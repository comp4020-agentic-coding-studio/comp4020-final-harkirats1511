import { expect, it, vi } from "vitest";
import { fillCrate, session, uniqueName } from "./helpers";

// Contract: GET /api/shop/events is a signed-in-only SSE stream (snapshot,
// moves, joined, left, emote, booths, radio). POST /api/shop/move {x, z, yaw}
// and POST /api/shop/emote {emote} answer 204; move 409s when you aren't in the
// shop. The server clamps positions to the room (x -8..8, z -5.5..4.7), caps
// speed at 4 m/s, drops moves past 8 a second, and allows one emote a second.

vi.setConfig({ testTimeout: 30_000 });

async function signedIn(prefix: string) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}

type Snapshot = { you: string; people: { name: string; x: number; z: number; yaw: number }[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("needs a sign-in for every shop action", async () => {
  const anon = session();
  expect((await anon.open("/api/shop/events")).status).toBe(401);
  expect((await anon.call("/api/shop/move", { body: { x: 0, z: 0, yaw: 0 } })).status).toBe(401);
  expect((await anon.call("/api/shop/emote", { body: { emote: "wave" } })).status).toBe(401);
});

it("puts you at the door on connect and 409s a move when you aren't in", async () => {
  const a = await signedIn("shopa");
  expect((await a.s.call("/api/shop/move", { body: { x: 0, z: 0, yaw: 0 } })).status).toBe(409);
  const stream = await a.s.open("/api/shop/events");
  const snap = await stream.next((e) => e.event === "snapshot");
  const data = snap!.data as Snapshot;
  expect(data.you).toBe(a.name);
  // somewhere just inside the door (people are spread out so they don't overlap)
  const at = data.people.find((p) => p.name === a.name)!;
  expect(Math.abs(at.x - 0.6)).toBeLessThanOrEqual(1.2);
  expect(at.z).toBeGreaterThanOrEqual(3.6);
  expect(at.z).toBeLessThanOrEqual(4.2);
  stream.close();
});

it("tells others who joined and left", async () => {
  const a = await signedIn("shopa");
  const b = await signedIn("shopb");
  const watch = await a.s.open("/api/shop/events");
  await watch.next((e) => e.event === "snapshot");
  const other = await b.s.open("/api/shop/events");
  expect(await watch.next((e) => e.event === "joined" && e.data.name === b.name)).not.toBeNull();
  other.close();
  expect(await watch.next((e) => e.event === "left" && e.data.name === b.name)).not.toBeNull();
  watch.close();
});

it("keeps someone in until their last tab closes", async () => {
  const a = await signedIn("shopa");
  const b = await signedIn("shopb");
  const watch = await a.s.open("/api/shop/events");
  await watch.next((e) => e.event === "snapshot");
  const tab1 = await b.s.open("/api/shop/events");
  const tab2 = await b.s.open("/api/shop/events");
  await tab2.next((e) => e.event === "snapshot");
  tab1.close();
  await sleep(400);
  expect(watch.seen.some((e) => e.event === "left" && e.data.name === b.name)).toBe(false);
  tab2.close();
  expect(await watch.next((e) => e.event === "left" && e.data.name === b.name)).not.toBeNull();
  watch.close();
});

it("puts you back where you stood if you reconnect soon", async () => {
  const a = await signedIn("shopa");
  const first = await a.s.open("/api/shop/events");
  await first.next((e) => e.event === "snapshot");
  await sleep(500);
  await a.s.call("/api/shop/move", { body: { x: 1.2, z: 4.0, yaw: 0 } });
  first.close();
  await sleep(300);
  const second = await a.s.open("/api/shop/events");
  const snap = await second.next((e) => e.event === "snapshot");
  expect((snap!.data as Snapshot).people.find((p) => p.name === a.name)).toMatchObject({ x: 1.2, z: 4 });
  second.close();
});

it("clamps a move to the room and caps how far it goes", async () => {
  const a = await signedIn("shopa");
  const b = await signedIn("shopb");
  const watch = await b.s.open("/api/shop/events");
  await watch.next((e) => e.event === "snapshot");
  const mine = await a.s.open("/api/shop/events");
  await mine.next((e) => e.event === "snapshot");

  // Far outside the room, right after arriving: the walk is capped, not rejected.
  expect((await a.s.call("/api/shop/move", { body: { x: 500, z: -500, yaw: 450 } })).status).toBe(204);
  const m = await watch.next((e) => e.event === "moves" && e.data.people.some((p: { name: string }) => p.name === a.name));
  const p = m!.data.people.find((q: { name: string }) => q.name === a.name);
  // within one step of where they walked in (the door, give or take the spread)
  expect(Math.hypot(p.x - 0.6, p.z - 4.2)).toBeLessThan(1.5 + 1.35);
  expect(p.x).toBeLessThanOrEqual(8);
  expect(p.z).toBeGreaterThanOrEqual(-5.5);
  expect(p.yaw).toBe(90);

  // Given long enough, the walk reaches the wall and no further.
  for (let i = 0; i < 8; i++) {
    await sleep(1100);
    await a.s.call("/api/shop/move", { body: { x: 500, z: -500, yaw: 0 } });
  }
  await sleep(300);
  const last = watch.seen.filter((e) => e.event === "moves").flatMap((e) => e.data.people).filter((q: { name: string }) => q.name === a.name).at(-1);
  expect(last.x).toBeLessThanOrEqual(8);
  expect(last.z).toBeGreaterThanOrEqual(-5.5);
  mine.close();
  watch.close();
});

it("rejects non-finite numbers", async () => {
  const a = await signedIn("shopa");
  const stream = await a.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  for (const body of [{ x: "1", z: 0, yaw: 0 }, { x: 0, z: null, yaw: 0 }, { x: 0, z: 0 }, {}]) {
    expect((await a.s.call("/api/shop/move", { body })).status).toBe(400);
  }
  expect((await a.s.call("/api/shop/move", { body: { x: 1e999, z: 0, yaw: 0 } })).status).toBe(400);
  stream.close();
});

it("ignores more than 8 moves in a second", async () => {
  const a = await signedIn("shopa");
  const b = await signedIn("shopb");
  const watch = await b.s.open("/api/shop/events");
  await watch.next((e) => e.event === "snapshot");
  const mine = await a.s.open("/api/shop/events");
  await mine.next((e) => e.event === "snapshot");
  await sleep(2000); // so speed isn't what limits it: 8 m of reach
  for (let i = 1; i <= 9; i++) {
    const res = await a.s.call("/api/shop/move", { body: { x: 0.6 - i * 0.1, z: 4.2, yaw: 0 } });
    expect(res.status).toBe(204);
  }
  await sleep(400);
  const xs = watch.seen.filter((e) => e.event === "moves").flatMap((e) => e.data.people).filter((q: { name: string }) => q.name === a.name).map((q: { x: number }) => q.x);
  // The ninth (x -0.3) was dropped: the last position seen is the eighth's.
  expect(xs.at(-1)).toBeCloseTo(0.6 - 0.8, 5);
  mine.close();
  watch.close();
});

it("allows only the listed emotes, one a second", async () => {
  const a = await signedIn("shopa");
  const b = await signedIn("shopb");
  const watch = await b.s.open("/api/shop/events");
  await watch.next((e) => e.event === "snapshot");
  const mine = await a.s.open("/api/shop/events");
  await mine.next((e) => e.event === "snapshot");
  expect((await a.s.call("/api/shop/emote", { body: { emote: "backflip" } })).status).toBe(400);
  expect((await a.s.call("/api/shop/emote", { body: {} })).status).toBe(400);
  for (const emote of ["wave", "nope"]) expect((await a.s.call("/api/shop/emote", { body: { emote } })).status).toBe(204);
  const got = await watch.next((e) => e.event === "emote" && e.data.name === a.name);
  expect(got!.data.emote).toBe("wave");
  await sleep(300);
  // The second, sent inside the second, was ignored.
  expect(watch.seen.filter((e) => e.event === "emote" && e.data.name === a.name)).toHaveLength(1);
  await sleep(900);
  await a.s.call("/api/shop/emote", { body: { emote: "dance" } });
  expect(await watch.next((e) => e.event === "emote" && e.data.emote === "dance")).not.toBeNull();
  mine.close();
  watch.close();
});

it("sends public state only: no theme, role, title or owner during a game", async () => {
  const people = await Promise.all([signedIn("shopg"), signedIn("shopg"), signedIn("shopg")]);
  const watcher = await signedIn("shopw");
  const stream = await watcher.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  const { code } = (await (await people[0].s.call("/api/tables", { body: {} })).json()) as { code: string };
  for (const p of people.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  for (const p of people) await fillCrate(p.s);
  expect((await people[0].s.call(`/api/tables/${code}/start`, { body: {} })).status).toBe(202);
  const playing = await stream.next((e) => e.event === "booths" && e.data.some((b: { code?: string; status: string }) => b.code === code && b.status === "playing"), 3000);
  expect(playing).not.toBeNull();
  await sleep(500);
  for (const word of ["theme", "role", "mole", "title", "owner", "majority", "pick", "vote"]) {
    expect(stream.raw.toLowerCase()).not.toContain(`"${word}`);
  }
  stream.close();
});
