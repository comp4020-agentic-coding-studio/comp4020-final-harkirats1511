import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// The shop wall and taste notes on the engine itself, against a scratch database (this file never
// touches the running app's). Decision 0011, CLAUDE.md "The shop": a round goes up only once its reveal
// has opened, never from a game played at a private table, a Knockout mole only once revealed; the wall
// is built from the stored rounds, so it is the same after the database is reread by a fresh process.
// Taste notes come only from games the person sat in, and only from revealed rounds.
const DIR = mkdtempSync(join(tmpdir(), "wall-spec-"));
process.env.DATABASE_PATH = join(DIR, "app.db");
vi.setConfig({ testTimeout: 60_000 });

const { db } = await import("../src/lib/db.ts");
const S = await import("../src/lib/schema.ts");
const G = await import("../src/lib/game.ts");
const T = await import("../src/lib/tables.ts");
const W = await import("../src/lib/wall.ts");
const N = await import("../src/lib/notes.ts");
const { eq, and } = await import("drizzle-orm");

type Slot = "up" | "down" | "out" | "in";
const SLOTS: Slot[] = ["up", "down", "out", "in"];
let seq = 0;
type Wd = { code: string; ids: string[]; names: string[]; base: number[] };

function world(n: number, o: { format?: "four" | "knockout"; private?: boolean; shared?: number } = {}): Wd {
  const code = `W${String(++seq).padStart(3, "0")}`;
  const now = Date.now();
  const ids: string[] = [], names: string[] = [], base: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    names.push(`wl${seq}x${i}`);
    base.push(seq * 1000 + i * 20);
    db.insert(S.people).values({ id, name: names[i], pinHash: "x", pinSalt: "x", createdAt: now }).run();
    for (let j = 0; j < 12; j++) {
      // `shared`: everyone's first song is the same track, so two people can pick it in one round.
      const trackId = o.shared !== undefined && j === 0 ? o.shared : base[i] + j;
      db.insert(S.tasteTracks).values({ personId: id, trackId, title: `t${trackId}`, artist: `a${i}`, slot: SLOTS[Math.floor(j / 3)], addedAt: now + j }).run();
    }
  }
  db.insert(S.tables).values({ code, hostPersonId: ids[0], status: "open", format: o.format ?? "four", private: o.private ?? false, createdAt: now }).run();
  ids.forEach((id, i) => db.insert(S.tableMembers).values({ tableCode: code, personId: id, joinedAt: now + i }).run());
  expect(G.startGame(code)).toEqual({ ok: true });
  return { code, ids, names, base };
}
const game = (w: Wd) => T.currentGame(w.code)!;
const nameOf = (w: Wd, id: string) => w.names[w.ids.indexOf(id)];
const trackOf = (w: Wd, i: number, j: number) => {
  const crate = db.select().from(S.tasteTracks).where(eq(S.tasteTracks.personId, w.ids[i])).orderBy(S.tasteTracks.addedAt).all();
  return crate[j].trackId;
};
function pickAll(w: Wd, o: { borrow?: { who: number; from: number } } = {}) {
  const round = game(w).round;
  const ghosts = new Set(db.select().from(S.gamePlayers).where(eq(S.gamePlayers.gameId, game(w).id)).all().filter((p) => p.ejectedRound !== null).map((p) => p.personId));
  w.ids.forEach((id, i) => {
    if (ghosts.has(id)) return;
    if (o.borrow?.who === i) {
      expect(G.pickTrack(w.code, id, trackOf(w, o.borrow.from, 11), w.names[o.borrow.from])).toEqual({ ok: true });
    } else expect(G.pickTrack(w.code, id, trackOf(w, i, round - 1))).toEqual({ ok: true });
  });
}
function toVote(w: Wd) {
  expect(G.advance(w.code)).toEqual({ ok: true });
  expect(game(w).phase).toBe("vote");
}
function lock(w: Wd) {
  db.update(S.games).set({ deadline: Date.now() - 1 }).where(eq(S.games.id, game(w).id)).run();
  G.schedule(w.code);
}
const vote = (w: Wd, voter: string, choice: string | "skip") =>
  expect(G.castVote(w.code, voter, choice === "skip" ? "skip" : { name: nameOf(w, choice) })).toEqual({ ok: true });
const sleevesOf = (w: Wd) => W.wallPage(null, 40).sleeves.filter((s) => s.table === w.code);
const molesOf = (w: Wd, round: number) =>
  db.select().from(S.roundMoles).where(and(eq(S.roundMoles.gameId, game(w).id), eq(S.roundMoles.round, round))).all().map((r) => r.personId);

