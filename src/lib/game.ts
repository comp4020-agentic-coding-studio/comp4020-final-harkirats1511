import { randomInt, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, games, people, picks, tableMembers, tables, targets, tasteTracks, votes } from "./schema.ts";
import {
  currentGame, defaultMoles, MAX_PLAYERS, maxMoles, MIN_PLAYERS, notifyTable, tableOptions,
} from "./tables.ts";

// The game engine. Every piece of state is a row in SQLite; the only thing held
// in memory is one timer per table, which is rebuilt from the rows at boot
// (resumeGames). Each transition runs in one transaction and starts by checking
// the round and phase it was asked to leave, so a timer firing at the moment an
// early finish lands cannot move the game on twice.

// How long listening may last when the host doesn't move it on: a slot is a
// 30 second preview, plus a little slack.
const LISTEN_MS_PER_SLOT = 30_000;
const LISTEN_SLACK_MS = 5_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Game = typeof games.$inferSelect;
type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Players still at the table in this game (left or not), alive or ghost.
const inPlay = (d: Tx | typeof db, gameId: string) =>
  d.select().from(gamePlayers).where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.left, 0))).all();

function winnerOf(d: Tx | typeof db, gameId: string): "players" | "moles" | null {
  const alive = inPlay(d, gameId).filter((p) => p.ejectedRound === null);
  const moles = alive.filter((p) => p.role === "mole").length;
  if (moles === 0) return "players";
  return moles >= alive.length - moles ? "moles" : null;
}

// Each alive mole gets a target among alive non-mole players, a different one
// from last round when there is a choice. Not a ghost, not themselves, not a mole.
function assignTargets(d: Tx, gameId: string, round: number, only?: string[]) {
  const alive = inPlay(d, gameId).filter((p) => p.ejectedRound === null);
  const candidates = alive.filter((p) => p.role !== "mole").map((p) => p.personId);
  if (!candidates.length) return;
  const last = new Map(
    d.select().from(targets).where(and(eq(targets.gameId, gameId), eq(targets.round, round - 1))).all()
      .map((t) => [t.molePersonId, t.targetPersonId]),
  );
  for (const mole of alive.filter((p) => p.role === "mole" && (!only || only.includes(p.personId)))) {
    const fresh = candidates.filter((c) => c !== last.get(mole.personId));
    const pool = fresh.length ? fresh : candidates;
    const targetPersonId = pool[randomInt(pool.length)];
    d.insert(targets)
      .values({ gameId, round, molePersonId: mole.personId, targetPersonId })
      .onConflictDoUpdate({ target: [targets.gameId, targets.round, targets.molePersonId], set: { targetPersonId } })
      .run();
  }
}

// ---- starting ----

export type StartResult = { ok: true } | Fail;

export function startGame(code: string): StartResult {
  const result = db.transaction((tx): StartResult => {
    const t = tableOptions(code);
    if (!t) return fail(404, "No such table.");
    if (t.status === "playing") return fail(409, "A game is already running.");
    const members = tx
      .select({ id: tableMembers.personId })
      .from(tableMembers)
      .where(eq(tableMembers.tableCode, code))
      .orderBy(asc(tableMembers.joinedAt))
      .all()
      .map((m) => m.id);
    if (members.length < MIN_PLAYERS) return fail(409, `A game needs at least ${MIN_PLAYERS} players.`);
    if (members.length > MAX_PLAYERS) return fail(409, `A table holds at most ${MAX_PLAYERS} players.`);
    const moleCount = t.moles ?? defaultMoles(members.length);
    if (moleCount > maxMoles(members.length)) {
      return fail(409, `${members.length} players can hold at most ${maxMoles(members.length)} moles.`);
    }
    const id = randomUUID();
    const now = Date.now();
    tx.insert(games)
      .values({ id, tableCode: code, round: 1, phase: "pick", deadline: now + t.pickSeconds * 1000, startedAt: now })
      .run();
    const moles = new Set(shuffle(members).slice(0, moleCount));
    for (const personId of members) {
      tx.insert(gamePlayers).values({ gameId: id, personId, role: moles.has(personId) ? "mole" : "player" }).run();
    }
    assignTargets(tx, id, 1);
    tx.update(tables).set({ status: "playing" }).where(eq(tables.code, code)).run();
    return { ok: true };
  });
  if (result.ok) changed(code);
  return result;
}

