import { expect, it, vi } from "vitest";
import { CRATES, fillCrate, getUrl, session, uniqueName } from "./helpers";

// Contract (decision 0011, CLAUDE.md "The shop"):
//   GET  /api/shop/jukebox        -> {now: Play|null, queue: Play[], skips, needed}
//   POST /api/shop/jukebox {trackId} -> 201 {play} | 400/403/409 {error}: signed in, on the shop floor,
//        a song of your own crate, clean by the starter's rules, one queued per person, at most 12 queued.
//   POST /api/shop/jukebox/skip   -> 200 {skips, needed}: on the floor, one per person per play; at
//        needed = max(2, ceil(people on the floor / 3)) the next play starts.
//   Play = {id, trackId, title, artist, cover?, picker, startedAt?, ms: 30000}. The snapshot has `jukebox`,
//   and a `jukebox` event (the GET shape) fires on every change. A jukebox play never marks a song heard.
// The jukebox is shared by everything the suite runs at once, so these wait for it to be quiet first.

vi.setConfig({ testTimeout: 180_000 });
type Session = ReturnType<typeof session>;
type Play = { id: string; trackId: number; title: string; artist: string; picker: string; startedAt?: number; ms: number };
type Box = { now: Play | null; queue: Play[]; skips: number; needed: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 1123844 ("On & On", in crate 1) is marked explicit by Deezer; crate 0's songs are clean.
const EXPLICIT = 1123844;
const CLEAN = CRATES[0][0];

async function person(prefix: string, crate?: number) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  if (crate !== undefined) await fillCrate(s, crate);
  return { s, name };
}
const box = async () => (await (await getUrl("/api/shop/jukebox")).json()) as Box;
const queue = (s: Session, trackId: unknown) => s.call("/api/shop/jukebox", { body: { trackId } });
// Clears whatever is left playing: everyone here skips, and a play ends by itself after 30 s anyway.
async function quiet(ss: Session[]) {
  const until = Date.now() + 13 * 31_000;
  while (Date.now() < until) {
    const b = await box();
    if (!b.now && !b.queue.length) return;
    for (const s of ss) await s.call("/api/shop/jukebox/skip", { body: {} });
    await sleep(500);
  }
  throw new Error("the jukebox never went quiet");
}

it("needs a sign-in to queue or skip, and anyone may read it", async () => {
  const anon = session();
  expect((await queue(anon, CLEAN)).status).toBe(401);
  expect((await anon.call("/api/shop/jukebox/skip", { body: {} })).status).toBe(401);
  const b = await box();
  expect(b).toMatchObject({ queue: expect.any(Array), skips: expect.any(Number), needed: expect.any(Number) });
  expect(b.needed).toBeGreaterThanOrEqual(2);
});

