import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, gamePrompts, games, people, picks, tableMembers, tableRemovals, tables, votes } from "./schema.ts";
import { log, personTag, tableScope } from "./log.ts";
import { PROMPTS, SLOTS, type Slot } from "./prompts.ts";
import { crateComplete, crateTrack } from "./taste.ts";
import {
  currentGame, defaultMoles, MAX_PLAYERS, MIN_PLAYERS, notifyTable, playedTrackIds, promptById, SECONDS_PER_TRACK, tableOptions,
} from "./tables.ts";

// The game engine. Every piece of state is a row in SQLite; the only thing held
// in memory is one timer per table, which is rebuilt from the rows at boot
// (resumeGames). Each transition runs in one transaction and starts by checking
// the round and phase it was asked to leave, so a timer firing at the moment an
// early finish lands cannot move the game on twice.
//
// Phases: pick -> listen -> vote -> (steal) -> reveal, then the next round's pick.

// Dials for playtests. A table's own pick/vote/track seconds override the first three.
export { PICK_SECONDS, SECONDS_PER_TRACK, VOTE_SECONDS } from "./tables.ts";
export const STEAL_SECONDS = 15;
// A reveal moves on to the next round by itself after this; the host can move it sooner.
export const REVEAL_SECONDS = 30;
export const LAST_CALL_MS = 5000;
export const STEAL_OPTIONS = 4;
// Listening that the host doesn't move on gets this much slack past the tracks.
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

const aliveIn = (d: Tx | typeof db, gameId: string) => inPlay(d, gameId).filter((p) => p.ejectedRound === null);

function winnerOf(d: Tx | typeof db, gameId: string): "players" | "moles" | null {
  const alive = aliveIn(d, gameId);
  const moles = alive.filter((p) => p.role === "mole").length;
  if (moles === 0) return "players";
  return moles >= alive.length - moles ? "moles" : null;
}

// Draw this round's prompt: its slot is the next in the game's shuffled slot
// cycle (all four before any repeats), and it is one this game hasn't used (if a
// slot's prompts were somehow all used, any of them will do).
function drawPrompt(d: Tx, g: { id: string; slotOrder: string | null }, round: number) {
  const order = JSON.parse(g.slotOrder ?? "[]") as Slot[];
  const slot = order[(round - 1) % SLOTS.length] ?? SLOTS[0];
  const used = new Set(d.select({ id: gamePrompts.promptId }).from(gamePrompts).where(eq(gamePrompts.gameId, g.id)).all().map((r) => r.id));
  const ofSlot = PROMPTS.filter((p) => p.slot === slot);
  const fresh = ofSlot.filter((p) => !used.has(p.id));
  const pool = fresh.length ? fresh : ofSlot;
  const prompt = pool[randomInt(pool.length)];
  d.insert(gamePrompts).values({ gameId: g.id, round, promptId: prompt.id, slot }).run();
}

const promptOf = (d: Tx | typeof db, gameId: string, round: number) =>
  d.select().from(gamePrompts).where(and(eq(gamePrompts.gameId, gameId), eq(gamePrompts.round, round))).get();

// ---- starting ----

export type StartResult = { ok: true } | Fail;

