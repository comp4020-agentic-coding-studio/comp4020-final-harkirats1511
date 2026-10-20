import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { leaveTable } from "../../../../lib/game.ts";
import { refused, tableScope, tag } from "../../../../lib/log.ts";
import { isHost, normaliseCode, publicState, tableExists } from "../../../../lib/tables.ts";
import { db } from "../../../../lib/db.ts";
import { people, tableMembers } from "../../../../lib/schema.ts";
import { and, eq, sql } from "drizzle-orm";

// Body {name}: the host takes a member out of the table for good. Everything
// leaving does (host passing, game consequences) happens too.
export const POST: APIRoute = async ({ params, cookies, request }) => {
  const me = personFromCookies(cookies);
  const code = normaliseCode(params.code);
  if (!me) {
    refused(tableScope(code), null, "remove", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isHost(code, me.id)) {
    refused(tableScope(code), tag(me), "remove", "not the host");
    return json({ error: "Only the host can remove someone." }, 403);
  }
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "Say who to remove." }, 400);
  const name = body.name.trim();
  if (name.toLowerCase() === me.name.toLowerCase()) {
    refused(tableScope(code), tag(me), "remove", "can't remove yourself");
    return json({ error: "You can't remove yourself; leave instead." }, 400);
  }
  const target = db
    .select({ id: people.id })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(and(eq(tableMembers.tableCode, code), sql`lower(${people.name}) = lower(${name})`))
    .get();
  if (!target) {
    refused(tableScope(code), tag(me), "remove", "not at this table");
    return json({ error: "Nobody by that name is at this table." }, 404);
  }
  leaveTable(code, target.id, me.id);
  return json(publicState(code));
};
