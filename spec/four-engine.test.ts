import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Four rounds and the Knockout ghost guess, on the engine itself against a scratch database (this
// file never touches the running app's). Calling the engine directly makes the moles known and the
// clock ours: a "lock" is moving the phase deadline into the past and letting the engine fire it.
// CLAUDE.md "Formats" has the rules; decision 0010 has the why.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "four-spec-")), "app.db");
vi.setConfig({ testTimeout: 60_000 });

async function load() {
  const { db } = await import("../src/lib/db.ts");
  const S = await import("../src/lib/schema.ts");
  const G = await import("../src/lib/game.ts");
  const T = await import("../src/lib/tables.ts");
  const L = await import("../src/lib/log.ts");
  const { eq, and } = await import("drizzle-orm");
  return { db, S, G, T, L, eq, and };
}
let M = await load();

type Slot = "up" | "down" | "out" | "in";
const SLOTS: Slot[] = ["up", "down", "out", "in"];
let seq = 0;
type W = { code: string; ids: string[]; names: string[]; base: number[] };

// A table of n people, each with a complete crate of distinct songs, and a started game.
function world(n: number, o: { format?: "four" | "knockout"; moles?: number | null } = {}): W {
  const { db, S, G } = M;
  const code = `Z${String(++seq).padStart(3, "0")}`;
  const now = Date.now();
  const ids: string[] = [];
  const names: string[] = [];
  const base: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    names.push(`w${seq}x${i}`);
    base.push(seq * 1000 + i * 20);
    db.insert(S.people).values({ id, name: names[i], pinHash: "x", pinSalt: "x", createdAt: now }).run();
    for (let j = 0; j < 12; j++) {
      db.insert(S.tasteTracks).values({ personId: id, trackId: base[i] + j, title: `t${base[i] + j}`, artist: `a${i}`, slot: SLOTS[Math.floor(j / 3)], addedAt: now + j }).run();
    }
  }
  db.insert(S.tables).values({ code, hostPersonId: ids[0], status: "open", format: o.format ?? "four", moles: o.moles ?? null, createdAt: now }).run();
  ids.forEach((id, i) => db.insert(S.tableMembers).values({ tableCode: code, personId: id, joinedAt: now + i }).run());
  expect(G.startGame(code)).toEqual({ ok: true });
  return { code, ids, names, base };
}

const game = (w: W) => M.T.currentGame(w.code)!;
const pub = (w: W) => M.T.publicState(w.code)!;
const nameOf = (w: W, id: string) => w.names[w.ids.indexOf(id)];
const molesOf = (w: W, round: number): string[] =>
  M.db.select().from(M.S.roundMoles).where(M.and(M.eq(M.S.roundMoles.gameId, game(w).id), M.eq(M.S.roundMoles.round, round))).all().map((r) => r.personId);
const idx = (w: W, id: string) => w.ids.indexOf(id);

// Everyone picks a song of their own crate (the `round`th), except those in `skip`.
function pickAll(w: W, skip: string[] = []) {
  const round = game(w).round;
  w.ids.forEach((id, i) => {
    if (skip.includes(id)) return;
    expect(M.G.pickTrack(w.code, id, w.base[i] + (round === 1 ? 0 : round))).toEqual({ ok: true });
  });
}
function toVote(w: W) {
  expect(game(w).phase).toBe("listen");
  expect(M.G.advance(w.code)).toEqual({ ok: true });
  expect(game(w).phase).toBe("vote");
}
// The engine fires the phase's deadline now, as the clock would.
function lock(w: W) {
  M.db.update(M.S.games).set({ deadline: Date.now() - 1 }).where(M.eq(M.S.games.id, game(w).id)).run();
  M.G.schedule(w.code);
}
const vote = (w: W, voter: string, choice: string | "skip") =>
  expect(M.G.castVote(w.code, voter, choice === "skip" ? "skip" : { name: nameOf(w, choice) })).toEqual({ ok: true });
// The card (its play order) picked by `who` in the round in play.
const cardOf = (w: W, who: string): number =>
  M.db.select().from(M.S.picks).where(M.and(M.eq(M.S.picks.gameId, game(w).id), M.eq(M.S.picks.round, game(w).round), M.eq(M.S.picks.personId, who))).get()!.slot!;
const best = (w: W, voter: string, of: string) => M.G.castBest(w.code, voter, cardOf(w, of));
const scoresOf = (w: W): Record<string, number> => Object.fromEntries(pub(w).game!.scores!.map((s) => [s.name, s.score]));
const roundIn = (w: W, round: number) => pub(w).game!.past.find((p) => p.round === round)!;
const realPrompt = (w: W) => M.db.select().from(M.S.gamePrompts).where(M.and(M.eq(M.S.gamePrompts.gameId, game(w).id), M.eq(M.S.gamePrompts.round, game(w).round))).get()!.promptId;

// ---- the rules as pure functions ----

it("scores a round per rule: a hand-checked example", async () => {
  const { roundPoints, SCORE_CATCH, SCORE_BEST, SCORE_LEND, SCORE_ESCAPE, SCORE_STEAL } = M.G;
  expect([SCORE_CATCH, SCORE_BEST, SCORE_LEND, SCORE_ESCAPE, SCORE_STEAL]).toEqual([2, 1, 1, 2, 3]);
  // Moles M1 M2; players A B C D. A and D vote M1 (+2 each); B votes A and C skips (0); M2 votes M1 (a mole: 0).
  // Best: A->B's card, borrowed from D (B +1, D +1), C->B's card (B +1, D +1), D->A (+1), B->C (+1), M1->A (+1), M2->C (+1).
  // M1 was caught and guessed wrong: no steal. M2 was not caught, so M2 escapes on their own (+2).
  const pts = roundPoints({
    moles: new Set(["M1", "M2"]),
    players: ["A", "B", "C", "D", "M1", "M2"],
    moleVotes: [{ voter: "A", choice: "M1" }, { voter: "D", choice: "M1" }, { voter: "B", choice: "A" }, { voter: "M2", choice: "M1" }],
    bestVotes: [
      { voter: "A", picker: "B", lender: "D" }, { voter: "C", picker: "B", lender: "D" }, { voter: "D", picker: "A", lender: null },
      { voter: "B", picker: "C", lender: null }, { voter: "M1", picker: "A", lender: null }, { voter: "M2", picker: "C", lender: null },
    ],
    caught: new Set(["M1"]),
    stole: null,
  });
  expect(Object.fromEntries(pts)).toEqual({ A: 2 + 1 + 1, B: 0 + 1 + 1, C: 0 + 1 + 1, D: 2 + 1 + 1, M1: 0, M2: 2 });
  // The same round, with both moles caught (a tie between them): nobody escapes.
  const both = roundPoints({
    moles: new Set(["M1", "M2"]), players: ["A", "M1", "M2"], moleVotes: [{ voter: "A", choice: "M1" }], bestVotes: [], caught: new Set(["M1", "M2"]), stole: null,
  });
  expect(Object.fromEntries(both)).toEqual({ A: 2, M1: 0, M2: 0 });
  // The moles got away (+2 each); a mole who stole is +3 and not +2 (caught).
  const away = roundPoints({ moles: new Set(["M1"]), players: ["A", "M1"], moleVotes: [], bestVotes: [], caught: new Set(), stole: null });
  expect(Object.fromEntries(away)).toEqual({ A: 0, M1: 2 });
  const stole = roundPoints({ moles: new Set(["M1"]), players: ["A", "M1"], moleVotes: [{ voter: "A", choice: "M1" }], bestVotes: [], caught: new Set(["M1"]), stole: "M1" });
  expect(Object.fromEntries(stole)).toEqual({ A: 2, M1: 3 });
});

