import { expect, it } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract: GET /api/shop/radio -> {mode, stations, slotMs, epoch, now, next},
// no sign-in needed; what plays is derived from the clock, so two reads inside
// one slot agree. POST /api/shop/radio {mode} needs a sign-in and being in the
// shop, and works once a minute for the whole shop (429 with retryAfter).

type Radio = {
  mode: string;
  stations: { id: string; name: string }[];
  slotMs: number;
  epoch: number;
  now: { trackId: number; station: string; startedAt: number };
  next: { trackId: number; station: string; startedAt: number };
};
const get = async () => (await (await fetch(new URL("/api/shop/radio", baseUrl))).json()) as Radio;

it("is readable without signing in and agrees with itself within a slot", async () => {
  const a = await get();
  const b = await get();
  expect(a.slotMs).toBe(30000);
  expect(a.stations.map((s) => s.id).sort()).toEqual(["after-hours", "back-room", "late-bus"]);
  if (a.now.startedAt === b.now.startedAt) expect(a.now.trackId).toBe(b.now.trackId);
  expect(a.next.startedAt).toBe(a.now.startedAt + a.slotMs);
});

it("needs a sign-in and being in the shop to change the station", async () => {
  expect((await session().call("/api/shop/radio", { body: { mode: "mix" } })).status).toBe(401);
  const s = session();
  await s.call("/api/join", { body: { name: uniqueName("dj"), pin: "1357" } });
  expect((await s.call("/api/shop/radio", { body: { mode: "mix" } })).status).toBe(409);
  expect((await s.call("/api/shop/radio", { body: { mode: "polka" } })).status).toBe(400);
});

it("changes the station for everyone, then holds the jukebox for a minute", async () => {
  const s = session();
  const t = session();
  await s.call("/api/join", { body: { name: uniqueName("dj"), pin: "1357" } });
  await t.call("/api/join", { body: { name: uniqueName("dj"), pin: "1357" } });
  const mine = await s.open("/api/shop/events");
  const theirs = await t.open("/api/shop/events");
  await mine.next((e) => e.event === "snapshot");
  await theirs.next((e) => e.event === "snapshot");

  const res = await s.call("/api/shop/radio", { body: { mode: "late-bus" } });
  if (res.status === 429) {
    // Another spec used the jukebox within the minute; the limit is the thing under test.
    expect(((await res.json()) as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  } else {
    expect(res.status).toBe(200);
    const heard = await theirs.next((e) => e.event === "radio");
    expect(heard!.data.mode).toBe("late-bus");
    expect(heard!.data.now.station).toBe("late-bus");
    expect((await get()).mode).toBe("late-bus");
  }
  const again = await t.call("/api/shop/radio", { body: { mode: "mix" } });
  expect(again.status).toBe(429);
  const body = (await again.json()) as { retryAfter: number };
  expect(body.retryAfter).toBeGreaterThan(0);
  expect(body.retryAfter).toBeLessThanOrEqual(60);
  mine.close();
  theirs.close();
});
