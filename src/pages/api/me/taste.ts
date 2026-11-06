import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { refused } from "../../../lib/log.ts";
import { tasteNotes } from "../../../lib/notes.ts";

// Taste notes for "Your past games": only from games you sat in, only what their reveals showed.
export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("history", null, "view taste notes", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  return json(tasteNotes(me.id));
};