it("reads the top mole vote: a mole on top is caught; a tie between moles counts as caught; any other tie, skip, or a non-mole on top lets them go", () => {
  const { judgeFour } = M.G;
  const moles = new Set(["M1", "M2"]);
  const t = (o: Record<string, number>) => new Map(Object.entries(o));
  const first = (n: number) => 0;
  expect(judgeFour(t({ M1: 3, P: 1 }), moles, first)).toMatchObject({ caught: true, steal: "M1", tied: false, caughtMoles: ["M1"] });
  // Each mole is judged on their own: M1 caught says nothing of M2, who is not in `caughtMoles` and so gets away.
  expect(judgeFour(t({ M1: 3, M2: 1, P: 1 }), moles, first).caughtMoles).toEqual(["M1"]);
  expect(judgeFour(t({ M1: 2, M2: 2 }), moles, first).caughtMoles).toEqual(["M1", "M2"]);
  expect(judgeFour(t({ P: 3, M1: 1 }), moles, first).caughtMoles).toEqual([]);
  // The rule for a tie: only moles level on top = the top mole vote is a mole; one of them (at random) steals.
  expect(judgeFour(t({ M1: 2, M2: 2, P: 1 }), moles, first)).toMatchObject({ caught: true, steal: "M1", tied: true });
  expect(judgeFour(t({ M1: 2, M2: 2 }), moles, (n) => n - 1)).toMatchObject({ caught: true, steal: "M2", tied: true });
  // A tie that includes a non-mole, or skip, or a non-mole alone on top: they got away.
  expect(judgeFour(t({ M1: 2, P: 2 }), moles, first)).toMatchObject({ caught: false, steal: null });
  expect(judgeFour(t({ M1: 2, skip: 2 }), moles, first)).toMatchObject({ caught: false });
  expect(judgeFour(t({ skip: 3, M1: 2 }), moles, first)).toMatchObject({ caught: false });
  expect(judgeFour(t({ P: 3, M1: 1 }), moles, first)).toMatchObject({ caught: false, accused: "P" });
  expect(judgeFour(t({}), moles, first)).toMatchObject({ caught: false, accused: null });
});

// ---- a whole game ----

it("plays four rounds: moles dealt again each round and named only at its reveal, scores move only at reveals, ends with winners", async () => {
  const w = world(6, { moles: 2 });
  expect(pub(w).game).toMatchObject({ format: "four", round: 1, phase: "pick" });
  const seenMoles: string[] = [];
  const slots: string[] = [];
  const logSince = M.L.recentLines(w.code).length;

  for (let round = 1; round <= 4; round++) {
    expect(game(w).round).toBe(round);
    const moles = molesOf(w, round);
    expect(moles).toHaveLength(2);
    seenMoles.push(moles.slice().sort().join());
    // Everyone's /me: the round's moles say mole and have no prompt; the others have it.
    for (const id of w.ids) {
      const v = M.G.myView(w.code, id);
      expect(v.role).toBe(moles.includes(id) ? "mole" : "player");
      expect("prompt" in v).toBe(!moles.includes(id));
      expect(v.slot).toBeDefined();
    }
    // Before the reveal nothing public names a mole, a role, a point, or a ballot.
    const early = JSON.stringify({ ...pub(w).game, past: [] }); // past rounds are revealed, and name their own moles
    expect(early).not.toMatch(/"(moles|role|roles|points|bestVotes|reveal|winners)"\s*:/);
    expect(pub(w).game!.past.map((p) => p.round)).toEqual(Array.from({ length: round - 1 }, (_, i) => i + 1));
    pickAll(w);
    toVote(w);
    const before = scoresOf(w);
    // Everyone casts both ballots (skip, and the first card that isn't theirs): a vote open, scores still.
    for (const id of w.ids) {
      vote(w, id, "skip");
      const other = w.ids.find((o) => o !== id)!;
      expect(best(w, id, other)).toEqual({ ok: true });
    }
    expect(game(w).lastCall).toBe(1);
    expect(scoresOf(w)).toEqual(before);
    expect(pub(w).game!.bestTally!.reduce((a, c) => a + c.votes, 0)).toBe(6);
    lock(w);
    expect(game(w).phase).toBe("reveal");
    slots.push(M.db.select().from(M.S.gamePrompts).where(M.and(M.eq(M.S.gamePrompts.gameId, game(w).id), M.eq(M.S.gamePrompts.round, round))).get()!.slot);
    // The reveal names the round's moles and applies its scores.
    const r = pub(w).game!;
    expect(r.reveal!.moles).toEqual(moles.map((m) => nameOf(w, m)).sort());
    const gained = Object.fromEntries(r.reveal!.points!.map((p) => [p.name, p.points]));
    for (const n of w.names) expect(scoresOf(w)[n]).toBe((before[n] ?? 0) + gained[n]);
    // All skipped: both moles got away (+2); each got one best vote (+1 each across the table: 6 cards, 6 votes).
    for (const m of moles) expect(gained[nameOf(w, m)]).toBeGreaterThanOrEqual(2);
    if (round < 4) expect(M.G.advance(w.code)).toEqual({ ok: true });
  }
  // Each mood once.
  expect(new Set(slots).size).toBe(4);
  // Roles were dealt again: over four rounds of 2 from 6 the moles are not always the same pair.
  expect(new Set(seenMoles).size).toBeGreaterThan(1);

  // Game over: the highest score wins, ties share, every round's moles and prompts are public.
  const end = pub(w);
  expect(end.status).toBe("finished");
  const g = end.game!;
  expect(g.winner).toBe("points");
  const top = Math.max(...Object.values(scoresOf(w)));
  expect(g.winners).toEqual(w.names.filter((n) => scoresOf(w)[n] === top));
  expect(g.past).toHaveLength(4);
  for (const p of g.past) expect(p.moles).toHaveLength(2);
  expect(g.prompts).toHaveLength(4);
  expect(g.moles!.length).toBeGreaterThanOrEqual(2);
  expect(M.db.select().from(M.S.roundScores).where(M.eq(M.S.roundScores.gameId, game(w).id)).all()).toHaveLength(24);

  // The log: the prompt only at the reveal lines and the finish, never the votes' targets or the cards chosen.
  const lines = M.L.recentLines(w.code).slice(logSince);
  const texts = M.db.select().from(M.S.gamePrompts).where(M.eq(M.S.gamePrompts.gameId, game(w).id)).all().map((p) => M.T.promptById(p.promptId)!.text);
  for (const l of lines) {
    if (!/^\[table \w+\] (reveal|game finished)/.test(l)) for (const t of texts) expect(l).not.toContain(t);
    expect(l).not.toMatch(/voted for|best pick of|chose card/);
  }
  // No line per vote while open; one per round at the lock, naming who cast each ballot.
  expect(lines.some((l) => /\) (voted|changed their vote|chose a best pick) · round/.test(l))).toBe(false);
  expect(lines.filter((l) => /votes in · mole: .* \(6 of 6\) · best pick: .* \(6 of 6\) · round/.test(l))).toHaveLength(4);
  expect(lines.filter((l) => /last call · everyone has voted on both/.test(l))).toHaveLength(4);
  expect(lines.some((l) => /game finished · winner: points/.test(l))).toBe(true);
});

