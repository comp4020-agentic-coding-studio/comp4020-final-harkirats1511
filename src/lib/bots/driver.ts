// Bots that play inside the server. A bot is a person row with is_bot set, seated at a
// table like anyone; this module wakes on table changes and plays its turn after a
// human-like pause.
//
// THE RULE THIS FILE KEEPS: a bot decides only from what a real player is given, the
// same two things the browser gets: its own `myView` (what GET /me returns) and the
// public table state (what every stream carries). It acts only through the functions the
// API routes call (pickTrack, castVote, castSteal) with its own person id, so the engine
// applies exactly the checks it applies to people. It never reads game_players, the
// prompts, other players' roles, or this round's hidden picks, and a bot that is the mole
// is handed a /me with no prompt in it. spec/bots.test.ts checks this from outside.
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { people, tableMembers } from "../schema.ts";
import { castSteal, castVote, leaveTable, myView, pickTrack } from "../game.ts";
import { log, tableScope, tag } from "../log.ts";
import {
  botSeats, currentGame, MAX_PLAYERS, memberCount, notifyTable, onTableChange, setRematch, tableFrame, tableOptions,
} from "../tables.ts";
import { crateComplete } from "../taste.ts";
import { buildCrate } from "./crate.ts";
import { decidePick, decideSteal, decideVote, DELAYS, thinkMs, type MeView, type Pub } from "./brain.ts";
import { BOT_NAMES, classOf } from "./names.ts";

type Fail = { ok: false; status: number; error: string };

