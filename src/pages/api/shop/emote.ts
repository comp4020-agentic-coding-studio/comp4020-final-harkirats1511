import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { EMOTES, emote } from "../../../lib/shop.ts";

// Body {emote}: one of EMOTES, at most one a second per person.
export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const b = ((await request.json().catch(() => ({}))) ?? {}) as { emote?: unknown };
  if (typeof b.emote !== "string" || !EMOTES.includes(b.emote)) {
    return json({ error: `emote is one of: ${EMOTES.join(", ")}.` }, 400);
  }
  if (!emote(me.id, b.emote)) return json({ error: "You are not in the shop." }, 409);
  return new Response(null, { status: 204 });
};
