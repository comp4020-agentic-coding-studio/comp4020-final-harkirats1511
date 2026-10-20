import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, gameThemes, games, people, picks, tableMembers, tableRemovals, tables, votes } from "./schema.ts";
import { log, personTag, tableScope } from "./log.ts";
import { THEMES } from "./themes.ts";
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

// Draw this round's theme pair: one not yet used in this game (if the whole
// list were somehow used up, any will do), and a coin flip for which side the
// majority gets so a pair can't be learnt. Moles all share the odd side.
function drawTheme(d: Tx, gameId: string, round: number) {
  const used = new Set(
    d.select({ m: gameThemes.majority, o: gameThemes.mole }).from(gameThemes).where(eq(gameThemes.gameId, gameId)).all()
      .flatMap((r) => [r.m, r.o]),
  );
  const fresh = THEMES.filter(([a, b]) => !used.has(a) && !used.has(b));
  const pool = fresh.length ? fresh : THEMES;
  const [x, y] = pool[randomInt(pool.length)];
  const flip = randomInt(2) === 1;
  d.insert(gameThemes).values({ gameId, round, majority: flip ? y : x, mole: flip ? x : y }).run();
}

// ---- starting ----

export type StartResult = { ok: true } | Fail;

export function startGame(code: string, by?: string): StartResult {
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
    drawTheme(tx, id, 1);
    tx.update(tables).set({ status: "playing" }).where(eq(tables.code, code)).run();
    // Player count only: roles and themes stay secret until the game ends.
    log(tableScope(code), `${by ? `${by} ` : ""}started the game · ${members.length} players · round 1`);
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
  d.update(games).set({ winner, phase: "reveal", deadline: null, finishedAt: Date.now() }).where(eq(games.id, g.id)).run();
  d.update(tables).set({ status: "finished" }).where(eq(tables.code, g.tableCode)).run();
  // The game-over screen shows the winner and every round's themes to everyone.
  const themes = d.select().from(gameThemes).where(eq(gameThemes.gameId, g.id)).orderBy(asc(gameThemes.round)).all();
  log(
    tableScope(g.tableCode),
    `game finished · winner: ${winner} · ${themes.map((t) => `round ${t.round}: majority "${t.majority}" vs mole "${t.mole}"`).join(" | ")}`,
  );
}

// What the reveal screen shows everyone: who was ejected (and whether they were
// a mole) and which person owned which track number. Titles are left out.
function logReveal(d: Tx, g: Game, out: string | null) {
  const scope = tableScope(g.tableCode);
  const who = out ? personTag(out) : null;
  const role = out
    ? d.select({ r: gamePlayers.role }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, out))).get()?.r
    : undefined;
  log(scope, who ? `reveal · ejected ${who}, ${role === "mole" ? "was a mole" : "was not a mole"} · round ${g.round}` : `reveal · nobody ejected · round ${g.round}`);
  const owners = d
    .select({ slot: picks.slot, owner: picks.personId })
    .from(picks)
    .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round)))
    .orderBy(asc(picks.slot))
    .all();
  if (owners.length) log(scope, `reveal · owners: ${owners.map((o) => `track ${(o.slot ?? 0) + 1} was ${personTag(o.owner)}`).join(", ")}`);
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
  logReveal(d, g, out);
  const winner = winnerOf(d, g.id);
  if (winner) finish(d, { ...g, ejectedPersonId: out }, winner);
}

function pickCount(d: Tx, g: Game): number {
  return d.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).get()?.n ?? 0;
}

function logPhase(g: Game, to: string, cause: string, extra = "") {
  log(tableScope(g.tableCode), `phase ${g.phase} → ${to} (${cause}) · round ${g.round}${extra}`);
}

function toVote(d: Tx, g: Game, cause: string) {
  logPhase(g, "vote", cause);
  const t = tableOptions(g.tableCode)!;
  d.update(games).set({ phase: "vote", deadline: Date.now() + t.voteSeconds * 1000 }).where(eq(games.id, g.id)).run();
}

