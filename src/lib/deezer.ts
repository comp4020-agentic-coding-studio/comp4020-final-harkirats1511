import { log } from "./log.ts";

// Deezer's public catalogue API (no key). We only ever store ids and metadata;
// preview URLs are signed and expire, so they are fetched fresh and never kept.
const BASE = "https://api.deezer.com";
const TIMEOUT_MS = 5000;

export type Track = { id: number; title: string; artist: string; album?: string; cover?: string };

// Thrown when Deezer is unreachable or misbehaving; routes turn it into a 502.
export class DeezerDown extends Error {}
// Thrown when Deezer says we are asking too fast (its error code 4); routes turn it into a 503.
export class DeezerBusy extends DeezerDown {}
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
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string };
};

async function get(path: string, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown> | null> {
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
  if (err && (err.code === 4)) throw new DeezerBusy("Deezer's quota is used up.");
  return body && !err ? body : null;
}

function toTrack(r: Raw): Track | null {
  if (typeof r.id !== "number" || !r.title || !r.artist?.name) return null;
  return { id: r.id, title: r.title, artist: r.artist.name, album: r.album?.title, cover: r.album?.cover_medium };
}

export async function searchTracks(q: string, limit = 25): Promise<Track[]> {
  const body = await get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
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
  const body = await get(`/track/${id}`);
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
    const body = (await get(`/track/${id}`)) as Raw | null;
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
