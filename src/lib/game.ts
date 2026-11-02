import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { bestVotes, gamePlayers, gamePrompts, games, ghostGuesses, people, picks, roundMoles, roundResults, roundScores, tableMembers, tableRemovals, tables, votes } from "./schema.ts";
import { log, personTag, tableScope } from "./log.ts";
import { PROMPTS, SLOTS, type Slot } from "./prompts.ts";
import { crateComplete, crateTrack, TASTE_MAX } from "./taste.ts";
import {
  botSeats, currentGame, effectiveMoles, humanCount, isBotPerson, MAX_PLAYERS, MIN_PLAYERS, notifyTable, playedTrackIds, promptById, SECONDS_PER_TRACK, tableOptions,
} from "./tables.ts";

// The game engine. Every piece of state is a row in SQLite; the only thing held
// in memory is one timer per table, which is rebuilt from the rows at boot
// (resumeGames). Each transition runs in one transaction and starts by checking
// the round and phase it was asked to leave, so a timer firing at the moment an
// early finish lands cannot move the game on twice.
//
// Phases: pick -> listen -> vote -> (steal) -> reveal, then the next round's pick.
// PHASES below is the one table of them: what each phase starts with (its deadline,
// the columns it clears) and where it may go next. enter() is the only function that
// moves a game between phases, and it is also what tells the table something changed.
// The clock inside a phase moves in one more place only: setDeadline (autoplay's next
// track, last call, the boot repair, and the host playing a card on an autoplay table).

// Dials for playtests. A table's own pick/vote/track seconds override the first three.
export { PICK_SECONDS, SECONDS_PER_TRACK, VOTE_SECONDS } from "./tables.ts";
export const STEAL_SECONDS = 15;
// A reveal moves on to the next round by itself after this; the host can move it sooner.
export const REVEAL_SECONDS = 30;
export const LAST_CALL_MS = 5000;
// How many prompts the voted-out mole chooses from (the real one and the rest decoys).
export const STEAL_OPTIONS = 8;
// A game never runs past this round: a crate has 12 songs, so by round 12 the
// crates are nearly spent. The moles win if they are still in after its reveal.
export const MAX_ROUNDS = TASTE_MAX;
// Four rounds (decision 0010): one round per mood. Scoring, per round (CLAUDE.md "Formats").
export const FOUR_ROUNDS = SLOTS.length;
export const SCORE_CATCH = 2; // a non-mole who voted for a mole
export const SCORE_BEST = 1; // a best-pick vote: to the card's picker, and again to its lender
export const SCORE_LEND = 1;
export const SCORE_ESCAPE = 2; // each mole, when the room's top mole vote isn't a mole
export const SCORE_STEAL = 3; // a caught mole's right guess
// The seats the moles win at: with this many left, a vote that ejects nobody ends the game.
const FINAL_VOTE_ALIVE = 3;
// Listening that the host doesn't move on gets this much slack past the tracks.
const LISTEN_SLACK_MS = 5_000;

// A phase of a game. "over" is derived, not stored: a finished game is stored as
// phase "reveal" with a winner (so the public `phase` clients read is unchanged),
// and phaseOf() says "over" for it.
export type Phase = "pick" | "listen" | "vote" | "steal" | "reveal" | "over";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Game = typeof games.$inferSelect;
type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

// ---- the phase table ----
//
// One row per phase: where it may go next, when it ends, and which columns are
// reset on entering it. enter() is the only code that writes `phase` or the per-round
// columns, and it marks the table as changed (see flush below). `deadline` is written by
// enter (a phase's own clock) and by setDeadline (a clock change inside a phase), nowhere else.
type Columns = Partial<typeof games.$inferInsert>;
type Opts = ReturnType<typeof tableOptions> & object;
type Entry = { next: Phase[]; deadline: (t: Opts, ctx: { cards: number }) => number | null; clear: Columns };
const secs = (n: number) => Date.now() + n * 1000;
const NEW_ROUND: Columns = { caughtMoles: null, ejectedPersonId: null, lastCall: 0, nowPlaying: null, stealPersonId: null, stealOptions: null, stealGuess: null, stole: 0 };
export const PHASES: Record<Phase, Entry> = {
  pick: { next: ["listen", "over"], deadline: (t) => secs(t.pickSeconds), clear: NEW_ROUND },
  // Autoplay plays card 0 at once and each card gets slotSeconds; otherwise the host moves it on.
  listen: {
    next: ["vote", "over"],
    deadline: (t, { cards }) => (t.autoplay ? secs(t.slotSeconds) : secs(cards * SECONDS_PER_TRACK) + LISTEN_SLACK_MS),
    clear: { lastCall: 0 },
  },
  vote: { next: ["steal", "reveal", "over"], deadline: (t) => secs(t.voteSeconds), clear: { lastCall: 0 } },
  // The steal's options (decoys included) are cleared with it, when the reveal begins.
  steal: { next: ["reveal", "over"], deadline: () => secs(STEAL_SECONDS), clear: { lastCall: 0 } },
  reveal: { next: ["pick", "over"], deadline: () => secs(REVEAL_SECONDS), clear: { lastCall: 0, stealOptions: null } },
  // A finished game is stored as phase "reveal" with a winner, so the public `phase` is unchanged.
  over: { next: [], deadline: () => null, clear: { lastCall: 0, stealOptions: null } },
};

// Move the clock of the phase a game is already in (never the phase): `extra` is whatever
// goes with it (autoplay's now-playing card, the last-call flag). With enter, the only
// code that writes `deadline`. The caller touches the table when the change is public.
function setDeadline(d: Tx | typeof db, gameId: string, deadline: number, extra: Columns = {}) {
  d.update(games).set({ ...extra, deadline }).where(eq(games.id, gameId)).run();
}

// The phase a game is in: "over" once it has a winner (including "none", abandoned).
export const phaseOf = (g: { phase: string; winner: string | null }): Phase => (g.winner ? "over" : (g.phase as Phase));

