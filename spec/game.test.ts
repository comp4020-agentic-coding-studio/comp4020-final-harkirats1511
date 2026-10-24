import { expect, it, vi } from "vitest";
import { PROMPTS } from "../src/lib/prompts";
import { baseUrl, CRATES, fillCrate, session, SLOT_NAMES, uniqueName } from "./helpers";

// Contract for a game at a table (CLAUDE.md has the rules these hold; decision 0009):
//   POST /api/tables {pickSeconds?, voteSeconds?, moles?, autoplay?} -> {code}
//   POST /api/tables/:code/start      host; 3 to 8 members, every crate complete
//   GET  /api/tables/:code            public state (same as the stream)
//   GET  /api/tables/:code/me         {role: "player"|"mole"|"ghost"|"spectator", prompt? (never a
//        mole), slot, picked, borrowUsed, played: trackId[], vote?, steal? (only the voted-out mole)}
//   POST /api/tables/:code/pick {trackId, from?: name}   own crate, or one borrow per game
//   POST /api/tables/:code/vote {name} | {skip: true}    alive players only; changeable until it locks
//   POST /api/tables/:code/steal {promptId}              the voted-out mole's one guess
//   POST /api/tables/:code/advance    host: listen -> vote, reveal -> next round
//   GET  /api/tables/:code/cards/:order/audio -> {url}
// Public game state: {round, phase, deadline, alive, ghosts, past, borrowed, played, cards?, deadAir?,
// tally?, skips?, lastCall?, accused? (steal), reveal?, winner?, moles?, prompts?}.
// `past` is every round whose reveal has happened (prompt, cards, ejected, wasMole), never the round
// in play before its reveal. A right steal ends the game: winner "moles". The reveal moves on by itself
// after REVEAL_SECONDS (30), except at game over.

vi.setConfig({ testTimeout: 90_000 });

type Session = ReturnType<typeof session>;
type Player = { s: Session; name: string; ids: number[] };
type Card = { order: number; picker: string; lender?: string; trackId: number; title: string; artist: string; clash?: boolean };
type Past = { round: number; prompt: string; slot: string; cards: Card[]; ejected: string | null; wasMole: boolean };
type Game = {
  round: number;
  phase: "pick" | "listen" | "vote" | "steal" | "reveal";
  deadline: number | null;
  alive: string[];
  ghosts: string[];
  past: Past[];
  borrowed: string[];
  played: number[];
  cards?: Card[];
  deadAir?: string[];
  tally?: { name: string; votes: number }[];
  skips?: number;
  lastCall?: boolean;
  accused?: string;
  reveal?: {
    prompt: string; slot: string; cards: Card[]; deadAir: string[]; votes: { voter: string; choice: string | null }[];
    accused: string | null; ejected: string | null; wasMole: boolean; stole: boolean;
  };
  winner?: "players" | "moles" | "none";
  ending?: "final-vote" | "round-cap" | "nobody-picked" | "update";
  moles?: string[];
  prompts?: { round: number; prompt: string; slot: string }[];
};
type State = { status: string; members: { name: string; crateReady: boolean; crate?: { trackId: number; slot: string }[] }[]; game?: Game };
type Me = {
  role: string; prompt?: string; slot?: string; picked: boolean; borrowUsed: boolean; played: number[];
  vote?: { name: string } | { skip: true }; steal?: { options: { id: string; text: string }[] };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function player(prefix: string, which: number): Promise<Player> {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "2580" } });
  const ids = await fillCrate(s, which);
  return { s, name, ids };
}

async function state(code: string): Promise<State> {
  return (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as State;
}

async function waitFor(code: string, ok: (s: State) => boolean, ms = 12000): Promise<State> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await state(code);
    if (ok(s)) return s;
    if (Date.now() > until) throw new Error(`state never matched: ${JSON.stringify(s)}`);
    await sleep(150);
  }
}

async function me(p: Player, code: string): Promise<Me> {
  return (await (await p.s.call(`/api/tables/${code}/me`)).json()) as Me;
}

const at = (code: string, path: string) => `/api/tables/${code}/${path}`;

async function table(n: number, opts: Record<string, unknown> = {}) {
  const players = await Promise.all(Array.from({ length: n }, (_, i) => player(`p${i}`, i)));
  const [host] = players;
  const { code } = (await (await host.s.call("/api/tables", { body: { pickSeconds: 15, voteSeconds: 15, ...opts } })).json()) as { code: string };
  for (const p of players.slice(1)) await p.s.call(at(code, "join"), { body: {} });
  return { code, host, players };
}

// A started game: who the moles are (from their own /me), who is not, and the
// round's prompt as the non-moles see it.
async function started(n: number, opts: Record<string, unknown> = {}, watch = false) {
  const t = await table(n, opts);
  const streams = watch ? new Map(t.players.map((p) => [p.name, undefined as unknown as Awaited<ReturnType<Session["open"]>>])) : null;
  if (streams) for (const p of t.players) streams.set(p.name, await p.s.open(at(t.code, "events")));
  expect((await t.host.s.call(at(t.code, "start"), { body: {} })).status).toBeLessThan(300);
  await waitFor(t.code, (s) => s.game?.phase === "pick");
  const views = new Map<string, Me>();
  for (const p of t.players) views.set(p.name, await me(p, t.code));
  const moles = t.players.filter((p) => views.get(p.name)!.role === "mole");
  const others = t.players.filter((p) => views.get(p.name)!.role === "player");
  const prompt = views.get(others[0].name)!.prompt!;
  return { ...t, views, moles, others, prompt, streams };
}
type G = Awaited<ReturnType<typeof started>>;

// Everyone in `who` picks the next unused song of their own crate for this round.
async function pickOwn(code: string, who: Player[], round = 1) {
  for (const p of who) expect((await p.s.call(at(code, "pick"), { body: { trackId: p.ids[round - 1] } })).status).toBe(200);
}

async function toVote(g: { code: string; host: Player }) {
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  await g.host.s.call(at(g.code, "advance"), { body: {} });
  await waitFor(g.code, (s) => s.game?.phase === "vote");
}

// Everyone in `voters` votes for `target`; the target can't vote for themself, so they skip.
async function voteFor(code: string, voters: Player[], target: string | "skip") {
  for (const p of voters) {
    const res = await p.s.call(at(code, "vote"), { body: target === "skip" || target === p.name ? { skip: true } : { name: target } });
    expect(res.status).toBe(200);
  }
}

async function nextRound(g: { code: string; host: Player }, round: number) {
  await g.host.s.call(at(g.code, "advance"), { body: {} });
  await waitFor(g.code, (s) => s.game?.round === round && s.game?.phase === "pick");
}

// The steal options as the mole sees them, and the one that is the real prompt
// (known to the spec from a non-mole's /me).
async function stealOptions(g: G, mole: Player) {
  const v = await me(mole, g.code);
  expect(v.steal).toBeDefined();
  const real = v.steal!.options.find((o) => o.text === g.prompt)!;
  return { options: v.steal!.options, real, wrong: v.steal!.options.find((o) => o !== real)! };
}

// Vote the mole out in the vote that is open, then let them miss the steal if
// they have one, so the game ends with the players winning.
async function ejectMole(g: G, voters: Player[]) {
  await voteFor(g.code, voters, g.moles[0].name);
  const s = await waitFor(g.code, (x) => x.game?.phase === "steal" || x.game?.phase === "reveal" || x.status === "finished", 9000);
  if (s.game!.phase === "steal") {
    const { wrong } = await stealOptions(g, g.moles[0]);
    expect((await g.moles[0].s.call(at(g.code, "steal"), { body: { promptId: wrong.id } })).status).toBe(200);
  }
  await waitFor(g.code, (x) => x.status === "finished");
}

