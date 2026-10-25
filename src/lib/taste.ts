import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, games, tasteTracks } from "./schema.ts";
import { type Artist, artistTop, DeezerBusy, DeezerQueued, findArtist, relatedArtists, trackBpm, type Track } from "./deezer.ts";
import { SLOTS, type Slot } from "./prompts.ts";

// A crate is 12 songs in 4 slots of 3 (decision 0009). Sitting down needs
// nothing, but starting a game needs every player's crate complete.
export const PER_SLOT = 3;
export const TASTE_MAX = SLOTS.length * PER_SLOT;
export const CRATE_LOCKED = "Your crate is locked until the game ends.";

export const isSlot = (s: unknown): s is Slot => typeof s === "string" && (SLOTS as readonly string[]).includes(s);

// Complete means 3 in every slot. A row with no slot (from before slots) counts
// for nothing, so its owner has to re-slot it.
export function crateComplete(personId: string): boolean {
  const counts = slotCounts(personId);
  return SLOTS.every((s) => counts[s] === PER_SLOT);
}

export function slotCounts(personId: string): Record<Slot, number> {
  const counts: Record<Slot, number> = { up: 0, down: 0, out: 0, in: 0 };
  for (const r of db.select({ slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all()) {
    if (isSlot(r.slot)) counts[r.slot]++;
  }
  return counts;
}

// True while this person is a player (left or not yet voted out, ghosts too) in
// a game that hasn't ended: their crate is on the table and can't change.
export function crateLocked(personId: string): boolean {
  return !!db
    .select({ g: gamePlayers.gameId })
    .from(gamePlayers)
    .innerJoin(games, eq(games.id, gamePlayers.gameId))
    .where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0), isNull(games.winner)))
    .get();
}

// The code of the table whose running game holds this person's crate, or "".
export function lockedTable(personId: string): string {
  return (
    db
      .select({ c: games.tableCode })
      .from(gamePlayers)
      .innerJoin(games, eq(games.id, gamePlayers.gameId))
      .where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0), isNull(games.winner)))
      .get()?.c ?? ""
  );
}

// The track, if it is in this person's own crate right now.
export function crateTrack(personId: string, trackId: number) {
  return db
    .select({ id: tasteTracks.trackId, title: tasteTracks.title, artist: tasteTracks.artist, cover: tasteTracks.cover })
    .from(tasteTracks)
    .where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId)))
    .get();
}

export function listTaste(personId: string) {
  return db
    .select({
      id: tasteTracks.trackId,
      title: tasteTracks.title,
      artist: tasteTracks.artist,
      album: tasteTracks.album,
      cover: tasteTracks.cover,
      slot: tasteTracks.slot,
    })
    .from(tasteTracks)
    .where(eq(tasteTracks.personId, personId))
    .orderBy(asc(tasteTracks.addedAt), sql`rowid`)
    .all();
}

// "added" and "present" are both successes; the rest are 409s. Reads and the
// write run synchronously, so two requests cannot both squeeze past a cap. A
// track already in the crate with no slot (an old row) takes the slot given.
export function addTaste(personId: string, t: Track, slot: Slot): "added" | "present" | "full" | "slot-full" {
  const here = db.select({ id: tasteTracks.trackId, slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all();
  const have = here.find((r) => r.id === t.id);
  if (have && have.slot !== null) return "present";
  if (here.filter((r) => r.slot === slot).length >= PER_SLOT) return "slot-full";
  if (have) {
    db.update(tasteTracks).set({ slot }).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, t.id))).run();
    return "added";
  }
  // Old rows with no slot don't count toward the cap: only slotted songs make a crate.
  if (here.filter((r) => r.slot !== null).length >= TASTE_MAX) return "full";
  db.insert(tasteTracks)
    .values({ personId, trackId: t.id, title: t.title, artist: t.artist, album: t.album ?? null, cover: t.cover ?? null, slot, addedAt: Date.now() })
    .run();
  return "added";
}

export function moveTaste(personId: string, trackId: number, slot: Slot): "moved" | "missing" | "slot-full" {
  const here = db.select({ id: tasteTracks.trackId, slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all();
  const row = here.find((r) => r.id === trackId);
  if (!row) return "missing";
  if (row.slot === slot) return "moved";
  if (here.filter((r) => r.slot === slot).length >= PER_SLOT) return "slot-full";
  db.update(tasteTracks).set({ slot }).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId))).run();
  return "moved";
}

export function removeTaste(personId: string, trackId: number) {
  db.delete(tasteTracks).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId))).run();
}

