import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Avatar, defaultAvatar, PARTS } from "./avatar.ts";
import type { Person } from "./auth.ts";
import { db } from "./db.ts";
import { crateSize, MIN_CRATE } from "./taste.ts";
import { log, personTag, refused, tableScope, tag } from "./log.ts";
import {
  avatars, gamePlayers, gameThemes, games, people, picks, tableMembers, tableRemovals, tableReports, tables, votes,
} from "./schema.ts";
import { HOUSE_ID } from "./house.ts";

// No I or O: they read as 1 and 0 when a code is shouted across a room.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const MIN_PLAYERS = 3;
// More than this and a table is refused at start: the votes and slots stop fitting a phone.
export const MAX_PLAYERS = 10;
export const DEFAULT_PICK_SECONDS = 60;
export const DEFAULT_VOTE_SECONDS = 45;
export const DEFAULT_SLOT_SECONDS = 30;
export type TableOptions = {
  pickSeconds: number; voteSeconds: number; moles: number | null; autoplay: boolean; slotSeconds: number;
  private: boolean;
};
export const REPORT_REASONS = ["rude names", "spam", "trolling the game", "something else"];

export function normaliseCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += LETTERS[randomInt(LETTERS.length)];
  return code;
}

// Moles when the host doesn't say: 1 for 3 to 5 players, 2 for 6 to 10.
export const defaultMoles = (players: number) => (players <= 5 ? 1 : 2);
// The most moles a table of n can hold: strictly fewer than everyone else.
export const maxMoles = (players: number) => Math.floor((players - 1) / 2);

export function createTable(hostId: string, opts: TableOptions): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomCode();
    const now = Date.now();
    try {
      db.transaction((tx) => {
        tx.insert(tables).values({ code, hostPersonId: hostId, status: "open", ...opts, createdAt: now }).run();
        tx.insert(tableMembers).values({ tableCode: code, personId: hostId, joinedAt: now }).run();
      });
      log(tableScope(code), `${personTag(hostId)} created the table · pick ${opts.pickSeconds}s, vote ${opts.voteSeconds}s${opts.autoplay ? `, autoplay ${opts.slotSeconds}s/track` : ""}${opts.private ? ", private" : ""}`);
      notifyTable(code);
      return code;
    } catch {
      // code collision: try another
    }
  }
  throw new Error("could not allocate a table code");
}

export function tableExists(code: string): boolean {
  return !!db.select({ c: tables.code }).from(tables).where(eq(tables.code, code)).get();
}