const textOf = (...parts: unknown[]) => parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n");
// Any of the 60 prompts, by text or by id, found in what a mole was sent.
const promptsIn = (text: string) => PROMPTS.filter((p) => text.includes(p.text) || text.includes(`"${p.id}"`)).map((p) => p.id);

// ---- crates and starting ----

it("refuses to start while a crate is incomplete, naming only names", async () => {
  const [host, a, b] = await Promise.all([player("cr", 0), player("cr", 1), player("cr", 2)]);
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  await a.s.call(at(code, "join"), { body: {} });
  await b.s.call(at(code, "join"), { body: {} });
  // Sitting down was fine; take a song off a and b, and the crate is no longer complete.
  for (const p of [a, b]) expect((await p.s.call(`/api/taste/${p.ids[0]}`, { method: "DELETE" })).status).toBeLessThan(300);
  const res = await host.s.call(at(code, "start"), { body: {} });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe(`Waiting on crates: ${[a.name, b.name].join(", ")}`);
  const pub = await state(code);
  expect(pub.members.map((m) => [m.name === host.name, m.crateReady])).toEqual([[true, true], [false, false], [false, false]]);
  expect(pub.members.every((m) => m.crate === undefined)).toBe(true);
  // Complete them again and the same table starts.
  for (const p of [a, b]) expect((await p.s.call("/api/taste", { body: { trackId: p.ids[0], slot: "up" } })).status).toBe(201);
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
});

it("refuses 2 players and a ninth seat, and starts with 3 to 8", async () => {
  const [host, a] = await Promise.all([player("lim", 0), player("lim", 1)]);
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  await a.s.call(at(code, "join"), { body: {} });
  const res = await host.s.call(at(code, "start"), { body: {} });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/at least 3/);
  const more = await Promise.all([2, 3, 4, 5, 6, 7, 0].map((i) => player("lim", i)));
  for (const p of more) await p.s.call(at(code, "join"), { body: {} });
  // The ninth person is turned away at the door, not at start: the table stays at 8.
  const ninth = await player("lim", 1);
  const door = await ninth.s.call(at(code, "join"), { body: {} });
  expect(door.status).toBe(409);
  expect(((await door.json()) as { error: string }).error).toMatch(/full.*8/);
  expect((await state(code)).members.length).toBe(8);
  // Someone already seated can still reopen the page.
  expect((await more[0].s.call(at(code, "join"), { body: {} })).status).toBe(200);
  const booth = ((await (await host.s.call("/api/shop/booths")).json()) as { code?: string; seated: number; max: number }[]).find((b) => b.code === code);
  if (booth) expect(booth).toMatchObject({ seated: 8, max: 8 });
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
});

it("starts with 8 players and deals 2 moles", async () => {
  const players = await Promise.all(Array.from({ length: 8 }, (_, i) => player("eight", i)));
  const [host] = players;
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  for (const p of players.slice(1)) expect((await p.s.call(at(code, "join"), { body: {} })).status).toBeLessThan(300);
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  await waitFor(code, (s) => s.game?.phase === "pick");
  const roles = await Promise.all(players.map(async (p) => (await me(p, code)).role));
  expect(roles.filter((r) => r === "mole")).toHaveLength(2);
  expect(roles.filter((r) => r === "player")).toHaveLength(6);
});

it("ignores a host's mole count: the rule is 1 for 3 to 5 players", async () => {
  const t = await table(4, { moles: 2 });
  expect((await t.host.s.call(at(t.code, "start"), { body: {} })).status).toBeLessThan(300);
  await waitFor(t.code, (s) => s.game?.phase === "pick");
  const roles = await Promise.all(t.players.map(async (p) => (await me(p, t.code)).role));
  expect(roles.filter((r) => r === "mole")).toHaveLength(1);
});

it("locks a crate for the game: edits refused with 409, and open again once it ends", async () => {
  const g = await started(3);
  const p = g.players[1];
  const taste = (await (await p.s.call("/api/taste")).json()) as { id: number }[];
  const locked = "Your crate is locked until the game ends.";
  for (const res of [
    await p.s.call(`/api/taste/${taste[0].id}`, { method: "DELETE" }),
    await p.s.call("/api/taste", { body: { trackId: 1123844, slot: "up" } }),
    await p.s.call(`/api/taste/${taste[0].id}`, { method: "PATCH", body: { slot: "down" } }),
    await p.s.call(`/api/taste/${taste[0].id}`, { method: "PUT", body: { slot: "down" } }),
  ]) {
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(locked);
  }
  expect(((await (await p.s.call("/api/taste")).json()) as unknown[]).length).toBe(12);
  // A spectator who joins mid-game is not a player, so their crate stays theirs.
  const late = await player("late", 4);
  await late.s.call(at(g.code, "join"), { body: {} });
  expect((await late.s.call(`/api/taste/${late.ids[0]}`, { method: "DELETE" })).status).toBeLessThan(300);

  // The mole walks out: the players win and the others' crates open again.
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  await waitFor(g.code, (s) => s.status === "finished");
  const survivor = g.others[0];
  expect((await survivor.s.call(`/api/taste/${survivor.ids[0]}`, { method: "DELETE" })).status).toBeLessThan(300);
  expect((await survivor.s.call("/api/taste", { body: { trackId: survivor.ids[0], slot: "up" } })).status).toBe(201);
});

it("shows the crates on the table while a game runs, to spectators too, and only then", async () => {
  const g = await started(3);
  const late = await player("spec", 5);
  await late.s.call(at(g.code, "join"), { body: {} });
  const pub = await state(g.code);
  const lateMember = pub.members.find((m) => m.name === late.name)!;
  expect(lateMember.crate).toBeUndefined();
  for (const [i, p] of g.players.entries()) {
    const crate = pub.members.find((m) => m.name === p.name)!.crate!;
    expect(crate.map((c) => c.trackId).sort()).toEqual([...CRATES[i]].sort());
    expect(crate.filter((c) => c.slot === "out")).toHaveLength(3);
  }
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  await waitFor(g.code, (s) => s.status === "finished");
  expect((await state(g.code)).members.every((m) => m.crate === undefined)).toBe(true);
});

// ---- roles and the prompt ----

it("gives non-moles the prompt, a mole only its slot, and every view the same shape", async () => {
  const g = await started(4);
  expect(g.moles).toHaveLength(1);
  const mole = g.views.get(g.moles[0].name)!;
  expect(mole.prompt).toBeUndefined();
  expect(Object.keys(mole)).not.toContain("prompt");
  const slot = PROMPTS.find((p) => p.text === g.prompt)!.slot;
  expect(mole.slot).toBe(slot);
  for (const p of g.others) {
    const v = g.views.get(p.name)!;
    expect(v.prompt).toBe(g.prompt);
    expect(v.slot).toBe(slot);
    expect(v).toMatchObject({ role: "player", picked: false, borrowUsed: false, played: [] });
    expect(v.steal).toBeUndefined();
  }
  expect(mole).toMatchObject({ role: "mole", picked: false, borrowUsed: false, played: [] });
});

it("restores a reconnecting person's view from the server", async () => {
  const g = await started(3);
  const mole = g.moles[0];
  const again = session();
  await again.call("/api/join", { body: { name: mole.name, pin: "2580" } });
  expect(await me({ ...mole, s: again }, g.code)).toEqual(g.views.get(mole.name));
});

