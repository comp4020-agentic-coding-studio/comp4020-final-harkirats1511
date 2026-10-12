import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../../lib/auth.ts";
import { roundSlots } from "../../../../../lib/game.ts";
import { isMember, normaliseCode, tableExists } from "../../../../../lib/tables.ts";

export const GET: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 403);
  const res = roundSlots(code);
  return "ok" in res ? json({ error: res.error }, res.status) : json(res);
};
