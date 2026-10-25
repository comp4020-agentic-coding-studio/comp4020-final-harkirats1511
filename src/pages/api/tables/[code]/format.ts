import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import { isFormat, isHost, normaliseCode, notifyTable, publicState, setFormat, tableExists, tableOptions } from "../../../../lib/tables.ts";

// Body {format: "knockout" | "four"}: the host's choice of format, between games (decision 0010).
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "choose format", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "choose format", "not the host");
    return json({ error: "Only the host can choose the format." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { format?: unknown };
  if (!isFormat(body.format)) return json({ error: "format is knockout or four." }, 400);
  if (tableOptions(code)?.status === "playing") {
    refused(tableScope(code), tag(me), "choose format", "a game is running");
    return json({ error: "You can't change the format during a game." }, 409);
  }
  setFormat(code, body.format);
  log(tableScope(code), `${tag(me)} chose ${body.format === "four" ? "four rounds" : "knockout"}`);
  notifyTable(code);
  return json(publicState(code));
};