it("scores a hand-checked game: a caught mole's wrong steal, a getaway, and a right steal", async () => {
  const w = world(6, { moles: 2 });
  const expectPoints = (round: number, by: Record<string, number>) => {
    const got = Object.fromEntries(roundIn(w, round).points!.map((p) => [p.name, p.points]));
    expect(got).toEqual(Object.fromEntries(w.ids.map((id) => [nameOf(w, id), by[id] ?? 0])));
  };

  // Round 1. Players P1-P4, moles M1 and M2. P2 borrows a song of P4's.
  let [m1, m2] = molesOf(w, 1);
  let [p1, p2, p3, p4] = w.ids.filter((id) => ![m1, m2].includes(id));
  w.ids.forEach((id, i) => {
    if (id === p2) expect(M.G.pickTrack(w.code, id, w.base[idx(w, p4)] + 1, nameOf(w, p4))).toEqual({ ok: true });
    else expect(M.G.pickTrack(w.code, id, w.base[i])).toEqual({ ok: true });
  });
  toVote(w);
  vote(w, p1, m1); vote(w, p2, p1); vote(w, p3, "skip"); vote(w, p4, m1); vote(w, m1, p1); vote(w, m2, m1);
  // Best: P1 and P3 pick P2's (borrowed from P4), P4 picks P1's, P2 picks P3's, M1 picks P1's, M2 picks P3's.
  for (const [v, of] of [[p1, p2], [p3, p2], [p4, p1], [p2, p3], [m1, p1], [m2, p3]]) expect(best(w, v, of)).toEqual({ ok: true });
  expect(scoresOf(w)).toEqual(Object.fromEntries(w.names.map((n) => [n, 0])));
  lock(w);
  // M1 is on top (3 votes: P1, P4, M2): caught, so M1 has the steal. A wrong guess scores nothing.
  expect(game(w).phase).toBe("steal");
  expect(pub(w).game!.accused).toBe(nameOf(w, m1));
  expect(scoresOf(w)).toEqual(Object.fromEntries(w.names.map((n) => [n, 0])));
  const options = M.G.myView(w.code, m1).steal!.options.map((o) => o.id);
  expect(options).toHaveLength(8);
  expect(options).toContain(realPrompt(w));
  // Only the caught mole is offered the options.
  for (const id of w.ids.filter((x) => x !== m1)) expect(M.G.myView(w.code, id).steal).toBeUndefined();
  expect(M.G.castSteal(w.code, m1, options.find((o) => o !== realPrompt(w))!)).toEqual({ ok: true });
  expect(game(w).phase).toBe("reveal");
  // M2 was not the one caught, so M2 got away on their own: +2.
  expectPoints(1, { [p1]: 2 + 2, [p2]: 0 + 2, [p3]: 0 + 2, [p4]: 2 + 2, [m1]: 0, [m2]: 2 });
  expect(pub(w).game!.reveal).toMatchObject({ stole: false, wasMole: true, accused: nameOf(w, m1), moles: [nameOf(w, m1), nameOf(w, m2)].sort() });
  const bv = pub(w).game!.reveal!.bestVotes!;
  expect(bv).toHaveLength(6);
  expect(bv.find((b) => b.voter === nameOf(w, p1))).toMatchObject({ picker: nameOf(w, p2), lender: nameOf(w, p4) });
  const r1 = { ...scoresOf(w) };

  // Round 2. Everyone skips: both moles got away, +2 each; nobody else scores.
  expect(M.G.advance(w.code)).toEqual({ ok: true });
  [m1, m2] = molesOf(w, 2);
  pickAll(w); toVote(w);
  for (const id of w.ids) vote(w, id, "skip");
  lock(w);
  expect(game(w).phase).toBe("reveal");
  expectPoints(2, { [m1]: 2, [m2]: 2 });
  expect(roundIn(w, 2)).toMatchObject({ wasMole: false });
  expect(pub(w).game!.reveal).toMatchObject({ accused: null, wasMole: false });
  expect(M.G.advance(w.code)).toEqual({ ok: true });

  // Round 3. The room all vote for one mole, who steals right: they get +3 (not the +2 of a getaway), the four voters +2.
  [m1, m2] = molesOf(w, 3);
  const players3 = w.ids.filter((id) => ![m1, m2].includes(id));
  pickAll(w); toVote(w);
  for (const id of players3) vote(w, id, m1);
  vote(w, m1, "skip"); vote(w, m2, m1);
  lock(w);
  expect(game(w).phase).toBe("steal");
  expect(M.G.castSteal(w.code, m1, realPrompt(w))).toEqual({ ok: true });
  expect(game(w).phase).toBe("reveal");
  expectPoints(3, { ...Object.fromEntries(players3.map((p) => [p, 2])), [m1]: 3, [m2]: 2 });
  expect(pub(w).game!.reveal).toMatchObject({ stole: true, wasMole: true });
  expect(game(w).winner).toBeNull();
  expect(M.G.advance(w.code)).toEqual({ ok: true });

  // Round 4 ends the game after its reveal; scores are the sum of the rounds.
  pickAll(w); toVote(w);
  for (const id of w.ids) vote(w, id, "skip");
  lock(w);
  const final = pub(w).game!;
  expect(final.winner).toBe("points");
  const sums = Object.fromEntries(w.names.map((n) => [n, final.past.reduce((a, p) => a + p.points!.find((q) => q.name === n)!.points, 0)]));
  expect(scoresOf(w)).toEqual(sums);
  expect(r1[nameOf(w, p1)]).toBe(4);
  const top = Math.max(...Object.values(sums));
  expect(final.winners).toEqual(w.names.filter((n) => sums[n] === top));
});

