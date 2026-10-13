import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, gameThemes, games, people, picks, tableMembers, tables } from "./schema.ts";

// No I or O: they read as 1 and 0 when a code is shouted across a room.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const MIN_PLAYERS = 3;
// More than this and a table is refused at start: the votes and slots stop fitting a phone.
export const MAX_PLAYERS = 10;
export const DEFAULT_PICK_SECONDS = 60;
export const DEFAULT_VOTE_SECONDS = 45;
export type TableOptions = { pickSeconds: number; voteSeconds: number; moles: number | null };

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
  members: string[];
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
    .select({ name: people.name })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(eq(tableMembers.tableCode, code))
    .orderBy(asc(tableMembers.joinedAt), asc(people.name))
    .all()
    .map((m) => m.name);
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
