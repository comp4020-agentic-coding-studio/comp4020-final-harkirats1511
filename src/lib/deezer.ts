import { log } from "./log.ts";
import { DEEZER_BUCKET, MAX_WAIT, type Priority } from "./bucket.ts";

// Deezer's public catalogue API (no key). We only ever store ids and metadata;
// preview URLs are signed and expire, so they are fetched fresh and never kept.
const BASE = "https://api.deezer.com";
const TIMEOUT_MS = 5000;

export type Track = { id: number; title: string; artist: string; album?: string; cover?: string };

// Thrown when Deezer is unreachable or misbehaving; routes turn it into a 502.
export class DeezerDown extends Error {}
// Thrown when Deezer says we are asking too fast (its error code 4); routes turn it into a 503.
export class DeezerBusy extends DeezerDown {}
// Thrown when it was us who held the call back (our own token bucket was empty), not Deezer.
export class DeezerQueued extends DeezerBusy {}
// One log line when Deezer fails a route ("busy" is its quota, "down" anything else).
// The message is ours, never Deezer's body or a URL.
export function logDeezer(route: string, e: unknown): void {
  log("deezer", `${route}: ${e instanceof DeezerBusy ? "busy (quota used up)" : "down"}`);
}
export const DEEZER_BUSY = "Deezer is busy, try again in a moment.";

type Raw = {
  id?: number;
  title?: string;
  preview?: string;
  explicit_lyrics?: boolean;
  explicit_content_lyrics?: number;
  bpm?: number;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string };
};

// Every Deezer call the server makes goes through here, and through one token bucket
// (see bucket.ts): card audio and previews first, then search and adds, then the starter
// and sort-plan, then bot crates. A call that can't get a slot in time is "busy".
async function get(path: string, priority: Priority, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  if (!(await DEEZER_BUCKET.take(priority, Math.min(MAX_WAIT[priority], timeoutMs)))) {
    throw new DeezerQueued("Too many Deezer calls at once.");
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DeezerDown("Deezer did not answer.");
  }
  if (!res.ok) throw new DeezerDown(`Deezer returned ${res.status}.`);
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new DeezerDown("Deezer sent something unreadable.");
  }
  // Errors arrive as HTTP 200 with an {error: {type, code, message}} body. Code 4
  // is the quota ("Quota limit exceeded"): that is not "no such track", say so.
  // Any other error body (code 800, "no data") means it isn't there.
  const err = body?.error as { code?: number; type?: string } | undefined;
  if (err && (err.code === 4)) {
    DEEZER_BUCKET.pause(2000);
    throw new DeezerBusy("Deezer's quota is used up.");
  }
  return body && !err ? body : null;
}

function toTrack(r: Raw): Track | null {
  if (typeof r.id !== "number" || !r.title || !r.artist?.name) return null;
  return { id: r.id, title: r.title, artist: r.artist.name, album: r.album?.title, cover: r.album?.cover_medium };
}

export async function searchTracks(q: string, limit = 25): Promise<Track[]> {
  const body = await get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`, "normal");
  const rows = (body?.data as Raw[] | undefined) ?? [];
  const tracks = rows.map(toTrack).filter((t): t is Track => t !== null).slice(0, limit);
  // Whatever someone picks next was probably just on their screen.
  for (const t of tracks) remember(t);
  return tracks;
}

// Track metadata rarely changes, so a small cache saves round trips.
const cache = new Map<number, { track: Track; at: number }>();
const TTL = 60 * 60 * 1000;
const CACHE_MAX = 500;

function remember(track: Track) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(track.id, { track, at: Date.now() });
}

export async function getTrack(id: number): Promise<Track | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.track;
  const body = await get(`/track/${id}`, "normal");
  const track = body ? toTrack(body as Raw) : null;
  if (track) remember(track);
  return track;
}

// The URL is signed and expires, so it is kept only in memory and only briefly:
// a whole table asking for the same card in the same second costs Deezer one call.
// Never the audio, never in the database.
const PREVIEW_TTL_MS = 60_000;
const PREVIEW_MAX = 200;
const previews = new Map<number, { url: string; at: number }>();
const inflight = new Map<number, Promise<string | null>>();

export async function getPreviewUrl(id: number): Promise<string | null> {
  const hit = previews.get(id);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.url;
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = (async () => {
    const body = (await get(`/track/${id}`, "card")) as Raw | null;
    const url = body?.preview || null;
    if (url) {
      if (previews.size >= PREVIEW_MAX) previews.delete(previews.keys().next().value!);
      previews.set(id, { url, at: Date.now() });
    }
    return url;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// A last net under Deezer's explicit flag, which some catalogue entries lack.
// Suggestions are automated content nobody chose, so they pass it (restored from
// before 73296e7, where it guarded the house record's tracks). It also catches the
// censored spellings Deezer itself prints ("N****", "ni**as", "n*gg") and letters
// spaced out ("n i g g e r"), and stays narrow so that ordinary titles pass
// (spec/explicit.test.ts holds a list of them).
export const UNSAYABLE = new RegExp(
  [
    "n[i1!]gg(?!l)", // the plain word and its plurals (not "niggle")
    "\\bn[*#@_]{2,}", // n**, n****as
    "n[i1!][*#@_]{2,}", // ni**as
    "n[*#@_]gg", // n*gg
    "\\bn[\\s.\\-_]+[i1][\\s.\\-_]+g[\\s.\\-_]+g", // n i g g
    "f[a@]gg", // f-slur, plain
    "\\bf[*#@_]{1,2}g{0,2}(?![\\w*])", // f*g, f**
    "\\bf[\\s.\\-_]+[a@][\\s.\\-_]+g[\\s.\\-_]+g", // f a g g
    "retard",
    "c[u*]nt",
    "wh[o0*]re",
    "sl[u*]t\\b",
  ].join("|"),
  "i",
);

// Ids and metadata only, for suggestions: a track with a preview, not marked
// explicit (either of Deezer's two flags), with no slur in its title or artist
// name. The preview URL itself is dropped (it is signed and expires; the game
// fetches a fresh one per play).
export function suggestable(r: Raw): Track | null {
  if (!r.preview || r.explicit_lyrics || r.explicit_content_lyrics === 1) return null;
  if (UNSAYABLE.test(r.title ?? "") || UNSAYABLE.test(r.artist?.name ?? "")) return null;
  return toTrack(r);
}

// A plain search for a bot's crate: clean tracks only, at the lowest priority.
export async function searchClean(q: string, limit = 50): Promise<Track[]> {
  const body = await get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`, "background", 6000);
  const rows = (body?.data as Raw[] | undefined) ?? [];
  return rows.map(suggestable).filter((t): t is Track => t !== null);
}