it("breaks a tie between two moles on top: it counts as caught and one of them steals", async () => {
  const w = world(6, { moles: 2 });
  const [m1, m2] = molesOf(w, 1);
  const [p1, p2, p3, p4] = w.ids.filter((id) => ![m1, m2].includes(id));
  pickAll(w); toVote(w);
  vote(w, p1, m1); vote(w, p2, m1); vote(w, p3, m2); vote(w, p4, m2); vote(w, m1, p1); vote(w, m2, p2);
  lock(w);
  expect(game(w).phase).toBe("steal");
  expect([m1, m2]).toContain(game(w).stealPersonId);
  const stealer = game(w).stealPersonId!;
  // Only the one who steals is offered the options; the other tied mole is not.
  expect(M.G.myView(w.code, stealer).steal).toBeDefined();
  expect(M.G.myView(w.code, stealer === m1 ? m2 : m1).steal).toBeUndefined();
  // Out of time: a missed steal. Nobody got away, so no +2 for either mole; the four who named a mole got +2.
  lock(w);
  expect(game(w).phase).toBe("reveal");
  const pts = Object.fromEntries(roundIn(w, 1).points!.map((p) => [p.name, p.points]));
  expect(pts[nameOf(w, m1)]).toBe(0);
  expect(pts[nameOf(w, m2)]).toBe(0);
  for (const p of [p1, p2, p3, p4]) expect(pts[nameOf(w, p)]).toBe(2);

  // A tie that includes a non-mole is a getaway.
  const v = world(6, { moles: 2 });
  const [n1, n2] = molesOf(v, 1);
  const [q1, q2, q3, q4] = v.ids.filter((id) => ![n1, n2].includes(id));
  pickAll(v); toVote(v);
  vote(v, q1, n1); vote(v, q2, n1); vote(v, q3, q1); vote(v, q4, q1); vote(v, n1, "skip"); vote(v, n2, "skip");
  lock(v);
  expect(game(v).phase).toBe("reveal");
  expect(pub(v).game!.reveal!.wasMole).toBe(false);
  const got = Object.fromEntries(roundIn(v, 1).points!.map((p) => [p.name, p.points]));
  expect(got[nameOf(v, n1)]).toBe(2);
  expect(got[nameOf(v, n2)]).toBe(2);
});

