import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { DEEZER_BUSY, DeezerBusy, DeezerDown, logDeezer } from "../../../../lib/deezer.ts";
import { getJukebox, queueSong } from "../../../../lib/jukebox.ts";
import { refused } from "../../../../lib/log.ts";

// What the jukebox is playing and what is queued: songs and their pickers, all public in the shop.
export const GET: APIRoute = () => json(getJukebox());

// Body {trackId}: a song from your own crate, clean enough for the starter. Signed in, on the floor,
// one queued per person, at most 12 queued.
export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("shop", null, "queue a song on the jukebox", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const b = ((await request.json().catch(() => ({}))) ?? {}) as { trackId?: unknown };
  const id = b.trackId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return json({ error: "trackId is a number." }, 400);
  try {
    const res = await queueSong(me, id);
    return res.ok ? json({ play: res.play }, 201) : json({ error: res.error }, res.status);
  } catch (e) {
    if (e instanceof DeezerDown) logDeezer("jukebox", e);
    if (e instanceof DeezerBusy) return json({ error: DEEZER_BUSY }, 503);
    if (e instanceof DeezerDown) return json({ error: "Music service is unavailable right now." }, 502);
    throw e;
  }
};
