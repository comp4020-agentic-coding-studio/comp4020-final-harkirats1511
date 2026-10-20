import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { log, refused, tag } from "../../../lib/log.ts";
import { notifyTablesOf } from "../../../lib/tables.ts";
import { removeTaste } from "../../../lib/taste.ts";

export const DELETE: APIRoute = ({ cookies, params }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("taste", null, "remove from taste file", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const id = Number(params.trackId);
  if (!Number.isSafeInteger(id)) return json({ error: "Bad track id." }, 400);
  removeTaste(me.id, id);
  notifyTablesOf(me.id);
  log("taste", `${tag(me)} removed a track from their taste file`);
  return json({ ok: true });
};
