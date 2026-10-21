import { expect, it, vi } from "vitest";
import { baseUrl, CRATE_IDS, fillCrate, session, slotMap, uniqueName } from "./helpers";

// Decision 0008: votes are on tracks, and every round has one house record:
// a song by an artist from a random player's crate, in nobody's crate at the
// table, shuffled in with the picks and unmarked until the reveal.
// Deezer decides whether a record is found in time, so a round may have
// players or players+1 tracks; the specs that need the house record retry a
// fresh table (up to 4 times) and fail only if none ever finds one.

vi.setConfig({ testTimeout: 120_000 });

type Session = ReturnType<typeof session>;
type Player = { s: Session; name: string };
type Game = {
  round: number;
  phase: string;
  deadline: number | null;
  tally?: { slot: number; votes: number }[];
  skips?: number;
  lastCall?: boolean;
  reveal?: {
    ejected: string | null;
    ejectedHouse: boolean;
    slots: { slot: number; owner?: string; house?: true; inspiredBy?: string }[];
    votes: { voter: string; slot: number | null }[];
  };
};
type State = { status: string; game?: Game };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = async (code: string) => (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as State;
async function waitFor(code: string, ok: (s: State) => boolean, ms = 15000): Promise<State> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await state(code);
    if (ok(s)) return s;
    if (Date.now() > until) throw new Error(`state never matched: ${JSON.stringify(s)}`);
    await sleep(150);
  }
}

async function setup(n: number, opts: Record<string, unknown> = {}) {
  const players: Player[] = [];
  for (let i = 0; i < n; i++) {
    const s = session();
    const name = uniqueName(`h${i}`);
    await s.call("/api/join", { body: { name, pin: "2580" } });
    await fillCrate(s);
    players.push({ s, name });
  }
  const { code } = (await (await players[0].s.call("/api/tables", { body: { pickSeconds: 30, voteSeconds: 30, ...opts } })).json()) as { code: string };
  for (const p of players.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await players[0].s.call(`/api/tables/${code}/start`, { body: {} });
  return { code, players };
}

// Picks for everyone and waits for listening; the picks are the first n crate tracks.
async function toListen(t: Awaited<ReturnType<typeof setup>>) {
  const picked = new Map<string, number>();
  for (const [i, p] of t.players.entries()) {
    expect((await p.s.call(`/api/tables/${t.code}/pick`, { body: { trackId: CRATE_IDS[i] } })).status).toBe(200);
    picked.set(p.name, CRATE_IDS[i]);
  }
  await waitFor(t.code, (s) => s.game?.phase === "listen", 8000);
  const { slots } = (await (await t.players[0].s.call(`/api/tables/${t.code}/round`)).json()) as { slots: unknown[] };
  return { picked, slots: slots.length };
}

async function toVote(t: Awaited<ReturnType<typeof setup>>) {
  await t.players[0].s.call(`/api/tables/${t.code}/advance`, { body: {} });
  await waitFor(t.code, (s) => s.game?.phase === "vote");
}

// A table in its vote phase with a house record in the mix, retrying on Deezer misses.
async function withHouse(n = 4, opts: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = await setup(n, opts);
    const l = await toListen(t);
    if (l.slots === n + 1) {
      await toVote(t);
      const map = await slotMap(t.players[0].s, t.code, CRATE_IDS.slice(0, 5));
      return { ...t, picked: l.picked, map };
    }
    for (const p of t.players) await p.s.call(`/api/tables/${t.code}/leave`, { body: {} });
  }
  throw new Error("Deezer never produced a house record in 4 tables");
}

const vote = (p: Player, code: string, body: unknown) => p.s.call(`/api/tables/${code}/vote`, { body });

it("adds one house record, so a round has players+1 tracks, none of them from a crate", async () => {
  const t = await withHouse(4);
  expect(t.map.count).toBe(5);
  // Every pick matches a crate track; exactly one slot matches none: the house record.
  expect(t.map.byTrack.size).toBe(4);
  expect(t.map.house).not.toBeNull();
  for (const id of CRATE_IDS.slice(0, 5)) {
    // the house record's slot is not the slot of any crate track
    expect(t.map.byTrack.get(id)).not.toBe(t.map.house);
  }
});

it("lets the round play without a house record when there is none, never more than one", async () => {
  const t = await setup(3);
  const l = await toListen(t);
  expect([3, 4]).toContain(l.slots);
});

it("does not mark the house record before the reveal: slots, audio, state and tally look alike", async () => {
  const t = await withHouse(4);
  const [host] = t.players;
  const slotsText = await (await host.s.call(`/api/tables/${t.code}/round`)).text();
  expect(Object.keys(JSON.parse(slotsText))).toEqual(["slots"]);
  expect(JSON.parse(slotsText).slots.every((x: object) => Object.keys(x).join() === "slot")).toBe(true);
  const audio = await (await host.s.call(`/api/tables/${t.code}/round/slots/${t.map.house}/audio`)).json();
  expect(Object.keys(audio)).toEqual(["url"]);
  const pub = await state(t.code);
  const stream = await host.s.open(`/api/tables/${t.code}/events`);
  await stream.next((e) => e.event === "state");
  const text = JSON.stringify(pub) + stream.raw + slotsText;
  stream.close();
  expect(text).not.toMatch(/house|inspired|owner/i);
  // Every slot has a tally entry shaped the same.
  expect(pub.game!.tally).toHaveLength(5);
  expect(pub.game!.tally!.every((x) => Object.keys(x).sort().join() === "slot,votes")).toBe(true);
});