it("deals 2 moles at 6 players and tells neither about the other, nor anyone else", async () => {
  const g = await started(6, {}, true);
  expect(g.moles).toHaveLength(2);
  const [m1, m2] = g.moles;
  // A mole's /me says they are a mole and carries no field that could name anyone else's role.
  const allowed = ["role", "slot", "picked", "borrowUsed", "played"];
  for (const [m, other] of [[m1, m2], [m2, m1]] as const) {
    const v = g.views.get(m.name)!;
    expect(v.role).toBe("mole");
    expect(Object.keys(v).sort()).toEqual([...allowed].sort());
    expect(textOf(await (await m.s.call(at(g.code, "me"))).text())).not.toContain(other.name);
    // Nothing public (state or their own stream) carries a role value or a moles field before the end.
    const pub = await state(g.code);
    expect(pub.game).not.toHaveProperty("moles");
    expect(pub.game).not.toHaveProperty("winner");
    const raw = g.streams!.get(m.name)!.raw;
    expect(raw).not.toContain('"mole"');
    expect(raw).not.toMatch(/"moles"\s*:/);
  }
  // Every other player's view has the same shape apart from the prompt.
  for (const p of g.others) expect(Object.keys(g.views.get(p.name)!).sort()).toEqual([...allowed, "prompt"].sort());
  // Nothing public names a role, before or after a pick.
  await pickOwn(g.code, [m1]);
  await sleep(300);
  const pub = JSON.stringify(await state(g.code));
  expect(pub).not.toMatch(/"(role|roles|moles?|prompt|picked)"\s*:/);
  const raw = g.streams!.get(m1.name)!.raw;
  expect(raw).not.toMatch(/"(role|roles|moles?|prompt|picked)"\s*:/);
  expect(raw).not.toContain(m2.name + '","role');
  for (const st of g.streams!.values()) st.close();
});

it("never sends a mole the prompt, in any phase before the reveal", async () => {
  const g = await started(4, {}, true);
  const mole = g.moles[0];
  const stream = g.streams!.get(mole.name)!;
  const slot = PROMPTS.find((p) => p.text === g.prompt)!.slot;
  const everything = async (extra: unknown = "") => {
    const home = await mole.s.call(at(g.code, "me"));
    return textOf(await home.text(), await (await fetch(new URL(at(g.code, ""), baseUrl))).text(), stream.raw, await (await mole.s.call("/api/history")).text(), extra as string);
  };
  const seen: string[] = [];

  // Pick: a non-mole has the prompt, the mole has none of the 60.
  expect(g.views.get(g.others[0].name)!.prompt).toBe(g.prompt);
  seen.push(await everything());
  await pickOwn(g.code, g.players);
  // Listen: the cards and the audio route.
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  const audio = await mole.s.call(`/api/tables/${g.code}/cards/0/audio`);
  expect(audio.status).toBe(200);
  seen.push(await everything(await audio.text()));
  await toVote(g);
  await voteFor(g.code, g.players.slice(0, 2), "skip");
  seen.push(await everything());
  // The mole's own wrong-slot probes get nothing either.
  seen.push(textOf(await (await mole.s.call(at(g.code, "steal"), { body: { promptId: "up-01" } })).text()));
  for (const text of seen) expect(promptsIn(text), "a prompt reached the mole").toEqual([]);
  expect(JSON.parse((await mole.s.call(at(g.code, "me")).then((r) => r.text()))).slot).toBe(slot);
  stream.close();
  for (const st of g.streams!.values()) st.close();
});

