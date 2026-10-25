import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, games, tasteTracks } from "./schema.ts";
import { artistTop, DeezerBusy, findArtist, relatedArtists, trackBpm, type Track } from "./deezer.ts";
import { SLOTS, type Slot } from "./prompts.ts";

// A crate is 12 songs in 4 slots of 3 (decision 0009). Sitting down needs
// nothing, but starting a game needs every player's crate complete.
export const PER_SLOT = 3;
export const TASTE_MAX = SLOTS.length * PER_SLOT;
export const CRATE_LOCKED = "Your crate is locked until the game ends.";

export const isSlot = (s: unknown): s is Slot => typeof s === "string" && (SLOTS as readonly string[]).includes(s);

// Complete means 3 in every slot. A row with no slot (from before slots) counts
// for nothing, so its owner has to re-slot it.
export function crateComplete(personId: string): boolean {
  const counts = slotCounts(personId);
  return SLOTS.every((s) => counts[s] === PER_SLOT);
}

export function slotCounts(personId: string): Record<Slot, number> {
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

// ---- Starting a crate from your own artists (perfect-plan #2) and sorting old songs (#45) ----
//
// Mood guess, Deezer data only (no audio analysis, no outside list):
//   1. Title keywords: a few words that name a mood ("party", "sad", "sleep", "run").
//   2. Otherwise tempo, when Deezer knows it (track.bpm is often 0 = unknown):
//        >= 128 up, 108-127 out, 88-107 in, below 88 down.
//   3. Otherwise unknown (null): the caller spreads unknowns over the moods that
//      still have room, so no mood is starved.
// It is a starting point the person confirms, never a verdict.
const KEYWORDS: Record<Slot, RegExp> = {
  up: /\b(run|running|fire|power|jump|energy|wild|fight|champion|thunder|rise|stronger|adrenaline|rush|loud|go|victory|king|queen|rock|beast|hype)\b/i,
  down: /\b(sad|cry|crying|tears?|goodbye|broken|lonely|blue|blues|rain|hurt|hurts|heartbreak|miss|missing|grief|sorrow|gone|lost|farewell|funeral|empty)\b/i,
  out: /\b(party|dance|dancing|night|nights|club|tonight|friday|saturday|summer|friends?|drink|drinks|shots?|girls|boys|disco|celebrate|fun|weekend)\b/i,
  in: /\b(home|cosy|cozy|sleep|sleeping|dream|dreams|coffee|lofi|chill|quiet|slow|morning|soft|lullaby|sunday|alone|gentle|calm|peace|blanket|tea)\b/i,
};
// Keyword order matters when a title hits two (down and in first: they are the quieter ones).
const KEY_ORDER: Slot[] = ["down", "in", "up", "out"];

export function moodByBpm(bpm: number | null | undefined): Slot | null {
  if (!bpm || bpm < 30) return null;
  return bpm >= 128 ? "up" : bpm >= 108 ? "out" : bpm >= 88 ? "in" : "down";
}

export function moodByTitle(title: string): Slot | null {
  for (const s of KEY_ORDER) if (KEYWORDS[s].test(title)) return s;
  return null;
}

export function guessMood(title: string, bpm?: number | null): Slot | null {
  return moodByTitle(title) ?? moodByBpm(bpm);
}

// A suggested mood for each old song, filling only the room that is left:
// a song whose guess is full (or unknown) goes to the mood with the most room.
// Returns trackId -> slot, or null when no mood has room (it stays unsorted).
export function planLegacySort(
  loose: { id: number; title: string }[],
  counts: Record<Slot, number>,
  bpmOf: (id: number) => number | null = () => null,
): Map<number, Slot | null> {
  const room = { ...counts };
  const out = new Map<number, Slot | null>();
  for (const t of loose) {
    const g = guessMood(t.title, bpmOf(t.id));
    let pick: Slot | null = g && room[g] < PER_SLOT ? g : null;
    if (!pick) {
      const open = SLOTS.filter((s) => room[s] < PER_SLOT).sort((a, b) => room[a] - room[b]);
      pick = open[0] ?? null;
    }
    if (pick) room[pick]++;
    out.set(t.id, pick);
  }
  return out;
}

export type Suggestion = Track;
export type SuggestResult = {
  artists: string[];
  missing: string[];
  moods: Record<Slot, Suggestion[]>;
  spare: Record<Slot, Suggestion[]>;
};

// The most we ask Deezer for in one go: 3 artists, 3 related each. Parallel, and
// the whole thing stops waiting after BUDGET_MS; whatever arrived is used.
const BUDGET_MS = 7000;
const TOP_LIMIT = 25;
const RELATED_PER_ARTIST = 3;
const RELATED_TOP = 8;
const BPM_LOOKUPS = 20;
const SPARE_PER_MOOD = 3;

// Resolves with `fallback` when the budget runs out; a Deezer busy error is not swallowed.
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), Math.max(1, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// DeezerBusy anywhere means the quota is gone: say so. Any other failure on one
// branch just loses that branch.
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e) { if (e instanceof DeezerBusy) throw e; return fallback; }
}

