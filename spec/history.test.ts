import { expect, it, vi } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract: a person can look back at the games they played, which is what the
// persistence is for. Only finished games, only ones they were in.
//   GET /api/history -> [{code, finishedAt, winner, mine: {theme, wasMole, title,
//        artist}[] per round, rounds: {round, majority, mole}[], players: string[]}]
//   newest first. `mine` is this person's own pick and theme per round. Nothing
//   about a game still running.

vi.setConfig({ testTimeout: 90_000 });

type Session = ReturnType<typeof session>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function state(code: string) {
  return (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as {
    status: string;
    game?: { phase: string };
  };
}
async function waitFor(code: string, ok: (s: Awaited<ReturnType<typeof state>>) => boolean) {
  for (let i = 0; i < 80; i++) {
    const s = await state(code);
    if (ok(s)) return s;
    await sleep(150);
  }
  throw new Error("state never matched");
}

async function people(n: number) {
  const out: { s: Session; name: string }[] = [];
  for (let i = 0; i < n; i++) {
    const s = session();
    const name = uniqueName(`h${i}`);
    await s.call("/api/join", { body: { name, pin: "1593" } });
    out.push({ s, name });
  }
  return out;
}

it("lists only finished games the person played, with their own picks, newest first", async () => {
  const ps = await people(3);
  const [host] = ps;
  const ids = ((await (await host.s.call("/api/search?q=love")).json()) as { id: number }[]).map((t) => t.id);
  const { code } = (await (await host.s.call("/api/tables", { body: { pickSeconds: 30, voteSeconds: 30 } })).json()) as {
    code: string;
  };
  for (const p of ps.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await host.s.call(`/api/tables/${code}/start`, { body: {} });

  // While the game runs, it isn't history yet.
  expect(((await (await host.s.call("/api/history")).json()) as unknown[]).some((g) => (g as { code: string }).code === code)).toBe(false);

  for (const [i, p] of ps.entries()) await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: ids[i] } });
  await waitFor(code, (s) => s.game?.phase === "listen");
  await host.s.call(`/api/tables/${code}/advance`, { body: {} });
  await waitFor(code, (s) => s.game?.phase === "vote");

  // Find the mole by theme (the odd one out), then vote them out to end the game.
  const themes = await Promise.all(ps.map(async (p) => ((await (await p.s.call(`/api/tables/${code}/me`)).json()) as { theme: string }).theme));
  const mole = ps[themes.findIndex((t) => themes.filter((x) => x === t).length === 1)];
  for (const p of ps) await p.s.call(`/api/tables/${code}/vote`, { body: { name: mole.name } });
  await waitFor(code, (s) => s.status === "finished");

  const history = (await (await host.s.call("/api/history")).json()) as {
    code: string;
    winner: string;
    mine: { theme: string; wasMole: boolean; title: string }[];
    rounds: { majority: string; mole: string }[];
    players: string[];
  }[];
  const game = history.find((g) => g.code === code)!;
  expect(game).toBeTruthy();
  expect(game.winner).toBe("players");
  expect(game.players.sort()).toEqual(ps.map((p) => p.name).sort());
  expect(game.rounds).toHaveLength(1);
  expect(game.mine).toHaveLength(1);
  expect(game.mine[0].theme).toBe(themes[0]);
  expect(game.mine[0].wasMole).toBe(host === mole);
  expect(game.mine[0].title).toBeTruthy();

  // Someone who wasn't there sees none of it.
  const [stranger] = await people(1);
  const theirs = (await (await stranger.s.call("/api/history")).json()) as { code: string }[];
  expect(theirs.some((g) => g.code === code)).toBe(false);
});

it("needs a session", async () => {
  expect((await session().call("/api/history")).status).toBe(401);
});