// ---- Starting a crate from your own artists (perfect-plan #2) and sorting old songs (#45) ----
//
// Mood guess, Deezer data only (no audio analysis, no outside list), and only a guess:
//   1. Words in the title, album and artist name. A mood needs a clear word (a "strong"
//      one: "lullaby", "heartbreak", "party") or two weaker words, or a weak word backed by a
//      genre hint (metal, rock, punk -> Up; ambient, lofi, acoustic -> In). One weak word
//      alone (a "Cocaine", a "Rock the boat") settles nothing.
//   2. Otherwise unknown (null): the caller spreads unknowns over the moods that still have
//      room, so no mood is starved.
//   3. Tempo (Deezer's bpm, often 0 = unknown) is used only to sort old songs, a few lookups.
// It is a starting point the person confirms, never a verdict.
type Words = { strong: RegExp; weak: RegExp; genre: RegExp };
const WORDS: Record<Slot, Words> = {
  up: {
    strong: /\b(workout|adrenaline|champions?|anthem|stronger|victory|unstoppable|pump(ed)?|knockout|rampage|thunderstruck|run(ning)? (it|away|the))\b/i,
    weak: /\b(run|running|fire|power|jump|energy|wild|fight|fighter|thunder|rise|rush|loud|go|king|queen|beast|hype|fast|louder|burn|blast|crazy|storm|war)\b/i,
    genre: /\b(metal|metalcore|hardcore|punk|hard rock|thrash|rock|drill|trap|edm|techno|hardstyle|dubstep|drum and bass|dnb)\b/i,
  },
  down: {
    strong: /\b(heartbreak(er)?|heartbroken|goodbye|farewell|funeral|grief|sorrow|tears?|crying|lonely|loneliness|broken[- ]hearted|breakup|depression|sad)\b/i,
    weak: /\b(cry|blue|blues|rain|hurt|hurts|miss|missing|gone|lost|empty|alone|without you|over you|regret|sorry|ghost|dying|die|fall(ing)?|pain|lonesome|memories)\b/i,
    genre: /\b(blues|ballad|sad|slowcore|torch|requiem|elegy|dirge|lament)\b/i,
  },
  out: {
    strong: /\b(party|dance floor|dancing|club|tonight|friday|saturday night|weekend|disco|celebrate|celebration|good times|shots|summer(time)?|last night)\b/i,
    weak: /\b(dance|night|nights|fun|friends?|drink|drinks|girls|boys|baby|move|body|groove|funk|fiesta|holiday|beach|sun|sunshine|good|feel)\b/i,
    genre: /\b(disco|funk|house|dancehall|reggaeton|latin|salsa|pop|afrobeats?|soul|reggae|swing|samba|bossa)\b/i,
  },
  in: {
    strong: /\b(lullaby|sleep(ing)?|bedroom|cosy|cozy|coffee|sunday morning|lofi|lo-fi|nightcap|bedtime|blanket|fireside|daydream)\b/i,
    weak: /\b(home|dream|dreams|chill|quiet|slow|morning|soft|sunday|gentle|calm|peace|tea|rest|warm|tender|silence|moon|stars|window|sunrise|lazy)\b/i,
    genre: /\b(ambient|lofi|lo-fi|acoustic|piano|instrumental|unplugged|chillout|chill|new age|folk|classical|sleep|meditation|bossa)\b/i,
  },
};
// Order matters when two moods tie (the quieter ones first).
const KEY_ORDER: Slot[] = ["down", "in", "up", "out"];

export function moodByBpm(bpm: number | null | undefined): Slot | null {
  if (!bpm || bpm < 30) return null;
  return bpm >= 128 ? "up" : bpm >= 108 ? "out" : bpm >= 88 ? "in" : "down";
}

// A mood for the words, or null when no mood has enough behind it. `extra` is album
// title and artist name: genre hints and words there count, but only as backing.
export function moodByTitle(title: string, extra = ""): Slot | null {
  let best: Slot | null = null;
  let top = 0;
  for (const s of KEY_ORDER) {
    const w = WORDS[s];
    const strong = w.strong.test(title) ? 1 : 0;
    const weak = w.weak.test(title) ? 1 : 0;
    const genre = w.genre.test(title) || w.genre.test(extra) ? 1 : 0;
    const score = strong * 3 + weak * 1 + genre * 1;
    // Enough: a strong word; or a weak word plus a genre hint. A lone weak word or a lone genre is not.
    const enough = strong > 0 || (weak > 0 && genre > 0);
    if (enough && score > top) { best = s; top = score; }
  }
  return best;
}