// Tables whose public state changed inside a transaction that has not committed yet.
const dirty = new Set<string>();
const touch = (code: string) => void dirty.add(code);

// Move a game to phase `to`: checks the move is allowed from `from`, sets the
// phase, its deadline and its resets, then whatever `set` adds for this
// particular move, and notes the table as changed. `cause` logs the move.
function enter(d: Tx, g: { id: string; tableCode: string; round: number; phase: string; winner: string | null }, to: Phase, o: { set?: Columns; cause?: string; note?: string; cards?: number } = {}) {
  const from = phaseOf(g);
  if (!PHASES[from].next.includes(to)) throw new Error(`a game can't go from ${from} to ${to}`);
  const entry = PHASES[to];
  const t = tableOptions(g.tableCode)!;
  if (o.cause !== undefined) log(tableScope(g.tableCode), `phase ${g.phase} → ${to === "over" ? "reveal" : to} (${o.cause}) · round ${g.round}${o.note ?? ""}`);
  d.update(games)
    .set({ ...entry.clear, phase: to === "over" ? "reveal" : to, deadline: entry.deadline(t, { cards: o.cards ?? 0 }), ...o.set })
    .where(eq(games.id, g.id))
    .run();
  touch(g.tableCode);
}

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

const isFour = (g: { format: string }) => g.format === "four";

// Who is dealt as a mole next, weighted (CLAUDE.md "Formats"): the more often someone has been a mole
// this game, the less likely they are dealt it again, but never impossible, so nobody can be sure
// from the public history who this round's moles are. `history` is the moles of each earlier round,
// `ids` everyone in play now (a leaver is simply not in it; someone new has no turns yet), `count` how
// many to deal. A person's weight is 1 / (1 + 2 * times they have been a mole); each mole is drawn
// in turn from the rest (never the same person twice in a round). Pure apart from `rand`
// (a number in [0, 1)), so it can be tested.
export const dealWeight = (times: number) => 1 / (1 + 2 * times);
export function dealOrder(history: string[][], ids: string[], count: number, rand: () => number = () => randomInt(1 << 30) / (1 << 30)): string[] {
  const times = new Map<string, number>();
  for (const round of history) for (const m of round) times.set(m, (times.get(m) ?? 0) + 1);
  const pool = [...ids];
  const chosen: string[] = [];
  while (chosen.length < Math.min(count, ids.length)) {
    const w = pool.map((i) => dealWeight(times.get(i) ?? 0));
    let x = rand() * w.reduce((a, b) => a + b, 0);
    let k = 0;
    while (k < pool.length - 1 && x >= w[k]) x -= w[k++];
    chosen.push(pool.splice(k, 1)[0]);
  }
  return chosen;
}

// Four rounds: deal this round's moles afresh from everyone in play (the same count rule as ever), weighted.
function dealMoles(d: Tx, gameId: string, round: number, ids: string[], count: number) {
  const rows = d.select().from(roundMoles).where(eq(roundMoles.gameId, gameId)).orderBy(asc(roundMoles.round)).all().filter((r) => r.round < round);
  const history = Array.from({ length: Math.max(0, round - 1) }, (_, i) => rows.filter((r) => r.round === i + 1).map((r) => r.personId));
  for (const id of dealOrder(history, ids, count)) d.insert(roundMoles).values({ gameId, round, personId: id }).run();
}

// Who is a mole in this round of a Four rounds game.
const moleIdsOf = (d: Tx | typeof db, gameId: string, round: number): Set<string> =>
  new Set(d.select({ p: roundMoles.personId }).from(roundMoles).where(and(eq(roundMoles.gameId, gameId), eq(roundMoles.round, round))).all().map((r) => r.p));

// Whether this person is dealt as a mole in the round in play (either format).
function isMoleNow(d: Tx | typeof db, g: Game, role: string, personId: string): boolean {
  return isFour(g) ? moleIdsOf(d, g.id, g.round).has(personId) : role === "mole";
}

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
    // The host's choice (1 or 2) if there is one, else the plain rule; never more than a third of the table.
    const moleCount = effectiveMoles(members.length, t.moles);
    const id = randomUUID();
    const now = Date.now();
    // Round n draws a prompt of slotOrder[n - 1]: in Four rounds that is each mood once, shuffled.
    const slotOrder = JSON.stringify(shuffle([...SLOTS]));
    const format = t.format === "four" ? "four" : "knockout";
    tx.insert(games)
      .values({ id, tableCode: code, round: 1, phase: "pick", deadline: PHASES.pick.deadline(t, { cards: 0 }), startedAt: now, slotOrder, format })
      .run();
    // Roles are dealt after the crates lock (they lock the moment this row exists). Four rounds
    // keeps game_players.role "player" for everyone: its moles are dealt per round (round_moles).
    const moles = new Set(shuffle(members.map((m) => m.id)).slice(0, moleCount));
    for (const m of members) {
      tx.insert(gamePlayers).values({ gameId: id, personId: m.id, role: format === "knockout" && moles.has(m.id) ? "mole" : "player" }).run();
    }
    if (format === "four") dealMoles(tx, id, 1, members.map((m) => m.id), moleCount);
    drawPrompt(tx, { id, slotOrder }, 1);
    tx.update(tables).set({ status: "playing" }).where(eq(tables.code, code)).run();
    // "I'm in" belonged to the game-over screen: a new game starts from nobody in.
    tx.update(tableMembers).set({ rematch: false }).where(eq(tableMembers.tableCode, code)).run();
    // Player count only: roles and prompts stay secret until the reveal.
    log(tableScope(code), `${by ? `${by} ` : ""}started the game · ${members.length} players · ${format === "four" ? "four rounds · " : ""}round 1`);
    return { ok: true };
  });
  if (result.ok) {
    touch(code);
    flush(code);
  }
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

