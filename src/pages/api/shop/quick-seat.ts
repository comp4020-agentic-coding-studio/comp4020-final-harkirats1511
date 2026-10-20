import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { quickSeatCode } from "../../../lib/booths.ts";
import { refused, tag } from "../../../lib/log.ts";
import { joinTable } from "../../../lib/tables.ts";

// Sit at the fullest public booth that is still waiting.
export const POST: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("shop", null, "quick seat", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const code = quickSeatCode(me.id);
  if (!code) {
    refused("shop", tag(me), "quick seat", "no public booth is waiting");
    return json({ error: "No public booth is waiting for players." }, 404);
  }
  const res = joinTable(code, me);
  return res.ok ? json({ code }) : json({ error: res.error }, res.status);
};