// Everything a mole can receive, in one string: /me, public state, a fresh SSE
// snapshot, the table page HTML and the history. (The suite has no browser, and the
// page shell holds no game state, so the client can only show what these carry.)
async function everythingAMoleGets(g: G, mole: Player) {
  const stream = await mole.s.open(at(g.code, "events"));
  await stream.next((e) => e.event === "state");
  const parts = [
    await (await mole.s.call(at(g.code, "me"))).text(),
    await (await fetch(new URL(at(g.code, ""), baseUrl))).text(),
    stream.raw,
    await (await mole.s.call(`/t/${g.code}`)).text(),
    await (await mole.s.call("/api/history")).text(),
  ];
  stream.close();
  return textOf(...parts);
}
// A prompt text may appear once its round is in `past` (revealed): only then.
const unrevealedPromptsIn = (text: string, past: Past[]) => {
  const revealed = new Set(past.map((p) => p.prompt));
  return PROMPTS.filter((p) => !revealed.has(p.text) && (text.includes(p.text) || text.includes(p.text.replace(/'/g, "&#39;")) || text.includes(`"${p.id}"`))).map((p) => p.id);
};

it("sends a mole no unrevealed prompt in /me, public state, a stream snapshot or the table page, in pick, listen and vote", async () => {
  const g = await started(4);
  const mole = g.moles[0];
  const seen: [string, string][] = [];
  const grab = async (label: string) => {
    const pub = (await state(g.code)).game!;
    seen.push([label, await everythingAMoleGets(g, mole)]);
    return pub.past;
  };
  // Round 1: pick, listen, vote.
  await grab("r1 pick");
  await pickOwn(g.code, g.players);
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  await grab("r1 listen");
  await toVote(g);
  await grab("r1 vote");
  await voteFor(g.code, g.players, "skip");
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  // Round 2: round 1's prompt is public now; round 2's must not be.
  await nextRound(g, 2);
  const prompt2 = (await me(g.others[0], g.code)).prompt!;
  expect(prompt2).toBeTruthy();
  await grab("r2 pick");
  await pickOwn(g.code, g.players, 2);
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  await grab("r2 listen");
  await toVote(g);
  const past = await grab("r2 vote");
  expect(past.map((p) => p.round)).toEqual([1]);
  for (const [label, text] of seen) {
    // The check bites: a non-mole's own /me does carry its prompt.
    expect(unrevealedPromptsIn(text, past), `a prompt reached the mole in ${label}`).toEqual([]);
  }
  expect(unrevealedPromptsIn(prompt2, past), "the check can see a prompt").toHaveLength(1);
  // Round 2's prompt is in the non-mole's view, which the same scan does find.
  expect(unrevealedPromptsIn(await (await g.others[0].s.call(at(g.code, "me"))).text(), past)).toHaveLength(1);
});

// ---- picking ----

it("keeps picks hidden until picking closes: public state and the stream don't change", async () => {
  const g = await started(4, {}, true);
  const before = await state(g.code);
  await pickOwn(g.code, g.players.slice(0, 2));
  await sleep(300);
  expect(await state(g.code)).toEqual(before);
  // Crates are public while a game runs, so titles are on the table; what must not
  // appear is anything about picks, and no frame after the start differs from another.
  const raw = [...g.streams!.values()].map((s) => s.raw).join("\n");
  expect(raw).not.toMatch(/"(cards|deadAir|picker|picked)"/);
  for (const st of g.streams!.values()) {
    const after = st.seen.filter((e) => e.event === "state" && e.data.game).map((e) => JSON.stringify(e.data));
    expect(new Set(after).size).toBe(1);
  }
  for (const st of g.streams!.values()) st.close();
});

it("sends nothing on any stream when someone picks, until the phase moves", async () => {
  const g = await started(4, { pickSeconds: 60 });
  const anon = await session().open(at(g.code, "events"));
  const joined = await g.players[0].s.open(at(g.code, "events"));
  await anon.next((e) => e.event === "state" && e.data.game?.phase === "pick", 3000);
  await joined.next((e) => e.event === "state" && e.data.game?.phase === "pick", 3000);
  const [a, b, c, d] = g.players;
  const frames = () => [anon.seen.length, joined.seen.length];
  const base = frames();
  const rawBase = [anon.raw.length, joined.raw.length];
  // One by one, not the last; one of them a borrow.
  expect((await a.s.call(at(g.code, "pick"), { body: { trackId: a.ids[0] } })).status).toBe(200);
  await sleep(400);
  expect(frames()).toEqual(base);
  expect((await b.s.call(at(g.code, "pick"), { body: { trackId: c.ids[1], from: c.name } })).status).toBe(200);
  await sleep(400);
  expect(frames()).toEqual(base);
  expect((await c.s.call(at(g.code, "pick"), { body: { trackId: c.ids[0] } })).status).toBe(200);
  await sleep(400);
  expect(frames()).toEqual(base);
  // Nothing at all arrived on the wire, not even a comment, bar heartbeats.
  for (const [i, st] of [anon, joined].entries()) {
    const added = st.raw.slice(rawBase[i]);
    expect(added.replaceAll(": heartbeat\n\n", "")).toBe("");
  }
  // The last pick moves the phase, and that frame does arrive.
  expect((await d.s.call(at(g.code, "pick"), { body: { trackId: d.ids[0] } })).status).toBe(200);
  expect(await anon.next((e) => e.event === "state" && e.data.game?.phase === "listen", 3000)).not.toBeNull();
  anon.close();
  joined.close();
});

it("moves on early once everyone alive has picked, then names every pick with its lender", async () => {
  const g = await started(4, { pickSeconds: 60 }); // only an early finish gets there in time
  const [a, b, c, d] = g.players;
  // b borrows one of a's songs; the rest pick their own.
  expect((await b.s.call(at(g.code, "pick"), { body: { trackId: a.ids[3], from: a.name } })).status).toBe(200);
  await pickOwn(g.code, [a, c, d]);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 5000);
  const cards = (await state(g.code)).game!.cards!;
  expect(cards.map((x) => x.order).sort()).toEqual([0, 1, 2, 3]);
  expect(cards.map((x) => x.picker).sort()).toEqual(g.players.map((p) => p.name).sort());
  const borrowed = cards.find((x) => x.picker === b.name)!;
  expect(borrowed).toMatchObject({ lender: a.name, trackId: a.ids[3] });
  expect(borrowed.title).toBeTruthy();
  expect(cards.filter((x) => x.lender)).toHaveLength(1);
  const own = cards.find((x) => x.picker === c.name)!;
  expect(own.lender).toBeUndefined();
  expect(own.trackId).toBe(c.ids[0]);
  const url = (await (await g.players[1].s.call(`/api/tables/${g.code}/cards/0/audio`)).json()) as { url: string };
  expect(url.url).toMatch(/^https:\/\//);
  // The anonymous route and the card route for a stranger are closed.
  expect((await session().call(`/api/tables/${g.code}/cards/0/audio`)).status).toBe(401);
});

it("lists who missed the pick as dead air, who can still vote, and doesn't count a late pick", async () => {
  const g = await started(4, { pickSeconds: 4, voteSeconds: 60 });
  const [missed, ...pickers] = g.players;
  await pickOwn(g.code, pickers);
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  const late = await missed.s.call(at(g.code, "pick"), { body: { trackId: missed.ids[0] } });
  expect(late.status).toBe(409);
  const game = (await state(g.code)).game!;
  expect(game.deadAir).toEqual([missed.name]);
  expect(game.cards).toHaveLength(3);
  await toVote(g);
  expect((await state(g.code)).game!.deadAir).toEqual([missed.name]);
  // Dead air votes, and everyone voting starts the last call, long before the 60 s deadline.
  await voteFor(g.code, g.players, "skip");
  expect((await state(g.code)).game!.lastCall).toBe(true);
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  expect((await state(g.code)).game!.reveal!.deadAir).toEqual([missed.name]);
});

it("takes own-crate picks, refuses a foreign track with no `from`, and lets spectators nowhere near", async () => {
  const g = await started(3);
  const [p0, p1] = g.players;
  const foreign = await p0.s.call(at(g.code, "pick"), { body: { trackId: p1.ids[0] } });
  expect(foreign.status).toBe(403);
  expect(((await foreign.json()) as { error: string }).error).toBe("Pick from your crate.");
  expect((await me(p0, g.code)).picked).toBe(false);
  expect((await p0.s.call(at(g.code, "pick"), { body: { trackId: p0.ids[0] } })).status).toBe(200);
  expect((await me(p0, g.code)).picked).toBe(true);
  expect((await p0.s.call(at(g.code, "pick"), { body: { trackId: p0.ids[1] } })).status).toBe(409);
  const late = await player("late", 6);
  await late.s.call(at(g.code, "join"), { body: {} });
  expect((await me(late, g.code)).role).toBe("spectator");
  expect((await late.s.call(at(g.code, "pick"), { body: { trackId: late.ids[0] } })).status).toBe(403);
  expect((await late.s.call(at(g.code, "vote"), { body: { skip: true } })).status).toBe(403);
});

it("allows one borrow per game, none from yourself, none twice, and no song twice in a game", async () => {
  const g = await started(4);
  const [a, b, c, d] = g.players;
  const pick = (p: Player, body: unknown) => p.s.call(at(g.code, "pick"), { body });
  // From yourself, or from nobody, or a song that isn't theirs.
  expect([400, 403]).toContain((await pick(a, { trackId: a.ids[0], from: a.name })).status);
  expect((await pick(a, { trackId: b.ids[0], from: "nobody-here" })).status).toBe(404);
  expect((await pick(a, { trackId: c.ids[0], from: b.name })).status).toBe(403);
  expect((await me(a, g.code)).picked).toBe(false);
  // Round 1: a borrows b's first song; everyone else picks their own (b a different one).
  expect((await pick(a, { trackId: b.ids[0], from: b.name })).status).toBe(200);
  expect(await me(a, g.code)).toMatchObject({ picked: true, borrowUsed: true });
  for (const [p, i] of [[b, 1], [c, 0], [d, 0]] as const) expect((await pick(p, { trackId: p.ids[i] })).status).toBe(200);
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  await toVote(g);
  await voteFor(g.code, g.players, "skip");
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  await nextRound(g, 2);
  expect((await me(c, g.code)).played).toContain(b.ids[0]);
  // Round 2: the song that was played in round 1 can't be picked by its owner or borrowed again.
  expect((await pick(b, { trackId: b.ids[0] })).status).toBe(409);
  expect(((await (await pick(c, { trackId: b.ids[0], from: b.name })).json()) as { error: string }).error).toBe("Already played this game.");
  // a's borrow is spent.
  expect((await pick(a, { trackId: c.ids[2], from: c.name })).status).toBe(403);
  // c still has theirs, and a song that was never played works.
  expect((await pick(c, { trackId: d.ids[2], from: d.name })).status).toBe(200);
  expect((await me(c, g.code)).borrowUsed).toBe(true);
});

it("lets a ghost watch: no pick, no vote, and their crate can still be borrowed from", async () => {
  const g = await started(5, { pickSeconds: 30, voteSeconds: 30 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const target = g.others[0];
  await voteFor(g.code, g.players, target.name);
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  const s1 = await state(g.code);
  expect(s1.game!.ghosts).toEqual([target.name]);
  await nextRound(g, 2);
  expect((await me(target, g.code)).role).toBe("ghost");
  expect((await target.s.call(at(g.code, "pick"), { body: { trackId: target.ids[1] } })).status).toBe(403);
  // Someone else borrows from the ghost's crate.
  const borrower = g.players.find((p) => p !== target)!;
  expect((await borrower.s.call(at(g.code, "pick"), { body: { trackId: target.ids[1], from: target.name } })).status).toBe(200);
  const alive = g.players.filter((p) => p !== target && p !== borrower);
  for (const p of alive) await p.s.call(at(g.code, "pick"), { body: { trackId: p.ids[1] } });
  await toVote(g);
  expect((await target.s.call(at(g.code, "vote"), { body: { skip: true } })).status).toBe(403);
  // Nobody can vote for someone who is out.
  expect((await alive[0].s.call(at(g.code, "vote"), { body: { name: target.name } })).status).toBe(400);
  const cards = (await state(g.code)).game!.cards!;
  expect(cards.map((c) => c.picker)).not.toContain(target.name);
  expect(cards.find((c) => c.picker === borrower.name)!.lender).toBe(target.name);
});

// ---- voting ----

it("lets a vote change until it locks, shows counts by name never by voter, and a tie ejects nobody", async () => {
  const g = await started(4, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const [a, b, c, d] = g.players;
  const vote = (p: Player, body: unknown) => p.s.call(at(g.code, "vote"), { body });
  expect((await vote(a, { name: b.name })).status).toBe(200);
  expect(await me(a, g.code)).toMatchObject({ vote: { name: b.name } });
  expect((await vote(a, { name: c.name })).status).toBe(200); // changed: allowed
  expect((await me(a, g.code)).vote).toEqual({ name: c.name });
  const mid = (await state(g.code)).game!;
  expect(mid.tally!.map((t) => t.name).sort()).toEqual(g.players.map((p) => p.name).sort());
  expect(Object.fromEntries(mid.tally!.map((t) => [t.name, t.votes]))).toEqual({ [a.name]: 0, [b.name]: 0, [c.name]: 1, [d.name]: 0 });
  expect(JSON.stringify(mid)).not.toMatch(/"voter"/);
  expect(mid.lastCall).toBeUndefined();
  expect((await vote(b, { name: "nobody-here" })).status).toBe(400);
  expect((await vote(b, {})).status).toBe(400);
  await vote(b, { name: a.name });
  await vote(c, { name: a.name });
  await vote(d, { name: c.name });
  // a: 2 (b, c), c: 2 (a's changed vote, d): a tie, nobody ejected.
  const last = (await state(g.code)).game!;
  expect(last.lastCall).toBe(true);
  expect(last.tally!.map((t) => t.votes).sort()).toEqual([0, 0, 2, 2]);
  const s = await waitFor(g.code, (x) => x.game?.phase === "reveal", 9000);
  expect(s.game!.reveal!.ejected).toBeNull();
  expect(s.game!.reveal!.accused).toBeNull();
  expect(s.game!.ghosts).toEqual([]);
});

it("counts skip as a vote that ejects nobody when it leads, and a changed mind during last call", async () => {
  const g = await started(4, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const [a, b, c, d] = g.players;
  const vote = (p: Player, body: unknown) => p.s.call(at(g.code, "vote"), { body });
  await vote(a, { name: b.name });
  await vote(b, { skip: true });
  await vote(c, { skip: true });
  await vote(d, { name: b.name });
  expect((await state(g.code)).game!.skips).toBe(2);
  // Last call is running; a changes their mind to skip: skip now leads 3 to 1.
  expect((await vote(a, { skip: true })).status).toBe(200);
  const s = await waitFor(g.code, (x) => x.game?.phase === "reveal", 9000);
  expect(s.game!.reveal!.ejected).toBeNull();
  expect(s.game!.reveal!.votes.filter((v) => v.choice === null)).toHaveLength(3);
});

// ---- steal ----

it("gives only the voted-out mole four prompts of the slot, and a right guess wins the game for the moles", async () => {
  const g = await started(4, { voteSeconds: 15 });
  const mole = g.moles[0];
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, mole.name);
  const s = await waitFor(g.code, (x) => x.game?.phase === "steal", 9000);
  // Public: who, and nothing else.
  expect(s.game!.accused).toBe(mole.name);
  const pubText = JSON.stringify(s);
  expect(promptsIn(pubText)).toEqual([]);
  expect(pubText).not.toMatch(/options|promptId/);
  for (const p of g.others) {
    expect((await me(p, g.code)).steal).toBeUndefined();
    expect((await p.s.call(at(g.code, "steal"), { body: { promptId: "up-01" } })).status).toBe(403);
  }
  const { options, real } = await stealOptions(g, mole);
  expect(options).toHaveLength(4);
  const slot = PROMPTS.find((p) => p.text === g.prompt)!.slot;
  for (const o of options) expect(PROMPTS.find((p) => p.id === o.id)).toMatchObject({ slot, text: o.text });
  expect(new Set(options.map((o) => o.id)).size).toBe(4);
  expect((await mole.s.call(at(g.code, "steal"), { body: { promptId: "not-a-prompt" } })).status).toBe(400);
  expect((await mole.s.call(at(g.code, "steal"), { body: { promptId: real.id } })).status).toBe(200);
  expect((await mole.s.call(at(g.code, "steal"), { body: { promptId: real.id } })).status).toBe(409);

  const r = await waitFor(g.code, (x) => x.status === "finished");
  expect(r.game!.winner).toBe("moles");
  expect(r.game!.moles).toEqual([mole.name]);
  expect(r.game!.reveal).toMatchObject({ accused: mole.name, ejected: null, wasMole: true, stole: true, prompt: g.prompt });
  expect(r.game!.alive).toContain(mole.name);
  expect(r.game!.ghosts).toEqual([]);
  expect(r.game!.deadline).toBeNull();
  expect(r.game!.past.at(-1)).toMatchObject({ round: 1, prompt: g.prompt, ejected: null, wasMole: true });
  expect((await me(mole, g.code)).steal).toBeUndefined();
});

it("refuses picks, votes and advance during a steal, and a second guess", async () => {
  const g = await started(4, { voteSeconds: 15 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, g.moles[0].name);
  await waitFor(g.code, (x) => x.game?.phase === "steal", 9000);
  for (const p of g.players) {
    expect((await p.s.call(at(g.code, "pick"), { body: { trackId: p.ids[5] } })).status).toBe(409);
    expect((await p.s.call(at(g.code, "vote"), { body: { skip: true } })).status).toBe(409);
  }
  expect((await g.host.s.call(at(g.code, "advance"), { body: {} })).status).toBe(409);
  expect((await state(g.code)).game!.phase).toBe("steal");
});

it("names a mole who leaves during the steal: a missed steal, ejected, and the game-over lists them", async () => {
  const g = await started(4, { voteSeconds: 15 });
  const mole = g.moles[0];
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, mole.name);
  await waitFor(g.code, (x) => x.game?.phase === "steal", 9000);
  expect((await mole.s.call(at(g.code, "leave"), { body: {} })).status).toBeLessThan(300);
  const end = await waitFor(g.code, (x) => x.status === "finished");
  expect(end.game!.winner).toBe("players");
  expect(end.game!.moles).toEqual([mole.name]);
  expect(end.game!.reveal).toMatchObject({ accused: mole.name, ejected: mole.name, wasMole: true, stole: false, prompt: g.prompt });
  expect(end.game!.reveal!.votes).toHaveLength(4);
  expect(end.game!.past.at(-1)).toMatchObject({ ejected: mole.name, wasMole: true });
});

it("names a mole who leaves while picking at game over, without logging or showing that round's picks", async () => {
  const g = await started(4, { pickSeconds: 60 });
  await pickOwn(g.code, g.others.slice(0, 1));
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  const end = await waitFor(g.code, (x) => x.status === "finished");
  expect(end.game!.winner).toBe("players");
  expect(end.game!.moles).toEqual([g.moles[0].name]);
  expect(end.game!.alive).not.toContain(g.moles[0].name);
  // The round was never closed, so the one pick made stays hidden.
  expect(end.game!.reveal!.cards).toEqual([]);
  expect(end.game!.past.at(-1)!.cards).toEqual([]);
  expect(end.game!.played).toEqual([]);
});

it("names a ghost who left later, too, among the moles at game over", async () => {
  const g = await started(6, { pickSeconds: 30, voteSeconds: 30 });
  const [m1, m2] = g.moles;
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, m1.name);
  await waitFor(g.code, (x) => x.game?.phase === "steal", 9000);
  const { wrong } = await stealOptions(g, m1);
  await m1.s.call(at(g.code, "steal"), { body: { promptId: wrong.id } });
  await waitFor(g.code, (x) => x.game?.phase === "reveal");
  await m1.s.call(at(g.code, "leave"), { body: {} });
  await m2.s.call(at(g.code, "leave"), { body: {} });
  const end = await waitFor(g.code, (x) => x.status === "finished");
  expect(end.game!.winner).toBe("players");
  expect(end.game!.moles).toEqual([m1.name, m2.name].sort());
});

it("ejects a mole who guesses wrong, and one who runs out of time", async () => {
  const wrong = await started(4);
  await pickOwn(wrong.code, wrong.players);
  await toVote(wrong);
  await ejectMole(wrong, wrong.players);
  const w = (await state(wrong.code)).game!;
  expect(w.reveal).toMatchObject({ ejected: wrong.moles[0].name, wasMole: true, stole: false, prompt: wrong.prompt });
  expect(w.winner).toBe("players");

  const slow = await started(3);
  await pickOwn(slow.code, slow.players);
  await toVote(slow);
  await voteFor(slow.code, slow.players, slow.moles[0].name);
  const s = await waitFor(slow.code, (x) => x.game?.phase === "steal", 9000);
  expect(s.game!.deadline! - Date.now()).toBeLessThanOrEqual(15_000);
  // No guess: after the clock the mole is out as the vote said.
  const done = await waitFor(slow.code, (x) => x.status === "finished", 20_000);
  expect(done.game!.reveal).toMatchObject({ ejected: slow.moles[0].name, wasMole: true, stole: false });
  const late = await slow.moles[0].s.call(at(slow.code, "steal"), { body: { promptId: "up-01" } });
  expect(late.status).toBe(409);
});

// ---- the prompt cycle, the reveal and the end ----

it("cycles the prompt through all four slots before repeating, never repeating a prompt", async () => {
  const g = await started(4, { pickSeconds: 30, voteSeconds: 30 });
  const slots: string[] = [];
  const prompts: string[] = [];
  for (let round = 1; round <= 4; round++) {
    if (round > 1) await nextRound(g, round);
    const v = await me(g.others[0], g.code);
    slots.push(v.slot!);
    prompts.push(v.prompt!);
    expect((await me(g.moles[0], g.code)).slot).toBe(v.slot);
    await pickOwn(g.code, g.players, round);
    await toVote(g);
    await voteFor(g.code, g.players, "skip");
    await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  }
  expect([...slots].sort()).toEqual([...SLOT_NAMES].sort());
  expect(new Set(prompts).size).toBe(4);
  for (const [i, text] of prompts.entries()) expect(PROMPTS.find((p) => p.text === text)!.slot).toBe(slots[i]);
  // Ending it now shows every round's prompt.
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.prompts!.map((p) => p.prompt)).toEqual(prompts);
  expect(end.game!.prompts!.map((p) => p.slot)).toEqual(slots);
});

it("reveals the prompt, every pick with its picker and lender, the votes by name, and who was out", async () => {
  const g = await started(4, { voteSeconds: 60 });
  const [a, b, c, d] = g.players;
  expect((await b.s.call(at(g.code, "pick"), { body: { trackId: a.ids[4], from: a.name } })).status).toBe(200);
  await pickOwn(g.code, [a, c, d]);
  await toVote(g);
  // Vote out a non-mole so the game goes on.
  const victim = g.others[0];
  await voteFor(g.code, g.players, victim.name);
  const s = await waitFor(g.code, (x) => x.game?.phase === "reveal", 9000);
  const r = s.game!.reveal!;
  expect(r.prompt).toBe(g.prompt);
  expect(r.slot).toBe(PROMPTS.find((p) => p.text === g.prompt)!.slot);
  expect(r.cards.map((x) => x.picker).sort()).toEqual(g.players.map((p) => p.name).sort());
  expect(r.cards.find((x) => x.picker === b.name)).toMatchObject({ lender: a.name, trackId: a.ids[4] });
  expect(r.votes.map((v) => v.voter).sort()).toEqual(g.players.map((p) => p.name).sort());
  // Everyone but the victim voted for them; the victim couldn't, so skipped.
  expect(r.votes.filter((v) => v.choice === victim.name)).toHaveLength(3);
  expect(r.votes.find((v) => v.voter === victim.name)!.choice).toBeNull();
  expect(r).toMatchObject({ ejected: victim.name, accused: victim.name, wasMole: false, stole: false, deadAir: [] });
  expect(s.game!.ghosts).toEqual([victim.name]);
  expect(s.game!.winner).toBeUndefined();
});

it("ends with the winner, the moles and every round's prompt; moles win at parity", async () => {
  const g = await started(4);
  const [innocent, ...rest] = g.others;
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, innocent.name);
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  await nextRound(g, 2);
  const second = (await me(rest[0], g.code)).prompt!;
  expect(second).not.toBe(g.prompt);
  await pickOwn(g.code, [g.moles[0], ...rest], 2);
  await toVote(g);
  // One more innocent out leaves one mole against one player: parity.
  await voteFor(g.code, [g.moles[0], ...rest], rest[0].name);
  const end = await waitFor(g.code, (s) => s.status === "finished", 9000);
  expect(end.game!.winner).toBe("moles");
  expect(end.game!.moles).toEqual([g.moles[0].name]);
  expect(end.game!.prompts!.map((p) => p.prompt)).toEqual([g.prompt, second]);
  // After the game, anyone can see the prompt.
  expect((await me(g.moles[0], g.code)).role).toBe("mole");
});

it("carries on when someone leaves if the game still works, and ends when the mole leaves", async () => {
  const g = await started(4);
  const leaver = g.others.find((p) => p !== g.host)!;
  await leaver.s.call(at(g.code, "leave"), { body: {} });
  const s = await waitFor(g.code, (s) => !s.game!.alive.includes(leaver.name));
  expect(s.status).toBe("playing");
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.winner).toBe("players");
});

// Playtest 1: in a second game at the same table only the mole could pick. The
// server is the record of who has picked, and a new game starts at round 1 again.
it("lets everyone pick again in a second game at the same table, with every song playable again", async () => {
  const g = await started(3);
  await pickOwn(g.code, g.players);
  await toVote(g);
  await ejectMole(g, g.players);

  expect((await g.host.s.call(at(g.code, "start"), { body: {} })).status).toBeLessThan(300);
  await waitFor(g.code, (s) => s.status === "playing" && s.game?.round === 1 && s.game?.phase === "pick");
  for (const p of g.players) expect(await me(p, g.code)).toMatchObject({ picked: false, played: [] });
  await pickOwn(g.code, g.players);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 5000);
});

// ---- same-round clashes, history, reveal timing (review fixes) ----

it("lets two picks of one song in the same round both play, marked as a clash, and refuses it afterwards", async () => {
  const g = await started(4, { pickSeconds: 60 });
  const [a, b, c, d] = g.players;
  // b borrows a's first song while a plays it from their own crate: neither is refused.
  expect((await b.s.call(at(g.code, "pick"), { body: { trackId: a.ids[0], from: a.name } })).status).toBe(200);
  expect((await a.s.call(at(g.code, "pick"), { body: { trackId: a.ids[0] } })).status).toBe(200);
  await pickOwn(g.code, [c, d]);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 5000);
  const cards = (await state(g.code)).game!.cards!;
  const same = cards.filter((x) => x.trackId === a.ids[0]);
  expect(same.map((x) => x.picker).sort()).toEqual([a.name, b.name].sort());
  expect(same.every((x) => x.clash === true)).toBe(true);
  expect(cards.filter((x) => x.trackId !== a.ids[0]).every((x) => x.clash === undefined)).toBe(true);
  await toVote(g);
  await voteFor(g.code, g.players, "skip");
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  expect((await state(g.code)).game!.reveal!.cards.filter((x) => x.clash)).toHaveLength(2);
  await nextRound(g, 2);
  // Heard in an earlier round now: refused, for the owner and as a borrow.
  expect((await a.s.call(at(g.code, "pick"), { body: { trackId: a.ids[0] } })).status).toBe(409);
  expect((await c.s.call(at(g.code, "pick"), { body: { trackId: a.ids[0], from: a.name } })).status).toBe(409);
  expect((await me(c, g.code)).played).toContain(a.ids[0]);
});

it("keeps every finished round, who has borrowed and what was heard, and never the round in play", async () => {
  const g = await started(4, { pickSeconds: 60, voteSeconds: 15 });
  const [a, b, c, d] = g.players;
  const game = async () => (await state(g.code)).game!;
  expect(await game()).toMatchObject({ past: [], borrowed: [], played: [] });
  // Round 1: b borrows. Mid-pick nothing of it shows.
  expect((await b.s.call(at(g.code, "pick"), { body: { trackId: a.ids[3], from: a.name } })).status).toBe(200);
  expect(await game()).toMatchObject({ past: [], borrowed: [], played: [] });
  await pickOwn(g.code, [a, c, d]);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 5000);
  expect(await game()).toMatchObject({ past: [], borrowed: [b.name] });
  expect((await game()).played.sort()).toEqual([a.ids[3], a.ids[0], c.ids[0], d.ids[0]].sort());
  await toVote(g);
  expect((await game()).past).toEqual([]);
  await voteFor(g.code, g.players, "skip");
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 9000);
  const r1 = await game();
  expect(r1.past).toHaveLength(1);
  expect(r1.past[0]).toMatchObject({ round: 1, prompt: g.prompt, ejected: null, wasMole: false });
  expect(r1.past[0].cards).toHaveLength(4);
  expect(r1.past[0].cards).toEqual(r1.reveal!.cards);
  // Round 2: round 1 is in the past, round 2 is not, in every phase until its reveal.
  await nextRound(g, 2);
  expect((await game()).past.map((p) => p.round)).toEqual([1]);
  expect((await game()).borrowed).toEqual([b.name]);
  await pickOwn(g.code, g.players, 2);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 5000);
  expect((await game()).past.map((p) => p.round)).toEqual([1]);
  await toVote(g);
  expect((await game()).past.map((p) => p.round)).toEqual([1]);
  await voteFor(g.code, g.players, g.moles[0].name);
  await waitFor(g.code, (s) => s.game?.phase === "steal", 9000);
  const steal = await game();
  expect(steal.past.map((p) => p.round)).toEqual([1]);
  // Only round 1's prompt (revealed) is anywhere in it; round 2's is not.
  expect(promptsIn(JSON.stringify(steal))).toEqual([PROMPTS.find((x) => x.text === g.prompt)!.id]);
  // Round 2's prompt, as a non-mole sees it: the steal's wrong option is anything else.
  const second = (await me(g.others[0], g.code)).prompt!;
  const wrong = (await me(g.moles[0], g.code)).steal!.options.find((o) => o.text !== second)!;
  await g.moles[0].s.call(at(g.code, "steal"), { body: { promptId: wrong.id } });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  // Game over: every round is in the past, with the ejected mole on the last.
  expect(end.game!.past.map((p) => p.round)).toEqual([1, 2]);
  expect(end.game!.past[1]).toMatchObject({ ejected: g.moles[0].name, wasMole: true });
  expect(end.game!.past[1].cards).toHaveLength(4);
  expect(end.game!.prompts!.map((p) => p.prompt)).toEqual(end.game!.past.map((p) => p.prompt));
});

