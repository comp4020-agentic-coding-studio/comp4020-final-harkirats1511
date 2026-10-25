import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { session, uniqueName } from "./helpers";

// Contract: suggestions are clean (neither Deezer explicit flag, no slur even when censored), the
// artist is the famous one (most fans among name matches), and every Deezer call the server makes
// goes through one token bucket in which card audio and previews come before everything else.

vi.setConfig({ testTimeout: 90_000 });
process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), "explicit-spec-")), "app.db");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("catches censored and spaced-out slurs, and passes ordinary song titles", async () => {
  const { UNSAYABLE, suggestable } = await import("../src/lib/deezer.ts");
  for (const bad of ["Ni**as in Paris", "n**", "N***** Please", "n*gg", "n i g g a", "N.I.G.G.A", "niggas", "f*g", "F**", "f a g g o t", "faggot", "C*nt", "Wh*re"]) {
    expect(UNSAYABLE.test(bad), bad).toBe(true);
  }
  const normal = [
    "Bohemian Rhapsody", "Hotel California", "Billie Jean", "Smells Like Teen Spirit", "Stairway to Heaven", "Wonderwall",
    "Nightcall", "Niggle", "Night Fever", "Nothing Else Matters", "Nights in White Satin", "Nineteen", "Nine in the Afternoon",
    "Fagin's Lament", "Fag End", "Fugees", "Flagpole Sitta", "F.E.A.R.", "FM", "F.U.N.", "N.W.A", "NWA", "N-Dubz", "N.E.R.D", "N.Y. State of Mind", "NY Is Killing Me",
    "N'Sync", "N Sync", "Snigger Snack", "Slutsky Waltz", "Wholesome",
    "Cunning Stunts", "Return of the Mack", "Under Pressure", "Dancing Queen", "Take On Me",
    "Gangnam Style", "Mr. Brightside", "Seven Nation Army", "Africa", "Lose Yourself", "Mo Bamba", "Nuthin' but a G Thang", "99 Problems",
  ];
  for (const ok of normal) expect(UNSAYABLE.test(ok), ok).toBe(false);
  // Both of Deezer's explicit flags drop a track, as does a slur in its title or artist.
  const base = { id: 1, title: "Fine", preview: "x", artist: { name: "A" } };
  expect(suggestable(base)).not.toBeNull();
  expect(suggestable({ ...base, explicit_lyrics: true })).toBeNull();
  expect(suggestable({ ...base, explicit_content_lyrics: 1 })).toBeNull();
  expect(suggestable({ ...base, title: "n*gg" })).toBeNull();
  expect(suggestable({ ...base, preview: "" })).toBeNull();
});

it("picks the artist with most fans among near-exact name matches", async () => {
  const { pickArtist } = await import("../src/lib/deezer.ts");
  const rows = [
    { id: 1, name: "BTS", fans: 4298 },
    { id: 2, name: "BTS", fans: 3_870_000 },
    { id: 3, name: "BTS Tribute Band", fans: 99_000_000 },
    { id: 4, name: "B.T.S", fans: 12 },
  ];
  expect(pickArtist(rows, "bts")?.id).toBe(2);
  expect(pickArtist([{ id: 5, name: "Rosalia", fans: 10 }, { id: 6, name: "Rosalía", fans: 900 }], "Rosalía")?.id).toBe(6);
  expect(pickArtist([{ id: 7, name: "The Beatles", fans: 5 }, { id: 8, name: "Beatles", fans: 50 }], "the beatles")?.id).toBe(8);
  // No exact match: a near one with fans, else Deezer's first.
  expect(pickArtist([{ id: 9, name: "Lil Wayne & Co", fans: 1 }, { id: 10, name: "Lil Wayne Jr", fans: 50 }], "Lil Wayne")?.id).toBe(10);
  expect(pickArtist([], "x")).toBeNull();
});