// "points" is the winner of a finished Four rounds game (who won is `winners` in the public state).
export type Winner = "players" | "moles" | "none" | "points";
// Why a game ended when it was not simply "every mole out" or "moles at parity":
// the public state carries it so the screen can say so.
export type Ending = "final-vote" | "round-cap" | "nobody-picked" | "update" | "too-few";

// " · moles: A, B" for the game-over line: the game-over screen names every mole,
// including any who left, so the log may too. An abandoned game (no winner) shows
// no roles, so its line names none.
function moleNames(d: Tx, g: Game, winner: Winner): string {
  if (winner === "none") return "";
  const ids = isFour(g)
    ? [...new Set(d.select({ p: roundMoles.personId }).from(roundMoles).where(eq(roundMoles.gameId, g.id)).all().map((r) => r.p))]
    : d.select({ id: gamePlayers.personId }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.role, "mole"))).all().map((r) => r.id);
  const names = ids.map((id) => personTag(id));
  return names.length ? ` · moles: ${names.join(", ")}` : "";
}

function finish(d: Tx, g: Game, winner: Winner, ending: Ending | null = null) {
  // A game cut short while picking never closed that round: its hidden picks are
  // neither ordered nor logged.
  if (g.phase !== "pick") assignOrder(d, g);
  // Four rounds: the final scores and winners are stored now, so nothing after the end (a leaver, a
  // restart) can change who won. Only people still in the game, in the order they sat down.
  let finalResult: string | undefined;
  if (winner === "points") {
    const scores = d.select({ name: people.name, score: gamePlayers.score }).from(gamePlayers).innerJoin(people, eq(people.id, gamePlayers.personId))
      .where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.left, 0))).orderBy(sql`game_players.rowid`).all();
    const top = Math.max(0, ...scores.map((x) => x.score));
    finalResult = JSON.stringify({ scores, winners: scores.filter((x) => x.score === top).map((x) => x.name) });
  }
  enter(d, g, "over", { set: { winner, endReason: ending, finishedAt: Date.now(), ...(finalResult ? { finalResult } : {}) } });
  // An abandoned game puts the table back in the lobby; any other ending leaves
  // the game-over screen up until the host plays again.
  d.update(tables).set({ status: winner === "none" ? "open" : "finished" }).where(eq(tables.code, g.tableCode)).run();
  // The game-over screen shows the winner and every round's prompt to everyone.
  const rounds = d.select().from(gamePrompts).where(eq(gamePrompts.gameId, g.id)).orderBy(asc(gamePrompts.round)).all();
  log(
    tableScope(g.tableCode),
    `game finished · winner: ${winner}${ending ? ` (${ending})` : ""}${moleNames(d, g, winner)} · ${rounds.map((r) => `round ${r.round}: "${promptById(r.promptId)?.text ?? r.promptId}"`).join(" | ")}`,
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

// The vote locked: one line saying who voted, never for whom (CLAUDE.md "Logging"). Only people
// still in the game at the lock are named, in the order they sat down. Four rounds names the
// voters of each ballot.
function logVotesIn(d: Tx, g: Game) {
  const here = inPlay(d, g.id).filter((p) => p.ejectedRound === null);
  const names = (rows: { p: string }[]) => {
    const who = new Set(rows.map((r) => r.p));
    const list = here.filter((p) => who.has(p.personId));
    return `${list.length ? list.map((p) => personTag(p.personId)).join(", ") : "nobody"} (${list.length} of ${here.length})`;
  };
  const mole = d.select({ p: votes.voterPersonId }).from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all();
  let line = `votes in: ${names(mole)}`;
  if (isFour(g)) {
    const best = d.select({ p: bestVotes.voterPersonId }).from(bestVotes).where(and(eq(bestVotes.gameId, g.id), eq(bestVotes.round, g.round))).all();
    line = `votes in · mole: ${names(mole)} · best pick: ${names(best)}`;
  }
  log(tableScope(g.tableCode), `${line} · round ${g.round}`);
}

// The vote locked: the most votes among the alive ejects that player; a tie, or
// skip on top, or no votes, ejects nobody. A mole with a steal left gets to
// guess the prompt before the verdict stands.
function resolveVote(d: Tx, g: Game) {
  if (isFour(g)) return resolveVoteFour(d, g);
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
  const aliveBefore = aliveIn(d, g.id).length;
  if (out) {
    d.update(gamePlayers).set({ ejectedRound: g.round }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, out))).run();
  }
  enter(d, g, "reveal", { set: { ejectedPersonId: out, stealPersonId: stole ? accused : g.stealPersonId, stole: stole ? 1 : 0 } });
  logReveal(d, g, accused, out, stole);
  const done = { ...g, phase: "reveal", ejectedPersonId: out };
  const winner = stole ? "moles" : winnerOf(d, g.id);
  if (winner) return finish(d, done, winner);
  // The last chance: with three left, a vote that ejects nobody hands it to the moles.
  if (!out && aliveBefore === FINAL_VOTE_ALIVE) return finish(d, done, "moles", "final-vote");
  if (g.round >= MAX_ROUNDS) return finish(d, done, "moles", "round-cap");
}

// ---- Four rounds ----

// What the locked mole vote means for the round (pure, so the rule can be tested). Each mole
// is judged on their own: a mole is caught when the top mole vote is that mole, or a tie made
// only of moles (all of the tied moles are caught, and `pick` chooses which of them steals).
//  - nobody, or skip, or a non-mole on top, or a tie that includes any of those: no mole is caught;
//  - the moles who are not caught get away, whoever else was caught (that is the caller's +2).
export function judgeFour(tally: Map<string, number>, moles: Set<string>, pick: (n: number) => number = randomInt) {
  const best = Math.max(0, ...tally.values());
  const top = [...tally].filter(([, n]) => n === best).map(([c]) => c);
  if (best > 0 && top.every((c) => c !== "skip" && moles.has(c))) {
    return { caught: true as const, caughtMoles: top, steal: top[pick(top.length)], tied: top.length > 1, accused: null };
  }
  const accused = best > 0 && top.length === 1 && top[0] !== "skip" ? top[0] : null;
  return { caught: false as const, caughtMoles: [] as string[], steal: null, tied: false, accused };
}