export function addMember(code: string, personId: string): boolean {
  const res = db
    .insert(tableMembers)
    .values({ tableCode: code, personId, joinedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function isRemoved(code: string, personId: string): boolean {
  return !!db
    .select({ p: tableRemovals.personId })
    .from(tableRemovals)
    .where(and(eq(tableRemovals.tableCode, code), eq(tableRemovals.personId, personId)))
    .get();
}

export type Fail = { ok: false; status: number; error: string };

// Sitting down, from the join route and from quick seat: same checks, same lines.
export function joinTable(code: string, me: Person): { ok: true; state: PublicTable | null } | Fail {
  if (!tableExists(code)) {
    refused("table", tag(me), `join ${code}`, "no such table");
    return { ok: false, status: 404, error: "No such table." };
  }
  if (isRemoved(code, me.id)) {
    refused(tableScope(code), tag(me), "join", "removed from this table");
    return { ok: false, status: 403, error: "The host removed you from this table." };
  }
  if (addMember(code, me.id)) {
    log(tableScope(code), `${tag(me)} joined the table`);
    notifyTable(code);
  }
  return { ok: true, state: publicState(code) };
}

// A crate change can flip crateReady, which the lobby shows: tell their tables.
export function notifyTablesOf(personId: string) {
  for (const r of db.select({ c: tableMembers.tableCode }).from(tableMembers).where(eq(tableMembers.personId, personId)).all()) notifyTable(r.c);
}

// True the first time this person reports this table.
export function addReport(code: string, personId: string, reason: string): boolean {
  return db
    .insert(tableReports)
    .values({ tableCode: code, personId, reason, at: Date.now() })
    .onConflictDoNothing()
    .run().changes > 0;
}

export function setPrivate(code: string, value: boolean) {
  db.update(tables).set({ private: value }).where(eq(tables.code, code)).run();
}

export function isHost(code: string, personId: string): boolean {
  return db.select({ h: tables.hostPersonId }).from(tables).where(eq(tables.code, code)).get()?.h === personId;
}

export function memberCount(code: string): number {
  return db.select().from(tableMembers).where(eq(tableMembers.tableCode, code)).all().length;
}

export function tableOptions(code: string) {
  return db.select().from(tables).where(eq(tables.code, code)).get();
}

export function isMember(code: string, personId: string): boolean {
  return !!db
    .select({ p: tableMembers.personId })
    .from(tableMembers)
    .where(and(eq(tableMembers.tableCode, code), eq(tableMembers.personId, personId)))
    .get();
}

// The table's current game: the latest one it started.
export function currentGame(code: string) {
  return db.select().from(games).where(eq(games.tableCode, code)).orderBy(desc(games.startedAt), sql`rowid desc`).get();
}

export function setStatus(code: string, status: string) {
  db.update(tables).set({ status }).where(eq(tables.code, code)).run();
}

// What anyone holding the code may see, and all the event stream ever carries:
// no ids, no PINs, nothing private to one player. Always read from the
// database, so a reconnect or a restart restores it. Before the reveal it holds
// nothing about roles, themes, picks or votes, so it cannot change when
// someone picks or votes; only the phase moving on shows it.
export type PublicGame = {
  round: number;
  phase: string;
  deadline: number | null;
  nowPlaying: number | null;
  // Whether the server plays the slots by itself; a table setting, public.
  autoplay: boolean;
  alive: string[];
  ghosts: string[];
  // Votes while the vote is open (decision 0008): a count per track and for
  // skip, never who cast them. Every slot is listed, so a track with no votes
  // looks like any other, and the house record is not marked.
  tally?: { slot: number; votes: number }[];
  skips?: number;
  // True once everyone who can vote has: the deadline is the end of the last call.
  lastCall?: boolean;
  reveal?: {
    ejected: string | null;
    wasMole: boolean;
    // True when the track with the most votes was the house record.
    ejectedHouse: boolean;
    // owner is absent for the house record, which carries house and inspiredBy.
    slots: { slot: number; owner?: string; house?: true; inspiredBy?: string; title: string; artist: string; cover?: string }[];
    // Who voted for which slot, shown only now; slot is null for skip.
    votes: { voter: string; slot: number | null }[];
  };
  winner?: string;
  // Every round's pair, only once the game is over.
  themes?: { round: number; majority: string; mole: string }[];
};
export type PublicTable = {
  code: string;
  status: string;
  host: string;
  // Public: the table page tells its members, the shop lists only a private booth's host.
  private: boolean;
  // Whether this member has the tracks to play (public; never the tracks themselves).
  members: { name: string; avatar: Avatar; crateReady: boolean }[];
  game?: PublicGame;
};

function publicGame(code: string): PublicGame | undefined {
  const g = currentGame(code);
  if (!g) return undefined;
  // Players still at the table, in the order they joined.
  const inGame = db
    .select({ name: people.name, id: people.id, role: gamePlayers.role, ejected: gamePlayers.ejectedRound })
    .from(gamePlayers)
    .innerJoin(tableMembers, and(eq(tableMembers.personId, gamePlayers.personId), eq(tableMembers.tableCode, code)))
    .innerJoin(people, eq(people.id, gamePlayers.personId))
    .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.left, 0)))
    .orderBy(asc(tableMembers.joinedAt), asc(people.name))
    .all();
  const out: PublicGame = {
    round: g.round,
    phase: g.phase,
    deadline: g.deadline,
    nowPlaying: g.nowPlaying,
    autoplay: tableOptions(code)?.autoplay ?? false,
    alive: inGame.filter((p) => p.ejected === null).map((p) => p.name),
    ghosts: inGame.filter((p) => p.ejected !== null).map((p) => p.name),
  };
  if (g.winner) {
    out.winner = g.winner;
    out.themes = db
      .select({ round: gameThemes.round, majority: gameThemes.majority, mole: gameThemes.mole })
      .from(gameThemes)
      .where(eq(gameThemes.gameId, g.id))
      .orderBy(asc(gameThemes.round))
      .all();
  }
  if (g.phase === "vote" && !g.winner) {
    const rows = db.select({ slot: picks.slot }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), isNotNull(picks.slot))).orderBy(asc(picks.slot)).all();
    const cast = db.select({ slot: votes.slot }).from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all();
    out.tally = rows.map((r) => ({ slot: r.slot!, votes: cast.filter((v) => v.slot === r.slot).length }));
    out.skips = cast.filter((v) => v.slot === null).length;
    if (g.lastCall) out.lastCall = true;
  }
  if (g.phase === "reveal" || g.winner) {
    const ejected = inGame.find((p) => p.id === g.ejectedPersonId);
    const slots = db
      .select({ slot: picks.slot, owner: people.name, who: picks.personId, inspiredBy: picks.inspiredBy, title: picks.title, artist: picks.artist, cover: picks.cover })
      .from(picks)
      .leftJoin(people, eq(people.id, picks.personId))
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), isNotNull(picks.slot)))
      .orderBy(asc(picks.slot))
      .all()
      .map(({ who, owner, inspiredBy, ...r }): NonNullable<PublicGame["reveal"]>["slots"][number] => {
        const base = { ...r, slot: r.slot!, cover: r.cover ?? undefined };
        if (who !== HOUSE_ID) return { ...base, owner: owner ?? undefined };
        const label = inspiredBy ? ejectedName(inspiredBy) : null;
        return { ...base, house: true, ...(label ? { inspiredBy: label } : {}) };
      });
    const cast = db
      .select({ voter: people.name, slot: votes.slot })
      .from(votes)
      .innerJoin(people, eq(people.id, votes.voterPersonId))
      .where(and(eq(votes.gameId, g.id), eq(votes.round, g.round)))
      .orderBy(asc(people.name))
      .all();
    out.reveal = {
      // A person who left after being ejected is gone from the table; their name still shows.
      ejected: g.ejectedPersonId ? (ejected?.name ?? ejectedName(g.ejectedPersonId)) : null,
      wasMole: !!g.ejectedPersonId && roleOf(g.id, g.ejectedPersonId) === "mole",
      ejectedHouse: g.voteSlot !== null && slots.some((x) => x.slot === g.voteSlot && x.house),
      slots,
      votes: cast,
    };
  }
  return out;
}

