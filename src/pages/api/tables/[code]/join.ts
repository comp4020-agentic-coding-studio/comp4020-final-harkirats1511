import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { refused, tableScope } from "../../../../lib/log.ts";
import { joinTable, normaliseCode } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "join", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const res = joinTable(code, me);
  return res.ok ? json(res.state) : json({ error: res.error }, res.status);
};