function resolveVoteFour(d: Tx, g: Game) {
  const here = new Set(inPlay(d, g.id).map((p) => p.personId));
  const tally = new Map<string, number>();
  for (const v of d.select().from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all()) {
    if (!here.has(v.voterPersonId)) continue;
    const c = v.choice ?? "skip";
    if (c === "skip" || here.has(c)) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  // A mole who has left is not on the tally (they are caught by leaving, see settleRoundFour), so the
  // moles still here are judged on the votes of those still here.
  const j = judgeFour(tally, new Set([...moleIdsOf(d, g.id, g.round)].filter((m) => here.has(m))));
  if (j.caught) {
    if (j.tied) log(tableScope(g.tableCode), `the top vote was tied between moles · one of them gets the steal · round ${g.round}`);
    return toSteal(d, g, j.steal, JSON.stringify(j.caughtMoles));
  }
  settleRoundFour(d, g, { accused: j.accused, caughtByVote: [], stole: false });
}

export type Reason = { kind: "caught" | "best" | "lend" | "escaped" | "stole"; n: number; points: number };
const UNIT: Record<Reason["kind"], number> = { caught: SCORE_CATCH, best: SCORE_BEST, lend: SCORE_LEND, escaped: SCORE_ESCAPE, stole: SCORE_STEAL };

// The round's points with the reasons for each, from its two ballots, the round's moles and the steal.
// One function does the scoring and the explaining, so what the screen says is what was scored.
//  - `moles` is everyone dealt as a mole this round, whether or not they are still here; a vote for one
//    who has left still catches them. `players` is who is still in the game: only they can score.
//  - `caught` is the moles who were caught (by the vote, or by leaving); every other mole who is still
//    here got away, on their own. A mole's own mole vote scores nothing.
//  - Best votes are already filtered to the ones that count (a leaver's own ballot, and any for a card
//    whose picker left, count for nothing); a lender who has left just gets nothing.
// `reasons[].points` is `n` times that reason's unit and always sums to the person's points.
export function scoreRound(o: {
  moles: Set<string>; players: string[]; moleVotes: { voter: string; choice: string }[];
  bestVotes: { voter: string; picker: string; lender: string | null }[]; caught: Set<string>; stole: string | null;
}): Map<string, { points: number; reasons: Reason[] }> {
  const got = new Map<string, Map<Reason["kind"], number>>(o.players.map((p) => [p, new Map()]));
  const add = (p: string | null, kind: Reason["kind"], n = 1) => {
    const m = p ? got.get(p) : undefined;
    if (m) m.set(kind, (m.get(kind) ?? 0) + n);
  };
  for (const v of o.moleVotes) if (!o.moles.has(v.voter) && o.moles.has(v.choice)) add(v.voter, "caught");
  for (const b of o.bestVotes) {
    add(b.picker, "best");
    if (b.lender) add(b.lender, "lend");
  }
  for (const m of o.moles) if (!o.caught.has(m)) add(m, "escaped");
  if (o.stole) add(o.stole, "stole");
  const order: Reason["kind"][] = ["caught", "best", "lend", "escaped", "stole"];
  return new Map([...got].map(([p, m]) => {
    const reasons = order.filter((k) => m.has(k)).map((kind) => ({ kind, n: m.get(kind)!, points: m.get(kind)! * UNIT[kind] }));
    return [p, { points: reasons.reduce((a, r) => a + r.points, 0), reasons }];
  }));
}

// Just the numbers (see scoreRound).
export function roundPoints(o: Parameters<typeof scoreRound>[0]): Map<string, number> {
  return new Map([...scoreRound(o)].map(([p, v]) => [p, v.points]));
}

const nameById = (d: Tx | typeof db, id: string | null) => (id ? d.select({ n: people.name }).from(people).where(eq(people.id, id)).get()?.n ?? "" : "");

// What a revealed round shows everyone, frozen at its reveal (by display name), so a leaver afterwards,
// a reload, or a late joiner always sees the round as it was scored. Written into round_results.snapshot.
export type RoundSnapshot = {
  moles: string[];
  // Everyone who had left the game when the reveal opened.
  left: string[];
  // Moles who left the game before the reveal: "X left. Everyone who had voted for them catches them."
  leftMoles: string[];
  // Each of the round's moles on their own: caught (by the vote, or by leaving) or got away.
  caught: string[];
  escaped: string[];
  votes: { voter: string; choice: string | null }[];
  bestVotes: { voter: string; order: number; picker: string; lender?: string }[];
  points: { name: string; points: number; reasons: Reason[] }[];
  // The card(s) with the most best-pick votes that counted (a tie lists each); none when there were no votes.
  best: { order: number; picker: string; lender?: string; votes: number }[];
};

// A mole who leaves during a round (in pick, listen, vote, or after being caught) counts as caught,
// for everyone who had voted for them, and there is no steal for them: the moles still here are judged
// on their own as usual (resolveVoteFour). One who leaves during their own steal was caught by the vote
// already: the steal is missed (no +3, as before), and the rule above applies as to any mole who leaves:
// those who had voted for them still get +2 (before, they got nothing, which is the case the review
// found) and the reveal says they left. The only difference from leaving earlier is that the vote had
// already caught them. Tied moles who were all caught (`caughtByVote`) stay caught
// when the one who steals leaves. Nobody else's leaving changes the vote: their ballots, and best votes
// for their card, count for nothing.
function settleRoundFour(d: Tx, g: Game, o: { accused: string | null; caughtByVote: string[]; stole: boolean }) {
  const { accused, stole } = o;
  const play = inPlay(d, g.id).map((p) => p.personId);
  const here = new Set(play);
  const dealt = moleIdsOf(d, g.id, g.round);
  const leftMoles = [...dealt].filter((m) => !here.has(m));
  const caught = new Set([...o.caughtByVote, ...leftMoles]);
  const picksOf = d.select().from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all();
  const ballots = d.select().from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all().filter((v) => here.has(v.voterPersonId));
  const counted = d.select().from(bestVotes).where(and(eq(bestVotes.gameId, g.id), eq(bestVotes.round, g.round))).all()
    .filter((b) => here.has(b.voterPersonId) && here.has(b.pickPersonId))
    .flatMap((b) => {
      const card = picksOf.find((p) => p.personId === b.pickPersonId);
      return card ? [{ voter: b.voterPersonId, picker: card.personId, lender: card.lenderPersonId, order: card.slot ?? 0 }] : [];
    });
  const scored = scoreRound({
    moles: dealt,
    players: play,
    moleVotes: ballots.filter((v) => v.choice && v.choice !== "skip").map((v) => ({ voter: v.voterPersonId, choice: v.choice! })),
    bestVotes: counted,
    caught,
    stole: stole ? accused : null,
  });
  d.insert(roundResults).values({ gameId: g.id, round: g.round, accusedPersonId: accused, caught: o.caughtByVote.length ? 1 : 0, stole: stole ? 1 : 0 }).run();
  for (const [personId, r] of scored) {
    d.insert(roundScores).values({ gameId: g.id, round: g.round, personId, points: r.points }).run();
    if (r.points) d.update(gamePlayers).set({ score: sql`${gamePlayers.score} + ${r.points}` }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, personId))).run();
  }
  // The frozen reveal. Best-pick tallies use the votes that scored; the ballots list those of people still here.
  const nm = (id: string | null) => nameById(d, id);
  const perCard = new Map<number, number>();
  for (const b of counted) perCard.set(b.order, (perCard.get(b.order) ?? 0) + 1);
  const top = Math.max(0, ...perCard.values());
  const snapshot: RoundSnapshot = {
    moles: [...dealt].map(nm).sort(),
    left: d.select({ id: gamePlayers.personId }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.left, 1))).all().map((r) => nm(r.id)).sort(),
    leftMoles: leftMoles.map(nm).sort(),
    caught: [...caught].map(nm).sort(),
    escaped: [...dealt].filter((m) => !caught.has(m)).map(nm).sort(),
    votes: ballots.map((v) => ({ voter: nm(v.voterPersonId), choice: v.choice && v.choice !== "skip" ? nm(v.choice) : null })).sort((a, b) => a.voter.localeCompare(b.voter)),
    bestVotes: counted.map((b) => ({ voter: nm(b.voter), order: b.order, picker: nm(b.picker), ...(b.lender ? { lender: nm(b.lender) } : {}) })).sort((a, b) => a.voter.localeCompare(b.voter)),
    points: [...scored].map(([id, r]) => ({ name: nm(id), points: r.points, reasons: r.reasons })).sort((a, b) => a.name.localeCompare(b.name)),
    best: top ? [...perCard].filter(([, n]) => n === top).sort((a, b) => a[0] - b[0]).map(([order, votes]) => {
      const c = picksOf.find((p) => p.slot === order)!;
      return { order, picker: nm(c.personId), ...(c.lenderPersonId ? { lender: nm(c.lenderPersonId) } : {}), votes };
    }) : [],
  };
  d.update(roundResults).set({ snapshot: JSON.stringify(snapshot) }).where(and(eq(roundResults.gameId, g.id), eq(roundResults.round, g.round))).run();
  enter(d, g, "reveal", { set: { ejectedPersonId: null, stole: stole ? 1 : 0 } });
  // The reveal names the round's moles and the prompt; never who voted for whom or what anyone gained.
  const names = [...dealt].map(personTag);
  const prompt = promptById(promptOf(d, g.id, g.round)?.promptId ?? "")?.text ?? "?";
  const verdict = o.caughtByVote.length ? (stole ? "caught, and stole it" : "caught") : leftMoles.length === dealt.size ? "caught (left)" : "got away";
  log(
    tableScope(g.tableCode),
    `reveal · prompt "${prompt}" · moles: ${names.join(", ") || "none"}${leftMoles.length ? ` · left: ${leftMoles.map(personTag).join(", ")}` : ""} · ${verdict} · round ${g.round}`,
  );
  if (g.round >= FOUR_ROUNDS) finish(d, { ...g, phase: "reveal" }, "points");
}

