import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import {
  isHost, memberCount, MIN_PLAYERS, normaliseCode, notifyTable, publicState, setStatus, tableExists,
} from "../../../../lib/tables.ts";

export const POST: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) return json({ error: "Only the host can start." }, 403);
  if (memberCount(code) < MIN_PLAYERS) {
    return json({ error: `A game needs at least ${MIN_PLAYERS} players.` }, 409);
  }
  // The game itself is a later phase; for now the table is ready to begin.
  setStatus(code, "lobby_ready");
  notifyTable(code);
  return json(publicState(code), 202);
};