export type Artist = { id: number; name: string; fans?: number };

// Short-lived memory for what the starter asks about an artist, so the same
// artists asked twice (or by four people in a row) cost Deezer one call each.
// In-flight asks are shared; a failure is never remembered.
const ASK_TTL = 10 * 60 * 1000;
const ASK_MAX = 300;
const asks = new Map<string, { at: number; p: Promise<unknown> }>();
function remembered<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = asks.get(key);
  if (hit && Date.now() - hit.at < ASK_TTL) return hit.p as Promise<T>;
  if (asks.size >= ASK_MAX) asks.delete(asks.keys().next().value!);
  const p = make();
  asks.set(key, { at: Date.now(), p });
  p.catch(() => { if (asks.get(key)?.p === p) asks.delete(key); });
  return p;
}
// True when the starter already holds this answer (so asking again costs no Deezer call).
export const asked = (key: string) => {
  const hit = asks.get(key);
  return !!hit && Date.now() - hit.at < ASK_TTL;
};

const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");

// Of Deezer's matches, the artist people mean: among those whose name is the
// same or nearly (ignoring case, accents, dots and "The"), the one with most fans.
// Deezer lists look-alike accounts first ("BTS" with 4,298 fans before the real one).
export function pickArtist(rows: Artist[], name: string): Artist | null {
  const want = plain(name);
  const byFans = (a: Artist, b: Artist) => (b.fans ?? 0) - (a.fans ?? 0);
  const exact = rows.filter((a) => plain(a.name) === want).sort(byFans);
  if (exact.length) return exact[0];
  const near = want.length >= 3 ? rows.filter((a) => plain(a.name).includes(want) || want.includes(plain(a.name))).sort(byFans) : [];
  return near[0] ?? rows[0] ?? null;
}

export function findArtist(name: string, ms = TIMEOUT_MS): Promise<Artist | null> {
  return remembered(`find:${plain(name)}`, async () => {
    const body = await get(`/search/artist?q=${encodeURIComponent(name)}&limit=10`, "suggest", ms);
    const rows = ((body?.data as { id?: number; name?: string; nb_fan?: number }[] | undefined) ?? [])
      .filter((a): a is { id: number; name: string; nb_fan?: number } => typeof a.id === "number" && !!a.name)
      .map((a) => ({ id: a.id, name: a.name, fans: a.nb_fan }));
    return pickArtist(rows, name);
  });
}

export function artistTop(id: number, limit: number, ms = TIMEOUT_MS): Promise<Track[]> {
  return remembered(`top:${id}:${limit}`, async () => {
    const body = await get(`/artist/${id}/top?limit=${limit}`, "suggest", ms);
    const tracks = ((body?.data as Raw[] | undefined) ?? []).map(suggestable).filter((t): t is Track => t !== null);
    for (const t of tracks) remember(t);
    return tracks;
  });
}

export function relatedArtists(id: number, limit: number, ms = TIMEOUT_MS): Promise<Artist[]> {
  return remembered(`rel:${id}:${limit}`, async () => {
    const body = await get(`/artist/${id}/related?limit=${limit}`, "suggest", ms);
    return ((body?.data as { id?: number; name?: string; nb_fan?: number }[] | undefined) ?? [])
      .filter((a): a is { id: number; name: string; nb_fan?: number } => typeof a.id === "number" && !!a.name)
      .map((a) => ({ id: a.id, name: a.name, fans: a.nb_fan }));
  });
}

// Beats per minute from /track/:id: Deezer often says 0 (unknown), which is null here.
const bpms = new Map<number, number | null>();
export async function trackBpm(id: number, ms = TIMEOUT_MS, priority: Priority = "suggest"): Promise<number | null> {
  if (bpms.has(id)) return bpms.get(id)!;
  const body = (await get(`/track/${id}`, priority, ms)) as Raw | null;
  const v = typeof body?.bpm === "number" && body.bpm > 30 ? body.bpm : null;
  if (bpms.size >= 2000) bpms.delete(bpms.keys().next().value!);
  bpms.set(id, v);
  return v;
}