it("takes best-pick votes for any card but your own: a borrowed card credits its lender, who can't pick it either", async () => {
  const w = world(4, { moles: 1 });
  const [a, b, c, d] = w.ids;
  // b borrows from d.
  w.ids.forEach((id, i) => {
    if (id === b) expect(M.G.pickTrack(w.code, b, w.base[3] + 1, nameOf(w, d))).toEqual({ ok: true });
    else expect(M.G.pickTrack(w.code, id, w.base[i])).toEqual({ ok: true });
  });
  // Before the vote there is no best pick to cast.
  expect(M.G.castBest(w.code, a, 0)).toMatchObject({ ok: false, status: 409 });
  toVote(w);
  const err = (r: ReturnType<typeof M.G.castBest>) => (r.ok ? "" : `${r.status} ${r.error}`);
  expect(err(await best(w, a, a))).toMatch(/^400 You can't pick your own card/);
  expect(err(await best(w, d, b))).toMatch(/^400 You can't pick your own card/); // their song, lent
  expect(err(M.G.castBest(w.code, a, 99))).toMatch(/^400 No such card/);
  expect(best(w, a, b)).toEqual({ ok: true });
  // Changeable: a second vote replaces the first, the tally follows.
  const cnt = () => Object.fromEntries(pub(w).game!.bestTally!.map((t) => [t.order, t.votes]));
  expect(cnt()[cardOf(w, b)]).toBe(1);
  expect(best(w, a, c)).toEqual({ ok: true });
  expect(cnt()[cardOf(w, b)]).toBe(0);
  expect(cnt()[cardOf(w, c)]).toBe(1);
  expect(M.G.myView(w.code, a).best).toEqual({ order: cardOf(w, c) });
  expect(M.G.myView(w.code, b).best).toBeUndefined();
  // The tally is counts only: no names anywhere in it.
  expect(JSON.stringify(pub(w).game!.bestTally)).not.toMatch(/[a-z]/i.test(JSON.stringify(pub(w).game!.bestTally)) ? /name|voter|picker/ : /$^/);
  // b's card gets two votes (from a and c): +1 each to b, +1 each to lender d.
  expect(best(w, a, b)).toEqual({ ok: true });
  expect(best(w, c, b)).toEqual({ ok: true });
  for (const id of [a, b, c, d]) vote(w, id, "skip");
  expect(game(w).lastCall).toBe(0); // b and d have not cast a best pick yet
  expect(best(w, b, a)).toEqual({ ok: true });
  expect(best(w, d, a)).toEqual({ ok: true });
  expect(game(w).lastCall).toBe(1);
  lock(w);
  const pts = Object.fromEntries(roundIn(w, 1).points!.map((p) => [p.name, p.points]));
  const moleId = molesOf(w, 1)[0];
  const escape = (id: string) => (id === moleId ? 2 : 0);
  expect(pts[nameOf(w, b)]).toBe(2 + escape(b)); // two best votes
  expect(pts[nameOf(w, d)]).toBe(2 + escape(d)); // lent it twice
  expect(pts[nameOf(w, a)]).toBe(2 + escape(a)); // picked by b and d
  expect(pts[nameOf(w, c)]).toBe(0 + escape(c));
  // After the lock a late ballot is refused.
  expect(M.G.castBest(w.code, a, 0)).toMatchObject({ ok: false, status: 409 });
  expect(M.G.castBest(w.code, a, 0)).toMatchObject({ error: "Voting is not open." });
});

it("never lets a score move while a vote is open", async () => {
  const w = world(4, { moles: 1 });
  for (let round = 1; round <= 2; round++) {
    pickAll(w); toVote(w);
    const before = JSON.stringify(scoresOf(w));
    for (const id of w.ids) {
      vote(w, id, w.ids.find((o) => o !== id)!);
      expect(JSON.stringify(scoresOf(w))).toBe(before);
      best(w, id, w.ids.find((o) => o !== id)!);
      expect(JSON.stringify(scoresOf(w))).toBe(before);
      expect(M.db.select().from(M.S.gamePlayers).where(M.eq(M.S.gamePlayers.gameId, game(w).id)).all().map((p) => p.score).sort()).toEqual(Object.values<number>(JSON.parse(before)).sort());
    }
    lock(w);
    // A steal (if any) also happens before the reveal and changes nothing.
    if (game(w).phase === "steal") {
      expect(JSON.stringify(scoresOf(w))).toBe(before);
      lock(w);
    }
    expect(game(w).phase).toBe("reveal");
    if (round < 2) M.G.advance(w.code);
  }
});

it("keeps both ballots through a restart in the middle of a vote", async () => {
  const w = world(4, { moles: 1 });
  const [a, b, c] = w.ids;
  pickAll(w); toVote(w);
  vote(w, a, b); vote(w, b, "skip"); vote(w, c, a);
  expect(best(w, a, c)).toEqual({ ok: true });
  expect(best(w, c, b)).toEqual({ ok: true });
  const frame = JSON.stringify(pub(w).game);
  const mine = JSON.stringify([M.G.myView(w.code, a), M.G.myView(w.code, b), M.G.myView(w.code, c)]);
  // A new process: the modules are loaded afresh from the same database file, and boot resumes the game.
  vi.resetModules();
  const old = M;
  M = await load();
  M.G.resumeGames();
  expect(M).not.toBe(old);
  expect(JSON.stringify(pub(w).game)).toBe(frame);
  expect(JSON.stringify([M.G.myView(w.code, a), M.G.myView(w.code, b), M.G.myView(w.code, c)])).toBe(mine);
  expect(M.G.myView(w.code, a)).toMatchObject({ vote: { name: nameOf(w, b) }, best: { order: cardOf(w, c) } });
  // And the vote carries on: the last ballots arrive, last call starts, it locks.
  vote(w, w.ids[3], "skip");
  expect(best(w, w.ids[3], a)).toEqual({ ok: true });
  expect(best(w, b, a)).toEqual({ ok: true });
  expect(game(w).lastCall).toBe(1);
  lock(w);
  expect(game(w).phase === "reveal" || game(w).phase === "steal").toBe(true);
});

// ---- endings ----

it("abandons a Four rounds game when a round has no picks at all, with no winner", async () => {
  const w = world(3);
  lock(w); // the pick phase ends with nobody having picked
  const g = pub(w);
  expect(g.status).toBe("open");
  expect(g.game).toMatchObject({ winner: "none", ending: "nobody-picked" });
  expect(g.game!.winners).toBeUndefined();
  expect(M.T.tableOptions(w.code)!.status).toBe("open");
  // Later round: two rounds played, then nobody picks.
  const v = world(3);
  for (let r = 1; r <= 2; r++) {
    pickAll(v); toVote(v);
    for (const id of v.ids) vote(v, id, "skip");
    lock(v);
    M.G.advance(v.code);
  }
  expect(game(v).round).toBe(3);
  lock(v);
  expect(pub(v).game).toMatchObject({ winner: "none" });
  expect(pub(v).game!.winners).toBeUndefined();
});

it("abandons a Four rounds game when too few are left to play, and moves on when one leaves with three or more", async () => {
  const w = world(4);
  pickAll(w); toVote(w);
  M.G.leaveTable(w.code, w.ids[3]);
  expect(game(w).phase).toBe("vote");
  expect(pub(w).game!.scores!.map((s) => s.name)).toEqual(w.names.slice(0, 3));
  M.G.leaveTable(w.code, w.ids[2]);
  expect(pub(w).game).toMatchObject({ winner: "none", ending: "too-few" });
  expect(M.T.tableOptions(w.code)!.status).toBe("open");
});

it("cuts a vote short for a Four rounds player with no card to vote for and needs nobody else's", async () => {
  const w = world(3);
  // Only one card on the table: the others can pick it, its picker has nothing to vote for and isn't waited on.
  M.G.pickTrack(w.code, w.ids[0], w.base[0]);
  lock(w);
  expect(game(w).phase).toBe("listen");
  toVote(w);
  for (const id of w.ids) vote(w, id, "skip");
  expect(game(w).lastCall).toBe(0);
  expect(best(w, w.ids[1], w.ids[0])).toEqual({ ok: true });
  expect(game(w).lastCall).toBe(0);
  expect(best(w, w.ids[2], w.ids[0])).toEqual({ ok: true });
  expect(game(w).lastCall).toBe(1);
});

// ---- Knockout ghosts ----

it("lets a Knockout ghost guess privately each round and shows every guess and hit only at game over", async () => {
  const w = world(4, { format: "knockout" });
  const mole = w.ids.find((id) => M.G.myView(w.code, id).role === "mole")!;
  const [x, y, z] = w.ids.filter((id) => id !== mole);
  // Round 1: the room votes out a player (x), not the mole.
  pickAll(w); toVote(w);
  // Nobody is a ghost yet: no guess to make.
  expect(M.G.castGhostGuess(w.code, x, nameOf(w, mole))).toMatchObject({ ok: false, status: 403, error: "Only ghosts guess." });
  for (const id of [y, z, mole]) vote(w, id, x);
  vote(w, x, "skip");
  lock(w);
  expect(game(w).phase).toBe("reveal");
  expect(pub(w).game!.ghosts).toEqual([nameOf(w, x)]);
  M.G.advance(w.code);

  // Round 2: x is a ghost and guesses; nobody else can see it, nor is it in any public tally.
  pickAll(w, [x]); toVote(w);
  expect(M.G.myView(w.code, x).role).toBe("ghost");
  expect(M.G.castGhostGuess(w.code, x, nameOf(w, x))).toMatchObject({ ok: false, status: 400 });
  expect(M.G.castGhostGuess(w.code, x, "nobody-here")).toMatchObject({ ok: false, status: 400 });
  expect(M.G.castGhostGuess(w.code, y, nameOf(w, z))).toMatchObject({ ok: false, status: 403 });
  expect(M.G.castVote(w.code, x, "skip")).toMatchObject({ ok: false, status: 403 });
  const quiet = JSON.stringify(pub(w));
  expect(M.G.castGhostGuess(w.code, x, nameOf(w, y))).toEqual({ ok: true });
  expect(M.G.castGhostGuess(w.code, x, nameOf(w, mole))).toEqual({ ok: true }); // changeable
  // A guess changes nothing public, and only the ghost's own /me has it.
  expect(JSON.stringify(pub(w))).toBe(quiet);
  expect(JSON.stringify(pub(w))).not.toMatch(/guess/i);
  expect(M.G.myView(w.code, x).guess).toEqual({ name: nameOf(w, mole) });
  for (const id of [y, z, mole]) expect(JSON.stringify(M.G.myView(w.code, id))).not.toMatch(/guess/i);
  for (const id of [y, z]) vote(w, id, mole);
  vote(w, mole, "skip");
  lock(w);
  // The room caught the mole; they miss the steal; the players win.
  expect(game(w).phase).toBe("steal");
  lock(w);
  expect(game(w).winner).toBe("players");
  // Past the vote, before game over there was nothing; now the guesses show, with their hits.
  const g = pub(w).game!;
  expect(g.ghostGuesses).toEqual([{ ghost: nameOf(w, x), guesses: [{ round: 2, guess: nameOf(w, mole), hit: true }], hits: 1 }]);
  expect(g.winners).toBeUndefined();
  // None of it was logged with a target.
  for (const l of M.L.recentLines(w.code)) expect(l).not.toContain(`guessed ${nameOf(w, mole)}`);
  expect(M.L.recentLines(w.code).some((l) => /made a ghost guess/.test(l))).toBe(true);
});

it("keeps Knockout's own public shape: no scores, no best tally, and no best pick or ghost guess in the wrong format", async () => {
  const k = world(3, { format: "knockout" });
  pickAll(k); toVote(k);
  const g = pub(k).game!;
  expect(g.format).toBe("knockout");
  expect(g).not.toHaveProperty("scores");
  expect(g).not.toHaveProperty("bestTally");
  expect(M.G.castBest(k.code, k.ids[0], 0)).toMatchObject({ ok: false, status: 409 });
  const f = world(3);
  pickAll(f); toVote(f);
  expect(M.G.castGhostGuess(f.code, f.ids[0], f.names[1])).toMatchObject({ ok: false, status: 409 });
});

// ---- the stage 3 review's fixes ----

// Plays a whole round: everyone picks, the vote opens. `ballot` casts the votes.
const reveal = (w: W) => pub(w).game!.reveal!;
const pointsOf = (w: W): Record<string, number> => Object.fromEntries(reveal(w).points!.map((p) => [p.name, p.points]));
// Every person's reasons add up to their points, and each reason is n times its kind's unit.
function expectReasonsAdd(w: W) {
  const unit = { caught: 2, best: 1, lend: 1, escaped: 2, stole: 3 } as const;
  const r = reveal(w);
  expect(r.points!.length).toBeGreaterThan(0);
  for (const p of r.points!) {
    expect(p.reasons.reduce((a, x) => a + x.points, 0)).toBe(p.points);
    for (const x of p.reasons) expect(x.points).toBe(x.n * unit[x.kind]);
  }
}

it("keeps the winner and the final scores after game over, when a player leaves", async () => {
  // The review's repro: scores A 2, B 10, C 8, then B (the winner) leaves.
  const w = world(3, { moles: 1 });
  for (let round = 1; round <= 4; round++) {
    pickAll(w); toVote(w);
    for (const id of w.ids) vote(w, id, "skip");
    // B (ids[1]) gets every best vote that isn't their own; the others split the rest.
    for (const id of w.ids) expect(best(w, id, id === w.ids[1] ? w.ids[2] : w.ids[1])).toEqual({ ok: true });
    lock(w);
    if (round < 4) M.G.advance(w.code);
  }
  const before = pub(w).game!;
  expect(before.winner).toBe("points");
  const top = Math.max(...before.scores!.map((s) => s.score));
  expect(before.winners).toEqual(before.scores!.filter((s) => s.score === top).map((s) => s.name));
  expect(before.winners).toContain(w.names[1]);
  const frozen = JSON.stringify({ scores: before.scores, winners: before.winners, past: before.past, reveal: before.reveal });
  // The winner leaves, then another: nothing on the game-over screen moves, and history still agrees.
  M.G.leaveTable(w.code, w.ids[1]);
  expect(JSON.stringify({ scores: pub(w).game!.scores, winners: pub(w).game!.winners, past: pub(w).game!.past, reveal: pub(w).game!.reveal })).toBe(frozen);
  M.G.leaveTable(w.code, w.ids[2]);
  expect(JSON.stringify({ scores: pub(w).game!.scores, winners: pub(w).game!.winners, past: pub(w).game!.past, reveal: pub(w).game!.reveal })).toBe(frozen);
  expect(pub(w).game!.winners).toContain(w.names[1]);
  // The winners are stored with the game, not worked out from who is seated.
  const stored = JSON.parse(game(w).finalResult!) as { scores: unknown[]; winners: string[] };
  expect(stored.winners).toEqual(before.winners);
  expect(stored.scores).toHaveLength(3);
});

it("sends the reasons for every person's points from the server, and they sum to the points, with a leaver in the game", async () => {
  // Random ballots over several games, with someone leaving at a random moment: every reveal adds up.
  for (let n = 0; n < 6; n++) {
    const six = n % 2 === 0;
    const w = world(six ? 6 : 4, { moles: six ? 2 : 1 });
    const rnd = (k: number) => Math.floor(Math.random() * k);
    let leaver: string | null = null;
    for (let round = 1; round <= 4; round++) {
      pickAll(w, w.ids.filter((id) => id === leaver));
      toVote(w);
      const live = () => w.ids.filter((id) => id !== leaver);
      // Some vote before the leaver goes, some after; the leaver (a mole or not) leaves in round 2 or 3.
      const ids = live();
      const half = ids.slice(0, ids.length >> 1);
      for (const id of half) {
        const others = ids.filter((o) => o !== id);
        vote(w, id, rnd(3) === 0 ? "skip" : others[rnd(others.length)]);
        best(w, id, others[rnd(others.length)]);
      }
      if (round === 2 + (n % 2) && !leaver) {
        leaver = n % 4 < 2 ? half[0] : molesOf(w, round)[0];
        M.G.leaveTable(w.code, leaver);
        if (game(w).winner) break;
      }
      if (game(w).phase === "vote") {
        for (const id of live()) {
          vote(w, id, rnd(3) === 0 ? "skip" : live().filter((o) => o !== id)[rnd(live().length - 1)]);
          const others = live().filter((o) => o !== id);
          best(w, id, others[rnd(others.length)]);
        }
        lock(w);
      }
      if (game(w).phase === "steal") lock(w);
      if (game(w).phase !== "reveal" && !game(w).winner) break;
      const r = reveal(w);
      expectReasonsAdd(w);
      // The reveal lists no one who had left as a voter, and says who left.
      if (leaver) {
        expect(r.left).toContain(nameOf(w, leaver));
        expect(r.votes.map((v) => v.voter)).not.toContain(nameOf(w, leaver));
        expect(r.bestVotes!.map((v) => v.voter)).not.toContain(nameOf(w, leaver));
        expect(r.points!.map((p) => p.name)).not.toContain(nameOf(w, leaver));
      }
      // Those points are the ones the scores moved by.
      for (const p of r.points!) expect(roundIn(w, round).points!.find((q) => q.name === p.name)).toEqual(p);
      if (game(w).winner) break;
      M.G.advance(w.code);
    }
    // Game over: past[] carries the same reasons for every round.
    if (game(w).winner === "points") for (const p of pub(w).game!.past) for (const q of p.points!) expect(q.reasons.reduce((a, x) => a + x.points, 0)).toBe(q.points);
  }
});

// A mole who leaves counts as caught for those who voted for them (+2 each), with no steal; the other
// mole in the round is still judged on their own.
{
  const setup = (phase: "pick" | "listen" | "vote" | "steal") => {
    const w = world(6, { moles: 2 });
    const [m1, m2] = molesOf(w, 1);
    const [p1, p2, p3, p4] = w.ids.filter((id) => ![m1, m2].includes(id));
    const out = { w, m1, m2, p1, p2, p3, p4 };
    if (phase === "pick") return out;
    pickAll(w);
    if (phase === "listen") return out;
    toVote(w);
    return out;
  };
  const sentence = (r: ReturnType<typeof reveal>) => r.leftMoles;

  it("a mole leaving in pick: nobody had voted yet, so nobody catches them; the other mole gets away", () => {
    const { w, m1, m2, p1 } = setup("pick");
    M.G.leaveTable(w.code, m1);
    expect(game(w).phase).toBe("pick");
    M.G.pickTrack(w.code, p1, w.base[idx(w, p1)]);
    for (const id of w.ids.filter((x) => x !== m1 && x !== p1)) M.G.pickTrack(w.code, id, w.base[idx(w, id)]);
    toVote(w);
    for (const id of w.ids.filter((x) => x !== m1)) vote(w, id, "skip");
    lock(w);
    expect(game(w).phase).toBe("reveal");
    expect(sentence(reveal(w))).toEqual([nameOf(w, m1)]);
    const pts = pointsOf(w);
    expect(pts[nameOf(w, m1)]).toBeUndefined();
    expect(pts[nameOf(w, m2)]).toBe(2 + (reveal(w).bestVotes ?? []).filter((b) => b.picker === nameOf(w, m2)).length);
    expectReasonsAdd(w);
  });

  it("a mole leaving in listen: still no votes; judged as left, the other mole is judged alone", () => {
    const { w, m1, m2, p1, p2 } = setup("listen");
    M.G.leaveTable(w.code, m1);
    expect(game(w).phase).toBe("listen");
    toVote(w);
    // The room votes for the mole who stayed, and it is caught on their own.
    for (const id of w.ids.filter((x) => x !== m1 && x !== m2)) vote(w, id, m2);
    vote(w, m2, p1);
    lock(w);
    expect(game(w).phase).toBe("steal");
    expect(game(w).stealPersonId).toBe(m2);
    lock(w);
    expect(sentence(reveal(w))).toEqual([nameOf(w, m1)]);
    const pts = pointsOf(w);
    expectReasonsAdd(w);
    // 3 players (of 4 non-moles) voted m2: +2 each, m2 caught: nothing for them.
    expect(pts[nameOf(w, p2)]).toBeGreaterThanOrEqual(2);
    expect(pts[nameOf(w, m2)]).toBe((reveal(w).bestVotes ?? []).filter((b) => b.picker === nameOf(w, m2)).length);
  });

  it("a mole leaving in vote: everyone who had voted for them gets +2, no steal, and the reveal says so", () => {
    const { w, m1, m2, p1, p2, p3, p4 } = setup("vote");
    vote(w, p1, m1); vote(w, p2, m1); vote(w, p3, m2); vote(w, p4, "skip");
    vote(w, m2, m1); // a mole's own mole vote scores nothing
    M.G.leaveTable(w.code, m1);
    for (const id of [p1, p2, p3, p4, m2]) if (!M.G.myView(w.code, id).vote) vote(w, id, "skip");
    // The room's tally without m1: m2 has 1 vote (p3), skip has 1: a tie with skip, so nobody is caught by vote.
    lock(w);
    expect(game(w).phase).toBe("reveal");
    const r = reveal(w);
    expect(r.leftMoles).toEqual([nameOf(w, m1)]);
    expect(r.left).toContain(nameOf(w, m1));
    expect(r.wasMole).toBe(false);
    expect(r.stole).toBe(false);
    const pts = pointsOf(w);
    const bonus = (id: string) => (r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, id)).length;
    expect(pts[nameOf(w, p1)]).toBe(2 + bonus(p1));
    expect(pts[nameOf(w, p2)]).toBe(2 + bonus(p2));
    expect(pts[nameOf(w, p3)]).toBe(2 + bonus(p3)); // any vote for a mole catches them, top or not
    expect(pts[nameOf(w, m2)]).toBe(2 + bonus(m2)); // the other mole was not caught: gets away on their own
    expect(pts[nameOf(w, m1)]).toBeUndefined();
    expectReasonsAdd(w);
    expect(M.db.select().from(M.S.roundScores).where(M.and(M.eq(M.S.roundScores.gameId, game(w).id), M.eq(M.S.roundScores.round, 1))).all().find((s) => s.personId === m1)).toBeUndefined();
    expect(M.L.recentLines(w.code).some((l) => /reveal ·.*· left: /.test(l))).toBe(true);
  });

  it("the only mole leaving in vote: the room that had caught them is paid, and there is no steal and no escape", () => {
    const w = world(4, { moles: 1 });
    const [m] = molesOf(w, 1);
    const ps = w.ids.filter((id) => id !== m);
    pickAll(w); toVote(w);
    for (const id of ps) vote(w, id, m);
    M.G.leaveTable(w.code, m);
    expect(game(w).phase).toBe("vote");
    for (const id of ps) best(w, id, ps.find((o) => o !== id)!);
    lock(w);
    expect(game(w).phase).toBe("reveal");
    const r = reveal(w);
    for (const id of ps) expect(pointsOf(w)[nameOf(w, id)]).toBe(2 + (r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, id)).length);
    expect(r.leftMoles).toEqual([nameOf(w, m)]);
    expect(r.escaped).toEqual([]);
    expectReasonsAdd(w);
  });

  it("a mole leaving during their own steal: the vote had caught them, so those who voted for them are paid, and the steal is missed", () => {
    const { w, m1, m2, p1, p2, p3, p4 } = setup("vote");
    for (const id of [p1, p2, p3, p4]) vote(w, id, m1);
    vote(w, m1, p1); vote(w, m2, "skip");
    lock(w);
    expect(game(w).phase).toBe("steal");
    expect(game(w).stealPersonId).toBe(m1);
    M.G.leaveTable(w.code, m1);
    expect(game(w).phase).toBe("reveal");
    const r = reveal(w);
    expect(r.wasMole).toBe(true); // the vote caught them
    expect(r.stole).toBe(false);
    expect(r.leftMoles).toEqual([nameOf(w, m1)]);
    for (const id of [p1, p2, p3, p4]) expect(pointsOf(w)[nameOf(w, id)]).toBe(2 + (r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, id)).length);
    expect(pointsOf(w)[nameOf(w, m2)]).toBe(2 + (r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, m2)).length); // m2 got away on their own
    expectReasonsAdd(w);
  });

  it("when tied moles are both caught and the one who steals leaves, the other stays caught", () => {
    const { w, m1, m2, p1, p2, p3, p4 } = setup("vote");
    vote(w, p1, m1); vote(w, p2, m1); vote(w, p3, m2); vote(w, p4, m2); vote(w, m1, p1); vote(w, m2, p2);
    lock(w);
    expect(game(w).phase).toBe("steal");
    const stealer = game(w).stealPersonId!;
    M.G.leaveTable(w.code, stealer);
    const other = stealer === m1 ? m2 : m1;
    const r = reveal(w);
    // Both were caught (one by the vote and by leaving): neither got away.
    expect(pointsOf(w)[nameOf(w, other)]).toBe((r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, other)).length);
    expect(r.escaped).toEqual([]);
    expectReasonsAdd(w);
  });
}

