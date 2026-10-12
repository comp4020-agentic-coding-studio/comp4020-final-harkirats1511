import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { castVote } from "../../../../lib/game.ts";
import { isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// Body {name}: a member's name, or "skip". Final once cast.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 403);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "Say who to vote for, or skip." }, 400);
  const res = castVote(code, me.id, body.name.trim());
  return res.ok ? json({ ok: true }) : json({ error: res.error }, res.status);
};
