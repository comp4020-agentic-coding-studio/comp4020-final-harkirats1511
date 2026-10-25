// Seating bots: the part of the bot code that needs the database. A bot is a person row with
// is_bot set. A name is unique per table, not across the server: a second table that wants
// "bot-ivy" gets the row "bot-ivy2" (see names.ts), and a row that has left its table is
// reused by the next one, so a crate is built once. A bot row sits at one table at a time. THE DRIVER (driver.ts, which plays) AND THE BRAIN MUST NOT IMPORT THIS
// FILE: it can see everything, and they may see only what a player does.
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { people, tableMembers, tables } from "../schema.ts";
import { leaveTable } from "../game.ts";
import { log, tableScope, tag } from "../log.ts";
import {
  botSeats, humanCount, MAX_PLAYERS, memberCount, notifyTable, tableOptions, tableWatchers,
} from "../tables.ts";
import { crateComplete } from "../taste.ts";
import { buildCrate } from "./crate.ts";
import { react, startBots } from "./driver.ts";
import { baseName, BOT_NAMES, classOf, rowName } from "./names.ts";

type Fail = { ok: false; status: number; error: string };

// The most bots one host may have seated across all their tables.
export const MAX_BOTS_PER_HOST = 14;
// A lobby nobody has had open for this long sends its bots home.
export const UNWATCHED_MS = 10 * 60 * 1000;

function botsOfHost(hostId: string): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .innerJoin(tables, eq(tables.code, tableMembers.tableCode))
    .where(and(eq(tables.hostPersonId, hostId), eq(people.isBot, true)))
    .get()!.n;
}

// Seats a bot at the table (the host's request; the route has checked who is asking).
export function addBot(code: string, by: { id: string; name: string }): { ok: true; name: string } | Fail {
  const t = tableOptions(code);
  if (!t) return { ok: false, status: 404, error: "No such table." };
  if (t.status === "playing") return { ok: false, status: 409, error: "Bots join between games." };
  if (memberCount(code) >= MAX_PLAYERS) return { ok: false, status: 409, error: `This table is full: it seats ${MAX_PLAYERS}.` };
  if (botsOfHost(t.hostPersonId) >= MAX_BOTS_PER_HOST) {
    return { ok: false, status: 409, error: `You already have ${MAX_BOTS_PER_HOST} bots across your tables. Remove some before adding more.` };
  }
  // A base name nobody at this table has, preferring a class (genre and fallback crate) this table lacks.
  const seated = db
    .select({ name: people.name })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(eq(tableMembers.tableCode, code))
    .all()
    .map((r) => baseName(r.name));
  const mine = botSeats(code).map((b) => BOT_NAMES.indexOf(baseName(b.name))).filter((i) => i >= 0).map(classOf);
  const free = BOT_NAMES.map((name, i) => ({ name, i })).filter((c) => !seated.includes(c.name));
  if (!free.length) return { ok: false, status: 409, error: "No bot is free right now." };
  const fresh = free.filter((c) => !mine.includes(classOf(c.i)));
  const pool = fresh.length ? fresh : free;
  const pick = pool[randomInt(pool.length)];
  // The first row of that name (bot-ivy, bot-ivy2, ...) that sits at no table, so its crate is already
  // built; else the first number nobody has used yet, as a new row.
  let id: string | undefined;
  let rowNameUsed = pick.name;
  for (let n = 1; !id; n++) {
    const name = rowName(pick.name, n);
    const row = db.select({ id: people.id, bot: people.isBot }).from(people).where(sql`lower(${people.name}) = ${name}`).get();
    const sits = row && db.select({ c: tableMembers.tableCode }).from(tableMembers).where(eq(tableMembers.personId, row.id)).get();
    if (row && (!row.bot || sits)) continue; // a person's, or a bot busy elsewhere
    rowNameUsed = name;
    if (row) { id = row.id; break; }
    id = randomUUID();
    // No session, and a hash nobody can match: nobody signs in as a bot.
    db.insert(people).values({ id, name, pinHash: randomBytes(32).toString("hex"), pinSalt: randomBytes(16).toString("hex"), createdAt: Date.now(), isBot: true }).run();
  }
  db.insert(tableMembers).values({ tableCode: code, personId: id, joinedAt: Date.now() }).onConflictDoNothing().run();
  unwatchedSince.set(code, unwatchedSince.get(code) ?? Date.now());
  log(tableScope(code), `${tag(by)} added a bot (${rowNameUsed})`);
  notifyTable(code);
  if (!crateComplete(id)) {
    void buildCrate(id, rowNameUsed, pick.i).then(() => notifyTable(code)).catch(() => {});
  }
  return { ok: true, name: rowNameUsed };
}

// The host takes a bot away, between games.
export function removeBot(code: string, by: { id: string; name: string }, name: string): { ok: true } | Fail {
  const t = tableOptions(code);
  if (!t) return { ok: false, status: 404, error: "No such table." };
  if (t.status === "playing") return { ok: false, status: 409, error: "Bots can be removed between games." };
  const bot = botSeats(code).find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!bot) return { ok: false, status: 404, error: "No bot by that name is at this table." };
  leaveTable(code, bot.id, by.id);
  return { ok: true };
}

// Tables with bots, and since when nobody has had them open (a person's stream is a watcher).
const unwatchedSince = new Map<string, number>();

// Sends home the bots of any table with no person left, and of any table nobody has watched for
// UNWATCHED_MS. Returns how many left. A game in progress is left to finish: it ends by itself.
export function sweepBots(now = Date.now(), after = UNWATCHED_MS): number {
  const rows = db
    .select({ code: tableMembers.tableCode })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(eq(people.isBot, true))
    .groupBy(tableMembers.tableCode)
    .all();
  const live = new Set(rows.map((r) => r.code));
  for (const c of [...unwatchedSince.keys()]) if (!live.has(c)) unwatchedSince.delete(c);
  let removed = 0;
  for (const { code } of rows) {
    const why =
      humanCount(code) === 0 ? "nobody but bots left"
      : tableWatchers(code) > 0 ? ""
      : tableOptions(code)?.status === "playing" ? ""
      : now - (unwatchedSince.get(code) ?? now) >= after ? "nobody has had the table open for a while"
      : "";
    if (tableWatchers(code) > 0) unwatchedSince.set(code, now);
    else if (!unwatchedSince.has(code)) unwatchedSince.set(code, now);
    if (!why) continue;
    log(tableScope(code), `${why}: the bots leave`);
    for (const b of botSeats(code)) {
      leaveTable(code, b.id);
      removed++;
    }
    unwatchedSince.delete(code);
  }
  return removed;
}

let sweeper: NodeJS.Timeout | null = null;

// At boot, after the engine's own resume. Bots with no person left at their table go;
// bots at a table that still has people carry on from the table's state in the database.
export function resumeBots() {
  startBots();
  const rows = db
    .select({ code: tableMembers.tableCode })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(eq(people.isBot, true))
    .groupBy(tableMembers.tableCode)
    .all();
  const removed = sweepBots();
  for (const { code } of rows) if (botSeats(code).length) react(code);
  if (rows.length) log("bots", `boot · ${rows.length} table${rows.length === 1 ? "" : "s"} had bots, ${removed} bot${removed === 1 ? "" : "s"} sent home`);
  if (!sweeper) {
    sweeper = setInterval(() => sweepBots(), 60_000);
    sweeper.unref();
  }
}