// A mole was voted out and has a steal: STEAL_OPTIONS prompts of the round's slot (the
// real one and the rest decoys), shuffled, in a column only /me reads for them.
function toSteal(d: Tx, g: Game, mole: string, caughtMoles?: string) {
  const prompt = promptOf(d, g.id, g.round)!;
  // Decoys are prompts this game hasn't used: every used one was shown at its
  // reveal, so a used decoy could be struck out. A slot has far more prompts than
  // a game has rounds of it (15 per slot, at most 3 rounds of a slot in a 12-round
  // game, so 11 unused others at worst against the 7 decoys needed); the fallback
  // to used ones, and then to fewer options, only keeps this total.
  const used = new Set(d.select({ id: gamePrompts.promptId }).from(gamePrompts).where(eq(gamePrompts.gameId, g.id)).all().map((r) => r.id));
  const ofSlot = PROMPTS.filter((p) => p.slot === prompt.slot && p.id !== prompt.promptId);
  const others = [...shuffle(ofSlot.filter((p) => !used.has(p.id))), ...shuffle(ofSlot.filter((p) => used.has(p.id)))].slice(0, STEAL_OPTIONS - 1);
  const options = shuffle([prompt.promptId, ...others.map((p) => p.id)]);
  d.update(gamePlayers).set({ stealUsed: 1 }).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, mole))).run();
  enter(d, g, "steal", { set: { stealPersonId: mole, stealOptions: JSON.stringify(options), stealGuess: null, stole: 0, ...(caughtMoles ? { caughtMoles } : {}) } });
  log(tableScope(g.tableCode), `${personTag(mole)} gets a steal · round ${g.round}`);
}