it("keeps each round's best card on the server in past[], so a reload at game over still has every round's", async () => {
  const w = world(4, { moles: 1 });
  const expected: { picker: string; votes: number }[] = [];
  for (let round = 1; round <= 4; round++) {
    pickAll(w); toVote(w);
    // Everyone best-picks the card of the next person along (so each card gets one vote), except that
    // w.ids[0]'s card gets a second vote from w.ids[2]: it is the unique best card.
    for (const id of w.ids) vote(w, id, "skip");
    for (const [i, id] of w.ids.entries()) expect(best(w, id, i === 2 ? w.ids[0] : w.ids[(i + 1) % 4])).toEqual({ ok: true });
    lock(w);
    expect(reveal(w).points!.length).toBe(4);
    expected.push({ picker: w.names[0], votes: 2 });
    if (round < 4) M.G.advance(w.code);
  }
  // "A reload": a new process loads the modules afresh from the same database, and boot resumes.
  vi.resetModules();
  M = await load();
  const g = pub(w).game!;
  expect(g.winner).toBe("points");
  expect(g.past).toHaveLength(4);
  for (const [i, p] of g.past.entries()) {
    expect(p.best).toHaveLength(1);
    expect(p.best![0]).toMatchObject({ picker: expected[i].picker, votes: expected[i].votes });
    expect(p.best![0].order).toBe(p.cards.find((c) => c.picker === expected[i].picker)!.order);
  }
});

