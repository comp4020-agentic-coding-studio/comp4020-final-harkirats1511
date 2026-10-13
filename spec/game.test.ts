import { expect, it, vi } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract for a game at a table (CLAUDE.md has the rules these hold):
//   POST /api/tables {pickSeconds?, voteSeconds?, speaker?} -> {code}
//        durations default to 60/45; specs use short ones
//   POST /api/tables/:code/start            host, 3+ members -> game starts
//   GET  /api/tables/:code                   public state (same as the stream)
//   GET  /api/tables/:code/me                this person's private view:
//        {role: "player"|"ghost"|"spectator", theme?, picked?}. A mole's role reads
//        "player" like everyone else's: nobody is told they are the mole
//   POST /api/tables/:code/pick {trackId}    during pick
//   GET  /api/tables/:code/round             anonymous slots while listening/voting
//   GET  /api/tables/:code/round/slots/:n/audio -> {url}
//   POST /api/tables/:code/vote {name|"skip"} during vote; final once cast
//   POST /api/tables/:code/advance           host: listen -> vote, reveal -> next round
//   POST /api/tables/:code/leave
// Public state carries game: {round, phase, deadline, alive, ghosts, reveal?, winner?,
// themes?}; themes is every round's {majority, mole} pair, only once the game ends.

vi.setConfig({ testTimeout: 90_000 });

type Session = ReturnType<typeof session>;
type Player = { s: Session; name: string };
type Game = {
  round: number;
  phase: "pick" | "listen" | "vote" | "reveal";
  deadline: number | null;
  alive: string[];
  ghosts: string[];
  reveal?: { ejected: string | null; wasMole: boolean; slots: { owner: string; title: string }[] };
  winner?: "players" | "moles";
  themes?: { round: number; majority: string; mole: string }[];
};
type State = { status: string; members: string[]; game?: Game };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function player(prefix: string): Promise<Player> {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "2580" } });
  return { s, name };
}

async function state(code: string): Promise<State> {
  return (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as State;
}

async function waitFor(code: string, ok: (s: State) => boolean, ms = 8000): Promise<State> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await state(code);
    if (ok(s)) return s;
    if (Date.now() > until) throw new Error(`state never matched: ${JSON.stringify(s)}`);
    await sleep(150);
  }
}

async function me(p: Player, code: string) {
  return (await (await p.s.call(`/api/tables/${code}/me`)).json()) as {
    role: string;
    theme?: string;
    picked?: boolean;
  };
}

// Real catalogue ids for picks; one search, shared by every test.
let ids: number[] = [];
async function trackIds(s: Session): Promise<number[]> {
  if (!ids.length) {
    const found = (await (await s.call("/api/search?q=love")).json()) as { id: number }[];
    ids = found.map((t) => t.id);
  }
  return ids;
}

async function table(n: number, opts: Record<string, unknown> = {}) {
  const players = await Promise.all(Array.from({ length: n }, (_, i) => player(`p${i}`)));
  const [host] = players;
  const { code } = (await (
    await host.s.call("/api/tables", { body: { pickSeconds: 15, voteSeconds: 15, ...opts } })
  ).json()) as { code: string };
  for (const p of players.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await trackIds(host.s);
  return { code, host, players };
}

async function started(n: number, opts: Record<string, unknown> = {}) {
  const t = await table(n, opts);
  expect((await t.host.s.call(`/api/tables/${t.code}/start`, { body: {} })).status).toBeLessThan(300);
  await waitFor(t.code, (s) => s.game?.phase === "pick");
  const roles = new Map<string, Awaited<ReturnType<typeof me>>>();
  for (const p of t.players) roles.set(p.name, await me(p, t.code));
  // Nobody is told they're the mole, so the spec finds them the way the room
  // would if it could see every phone: the theme fewer people have.
  const count = new Map<string, number>();
  for (const r of roles.values()) count.set(r.theme!, (count.get(r.theme!) ?? 0) + 1);
  const odd = [...count.entries()].sort((x, y) => x[1] - y[1])[0][0];
  const moles = t.players.filter((p) => roles.get(p.name)!.theme === odd);
  const others = t.players.filter((p) => roles.get(p.name)!.theme !== odd);
  return { ...t, roles, moles, others };
}

async function pickAll(code: string, players: Player[]) {
  for (const [i, p] of players.entries()) {
    expect((await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: ids[i] } })).status).toBeLessThan(300);
  }
}

async function toVote(g: Awaited<ReturnType<typeof started>>) {
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  await g.host.s.call(`/api/tables/${g.code}/advance`, { body: {} });
  await waitFor(g.code, (s) => s.game?.phase === "vote");
}

