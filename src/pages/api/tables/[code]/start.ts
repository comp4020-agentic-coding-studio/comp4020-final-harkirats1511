import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { startGame } from "../../../../lib/game.ts";
import { isHost, normaliseCode, publicState, tableExists } from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) return json({ error: "Only the host can start." }, 403);
  const res = startGame(code);
  if (!res.ok) return json({ error: res.error }, res.status);
  return json(publicState(code), 202);
};
