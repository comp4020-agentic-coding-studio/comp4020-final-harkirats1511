import { expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers.ts";

// Caps on the event stream (no sign-in needed to open one) and a light rate
// limit on acting. The numbers are constants in src/lib/limits.ts.
vi.setConfig({ testTimeout: 60_000 });

const limits = () => import("../src/lib/limits.ts");

it("refuses the 25th anonymous watcher of one table with 429, and frees the place when one leaves", async () => {
  const { MAX_WATCHERS_PER_TABLE } = await limits();
  const host = session();
  await host.call("/api/join", { body: { name: uniqueName("cap"), pin: "2580" } });
  const { code } = (await (await host.call("/api/tables", { body: {} })).json()) as { code: string };
  const open: Awaited<ReturnType<typeof host.open>>[] = [];
  for (let i = 0; i < MAX_WATCHERS_PER_TABLE; i++) open.push(await session().open(`/api/tables/${code}/events`));
  expect(open.every((o) => o.status === 200)).toBe(true);
  const over = await fetch(new URL(`/api/tables/${code}/events`, baseUrl));
  expect(over.status).toBe(429);
  await over.body?.cancel();
  // Another table is not affected.
  const other = session();
  await other.call("/api/join", { body: { name: uniqueName("cap"), pin: "2580" } });
  const { code: code2 } = (await (await other.call("/api/tables", { body: {} })).json()) as { code: string };
  const free = await other.open(`/api/tables/${code2}/events`);
  expect(free.status).toBe(200);
  free.close();
  open[0].close();
  let again = 0;
  for (let i = 0; i < 20 && again !== 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(new URL(`/api/tables/${code}/events`, baseUrl));
    again = r.status;
    await r.body?.cancel();
  }
  expect(again).toBe(200);
  for (const o of open) o.close();
});

it("never refuses a signed-in member of the table, however many strangers are watching", async () => {
  const { MAX_WATCHERS_PER_TABLE, MAX_STREAMS_PER_PERSON } = await limits();
  const host = session();
  await host.call("/api/join", { body: { name: uniqueName("mem"), pin: "2580" } });
  const { code } = (await (await host.call("/api/tables", { body: {} })).json()) as { code: string };
  const strangers: Awaited<ReturnType<typeof host.open>>[] = [];
  for (let i = 0; i < MAX_WATCHERS_PER_TABLE; i++) strangers.push(await session().open(`/api/tables/${code}/events`));
  expect(strangers.every((o) => o.status === 200)).toBe(true);
  // Full to strangers, open to the host: up to the per-person cap, then 429.
  const mine: Awaited<ReturnType<typeof host.open>>[] = [];
  for (let i = 0; i < MAX_STREAMS_PER_PERSON; i++) mine.push(await host.open(`/api/tables/${code}/events`));
  expect(mine.every((o) => o.status === 200)).toBe(true);
  expect((await host.open(`/api/tables/${code}/events`)).status).toBe(429);
  for (const o of [...strangers, ...mine]) o.close();
});

it("caps anonymous streams per address, exempts members, and frees them on release", async () => {
  const { MAX_STREAMS_PER_IP, MAX_WATCHERS_PER_TABLE, MAX_STREAMS_PER_PERSON, openStream } = await limits();
  const full = Array.from({ length: MAX_WATCHERS_PER_TABLE }, () => openStream("FULLTBL", "203.0.113.99"));
  expect(openStream("FULLTBL", "203.0.113.99")).toBe("table");
  expect(typeof openStream("FULLTBL", "203.0.113.99", "member-1")).toBe("object");
  for (const s of full) (s as { release: () => void }).release();
  const ip = "203.0.113.7";
  const slots = [];
  for (let i = 0; i < MAX_STREAMS_PER_IP; i++) {
    const s = openStream(`T${i % 3}${i}`, ip);
    expect(typeof s).toBe("object");
    slots.push(s as { release: () => void });
  }
  expect(openStream("TX", ip)).toBe("ip");
  // A member from the same address is not refused, and someone else's address is unaffected.
  expect(typeof openStream("TX", ip, "member-2")).toBe("object");
  expect(typeof openStream("TX", "203.0.113.8")).toBe("object");
  slots[0].release();
  slots[0].release(); // releasing twice frees one place only
  expect(typeof openStream("TX", ip)).toBe("object");
  expect(openStream("TX", ip)).toBe("ip");
  // One member's own streams are capped.
  const own = Array.from({ length: MAX_STREAMS_PER_PERSON }, () => openStream("TY", ip, "member-3"));
  expect(own.every((s) => typeof s === "object")).toBe(true);
  expect(openStream("TY", ip, "member-3")).toBe("person");
});

it("rate-limits one person's actions: the sixth in a second is 429, and a pause clears it", async () => {
  const { MAX_ACTIONS_PER_WINDOW, ACTION_WINDOW_MS, tooFast } = await limits();
  // The module, with a clock.
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_ACTIONS_PER_WINDOW; i++) expect(tooFast("p1", t0 + i)).toBe(false);
  expect(tooFast("p1", t0 + 10)).toBe(true);
  expect(tooFast("p2", t0 + 10)).toBe(false);
  expect(tooFast("p1", t0 + ACTION_WINDOW_MS + MAX_ACTIONS_PER_WINDOW)).toBe(false);
});

it("answers a flood of votes from one person with 429, over HTTP", async () => {
  const mk = async (i: number) => {
    const s = session();
    const name = uniqueName(`fl${i}`);
    await s.call("/api/join", { body: { name, pin: "2580" } });
    await fillCrate(s, i);
    return { s, name };
  };
  const [a, b, c] = await Promise.all([0, 1, 2].map(mk));
  const { code } = (await (await a.s.call("/api/tables", { body: { voteSeconds: 60 } })).json()) as { code: string };
  await b.s.call(`/api/tables/${code}/join`, { body: {} });
  await c.s.call(`/api/tables/${code}/join`, { body: {} });
  // Not in a vote, so each is refused for the phase: the first five by the engine (409),
  // then the limiter answers before it looks.
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await a.s.call(`/api/tables/${code}/vote`, { body: { skip: true } })).status);
  expect(codes.slice(0, 5).every((s) => s === 409)).toBe(true);
  expect(codes.slice(5)).toContain(429);
  // Someone else is not slowed by it.
  expect((await b.s.call(`/api/tables/${code}/vote`, { body: { skip: true } })).status).toBe(409);
  // And the log says so once (when the admin token is known).
  const token = process.env.LOG_TOKEN;
  if (token) {
    const lines = (await (await fetch(new URL(`/api/logs?table=${code}`, baseUrl), { headers: { authorization: `Bearer ${token}` } })).text())
      .split("\n").filter((l) => l.includes("too many requests"));
    expect(lines.length).toBeLessThanOrEqual(1);
  }
});
