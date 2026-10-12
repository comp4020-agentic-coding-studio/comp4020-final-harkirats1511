import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { createTable } from "../../../lib/tables.ts";

export const POST: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json({ code: createTable(me.id) }, 201);
};
