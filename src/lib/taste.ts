import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, games, tasteTracks } from "./schema.ts";
import type { Track } from "./deezer.ts";
import { SLOTS, type Slot } from "./prompts.ts";

// A crate is 12 songs in 4 slots of 3 (decision 0009). Sitting down needs
// nothing, but starting a game needs every player's crate complete.
export const PER_SLOT = 3;
export const TASTE_MAX = SLOTS.length * PER_SLOT;
export const CRATE_LOCKED = "Your crate is locked until the game ends.";

export const isSlot = (s: unknown): s is Slot => typeof s === "string" && (SLOTS as readonly string[]).includes(s);

export function crateSize(personId: string): number {
  return db.select({ id: tasteTracks.trackId }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all().length;
}

// Complete means 3 in every slot. A row with no slot (from before slots) counts
// for nothing, so its owner has to re-slot it.
export function crateComplete(personId: string): boolean {
  const counts = slotCounts(personId);
  return SLOTS.every((s) => counts[s] === PER_SLOT);
}

function slotCounts(personId: string): Record<Slot, number> {
  const counts: Record<Slot, number> = { up: 0, down: 0, out: 0, in: 0 };
  for (const r of db.select({ slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all()) {
    if (isSlot(r.slot)) counts[r.slot]++;
  }
  return counts;
}

// True while this person is a player (left or not yet voted out, ghosts too) in
// a game that hasn't ended: their crate is on the table and can't change.
export function crateLocked(personId: string): boolean {
  return !!db
    .select({ g: gamePlayers.gameId })
    .from(gamePlayers)
    .innerJoin(games, eq(games.id, gamePlayers.gameId))
    .where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0), isNull(games.winner)))
    .get();
}

// The code of the table whose running game holds this person's crate, or "".
export function lockedTable(personId: string): string {
  return (
    db
      .select({ c: games.tableCode })
      .from(gamePlayers)
      .innerJoin(games, eq(games.id, gamePlayers.gameId))
      .where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0), isNull(games.winner)))
      .get()?.c ?? ""
  );
}

// The track, if it is in this person's own crate right now.
export function crateTrack(personId: string, trackId: number) {
  return db
    .select({ id: tasteTracks.trackId, title: tasteTracks.title, artist: tasteTracks.artist, cover: tasteTracks.cover })
    .from(tasteTracks)
    .where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId)))
    .get();
}

export function listTaste(personId: string) {
  return db
    .select({
      id: tasteTracks.trackId,
      title: tasteTracks.title,
      artist: tasteTracks.artist,
      album: tasteTracks.album,
      cover: tasteTracks.cover,
      slot: tasteTracks.slot,
    })
    .from(tasteTracks)
    .where(eq(tasteTracks.personId, personId))
    .orderBy(asc(tasteTracks.addedAt), sql`rowid`)
    .all();
}

// "added" and "present" are both successes; the rest are 409s. Reads and the
// write run synchronously, so two requests cannot both squeeze past a cap. A
// track already in the crate with no slot (an old row) takes the slot given.
export function addTaste(personId: string, t: Track, slot: Slot): "added" | "present" | "full" | "slot-full" {
  const here = db.select({ id: tasteTracks.trackId, slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all();
  const have = here.find((r) => r.id === t.id);
  if (have && have.slot !== null) return "present";
  if (here.filter((r) => r.slot === slot).length >= PER_SLOT) return "slot-full";
  if (have) {
    db.update(tasteTracks).set({ slot }).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, t.id))).run();
    return "added";
  }
  // Old rows with no slot don't count toward the cap: only slotted songs make a crate.
  if (here.filter((r) => r.slot !== null).length >= TASTE_MAX) return "full";
  db.insert(tasteTracks)
    .values({ personId, trackId: t.id, title: t.title, artist: t.artist, album: t.album ?? null, cover: t.cover ?? null, slot, addedAt: Date.now() })
    .run();
  return "added";
}

export function moveTaste(personId: string, trackId: number, slot: Slot): "moved" | "missing" | "slot-full" {
  const here = db.select({ id: tasteTracks.trackId, slot: tasteTracks.slot }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all();
  const row = here.find((r) => r.id === trackId);
  if (!row) return "missing";
  if (row.slot === slot) return "moved";
  if (here.filter((r) => r.slot === slot).length >= PER_SLOT) return "slot-full";
  db.update(tasteTracks).set({ slot }).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId))).run();
  return "moved";
}

export function removeTaste(personId: string, trackId: number) {
  db.delete(tasteTracks).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId))).run();
}