export function guessMood(title: string, bpm?: number | null): Slot | null {
  return moodByTitle(title) ?? moodByBpm(bpm);
}

// A suggested mood for each old song, filling only the room that is left:
// a song whose guess is full (or unknown) goes to the mood with the most room.
// Returns trackId -> slot, or null when no mood has room (it stays unsorted).
export function planLegacySort(
  loose: { id: number; title: string }[],
  counts: Record<Slot, number>,
  bpmOf: (id: number) => number | null = () => null,
): Map<number, Slot | null> {
  const room = { ...counts };
  const out = new Map<number, Slot | null>();
  for (const t of loose) {
    const g = guessMood(t.title, bpmOf(t.id));
    let pick: Slot | null = g && room[g] < PER_SLOT ? g : null;
    if (!pick) {
      const open = SLOTS.filter((s) => room[s] < PER_SLOT).sort((a, b) => room[a] - room[b]);
      pick = open[0] ?? null;
    }
    if (pick) room[pick]++;
    out.set(t.id, pick);
  }
  return out;
}

export type Suggestion = Track;
export type SuggestResult = {
  artists: string[];
  missing: string[];
  // Artists with fewer than 3 clean songs of their own (the rest of what we found is from artists like them).
  fewClean: string[];
  moods: Record<Slot, Suggestion[]>;
  spare: Record<Slot, Suggestion[]>;
};

// What one starter costs Deezer: per artist 1 search, 1 top list (50), 1 related list and
// the top list of its first related artist = 4, so 12 for three artists, all of it cached
// for 10 minutes. Only when the first pass leaves too few songs does it look at more related
// artists (a thin or mostly explicit catalogue: Drake has 4 clean songs in his top 25).
// Parallel, and the whole thing stops waiting after BUDGET_MS; whatever arrived is used.
const BUDGET_MS = 10_000;
const TOP_LIMIT = 50;
const RELATED_LIST = 10;
const RELATED_TOP = 25;
const ENOUGH = 14; // clean songs in the pool at which a first pass is not thin
const MORE_RELATED = 4; // extra related artists looked at when thin
const BPM_LOOKUPS = 6; // legacy sort only
const SPARE_PER_MOOD = 6;

// Resolves with `fallback` when the budget runs out; a Deezer busy error is not swallowed.
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), Math.max(1, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Deezer's own quota anywhere means the quota is gone: say so. When it was our own queue that
// held a call back, or any other failure, just that branch is lost (and noted, so a result
// with nothing in it can say "busy" rather than "nothing found").
type Soft = { held: boolean };
async function soft<T>(p: Promise<T>, fallback: T, note?: Soft): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof DeezerQueued) { if (note) note.held = true; return fallback; }
    if (e instanceof DeezerBusy) throw e;
    return fallback;
  }
}

