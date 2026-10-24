import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Avatar, defaultAvatar, PARTS } from "./avatar.ts";
import type { Person } from "./auth.ts";
import { db } from "./db.ts";
import { crateComplete, listTaste } from "./taste.ts";
import { PROMPTS, type Slot } from "./prompts.ts";
import { log, personTag, refused, tableScope, tag } from "./log.ts";
import {
  avatars, gamePlayers, gamePrompts, gameThemes, games, people, picks, tableMembers, tableRemovals, tableReports, tables, votes,
} from "./schema.ts";

// No I or O: they read as 1 and 0 when a code is shouted across a room.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const MIN_PLAYERS = 3;
// More than this and a table is refused at start: 8 crates is already 96 songs on a phone.
export const MAX_PLAYERS = 8;
// Tuning dials for playtests (game.ts re-exports them and has the steal ones).
// A table's own pick/vote/track seconds still override these defaults.
export const PICK_SECONDS = 45;
export const VOTE_SECONDS = 30;
export const SECONDS_PER_TRACK = 20;
export const DEFAULT_PICK_SECONDS = PICK_SECONDS;
export const DEFAULT_VOTE_SECONDS = VOTE_SECONDS;
export const DEFAULT_SLOT_SECONDS = SECONDS_PER_TRACK;
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

// The number of moles is a rule, not a setting: 1 for 3 to 5 players, 2 for 6 to 8.
export const defaultMoles = (players: number) => (players <= 5 ? 1 : 2);

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
// database, so a reconnect or a restart restores it. It never holds a prompt,
// a role, or who has picked before picking closes, so it cannot change when
// someone picks; only the phase moving on shows it. Votes show as counts per
// name, never who cast them.
export type PublicCard = {
  order: number; picker: string; lender?: string; trackId: number; title: string; artist: string; cover?: string;
  // True when another card of the same round is the same song (picked blind, so it can happen).
  clash?: true;
};
// A round whose reveal has happened. The picker of a card, or the one ejected,
// may have left the table since; their name still shows.
export type PastRound = {
  round: number; prompt: string; slot: Slot; cards: PublicCard[]; ejected: string | null; wasMole: boolean;
};
export type PublicGame = {
  round: number;
  phase: string;
  deadline: number | null;
  nowPlaying: number | null;
  // Whether the server plays the cards by itself; a table setting, public.
  autoplay: boolean;
  alive: string[];
  ghosts: string[];
  // Listen and vote: every pick, named, in the order they play; and the alive
  // players who missed the pick ("dead air").
  cards?: PublicCard[];
  deadAir?: string[];
  // Vote: a count per alive player and for skip, never who cast them.
  tally?: { name: string; votes: number }[];
  skips?: number;
  // True once everyone who can vote has: the deadline is the end of the last call.
  lastCall?: boolean;
  // Steal: who the room voted out. Never the options or the prompt.
  accused?: string;
  reveal?: {
    prompt: string;
    slot: Slot;
    cards: PublicCard[];
    deadAir: string[];
    // Who voted for whom, shown only now; choice is null for skip.
    votes: { voter: string; choice: string | null }[];
    // The room's choice, even when a steal kept them in.
    accused: string | null;
    ejected: string | null;
    wasMole: boolean;
    stole: boolean;
  };
  // Rounds already revealed, oldest first, never the round in play before its
  // reveal. At game over, every round.
  past: PastRound[];
  // Who has used their borrow, as it became public at listen (never during a pick).
  borrowed: string[];
  // Track ids heard in earlier rounds (this round's too once its picks are public).
  played: number[];
  winner?: string;
  // Who the moles were, only once the game is over; includes any who left.
  moles?: string[];
  // Every round's prompt, only once the game is over.
  prompts?: { round: number; prompt: string; slot: Slot }[];
};
export type PublicCrateTrack = { trackId: number; title: string; artist: string; cover?: string; slot: Slot | null };
export type PublicTable = {
  code: string;
  status: string;
  host: string;
  // Public: the table page tells its members, the shop lists only a private booth's host.
  private: boolean;
  // crateReady: 3 in every slot (public; never the tracks). crate is the
  // player's locked crate, present only while a game is running.
  members: { name: string; avatar: Avatar; crateReady: boolean; crate?: PublicCrateTrack[] }[];
  game?: PublicGame;
};

const promptText = new Map(PROMPTS.map((p) => [p.id, p]));
export const promptById = (id: string) => promptText.get(id);

function cardsOf(gameId: string, round: number): PublicCard[] {
  const lender = alias(people, "lender");
  return db
    .select({
      order: picks.slot, picker: people.name, lender: lender.name, trackId: picks.trackId, title: picks.title, artist: picks.artist, cover: picks.cover,
    })
    .from(picks)
    .innerJoin(people, eq(people.id, picks.personId))
    .leftJoin(lender, eq(lender.id, picks.lenderPersonId))
    .where(and(eq(picks.gameId, gameId), eq(picks.round, round), isNotNull(picks.slot)))
    .orderBy(asc(picks.slot))
    .all()
    .map((r, _i, all) => ({
      order: r.order!, picker: r.picker, ...(r.lender ? { lender: r.lender } : {}), trackId: r.trackId, title: r.title, artist: r.artist,
      ...(r.cover ? { cover: r.cover } : {}),
      ...(all.filter((o) => o.trackId === r.trackId).length > 1 ? { clash: true as const } : {}),
    }));
}

