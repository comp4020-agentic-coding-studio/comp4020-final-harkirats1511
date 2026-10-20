import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castVote } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Body {name}: a member's name, or "skip". Final once cast.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "vote", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "vote", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "Say who to vote for, or skip." }, 400);
  const res = castVote(code, me.id, body.name.trim());
  if (!res.ok) refused(tableScope(code), tag(me), "vote", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
