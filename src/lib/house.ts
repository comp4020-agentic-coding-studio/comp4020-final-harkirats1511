import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { topTracksWithPreview } from "./deezer.ts";
import { gamePlayers, tableMembers, tasteTracks } from "./schema.ts";

// The house record (decision 0008): one extra track per round, by an artist from
// a random player's crate, that is in nobody's crate at the table. It is looked
// up from Deezer while people are picking, held here in memory (it is not game
// state until assignSlots writes it as a pick row), and used only if it is ready
// when picking ends. The lookup has a hard budget so the game never waits for it.

export const HOUSE_ID = "house";
export const HOUSE_BUDGET_MS = 2500;

export type House = { trackId: number; title: string; artist: string; cover: string | null; inspiredBy: string };
type Entry = { at: number; done: boolean; result: House | null; settled: Promise<void> };

const entries = new Map<string, Entry>();
const key = (gameId: string, round: number) => `${gameId}:${round}`;
const pick = <T>(xs: T[]): T => xs[randomInt(xs.length)];

// Everyone who may have a crate here: the game's players still in it, plus the
// table's members (a spectator's crate counts for "not in any crate").
function crateOwners(code: string, gameId: string): { players: string[]; everyone: string[] } {
  const players = db
    .select({ id: gamePlayers.personId })
    .from(gamePlayers)
    .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.left, 0)))
    .all()
    .map((r) => r.id);
  const members = db.select({ id: tableMembers.personId }).from(tableMembers).where(eq(tableMembers.tableCode, code)).all().map((r) => r.id);
  return { players, everyone: [...new Set([...players, ...members])] };
}

async function prepare(code: string, gameId: string, until: number): Promise<House | null> {
  const { players, everyone } = crateOwners(code, gameId);
  if (!everyone.length) return null;
  const crates = db
    .select({ p: tasteTracks.personId, id: tasteTracks.trackId, artist: tasteTracks.artist })
    .from(tasteTracks)
    .where(inArray(tasteTracks.personId, everyone))
    .all();
  const owned = new Set(crates.map((c) => c.id));
  // Equal weight per player: a random player, then a random artist of theirs.
  const artistsOf = new Map<string, string[]>();
  for (const p of players) {
    const names = [...new Set(crates.filter((c) => c.p === p).map((c) => c.artist))];
    if (names.length) artistsOf.set(p, names);
  }
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 3 && Date.now() < until - 150; attempt++) {
    const open = [...artistsOf].filter(([, names]) => names.some((n) => !tried.has(n.toLowerCase())));
    if (!open.length) return null;
    const [person, names] = pick(open);
    const artist = pick(names.filter((n) => !tried.has(n.toLowerCase())));
    tried.add(artist.toLowerCase());
    const tracks = (await topTracksWithPreview(artist, until - Date.now())).filter((t) => !owned.has(t.id));
    if (tracks.length) {
      const t = pick(tracks);
      return { trackId: t.id, title: t.title, artist: t.artist, cover: t.cover ?? null, inspiredBy: person };
    }
  }
  return null;
}

// Start looking for this round's house record, once. Safe to call again.
export function ensureHouse(code: string, gameId: string, round: number): Entry {
  const k = key(gameId, round);
  const have = entries.get(k);
  if (have) return have;
  for (const [old, e] of entries) if (Date.now() - e.at > 10 * 60_000) entries.delete(old);
  const entry: Entry = { at: Date.now(), done: false, result: null, settled: Promise.resolve() };
  const until = entry.at + HOUSE_BUDGET_MS;
  const finish = (r: House | null) => {
    if (!entry.done) {
      entry.done = true;
      entry.result = r;
    }
  };
  let timer: NodeJS.Timeout;
  entry.settled = Promise.race([
    prepare(code, gameId, until).catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HOUSE_BUDGET_MS); }),
  ]).then((r) => { clearTimeout(timer); finish(r); });
  entries.set(k, entry);
  return entry;
}

// The result, if the lookup has finished (found or not); otherwise undefined.
export function houseIfSettled(gameId: string, round: number): House | null | undefined {
  const e = entries.get(key(gameId, round));
  return e?.done ? e.result : undefined;
}

export function houseSettled(code: string, gameId: string, round: number): Promise<void> | null {
  const e = ensureHouse(code, gameId, round);
  return e.done ? null : e.settled;
}

// Takes the record for use, once, if it is still valid: its track must not have
// become part of anyone's crate or a pick since it was chosen.
export function takeHouse(code: string, gameId: string, round: number, pickedIds: number[]): House | null {
  const e = entries.get(key(gameId, round));
  entries.delete(key(gameId, round));
  const h = e?.done ? e.result : null;
  if (!h || pickedIds.includes(h.trackId)) return null;
  const { everyone } = crateOwners(code, gameId);
  const clash = everyone.length
    ? db.select({ id: tasteTracks.trackId }).from(tasteTracks).where(and(inArray(tasteTracks.personId, everyone), eq(tasteTracks.trackId, h.trackId))).get()
    : undefined;
  return clash ? null : h;
}

// For the picks table's `personId`.
export const isHouseRow = (personId: string) => personId === HOUSE_ID;
