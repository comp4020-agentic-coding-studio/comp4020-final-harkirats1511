import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../../lib/auth.ts";
import { setNowPlaying } from "../../../../../lib/game.ts";
import { isHost, normaliseCode, tableExists } from "../../../../../lib/tables.ts";

// Body {slot}: the anonymous number now playing. Public, since it names no one.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) return json({ error: "Only the host picks what plays." }, 403);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { slot?: unknown };
  const slot = body.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) return json({ error: "Bad slot." }, 400);
  const res = setNowPlaying(code, slot);
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