// The steal ended, by a guess, the clock, or the mole leaving. A guess that was
// the real prompt wins the game for the moles; anything else (a leaver misses
// it) ejects them as the vote said and the game goes on, or ends on the count.
function resolveSteal(d: Tx, g: Game) {
  const mole = g.stealPersonId!;
  const right = !!g.stealGuess && g.stealGuess === promptOf(d, g.id, g.round)?.promptId;
  log(tableScope(g.tableCode), `${personTag(mole)} ${right ? "stole it (guessed right)" : "missed the steal"} · round ${g.round}`);
  if (isFour(g)) return settleRoundFour(d, g, { accused: mole, caughtByVote: JSON.parse(g.caughtMoles ?? "[]") as string[], stole: right });
  settleVerdict(d, g, mole, right);
}

function pickCount(d: Tx, g: Game): number {
  return d.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).get()?.n ?? 0;
}

function logPhase(g: Game, to: string, cause: string, extra = "") {
  log(tableScope(g.tableCode), `phase ${g.phase} → ${to} (${cause}) · round ${g.round}${extra}`);
}

// Leave the phase the game is in for the next one. The caller has checked the
// round and phase.
function step(d: Tx, g: Game, cause: string) {
  const t = tableOptions(g.tableCode)!;
  const now = Date.now();
  if (g.phase === "pick") {
    const cards = assignOrder(d, g);
    // Nobody picked: nobody is playing. End it so the crates unlock.
    if (cards === 0) {
      logPhase(g, "reveal", cause, " · nobody picked");
      return finish(d, g, "none", "nobody-picked");
    }
    // Autoplay: the server plays card 0 now; the deadline is the next autoplay step.
    if (t.autoplay) log(tableScope(g.tableCode), `autoplay · track 1 of ${cards} playing · round ${g.round}`);
    enter(d, g, "listen", { cause, note: ` · ${cards} track${cards === 1 ? "" : "s"}`, cards, set: { nowPlaying: t.autoplay ? 0 : null } });
  } else if (g.phase === "listen") {
    // Autoplay: the deadline hit means the card's time is up, so play the next
    // one; only after the last does listening end. Cards are numbered 0..n-1.
    const cards = t.autoplay ? pickCount(d, g) : 0;
    const next = (g.nowPlaying ?? -1) + 1;
    if (t.autoplay && next < cards) {
      setDeadline(d, g.id, now + t.slotSeconds * 1000, { nowPlaying: next });
      touch(g.tableCode);
      log(tableScope(g.tableCode), `autoplay · track ${next + 1} of ${cards} playing · round ${g.round}`);
    } else {
      enter(d, g, "vote", { cause });
    }
  } else if (g.phase === "vote") {
    logPhase(g, "reveal", cause);
    logVotesIn(d, g);
    resolveVote(d, g);
  } else if (g.phase === "steal") {
    logPhase(g, "reveal", cause);
    resolveSteal(d, g);
  } else if (g.phase === "reveal") {
    // settleVerdict ends the game at the round cap, so a reveal here is never the last.
    enter(d, g, "pick", { cause, note: ` (next round ${g.round + 1})`, set: { round: g.round + 1 } });
    drawPrompt(d, g, g.round + 1);
    if (isFour(g)) {
      const ids = inPlay(d, g.id).map((p) => p.personId);
      dealMoles(d, g.id, g.round + 1, ids, effectiveMoles(ids.length, t.moles));
    }
  }
}

// A card is "your own" if you picked it or lent the song it was picked with.
const isOthersCard = (c: { personId: string; lenderPersonId: string | null }, me: string) => c.personId !== me && c.lenderPersonId !== me;

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
  if (g.phase === "vote" && isFour(g)) {
    const moleDone = new Set(d.select({ p: votes.voterPersonId }).from(votes).where(and(eq(votes.gameId, g.id), eq(votes.round, g.round))).all().map((r) => r.p));
    const bestDone = new Set(d.select({ p: bestVotes.voterPersonId }).from(bestVotes).where(and(eq(bestVotes.gameId, g.id), eq(bestVotes.round, g.round))).all().map((r) => r.p));
    const cards = d.select().from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round))).all();
    // Someone with no card to vote for (only their own are on the table) isn't waited on for best pick.
    return alive.every((p) => moleDone.has(p.personId) && (bestDone.has(p.personId) || !cards.some((c) => isOthersCard(c, p.personId))));
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
  // Four rounds has no parity win; it is abandoned (no winner) when too few are left to play it.
  if (isFour(g) && inPlay(d, g.id).length < MIN_PLAYERS) return finish(d, g, "none", "too-few");
  if (g.phase === "steal") {
    if (complete(d, g)) step(d, g, why);
    return;
  }
  const winner = isFour(g) ? null : winnerOf(d, g.id);
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
  setDeadline(d, g.id, deadline, { lastCall: 1 });
  log(tableScope(g.tableCode), `last call · everyone has voted${isFour(g) ? " on both" : ""} · round ${g.round}`);
}

// A change landed: tell every open session and re-arm the table's timer.
function changed(code: string) {
  dirty.delete(code);
  schedule(code);
  notifyTable(code);
}

// After a transaction: tell everyone if anything public changed in it (a phase
// move, via enter, or a touch), otherwise only re-arm the timer. A pick sends
// nothing unless it moved the phase: even an identical frame would show how many picked.
function flush(code: string) {
  if (dirty.has(code)) changed(code);
  else schedule(code);
}

