import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { addMember, normaliseCode, notifyTable, publicState, tableExists } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (addMember(code, me.id)) notifyTable(code);
  return json(publicState(code));
};
