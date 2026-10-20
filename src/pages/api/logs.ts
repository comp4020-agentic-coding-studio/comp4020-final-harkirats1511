import { createHash, timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { recentLines } from "../../lib/log.ts";
import { normaliseCode } from "../../lib/tables.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();

// The recent server log, for whoever holds LOG_TOKEN. Anyone else, or any
// server without LOG_TOKEN, gets exactly what an unknown route gets.
export const GET: APIRoute = ({ request, url, rewrite }) => {
  const token = process.env.LOG_TOKEN;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  // Answer exactly as an unknown route would (Astro's own 404 page), so a probe
  // can't tell this endpoint exists.
  if (!token || !given || !timingSafeEqual(digest(given), digest(token))) return rewrite("/404");
  const table = url.searchParams.get("table");
  const lines = recentLines(table ? normaliseCode(table) : undefined);
  return new Response(lines.length ? `${lines.join("\n")}\n` : "", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
};