// Seats a bot at the table (the host's request; the route has checked who is asking).
export function addBot(code: string, by: { id: string; name: string }): { ok: true; name: string } | Fail {
  const t = tableOptions(code);
  if (!t) return { ok: false, status: 404, error: "No such table." };
  if (t.status === "playing") return { ok: false, status: 409, error: "Bots join between games." };
  if (memberCount(code) >= MAX_PLAYERS) return { ok: false, status: 409, error: `This table is full: it seats ${MAX_PLAYERS}.` };
  // A name not seated at any table, preferring a class (genre and fallback crate) this table lacks.
  const busy = new Set(db.select({ id: tableMembers.personId }).from(tableMembers).all().map((r) => r.id));
  const mine = botSeats(code).map((b) => BOT_NAMES.indexOf(b.name)).filter((i) => i >= 0).map(classOf);
  const rows = db.select({ id: people.id, name: people.name, bot: people.isBot }).from(people).where(sql`lower(${people.name}) like 'bot-%'`).all();
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const free = BOT_NAMES.map((name, i) => ({ name, i, row: byName.get(name) })).filter((c) => (!c.row ? true : c.row.bot && !busy.has(c.row.id)));
  if (!free.length) return { ok: false, status: 409, error: "No bot is free right now." };
  const fresh = free.filter((c) => !mine.includes(classOf(c.i)));
  const pool = fresh.length ? fresh : free;
  const pick = pool[randomInt(pool.length)];
  let id = pick.row?.id;
  if (!id) {
    id = randomUUID();
    // No session, and a hash nobody can match: nobody signs in as a bot.
    db.insert(people).values({ id, name: pick.name, pinHash: randomBytes(32).toString("hex"), pinSalt: randomBytes(16).toString("hex"), createdAt: Date.now(), isBot: true }).run();
  }
  db.insert(tableMembers).values({ tableCode: code, personId: id, joinedAt: Date.now() }).onConflictDoNothing().run();
  log(tableScope(code), `${tag(by)} added a bot (${pick.name})`);
  notifyTable(code);
  if (!crateComplete(id)) {
    void buildCrate(id, pick.name, pick.i).then(() => notifyTable(code)).catch(() => {});
  }
  return { ok: true, name: pick.name };
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

// ---- playing ----

// Per bot: the phase it last reacted to, and its pending timers (dropped on any new phase).
type Mind = { key: string; timers: NodeJS.Timeout[] };
const minds = new Map<string, Mind>();
const mindOf = (code: string, id: string) => {
  const k = `${code}:${id}`;
  let m = minds.get(k);
  if (!m) minds.set(k, (m = { key: "", timers: [] }));
  return m;
};
const later = (m: Mind, ms: number, fn: () => void) => {
  const t = setTimeout(() => {
    try {
      fn();
    } catch (e) {
      log("bots", `a bot's move failed: ${(e as Error).message}`);
    }
  }, ms);
  t.unref();
  m.timers.push(t);
};

// What a player gets: the public state and this person's own /me. The one place a bot's inputs are made.
export function botView(code: string, id: string): { pub: Pub; me: MeView } | null {
  const frame = tableFrame(code);
  if (!frame) return null;
  return { pub: frame.state as unknown as Pub, me: myView(code, id) as MeView };
}

function react(code: string) {
  const bots = botSeats(code);
  const live = new Set(bots.map((b) => `${code}:${b.id}`));
  for (const k of [...minds.keys()]) if (k.startsWith(`${code}:`) && !live.has(k)) {
    for (const t of minds.get(k)!.timers) clearTimeout(t);
    minds.delete(k);
  }
  if (!bots.length) return;
  const frame = tableFrame(code);
  if (!frame) return;
  const s = frame.state;
  const g = s.game;
  for (const bot of bots) {
    const m = mindOf(code, bot.id);
    const key = !g || s.status === "open" ? "lobby" : g.winner ? `over:${g.winner}` : `${g.round}:${g.phase}`;
    if (key === m.key) continue;
    m.key = key;
    for (const t of m.timers) clearTimeout(t);
    m.timers = [];
    if (!g) continue;
    if (g.winner) {
      // Game over: a bot is always in for another.
      if (g.winner !== "none") {
        later(m, thinkMs(...DELAYS.rematch, null) , () => {
          if (setRematch(code, bot.id, true)) notifyTable(code);
        });
      }
      continue;
    }
    if (g.phase === "pick") later(m, thinkMs(...DELAYS.pick, g.deadline), () => doPick(code, bot));
    else if (g.phase === "vote") later(m, thinkMs(...DELAYS.vote, g.deadline), () => doVote(code, bot, m, true));
    else if (g.phase === "steal") later(m, thinkMs(...DELAYS.steal, g.deadline), () => doSteal(code, bot));
  }
}

type Seat = { id: string; name: string };

function doPick(code: string, bot: Seat) {
  const v = botView(code, bot.id);
  if (!v || v.pub.game?.phase !== "pick" || v.me.role === "spectator" || v.me.role === "ghost") return;
  if (v.me.picked) return;
  const choice = decidePick(v.me, bot.name, v.pub);
  if (!choice) return;
  const from = choice.from;
  pickTrack(code, bot.id, choice.trackId, from);
}

function doVote(code: string, bot: Seat, m: Mind, first: boolean) {
  const v = botView(code, bot.id);
  if (!v || v.pub.game?.phase !== "vote" || (v.me.role !== "player" && v.me.role !== "mole")) return;
  const choice = decideVote(v.me, bot.name, v.pub);
  castVote(code, bot.id, choice);
  // Now and then it changes its mind once before the vote locks.
  if (first && Math.random() < 0.25) {
    const left = (currentGame(code)?.deadline ?? Date.now() + 5000) - Date.now();
    later(m, Math.min(3000 + Math.random() * 3000, Math.max(0, left * 0.5)), () => doVote(code, bot, m, false));
  }
}

function doSteal(code: string, bot: Seat) {
  const v = botView(code, bot.id);
  if (!v || !v.me.steal) return;
  const guess = decideSteal(v.me, v.pub);
  if (guess) castSteal(code, bot.id, guess);
}

let started = false;
// Wires the bots to table changes. Idempotent.
export function startBots() {
  if (started) return;
  started = true;
  onTableChange((code) => {
    // Not inside the change that woke us: after it has finished.
    setImmediate(() => react(code));
  });
}

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
  let removed = 0;
  for (const { code } of rows) {
    const humans = db
      .select({ n: sql<number>`count(*)` })
      .from(tableMembers)
      .innerJoin(people, eq(people.id, tableMembers.personId))
      .where(and(eq(tableMembers.tableCode, code), eq(people.isBot, false)))
      .get()!.n;
    if (humans === 0) {
      for (const b of botSeats(code)) {
        leaveTable(code, b.id);
        removed++;
      }
    } else react(code);
  }
  if (rows.length) log("bots", `boot · ${rows.length} table${rows.length === 1 ? "" : "s"} had bots, ${removed} bot${removed === 1 ? "" : "s"} sent home`);
}
