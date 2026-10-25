import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { legacySuggestions } from "../../../lib/taste.ts";

// A suggested mood for each song from before moods ({id, slot|null}). Only a
// suggestion: the person confirms each one (or "Sort all as suggested").
export const GET: APIRoute = async ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json(await legacySuggestions(me.id));
};
