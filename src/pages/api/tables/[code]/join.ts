import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import { addMember, normaliseCode, notifyTable, publicState, tableExists } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "join", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) {
    refused("table", tag(me), `join ${code}`, "no such table");
    return json({ error: "No such table." }, 404);
  }
  if (addMember(code, me.id)) {
    log(tableScope(code), `${tag(me)} joined the table`);
    notifyTable(code);
  }
  return json(publicState(code));
};