it("shows live counts and never who voted, and a vote can change until the last one's call", async () => {
  const t = await withHouse(4);
  const [a, b, c] = t.players;
  const [s0, s1] = [0, 1];
  expect((await state(t.code)).game!.tally!.every((x) => x.votes === 0)).toBe(true);
  expect((await vote(a, t.code, { slot: s0 })).status).toBe(200);
  let g = (await state(t.code)).game!;
  expect(g.tally!.find((x) => x.slot === s0)!.votes).toBe(1);
  // changed his mind: the old slot loses the vote, the new one gains it
  expect((await vote(a, t.code, { slot: s1 })).status).toBe(200);
  g = (await state(t.code)).game!;
  expect(g.tally!.find((x) => x.slot === s0)!.votes).toBe(0);
  expect(g.tally!.find((x) => x.slot === s1)!.votes).toBe(1);
  await vote(b, t.code, skipBody());
  expect((await state(t.code)).game!.skips).toBe(1);
  // counts only: no names anywhere in the vote-phase public state
  const text = JSON.stringify(await state(t.code));
  for (const p of t.players) expect(text).not.toContain(p.name);
  expect((await vote(c, t.code, { slot: 99 })).status).toBe(400);
  expect((await vote(c, t.code, {})).status).toBe(400);
  expect((await vote(c, t.code, { name: b.name })).status).toBe(400);
});
const skipBody = () => ({ skip: true });

it("starts a last call of at most 5 s once everyone has voted, and the last change counts", async () => {
  const t = await withHouse(4, { voteSeconds: 60 });
  const mine = (p: Player) => t.map.byTrack.get(t.picked.get(p.name)!)!;
  const [a, b, c, d] = t.players;
  // a, b, c vote for d's track; d votes skip; nobody is ejected yet.
  for (const p of [a, b, c]) await vote(p, t.code, { slot: mine(d) });
  expect((await state(t.code)).game!.lastCall).toBeUndefined();
  const before = (await state(t.code)).game!.deadline!;
  await vote(d, t.code, skipBody());
  const g = (await state(t.code)).game!;
  expect(g.phase).toBe("vote"); // not locked at once
  expect(g.lastCall).toBe(true);
  expect(g.deadline!).toBeLessThanOrEqual(Date.now() + 5000 + 500);
  expect(g.deadline!).toBeLessThan(before);
  // within the last call, d changes their vote to b's track; the last change counts
  expect((await vote(d, t.code, { slot: mine(b) })).status).toBe(200);
  const s = await waitFor(t.code, (x) => x.game?.phase === "reveal" || x.status === "finished", 9000);
  const r = s.game!.reveal!;
  // d's track got 3 votes and wins; its picker is ejected
  expect(r.ejected).toBe(d.name);
  expect(r.votes.find((v) => v.voter === d.name)!.slot).toBe(mine(b));
});

it("rejects a vote once the vote has locked", async () => {
  const t = await withHouse(4);
  for (const p of t.players) await vote(p, t.code, skipBody());
  await waitFor(t.code, (s) => s.game?.phase === "reveal", 9000);
  expect((await vote(t.players[0], t.code, skipBody())).status).toBe(409);
});

it("ejects nobody when the house record wins, and the reveal labels it with whose crate it echoes", async () => {
  const t = await withHouse(4);
  const house = t.map.house!;
  for (const p of t.players) expect((await vote(p, t.code, { slot: house })).status).toBe(200);
  const s = await waitFor(t.code, (x) => x.game?.phase === "reveal", 9000);
  const r = s.game!.reveal!;
  expect(r.ejected).toBeNull();
  expect(r.ejectedHouse).toBe(true);
  const row = r.slots.find((x) => x.slot === house)!;
  expect(row.house).toBe(true);
  expect(row.owner).toBeUndefined();
  expect(t.players.map((p) => p.name)).toContain(row.inspiredBy);
  expect(r.slots.filter((x) => x.house)).toHaveLength(1);
  expect(r.votes.map((v) => v.slot)).toEqual([house, house, house, house]);
  expect(r.votes.map((v) => v.voter).sort()).toEqual(t.players.map((p) => p.name).sort());
});

it("ejects nobody on a tie or when skip wins, and shows who voted what at the reveal", async () => {
  const t = await withHouse(4);
  const mine = (p: Player) => t.map.byTrack.get(t.picked.get(p.name)!)!;
  const [a, b, c, d] = t.players;
  await vote(a, t.code, { slot: mine(b) });
  await vote(b, t.code, { slot: mine(a) });
  await vote(c, t.code, { slot: mine(b) });
  await vote(d, t.code, { slot: mine(a) });
  const s = await waitFor(t.code, (x) => x.game?.phase === "reveal", 9000);
  expect(s.game!.reveal!.ejected).toBeNull();
  expect(s.game!.reveal!.ejectedHouse).toBe(false);
  expect(s.game!.reveal!.votes).toHaveLength(4);
  expect(s.game!.reveal!.votes.find((v) => v.voter === a.name)!.slot).toBe(mine(b));

  const u = await withHouse(4);
  const m2 = (p: Player) => u.map.byTrack.get(u.picked.get(p.name)!)!;
  await vote(u.players[0], u.code, { slot: m2(u.players[1]) });
  for (const p of u.players.slice(1)) await vote(p, u.code, skipBody());
  const s2 = await waitFor(u.code, (x) => x.game?.phase === "reveal", 9000);
  expect(s2.game!.reveal!.ejected).toBeNull();
  expect(s2.game!.reveal!.votes.filter((v) => v.slot === null)).toHaveLength(3);
});
