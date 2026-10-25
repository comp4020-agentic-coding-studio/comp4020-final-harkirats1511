import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { addBot } from "../../../../lib/bots/driver.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isHost, normaliseCode, publicState, tableExists } from "../../../../lib/tables.ts";

// The host seats one more bot (up to the table's 8 seats), between games.
export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "add a bot", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "add a bot", "not the host");
    return json({ error: "Only the host can add a bot." }, 403);
  }
  const res = addBot(code, me);
  if (!res.ok) {
    refused(tableScope(code), tag(me), "add a bot", res.error);
    return json({ error: res.error }, res.status);
  }
  return json(publicState(code), 201);
};
