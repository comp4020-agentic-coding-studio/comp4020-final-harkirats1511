import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

// Rules checked on the engine itself against a scratch database (this file never touches the
// running app's): the steal's options are shuffled, a vote after its deadline doesn't count, a
// failing timer step doesn't take the process down, the shop's full answer, and the 3D scene
// can reach neither /me nor the database.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "rules-spec-")), "app.db");
vi.setConfig({ testTimeout: 120_000 });
// The engine logs every action; thousands of lines through the worker channel would only slow teardown.
vi.spyOn(console, "log").mockImplementation(() => {});

const { db } = await import("../src/lib/db.ts");
const S = await import("../src/lib/schema.ts");
const G = await import("../src/lib/game.ts");
const T = await import("../src/lib/tables.ts");
const L = await import("../src/lib/log.ts");
const { eq, and } = await import("drizzle-orm");

const SLOTS = ["up", "down", "out", "in"] as const;
let seq = 0;
function world(n: number) {
  const code = `R${String(++seq).padStart(3, "0")}`;
  const now = Date.now();
  const ids: string[] = [];
  const names: string[] = [];
  const base: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    names.push(`r${seq}x${i}`);
    base.push(5_000_000 + seq * 1000 + i * 20);
    db.insert(S.people).values({ id, name: names[i], pinHash: "x", pinSalt: "x", createdAt: now }).run();
    for (let j = 0; j < 12; j++) {
      db.insert(S.tasteTracks).values({ personId: id, trackId: base[i] + j, title: `t${base[i] + j}`, artist: `a${i}`, slot: SLOTS[Math.floor(j / 3)], addedAt: now + j }).run();
    }
  }
  db.insert(S.tables).values({ code, hostPersonId: ids[0], status: "open", format: "knockout", createdAt: now }).run();
  ids.forEach((id, i) => db.insert(S.tableMembers).values({ tableCode: code, personId: id, joinedAt: now + i }).run());
  expect(G.startGame(code)).toEqual({ ok: true });
  return { code, ids, names, base };
}
const game = (code: string) => T.currentGame(code)!;
const lock = (code: string) => {
  db.update(S.games).set({ deadline: Date.now() - 1 }).where(eq(S.games.id, game(code).id)).run();
  G.schedule(code);
};
const moleOf = (w: ReturnType<typeof world>) =>
  db.select().from(S.gamePlayers).where(and(eq(S.gamePlayers.gameId, game(w.code).id), eq(S.gamePlayers.role, "mole"))).get()!.personId;
function toVote(w: ReturnType<typeof world>) {
  w.ids.forEach((id, i) => expect(G.pickTrack(w.code, id, w.base[i])).toEqual({ ok: true }));
  expect(G.advance(w.code)).toEqual({ ok: true });
}

it("shuffles the real prompt among the 8 steal options: its position is uniform over many steals", () => {
  const N = 480;
  const hits = Array<number>(8).fill(0);
  for (let i = 0; i < N; i++) {
    const w = world(4);
    const mole = moleOf(w);
    toVote(w);
    w.ids.forEach((id) => G.castVote(w.code, id, id === mole ? "skip" : { name: w.names[w.ids.indexOf(mole)] }));
    lock(w.code);
    expect(game(w.code).phase).toBe("steal");
    const real = db.select().from(S.gamePrompts).where(and(eq(S.gamePrompts.gameId, game(w.code).id), eq(S.gamePrompts.round, 1))).get()!.promptId;
    const options = G.myView(w.code, mole).steal!.options.map((o) => o.id);
    expect(options).toHaveLength(8);
    hits[options.indexOf(real)]++;
  }
  // Chi-square against uniform, 7 degrees of freedom. 24.3 is the 0.1% point, so a fair shuffle passes
  // 999 times in 1000; 40 is far past it, so the check can't flake and still catches a fixed or biased place
  // (a real prompt always first scores about 3,360).
  const expected = N / 8;
  const chi = hits.reduce((s, h) => s + (h - expected) ** 2 / expected, 0);
  expect(hits.every((h) => h > 0), `positions ${hits}`).toBe(true);
  expect(chi, `positions ${hits}`).toBeLessThan(40);
});

