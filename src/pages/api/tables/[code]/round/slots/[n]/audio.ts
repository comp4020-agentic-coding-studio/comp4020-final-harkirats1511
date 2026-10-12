import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../../../../lib/auth.ts";
import { DeezerDown, getPreviewUrl } from "../../../../../../../lib/deezer.ts";
import { slotTrackId } from "../../../../../../../lib/game.ts";
import { isMember, normaliseCode, tableExists } from "../../../../../../../lib/tables.ts";

// A fresh signed preview URL for one anonymous slot; the track id stays here.
export const GET: APIRoute = async ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 403);
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 0) return json({ error: "No such slot." }, 404);
  const id = slotTrackId(code, n);
  if (typeof id !== "number") return json({ error: id.error }, id.status);
  try {
    const url = await getPreviewUrl(id);
    return url ? json({ url }) : json({ error: "No preview for that track." }, 404);
  } catch (e) {
    if (e instanceof DeezerDown) return json({ error: "Music service is unavailable right now." }, 502);
    throw e;
  }
};
