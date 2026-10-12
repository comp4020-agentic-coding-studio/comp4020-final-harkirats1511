import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { DeezerDown, getTrack } from "../../../../lib/deezer.ts";
import { checkPick, recordPick } from "../../../../lib/game.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";
import { listTaste } from "../../../../lib/taste.ts";

// Body {trackId}: a Deezer id. Final once made, and refused after the deadline.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 403);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { trackId?: unknown };
  const id = body.trackId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return json({ error: "Bad track id." }, 400);
  const pre = checkPick(code, me.id);
  if (!pre.ok) return json({ error: pre.error }, pre.status);

  // Title and artist are kept for the reveal. Own taste file first, then Deezer.
  let track: { id: number; title: string; artist: string } | null | undefined = listTaste(me.id).find((t) => t.id === id);
  try {
    track ??= await getTrack(id);
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music service is unavailable right now." }, 502);
    throw e;
  }
  if (!track) return json({ error: "No such track." }, 400);
  // recordPick checks the phase and deadline again: the lookup took time.
  const res = recordPick(code, me.id, { id, title: track.title, artist: track.artist });
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