function ejectedName(personId: string): string | null {
  return db.select({ n: people.name }).from(people).where(eq(people.id, personId)).get()?.n ?? null;
}

function roleOf(gameId: string, personId: string): string | undefined {
  return db
    .select({ r: gamePlayers.role })
    .from(gamePlayers)
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.personId, personId)))
    .get()?.r;
}

export function publicState(code: string): PublicTable | null {
  const t = db
    .select({ code: tables.code, status: tables.status, host: people.name, private: tables.private })
    .from(tables)
    .innerJoin(people, eq(people.id, tables.hostPersonId))
    .where(eq(tables.code, code))
    .get();
  if (!t) return null;
  const members = db
    .select({ id: people.id, name: people.name, a: avatars })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .leftJoin(avatars, eq(avatars.personId, people.id))
    .where(eq(tableMembers.tableCode, code))
    .orderBy(asc(tableMembers.joinedAt), asc(people.name))
    .all()
    .map((m) => ({
      name: m.name,
      crateReady: crateSize(m.id) >= MIN_CRATE,
      avatar: m.a ? (Object.fromEntries(PARTS.map((p) => [p, m.a![p]])) as Avatar) : defaultAvatar(m.id),
    }));
  const game = publicGame(code);
  return game ? { ...t, members, game } : { ...t, members };
}