// ---- phase transitions (all inside a transaction) ----

// Give this round's picks their anonymous slots, once.
function assignSlots(d: Tx, g: Game) {
  const rows = d.select().from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all();
  if (rows.some((r) => r.slot !== null)) return rows.length;
  shuffle(rows).forEach((r, slot) => {
    d.update(picks)
      .set({ slot })
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.personId, r.personId)))
      .run();
  });
  return rows.length;
}

function finish(d: Tx, g: Game, winner: "players" | "moles") {
  assignSlots(d, g);
  d.update(games).set({ winner, phase: "reveal", deadline: null }).where(eq(games.id, g.id)).run();
  d.update(tables).set({ status: "finished" }).where(eq(tables.code, g.tableCode)).run();
}

function resolveVote(d: Tx, g: Game) {
  const alive = new Set(inPlay(d, g.id).filter((p) => p.ejectedRound === null).map((p) => p.personId));
  const tally = new Map<string | null, number>();
  for (const v of d.select().from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all()) {
    // A vote for someone who has since left counts for nothing.
    if (v.choice === null || alive.has(v.choice)) tally.set(v.choice, (tally.get(v.choice) ?? 0) + 1);
  }
  const best = Math.max(0, ...tally.values());
  const top = [...tally].filter(([, n]) => n === best);
  // The most-voted goes; a tie, "skip" on top, or no votes at all ejects nobody.
  const out = best > 0 && top.length === 1 ? top[0][0] : null;
  if (out) {
    d.update(gamePlayers).set({ ejectedRound: g.round }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, out))).run();
  }
  d.update(games).set({ phase: "reveal", deadline: null, ejectedPersonId: out }).where(eq(games.id, g.id)).run();
  const winner = winnerOf(d, g.id);
  if (winner) finish(d, { ...g, ejectedPersonId: out }, winner);
}

// Leave the phase the game is in for the next one. The caller has checked the
// round and phase.
function step(d: Tx, g: Game) {
  const t = tableOptions(g.tableCode)!;
  const now = Date.now();
  if (g.phase === "pick") {
    const slots = assignSlots(d, g);
    d.update(games)
      .set({ phase: "listen", nowPlaying: null, deadline: now + slots * LISTEN_MS_PER_SLOT + LISTEN_SLACK_MS })
      .where(eq(games.id, g.id))
      .run();
  } else if (g.phase === "listen") {
    d.update(games).set({ phase: "vote", deadline: now + t.voteSeconds * 1000 }).where(eq(games.id, g.id)).run();
  } else if (g.phase === "vote") {
    resolveVote(d, g);
  } else if (g.phase === "reveal") {
    d.update(games)
      .set({ round: g.round + 1, phase: "pick", deadline: now + t.pickSeconds * 1000, ejectedPersonId: null, nowPlaying: null })
      .where(eq(games.id, g.id))
      .run();
    assignTargets(d, g.id, g.round + 1);
  }
}

