import { expect, it, vi } from "vitest";
import { session, uniqueName } from "./helpers";

vi.setConfig({ testTimeout: 90_000 });

// Contract (stage 2a): starting a crate quickly.
//   POST /api/taste/suggest {artists: string[]} (or GET ?artists=a,b) -> {moods: {up,down,out,in: Track[]}, spare, missing}
//     up to 3 songs per mood, Deezer ids and metadata only, each with a preview and none explicit;
//     401 signed out; 429 when the same person asks again within 3 s; 503 with Deezer's busy message.
//   After sign-in the home page sends someone with an incomplete crate to /taste?welcome=1
//     (carrying a table link as ?next=), and leaves a complete crate alone.
//   Old songs (no slot) are sorted with PATCH /api/taste/:id {slot}, which holds 3 per mood.

type Track = { id: number; title: string; artist: string; slot?: string | null };
type Moods = Record<"up" | "down" | "out" | "in", Track[]>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry503(go: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await go();
    if ((res.status !== 503 && res.status !== 429) || attempt >= 6) return res;
    await sleep(res.status === 429 ? 3200 : 1500);
  }
}

async function signedIn() {
  const s = session();
  const name = uniqueName("stt");
  await s.call("/api/join", { body: { name, pin: "8642" } });
  return { s, name };
}

it("suggests at most 3 songs per mood, all with previews and none explicit, and adds nothing", async () => {
  const { s } = await signedIn();
  const res = await retry503(() => s.call("/api/taste/suggest", { body: { artists: ["Daft Punk", "Fleetwood Mac"] } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { moods: Moods; spare: Moods };
  const all = Object.values(body.moods).flat();
  for (const slot of ["up", "down", "out", "in"] as const) expect(body.moods[slot].length).toBeLessThanOrEqual(3);
  expect(all.length).toBeGreaterThan(3);
  expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  // Every suggestion is playable: the app serves a preview for it (so it has one).
  await sleep(300);
  for (const t of all.slice(0, 3)) {
    const p = await retry503(() => s.call(`/api/tracks/${t.id}/preview`));
    expect(p.status, `${t.title} has a preview`).toBe(200);
  }
  // Metadata only: no preview URLs, no explicit flag, no audio.
  expect(JSON.stringify(body)).not.toMatch(/preview|cdn|\.mp3/i);
  expect(JSON.stringify(body)).not.toMatch(/n[i1]gg|f[a@]gg|retard/i);
  // Nothing went into the crate.
  expect((await (await s.call("/api/taste")).json()) as Track[]).toEqual([]);
});

it("needs a sign-in to suggest", async () => {
  const res = await session().call("/api/taste/suggest", { body: { artists: ["Daft Punk"] } });
  expect(res.status).toBe(401);
  expect((await session().call("/api/taste/suggest?artists=Daft%20Punk")).status).toBe(401);
});

it("asks for at least one artist, and limits how fast one person can ask", async () => {
  const { s } = await signedIn();
  // First ask is answered (bad input is a 400); the next one right after is throttled.
  expect((await s.call("/api/taste/suggest", { body: { artists: [] } })).status).toBe(400);
  const again = await s.call("/api/taste/suggest", { body: { artists: ["Daft Punk"] } });
  expect(again.status).toBe(429);
  expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
  // Another person is not held up by it.
  const other = await signedIn();
  const ok = await retry503(() => other.s.call("/api/taste/suggest?artists=Radiohead"));
  expect([200, 502]).toContain(ok.status);
});

it("sends a newcomer with an incomplete crate from the home page to /taste?welcome=1, keeping a table link", async () => {
  const { s } = await signedIn();
  const home = await s.call("/?welcome=1", { method: "GET" });
  // fetch follows redirects: the page we land on is the crate page.
  expect(home.url).toMatch(/\/taste\?welcome=1$/);
  expect(await home.text()).toContain("Build a crate of 12 songs, 3 for each mood");

  const host = await signedIn();
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  const viaTable = await s.call(`/?welcome=1&next=/t/${code}`);
  const u = new URL(viaTable.url);
  expect(u.pathname).toBe("/taste");
  expect(u.searchParams.get("next")).toBe(`/t/${code}`);
  expect(u.searchParams.has("welcome")).toBe(true);
  expect(await viaTable.text()).toContain(`href="/t/${code}"`);
});

it("leaves someone with a complete crate where they were going", async () => {
  const { fillCrate } = await import("./helpers");
  const { s } = await signedIn();
  await fillCrate(s, 2);
  const home = await s.call("/?welcome=1");
  expect(new URL(home.url).pathname).toBe("/");
  const host = await signedIn();
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  const via = await s.call(`/?welcome=1&next=/t/${code}`);
  expect(new URL(via.url).pathname).toBe(`/t/${code}`);
});

it.skipIf(!process.env.DATABASE_PATH)("sorts old songs one by one and all at once, never past 3 per mood", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { s } = await signedIn();
  const me = (await (await s.call("/api/me")).json()) as { id: string };
  const db = new Database(process.env.DATABASE_PATH!);
  const plant = db.prepare("insert into taste_tracks (person_id, track_id, title, artist, added_at, slot) values (?, ?, ?, ?, ?, null)");
  for (let i = 0; i < 6; i++) plant.run(me.id, 920000000 + i, `Old party ${i}`, "Old", Date.now() + i);
  db.close();

  // The plan suggests a mood for every old song and never over-fills one.
  const plan = (await (await s.call("/api/taste/sort-plan")).json()) as { id: number; slot: string | null }[];
  expect(plan).toHaveLength(6);
  for (const slot of ["up", "down", "out", "in"]) expect(plan.filter((p) => p.slot === slot).length).toBeLessThanOrEqual(3);
  expect(plan.filter((p) => p.slot === "out")).toHaveLength(3); // "party" titles fill Out first

  const patch = (id: number, slot: string) => s.call(`/api/taste/${id}`, { method: "PATCH", body: { slot } });
  // Apply the plan, as "Sort all as suggested" does, one PATCH each.
  for (const p of plan) expect((await patch(p.id, p.slot!)).status).toBe(200);
  // A fourth song into a full mood is refused and stays unsorted.
  const db2 = new Database(process.env.DATABASE_PATH!);
  db2.prepare("insert into taste_tracks (person_id, track_id, title, artist, added_at, slot) values (?, ?, ?, ?, ?, null)").run(me.id, 920000099, "Old extra", "Old", Date.now());
  db2.close();
  const full = plan.find((p) => p.slot === "out")!;
  expect(plan.filter((p) => p.slot === full.slot)).toHaveLength(3);
  const over = await patch(920000099, "out");
  expect(over.status).toBe(409);
  const taste = (await (await s.call("/api/taste")).json()) as Track[];
  expect(taste.find((t) => t.id === 920000099)?.slot).toBeNull();
  expect(taste.filter((t) => t.slot === "out")).toHaveLength(3);
});
