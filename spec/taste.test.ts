import { expect, it, vi } from "vitest";
import { session, uniqueName } from "./helpers";

// These go through Deezer, which answers in 2-4s from the Fly machine in
// Sydney: the default 5s limit timed out on the live app, not the app itself.
vi.setConfig({ testTimeout: 60_000 });

// Contract: a person's taste file is up to 10 tracks they'd actually play. It is
// what a mole studies from the very first game, so it has to persist.
//   GET    /api/search?q=...     -> [{id, title, artist}] (Deezer catalogue)
//   GET    /api/taste            -> [{id, title, artist}] for this session's person
//   POST   /api/taste {trackId}  -> adds it; metadata comes from Deezer, not the client
//   DELETE /api/taste/:trackId   -> removes it
// Tracks are stored by Deezer id; audio is never hosted (CLAUDE.md).

type Track = { id: number; title: string; artist: string };
const MAX = 10;

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
  expect((await s.call("/api/taste", { body: { trackId: first.id } })).status).toBeLessThan(300);
  expect((await s.call("/api/taste", { body: { trackId: second.id } })).status).toBeLessThan(300);

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
  await s.call("/api/taste", { body: { trackId: track.id, title: "forged title" } });
  const taste = (await (await s.call("/api/taste")).json()) as Track[];
  expect(taste.find((t) => t.id === track.id)?.title).toBe(track.title);
});

it("refuses a track id the catalogue doesn't know", async () => {
  const { s } = await signedIn();
  const res = await s.call("/api/taste", { body: { trackId: 1 } });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

it("removes a track, and adding one twice keeps one copy", async () => {
  const { s } = await signedIn();
  const [a, b] = await search(s, "beyonce");
  await s.call("/api/taste", { body: { trackId: a.id } });
  await s.call("/api/taste", { body: { trackId: a.id } });
  await s.call("/api/taste", { body: { trackId: b.id } });
  expect(((await (await s.call("/api/taste")).json()) as Track[]).filter((t) => t.id === a.id)).toHaveLength(1);

  expect((await s.call(`/api/taste/${a.id}`, { method: "DELETE" })).status).toBeLessThan(300);
  const left = (await (await s.call("/api/taste")).json()) as Track[];
  expect(left.map((t) => t.id)).toEqual([b.id]);
});

it(`caps a taste file at ${MAX} tracks`, async () => {
  const { s } = await signedIn();
  const results = (await search(s, "love")).slice(0, MAX + 1);
  expect(results.length).toBe(MAX + 1);
  for (const t of results.slice(0, MAX)) {
    expect((await s.call("/api/taste", { body: { trackId: t.id } })).status).toBeLessThan(300);
  }
  expect((await s.call("/api/taste", { body: { trackId: results[MAX].id } })).status).toBe(409);
});

it("keeps taste files private to their session's person", async () => {
  const anonymous = session();
  expect((await anonymous.call("/api/taste")).status).toBe(401);
  expect((await anonymous.call("/api/taste", { body: { trackId: 3135556 } })).status).toBe(401);
});
