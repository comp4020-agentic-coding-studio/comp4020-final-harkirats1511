import { expect, it, vi } from "vitest";
import { fillCrate, session, uniqueName } from "./helpers";

// Contract (decision 0011, "booths you can see into"): a public booth that is playing adds
// phase, mood, format, playing {title, artist, picker} (only while a card plays in listen) and
// votes (a count in an open vote, never who or for whom), in GET /api/shop/booths and the shop
// stream's booths event. A private booth shows none of it. A pick still sends nothing.

vi.setConfig({ testTimeout: 180_000 });
type Booth = { code?: string; host: string; private: boolean; status: string; round?: number; phase?: string; mood?: string; format?: string; playing?: { title: string; artist: string; picker: string }; votes?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (code: string, p: string) => `/api/tables/${code}/${p}`;
const KEYS = new Set(["spot", "private", "code", "host", "seated", "bots", "max", "status", "round", "phase", "mood", "format", "playing", "votes"]);

async function player(prefix: string, crate: number) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name, ids: await fillCrate(s, crate) };
}
type P = Awaited<ReturnType<typeof player>>;
async function until(p: P, code: string, ok: (st: any) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await (await p.s.call(at(code, ""))).json();
    if (ok(st)) return st;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(200);
  }
}
const booth = async (p: P, host: string) => ((await (await p.s.call("/api/shop/booths")).json()) as Booth[]).find((b) => b.host === host);

it("shows a public booth's phase, mood and format, the card playing only in listen, and the vote as a count", async () => {
  const ps = await Promise.all([0, 1, 2].map((i) => player("bv", i)));
  const [host] = ps;
  // pickSeconds long, so the pick ends only when everyone has picked; the table page is held open so it stays a booth.
  const { code } = (await (await host.s.call("/api/tables", { body: { format: "knockout", pickSeconds: 120, voteSeconds: 120 } })).json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(at(code, "join"), { body: {} });
  const page = await host.s.open(at(code, "events"));
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  await until(host, code, (st) => st.game?.phase === "pick");
  const prompt = (await (await host.s.call(at(code, "me"))).json()) as { slot: string };
  const pick = (await booth(host, host.name))!;
  expect(pick).toMatchObject({ code, status: "playing", phase: "pick", format: "knockout", round: 1, mood: prompt.slot });
  expect(pick.playing).toBeUndefined();
  expect(pick.votes).toBeUndefined();
  for (const k of Object.keys(pick)) expect(KEYS.has(k), k).toBe(true);

  // A pick changes nothing a booth shows.
  expect((await ps[0].s.call(at(code, "pick"), { body: { trackId: ps[0].ids[0] } })).status).toBe(200);
  expect(await booth(host, host.name)).toEqual(pick);
  for (const p of ps.slice(1)) await p.s.call(at(code, "pick"), { body: { trackId: p.ids[0] } });
  const listen = await until(host, code, (st) => st.game?.phase === "listen");
  // Listen with no card playing: no `playing`. Then the host plays card 2.
  expect((await booth(host, host.name))!.playing).toBeUndefined();
  expect((await host.s.call(at(code, "round/play"), { body: { slot: 1 } })).status).toBeLessThan(300);
  await sleep(100);
  const card = listen.game.cards.find((c: { order: number }) => c.order === 1);
  expect((await booth(host, host.name))!).toMatchObject({ phase: "listen", playing: { title: card.title, artist: card.artist, picker: card.picker } });

  // Vote: a count of ballots, nothing else; `playing` is gone.
  await host.s.call(at(code, "advance"), { body: {} });
  await until(host, code, (st) => st.game?.phase === "vote");
  let v = (await booth(host, host.name))!;
  expect(v).toMatchObject({ phase: "vote", votes: 0 });
  expect(v.playing).toBeUndefined();
  await ps[0].s.call(at(code, "vote"), { body: { name: ps[1].name } });
  await ps[1].s.call(at(code, "vote"), { body: { skip: true } });
  v = (await booth(host, host.name))!;
  expect(v.votes).toBe(2);
  expect(typeof v.votes).toBe("number");
  // Never a name in the booth beyond its host.
  for (const p of ps.slice(1)) expect(JSON.stringify(v)).not.toContain(p.name);
  page.close();
});

it("shows a private booth's host and nothing of its game", async () => {
  const ps = await Promise.all([3, 4, 5].map((i) => player("bp", i)));
  const [host] = ps;
  const watcher = await player("bpw", 6);
  const stream = await watcher.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  const { code } = (await (await host.s.call("/api/tables", { body: { private: true, pickSeconds: 120 } })).json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(at(code, "join"), { body: {} });
  const page = await host.s.open(at(code, "events"));
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  for (const p of ps) await p.s.call(at(code, "pick"), { body: { trackId: p.ids[0] } });
  await until(host, code, (st) => st.game?.phase === "listen");
  await host.s.call(at(code, "round/play"), { body: { slot: 0 } });
  await sleep(600);
  const b = (await booth(watcher, host.name))!;
  expect(b.private).toBe(true);
  // (round was shown for private booths before 0011 and stays as it was.)
  for (const k of ["code", "phase", "mood", "format", "playing", "votes"]) expect(b, k).not.toHaveProperty(k);
  const frames = stream.seen.filter((e) => e.event === "booths" || e.event === "snapshot").map((e) => (e.event === "snapshot" ? e.data.booths : e.data));
  for (const list of frames) {
    const mine = (list as Booth[]).find((x) => x.host === host.name);
    if (mine) for (const k of ["code", "phase", "mood", "format", "playing", "votes"]) expect(mine, k).not.toHaveProperty(k);
  }
  expect(stream.raw).not.toContain(code);
  stream.close();
  page.close();
});