it("deals the right number of moles each round of an engine game, from people in play, never the same person twice in a round", async () => {
  for (const [n, k] of [[4, 1], [6, 2]] as const) {
    for (let g = 0; g < 5; g++) {
      const w = world(n, { moles: k });
      for (let round = 1; round <= 4; round++) {
        const m = molesOf(w, round);
        expect(m.length).toBe(k);
        expect(new Set(m).size).toBe(k);
        for (const id of m) expect(w.ids).toContain(id);
        pickAll(w); toVote(w);
        for (const id of w.ids) vote(w, id, "skip");
        lock(w);
        if (round < 4) M.G.advance(w.code);
      }
    }
  }
});

it("deals weighted: a person's chance falls with how often they have been a mole, but is never zero", () => {
  const { dealOrder, dealWeight } = M.G;
  expect(dealWeight(0)).toBe(1);
  expect(dealWeight(1)).toBeCloseTo(1 / 3);
  expect(dealWeight(3)).toBeCloseTo(1 / 7);
  expect(dealWeight(3)).toBeGreaterThan(0);
  // Two people, a has been the mole once: weights a 1/3, b 1. The draw follows the injected randomness.
  const h = [["a"]];
  expect(dealOrder(h, ["a", "b"], 1, () => 0)).toEqual(["a"]);
  expect(dealOrder(h, ["a", "b"], 1, () => 0.2)).toEqual(["a"]);
  expect(dealOrder(h, ["a", "b"], 1, () => 0.4)).toEqual(["b"]);
  expect(dealOrder(h, ["a", "b"], 1, () => 0.999999)).toEqual(["b"]);
  // Someone who has been the mole every round so far can still be dealt it (nobody is ruled out by elimination).
  const every = [["a"], ["a"], ["a"]];
  expect(dealOrder(every, ["a", "b", "c", "d"], 1, () => 0)).toEqual(["a"]);
  // A round never deals the same person twice, and never more than are seated.
  for (let n = 0; n < 300; n++) {
    const got = dealOrder([["a", "b"]], ["a", "b", "c", "d", "e"], 2);
    expect(new Set(got).size).toBe(2);
  }
  expect(dealOrder([], ["a", "b"], 5).length).toBe(2);
  // A leaver is not dealt; someone who joined later has no turns yet and so the heaviest weight.
  expect(dealOrder([["a"], ["z"]], ["a", "c"], 1, () => 0.999)).toEqual(["c"]);
  for (let n = 0; n < 200; n++) expect(dealOrder([["z"]], ["a", "b", "c"], 1)).not.toContain("z");
});