it("gives one mole a different theme at a table of 4, and tells nobody who the mole is", async () => {
  const g = await started(4);
  expect(g.moles).toHaveLength(1);
  const moleTheme = g.roles.get(g.moles[0].name)!.theme!;
  const theme = g.roles.get(g.others[0].name)!.theme!;
  expect(moleTheme).toBeTruthy();
  expect(theme).toBeTruthy();
  expect(moleTheme).not.toBe(theme);
  for (const p of g.others) expect(g.roles.get(p.name)!.theme).toBe(theme);
  // Every phone looks the same: no role, field or wording gives the mole away.
  for (const p of g.players) {
    const view = g.roles.get(p.name)!;
    expect(view.role).toBe("player");
    expect(Object.keys(view).sort()).toEqual(["picked", "role", "theme"]);
  }
});

it("restores a reconnecting person's theme from the server", async () => {
  const g = await started(3);
  const mole = g.moles[0];
  const again = session();
  await again.call("/api/join", { body: { name: mole.name, pin: "2580" } });
  expect(await me({ s: again, name: mole.name }, g.code)).toEqual(g.roles.get(mole.name));
});

it("never shows roles, targets, or who has picked on the public state", async () => {
  const g = await started(4);
  const before = await state(g.code);
  await pickAll(g.code, g.players.slice(0, 2));
  const after = await state(g.code);
  expect(after).toEqual(before);
  const text = JSON.stringify(after);
  expect(text).not.toMatch(/"(role|roles|theme|themes|moles?|picked|owner)"\s*:/);
  for (const r of g.roles.values()) expect(text).not.toContain(r.theme!);
});

it("moves on early once everyone has picked, and the slots are anonymous", async () => {
  const g = await started(4, { pickSeconds: 60 });  // only an early finish gets there in time
  await pickAll(g.code, g.players);
  await waitFor(g.code, (s) => s.game?.phase === "listen", 2000);

  const res = await g.players[1].s.call(`/api/tables/${g.code}/round`);
  const text = await res.text();
  const { slots } = JSON.parse(text) as { slots: unknown[] };
  expect(slots).toHaveLength(4);
  for (const p of g.players) expect(text).not.toContain(p.name);

  const audio = (await (await g.players[1].s.call(`/api/tables/${g.code}/round/slots/0/audio`)).json()) as {
    url: string;
  };
  expect(audio.url).toMatch(/^https:\/\//);
});

it("doesn't count a pick that misses the deadline", async () => {
  const g = await started(3, { pickSeconds: 4 });
  await pickAll(g.code, g.players.slice(0, 2));
  await waitFor(g.code, (s) => s.game?.phase === "listen");
  const late = await g.players[2].s.call(`/api/tables/${g.code}/pick`, { body: { trackId: ids[5] } });
  expect(late.status).toBe(409);
  const { slots } = (await (await g.host.s.call(`/api/tables/${g.code}/round`)).json()) as { slots: unknown[] };
  expect(slots).toHaveLength(2);
});

it("ejects the most-voted, reveals every owner, and the players win when the mole goes", async () => {
  const g = await started(4);
  await pickAll(g.code, g.players);
  await toVote(g);
  const mole = g.moles[0].name;
  for (const p of g.players) await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: mole } });

  const s = await waitFor(g.code, (s) => s.game?.phase === "reveal" || s.status === "finished");
  expect(s.game!.reveal!.ejected).toBe(mole);
  expect(s.game!.reveal!.wasMole).toBe(true);
  expect(s.game!.reveal!.slots.map((x) => x.owner).sort()).toEqual(g.players.map((p) => p.name).sort());
  expect(s.game!.winner).toBe("players");
});

it("makes a final vote final, and a tie ejects nobody", async () => {
  const g = await started(4);
  await pickAll(g.code, g.players);
  await toVote(g);
  const [a, b, c, d] = g.players;
  await a.s.call(`/api/tables/${g.code}/vote`, { body: { name: b.name } });
  expect((await a.s.call(`/api/tables/${g.code}/vote`, { body: { name: c.name } })).status).toBe(409);
  await b.s.call(`/api/tables/${g.code}/vote`, { body: { name: a.name } });
  await c.s.call(`/api/tables/${g.code}/vote`, { body: { name: b.name } });
  await d.s.call(`/api/tables/${g.code}/vote`, { body: { name: a.name } });
  // a: 2, b: 2 -> a tie, nobody ejected
  const s = await waitFor(g.code, (s) => s.game?.phase === "reveal");
  expect(s.game!.reveal!.ejected).toBeNull();
});