export function startGame(code: string, by?: string): StartResult {
  const result = db.transaction((tx): StartResult => {
    const t = tableOptions(code);
    if (!t) return fail(404, "No such table.");
    if (t.status === "playing") return fail(409, "A game is already running.");
    const members = tx
      .select({ id: tableMembers.personId, name: people.name })
      .from(tableMembers)
      .innerJoin(people, eq(people.id, tableMembers.personId))
      .where(eq(tableMembers.tableCode, code))
      .orderBy(asc(tableMembers.joinedAt), asc(people.name))
      .all();
    if (members.length < MIN_PLAYERS) return fail(409, `A game needs at least ${MIN_PLAYERS} players.`);
    if (members.length > MAX_PLAYERS) return fail(409, `A table holds at most ${MAX_PLAYERS} players.`);
    // Everyone who would play needs a complete crate: nobody is quietly made a spectator.
    const short = members.filter((m) => !crateComplete(m.id));
    if (short.length) return fail(409, `Waiting on crates: ${short.map((m) => m.name).join(", ")}`);
    // The rule, not a dial: 1 mole for 3 to 5 players, 2 for 6 to 8.
    const moleCount = defaultMoles(members.length);
    const id = randomUUID();
    const now = Date.now();
    const slotOrder = JSON.stringify(shuffle([...SLOTS]));
    tx.insert(games)
      .values({ id, tableCode: code, round: 1, phase: "pick", deadline: now + t.pickSeconds * 1000, startedAt: now, slotOrder })
      .run();
    // Roles are dealt after the crates lock (they lock the moment this row exists).
    const moles = new Set(shuffle(members.map((m) => m.id)).slice(0, moleCount));
    for (const m of members) {
      tx.insert(gamePlayers).values({ gameId: id, personId: m.id, role: moles.has(m.id) ? "mole" : "player" }).run();
    }
    drawPrompt(tx, { id, slotOrder }, 1);
    tx.update(tables).set({ status: "playing" }).where(eq(tables.code, code)).run();
    // Player count only: roles and prompts stay secret until the reveal.
    log(tableScope(code), `${by ? `${by} ` : ""}started the game · ${members.length} players · round 1`);
    return { ok: true };
  });
  if (result.ok) changed(code);
  return result;
}

// ---- phase transitions (all inside a transaction) ----

const playedIds = (d: Tx | typeof db, g: Game): number[] => playedTrackIds(d, g);

// Give this round's picks their play order, once, when picking closes. Returns
// the number of cards. The log line lists them with their pickers: the listen
// screen shows exactly that.
function assignOrder(d: Tx, g: Game): number {
  const rows = d.select().from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all();
  if (rows.some((r) => r.slot !== null)) return rows.length;
  const ordered = shuffle(rows);
  ordered.forEach((r, order) => {
    d.update(picks)
      .set({ slot: order })
      .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.personId, r.personId)))
      .run();
  });
  const done = new Set(rows.map((r) => r.personId));
  const missed = aliveIn(d, g.id).filter((p) => !done.has(p.personId));
  const named = ordered.length
    ? ordered
        .map((r) => `${personTag(r.personId)}: "${r.title}"${r.lenderPersonId ? ` (borrowed from ${personTag(r.lenderPersonId)})` : ""}`)
        .join(", ")
    : "none";
  log(tableScope(g.tableCode), `picks closed · round ${g.round} · ${named}${missed.length ? ` · dead air: ${missed.map((p) => personTag(p.personId)).join(", ")}` : ""}`);
  return rows.length;
}

function finish(d: Tx, g: Game, winner: "players" | "moles") {
  // A game cut short while picking never closed that round: its hidden picks are
  // neither ordered nor logged.
  if (g.phase !== "pick") assignOrder(d, g);
  d.update(games).set({ winner, phase: "reveal", deadline: null, finishedAt: Date.now() }).where(eq(games.id, g.id)).run();
  d.update(tables).set({ status: "finished" }).where(eq(tables.code, g.tableCode)).run();
  // The game-over screen shows the winner and every round's prompt to everyone.
  const rounds = d.select().from(gamePrompts).where(eq(gamePrompts.gameId, g.id)).orderBy(asc(gamePrompts.round)).all();
  log(
    tableScope(g.tableCode),
    `game finished · winner: ${winner} · ${rounds.map((r) => `round ${r.round}: "${promptById(r.promptId)?.text ?? r.promptId}"`).join(" | ")}`,
  );
}

// What the reveal screen shows everyone: the prompt, who was ejected (and
// whether they were a mole), and whether a steal won it for the moles. Who voted
// for whom is on the screen but never in the logs.
function logReveal(d: Tx, g: Game, accused: string | null, out: string | null, stole: boolean) {
  const scope = tableScope(g.tableCode);
  const prompt = promptOf(d, g.id, g.round);
  const said = `prompt "${promptById(prompt?.promptId ?? "")?.text ?? "?"}"`;
  const role = accused
    ? d.select({ r: gamePlayers.role }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, accused))).get()?.r
    : undefined;
  const what = stole && accused
    ? `${personTag(accused)} was a mole and stole it, so the moles win`
    : out
      ? `ejected ${personTag(out)}, ${role === "mole" ? "was a mole" : "was not a mole"}`
      : "nobody ejected";
  log(scope, `reveal · ${said} · ${what} · round ${g.round}`);
}