it("refuses a vote for yourself", async () => {
  const g = await started(3);
  await pickOwn(g.code, g.players);
  await toVote(g);
  const res = await g.players[0].s.call(at(g.code, "vote"), { body: { name: g.players[0].name } });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/yourself/);
  expect((await me(g.players[0], g.code)).vote).toBeUndefined();
});

it("gives a spectator no slot, and nothing about the round", async () => {
  const g = await started(3);
  const late = await player("spec", 5);
  await late.s.call(at(g.code, "join"), { body: {} });
  const v = await me(late, g.code);
  expect(v.role).toBe("spectator");
  expect(v.slot).toBeUndefined();
  expect(v.prompt).toBeUndefined();
});

it("passes the host on when the host leaves mid-game, and the game carries on", async () => {
  const g = await started(6, { pickSeconds: 60 });
  const [host, next, ...rest] = g.players;
  expect((await state(g.code) as State & { host: string }).host).toBe(host.name);
  expect((await host.s.call(at(g.code, "leave"), { body: {} })).status).toBeLessThan(300);
  const s = await waitFor(g.code, (x) => (x as State & { host: string }).host === next.name);
  expect(s.status).toBe("playing");
  expect(s.game!.alive).not.toContain(host.name);
  await pickOwn(g.code, [next, ...rest]);
  await waitFor(g.code, (x) => x.game?.phase === "listen", 5000);
  expect((await host.s.call(at(g.code, "advance"), { body: {} })).status).toBe(403);
  expect((await next.s.call(at(g.code, "advance"), { body: {} })).status).toBe(200);
  await waitFor(g.code, (x) => x.game?.phase === "vote");
});

