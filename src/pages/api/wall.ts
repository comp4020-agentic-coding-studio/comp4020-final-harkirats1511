import type { APIRoute } from "astro";
import { json } from "../../lib/auth.ts";
import { WALL_DEFAULT, WALL_MAX, wallPage } from "../../lib/wall.ts";

// The shop wall (decision 0011): revealed rounds of public tables, newest first. Public, no sign-in:
// it holds only what those tables showed at their reveals. ?before=<revealedAt ms>&limit=<1..40>.
export const GET: APIRoute = ({ url }) => {
  const b = url.searchParams.get("before");
  const l = url.searchParams.get("limit");
  const before = b === null || b === "" ? null : Number(b);
  if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) return json({ error: "before is a time in ms." }, 400);
  const limit = l === null || l === "" ? WALL_DEFAULT : Number(l);
  if (!Number.isInteger(limit) || limit < 1 || limit > WALL_MAX) return json({ error: `limit is 1 to ${WALL_MAX}.` }, 400);
  return json(wallPage(before, limit));
};