type Q = Pick<typeof db, "select">;

// Every track heard in this game: earlier rounds, and this round once its picks
// are closed (they have a play order). Picks of the round still being picked
// don't count, so a refused pick can never reveal what someone else chose.
export function playedTrackIds(d: Q, g: { id: string; round: number; phase: string }): number[] {
  const rows = d
    .select({ id: picks.trackId })
    .from(picks)
    .where(
      and(
        eq(picks.gameId, g.id),
        g.phase === "pick" ? lt(picks.round, g.round) : sql`(${picks.round} < ${g.round} or (${picks.round} = ${g.round} and ${picks.slot} is not null))`,
      ),
    )
    .all();
  return [...new Set(rows.map((r) => r.id))];
}

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
    past: [],
    borrowed: [],
    played: playedTrackIds(db, g),
  };
  // Borrows are public once their round's picks are closed; this round's, while
  // picking, are not.
  out.borrowed = [
    ...new Set(
      db
        .select({ n: people.name })
        .from(picks)
        .innerJoin(people, eq(people.id, picks.personId))
        .where(and(eq(picks.gameId, g.id), isNotNull(picks.lenderPersonId), sql`(${picks.round} < ${g.round} or ${picks.slot} is not null)`))
        .all()
        .map((r) => r.n),
    ),
  ];
  const nameOf = (id: string | null) => (id ? inGame.find((p) => p.id === id)?.name ?? personName(id) : null);
  // Who the round's pick phase was waiting on and didn't get: alive then, no pick.
  const deadAir = () => {
    const done = new Set(db.select({ p: picks.personId }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all().map((r) => r.p));
    return inGame.filter((p) => (p.ejected === null || p.ejected === g.round) && !done.has(p.id)).map((p) => p.name);
  };
  if (g.winner) {
    out.winner = g.winner;
    // From the game's own players, seated or not: a mole who left is still named.
    out.moles = db
      .select({ name: people.name })
      .from(gamePlayers)
      .innerJoin(people, eq(people.id, gamePlayers.personId))
      .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.role, "mole")))
      .orderBy(asc(people.name))
      .all()
      .map((r) => r.name);
    out.prompts = db
      .select({ round: gamePrompts.round, promptId: gamePrompts.promptId, slot: gamePrompts.slot })
      .from(gamePrompts)
      .where(eq(gamePrompts.gameId, g.id))
      .orderBy(asc(gamePrompts.round))
      .all()
      .map((r) => ({ round: r.round, prompt: promptById(r.promptId)?.text ?? "", slot: r.slot as Slot }));
  }
  if ((g.phase === "listen" || g.phase === "vote") && !g.winner) {
    out.cards = cardsOf(g.id, g.round);
    out.deadAir = deadAir();
  }
  if (g.phase === "steal" && !g.winner) out.accused = nameOf(g.stealPersonId) ?? undefined;
  if (g.phase === "vote" && !g.winner) {
    const here = new Set(inGame.map((p) => p.id));
    const cast = db
      .select({ voter: votes.voterPersonId, choice: votes.choice })
      .from(votes)
      .where(and(eq(votes.gameId, g.id), eq(votes.round, g.round)))
      .all()
      .filter((v) => here.has(v.voter));
    out.tally = inGame.filter((p) => p.ejected === null).map((p) => ({ name: p.name, votes: cast.filter((v) => v.choice === p.id).length }));
    out.skips = cast.filter((v) => v.choice === "skip").length;
    if (g.lastCall) out.lastCall = true;
  }
  {
    // Finished rounds: every earlier one, and this one only once its reveal is
    // here (or the game is over). The round in play is never in `past`: its
    // prompt and picks are not public yet.
    const revealed = g.phase === "reveal" || !!g.winner;
    const everyone = db
      .select({ id: gamePlayers.personId, name: people.name, role: gamePlayers.role, ejected: gamePlayers.ejectedRound })
      .from(gamePlayers)
      .innerJoin(people, eq(people.id, gamePlayers.personId))
      .where(eq(gamePlayers.gameId, g.id))
      .all();
    out.past = db
      .select()
      .from(gamePrompts)
      .where(eq(gamePrompts.gameId, g.id))
      .orderBy(asc(gamePrompts.round))
      .all()
      .filter((r) => r.round < g.round || (revealed && r.round === g.round))
      .map((r) => {
        const ejected = everyone.find((p) => p.ejected === r.round);
        // A right steal ejects nobody, but the mole it names was the room's choice.
        const stoleIt = r.round === g.round && g.stole ? everyone.find((p) => p.id === g.stealPersonId) : undefined;
        return {
          round: r.round,
          prompt: promptById(r.promptId)?.text ?? "",
          slot: r.slot as Slot,
          cards: cardsOf(g.id, r.round),
          ejected: ejected?.name ?? null,
          wasMole: (ejected ?? stoleIt)?.role === "mole",
        };
      });
  }
  if (g.phase === "reveal" || g.winner) {
    const prompt = db.select().from(gamePrompts).where(and(eq(gamePrompts.gameId, g.id), eq(gamePrompts.round, g.round))).get();
    const target = alias(people, "target");
    const cast = db
      .select({ voter: people.name, choice: votes.choice, target: target.name })
      .from(votes)
      .innerJoin(people, eq(people.id, votes.voterPersonId))
      .leftJoin(target, eq(target.id, votes.choice))
      .where(and(eq(votes.gameId, g.id), eq(votes.round, g.round)))
      .orderBy(asc(people.name))
      .all();
    // The room's choice: the ejected person, or the mole whose steal kept them in.
    const accusedId = g.ejectedPersonId ?? (g.stole ? g.stealPersonId : null);
    if (prompt) {
      out.reveal = {
        prompt: promptById(prompt.promptId)?.text ?? "",
        slot: prompt.slot as Slot,
        cards: cardsOf(g.id, g.round),
        deadAir: deadAir(),
        votes: cast.map((v) => ({ voter: v.voter, choice: v.target ?? null })),
        accused: nameOf(accusedId),
        // A person who left after being ejected is gone from the table; their name still shows.
        ejected: nameOf(g.ejectedPersonId),
        wasMole: !!accusedId && roleOf(g.id, accusedId) === "mole",
        stole: !!g.stole,
      };
    }
  }
  return out;
}

