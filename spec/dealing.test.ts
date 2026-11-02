import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Contract (CLAUDE.md "Formats", decision 0010): Four rounds moles are dealt weighted, never certain.
// A pure simulation over the engine's own dealOrder (no server): from the public history of earlier
// rounds' moles the room must never be able to name this round's moles for certain, and the most-dealt
// player's share should stay near a uniform deal's rather than run away.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "deal-spec-")), "app.db");
vi.setConfig({ testTimeout: 120_000 });
const { dealOrder, dealWeight } = await import("../src/lib/game.ts");

// A small seeded generator, so the spec can't flake.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// The old rule, kept only to compare against: nobody twice until everyone has been once.
function oldDeal(history: string[][], ids: string[], count: number, rand: () => number): string[] {
  let seen = new Set<string>();
  const full = () => ids.every((i) => seen.has(i));
  for (const r of history) for (const m of r) { seen.add(m); if (full()) seen = new Set(); }
  const chosen: string[] = [];
  while (chosen.length < Math.min(count, ids.length)) {
    const free = ids.filter((i) => !seen.has(i) && !chosen.includes(i));
    const pool = free.length ? free : ids.filter((i) => !chosen.includes(i));
    const pick = pool[Math.floor(rand() * pool.length)];
    chosen.push(pick); seen.add(pick);
    if (full()) seen = new Set();
  }
  return chosen;
}
const uniformDeal = (_h: string[][], ids: string[], count: number, rand: () => number) => {
  const pool = [...ids]; const out: string[] = [];
  while (out.length < count) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
};

type Dealer = (h: string[][], ids: string[], k: number, rand: () => number) => string[];
function play(deal: Dealer, n: number, k: number, rand: () => number) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const hist: string[][] = [];
  for (let r = 0; r < 4; r++) hist.push(deal(hist, ids, k, rand));
  const count = new Map<string, number>();
  for (const m of hist.flat()) count.set(m, (count.get(m) ?? 0) + 1);
  return { hist, max: Math.max(...count.values()) / (4 * k), ids };
}

const shapes: [number, number][] = [];
for (let n = 3; n <= 8; n++) for (const k of [1, 2]) if (k <= Math.max(1, Math.floor(n / 3))) shapes.push([n, k]);

it("never lets the room name a round's moles for certain from the public history", () => {
  const rand = lcg(7);
  const GAMES = 3000;
  for (const [n, k] of shapes) {
    const seenDealt = new Set<string>();
    for (let g = 0; g < GAMES; g++) {
      const { hist, ids } = play(dealOrder, n, k, rand);
      for (let r = 0; r < 4; r++) {
        // Exact check: every seated person has a positive chance given the history before round r.
        const times = new Map<string, number>();
        for (const m of hist.slice(0, r).flat()) times.set(m, (times.get(m) ?? 0) + 1);
        for (const id of ids) expect(dealWeight(times.get(id) ?? 0)).toBeGreaterThan(0);
        for (const m of hist[r]) seenDealt.add(`${r}:${m}`);
      }
    }
    // Empirical check: in every round, every seated person was dealt at least once, including round 4.
    for (let r = 0; r < 4; r++) for (let i = 0; i < n; i++) expect(seenDealt.has(`${r}:p${i}`), `n=${n} k=${k} round ${r + 1} p${i}`).toBe(true);
    // With 1 mole and a history where one person has been the mole in every earlier round, they can still be dealt again.
    if (k === 1) {
      let again = 0;
      for (let g = 0; g < 4000; g++) if (dealOrder([["p0"], ["p0"], ["p0"]], Array.from({ length: n }, (_, i) => `p${i}`), 1, rand)[0] === "p0") again++;
      expect(again).toBeGreaterThan(0);
    }
  }
});

it("keeps the most-dealt player's share near a uniform deal's, far below what a pure repeat would give (numbers reported)", () => {
  const rand = lcg(11);
  const GAMES = 4000;
  const rows: string[] = [];
  let oldCertain = 0;
  for (const [n, k] of shapes) {
    const share = { weighted: 0, uniform: 0, old: 0 };
    for (let g = 0; g < GAMES; g++) {
      share.weighted += play((h, i, c, r) => dealOrder(h, i, c, r), n, k, rand).max;
      share.uniform += play(uniformDeal, n, k, rand).max;
      const o = play(oldDeal, n, k, rand);
      share.old += o.max;
      // The old rule: the last round's moles are certain when only that many people are left unused.
      const used = new Set(o.hist.slice(0, 3).flat());
      if (n - used.size === k && used.size <= n) oldCertain++;
    }
    const w = share.weighted / GAMES, u = share.uniform / GAMES, o = share.old / GAMES;
    rows.push(`n=${n} moles=${k}  most-dealt share  weighted ${w.toFixed(3)}  uniform ${u.toFixed(3)}  old no-repeat ${o.toFixed(3)}`);
    // Weighted evens things out: no more concentrated than uniform, and not wildly less even than the old rule.
    expect(w).toBeLessThanOrEqual(u + 0.005);
    expect(w).toBeGreaterThanOrEqual(o - 0.001);
    expect(w).toBeLessThan(u);
  }
  process.stderr.write(`\nDealing simulation, ${GAMES} games per shape, 4 rounds\n${rows.join("\n")}\nold rule: round 4 deducible for certain in ${oldCertain} of the simulated games\n`);
});