export async function suggestFromArtists(names: string[], skip: Set<number>, only?: Slot[]): Promise<SuggestResult> {
  const until = Date.now() + BUDGET_MS;
  const left = () => until - Date.now();
  const note: Soft = { held: false };
  const found = await within(Promise.all(names.map((n) => soft(findArtist(n, left()), null, note))), left(), names.map(() => null));
  const artists = found.filter((a): a is Artist => !!a);
  const missing = names.filter((_, i) => !found[i]);
  if (!artists.length && note.held) throw new DeezerBusy("Deezer calls are queued.");

  // Each artist's own top tracks, and the top tracks of its closest related artist.
  type Cand = { t: Track; src: number };
  const own: Track[][] = artists.map(() => []);
  const theirs: Track[][] = artists.map(() => []);
  const related: Artist[][] = artists.map(() => []);
  await within(
    Promise.all(
      artists.map(async (a, i) => {
        const mine = soft(artistTop(a.id, TOP_LIMIT, left()), [] as Track[], note).then((r) => { own[i] = r; });
        const rel = soft(relatedArtists(a.id, RELATED_LIST, left()), [] as Artist[], note).then(async (rs) => {
          related[i] = rs;
          if (rs[0]) theirs[i] = await soft(artistTop(rs[0].id, RELATED_TOP, left()), [] as Track[], note);
        });
        await Promise.all([mine, rel]);
      }),
    ),
    left(),
    [],
  );
  // Thin (a mostly explicit catalogue): look at more related artists, a few in all, round robin.
  const count = () => own.reduce((n, o, i) => n + o.length + theirs[i].length, 0);
  if (count() < ENOUGH && left() > 1500 && artists.length < 3) {
    const more: { i: number; r: Artist }[] = [];
    const extra = Math.max(0, Math.min(MORE_RELATED, 12 - 4 * artists.length)); // keeps a starter near 12 calls
    for (let k = 1; more.length < MORE_RELATED && related.some((rs) => k < rs.length); k++) {
      related.forEach((rs, i) => { if (rs[k] && more.length < extra) more.push({ i, r: rs[k] }); });
    }
    await within(
      Promise.all(more.map(async ({ i, r }) => { theirs[i] = theirs[i].concat(await soft(artistTop(r.id, RELATED_TOP, left()), [] as Track[], note)); })),
      left(),
      [],
    );
  }
  const fewClean = artists.filter((_, i) => own[i].length < PER_SLOT).map((a) => a.name);
  const pools: Cand[][] = artists.map((_, i) => {
    // Own songs first, then related ones, interleaved so neither floods a mood.
    const merged: Track[] = [];
    for (let k = 0; k < Math.max(own[i].length, theirs[i].length); k++) {
      if (own[i][k]) merged.push(own[i][k]);
      if (theirs[i][k]) merged.push(theirs[i][k]);
    }
    return merged.map((t) => ({ t, src: i }));
  });

  // Interleave the artists, dedupe, drop what they already have.
  // Also dedupe the same song in another edition ("Tears in Heaven" and its live cut).
  const seen = new Set<number>(skip);
  const songs = new Set<string>();
  const songKey = (t: Track) => `${t.artist}|${t.title.replace(/[\(\[].*$/, "").replace(/ - .*$/, "").trim()}`.toLowerCase();
  const pool: Cand[] = [];
  for (let k = 0; pools.some((p) => k < p.length); k++) {
    for (const p of pools) {
      const c = p[k];
      if (c && !seen.has(c.t.id) && !songs.has(songKey(c.t))) { seen.add(c.t.id); songs.add(songKey(c.t)); pool.push(c); }
    }
  }
  if (!pool.length && note.held) throw new DeezerBusy("Deezer calls are queued.");

  // Mood: words only (no tempo lookups: they were most of the cost).
  const guess = new Map<number, Slot | null>();
  for (const c of pool) guess.set(c.t.id, moodByTitle(c.t.title, `${c.t.album ?? ""} ${c.t.artist}`));

  const moods = Object.fromEntries(SLOTS.map((s) => [s, [] as Track[]])) as Record<Slot, Track[]>;
  const spare = Object.fromEntries(SLOTS.map((s) => [s, [] as Track[]])) as Record<Slot, Track[]>;
  const want = (only && only.length ? only : [...SLOTS]) as Slot[];
  const used = new Set<number>();
  const take = (s: Slot, into: Track[], cap: number, from: (c: Cand) => boolean) => {
    for (const c of pool) {
      if (into.length >= cap) break;
      if (used.has(c.t.id) || !from(c)) continue;
      used.add(c.t.id);
      into.push(c.t);
    }
  };
  // Pass 1: songs whose guessed mood is this one. Pass 2: unknowns (a balanced spread). Pass 3: any left.
  for (const s of want) take(s, moods[s], PER_SLOT, (c) => guess.get(c.t.id) === s);
  for (const s of want) take(s, moods[s], PER_SLOT, (c) => !guess.get(c.t.id));
  for (const s of want) take(s, moods[s], PER_SLOT, () => true);
  for (const s of want) take(s, spare[s], SPARE_PER_MOOD, (c) => guess.get(c.t.id) === s || !guess.get(c.t.id));
  for (const s of want) take(s, spare[s], SPARE_PER_MOOD, () => true);
  return { artists: artists.map((a) => a.name), missing, fewClean, moods, spare };
}

// Old songs (no slot) with a suggested mood each, using the same guess plus
// Deezer's tempo for titles with no keyword (a few lookups, in parallel, within a budget).
export async function legacySuggestions(personId: string): Promise<{ id: number; slot: Slot | null }[]> {
  const loose = listTaste(personId).filter((t) => !isSlot(t.slot));
  const bpm = new Map<number, number | null>();
  const need = loose.filter((t) => !moodByTitle(t.title)).slice(0, BPM_LOOKUPS);
  if (need.length) {
    await within(
      Promise.all(need.map((t) => soft(trackBpm(t.id, 4000, "background"), null).then((b) => bpm.set(t.id, b)))),
      4500,
      [],
    ).catch(() => []);
  }
  const plan = planLegacySort(loose, slotCounts(personId), (id) => bpm.get(id) ?? null);
  return loose.map((t) => ({ id: t.id, slot: plan.get(t.id) ?? null }));
}
