// Deezer's public catalogue API (no key). We only ever store ids and metadata;
// preview URLs are signed and expire, so they are fetched fresh and never kept.
const BASE = "https://api.deezer.com";
const TIMEOUT_MS = 5000;

export type Track = { id: number; title: string; artist: string; album?: string; cover?: string };

// Thrown when Deezer is unreachable or misbehaving; routes turn it into a 502.
export class DeezerDown extends Error {}

type Raw = {
  id?: number;
  title?: string;
  preview?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string };
};

async function get(path: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  // Errors arrive as HTTP 200 with an {error} body; treat them as not found.
  return body && !body.error ? body : null;
}

function toTrack(r: Raw): Track | null {
  if (typeof r.id !== "number" || !r.title || !r.artist?.name) return null;
  return { id: r.id, title: r.title, artist: r.artist.name, album: r.album?.title, cover: r.album?.cover_medium };
}

async function searchOnce(q: string, limit: number): Promise<Track[]> {
  const body = await get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  const rows = (body?.data as Raw[] | undefined) ?? [];
  return rows.map(toTrack).filter((t): t is Track => t !== null).slice(0, limit);
}

export async function searchTracks(q: string, limit = 25): Promise<Track[]> {
  let tracks = await searchOnce(q, limit);
  // For some short queries (observed: "pop") Deezer returns only the few exact
  // title matches. A trailing space asks it for the loose match instead, so top
  // the list up from that rather than hand back three results.
  if (tracks.length < limit) {
    const seen = new Set(tracks.map((t) => t.id));
    const more = (await searchOnce(`${q} `, limit)).filter((t) => !seen.has(t.id));
    tracks = [...tracks, ...more].slice(0, limit);
  }
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

// Always fresh: the URL is signed and expires.
export async function getPreviewUrl(id: number): Promise<string | null> {
  const body = (await get(`/track/${id}`)) as Raw | null;
  return body?.preview || null;
}