it("refuses someone off the floor, a song not in your crate, an explicit song and a second queue; skips move it on", async () => {
  const a = await person("jka", 0);
  const b = await person("jkb", 1);
  const c = await person("jkc");
  // Off the floor: no stream open yet.
  const off = await queue(a.s, CLEAN);
  expect(off.status).toBe(409);
  expect((await b.s.call("/api/shop/jukebox/skip", { body: {} })).status).toBe(409);
  const sa = await a.s.open("/api/shop/events");
  const snap = await sa.next((e) => e.event === "snapshot");
  expect(snap!.data.jukebox).toMatchObject({ queue: expect.any(Array), needed: expect.any(Number) });
  const sb = await b.s.open("/api/shop/events");
  await sb.next((e) => e.event === "snapshot");
  const sc = await c.s.open("/api/shop/events");
  await sc.next((e) => e.event === "snapshot");
  await quiet([a.s, b.s, c.s]);

  // Not a number, not in your crate (it is in someone else's), explicit (in your own crate).
  expect((await queue(a.s, "lots")).status).toBe(400);
  const notMine = await queue(a.s, CRATES[1][1]);
  expect(notMine.status).toBe(403);
  expect(((await notMine.json()) as { error: string }).error).toMatch(/crate/i);
  const dirty = await queue(b.s, EXPLICIT);
  expect(dirty.status).toBe(400);
  expect(((await dirty.json()) as { error: string }).error).toMatch(/clean/i);
  expect((await box()).queue.some((p) => p.trackId === EXPLICIT)).toBe(false);

  // A clean song of your own: it plays now, named, and the stream says so.
  const mark = sa.seen.length;
  const ok = await queue(a.s, CLEAN);
  expect(ok.status).toBe(201);
  const { play } = (await ok.json()) as { play: Play };
  expect(play).toMatchObject({ trackId: CLEAN, picker: a.name, ms: 30_000 });
  expect(play.startedAt).toEqual(expect.any(Number));
  const ev = await sa.next((e) => e.event === "jukebox" && e.data.now?.id === play.id, 3000, mark);
  expect(ev).not.toBeNull();
  // A second queue from the same person while theirs plays.
  const twice = await queue(a.s, CRATES[0][1]);
  expect(twice.status).toBe(409);
  expect(((await twice.json()) as { error: string }).error).toMatch(/already/i);
  // b queues a clean song of their own behind it.
  const next = await queue(b.s, CRATES[1][1]);
  expect(next.status).toBe(201);
  let st = await box();
  expect(st.now?.id).toBe(play.id);
  expect(st.queue.map((p) => p.picker)).toContain(b.name);
  // Skips: one per person per play; one short of `needed` keeps it playing, `needed` starts the next.
  // (Other specs may have people on the floor, so the count is read, and enough of us walk in to reach it.)
  const first = await c.s.call("/api/shop/jukebox/skip", { body: {} });
  expect(first.status).toBe(200);
  const r1 = (await first.json()) as { skips: number; needed: number };
  expect(r1.skips).toBe(1);
  expect(r1.needed).toBeGreaterThanOrEqual(2);
  expect((await c.s.call("/api/shop/jukebox/skip", { body: {} })).status).toBe(409);
  const extra: { close: () => void }[] = [];
  const voters = [b.s, a.s];
  for (let skips = 1; ; ) {
    const need = (await box()).needed;
    expect(need).toBeGreaterThanOrEqual(2);
    if (skips === need - 1) expect((await box()).now?.id).toBe(play.id);
    let s = voters.shift();
    if (!s) {
      const p = await person("jkx");
      const st2 = await p.s.open("/api/shop/events");
      await st2.next((e) => e.event === "snapshot");
      extra.push(st2);
      s = p.s;
    }
    const r = await s.call("/api/shop/jukebox/skip", { body: {} });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { skips: number; needed: number };
    skips = body.skips;
    if (skips >= body.needed) break;
  }
  st = await box();
  expect(st.now?.id).not.toBe(play.id);
  expect(st.skips).toBe(0);
  // a's song is gone, so a may queue again.
  expect((await queue(a.s, CRATES[0][1])).status).toBe(201);
  await quiet([a.s, b.s, c.s]);
  sa.close(); sb.close(); sc.close();
  for (const e of extra) e.close();
});

it("needs max(2, ceil(floor/3)) skips, and a jukebox play never marks a song heard in a game", async () => {
  const host = await person("jkh", 0);
  const crowd = await Promise.all([1, 2, 3, 4, 5, 6].map(() => person("jkf")));
  const streams = [await host.s.open("/api/shop/events")];
  await streams[0].next((e) => e.event === "snapshot");
  for (const p of crowd) {
    const st = await p.s.open("/api/shop/events");
    await st.next((e) => e.event === "snapshot");
    streams.push(st);
  }
  await quiet([host.s, ...crowd.map((p) => p.s)]);
  expect((await queue(host.s, CLEAN)).status).toBe(201);
  const b = await box();
  // At least these 7 are on the floor (other specs may add more).
  expect(b.needed).toBeGreaterThanOrEqual(Math.max(2, Math.ceil(7 / 3)));
  // The host's crate song, played on the jukebox, can still be picked in a game: start one and check `played`.
  const g1 = await person("jkg", 1);
  const g2 = await person("jkg", 2);
  const { code } = (await (await host.s.call("/api/tables", { body: { private: true } })).json()) as { code: string };
  for (const p of [g1, g2]) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  expect((await host.s.call(`/api/tables/${code}/start`, { body: {} })).status).toBeLessThan(300);
  const st = (await (await host.s.call(`/api/tables/${code}`)).json()) as { game: { played: number[] } };
  expect(st.game.played).not.toContain(CLEAN);
  const me = (await (await host.s.call(`/api/tables/${code}/me`)).json()) as { played: number[] };
  expect(me.played).not.toContain(CLEAN);
  expect((await host.s.call(`/api/tables/${code}/pick`, { body: { trackId: CLEAN } })).status).toBe(200);
  await quiet([host.s, ...crowd.map((p) => p.s)]);
  for (const s of streams) s.close();
});
