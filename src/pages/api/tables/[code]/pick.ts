import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { pickTrack } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Body {trackId, from?}: a Deezer id from your own crate, or, with `from` (a
// player's name), your one borrow from theirs. Final once made, hidden until
// picking closes, and refused after the deadline.
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
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { trackId?: unknown; from?: unknown };
  const id = body.trackId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return json({ error: "Bad track id." }, 400);
  if (body.from !== undefined && (typeof body.from !== "string" || !body.from.trim())) return json({ error: "from is a player's name." }, 400);
  const res = pickTrack(code, me.id, id, body.from === undefined ? undefined : (body.from as string).trim());
  if (!res.ok) refused(tableScope(code), tag(me), "pick", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