it("the Deezer bucket serves card audio first, makes low priorities wait or give up, and never exceeds its window", async () => {
  const { Bucket } = await import("../src/lib/bucket.ts");
  const b = new Bucket({ limit: 10, windowMs: 400, reserve: { card: 0, normal: 2, suggest: 4, background: 7 } });
  // Background stops at 3, suggest at 6, normal at 8, card at 10: the lower the class, the sooner it is held.
  const took = (p: "card" | "normal" | "suggest" | "background") => { let n = 0; while (b.tryTake(p)) n++; return n; };
  expect(took("background")).toBe(3);
  expect(took("suggest")).toBe(3);
  expect(took("normal")).toBe(2);
  expect(took("card")).toBe(2);
  expect(b.inWindow()).toBe(10);
  // Starters pile up behind a full bucket; a card call still gets through as soon as the window moves,
  // ahead of all of them, and the starters can't have used its room.
  const waiting = Array.from({ length: 6 }, () => b.take("suggest", 2000));
  const t0 = Date.now();
  expect(await b.take("card", 2000)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(500);
  // A low priority with no patience gives up rather than queue.
  expect(await b.take("background", 50)).toBe(false);
  await Promise.all(waiting);
  // In any window of 400 ms it never let more than 10 through.
  expect(b.inWindow()).toBeLessThanOrEqual(10);
});

async function signedIn() {
  const s = session();
  await s.call("/api/join", { body: { name: uniqueName("xp"), pin: "8642" } });
  return s;
}
async function suggest(s: ReturnType<typeof session>, artists: string[]) {
  for (let attempt = 0; ; attempt++) {
    const res = await s.call("/api/taste/suggest", { body: { artists } });
    if ((res.status === 429 || res.status === 503) && attempt < 5) { await sleep(res.status === 429 ? 3200 : 3000); continue; }
    return res;
  }
}

// Network: needs Deezer, like the rest of the starter's specs.
it("suggests nothing explicit for an artist whose top tracks are mostly explicit (Eminem)", async () => {
  const s = await signedIn();
  const res = await suggest(s, ["Eminem"]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { moods: Record<string, { id: number }[]> };
  const ids = Object.values(body.moods).flat().map((t) => t.id);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids.slice(0, 8)) {
    const t = (await (await fetch(`https://api.deezer.com/track/${id}`)).json()) as { explicit_lyrics?: boolean; explicit_content_lyrics?: number };
    expect(t.explicit_lyrics, `track ${id}`).toBeFalsy();
    expect(t.explicit_content_lyrics, `track ${id}`).not.toBe(1);
    await sleep(150);
  }
});

it("finds the real BTS, not the look-alike account listed first: at least 6 suggestions", async () => {
  const s = await signedIn();
  const res = await suggest(s, ["BTS"]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { moods: Record<string, unknown[]> };
  expect(Object.values(body.moods).flat().length).toBeGreaterThanOrEqual(6);
});

it("gives Drake, whose top tracks are mostly explicit, a full starter from the clean ones and artists like him", async () => {
  const s = await signedIn();
  const res = await suggest(s, ["Drake"]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { artists: string[]; moods: Record<string, unknown[]> };
  expect(body.artists).toEqual(["Drake"]);
  expect(Object.values(body.moods).flat().length).toBeGreaterThanOrEqual(6);
});

it("four people asking for starters at once don't take previews away from a fifth", async () => {
  const askers = await Promise.all(Array.from({ length: 4 }, signedIn));
  const listener = await signedIn();
  const results = await Promise.all(askers.map((s, i) => s.call("/api/taste/suggest", { body: { artists: [["Radiohead", "Adele", "Coldplay"], ["Queen", "ABBA", "Oasis"], ["Madonna", "Prince", "Blur"], ["Rihanna", "Muse", "Pulp"]][i] } })));
  const codes = results.map((r) => r.status);
  for (const c of codes) expect([200, 429, 502, 503]).toContain(c);
  expect(codes.filter((c) => c === 200).length, `starters: ${codes}`).toBeGreaterThanOrEqual(2);
  // Right away, from another session: previews must not 503.
  const previews: number[] = [];
  for (const id of [13159670, 829306252, 1951194607, 684573392, 3099606]) {
    previews.push((await listener.call(`/api/tracks/${id}/preview`)).status);
  }
  expect(previews.filter((c) => c === 503), `previews: ${previews}`).toEqual([]);
});
