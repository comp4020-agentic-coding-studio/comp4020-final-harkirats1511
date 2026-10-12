import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { tasteTracks } from "./schema.ts";
import type { Track } from "./deezer.ts";

export const TASTE_MAX = 10;

export function listTaste(personId: string) {
  return db
    .select({
      id: tasteTracks.trackId,
      title: tasteTracks.title,
      artist: tasteTracks.artist,
      album: tasteTracks.album,
      cover: tasteTracks.cover,
    })
    .from(tasteTracks)
    .where(eq(tasteTracks.personId, personId))
    .orderBy(asc(tasteTracks.addedAt), sql`rowid`)
    .all();
}

// "added" and "present" are both successes; "full" is a 409. The count and the
// insert run synchronously, so two requests cannot both squeeze past the cap.
export function addTaste(personId: string, t: Track): "added" | "present" | "full" {
  const here = db.select({ id: tasteTracks.trackId }).from(tasteTracks).where(eq(tasteTracks.personId, personId)).all();
  if (here.some((r) => r.id === t.id)) return "present";
  if (here.length >= TASTE_MAX) return "full";
  db.insert(tasteTracks)
    .values({ personId, trackId: t.id, title: t.title, artist: t.artist, album: t.album ?? null, cover: t.cover ?? null, addedAt: Date.now() })
    .run();
  return "added";
}

export function removeTaste(personId: string, trackId: number) {
  db.delete(tasteTracks).where(and(eq(tasteTracks.personId, personId), eq(tasteTracks.trackId, trackId))).run();
}