it("cycles all four slots in every block of four rounds over eight rounds", async () => {
  const g = await started(4, { voteSeconds: 2 });
  const slots: string[] = [];
  const prompts: string[] = [];
  for (let round = 1; round <= 8; round++) {
    if (round > 1) await nextRound(g, round);
    const v = await me(g.others[0], g.code);
    slots.push(v.slot!);
    prompts.push(v.prompt!);
    await pickOwn(g.code, g.players, round);
    await toVote(g);
    // Nobody votes: the 2 s vote ends with nobody ejected.
    await waitFor(g.code, (s) => s.game?.phase === "reveal", 6000);
  }
  expect([...slots.slice(0, 4)].sort()).toEqual([...SLOT_NAMES].sort());
  expect([...slots.slice(4)].sort()).toEqual([...SLOT_NAMES].sort());
  expect(slots.slice(4)).toEqual(slots.slice(0, 4));
  expect(new Set(prompts).size).toBe(8);
});

it("steal decoys are never a prompt used earlier in the game", async () => {
  // Several games at once, each taken to round 5 (the first repeat of a slot),
  // where a decoy drawn from every prompt in the slot would sometimes be round 1's.
  // Four players: with three left a no-eject vote would end the game.
  const trio = await Promise.all([0, 1, 2, 3].map((i) => player("dc", i)));
  const run = async () => {
    const [host, ...others] = trio;
    const { code } = (await (await host.s.call("/api/tables", { body: { voteSeconds: 2 } })).json()) as { code: string };
    for (const p of others) await p.s.call(at(code, "join"), { body: {} });
    expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
    await waitFor(code, (s) => s.game?.phase === "pick");
    const views = await Promise.all(trio.map((p) => me(p, code)));
    const moleAt = views.findIndex((v) => v.role === "mole");
    const nonMole = trio[views.findIndex((v) => v.role === "player")];
    const used: string[] = [];
    for (let round = 1; round <= 5; round++) {
      if (round > 1) {
        await host.s.call(at(code, "advance"), { body: {} });
        await waitFor(code, (s) => s.game?.round === round && s.game?.phase === "pick");
      }
      used.push((await me(nonMole, code)).prompt!);
      await pickOwn(code, trio, round);
      await waitFor(code, (s) => s.game?.phase === "listen");
      await host.s.call(at(code, "advance"), { body: {} });
      await waitFor(code, (s) => s.game?.phase === "vote");
      if (round < 5) {
        await waitFor(code, (s) => s.game?.phase === "reveal", 6000);
      } else {
        await voteFor(code, trio, trio[moleAt].name);
      }
    }
    await waitFor(code, (s) => s.game?.phase === "steal", 9000);
    const options = (await me(trio[moleAt], code)).steal!.options.map((o) => o.text);
    expect(options).toHaveLength(4);
    for (const earlier of used.slice(0, 4)) expect(options, "a decoy was an earlier round's prompt").not.toContain(earlier);
  };
  await Promise.all(Array.from({ length: 12 }, run));
}, 120_000);

