import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../lib/auth.ts";
import { historyFor } from "../../lib/tables.ts";

// The caller's own finished games, newest first (at most 20). Needs their session.
export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json(historyFor(me.id));
};