// The vote locked: the most votes among the alive ejects that player; a tie, or
// skip on top, or no votes, ejects nobody. A mole with a steal left gets to
// guess the prompt before the verdict stands.
function resolveVote(d: Tx, g: Game) {
  const alive = new Set(aliveIn(d, g.id).map((p) => p.personId));
  const tally = new Map<string, number>();
  for (const v of d.select().from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all()) {
    // A vote from someone who has since left, or for someone out, counts for nothing.
    if (!alive.has(v.voterPersonId)) continue;
    const c = v.choice ?? "skip";
    if (c === "skip" || alive.has(c)) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  const best = Math.max(0, ...tally.values());
  const top = [...tally].filter(([, n]) => n === best);
  const accused = best > 0 && top.length === 1 && top[0][0] !== "skip" ? top[0][0] : null;
  const row = accused ? aliveIn(d, g.id).find((p) => p.personId === accused) : undefined;
  if (row && row.role === "mole" && row.stealUsed === 0) return toSteal(d, g, accused!);
  settleVerdict(d, g, accused, false);
}

// The verdict is in (steal over, or none to make): eject, reveal, check the win.
function settleVerdict(d: Tx, g: Game, accused: string | null, stole: boolean) {
  // A right steal ends the game for the moles; nobody is ejected.
  const out = accused && !stole ? accused : null;
  if (out) {
    d.update(gamePlayers).set({ ejectedRound: g.round }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, out))).run();
  }
  d.update(games)
    .set({ phase: "reveal", deadline: Date.now() + REVEAL_SECONDS * 1000, ejectedPersonId: out, stealPersonId: stole ? accused : g.stealPersonId, stole: stole ? 1 : 0, lastCall: 0 })
    .where(eq(games.id, g.id))
    .run();
  logReveal(d, g, accused, out, stole);
  const winner = stole ? "moles" : winnerOf(d, g.id);
  if (winner) finish(d, { ...g, ejectedPersonId: out }, winner);
}

// A mole was voted out and has a steal: four prompts of the round's slot (the
// real one and three others), shuffled, in a column only /me reads for them.
function toSteal(d: Tx, g: Game, mole: string) {
  const prompt = promptOf(d, g.id, g.round)!;
  // Decoys are prompts this game hasn't used: every used one was shown at its
  // reveal, so a used decoy could be struck out. A slot has far more prompts than
  // a game has rounds of it; the fallback to used ones only keeps this total.
  const used = new Set(d.select({ id: gamePrompts.promptId }).from(gamePrompts).where(eq(gamePrompts.gameId, g.id)).all().map((r) => r.id));
  const ofSlot = PROMPTS.filter((p) => p.slot === prompt.slot && p.id !== prompt.promptId);
  const others = [...shuffle(ofSlot.filter((p) => !used.has(p.id))), ...shuffle(ofSlot.filter((p) => used.has(p.id)))].slice(0, STEAL_OPTIONS - 1);
  const options = shuffle([prompt.promptId, ...others.map((p) => p.id)]);
  d.update(gamePlayers).set({ stealUsed: 1 }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, mole))).run();
  d.update(games)
    .set({ phase: "steal", deadline: Date.now() + STEAL_SECONDS * 1000, lastCall: 0, stealPersonId: mole, stealOptions: JSON.stringify(options), stealGuess: null, stole: 0 })
    .where(eq(games.id, g.id))
    .run();
  log(tableScope(g.tableCode), `${personTag(mole)} gets a steal · round ${g.round}`);
}

// The steal ended, by a guess, the clock, or the mole leaving. A guess that was
// the real prompt wins the game for the moles; anything else (a leaver misses
// it) ejects them as the vote said and the game goes on, or ends on the count.
function resolveSteal(d: Tx, g: Game) {
  const mole = g.stealPersonId!;
  const right = !!g.stealGuess && g.stealGuess === promptOf(d, g.id, g.round)?.promptId;
  log(tableScope(g.tableCode), `${personTag(mole)} ${right ? "stole it (guessed right)" : "missed the steal"} · round ${g.round}`);
  settleVerdict(d, g, mole, right);
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
  d.update(games).set({ phase: "vote", deadline: Date.now() + t.voteSeconds * 1000, lastCall: 0 }).where(eq(games.id, g.id)).run();
}