it("hangs a Four rounds round only at its reveal, with its moles, caught, picks and best card", () => {
  const w = world(4);
  const heard: unknown[] = [];
  const off = W.watchWall((x) => heard.push(x));
  pickAll(w, { borrow: { who: 1, from: 2 } });
  expect(sleevesOf(w)).toEqual([]);
  toVote(w);
  const moles = molesOf(w, 1);
  for (const id of w.ids) vote(w, id, "skip");
  // Best: player 1's card (the borrow) gets the most.
  const card = (who: number) => db.select().from(S.picks).where(and(eq(S.picks.gameId, game(w).id), eq(S.picks.round, 1), eq(S.picks.personId, w.ids[who]))).get()!.slot!;
  // (Player 2 lent that song, so it isn't theirs to vote for: they choose player 3's.)
  for (const [i, id] of w.ids.entries()) expect(G.castBest(w.code, id, card(i === 1 ? 0 : i === 2 ? 3 : 1))).toEqual({ ok: true });
  expect(sleevesOf(w)).toEqual([]);
  expect(heard).toEqual([]);
  lock(w);
  expect(game(w).phase).toBe("reveal");
  const [s] = sleevesOf(w);
  expect(s).toMatchObject({ format: "four", round: 1, moles: moles.map((m) => nameOf(w, m)).sort(), caught: false });
  expect(s.picks).toHaveLength(4);
  const borrowed = s.picks.find((p) => p.picker === w.names[1])!;
  expect(borrowed).toMatchObject({ lender: w.names[2], best: true });
  expect(s.picks.filter((p) => p.best)).toHaveLength(1);
  // Never a ballot, a score or a reason.
  expect(JSON.stringify(s)).not.toMatch(/"(voter|choice|points|score|scores|reasons|bestVotes|votes)"/);
  expect(heard).toHaveLength(1);
  expect(heard[0]).toEqual(s);
  off();
});

it("keeps a Knockout mole off the wall until they are voted out, and names them all at game over", () => {
  const w = world(5, { format: "knockout" });
  const mole = w.ids.find((id) => G.myView(w.code, id).role === "mole")!;
  const [x, y] = w.ids.filter((id) => id !== mole);
  // Round 1: a player is voted out.
  pickAll(w); toVote(w);
  for (const id of w.ids) vote(w, id, id === x ? y : x);
  lock(w);
  expect(game(w).phase).toBe("reveal");
  expect(sleevesOf(w)[0]).toMatchObject({ round: 1, moles: [], caught: false });
  G.advance(w.code);
  // Round 2: the ghost guesses; the mole is voted out and misses the steal. The game is over (players win).
  pickAll(w); toVote(w);
  expect(G.castGhostGuess(w.code, x, nameOf(w, mole))).toEqual({ ok: true });
  for (const id of w.ids.filter((i) => i !== x)) vote(w, id, id === mole ? y : mole);
  lock(w);
  expect(game(w).phase).toBe("steal");
  // While the steal runs, round 2 isn't up and the mole is named nowhere on the wall.
  expect(sleevesOf(w).map((s) => s.round)).toEqual([1]);
  for (const x of W.wallPage(null, 40).sleeves) expect(x.moles).not.toContain(nameOf(w, mole));
  const real = db.select().from(S.gamePrompts).where(and(eq(S.gamePrompts.gameId, game(w).id), eq(S.gamePrompts.round, 2))).get()!.promptId;
  const opts = JSON.parse(game(w).stealOptions!) as string[];
  expect(G.castSteal(w.code, mole, opts.find((o) => o !== real)!)).toEqual({ ok: true });
  expect(game(w).winner).toBe("players");
  const [r2, r1] = sleevesOf(w);
  expect(r2).toMatchObject({ round: 2, caught: true, moles: [nameOf(w, mole)] });
  expect(r2.stole).toBeUndefined();
  expect(r1).toMatchObject({ round: 1, caught: false, moles: [nameOf(w, mole)] });
  expect(JSON.stringify(sleevesOf(w))).not.toMatch(/"(guess|ghost|ghostGuesses|voter|choice)"/);
});

it("names a Knockout mole who was caught but the game goes on only on their own round, and keeps the other mole hidden", () => {
  const w = world(6, { format: "knockout" });
  const moles = w.ids.filter((id) => G.myView(w.code, id).role === "mole");
  expect(moles).toHaveLength(2);
  const [m1, m2] = moles;
  pickAll(w); toVote(w);
  for (const id of w.ids) vote(w, id, id === m1 ? w.ids.find((i) => !moles.includes(i))! : m1);
  lock(w);
  const real = db.select().from(S.gamePrompts).where(and(eq(S.gamePrompts.gameId, game(w).id), eq(S.gamePrompts.round, 1))).get()!.promptId;
  expect(G.castSteal(w.code, m1, (JSON.parse(game(w).stealOptions!) as string[]).find((o) => o !== real)!)).toEqual({ ok: true });
  expect(game(w).winner).toBeNull();
  const [s] = sleevesOf(w);
  expect(s).toMatchObject({ caught: true, moles: [nameOf(w, m1)] });
  expect(s.moles).not.toContain(nameOf(w, m2));
});

it("never hangs a game played at a private table, nor one whose table has since gone private", () => {
  const w = world(3, { private: true });
  pickAll(w); toVote(w);
  for (const id of w.ids) vote(w, id, "skip");
  lock(w);
  expect(game(w).phase).toBe("reveal");
  expect(sleevesOf(w)).toEqual([]);
  expect(JSON.stringify(W.wallPage(null, 40))).not.toContain(w.code);
  // Made public after: what it played in private stays off.
  T.setPrivate(w.code, false);
  expect(sleevesOf(w)).toEqual([]);
  // A public game, then the table made private: its code is private now, so its sleeves come down.
  const v = world(3);
  pickAll(v); toVote(v);
  for (const id of v.ids) vote(v, id, "skip");
  lock(v);
  expect(sleevesOf(v)).toHaveLength(1);
  T.setPrivate(v.code, true);
  expect(sleevesOf(v)).toEqual([]);
  T.setPrivate(v.code, false);
});

