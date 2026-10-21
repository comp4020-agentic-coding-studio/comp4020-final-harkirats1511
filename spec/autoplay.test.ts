import { expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers";

// Contract: a table can let the server play the round's tracks in order, so the
// room isn't waiting on the host's phone (which may lock or drop).
//   POST /api/tables {autoplay: true, slotSeconds?} -> the listen phase plays
//        slot 0, 1, ... in turn, `slotSeconds` each (default 30, the preview
//        length; specs use short ones), then moves on to the vote by itself.
// The host can still play a slot by hand, which takes over from there.

vi.setConfig({ testTimeout: 90_000 });

type Session = ReturnType<typeof session>;
type S = { status: string; game?: { phase: string; nowPlaying: number | null } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (code: string) => (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as S;

async function setup(opts: Record<string, unknown>) {
  const ps: { s: Session; name: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = session();
    const name = uniqueName(`ap${i}`);
    await s.call("/api/join", { body: { name, pin: "7531" } });
    ps.push({ s, name });
  }
  let ids: number[] = [];
  for (const p of ps) ids = await fillCrate(p.s);
  const res = await ps[0].s.call("/api/tables", { body: { pickSeconds: 30, voteSeconds: 30, ...opts } });
  const { code } = (await res.json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await ps[0].s.call(`/api/tables/${code}/start`, { body: {} });
  for (const [i, p] of ps.entries()) await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: ids[i] } });
  return { code, ps, status: res.status };
}

it("plays every slot in turn on its own, then opens the vote", async () => {
  const { code } = await setup({ autoplay: true, slotSeconds: 2 });
  const seen: (number | null)[] = [];
  const until = Date.now() + 20_000;
  let phase = "";
  while (Date.now() < until) {
    const s = await get(code);
    phase = s.game!.phase;
    if (phase === "listen" && seen[seen.length - 1] !== s.game!.nowPlaying) seen.push(s.game!.nowPlaying);
    if (phase === "vote") break;
    await sleep(200);
  }
  // Three picks, plus the house record when Deezer found one in time.
  const played = seen.filter((x) => x !== null);
  expect(played).toEqual([0, 1, 2, 3].slice(0, played.length));
  expect([3, 4]).toContain(played.length);
  expect(phase).toBe("vote");
});

it("leaves listening to the host when autoplay is off", async () => {
  const { code } = await setup({ slotSeconds: 2 });
  await sleep(4000);
  const s = await get(code);
  expect(s.game!.phase).toBe("listen");
  expect(s.game!.nowPlaying).toBeNull();
});

it("refuses a nonsense slot length", async () => {
  const s = session();
  await s.call("/api/join", { body: { name: uniqueName("apx"), pin: "7531" } });
  expect((await s.call("/api/tables", { body: { autoplay: true, slotSeconds: "lots" } })).status).toBe(400);
});