// Leave the phase the game is in for the next one. The caller has checked the
// round and phase.
function step(d: Tx, g: Game, cause: string) {
  const t = tableOptions(g.tableCode)!;
  const now = Date.now();
  if (g.phase === "pick") {
    const cards = assignOrder(d, g);
    logPhase(g, "listen", cause, ` · ${cards} track${cards === 1 ? "" : "s"}`);
    if (t.autoplay && cards > 0) {
      log(tableScope(g.tableCode), `autoplay · track 1 of ${cards} playing · round ${g.round}`);
      // The server plays card 0 now; the deadline is the next autoplay step.
      d.update(games)
        .set({ phase: "listen", nowPlaying: 0, deadline: now + t.slotSeconds * 1000 })
        .where(eq(games.id, g.id))
        .run();
    } else {
      d.update(games)
        .set({ phase: "listen", nowPlaying: null, deadline: now + cards * SECONDS_PER_TRACK * 1000 + LISTEN_SLACK_MS })
        .where(eq(games.id, g.id))
        .run();
    }
  } else if (g.phase === "listen") {
    // Autoplay: the deadline hit means the card's time is up, so play the next
    // one; only after the last does listening end. Cards are numbered 0..n-1.
    const cards = t.autoplay ? pickCount(d, g) : 0;
    const next = (g.nowPlaying ?? -1) + 1;
    if (t.autoplay && next < cards) {
      d.update(games).set({ nowPlaying: next, deadline: now + t.slotSeconds * 1000 }).where(eq(games.id, g.id)).run();
      log(tableScope(g.tableCode), `autoplay · track ${next + 1} of ${cards} playing · round ${g.round}`);
    } else {
      toVote(d, g, cause);
    }
  } else if (g.phase === "vote") {
    logPhase(g, "reveal", cause);
    resolveVote(d, g);
  } else if (g.phase === "steal") {
    logPhase(g, "reveal", cause);
    resolveSteal(d, g);
  } else if (g.phase === "reveal") {
    logPhase(g, "pick", cause, ` (next round ${g.round + 1})`);
    d.update(games)
      .set({
        round: g.round + 1, phase: "pick", deadline: now + t.pickSeconds * 1000, ejectedPersonId: null, lastCall: 0, nowPlaying: null,
        stealPersonId: null, stealOptions: null, stealGuess: null, stole: 0,
      })
      .where(eq(games.id, g.id))
      .run();
    drawPrompt(d, g, g.round + 1);
  }
}

function pickedThisRound(d: Tx | typeof db, g: Game): Set<string> {
  return new Set(d.select({ p: picks.personId }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all().map((r) => r.p));
}

// Everyone eligible has submitted: pick and vote count only the alive (ghosts
// don't pick or vote); a steal is done once the mole guessed or left.
function complete(d: Tx, g: Game): boolean {
  const alive = aliveIn(d, g.id);
  if (g.phase === "pick") {
    const done = pickedThisRound(d, g);
    return alive.every((p) => done.has(p.personId));
  }
  if (g.phase === "vote") {
    const done = new Set(d.select({ p: votes.voterPersonId }).from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all().map((r) => r.p));
    // Dead air votes too, so nobody is left out of the wait.
    return alive.every((p) => done.has(p.personId));
  }
  if (g.phase === "steal") return g.stealGuess !== null || !alive.some((p) => p.personId === g.stealPersonId);
  return false;
}

// After anything that could finish the phase early or end the game.
function settle(d: Tx, code: string, why: string) {
  const g = currentGame(code);
  if (!g || g.winner) return;
  // A steal in progress settles first (the guess, or a missed steal if the mole
  // has gone), so a leaving mole is named and ejected before the win is checked.
  if (g.phase === "steal") {
    if (complete(d, g)) step(d, g, why);
    return;
  }
  const winner = winnerOf(d, g.id);
  if (winner) return finish(d, g, winner);
  if (!complete(d, g)) return;
  if (g.phase === "vote") return lastCall(d, g);
  step(d, g, why);
}

// Everyone who can vote has: a short last call instead of locking at once, so a
// changed mind still counts. The deadline only ever moves earlier.
function lastCall(d: Tx, g: Game) {
  if (g.lastCall) return;
  const deadline = Math.min(g.deadline ?? Infinity, Date.now() + LAST_CALL_MS);
  d.update(games).set({ lastCall: 1, deadline }).where(eq(games.id, g.id)).run();
  log(tableScope(g.tableCode), `last call · everyone has voted · round ${g.round}`);
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

// A player still in this game, by display name (names are unique ignoring case).
function playerByName(d: Tx | typeof db, game: Game, name: string) {
  return d
    .select({ id: gamePlayers.personId, ejected: gamePlayers.ejectedRound })
    .from(gamePlayers)
    .innerJoin(people, eq(people.id, gamePlayers.personId))
    .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.left, 0), sql`lower(${people.name}) = lower(${name})`))
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

