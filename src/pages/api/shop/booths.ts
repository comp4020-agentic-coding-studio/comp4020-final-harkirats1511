import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { booths } from "../../../lib/booths.ts";

// The 2D booth list: what the shop stream's booths event carries, for a plain page.
export const GET: APIRoute = ({ cookies }) => {
  if (!personFromCookies(cookies)) return json({ error: "Sign in first." }, 401);
  return json(booths());
};
