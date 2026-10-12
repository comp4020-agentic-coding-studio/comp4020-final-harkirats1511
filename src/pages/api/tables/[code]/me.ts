import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { myView } from "../../../../lib/game.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// This person's private view of the game: only a mole has a target.
export const GET: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 404);
  return json(myView(code, me.id));
};
