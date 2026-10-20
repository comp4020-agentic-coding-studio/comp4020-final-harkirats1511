import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { log, refused, tableScope, tag } from "../../../../lib/log.ts";
import { addReport, normaliseCode, REPORT_REASONS, tableExists } from "../../../../lib/tables.ts";

// Body {reason}: one of REPORT_REASONS. It writes a log line and nothing else.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "report", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { reason?: unknown };
  if (typeof body.reason !== "string" || !REPORT_REASONS.includes(body.reason)) {
    return json({ error: `reason is one of: ${REPORT_REASONS.join(", ")}.` }, 400);
  }
  if (!addReport(code, me.id, body.reason)) {
    refused(tableScope(code), tag(me), "report", "already reported this table");
    return json({ error: "You already reported this table." }, 409);
  }
  log(tableScope(code), `${tag(me)} reported the table · ${body.reason}`);
  return json({ ok: true });
};
