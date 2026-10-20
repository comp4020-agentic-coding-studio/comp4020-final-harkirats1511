import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../lib/auth.ts";
import { log, refused, tag } from "../../lib/log.ts";
import { historyFor } from "../../lib/tables.ts";

// The caller's own finished games, newest first (at most 20). Needs their session.
export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("history", null, "view history", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const games = historyFor(me.id);
  log("history", `${tag(me)} viewed their history · ${games.length} game${games.length === 1 ? "" : "s"}`);
  return json(games);
};
