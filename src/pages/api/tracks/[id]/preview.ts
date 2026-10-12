import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { DeezerDown, getPreviewUrl } from "../../../../lib/deezer.ts";

export const GET: APIRoute = async ({ cookies, params }) => {
  if (!personFromCookies(cookies)) return json({ error: "Sign in first." }, 401);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Bad track id." }, 400);
  try {
    const url = await getPreviewUrl(id);
    return url ? json({ url }) : json({ error: "No preview for that track." }, 404);
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music service is unavailable right now." }, 502);
    throw e;
  }
};
