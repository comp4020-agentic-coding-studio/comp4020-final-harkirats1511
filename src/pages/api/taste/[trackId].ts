import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { log, refused, tag } from "../../../lib/log.ts";
import { notifyTablesOf } from "../../../lib/tables.ts";
import { CRATE_LOCKED, crateLocked, isSlot, listTaste, moveTaste, PER_SLOT, removeTaste } from "../../../lib/taste.ts";

export const DELETE: APIRoute = ({ cookies, params }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("taste", null, "remove from crate", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const id = Number(params.trackId);
  if (!Number.isSafeInteger(id)) return json({ error: "Bad track id." }, 400);
  if (crateLocked(me.id)) {
    refused("taste", tag(me), "remove from crate", "crate is locked");
    return json({ error: CRATE_LOCKED }, 409);
  }
  removeTaste(me.id, id);
  notifyTablesOf(me.id);
  log("taste", `${tag(me)} removed a track from their crate`);
  return json({ ok: true });
};

// Body {slot}: move a track to another slot (which must have room).
const move: APIRoute = async ({ cookies, params, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("taste", null, "move in crate", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const id = Number(params.trackId);
  if (!Number.isSafeInteger(id)) return json({ error: "Bad track id." }, 400);
  const body = (await request.json().catch(() => ({}))) as { slot?: unknown };
  if (!isSlot(body.slot)) return json({ error: 'slot is "up", "down", "out" or "in".' }, 400);
  if (crateLocked(me.id)) {
    refused("taste", tag(me), "move in crate", "crate is locked");
    return json({ error: CRATE_LOCKED }, 409);
  }
  const res = moveTaste(me.id, id, body.slot);
  if (res === "missing") return json({ error: "That track is not in your crate." }, 404);
  if (res === "slot-full") {
    refused("taste", tag(me), "move in crate", `${body.slot} is full`);
    return json({ error: `A slot holds ${PER_SLOT} tracks.` }, 409);
  }
  log("taste", `${tag(me)} moved a track in their crate`);
  notifyTablesOf(me.id);
  return json(listTaste(me.id));
};
export const PATCH = move;
export const PUT = move;
