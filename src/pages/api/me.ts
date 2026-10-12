import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../lib/auth.ts";

export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  return me ? json({ id: me.id, name: me.name }) : json({ error: "Not signed in." }, 401);
};
