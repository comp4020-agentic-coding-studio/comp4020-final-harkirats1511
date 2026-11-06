import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Person } from "./auth.ts";
import { cleanVerdict, UNSAYABLE } from "./deezer.ts";
import { log, refused, tag } from "./log.ts";
import { crateTrack } from "./taste.ts";

// The shop jukebox (decision 0011). Memory only, like positions: a restart empties the queue, and
// nothing a game depends on lives here. A play never touches a game's heard songs: it reads a crate,
// never writes a pick. Someone on the floor queues one song at a time from their own crate, only one
// clean enough for the crate starter (deezer.ts suggestable), because strangers hear it. A play lasts
// a preview (30 s), then the next starts; skips from enough of the floor move it on sooner.

export const PLAY_MS = 30_000;
export const QUEUE_MAX = 12;
export type Play = { id: string; trackId: number; title: string; artist: string; cover?: string; picker: string; startedAt?: number; ms: number };
export type Jukebox = { now: Play | null; queue: Play[]; skips: number; needed: number };
type Entry = Play & { personId: string };

let now: Entry | null = null;
const queue: Entry[] = [];
const skippers = new Set<string>();
let floor = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const neededSkips = (onFloor: number) => Math.max(2, Math.ceil(onFloor / 3));
const pub = ({ personId: _p, ...play }: Entry): Play => play;

export function getJukebox(): Jukebox {
  return { now: now ? pub(now) : null, queue: queue.map(pub), skips: skippers.size, needed: neededSkips(floor.size) };
}

export function watchJukebox(fn: (j: Jukebox) => void): () => void {
  bus.on("jukebox", fn);
  return () => bus.off("jukebox", fn);
}
const changed = () => bus.emit("jukebox", getJukebox());

// The next queued song starts now, or the jukebox goes quiet (and the radio plays).
function next() {
  if (timer) clearTimeout(timer);
  timer = null;
  skippers.clear();
  const n = queue.shift();
  now = n ? { ...n, startedAt: Date.now() } : null;
  if (now) {
    const playing = now;
    timer = setTimeout(() => {
      if (now === playing) {
        next();
        changed();
      }
    }, PLAY_MS);
    timer.unref();
  }
}

// Who is on the shop floor, from shop.ts whenever someone walks in or out. Skips from people who have
// left stop counting, and a smaller floor may need fewer skips: either can move the song on.
export function floorChanged(ids: Iterable<string>) {
  floor = new Set(ids);
  const before = JSON.stringify(getJukebox());
  for (const id of [...skippers]) if (!floor.has(id)) skippers.delete(id);
  if (now && skippers.size >= neededSkips(floor.size)) {
    log("shop", `jukebox moved on · skipped`);
    next();
  }
  if (JSON.stringify(getJukebox()) !== before) changed();
}

export type Refusal = { ok: false; status: number; error: string };
const no = (me: Person, status: number, error: string, why: string): Refusal => {
  refused("shop", tag(me), "queue a song on the jukebox", why);
  return { ok: false, status, error };
};

// Queues a song from this person's own crate. The caller has checked they are signed in.
export async function queueSong(me: Person, trackId: number): Promise<{ ok: true; play: Play } | Refusal> {
  if (!floor.has(me.id)) return no(me, 409, "Walk into the shop first: the jukebox is on the shop floor.", "not on the shop floor");
  const own = crateTrack(me.id, trackId);
  if (!own) return no(me, 403, "That song isn't in your crate.", `track ${trackId} is not in their crate`);
  const mine = () => (now?.personId === me.id ? now : queue.find((p) => p.personId === me.id));
  if (mine()) return no(me, 409, "You already have a song in the queue.", "already has a song queued");
  if (queue.length >= QUEUE_MAX) return no(me, 409, "The queue is full; try again after this one.", `queue is full (${QUEUE_MAX})`);
  if (UNSAYABLE.test(own.title) || UNSAYABLE.test(own.artist)) return no(me, 400, "That song isn't clean enough for the jukebox.", "not clean (title or artist)");
  // Deezer says whether it is explicit (cached for the hour). A throw (busy, down) is the route's to answer.
  const v = await cleanVerdict(trackId);
  if (!v.clean) {
    const error = v.why === "explicit" ? "That song isn't clean enough for the jukebox." : v.why === "no preview" ? "That song has no preview to play." : "No such track.";
    return no(me, 400, error, v.why === "explicit" ? "not clean (explicit)" : v.why);
  }
  // Checked again after the lookup: someone else may have filled the queue, or this person queued twice at once.
  if (!floor.has(me.id)) return no(me, 409, "Walk into the shop first: the jukebox is on the shop floor.", "not on the shop floor");
  if (mine()) return no(me, 409, "You already have a song in the queue.", "already has a song queued");
  if (queue.length >= QUEUE_MAX) return no(me, 409, "The queue is full; try again after this one.", `queue is full (${QUEUE_MAX})`);
  const entry: Entry = {
    id: randomBytes(6).toString("hex"), trackId, title: own.title, artist: own.artist, ...(own.cover ? { cover: own.cover } : {}),
    picker: me.name, ms: PLAY_MS, personId: me.id,
  };
  queue.push(entry);
  // The song and its picker are public (the shop hears it, named), so the line may name it.
  log("shop", `${tag(me)} queued a song on the jukebox: "${own.title}" by ${own.artist}`);
  if (!now) next();
  changed();
  const play = now?.id === entry.id ? now : entry;
  return { ok: true, play: pub(play) };
}

// One skip per person per play, from someone on the floor.
export function skipSong(me: Person): { ok: true; skips: number; needed: number } | Refusal {
  const refuse = (status: number, error: string, why: string): Refusal => {
    refused("shop", tag(me), "skip the jukebox song", why);
    return { ok: false, status, error };
  };
  if (!floor.has(me.id)) return refuse(409, "Walk into the shop first: the jukebox is on the shop floor.", "not on the shop floor");
  if (!now) return refuse(409, "Nothing is playing on the jukebox.", "nothing playing");
  if (skippers.has(me.id)) return refuse(409, "You already asked to skip this one.", "already skipped this song");
  skippers.add(me.id);
  const skips = skippers.size;
  const needed = neededSkips(floor.size);
  log("shop", `${tag(me)} skipped the jukebox song (${skips} of ${needed})`);
  if (skips >= needed) {
    log("shop", `jukebox moved on · skipped`);
    next();
  }
  changed();
  return { ok: true, skips, needed };
}