function personName(personId: string): string | null {
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
  const g = currentGame(code);
  const running = !!g && !g.winner;
  // The crates on the table while a game runs: players still seated, ghosts
  // included (their crate can be borrowed from). Spectators' crates stay private.
  const playing = new Set(
    running
      ? db.select({ p: gamePlayers.personId }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.left, 0))).all().map((r) => r.p)
      : [],
  );
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
      crateReady: crateComplete(m.id),
      avatar: m.a ? (Object.fromEntries(PARTS.map((p) => [p, m.a![p]])) as Avatar) : defaultAvatar(m.id),
      ...(playing.has(m.id)
        ? {
            crate: listTaste(m.id).map((c) => ({
              trackId: c.id, title: c.title, artist: c.artist, ...(c.cover ? { cover: c.cover } : {}), slot: (c.slot as Slot | null) ?? null,
            })),
          }
        : {}),
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

// Games before the crate game have rounds with a theme pair (majority, mole);
// newer ones have a prompt and its slot. Both shapes are returned, and the
// page shows whichever a round has.
export type HistoryGame = {
  code: string;
  finishedAt: number;
  winner: string;
  players: string[];
  rounds: { round: number; majority?: string; mole?: string; prompt?: string; slot?: Slot }[];
  // theme is this person's own card: the old game's theme, or the new game's prompt.
  mine: { round: number; theme: string; wasMole: boolean; title: string; artist: string; lender?: string }[];
};

// Finished games this person was still in when they ended, newest first, at
// most `limit`. Everything but `mine` is what the game-over screen shows the
// whole table; `mine` is only this person's own pick per round. A game they
// left before the end is left out (they weren't at the table for the reveal),
// as is any game still running. A handful of indexed queries however many
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
  const themes = db.select().from(gameThemes).where(inArray(gameThemes.gameId, ids)).orderBy(asc(gameThemes.round)).all();
  const prompts = db.select().from(gamePrompts).where(inArray(gamePrompts.gameId, ids)).orderBy(asc(gamePrompts.round)).all();
  const lender = alias(people, "lender");
  const myPicks = db
    .select({ gameId: picks.gameId, round: picks.round, title: picks.title, artist: picks.artist, lender: lender.name })
    .from(picks)
    .leftJoin(lender, eq(lender.id, picks.lenderPersonId))
    .where(and(inArray(picks.gameId, ids), eq(picks.personId, personId)))
    .all();
  return mineGames.map((g) => {
    const old = themes.filter((t) => t.gameId === g.id);
    const rounds: HistoryGame["rounds"] = old.length
      ? old.map((t) => ({ round: t.round, majority: t.majority, mole: t.mole }))
      : prompts.filter((p) => p.gameId === g.id).map((p) => ({ round: p.round, prompt: promptById(p.promptId)?.text ?? "", slot: p.slot as Slot }));
    const wasMole = g.role === "mole";
    return {
      code: g.code,
      finishedAt: g.finishedAt,
      winner: g.winner!,
      players: names.filter((n) => n.gameId === g.id).map((n) => n.name),
      rounds,
      mine: myPicks
        .filter((p) => p.gameId === g.id)
        .sort((a, b) => a.round - b.round)
        .flatMap((p) => {
          const r = rounds.find((x) => x.round === p.round);
          if (!r) return [];
          // Old games: their own side of the pair, the odd one while a mole and still in.
          const odd = wasMole && (g.ejected === null || p.round <= g.ejected);
          const theme = r.prompt ?? (odd ? r.mole : r.majority) ?? "";
          return [{ round: p.round, theme, wasMole, title: p.title, artist: p.artist, ...(p.lender ? { lender: p.lender } : {}) }];
        }),
    };
  });
}
