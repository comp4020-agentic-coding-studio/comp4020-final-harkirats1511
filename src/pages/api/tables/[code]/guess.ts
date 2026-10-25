import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castGhostGuess } from "../../../../lib/game.ts";
import { actedTooFast } from "../../../../lib/limits.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Knockout: a ghost's private guess at who the mole is. Body {name}. Allowed during each
// round's vote, changeable until it locks; it is shown to nobody until the game is over.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "ghost guess", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "ghost guess", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  if (actedTooFast(`${me.id}:${code}`, () => refused(tableScope(code), tag(me), "ghost guess", "too many requests in a second"))) return json({ error: "Slow down." }, 429);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "Say who you think the mole is." }, 400);
  const res = castGhostGuess(code, me.id, body.name.trim());
  if (!res.ok) refused(tableScope(code), tag(me), "ghost guess", res.error);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