// In-process pub/sub: the app runs as a single machine. A listener is told a
// table changed and re-reads the state itself.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// Whoever wants to hear about any table (the shop's booth list) rather than one.
const anyTable = new Set<() => void>();

export function notifyTable(code: string) {
  bus.emit(code);
  for (const fn of anyTable) fn();
}

export function watchAnyTable(fn: () => void): () => void {
  anyTable.add(fn);
  return () => anyTable.delete(fn);
}

// Someone opening or closing a table page changes whether it is a live booth.
export function watchTable(code: string, fn: () => void): () => void {
  bus.on(code, fn);
  for (const f of anyTable) f();
  return () => {
    bus.off(code, fn);
    for (const f of anyTable) f();
  };
}

// How many open table pages (streams) are following this table right now.
export const tableWatchers = (code: string) => bus.listenerCount(code);

// ---- history ----

export type HistoryGame = {
  code: string;
  finishedAt: number;
  winner: string;
  players: string[];
  rounds: { round: number; majority: string; mole: string }[];
  mine: { round: number; theme: string; wasMole: boolean; title: string; artist: string }[];
};

// Finished games this person was still in when they ended, newest first, at
// most `limit`. Everything but `mine` is what the game-over screen shows the
// whole table; `mine` is only this person's own theme and pick per round. A
// game they left before the end is left out (they weren't at the table for the
// reveal), as is any game still running. Four indexed queries however many
// games and rounds there are.
export function historyFor(personId: string, limit = 20): HistoryGame[] {
  const finished = sql<number>`coalesce(${games.finishedAt}, ${games.startedAt})`;
  const mineGames = db
    .select({ id: games.id, code: games.tableCode, winner: games.winner, finishedAt: finished, role: gamePlayers.role, ejected: gamePlayers.ejectedRound })
    .from(gamePlayers)
    .innerJoin(games, eq(games.id, gamePlayers.gameId))
    .where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0), isNotNull(games.winner)))
    .orderBy(desc(finished), sql`games.rowid desc`)
    .limit(limit)
    .all();
  if (!mineGames.length) return [];
  const ids = mineGames.map((g) => g.id);
  const names = db
    .select({ gameId: gamePlayers.gameId, name: people.name })
    .from(gamePlayers)
    .innerJoin(people, eq(people.id, gamePlayers.personId))
    .where(and(inArray(gamePlayers.gameId, ids), eq(gamePlayers.left, 0)))
    .orderBy(asc(people.name))
    .all();
  const themes = db
    .select()
    .from(gameThemes)
    .where(inArray(gameThemes.gameId, ids))
    .orderBy(asc(gameThemes.round))
    .all();
  const myPicks = db
    .select({ gameId: picks.gameId, round: picks.round, title: picks.title, artist: picks.artist })
    .from(picks)
    .where(and(inArray(picks.gameId, ids), eq(picks.personId, personId)))
    .all();
  return mineGames.map((g) => {
    const rounds = themes.filter((t) => t.gameId === g.id).map((t) => ({ round: t.round, majority: t.majority, mole: t.mole }));
    const wasMole = g.role === "mole";
    return {
      code: g.code,
      finishedAt: g.finishedAt,
      winner: g.winner!,
      players: names.filter((n) => n.gameId === g.id).map((n) => n.name),
      rounds,
      // Their own side of the pair: the odd one while a mole and still in, else the majority's.
      mine: myPicks
        .filter((p) => p.gameId === g.id)
        .sort((a, b) => a.round - b.round)
        .flatMap((p) => {
          const r = rounds.find((x) => x.round === p.round);
          if (!r) return [];
          const odd = wasMole && (g.ejected === null || p.round <= g.ejected);
          return [{ round: p.round, theme: odd ? r.mole : r.majority, wasMole, title: p.title, artist: p.artist }];
        }),
    };
  });
}