// A pick is final once made: changing it would let someone probe the others'
// choices. With `from` (a player's name) it is a borrow from their crate, once
// per game. Either way the song must not have been played yet; this round's
// hidden picks don't count, so a refusal never says what someone else chose.
export function pickTrack(code: string, personId: string, trackId: number, from?: string): { ok: true } | Fail {
  let moved = false;
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner) return fail(409, "No round is running.");
    const me = playerRow(game, personId);
    if (!me) return fail(403, "You are watching this game.");
    if (me.ejectedRound !== null) return fail(403, "Ghosts can't pick.");
    if (game.phase !== "pick" || (game.deadline !== null && Date.now() >= game.deadline)) {
      return fail(409, "Picking is over for this round.");
    }
    if (pickedThisRound(tx, game).has(personId)) return fail(409, "You already picked this round.");
    let lender: string | null = null;
    let track;
    if (from !== undefined) {
      const there = playerByName(tx, game, from);
      if (!there) return fail(404, "No such player in this game.");
      if (there.id === personId) return fail(400, "You can't borrow from yourself.");
      if (me.borrowUsed) return fail(403, "You've used your borrow.");
      track = crateTrack(there.id, trackId);
      if (!track) return fail(403, "That song isn't in their crate.");
      lender = there.id;
    } else {
      track = crateTrack(personId, trackId);
      if (!track) return fail(403, "Pick from your crate.");
    }
    if (playedIds(tx, game).includes(trackId)) return fail(409, "Already played this game.");
    tx.insert(picks)
      .values({
        gameId: game.id, round: game.round, personId, trackId, title: track.title, artist: track.artist, cover: track.cover ?? null,
        pickedAt: Date.now(), lenderPersonId: lender,
      })
      .run();
    if (lender) tx.update(gamePlayers).set({ borrowUsed: 1 }).where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.personId, personId))).run();
    // Who picked, never what or how: the pick stays hidden until picking closes.
    log(tableScope(code), `${personTag(personId)} picked a track · round ${game.round}`);
    settle(tx, code, "everyone picked");
    const now = currentGame(code);
    moved = !now || !!now.winner || now.phase !== game.phase;
    return { ok: true };
  });
  // A pick sends nothing on any stream unless the phase moved: the public state
  // is the same, and even an identical frame would show how many have picked.
  if (res.ok) {
    if (moved) changed(code);
    else schedule(code);
  }
  return res;
}

// choice is a player's name or "skip". A vote can be changed until the vote
// locks: the voter's row is replaced, and the last one counts.
export function castVote(code: string, personId: string, choice: { name: string } | "skip"): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner) return fail(409, "No vote is open.");
    const me = playerRow(game, personId);
    if (!me) return fail(403, "You are watching this game.");
    if (me.ejectedRound !== null) return fail(403, "Ghosts can't vote.");
    if (game.phase !== "vote" || (game.deadline !== null && Date.now() >= game.deadline)) {
      return fail(409, "Voting is not open.");
    }
    let target = "skip";
    if (choice !== "skip") {
      const who = playerByName(tx, game, choice.name);
      if (!who || who.ejected !== null) return fail(400, "Vote for someone still in the game, or skip.");
      if (who.id === personId) return fail(400, "You can't vote for yourself.");
      target = who.id;
    }
    const before = tx
      .select({ p: votes.voterPersonId })
      .from(votes)
      .where(and(eq(votes.gameId, game.id), eq(votes.round, game.round), eq(votes.voterPersonId, personId)))
      .get();
    tx.insert(votes)
      .values({ gameId: game.id, round: game.round, voterPersonId: personId, choice: target, slot: null })
      .onConflictDoUpdate({ target: [votes.gameId, votes.round, votes.voterPersonId], set: { choice: target, slot: null } })
      .run();
    // Who voted, never for whom.
    log(tableScope(code), `${personTag(personId)} ${before ? "changed their vote" : "voted"} · round ${game.round}`);
    settle(tx, code, "everyone voted");
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}

