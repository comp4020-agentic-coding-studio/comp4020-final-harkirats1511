import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Avatar, defaultAvatar, PARTS } from "./avatar.ts";
import { db } from "./db.ts";
import { log, personTag, tableScope } from "./log.ts";
import { avatars, gamePlayers, gameThemes, games, people, picks, tableMembers, tables } from "./schema.ts";

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
};

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
      log(tableScope(code), `${personTag(hostId)} created the table · pick ${opts.pickSeconds}s, vote ${opts.voteSeconds}s${opts.autoplay ? `, autoplay ${opts.slotSeconds}s/track` : ""}`);
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
  reveal?: {
    ejected: string | null;
    wasMole: boolean;
    slots: { slot: number; owner: string; title: string; artist: string; cover?: string }[];
  };
  winner?: string;
  // Every round's pair, only once the game is over.
  themes?: { round: number; majority: string; mole: string }[];
};
export type PublicTable = {
  code: string;
  status: string;
  host: string;
  members: { name: string; avatar: Avatar }[];
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
  if (g.phase === "reveal" || g.winner) {
    const ejected = inGame.find((p) => p.id === g.ejectedPersonId);
    const slots = db
      .select({ slot: picks.slot, owner: people.name, title: picks.title, artist: picks.artist, cover: picks.cover })
      .from(picks)
      .innerJoin(people, eq(people.id, picks.personId))
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), isNotNull(picks.slot)))
      .orderBy(asc(picks.slot))
      .all()
      .map((r) => ({ ...r, slot: r.slot!, cover: r.cover ?? undefined }));
    out.reveal = {
      // A person who left after being ejected is gone from the table; their name still shows.
      ejected: g.ejectedPersonId ? (ejected?.name ?? ejectedName(g.ejectedPersonId)) : null,
      wasMole: !!g.ejectedPersonId && roleOf(g.id, g.ejectedPersonId) === "mole",
      slots,
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
    .select({ code: tables.code, status: tables.status, host: people.name })
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
      avatar: m.a ? (Object.fromEntries(PARTS.map((p) => [p, m.a![p]])) as Avatar) : defaultAvatar(m.id),
    }));
  const game = publicGame(code);
  return game ? { ...t, members, game } : { ...t, members };
}

// In-process pub/sub: the app runs as a single machine. A listener is told a
// table changed and re-reads the state itself.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function notifyTable(code: string) {
  bus.emit(code);
}

export function watchTable(code: string, fn: () => void): () => void {
  bus.on(code, fn);
  return () => bus.off(code, fn);
}

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
