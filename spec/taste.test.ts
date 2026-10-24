import { expect, it, vi } from "vitest";
import { fillCrate, session, uniqueName } from "./helpers";

// These go through Deezer, which answers in 2-4s from the Fly machine in
// Sydney: the default 5s limit timed out on the live app, not the app itself.
vi.setConfig({ testTimeout: 60_000 });

// Contract: a person's crate is 12 tracks they'd actually play, 3 in each of the
// slots "up", "down", "out" and "in" (decision 0009). It persists.
//   GET    /api/search?q=...     -> [{id, title, artist}] (Deezer catalogue)
//   GET    /api/taste            -> [{id, title, artist, slot}] for this session's person
//   POST   /api/taste {trackId, slot} -> adds it; metadata comes from Deezer, not the client;
//        a full slot or a full crate is a 409
//   PATCH  /api/taste/:trackId {slot} -> moves it to a slot with room (409 if full)
//   DELETE /api/taste/:trackId   -> removes it
// Tracks are stored by Deezer id; audio is never hosted (CLAUDE.md).

type Track = { id: number; title: string; artist: string; slot?: string };
const MAX = 12;

async function signedIn(name = uniqueName("tst"), pin = "8642") {
  const s = session();
  await s.call("/api/join", { body: { name, pin } });
  return { s, name, pin };
}