// Everyone eligible has submitted: pick counts ghosts, vote counts only the alive.
function pickedThisRound(d: Tx | typeof db, g: Game): Set<string> {
  return new Set(d.select({ p: picks.personId }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all().map((r) => r.p));
}

function complete(d: Tx, g: Game): boolean {
  const here = inPlay(d, g.id);
  if (g.phase === "pick") {
    const done = pickedThisRound(d, g);
    return here.every((p) => done.has(p.personId));
  }
  if (g.phase === "vote") {
    // Only those who picked can vote, so nobody waits on someone who missed it.
    const picked = pickedThisRound(d, g);
    const done = new Set(d.select({ p: votes.voterPersonId }).from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all().map((r) => r.p));
    return here.filter((p) => p.ejectedRound === null && picked.has(p.personId)).every((p) => done.has(p.personId));
  }
  return false;
}

// After anything that could finish the phase early or end the game.
function settle(d: Tx, code: string) {
  const g = currentGame(code);
  if (!g || g.winner) return;
  const winner = winnerOf(d, g.id);
  if (winner) return finish(d, g, winner);
  if (complete(d, g)) step(d, g);
}

// A change landed: tell every open session and re-arm the table's timer.
function changed(code: string) {
  schedule(code);
  notifyTable(code);
}

// ---- timers ----

const timers = new Map<string, NodeJS.Timeout>();

export function schedule(code: string) {
  clearTimeout(timers.get(code));
  timers.delete(code);
  const g = currentGame(code);
  if (!g || g.winner || g.deadline === null) return;
  // Overdue (the server was down past it): step now, so whoever's request loaded
  // the server gets the current phase back, not the one that already ended.
  if (g.deadline <= Date.now()) return fire(code, g.round, g.phase);
  const timer = setTimeout(() => fire(code, g.round, g.phase), Math.max(0, g.deadline - Date.now()));
  timer.unref();
  timers.set(code, timer);
}

// The deadline of (round, phase) arrived. Does nothing if that phase has
// already been left, which is what makes a race with an early finish harmless.
function fire(code: string, round: number, phase: string) {
  const moved = db.transaction((tx) => {
    const g = currentGame(code);
    if (!g || g.winner || g.round !== round || g.phase !== phase || g.deadline === null) return false;
    if (g.deadline > Date.now()) return false;
    step(tx, g);
    return true;
  });
  if (moved) changed(code);
  else schedule(code);
}

// At boot: re-arm every running game's timer. A deadline that passed while the
// server was down fires straight away, and the next phase then gets a fresh
// deadline from now rather than cascading through several at once.
export function resumeGames() {
  const running = db.select({ code: tables.code }).from(tables).where(eq(tables.status, "playing")).all();
  for (const { code } of running) schedule(code);
}

// ---- what a player does ----

export function playerRow(game: Game, personId: string) {
  return db
    .select()
    .from(gamePlayers)
    .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0)))
    .get();
}

// The host moves listening on to voting, or a reveal on to the next round.
export function advance(code: string): { ok: true } | Fail {
  const g = currentGame(code);
  if (!g || g.winner) return fail(409, "No game is running.");
  if (g.phase !== "listen" && g.phase !== "reveal") return fail(409, `Nothing to advance during ${g.phase}.`);
  const moved = db.transaction((tx) => {
    const now = currentGame(code);
    if (!now || now.winner || now.round !== g.round || now.phase !== g.phase) return false;
    step(tx, now);
    return true;
  });
  if (!moved) return fail(409, "The game has already moved on.");
  changed(code);
  return { ok: true };
}

export function checkPick(code: string, personId: string): { ok: true; game: Game } | Fail {
  const game = currentGame(code);
  if (!game || game.winner) return fail(409, "No round is running.");
  if (!playerRow(game, personId)) return fail(403, "You are watching this game.");
  if (game.phase !== "pick" || (game.deadline !== null && Date.now() >= game.deadline)) {
    return fail(409, "Picking is over for this round.");
  }
  const mine = db
    .select({ p: picks.personId })
    .from(picks)
    .where(and(eq(picks.gameId, game.id), eq(picks.round, game.round), eq(picks.personId, personId)))
    .get();
  if (mine) return fail(409, "You already picked this round.");
  return { ok: true, game };
}

