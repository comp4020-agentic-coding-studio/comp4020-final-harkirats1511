import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { createTable, isPace, PACES } from "../../../lib/tables.ts";
import { refused } from "../../../lib/log.ts";

const MIN_SECONDS = 2;
const MAX_SECONDS = 300;

// A duration must be an integer; one outside 2..300 seconds is clamped into it.
function seconds(raw: unknown, fallback: number, max = MAX_SECONDS): number | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  return Math.min(max, Math.max(MIN_SECONDS, raw));
}

export const POST: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("table", null, "create a table", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  // Every option is optional, and the body may be empty.
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const autoplay = body.autoplay ?? false;
  if (typeof autoplay !== "boolean") return json({ error: "autoplay is true or false." }, 400);
  const priv = body.private ?? false;
  if (typeof priv !== "boolean") return json({ error: "private is true or false." }, 400);
  // A pace preset ("quick" | "normal" | "chill") sets the three timings; a number sent
  // alongside it still wins, so the form's Custom disclosure needs no preset.
  if (body.pace !== undefined && !isPace(body.pace)) return json({ error: "pace is quick, normal or chill." }, 400);
  const pace = PACES[body.pace === undefined ? "normal" : (body.pace as keyof typeof PACES)];
  const slotSeconds = seconds(body.slotSeconds, pace.slotSeconds, 120);
  if (slotSeconds === null) return json({ error: "slotSeconds is a whole number of seconds." }, 400);
  const pickSeconds = seconds(body.pickSeconds, pace.pickSeconds);
  const voteSeconds = seconds(body.voteSeconds, pace.voteSeconds);
  if (pickSeconds === null || voteSeconds === null) {
    return json({ error: "pickSeconds and voteSeconds are whole numbers of seconds." }, 400);
  }
  // The mole count is chosen in the lobby (POST /api/tables/:code/moles), where the player count is known; a `moles` here is ignored.
  const moles = null;
  return json({ code: createTable(me.id, { pickSeconds, voteSeconds, moles, autoplay, slotSeconds, private: priv }) }, 201);
};