it("turns a wrongly ejected player into a ghost: picks, doesn't vote; moles win at parity", async () => {
  const g = await started(4);
  const mole = g.moles[0];
  const [innocent, ...rest] = g.others;

  await pickAll(g.code, g.players);
  await toVote(g);
  for (const p of g.players) await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: innocent.name } });
  const s1 = await waitFor(g.code, (s) => s.game?.phase === "reveal");
  expect(s1.game!.reveal!.wasMole).toBe(false);
  expect(s1.game!.ghosts).toEqual([innocent.name]);

  await g.host.s.call(`/api/tables/${g.code}/advance`, { body: {} });
  await waitFor(g.code, (s) => s.game?.round === 2 && s.game?.phase === "pick");
  expect((await me(innocent, g.code)).role).toBe("ghost");
  await pickAll(g.code, g.players);

  await toVote(g);
  expect(
    (await innocent.s.call(`/api/tables/${g.code}/vote`, { body: { name: mole.name } })).status,
  ).toBe(403);
  // Vote out a second innocent: one mole against one player is parity.
  for (const p of [mole, ...rest]) await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: rest[0].name } });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.winner).toBe("moles");
});

it("lets someone who joins mid-game watch but not play", async () => {
  const g = await started(3);
  const late = await player("late");
  await late.s.call(`/api/tables/${g.code}/join`, { body: {} });
  expect((await me(late, g.code)).role).toBe("spectator");
  expect((await late.s.call(`/api/tables/${g.code}/pick`, { body: { trackId: ids[7] } })).status).toBe(403);
});

it("carries on when someone leaves if the game still works, and ends when the mole leaves", async () => {
  const g = await started(4);
  const leaver = g.others.find((p) => p !== g.host)!;
  await leaver.s.call(`/api/tables/${g.code}/leave`, { body: {} });
  const s = await waitFor(g.code, (s) => !s.game!.alive.includes(leaver.name));
  expect(s.status).toBe("playing");

  await g.moles[0].s.call(`/api/tables/${g.code}/leave`, { body: {} });
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.winner).toBe("players");
});

it("doesn't let someone who missed the pick vote, and doesn't wait for them either", async () => {
  const g = await started(4, { pickSeconds: 4, voteSeconds: 60 });
  const [missed, ...pickers] = g.players;
  await pickAll(g.code, pickers);
  await toVote(g);

  expect((await me(missed, g.code)) as { picked?: boolean }).toMatchObject({ picked: false });
  const res = await missed.s.call(`/api/tables/${g.code}/vote`, { body: { name: "skip" } });
  expect(res.status).toBe(403);

  // Everyone who can vote has: the vote ends long before its 60s deadline.
  for (const p of pickers) await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: "skip" } });
  await waitFor(g.code, (s) => s.game?.phase === "reveal", 3000);
});

it("draws a new theme pair each round, and shows every pair only when the game ends", async () => {
  const g = await started(4);
  const first = g.roles.get(g.others[0].name)!.theme!;
  await pickAll(g.code, g.players);
  await toVote(g);
  // Vote out an innocent, so the game goes on to a second round.
  const innocent = g.others[0];
  for (const p of g.players) await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: innocent.name } });
  const r1 = await waitFor(g.code, (s) => s.game?.phase === "reveal");
  expect(r1.game!.themes).toBeUndefined();
  expect(JSON.stringify(r1)).not.toContain(first);

  await g.host.s.call(`/api/tables/${g.code}/advance`, { body: {} });
  await waitFor(g.code, (s) => s.game?.round === 2 && s.game?.phase === "pick");
  const second = (await me(g.others[1], g.code)).theme!;
  expect(second).not.toBe(first);
  expect([first, second]).not.toContain((await me(g.moles[0], g.code)).theme);

  await pickAll(g.code, g.players);
  await toVote(g);
  for (const p of g.players.filter((p) => p !== innocent)) {
    await p.s.call(`/api/tables/${g.code}/vote`, { body: { name: g.moles[0].name } });
  }
  const end = await waitFor(g.code, (s) => s.status === "finished");
  expect(end.game!.themes).toHaveLength(2);
  expect(end.game!.themes![0].majority).toBe(first);
  expect(end.game!.themes![1].majority).toBe(second);
  expect(end.game!.themes![0].mole).toBe(g.roles.get(g.moles[0].name)!.theme);
});

// Playtest 1: in a second game at the same table only the mole could pick. The
// page had remembered "already picked" per table and round number, and a new
// game starts at round 1 again. The server is the record of who has picked.
it("lets everyone pick again in a second game at the same table", async () => {
  const t = await started(3);
  await pickAll(t.code, t.players);
  await toVote(t);
  for (const p of t.players) await p.s.call(`/api/tables/${t.code}/vote`, { body: { name: t.moles[0].name } });
  await waitFor(t.code, (s) => s.status === "finished");

  expect((await t.host.s.call(`/api/tables/${t.code}/start`, { body: {} })).status).toBeLessThan(300);
  await waitFor(t.code, (s) => s.status === "playing" && s.game?.round === 1 && s.game?.phase === "pick");
  for (const p of t.players) expect((await me(p, t.code)).picked).toBe(false);
  await pickAll(t.code, t.players);
  await waitFor(t.code, (s) => s.game?.phase === "listen");
});
