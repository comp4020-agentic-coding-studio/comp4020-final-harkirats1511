import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { DEEZER_BUSY, DeezerBusy, DeezerDown, logDeezer, getPreviewUrl } from "../../../../lib/deezer.ts";

export const GET: APIRoute = async ({ cookies, params }) => {
  if (!personFromCookies(cookies)) return json({ error: "Sign in first." }, 401);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Bad track id." }, 400);
  try {
    const url = await getPreviewUrl(id);
    return url ? json({ url }) : json({ error: "No preview for that track." }, 404);
  } catch (e) {
    if (e instanceof DeezerDown) logDeezer("preview", e);
    if (e instanceof DeezerBusy) return json({ error: DEEZER_BUSY }, 503);
    if (e instanceof DeezerDown) return json({ error: "Music service is unavailable right now." }, 502);
    throw e;
  }
};