// Leave the phase the game is in for the next one. The caller has checked the
// round and phase.
function step(d: Tx, g: Game, cause: string) {
  const t = tableOptions(g.tableCode)!;
  const now = Date.now();
  if (g.phase === "pick") {
    const slots = assignSlots(d, g);
    logPhase(g, "listen", cause, ` · ${slots} track${slots === 1 ? "" : "s"}`);
    if (t.autoplay && slots > 0) {
      log(tableScope(g.tableCode), `autoplay · track 1 of ${slots} playing · round ${g.round}`);
      // The server plays slot 0 now; the deadline is the next autoplay step.
      d.update(games)
        .set({ phase: "listen", nowPlaying: 0, deadline: now + t.slotSeconds * 1000 })
        .where(eq(games.id, g.id))
        .run();
    } else {
      d.update(games)
        .set({ phase: "listen", nowPlaying: null, deadline: now + slots * LISTEN_MS_PER_SLOT + LISTEN_SLACK_MS })
        .where(eq(games.id, g.id))
        .run();
    }
  } else if (g.phase === "listen") {
    // Autoplay: the deadline hit means the slot's time is up, so play the next
    // one; only after the last does listening end. Slots are numbered 0..n-1.
    const slots = t.autoplay ? pickCount(d, g) : 0;
    const next = (g.nowPlaying ?? -1) + 1;
    if (t.autoplay && next < slots) {
      d.update(games).set({ nowPlaying: next, deadline: now + t.slotSeconds * 1000 }).where(eq(games.id, g.id)).run();
      log(tableScope(g.tableCode), `autoplay · track ${next + 1} of ${slots} playing · round ${g.round}`);
    } else {
      toVote(d, g, cause);
    }
  } else if (g.phase === "vote") {
    logPhase(g, "reveal", cause);
    resolveVote(d, g);
  } else if (g.phase === "reveal") {
    logPhase(g, "pick", cause, ` (next round ${g.round + 1})`);
    d.update(games)
      .set({ round: g.round + 1, phase: "pick", deadline: now + t.pickSeconds * 1000, ejectedPersonId: null, nowPlaying: null })
      .where(eq(games.id, g.id))
      .run();
    drawTheme(d, g.id, g.round + 1);
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
function settle(d: Tx, code: string, why: string) {
  const g = currentGame(code);
  if (!g || g.winner) return;
  const winner = winnerOf(d, g.id);
  if (winner) return finish(d, g, winner);
  if (complete(d, g)) step(d, g, why);
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
    step(tx, g, "timer");
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
  log("server", `started · resuming ${running.length} running game${running.length === 1 ? "" : "s"}`);
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
export function advance(code: string, by = "the host"): { ok: true } | Fail {
  const g = currentGame(code);
  if (!g || g.winner) return fail(409, "No game is running.");
  if (g.phase !== "listen" && g.phase !== "reveal") return fail(409, `Nothing to advance during ${g.phase}.`);
  const moved = db.transaction((tx) => {
    const now = currentGame(code);
    if (!now || now.winner || now.round !== g.round || now.phase !== g.phase) return false;
    if (now.phase === "listen") toVote(tx, now, `by ${by}`);
    else step(tx, now, `by ${by}`);
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
  let round = 0;
  const res = db.transaction((tx): { ok: true } | Fail => {
    const checked = checkPick(code, personId);
    if (!checked.ok) return checked;
    const { game } = checked;
    tx.insert(picks)
      .values({ gameId: game.id, round: game.round, personId, trackId: track.id, title: track.title, artist: track.artist, cover: track.cover ?? null, pickedAt: Date.now() })
      .run();
    round = game.round;
    log(tableScope(code), `${personTag(personId)} picked a track · round ${round}`);
    settle(tx, code, "everyone picked");
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
    // Who voted, never for whom.
    log(tableScope(code), `${personTag(personId)} voted · round ${game.round}`);
    settle(tx, code, "everyone voted");
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}

// Leaving takes someone out of the table and the game, then re-checks the win,
// whether the phase is now complete, and who hosts. A host removing someone
// goes through the same steps and also records the removal.
export function leaveTable(code: string, personId: string, removedBy?: string): boolean {
  const left = db.transaction((tx) => {
    const gone = tx
      .delete(tableMembers)
      .where(and(eq(tableMembers.tableCode, code), eq(tableMembers.personId, personId)))
      .run();
    if (!gone.changes) return false;
    if (removedBy) {
      tx.insert(tableRemovals).values({ tableCode: code, personId, at: Date.now() }).onConflictDoNothing().run();
      log(tableScope(code), `${personTag(removedBy)} removed ${personTag(personId)}`);
    } else {
      log(tableScope(code), `${personTag(personId)} left the table`);
    }
    const t = tableOptions(code)!;
    if (t.hostPersonId === personId) {
      const next = tx
        .select({ id: tableMembers.personId })
        .from(tableMembers)
        .where(eq(tableMembers.tableCode, code))
        .orderBy(asc(tableMembers.joinedAt), sql`rowid`)
        .get();
      if (next) {
        tx.update(tables).set({ hostPersonId: next.id }).where(eq(tables.code, code)).run();
        log(tableScope(code), `host passed to ${personTag(next.id)}`);
      }
    }
    const g = currentGame(code);
    if (t.status === "playing" && g && !g.winner && playerRow(g, personId)) {
      log(tableScope(code), `${personTag(personId)} left the game too · round ${g.round}`);
      tx.update(gamePlayers).set({ left: 1 }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, personId))).run();
      settle(tx, code, "a player left");
    }
    return true;
  });
  if (left) changed(code);
  return left;
}

// ---- what a player may see ----

// Everyone's view has the same shape and wording: their own theme and whether
// they have picked. A mole's role reads "player"; only the theme text differs,
// and nothing says which side is the odd one. Ghosts get the majority theme.
export function myView(code: string, personId: string): { role: string; theme?: string; picked?: boolean } | null {
  const g = currentGame(code);
  if (!g) return { role: "spectator" };
  const me = playerRow(g, personId);
  if (!me) return { role: "spectator" };
  const picked = pickedThisRound(db, g).has(personId);
  const t = db.select().from(gameThemes).where(and(eq(gameThemes.gameId, g.id), eq(gameThemes.round, g.round))).get();
  const theme = t && (me.ejectedRound === null && me.role === "mole" ? t.mole : t.majority);
  const role = me.ejectedRound !== null ? "ghost" : "player";
  return theme ? { role, theme, picked } : { role, picked };
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

// ---- the speaker's now-playing ----

// The host says which anonymous slot is playing; every phone follows it.
export function setNowPlaying(code: string, slot: number, by?: string): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const g = currentGame(code);
    if (!g || g.winner || (g.phase !== "listen" && g.phase !== "vote")) return fail(409, "Nothing to play right now.");
    const exists = tx
      .select({ s: picks.slot })
      .from(picks)
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.slot, slot)))
      .get();
    if (!exists) return fail(400, "No such slot.");
    // On an autoplay table, playing a slot by hand restarts the clock: autoplay
    // carries on from this slot once its time is up.
    const t = tableOptions(code)!;
    const resume = t.autoplay && g.phase === "listen";
    tx.update(games)
      .set(resume ? { nowPlaying: slot, deadline: Date.now() + t.slotSeconds * 1000 } : { nowPlaying: slot })
      .where(eq(games.id, g.id))
      .run();
    // The slot number is public: it names no one.
    log(tableScope(code), `${by ? `${by} ` : ""}played track ${slot + 1} · round ${g.round}`);
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}