async function search(s: ReturnType<typeof session>, q: string): Promise<Track[]> {
  const res = await s.call(`/api/search?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Track[];
}

it("searches the catalogue for tracks to add", async () => {
  const { s } = await signedIn();
  const results = await search(s, "daft punk");
  expect(results.length).toBeGreaterThan(0);
  expect(typeof results[0].id).toBe("number");
  expect(results[0].title).toBeTruthy();
  expect(results[0].artist).toBeTruthy();
});

it("keeps a taste file that a returning person finds again", async () => {
  const { s, name, pin } = await signedIn();
  const [first, second] = await search(s, "radiohead");
  expect((await s.call("/api/taste", { body: { trackId: first.id, slot: "up" } })).status).toBeLessThan(300);
  expect((await s.call("/api/taste", { body: { trackId: second.id, slot: "down" } })).status).toBeLessThan(300);

  // The same person on another device.
  const again = session();
  await again.call("/api/join", { body: { name, pin } });
  const taste = (await (await again.call("/api/taste")).json()) as Track[];
  expect(taste.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
  expect(taste.find((t) => t.id === first.id)?.title).toBe(first.title);
});

it("takes the track's details from the catalogue, not from the client", async () => {
  const { s } = await signedIn();
  const [track] = await search(s, "fleetwood mac dreams");
  await s.call("/api/taste", { body: { trackId: track.id, slot: "in", title: "forged title" } });
  const taste = (await (await s.call("/api/taste")).json()) as Track[];
  expect(taste.find((t) => t.id === track.id)?.title).toBe(track.title);
});

it("refuses a track id the catalogue doesn't know", async () => {
  const { s } = await signedIn();
  const res = await s.call("/api/taste", { body: { trackId: 1, slot: "up" } });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

it("removes a track, and adding one twice keeps one copy", async () => {
  const { s } = await signedIn();
  const [a, b] = await search(s, "beyonce");
  await s.call("/api/taste", { body: { trackId: a.id, slot: "out" } });
  await s.call("/api/taste", { body: { trackId: a.id, slot: "out" } });
  await s.call("/api/taste", { body: { trackId: b.id, slot: "out" } });
  expect(((await (await s.call("/api/taste")).json()) as Track[]).filter((t) => t.id === a.id)).toHaveLength(1);

  expect((await s.call(`/api/taste/${a.id}`, { method: "DELETE" })).status).toBeLessThan(300);
  const left = (await (await s.call("/api/taste")).json()) as Track[];
  expect(left.map((t) => t.id)).toEqual([b.id]);
});

it("holds 3 per slot and 12 in all: a fourth in a slot is a 409, and a full crate is complete", async () => {
  const { s } = await signedIn();
  const ids = await fillCrate(s, 3);
  const taste = (await (await s.call("/api/taste")).json()) as Track[];
  expect(taste).toHaveLength(MAX);
  for (const slot of ["up", "down", "out", "in"]) expect(taste.filter((t) => t.slot === slot)).toHaveLength(3);
  // Every slot is full, so one more anywhere is a 409 (slot full) and nothing is added.
  const [extra] = await search(s, "love");
  const res = await s.call("/api/taste", { body: { trackId: extra.id, slot: "up" } });
  expect(res.status).toBe(409);
  expect(((await (await s.call("/api/taste")).json()) as Track[]).length).toBe(MAX);
  // Free a place in "out" and a track fits there but still not in "up".
  await s.call(`/api/taste/${ids[6]}`, { method: "DELETE" });
  expect((await s.call("/api/taste", { body: { trackId: extra.id, slot: "up" } })).status).toBe(409);
  expect((await s.call("/api/taste", { body: { trackId: extra.id, slot: "out" } })).status).toBe(201);
});

it("refuses a missing or unknown slot, and moves a track only to a slot with room", async () => {
  const { s } = await signedIn();
  const [a, b] = await search(s, "queen");
  expect((await s.call("/api/taste", { body: { trackId: a.id } })).status).toBe(400);
  expect((await s.call("/api/taste", { body: { trackId: a.id, slot: "sideways" } })).status).toBe(400);
  await s.call("/api/taste", { body: { trackId: a.id, slot: "up" } });
  await s.call("/api/taste", { body: { trackId: b.id, slot: "up" } });
  const moved = await s.call(`/api/taste/${a.id}`, { method: "PATCH", body: { slot: "down" } });
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as Track[]).find((t) => t.id === a.id)?.slot).toBe("down");
  expect((await s.call(`/api/taste/${a.id}`, { method: "PUT", body: { slot: "in" } })).status).toBe(200);
  expect((await s.call(`/api/taste/${a.id}`, { method: "PATCH", body: { slot: "nope" } })).status).toBe(400);
  expect((await s.call("/api/taste/999999999", { method: "PATCH", body: { slot: "up" } })).status).toBe(404);
  // Fill "down" with three others and a fourth move into it is a 409.
  const more = (await search(s, "abba")).slice(0, 4);
  for (const t of more.slice(0, 3)) await s.call("/api/taste", { body: { trackId: t.id, slot: "down" } });
  expect((await s.call(`/api/taste/${a.id}`, { method: "PATCH", body: { slot: "down" } })).status).toBe(409);
});

it("keeps taste files private to their session's person", async () => {
  const anonymous = session();
  expect((await anonymous.call("/api/taste")).status).toBe(401);
  expect((await anonymous.call("/api/taste", { body: { trackId: 3135556, slot: "up" } })).status).toBe(401);
});

it("serves the crate builder with the four slot dividers, and a home page with no moles selector", async () => {
  const { s } = await signedIn();
  const page = await s.call("/taste");
  expect(page.status).toBe(200);
  const html = await page.text();
  for (const name of ["Up", "Down", "Out", "In"]) expect(html).toMatch(new RegExp(`<h2[^>]*>${name}</h2>`));
  expect(html).toContain("energy, hype");
  const home = await (await s.call("/")).text();
  expect(home).not.toMatch(/id="moles"/);
  expect(home).toContain("/ 12");
});

// Old rows from before slots have no slot. They can't be made over the API, so this
// plants them in the app's own database: it runs where DATABASE_PATH points at that file
// (a local run), and is skipped against a remote or containerised app.
it.skipIf(!process.env.DATABASE_PATH)("doesn't let unsorted legacy songs fill the crate, and counts only sorted songs as ready", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { s, name } = await signedIn();
  const me = (await (await s.call("/api/me")).json()) as { id: string };
  const db = new Database(process.env.DATABASE_PATH!);
  const plant = db.prepare("insert into taste_tracks (person_id, track_id, title, artist, added_at, slot) values (?, ?, ?, ?, ?, null)");
  // Fourteen old songs: more than the whole crate.
  for (let i = 0; i < 14; i++) plant.run(me.id, 900000000 + i, `Old ${i}`, "Old", Date.now() + i);
  db.close();
  expect(((await (await s.call("/api/taste")).json()) as Track[]).filter((t) => !t.slot)).toHaveLength(14);
  // A full, sorted crate still goes in beside them, and then is complete.
  await fillCrate(s, 5);
  const taste = (await (await s.call("/api/taste")).json()) as Track[];
  for (const slot of ["up", "down", "out", "in"]) expect(taste.filter((t) => t.slot === slot)).toHaveLength(3);
  const { code } = (await (await s.call("/api/tables", { body: {} })).json()) as { code: string };
  const pub = (await (await s.call(`/api/tables/${code}`)).json()) as { members: { name: string; crateReady: boolean }[] };
  expect(pub.members.find((m) => m.name === name)?.crateReady).toBe(true);
});

it.skipIf(!process.env.DATABASE_PATH)("a person with only unsorted songs isn't ready, however many they have", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { s, name } = await signedIn();
  const me = (await (await s.call("/api/me")).json()) as { id: string };
  const db = new Database(process.env.DATABASE_PATH!);
  const plant = db.prepare("insert into taste_tracks (person_id, track_id, title, artist, added_at, slot) values (?, ?, ?, ?, ?, null)");
  for (let i = 0; i < 12; i++) plant.run(me.id, 910000000 + i, `Old ${i}`, "Old", Date.now() + i);
  db.close();
  const { code } = (await (await s.call("/api/tables", { body: {} })).json()) as { code: string };
  const pub = (await (await s.call(`/api/tables/${code}`)).json()) as { members: { name: string; crateReady: boolean }[] };
  expect(pub.members.find((m) => m.name === name)?.crateReady).toBe(false);
  // And one sorted song still goes in.
  const [first] = await search(s, "radiohead");
  expect((await s.call("/api/taste", { body: { trackId: first.id, slot: "up" } })).status).toBe(201);
});
