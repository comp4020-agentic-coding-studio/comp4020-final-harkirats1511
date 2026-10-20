import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { leaveTable } from "../../../../lib/game.ts";
import { refused, tableScope } from "../../../../lib/log.ts";
import { normaliseCode, tableExists } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "leave", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  leaveTable(code, me.id);
  return json({ ok: true });
};