export async function suggestFromArtists(names: string[], skip: Set<number>, only?: Slot[]): Promise<SuggestResult> {
  const until = Date.now() + BUDGET_MS;
  const left = () => until - Date.now();
  const found = await within(Promise.all(names.map((n) => soft(findArtist(n, left()), null))), left(), names.map(() => null));
  const artists = found.filter((a): a is { id: number; name: string } => !!a);
  const missing = names.filter((_, i) => !found[i]);

  // Each artist's own top tracks, and the top tracks of a few related artists.
  type Cand = { t: Track; src: number };
  const pools: Cand[][] = await within(
    Promise.all(
      artists.map(async (a, i) => {
        const own = soft(artistTop(a.id, TOP_LIMIT, left()), [] as Track[]);
        const rel = soft(relatedArtists(a.id, RELATED_PER_ARTIST, left()), []).then((rs) =>
          Promise.all(rs.map((r) => soft(artistTop(r.id, RELATED_TOP, left()), [] as Track[]))),
        );
        const [mine, theirs] = await Promise.all([own, rel]);
        // Own songs first, then related ones, interleaved so neither floods a mood.
        const flat = theirs.flat();
        const merged: Track[] = [];
        for (let k = 0; k < Math.max(mine.length, flat.length); k++) {
          if (mine[k]) merged.push(mine[k]);
          if (flat[k]) merged.push(flat[k]);
        }
        return merged.map((t) => ({ t, src: i }));
      }),
    ),
    left(),
    [] as Cand[][],
  );

  // Interleave the artists, dedupe, drop what they already have.
  const seen = new Set<number>(skip);
  const pool: Cand[] = [];
  for (let k = 0; pools.some((p) => k < p.length); k++) {
    for (const p of pools) {
      const c = p[k];
      if (c && !seen.has(c.t.id)) { seen.add(c.t.id); pool.push(c); }
    }
  }

  // Mood: title keywords first; for the rest, BPM for a limited number of lookups.
  const guess = new Map<number, Slot | null>();
  const unknown: Cand[] = [];
  for (const c of pool) {
    const g = moodByTitle(c.t.title);
    guess.set(c.t.id, g);
    if (!g) unknown.push(c);
  }
  const lookups = unknown.slice(0, BPM_LOOKUPS);
  if (lookups.length && left() > 300) {
    await within(
      Promise.all(lookups.map((c) => soft(trackBpm(c.t.id, left()), null).then((b) => guess.set(c.t.id, moodByBpm(b))))),
      left(),
      [],
    );
  }

  const moods = Object.fromEntries(SLOTS.map((s) => [s, [] as Track[]])) as Record<Slot, Track[]>;
  const spare = Object.fromEntries(SLOTS.map((s) => [s, [] as Track[]])) as Record<Slot, Track[]>;
  const want = (only && only.length ? only : [...SLOTS]) as Slot[];
  const used = new Set<number>();
  const take = (s: Slot, into: Track[], cap: number, from: (c: Cand) => boolean) => {
    for (const c of pool) {
      if (into.length >= cap) break;
      if (used.has(c.t.id) || !from(c)) continue;
      used.add(c.t.id);
      into.push(c.t);
    }
  };
  // Pass 1: songs whose guessed mood is this one. Pass 2: unknowns (a balanced spread). Pass 3: any left.
  for (const s of want) take(s, moods[s], PER_SLOT, (c) => guess.get(c.t.id) === s);
  for (const s of want) take(s, moods[s], PER_SLOT, (c) => !guess.get(c.t.id));
  for (const s of want) take(s, moods[s], PER_SLOT, () => true);
  for (const s of want) take(s, spare[s], SPARE_PER_MOOD, (c) => guess.get(c.t.id) === s || !guess.get(c.t.id));
  for (const s of want) take(s, spare[s], SPARE_PER_MOOD, () => true);
  return { artists: artists.map((a) => a.name), missing, moods, spare };
}

// Old songs (no slot) with a suggested mood each, using the same guess plus
// Deezer's tempo for titles with no keyword (a few lookups, in parallel, within a budget).
export async function legacySuggestions(personId: string): Promise<{ id: number; slot: Slot | null }[]> {
  const loose = listTaste(personId).filter((t) => !isSlot(t.slot));
  const bpm = new Map<number, number | null>();
  const need = loose.filter((t) => !moodByTitle(t.title)).slice(0, BPM_LOOKUPS);
  if (need.length) {
    await within(
      Promise.all(need.map((t) => soft(trackBpm(t.id, 4000), null).then((b) => bpm.set(t.id, b)))),
      4500,
      [],
    ).catch(() => []);
  }
  const plan = planLegacySort(loose, slotCounts(personId), (id) => bpm.get(id) ?? null);
  return loose.map((t) => ({ id: t.id, slot: plan.get(t.id) ?? null }));
}
