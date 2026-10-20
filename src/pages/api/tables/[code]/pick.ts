import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { checkPick, recordPick } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";
import { crateTrack } from "../../../../lib/taste.ts";

// Body {trackId}: a Deezer id that is in the picker's own crate. Final once made, and refused after the deadline.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "pick", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "pick", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { trackId?: unknown };
  const id = body.trackId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return json({ error: "Bad track id." }, 400);
  const pre = checkPick(code, me.id);
  if (!pre.ok) {
    refused(tableScope(code), tag(me), "pick", pre.error);
    return json({ error: pre.error }, pre.status);
  }

  // Only from your own crate, as it is right now. Title and artist are kept for the reveal.
  const track = crateTrack(me.id, id);
  if (!track) {
    refused(tableScope(code), tag(me), "pick", "track not in their crate");
    return json({ error: "Pick from your crate." }, 403);
  }
  // recordPick checks the phase and deadline again: the lookup took time.
  const res = recordPick(code, me.id, { id, title: track.title, artist: track.artist, cover: track.cover });
  if (!res.ok) refused(tableScope(code), tag(me), "pick", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
