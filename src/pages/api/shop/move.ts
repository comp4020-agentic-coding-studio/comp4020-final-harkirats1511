import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { refused, tag } from "../../../lib/log.ts";
import { move } from "../../../lib/shop.ts";

// Body {x, z, yaw}. Not logged per move: there are up to 8 a second each.
export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const b = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const { x, z, yaw } = b;
  if (typeof x !== "number" || typeof z !== "number" || typeof yaw !== "number" || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) {
    return json({ error: "x, z and yaw are numbers." }, 400);
  }
  if (!move(me.id, x, z, yaw)) {
    refused("shop", tag(me), "move", "not in the shop");
    return json({ error: "You are not in the shop." }, 409);
  }
  return new Response(null, { status: 204 });
};
