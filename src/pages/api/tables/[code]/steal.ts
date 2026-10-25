import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castSteal } from "../../../../lib/game.ts";
import { actedTooFast } from "../../../../lib/limits.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Body {promptId}: the voted-out mole's one guess, one of the four they were offered.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "steal", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "steal", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  if (actedTooFast(`${me.id}:${code}`, () => refused(tableScope(code), tag(me), "steal", "too many requests in a second"))) return json({ error: "Slow down." }, 429);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { promptId?: unknown };
  if (typeof body.promptId !== "string" || !body.promptId) return json({ error: "Say which prompt you are guessing." }, 400);
  const res = castSteal(code, me.id, body.promptId);
  // The guess itself is only logged once it resolves (in the engine).
  if (!res.ok) refused(tableScope(code), tag(me), "steal", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
