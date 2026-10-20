import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { log, refused, tag } from "../../../lib/log.ts";
import { getRadio, isMode, retryAfter, setMode } from "../../../lib/radio.ts";
import { isHere } from "../../../lib/shop.ts";

// Only track ids from the code, so anyone may read it.
export const GET: APIRoute = () => json(getRadio());

// Body {mode}: "mix" or a station id. The jukebox: signed in, in the shop, once
// a minute for the whole shop.
export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("shop", null, "change the radio", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const b = ((await request.json().catch(() => ({}))) ?? {}) as { mode?: unknown };
  if (!isMode(b.mode)) return json({ error: "mode is mix or a station id." }, 400);
  if (!isHere(me.id)) {
    refused("shop", tag(me), "change the radio", "not in the shop");
    return json({ error: "Walk up to the jukebox first." }, 409);
  }
  const wait = retryAfter();
  if (wait) {
    refused("shop", tag(me), "change the radio", `changed less than a minute ago, ${wait}s left`);
    return json({ error: "The jukebox was just used.", retryAfter: wait }, 429, { "retry-after": String(wait) });
  }
  setMode(b.mode);
  log("shop", `${tag(me)} set the radio to ${b.mode}`);
  return json(getRadio());
};
