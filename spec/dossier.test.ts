import { expect, it, vi } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract:
//   GET  /api/tables/:code/dossier        mole only: what they study about their
//        target, {name, taste: [{title, artist}], picks: [{title, artist}]};
//        taste file plus picks they made in earlier rounds/games, nothing else
//   POST /api/tables/:code/round/play {slot}  host: the slot now playing, shown on
//        the public state as game.nowPlaying so every phone can follow

vi.setConfig({ testTimeout: 90_000 });

type Session = ReturnType<typeof session>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (code: string) =>
  (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as {
    game?: { phase: string; nowPlaying?: number | null };
  };

async function setup() {
  const people: { s: Session; name: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = session();
    const name = uniqueName(`d${i}`);
    await s.call("/api/join", { body: { name, pin: "1470" } });
    people.push({ s, name });
  }
  const found = (await (await people[0].s.call("/api/search?q=love")).json()) as { id: number; title: string }[];
  // Everyone has a taste file, so whoever ends up targeted has one.
  for (const [i, p] of people.entries()) await p.s.call("/api/taste", { body: { trackId: found[i].id } });

  const { code } = (await (
    await people[0].s.call("/api/tables", { body: { pickSeconds: 30, voteSeconds: 30 } })
  ).json()) as { code: string };
  for (const p of people.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await people[0].s.call(`/api/tables/${code}/start`, { body: {} });

  const roles = await Promise.all(
    people.map(async (p) => ({
      ...p,
      ...((await (await p.s.call(`/api/tables/${code}/me`)).json()) as { role: string; target?: string }),
    })),
  );
  return { code, people, roles, found };
}

it("shows the mole their target's taste file, and nobody else gets it", async () => {
  const { code, roles, found, people } = await setup();
  const mole = roles.find((r) => r.role === "mole")!;
  const res = await mole.s.call(`/api/tables/${code}/dossier`);
  expect(res.status).toBe(200);
  const dossier = (await res.json()) as { name: string; taste: { title: string }[]; picks: unknown[] };
  expect(dossier.name).toBe(mole.target);
  const targetIndex = people.findIndex((p) => p.name === mole.target);
  expect(dossier.taste.map((t) => t.title)).toContain(found[targetIndex].title);
  expect(JSON.stringify(dossier)).not.toMatch(/pin/i);

  for (const r of roles.filter((r) => r.role !== "mole")) {
    expect((await r.s.call(`/api/tables/${code}/dossier`)).status).toBe(403);
  }
});

it("lets the host say which slot is playing, and every phone sees it", async () => {
  const { code, people, found } = await setup();
  for (const [i, p] of people.entries()) await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: found[i + 3].id } });
  for (let i = 0; (await get(code)).game?.phase !== "listen"; i++) {
    if (i > 50) throw new Error("never reached listen");
    await sleep(150);
  }
  expect((await people[1].s.call(`/api/tables/${code}/round/play`, { body: { slot: 1 } })).status).toBe(403);
  const at = Date.now();
  expect((await people[0].s.call(`/api/tables/${code}/round/play`, { body: { slot: 1 } })).status).toBeLessThan(300);
  expect((await get(code)).game?.nowPlaying).toBe(1);
  expect(Date.now() - at).toBeLessThan(1500);
  expect((await people[0].s.call(`/api/tables/${code}/round/play`, { body: { slot: 9 } })).status).toBe(400);
});
