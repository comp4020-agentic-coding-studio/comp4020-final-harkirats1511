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
  // Errors arrive as HTTP 200 with an {error} body; treat them as not found.
  return body && !body.error ? body : null;
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

// Always fresh: the URL is signed and expires.
export async function getPreviewUrl(id: number): Promise<string | null> {
  const body = (await get(`/track/${id}`)) as Raw | null;
  return body?.preview || null;
}

// An artist's top tracks that have a preview, for the house record (decision
// 0008). The artist id comes from a search by name, taking the first result
// whose name matches exactly (ignoring case). One shared time limit covers both
// requests; any failure, or no exact match, is an empty list.
export async function topTracksWithPreview(artistName: string, ms: number): Promise<Track[]> {
  const until = Date.now() + ms;
  const left = () => Math.max(1, until - Date.now());
  try {
    const found = await get(`/search/artist?q=${encodeURIComponent(artistName)}&limit=5`, left());
    const wanted = artistName.trim().toLowerCase();
    const artist = ((found?.data as { id?: number; name?: string }[] | undefined) ?? []).find(
      (a) => typeof a.id === "number" && a.name?.trim().toLowerCase() === wanted,
    );
    if (!artist) return [];
    const top = await get(`/artist/${artist.id}/top?limit=25`, left());
    const rows = (top?.data as Raw[] | undefined) ?? [];
    return rows.filter((r) => !!r.preview).map(toTrack).filter((t): t is Track => t !== null);
  } catch {
    return [];
  }
}
