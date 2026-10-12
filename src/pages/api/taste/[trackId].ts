import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { removeTaste } from "../../../lib/taste.ts";

export const DELETE: APIRoute = ({ cookies, params }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const id = Number(params.trackId);
  if (!Number.isSafeInteger(id)) return json({ error: "Bad track id." }, 400);
  removeTaste(me.id, id);
  return json({ ok: true });
};
