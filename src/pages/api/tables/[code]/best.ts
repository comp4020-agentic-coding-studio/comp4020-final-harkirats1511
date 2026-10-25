import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castBest } from "../../../../lib/game.ts";
import { actedTooFast } from "../../../../lib/limits.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Four rounds: body {order} (a card's number in the round's play order, not your own card).
// Changeable until the vote locks.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "best pick", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "best pick", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  if (actedTooFast(`${me.id}:${code}`, () => refused(tableScope(code), tag(me), "best pick", "too many requests in a second"))) return json({ error: "Slow down." }, 429);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { order?: unknown };
  if (typeof body.order !== "number" || !Number.isInteger(body.order)) return json({ error: "Say which card, by its number." }, 400);
  const res = castBest(code, me.id, body.order);
  if (!res.ok) refused(tableScope(code), tag(me), "best pick", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
