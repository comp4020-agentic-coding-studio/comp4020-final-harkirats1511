import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../../lib/auth.ts";
import { removeBot } from "../../../../../lib/bots/seats.ts";
import { refused, tableScope, tag } from "../../../../../lib/log.ts";
import { isHost, normaliseCode, publicState, tableExists } from "../../../../../lib/tables.ts";

// Body {name}: the host sends a bot home, between games.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "remove a bot", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "remove a bot", "not the host");
    return json({ error: "Only the host can remove a bot." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "Say which bot to remove." }, 400);
  const res = removeBot(code, me, body.name.trim());
  if (!res.ok) {
    refused(tableScope(code), tag(me), "remove a bot", res.error);
    return json({ error: res.error }, res.status);
  }
  return json(publicState(code));
};
