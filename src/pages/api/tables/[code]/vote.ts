import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castVote } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Body {slot} (a track's anonymous number) or {skip: true}. Changeable until the vote locks.
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
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { slot?: unknown; skip?: unknown };
  let choice: { slot: number } | "skip";
  if (body.skip === true) choice = "skip";
  else if (typeof body.slot === "number" && Number.isInteger(body.slot) && body.slot >= 0) choice = { slot: body.slot };
  else return json({ error: "Say which track to vote for, or skip." }, 400);
  const res = castVote(code, me.id, choice);
  if (!res.ok) refused(tableScope(code), tag(me), "vote", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