// A pick is final once made: changing it would let someone probe the others'
// choices, and nothing in the rules asks for it.
export function recordPick(
  code: string, personId: string, track: { id: number; title: string; artist: string; cover?: string | null },
): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const checked = checkPick(code, personId);
    if (!checked.ok) return checked;
    const { game } = checked;
    tx.insert(picks)
      .values({ gameId: game.id, round: game.round, personId, trackId: track.id, title: track.title, artist: track.artist, cover: track.cover ?? null, pickedAt: Date.now() })
      .run();
    settle(tx, code);
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}

// choice is a member's name or "skip".
export function castVote(code: string, personId: string, choice: string): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner) return fail(409, "No vote is open.");
    const me = playerRow(game, personId);
    if (!me) return fail(403, "You are watching this game.");
    if (me.ejectedRound !== null) return fail(403, "Ghosts can't vote.");
    if (!pickedThisRound(tx, game).has(personId)) return fail(403, "You didn't pick this round, so you can't vote in it.");
    if (game.phase !== "vote" || (game.deadline !== null && Date.now() >= game.deadline)) {
      return fail(409, "Voting is not open.");
    }
    const voted = tx
      .select({ p: votes.voterPersonId })
      .from(votes)
      .where(and(eq(votes.gameId, game.id), eq(votes.round, game.round), eq(votes.voterPersonId, personId)))
      .get();
    if (voted) return fail(409, "Your vote is final.");
    let target: string | null = null;
    if (choice !== "skip") {
      const alive = inPlay(tx, game.id).filter((p) => p.ejectedRound === null).map((p) => p.personId);
      const named = alive.length
        ? tx
            .select({ id: people.id })
            .from(people)
            .where(and(sql`lower(${people.name}) = lower(${choice})`, inArray(people.id, alive)))
            .get()
        : undefined;
      if (!named) return fail(400, "Vote for someone still playing, or skip.");
      target = named.id;
    }
    tx.insert(votes).values({ gameId: game.id, round: game.round, voterPersonId: personId, choice: target }).run();
    settle(tx, code);
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}

// Leaving takes someone out of the table and the game, then re-checks the win,
// whether the phase is now complete, and who hosts.
export function leaveTable(code: string, personId: string): boolean {
  const left = db.transaction((tx) => {
    const gone = tx
      .delete(tableMembers)
      .where(and(eq(tableMembers.tableCode, code), eq(tableMembers.personId, personId)))
      .run();
    if (!gone.changes) return false;
    const t = tableOptions(code)!;
    if (t.hostPersonId === personId) {
      const next = tx
        .select({ id: tableMembers.personId })
        .from(tableMembers)
        .where(eq(tableMembers.tableCode, code))
        .orderBy(asc(tableMembers.joinedAt), sql`rowid`)
        .get();
      if (next) tx.update(tables).set({ hostPersonId: next.id }).where(eq(tables.code, code)).run();
    }
    const g = currentGame(code);
    if (t.status === "playing" && g && !g.winner && playerRow(g, personId)) {
      tx.update(gamePlayers).set({ left: 1 }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, personId))).run();
      // A mole whose target just left needs a new one.
      const orphaned = tx
        .select({ mole: targets.molePersonId })
        .from(targets)
        .where(and(eq(targets.gameId, g.id), eq(targets.round, g.round), eq(targets.targetPersonId, personId)))
        .all()
        .map((r) => r.mole);
      if (orphaned.length) assignTargets(tx, g.id, g.round, orphaned);
      settle(tx, code);
    }
    return true;
  });
  if (left) changed(code);
  return left;
}

// ---- what a player may see ----

export function myView(code: string, personId: string): { role: string; target?: string; picked?: boolean } | null {
  const g = currentGame(code);
  if (!g) return { role: "spectator" };
  const me = playerRow(g, personId);
  if (!me) return { role: "spectator" };
  // Private to this person: whether they're in this round's vote.
  const picked = pickedThisRound(db, g).has(personId);
  if (me.ejectedRound !== null) return { role: "ghost", picked };
  if (me.role !== "mole") return { role: "player", picked };
  const t = db
    .select({ id: targets.targetPersonId })
    .from(targets)
    .where(and(eq(targets.gameId, g.id), eq(targets.round, g.round), eq(targets.molePersonId, personId)))
    .get();
  if (!t) return { role: "mole", picked };
  const name = db.select({ n: people.name }).from(people).where(eq(people.id, t.id)).get()?.n;
  return name ? { role: "mole", target: name, picked } : { role: "mole", picked };
}