it("doesn't count a vote that arrives after the deadline", () => {
  const w = world(4);
  toVote(w);
  const [a, b, c, d] = w.ids;
  expect(G.castVote(w.code, a, { name: w.names[1] })).toEqual({ ok: true });
  // The deadline passes but the timer hasn't fired yet: a late vote is refused and stores nothing.
  db.update(S.games).set({ deadline: Date.now() - 5 }).where(eq(S.games.id, game(w.code).id)).run();
  const late = G.castVote(w.code, c, { name: w.names[1] });
  expect(late).toMatchObject({ ok: false, status: 409 });
  const rows = db.select().from(S.votes).where(and(eq(S.votes.gameId, game(w.code).id), eq(S.votes.round, 1))).all();
  expect(rows.map((r) => r.voterPersonId)).toEqual([a]);
  void b; void d;
});

it("logs a failing timer step and keeps going instead of throwing", () => {
  const w = world(3);
  toVote(w);
  // A broken game row: ending the vote throws inside the step. The timer path must swallow it.
  db.update(S.games).set({ slotOrder: "{not json", deadline: Date.now() - 1, phase: "reveal" }).where(eq(S.games.id, game(w.code).id)).run();
  expect(() => G.schedule(w.code)).not.toThrow();
  const line = L.recentLines(w.code).find((l) => /timer step failed: /.test(l));
  expect(line, "a timer step failed line").toBeTruthy();
  expect(line).not.toMatch(/\{not json\}/);
});

it("answers the 41st person at the shop with a clear message, the cap and the booth list", async () => {
  const Shop = await import("../src/lib/shop.ts");
  const now = Date.now();
  const leave: (() => void)[] = [];
  for (let i = 0; i < Shop.MAX_PEOPLE; i++) {
    const id = randomUUID();
    db.insert(S.people).values({ id, name: `shopfull${i}`, pinHash: "x", pinSalt: "x", createdAt: now }).run();
    leave.push(Shop.enter({ id, name: `shopfull${i}` } as never, () => {})!.leave);
  }
  expect(Shop.isFull(randomUUID())).toBe(true);
  const body = Shop.fullBody();
  expect(body).toMatchObject({ full: true, max: 40 });
  expect(body.error).toMatch(/full/i);
  expect(Array.isArray(body.booths)).toBe(true);
  for (const l of leave) l();
});

// The 3D scene runs in the browser beside the page: whatever it imports ships to every visitor
// and runs next to the player's own /me. It may import nothing that reaches the database, the
// session or the game engine, and never calls /me itself. (Type-only imports are erased.)
it("imports nothing in src/scene that can reach /me or the database", () => {
  const root = resolve(import.meta.dirname, "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.(ts|js)$/.test(f) ? [join(dir, f)] : []));
  const importsOf = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/gms)) {
      if (m[2]) continue; // import type
      out.push(m[4]);
    }
    for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
    for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
    return out;
  };
  const reach = new Set<string>();
  const queue = files(join(root, "scene"));
  const bare = new Set<string>();
  while (queue.length) {
    const f = queue.pop()!;
    if (reach.has(f)) continue;
    reach.add(f);
    for (const spec of importsOf(f)) {
      if (!spec.startsWith(".")) { bare.add(spec); continue; }
      const p = resolve(dirname(f), spec);
      for (const cand of [p, `${p}.ts`, `${p}.js`]) if (reach.has(cand) === false && /\.(ts|js)$/.test(cand)) { try { statSync(cand); queue.push(cand); break; } catch { /* next */ } }
    }
  }
  const rel = [...reach].map((f) => f.slice(root.length + 1));
  for (const banned of ["db.ts", "schema.ts", "auth.ts", "game.ts", "tables.ts", "taste.ts", "history.ts", "shop.ts", "bots/", "deezer.ts", "log.ts"]) {
    expect(rel.filter((f) => f.includes(banned)), `scene reaches ${banned}`).toEqual([]);
  }
  for (const b of bare) expect(b, `scene imports ${b}`).not.toMatch(/better-sqlite3|drizzle|node:|astro:/);
  for (const f of reach) {
    if (!f.startsWith(join(root, "scene"))) continue;
    expect(readFileSync(f, "utf8"), f).not.toMatch(/\/api\/tables\/[^"'`]*\/me|["'`]\/me["'`]|api\/me\b/);
  }
});