it("moves the reveal on by itself after 30 seconds, and a game-over reveal has no deadline", async () => {
  const g = await started(4, { voteSeconds: 2 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const r = await waitFor(g.code, (s) => s.game?.phase === "reveal", 6000);
  const left = r.game!.deadline! - Date.now();
  expect(left).toBeGreaterThan(24_000);
  expect(left).toBeLessThanOrEqual(30_000);
  // Nobody touches it: the next round opens after the deadline.
  const next = await waitFor(g.code, (s) => s.game?.round === 2 && s.game?.phase === "pick", 35_000);
  expect(next.game!.deadline).not.toBeNull();
  await g.moles[0].s.call(at(g.code, "leave"), { body: {} });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.deadline).toBeNull();
}, 120_000);

// ---- every game ends ----

it("ends in a moles win when a vote with three left ejects nobody: a tie", async () => {
  const g = await started(3, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const [a, b, c] = g.players;
  const vote = (p: Player, name: string) => p.s.call(at(g.code, "vote"), { body: { name } });
  await vote(a, b.name);
  await vote(b, c.name);
  await vote(c, a.name); // 1-1-1
  const end = await waitFor(g.code, (s) => s.status === "finished", 12_000);
  expect(end.game).toMatchObject({ winner: "moles", ending: "final-vote", round: 1, phase: "reveal", deadline: null });
  expect(end.game!.reveal!.ejected).toBeNull();
  expect(end.game!.reveal!.prompt).toBeTruthy();
  expect(end.game!.reveal!.cards.length).toBe(3);
  expect(end.game!.moles).toEqual(g.moles.map((m) => m.name));
  expect(end.game!.ghosts).toEqual([]);
});

it("ends in a moles win when skip tops a vote with three left", async () => {
  const g = await started(3, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  const [a, b, c] = g.players;
  await voteFor(g.code, [a, b], "skip");
  await c.s.call(at(g.code, "vote"), { body: { name: a.name } });
  const end = await waitFor(g.code, (s) => s.status === "finished", 12_000);
  expect(end.game).toMatchObject({ winner: "moles", ending: "final-vote" });
});

it("still lets a vote with three left eject someone and carry on (a tie with four is not the last chance)", async () => {
  const g = await started(4, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, "skip");
  const s = await waitFor(g.code, (x) => x.game?.phase === "reveal", 12_000);
  expect(s.game!.winner).toBeUndefined();
  expect(s.status).toBe("playing");
});

it("gives the moles the game if they are still in after round 12's reveal", async () => {
  const g = await started(4, { pickSeconds: 15, voteSeconds: 2 });
  for (let round = 1; round <= 12; round++) {
    await pickOwn(g.code, g.players, round);
    await waitFor(g.code, (s) => s.game?.round === round && s.game?.phase === "listen");
    await g.host.s.call(at(g.code, "advance"), { body: {} });
    // Nobody votes: the vote runs out and nobody is ejected.
    const s = await waitFor(g.code, (x) => x.game?.phase === "reveal" && x.game.round === round, 9000);
    if (round < 12) {
      expect(s.game!.winner).toBeUndefined();
      await nextRound(g, round + 1);
    } else {
      expect(s.game).toMatchObject({ winner: "moles", ending: "round-cap", round: 12, deadline: null });
      expect(s.status).toBe("finished");
      expect(s.game!.prompts!.length).toBe(12);
    }
  }
}, 150_000);

it("abandons a game nobody picks in: no winner, the table back in the lobby, crates unlocked", async () => {
  const g = await started(3, { pickSeconds: 2 });
  const p = g.players[1];
  const taste = (await (await p.s.call("/api/taste")).json()) as { id: number }[];
  expect((await p.s.call(`/api/taste/${taste[0].id}`, { method: "DELETE" })).status).toBe(409);
  const end = await waitFor(g.code, (s) => s.game?.winner === "none", 8000);
  expect(end.status).toBe("open");
  expect(end.game).toMatchObject({ winner: "none", ending: "nobody-picked" });
  expect(end.game!.moles).toBeUndefined();
  expect(end.members.length).toBe(3);
  // Crates open again, and the same table can start again.
  expect((await p.s.call(`/api/taste/${taste[0].id}`, { method: "DELETE" })).status).toBeLessThan(300);
  expect((await p.s.call("/api/taste", { body: { trackId: taste[0].id, slot: "up" } })).status).toBe(201);
  expect((await g.host.s.call(at(g.code, "start"), { body: {} })).status).toBeLessThan(300);
  // History shows it as a game with no winner.
  const hist = (await (await p.s.call("/api/history")).json()) as { code: string; winner: string; ending?: string }[];
  expect(hist.find((h) => h.code === g.code)).toMatchObject({ winner: "none", ending: "nobody-picked" });
});

it("clears the steal options once the steal is over", async () => {
  const g = await started(5, { voteSeconds: 60 });
  await pickOwn(g.code, g.players);
  await toVote(g);
  await voteFor(g.code, g.players, g.moles[0].name);
  await waitFor(g.code, (s) => s.game?.phase === "steal", 9000);
  expect((await me(g.moles[0], g.code)).steal?.options.length).toBe(4);
  const { wrong } = await stealOptions(g, g.moles[0]);
  await g.moles[0].s.call(at(g.code, "steal"), { body: { promptId: wrong.id } });
  await waitFor(g.code, (s) => s.game?.phase === "reveal");
  const after = await me(g.moles[0], g.code);
  expect(after.role).toBe("ghost");
  expect(after.steal).toBeUndefined();
  expect(textOf(after)).not.toContain(wrong.text);
});
