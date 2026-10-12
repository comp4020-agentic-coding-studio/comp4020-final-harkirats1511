import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../lib/auth.ts";
import { DeezerDown, searchTracks } from "../../lib/deezer.ts";

// Metadata only: no preview URLs here, they are fetched per play.
export const GET: APIRoute = async ({ cookies, url }) => {
  if (!personFromCookies(cookies)) return json({ error: "Sign in first." }, 401);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return json([]);
  try {
    return json(await searchTracks(q));
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music search is unavailable right now." }, 502);
    throw e;
  }
};