// A timer step must never take the server down for every table: a step that throws is logged
// (the message only: no prompt, no ids beyond the table) and that game is left as it was.
function safely(code: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    log(tableScope(code), `timer step failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  if (g.deadline <= Date.now()) return safely(code, () => fire(code, g.round, g.phase));
  const timer = setTimeout(() => safely(code, () => fire(code, g.round, g.phase)), Math.max(0, g.deadline - Date.now()));
  timer.unref();
  timers.set(code, timer);
}

// The deadline of (round, phase) arrived. Does nothing if that phase has
// already been left, which is what makes a race with an early finish harmless.
function fire(code: string, round: number, phase: string) {
  db.transaction((tx) => {
    const g = currentGame(code);
    if (!g || g.winner || g.round !== round || g.phase !== phase || g.deadline === null) return;
    if (g.deadline > Date.now()) return;
    step(tx, g, "timer");
    touch(code);
  });
  flush(code);
}

// At boot: re-arm every running game's timer. A deadline that passed while the
// server was down fires straight away, and the next phase then gets a fresh
// deadline from now rather than cascading through several at once.
export function resumeGames() {
  const running = db.select({ code: tables.code }).from(tables).where(eq(tables.status, "playing")).all();
  if (process.env.GIT_SHA) log("server", `build ${process.env.GIT_SHA.replace(/[^\w.-]/g, "").slice(0, 40)}`);
  log("server", `started · resuming ${running.length} running game${running.length === 1 ? "" : "s"}`);
  for (const { code } of running) {
    // A game this engine can't carry on (one begun by an older version: no slot
    // order, or no prompt for its round) is ended with no winner, not resumed broken.
    const g = currentGame(code);
    if (g && !g.winner && !resumable(g)) {
      db.transaction((tx) => finish(tx, g, "none", "update"));
      log(tableScope(code), `game ended with no winner at boot · it can't be resumed (round ${g.round}, ${g.phase})`);
      notifyTable(code);
      continue;
    }
    // A table marked playing with no running game has nothing to wait on: reopen it.
    if (!g || g.winner) {
      db.update(tables).set({ status: g?.winner === "none" ? "open" : "finished" }).where(eq(tables.code, code)).run();
      log(tableScope(code), "table was marked playing with no running game · closed at boot");
      continue;
    }
    // A reveal with no deadline and no winner (an older build moved the game there
    // and its reveal had no timer): give it the usual one, or it would sit forever.
    if (g.phase === "reveal" && g.deadline === null) {
      setDeadline(db, g.id, Date.now() + REVEAL_SECONDS * 1000);
      log(tableScope(code), `reveal had no deadline at boot · round ${g.round} moves on in ${REVEAL_SECONDS}s`);
    }
    schedule(code);
  }
}

// What the engine needs to carry a game on: this round's prompt, and the slot
// cycle the next rounds draw from.
function resumable(g: Game): boolean {
  if (!g.slotOrder) return false;
  try {
    if ((JSON.parse(g.slotOrder) as unknown[]).length !== SLOTS.length) return false;
  } catch {
    return false;
  }
  return !!promptOf(db, g.id, g.round);
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
    // The host skips what is left of listening: straight to the vote, even on autoplay.
    if (now.phase === "listen") enter(tx, now, "vote", { cause: `by ${by}` });
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
    return { ok: true };
  });
  if (res.ok) flush(code);
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
    if (game.phase !== "vote" || (game.deadline !== null && Date.now() >= game.deadline)) {
      return fail(409, "Voting is not open.");
    }
    if (me.ejectedRound !== null) return fail(403, "Ghosts can't vote.");
    let target = "skip";
    if (choice !== "skip") {
      const who = playerByName(tx, game, choice.name);
      if (!who || who.ejected !== null) return fail(400, "Vote for someone still in the game, or skip.");
      if (who.id === personId) return fail(400, "You can't vote for yourself.");
      target = who.id;
    }
    tx.insert(votes)
      .values({ gameId: game.id, round: game.round, voterPersonId: personId, choice: target, slot: null })
      .onConflictDoUpdate({ target: [votes.gameId, votes.round, votes.voterPersonId], set: { choice: target, slot: null } })
      .run();
    // Nothing is logged while the vote is open: the tally is public, so a line per vote would show
    // whose vote moved which count. One line at the lock says who voted (logVotesIn).
    settle(tx, code, "everyone voted");
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}

// Four rounds: the best pick. `order` is a card's place in the round's play order (the
// number on the public card); not your own card (picked by you, or lent by you).
// Changeable until the vote locks, like the mole vote. Both ballots feed the last call.
export function castBest(code: string, personId: string, order: number): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner) return fail(409, "No vote is open.");
    if (!isFour(game)) return fail(409, "There is no best pick in this format.");
    const me = playerRow(game, personId);
    if (!me) return fail(403, "You are watching this game.");
    if (game.phase !== "vote" || (game.deadline !== null && Date.now() >= game.deadline)) return fail(409, "Voting is not open.");
    const card = tx.select().from(picks).where(and(eq(picks.gameId, game.id), eq(picks.round, game.round), eq(picks.slot, order))).get();
    if (!card) return fail(400, "No such card.");
    if (!isOthersCard(card, personId)) return fail(400, "You can't pick your own card.");
    tx.insert(bestVotes)
      .values({ gameId: game.id, round: game.round, voterPersonId: personId, pickPersonId: card.personId })
      .onConflictDoUpdate({ target: [bestVotes.gameId, bestVotes.round, bestVotes.voterPersonId], set: { pickPersonId: card.personId } })
      .run();
    // Nothing is logged while the vote is open (see castVote); the lock line covers this ballot too.
    touch(code);
    settle(tx, code, "everyone voted");
    return { ok: true };
  });
  if (res.ok) flush(code);
  return res;
}