// The voted-out mole's one guess. Only them, only during the steal, only from
// the four options. It ends the steal at once.
export function castSteal(code: string, personId: string, promptId: string): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner || game.phase !== "steal") return fail(409, "There is no steal to make.");
    if (game.stealPersonId !== personId || !playerRow(game, personId)) return fail(403, "This steal isn't yours.");
    if (game.deadline !== null && Date.now() >= game.deadline) return fail(409, "The steal is over.");
    if (game.stealGuess !== null) return fail(409, "You already guessed.");
    if (!(JSON.parse(game.stealOptions ?? "[]") as string[]).includes(promptId)) return fail(400, "Guess one of the four prompts.");
    tx.update(games).set({ stealGuess: promptId }).where(eq(games.id, game.id)).run();
    settle(tx, code, "the mole guessed");
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

export type MyView = {
  role: "player" | "mole" | "ghost" | "spectator";
  // The round's prompt: never for a mole (alive or ejected), who gets only the slot.
  prompt?: string;
  slot?: Slot;
  picked: boolean;
  borrowUsed: boolean;
  // Every track played this game (public anyway), so a picker can skip them.
  played: number[];
  vote?: { name: string } | { skip: true };
  // Only the voted-out mole during the steal.
  steal?: { options: { id: string; text: string }[] };
};

export function myView(code: string, personId: string): MyView {
  const g = currentGame(code);
  const me = g && playerRow(g, personId);
  if (!g || !me) {
    return { role: "spectator", picked: false, borrowUsed: false, played: g ? playedIds(db, g) : [] };
  }
  const ghost = me.ejectedRound !== null;
  const prompt = promptOf(db, g.id, g.round);
  const view: MyView = {
    role: ghost ? "ghost" : me.role === "mole" ? "mole" : "player",
    picked: pickedThisRound(db, g).has(personId),
    borrowUsed: !!me.borrowUsed,
    played: playedIds(db, g),
  };
  if (prompt) {
    view.slot = prompt.slot as Slot;
    // Keyed on the dealt role, so a voted-out mole (a ghost now) is still kept from it.
    if (me.role !== "mole") view.prompt = promptById(prompt.promptId)?.text;
  }
  if (g.phase === "vote" && !g.winner && !ghost) {
    const v = db.select({ c: votes.choice }).from(votes)
      .where(and(eq(votes.gameId, g.id), eq(votes.round, g.round), eq(votes.voterPersonId, personId))).get();
    if (v) {
      const name = v.c && v.c !== "skip" ? db.select({ n: people.name }).from(people).where(eq(people.id, v.c)).get()?.n : undefined;
      view.vote = name ? { name } : { skip: true };
    }
  }
  if (g.phase === "steal" && !g.winner && g.stealPersonId === personId) {
    const ids = JSON.parse(g.stealOptions ?? "[]") as string[];
    view.steal = { options: ids.map((id) => ({ id, text: promptById(id)?.text ?? "" })) };
  }
  return view;
}

// The track id behind a card while the room listens and votes, for the audio
// route; the picks are public by then, so nothing here is private.
export function cardTrackId(code: string, order: number): number | Fail {
  const g = currentGame(code);
  if (!g || g.winner || (g.phase !== "listen" && g.phase !== "vote")) return fail(409, "Nothing to listen to right now.");
  const row = db
    .select({ id: picks.trackId })
    .from(picks)
    .where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.slot, order)))
    .get();
  return row ? row.id : fail(404, "No such card.");
}

// ---- the speaker's now-playing ----

// The host says which card is playing; every phone follows it.
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
    log(tableScope(code), `${by ? `${by} ` : ""}played track ${slot + 1} · round ${g.round}`);
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}