it("hangs nothing of an abandoned round (nobody picked)", () => {
  const w = world(3);
  lock(w);
  expect(game(w).winner).toBe("none");
  expect(sleevesOf(w)).toEqual([]);
});

it("hangs nothing of a round cut short while picking (the mole left), even though the game has a winner", () => {
  const w = world(4, { format: "knockout" });
  const mole = w.ids.find((id) => G.myView(w.code, id).role === "mole")!;
  const other = w.ids.find((id) => id !== mole)!;
  expect(G.pickTrack(w.code, other, trackOf(w, w.ids.indexOf(other), 0))).toEqual({ ok: true });
  expect(G.leaveTable(w.code, mole)).toBe(true);
  expect(game(w).winner).toBe("players");
  expect(sleevesOf(w)).toEqual([]);
  // And the page is still full: a dropped round never makes a page come up short.
  const all = W.wallPage(null, 40).sleeves.length;
  if (all >= 2) expect(W.wallPage(null, 2).sleeves.length).toBe(2);
});

it("reads the same wall from the database alone, in a fresh process", () => {
  const here = W.wallPage(null, 40);
  expect(here.sleeves.length).toBeGreaterThan(0);
  // A new Node process with nothing in memory but the database file: the same sleeves.
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const W = await import(${JSON.stringify(new URL("../src/lib/wall.ts", import.meta.url).href)});
    process.stdout.write(JSON.stringify(W.wallPage(null, 40)));
  `], { env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH }, cwd: process.cwd(), encoding: "utf8" });
  expect(JSON.parse(out)).toEqual(here);
});

it("writes taste notes only from games you sat in, and only from revealed rounds", () => {
  const SHARED = 777_000_001;
  const w = world(4, { shared: SHARED });
  const [a, b, c] = w.ids;
  // Round 1: a and b both pick the shared song; c borrows from a.
  w.ids.forEach((id, i) => {
    if (i === 2) expect(G.pickTrack(w.code, id, trackOf(w, 0, 11), w.names[0])).toEqual({ ok: true });
    else if (i < 2) expect(G.pickTrack(w.code, id, SHARED)).toEqual({ ok: true });
    else expect(G.pickTrack(w.code, id, trackOf(w, i, 5))).toEqual({ ok: true });
  });
  // Not revealed yet: nothing.
  toVote(w);
  expect(N.tasteNotes(a)).toEqual({ byMood: { up: [], down: [], out: [], in: [] }, shared: [], borrows: [] });
  const card = (who: string) => db.select().from(S.picks).where(and(eq(S.picks.gameId, game(w).id), eq(S.picks.round, 1), eq(S.picks.personId, who))).get()!.slot!;
  for (const id of w.ids) {
    vote(w, id, "skip");
    expect(G.castBest(w.code, id, card(id === a ? b : a))).toEqual({ ok: true });
  }
  lock(w);
  expect(game(w).phase).toBe("reveal");
  const slot = db.select().from(S.gamePrompts).where(and(eq(S.gamePrompts.gameId, game(w).id), eq(S.gamePrompts.round, 1))).get()!.slot as Slot;
  const na = N.tasteNotes(a);
  expect(na.byMood[slot].map((t) => t.trackId)).toEqual([SHARED]);
  expect(na.shared).toEqual([{ with: w.names[1], track: expect.objectContaining({ trackId: SHARED }) }]);
  expect(na.borrows).toEqual([{ to: w.names[2], track: expect.objectContaining({ trackId: trackOf(w, 0, 11) }) }]);
  expect(na.mostLoved).toMatchObject({ trackId: SHARED, votes: 3 });
  const nc = N.tasteNotes(c);
  expect(nc.borrows).toEqual([{ from: w.names[0], track: expect.objectContaining({ trackId: trackOf(w, 0, 11) }) }]);
  // Round 2 picked but not revealed: it adds nothing.
  G.advance(w.code);
  pickAll(w);
  expect(N.tasteNotes(a)).toEqual(na);
  // Someone who never sat at this table gets nothing from it.
  const stranger = world(3);
  expect(N.tasteNotes(stranger.ids[0]).shared).toEqual([]);
  expect(JSON.stringify(N.tasteNotes(stranger.ids[0]))).not.toContain(w.names[0]);
  // A game you walked out of isn't yours to read back.
  expect(G.leaveTable(w.code, b)).toBe(true);
  expect(N.tasteNotes(b)).toEqual({ byMood: { up: [], down: [], out: [], in: [] }, shared: [], borrows: [] });
  // Notes never carry who voted for whom, a role, or a score.
  expect(JSON.stringify(na)).not.toMatch(/"(voter|choice|role|mole|score|points)"/);
});
