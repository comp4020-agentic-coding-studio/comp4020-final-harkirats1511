import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import { isHost, normaliseCode, notifyTable, publicState, setPrivate, tableExists, tableOptions } from "../../../../lib/tables.ts";

// Body {private}: the host makes the booth private or public, before a game starts.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "set visibility", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "set visibility", "not the host");
    return json({ error: "Only the host can do that." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { private?: unknown };
  if (typeof body.private !== "boolean") return json({ error: "private is true or false." }, 400);
  if (tableOptions(code)?.status === "playing") {
    refused(tableScope(code), tag(me), "set visibility", "a game is in progress");
    return json({ error: "A game is in progress." }, 409);
  }
  setPrivate(code, body.private);
  log(tableScope(code), `${tag(me)} made the booth ${body.private ? "private" : "public"}`);
  notifyTable(code);
  return json(publicState(code));
};