// Knockout: a ghost's private guess at who the mole is, once or changed any time during a
// round's vote. It is stored and shown to nobody (it sends nothing on any stream) until the
// game is over, when each ghost's guesses and hits are public.
export function castGhostGuess(code: string, personId: string, name: string): { ok: true } | Fail {
  return db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner) return fail(409, "No vote is open.");
    if (isFour(game)) return fail(409, "There are no ghosts in this format.");
    const me = playerRow(game, personId);
    if (!me) return fail(403, "You are watching this game.");
    if (me.ejectedRound === null) return fail(403, "Only ghosts guess.");
    if (game.phase !== "vote" || (game.deadline !== null && Date.now() >= game.deadline)) return fail(409, "Voting is not open.");
    const who = playerByName(tx, game, name);
    if (!who || who.ejected !== null) return fail(400, "Guess someone still in the game.");
    if (who.id === personId) return fail(400, "You can't guess yourself.");
    const before = tx.select({ p: ghostGuesses.ghostPersonId }).from(ghostGuesses)
      .where(and(eq(ghostGuesses.gameId, game.id), eq(ghostGuesses.round, game.round), eq(ghostGuesses.ghostPersonId, personId))).get();
    tx.insert(ghostGuesses)
      .values({ gameId: game.id, round: game.round, ghostPersonId: personId, guessPersonId: who.id })
      .onConflictDoUpdate({ target: [ghostGuesses.gameId, ghostGuesses.round, ghostGuesses.ghostPersonId], set: { guessPersonId: who.id } })
      .run();
    // Not who they guessed, and nothing is sent to anyone: a guess changes nothing public.
    if (!before) log(tableScope(code), `${personTag(personId)} made a ghost guess · round ${game.round}`);
    return { ok: true };
  });
}

// The voted-out mole's one guess. Only them, only during the steal, only from
// the options. It ends the steal at once.
export function castSteal(code: string, personId: string, promptId: string): { ok: true } | Fail {
  const res = db.transaction((tx): { ok: true } | Fail => {
    const game = currentGame(code);
    if (!game || game.winner || game.phase !== "steal") return fail(409, "There is no steal to make.");
    if (game.stealPersonId !== personId || !playerRow(game, personId)) return fail(403, "This steal isn't yours.");
    if (game.deadline !== null && Date.now() >= game.deadline) return fail(409, "The steal is over.");
    if (game.stealGuess !== null) return fail(409, "You already guessed.");
    if (!(JSON.parse(game.stealOptions ?? "[]") as string[]).includes(promptId)) return fail(400, "Guess one of the prompts you were offered.");
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
    const bot = isBotPerson(personId);
    if (removedBy) {
      // A bot is only seated again by the host adding one: no removal row to keep it out.
      if (!bot) tx.insert(tableRemovals).values({ tableCode: code, personId, at: Date.now() }).onConflictDoNothing().run();
      log(tableScope(code), `${personTag(removedBy)} removed ${bot ? "a bot " : ""}${personTag(personId)}`);
    } else {
      log(tableScope(code), `${personTag(personId)} left the table`);
    }
    const t = tableOptions(code)!;
    if (t.hostPersonId === personId) {
      // A bot can't be the host: the role passes to the longest-seated person.
      const next = tx
        .select({ id: tableMembers.personId })
        .from(tableMembers)
        .innerJoin(people, eq(people.id, tableMembers.personId))
        .where(and(eq(tableMembers.tableCode, code), eq(people.isBot, false)))
        .orderBy(asc(tableMembers.joinedAt), sql`table_members.rowid`)
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
  // A table with nobody but bots left is over for them: they go too (each leaves like anyone).
  if (left && humanCount(code) === 0) {
    const bots = botSeats(code);
    if (bots.length) log(tableScope(code), "nobody but bots left: the bots leave too");
    for (const b of bots) leaveTable(code, b.id);
  }
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
  // Four rounds: the card (its `order`) this person chose as best, during the vote.
  best?: { order: number };
  // Knockout ghosts: their own guess this round (private to them, in the vote only).
  guess?: { name: string };
  // Only the voted-out mole during the steal (in Four rounds, whoever the room caught).
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
  // Four rounds deals moles per round; the role here is for the round in play.
  const mole = isMoleNow(db, g, me.role, personId);
  const view: MyView = {
    role: ghost ? "ghost" : mole ? "mole" : "player",
    picked: pickedThisRound(db, g).has(personId),
    borrowUsed: !!me.borrowUsed,
    played: playedIds(db, g),
  };
  if (prompt) {
    view.slot = prompt.slot as Slot;
    // Keyed on the dealt role, so a voted-out mole (a ghost now) is still kept from it.
    if (!mole) view.prompt = promptById(prompt.promptId)?.text;
  }
  if (g.phase === "vote" && !g.winner && !ghost) {
    const v = db.select({ c: votes.choice }).from(votes)
      .where(and(eq(votes.gameId, g.id), eq(votes.round, g.round), eq(votes.voterPersonId, personId))).get();
    if (v) {
      const name = v.c && v.c !== "skip" ? db.select({ n: people.name }).from(people).where(eq(people.id, v.c)).get()?.n : undefined;
      view.vote = name ? { name } : { skip: true };
    }
  }
  if (g.phase === "vote" && !g.winner) {
    if (isFour(g)) {
      const b = db.select({ p: bestVotes.pickPersonId }).from(bestVotes)
        .where(and(eq(bestVotes.gameId, g.id), eq(bestVotes.round, g.round), eq(bestVotes.voterPersonId, personId))).get();
      const order = b && db.select({ s: picks.slot }).from(picks).where(and(eq(picks.gameId, g.id), eq(picks.round, g.round), eq(picks.personId, b.p))).get()?.s;
      if (order !== undefined && order !== null) view.best = { order };
    } else if (ghost) {
      const gu = db.select({ p: ghostGuesses.guessPersonId }).from(ghostGuesses)
        .where(and(eq(ghostGuesses.gameId, g.id), eq(ghostGuesses.round, g.round), eq(ghostGuesses.ghostPersonId, personId))).get();
      const n = gu && db.select({ n: people.name }).from(people).where(eq(people.id, gu.p)).get()?.n;
      if (n) view.guess = { name: n };
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
    if (resume) setDeadline(tx, g.id, Date.now() + t.slotSeconds * 1000, { nowPlaying: slot });
    else tx.update(games).set({ nowPlaying: slot }).where(eq(games.id, g.id)).run();
    log(tableScope(code), `${by ? `${by} ` : ""}played track ${slot + 1} · round ${g.round}`);
    return { ok: true };
  });
  if (res.ok) changed(code);
  return res;
}
