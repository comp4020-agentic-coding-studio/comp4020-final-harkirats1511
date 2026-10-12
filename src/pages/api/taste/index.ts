import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { DeezerDown, getTrack } from "../../../lib/deezer.ts";
import { addTaste, listTaste, TASTE_MAX } from "../../../lib/taste.ts";

export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json(listTaste(me.id));
};

export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const body = (await request.json().catch(() => ({}))) as { trackId?: unknown };
  const raw = body.trackId;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "trackId must be a number." }, 400);

  // Title and artist come from Deezer, never from the client.
  let track;
  try {
    track = await getTrack(id);
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music search is unavailable right now." }, 502);
    throw e;
  }
  if (!track) return json({ error: "No such track." }, 404);

  const result = addTaste(me.id, track);
  if (result === "full") return json({ error: `A taste file holds up to ${TASTE_MAX} tracks.` }, 409);
  return json(listTaste(me.id), result === "added" ? 201 : 200);
};
