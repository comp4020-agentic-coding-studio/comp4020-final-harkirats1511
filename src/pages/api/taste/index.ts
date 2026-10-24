import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { DeezerDown, getTrack } from "../../../lib/deezer.ts";
import { log, refused, tag } from "../../../lib/log.ts";
import { notifyTablesOf } from "../../../lib/tables.ts";
import { addTaste, CRATE_LOCKED, crateLocked, isSlot, listTaste, PER_SLOT, TASTE_MAX } from "../../../lib/taste.ts";

export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json(listTaste(me.id));
};

// Body {trackId, slot}: slot is "up" | "down" | "out" | "in".
export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("taste", null, "add to crate", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const body = (await request.json().catch(() => ({}))) as { trackId?: unknown; slot?: unknown };
  const raw = body.trackId;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "trackId must be a number." }, 400);
  if (!isSlot(body.slot)) return json({ error: 'slot is "up", "down", "out" or "in".' }, 400);
  if (crateLocked(me.id)) {
    refused("taste", tag(me), "add to crate", "crate is locked");
    return json({ error: CRATE_LOCKED }, 409);
  }

  // Title and artist come from Deezer, never from the client.
  let track;
  try {
    track = await getTrack(id);
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music search is unavailable right now." }, 502);
    throw e;
  }
  if (!track) return json({ error: "No such track." }, 404);

  // Locked again after the lookup: a game may have started while it ran.
  if (crateLocked(me.id)) {
    refused("taste", tag(me), "add to crate", "crate is locked");
    return json({ error: CRATE_LOCKED }, 409);
  }
  const result = addTaste(me.id, track, body.slot);
  if (result === "full" || result === "slot-full") {
    refused("taste", tag(me), "add to crate", result === "full" ? "crate is full" : `${body.slot} is full`);
    return json({ error: result === "full" ? `A crate holds ${TASTE_MAX} tracks.` : `A slot holds ${PER_SLOT} tracks.` }, 409);
  }
  if (result === "added") {
    log("taste", `${tag(me)} added a track to their crate`);
    notifyTablesOf(me.id);
  }
  return json(listTaste(me.id), result === "added" ? 201 : 200);
};