// The shuffled, anonymous slots while the room listens and votes: positions
// only, never an owner, a title, an artist or a track id.
export function roundSlots(code: string): { slots: { slot: number }[] } | Fail {
  const g = currentGame(code);
  if (!g || g.winner || (g.phase !== "listen" && g.phase !== "vote")) return fail(409, "Nothing to listen to right now.");
  const rows = db
    .select({ slot: picks.slot })
    .from(picks)
    .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round)))
    .orderBy(asc(picks.slot))
    .all();
  return { slots: rows.map((r) => ({ slot: r.slot! })) };
}

export function slotTrackId(code: string, slot: number): number | Fail {
  const g = currentGame(code);
  if (!g || g.winner || (g.phase !== "listen" && g.phase !== "vote")) return fail(409, "Nothing to listen to right now.");
  const row = db
    .select({ id: picks.trackId })
    .from(picks)
    .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.slot, slot)))
    .get();
  return row ? row.id : fail(404, "No such slot.");
}

// ---- the mole's dossier and the speaker's now-playing ----

const DOSSIER_PICKS = 10;

// What a mole studies about this round's target: their taste file and what they
// picked in earlier rounds and games here, most recent first. Only the current
// round's pick is left out, since it is still a secret. Null for anyone but a
// mole with a target. Names and tracks only: no ids, no PIN.
export function dossierFor(code: string, personId: string) {
  const g = currentGame(code);
  if (!g || g.winner) return null;
  const me = playerRow(g, personId);
  if (!me || me.role !== "mole" || me.ejectedRound !== null) return null;
  const t = db
    .select({ id: targets.targetPersonId })
    .from(targets)
    .where(and(eq(targets.gameId, g.id), eq(targets.round, g.round), eq(targets.molePersonId, personId)))
    .get();
  if (!t) return null;
  const name = db.select({ n: people.name }).from(people).where(eq(people.id, t.id)).get()?.n;
  if (!name) return null;
  const taste = db
    .select({ title: tasteTracks.title, artist: tasteTracks.artist, cover: tasteTracks.cover })
    .from(tasteTracks)
    .where(eq(tasteTracks.personId, t.id))
    .orderBy(asc(tasteTracks.addedAt), sql`rowid`)
    .all()
    .map((r) => ({ title: r.title, artist: r.artist, ...(r.cover ? { cover: r.cover } : {}) }));
  const past = db
    .select({ title: picks.title, artist: picks.artist, cover: picks.cover })
    .from(picks)
    .where(and(eq(picks.personId, t.id), or(ne(picks.gameId, g.id), ne(picks.round, g.round))))
    .orderBy(desc(picks.pickedAt))
    .limit(DOSSIER_PICKS)
    .all();
  return { name, taste, picks: past.map((r) => ({ title: r.title, artist: r.artist, ...(r.cover ? { cover: r.cover } : {}) })) };
}

// The host says which anonymous slot is playing; every phone follows it.
export function setNowPlaying(code: string, slot: number): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const g = currentGame(code);
    if (!g || g.winner || (g.phase !== "listen" && g.phase !== "vote")) return fail(409, "Nothing to play right now.");
    const exists = tx
      .select({ s: picks.slot })
      .from(picks)
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.slot, slot)))
      .get();
    if (!exists) return fail(400, "No such slot.");
    tx.update(games).set({ nowPlaying: slot }).where(eq(games.id, g.id)).run();
    return { ok: true };
  });
  if (res.ok) notifyTable(code);
  return res;
}
