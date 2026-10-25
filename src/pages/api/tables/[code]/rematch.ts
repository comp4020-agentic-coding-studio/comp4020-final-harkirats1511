import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import { isMember, normaliseCode, notifyTable, publicState, setRematch, tableExists, tableOptions } from "../../../../lib/tables.ts";

// Body {in: boolean}: "I'm in" for the next game, on the game-over screen. Public and
// harmless (the host's Play again shows "3 of 4 in" but isn't blocked by it); reset when
// the next game starts.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "rematch", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) {
    refused(tableScope(code), tag(me), "rematch", "not at this table");
    return json({ error: "You are not at this table." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { in?: unknown };
  if (typeof body.in !== "boolean") return json({ error: "in is true or false." }, 400);
  if (tableOptions(code)?.status !== "finished") {
    refused(tableScope(code), tag(me), "rematch", "no game just ended");
    return json({ error: "There is no finished game to play again." }, 409);
  }
  setRematch(code, me.id, body.in);
  log(tableScope(code), `${tag(me)} is ${body.in ? "in for" : "out of"} the next game`);
  notifyTable(code);
  return json(publicState(code));
};
