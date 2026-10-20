import { createHash, timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { recentLines } from "../../lib/log.ts";
import { normaliseCode } from "../../lib/tables.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();

// The recent server log, for whoever holds LOG_TOKEN. Anyone else, or any
// server without LOG_TOKEN, gets exactly what an unknown route gets.
export const GET: APIRoute = ({ request, url }) => {
  const token = process.env.LOG_TOKEN;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !given || !timingSafeEqual(digest(given), digest(token))) return NOT_FOUND();
  const table = url.searchParams.get("table");
  const lines = recentLines(table ? normaliseCode(table) : undefined);
  return new Response(lines.length ? `${lines.join("\n")}\n` : "", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
};

function NOT_FOUND(): Response {
  return new Response(null, { status: 404 });
}
