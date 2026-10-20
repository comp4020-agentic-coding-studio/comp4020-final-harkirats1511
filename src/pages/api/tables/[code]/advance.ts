import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { advance } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isHost, normaliseCode, publicState, tableExists } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "advance", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "advance", "not the host");
    return json({ error: "Only the host can move the game on." }, 403);
  }
  const res = advance(code, `host ${tag(me)}`);
  if (!res.ok) refused(tableScope(code), tag(me), "advance", res.error);
  return res.ok ? json(publicState(code)) : json({ error: res.error }, res.status);
};