it("pays each mole on their own in an engine round: one caught, one not caught gets +2, and the steal goes to the caught one", async () => {
  const w = world(6, { moles: 2 });
  const [m1, m2] = molesOf(w, 1);
  const ps = w.ids.filter((id) => ![m1, m2].includes(id));
  pickAll(w); toVote(w);
  for (const id of ps) vote(w, id, m1);
  vote(w, m1, "skip"); vote(w, m2, "skip");
  lock(w);
  expect(game(w).stealPersonId).toBe(m1);
  expect(M.G.castSteal(w.code, m1, realPrompt(w))).toEqual({ ok: true });
  const r = reveal(w);
  expect(pointsOf(w)[nameOf(w, m1)]).toBe(3 + (r.bestVotes ?? []).filter((b) => b.picker === nameOf(w, m1)).length);
  expect(r.points!.find((p) => p.name === nameOf(w, m2))!.reasons).toContainEqual({ kind: "escaped", n: 1, points: 2 });
  expect(r.points!.find((p) => p.name === nameOf(w, m1))!.reasons).toContainEqual({ kind: "stole", n: 1, points: 3 });
  expect(r.caught).toEqual([nameOf(w, m1)]);
  expect(r.escaped).toEqual([nameOf(w, m2)]);
  expectReasonsAdd(w);
});
