import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import {
  isHost, maxMoles, memberCount, MOLE_CHOICES, normaliseCode, notifyTable, publicState, setMoles, tableExists, tableOptions,
} from "../../../../lib/tables.ts";

// Body {moles: 1 | 2} (or null for the plain rule): the host's choice of mole count,
// between games. Never more than a third of the table, rounded down, minimum 1: 2
// moles need 6 players, checked here against who is seated now and again at the start.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "choose moles", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "choose moles", "not the host");
    return json({ error: "Only the host can choose the moles." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { moles?: unknown };
  const want = body.moles;
  if (want !== null && !(typeof want === "number" && MOLE_CHOICES.includes(want))) {
    return json({ error: "moles is 1 or 2." }, 400);
  }
  if (tableOptions(code)?.status === "playing") {
    refused(tableScope(code), tag(me), "choose moles", "a game is running");
    return json({ error: "You can't change the moles during a game." }, 409);
  }
  if (want !== null && want > maxMoles(memberCount(code))) {
    refused(tableScope(code), tag(me), `choose ${want} moles`, `${memberCount(code)} seated`);
    return json({ error: `${want} moles need ${want * 3} players: never more than a third of the table.` }, 409);
  }
  setMoles(code, want);
  log(tableScope(code), `${tag(me)} chose ${want ?? "the usual number of"} mole${want === 1 ? "" : "s"}`);
  notifyTable(code);
  return json(publicState(code));
};
