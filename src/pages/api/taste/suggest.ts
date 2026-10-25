import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { DEEZER_BUSY, DeezerBusy, DeezerDown, logDeezer } from "../../../lib/deezer.ts";
import { log, refused, tag } from "../../../lib/log.ts";
import { isSlot, listTaste, suggestFromArtists } from "../../../lib/taste.ts";

// Starter songs from the person's own artists: {artists: string[]} (POST) or
// ?artists=a,b,c (GET). Up to 3 per mood, only tracks with a preview, never an
// explicit one. Nothing is added: the person taps Keep. One call per person per 3 s.
const EVERY_MS = 3000;
const last = new Map<string, number>();

async function handle(cookies: Parameters<APIRoute>[0]["cookies"], raw: unknown, moodsRaw: unknown) {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("taste", null, "suggest", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const now = Date.now();
  const at = last.get(me.id) ?? 0;
  if (now - at < EVERY_MS) {
    refused("taste", tag(me), "suggest", "too fast");
    return json({ error: "One moment, then try again." }, 429, { "retry-after": String(Math.ceil((EVERY_MS - (now - at)) / 1000)) });
  }
  if (last.size > 500) last.clear();
  last.set(me.id, now);

  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const names = [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 60)).filter((x) => x.length >= 2))].slice(0, 3);
  if (!names.length) return json({ error: "Type 1 to 3 artist names." }, 400);
  const only = (Array.isArray(moodsRaw) ? moodsRaw : []).filter(isSlot);

  const skip = new Set(listTaste(me.id).map((t) => t.id));
  try {
    const res = await suggestFromArtists(names, skip, only);
    log("taste", `${tag(me)} asked for starter songs`);
    return json(res);
  } catch (e) {
    if (e instanceof DeezerDown) logDeezer("suggest", e);
    // Deezer's quota says nothing about this person: let them ask again at once.
    if (e instanceof DeezerDown) last.delete(me.id);
    if (e instanceof DeezerBusy) return json({ error: DEEZER_BUSY }, 503);
    if (e instanceof DeezerDown) return json({ error: "Music search is unavailable right now." }, 502);
    throw e;
  }
}

export const GET: APIRoute = ({ cookies, url }) => handle(cookies, url.searchParams.get("artists") ?? "", (url.searchParams.get("moods") ?? "").split(","));
export const POST: APIRoute = async ({ cookies, request }) => {
  const body = (await request.json().catch(() => ({}))) as { artists?: unknown; moods?: unknown };
  return handle(cookies, body.artists, body.moods);
};
