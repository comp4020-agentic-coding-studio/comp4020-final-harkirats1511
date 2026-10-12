import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import {
  createTable, DEFAULT_PICK_SECONDS, DEFAULT_VOTE_SECONDS, maxMoles, MAX_PLAYERS,
} from "../../../lib/tables.ts";

const MIN_SECONDS = 2;
const MAX_SECONDS = 300;

// A duration must be an integer; one outside 2..300 seconds is clamped into it.
function seconds(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, raw));
}

export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  // Every option is optional, and the body may be empty.
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const pickSeconds = seconds(body.pickSeconds, DEFAULT_PICK_SECONDS);
  const voteSeconds = seconds(body.voteSeconds, DEFAULT_VOTE_SECONDS);
  if (pickSeconds === null || voteSeconds === null) {
    return json({ error: "pickSeconds and voteSeconds are whole numbers of seconds." }, 400);
  }
  const speaker = body.speaker ?? "host";
  if (speaker !== "host" && speaker !== "every") return json({ error: 'speaker is "host" or "every".' }, 400);
  // The cap is for the biggest table; start checks it again against who is actually there.
  const moles = body.moles ?? null;
  if (moles !== null && (typeof moles !== "number" || !Number.isInteger(moles) || moles < 1 || moles > maxMoles(MAX_PLAYERS))) {
    return json({ error: `moles is a whole number from 1 to ${maxMoles(MAX_PLAYERS)}.` }, 400);
  }
  return json({ code: createTable(me.id, { pickSeconds, voteSeconds, speaker, moles }) }, 201);
};
