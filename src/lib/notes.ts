import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "./db.ts";
import type { RoundSnapshot } from "./game.ts";
import type { Slot } from "./prompts.ts";
import { gamePlayers, gamePrompts, people, picks, roundResults } from "./schema.ts";

// Taste notes on "Your past games" (decision 0011): only from games this person sat in (and was still
// in: like the history, a game they walked out of isn't theirs to read back), and only from rounds those
// games revealed (game_prompts.revealed_at), so every note was already shown to them at a reveal.

export type T = { trackId: number; title: string; artist: string; cover?: string };
export type TasteNotes = {
  byMood: Record<Slot, T[]>;
  mostLoved?: T & { votes: number };
  shared: { with: string; track: T }[];
  borrows: { from?: string; to?: string; track: T }[];
};

const t = (r: { trackId: number; title: string; artist: string; cover: string | null }): T => ({
  trackId: r.trackId, title: r.title, artist: r.artist, ...(r.cover ? { cover: r.cover } : {}),
});

export function tasteNotes(personId: string): TasteNotes {
  const out: TasteNotes = { byMood: { up: [], down: [], out: [], in: [] }, shared: [], borrows: [] };
  const ids = db.select({ g: gamePlayers.gameId }).from(gamePlayers).where(and(eq(gamePlayers.personId, personId), eq(gamePlayers.left, 0))).all().map((r) => r.g);
  if (!ids.length) return out;
  const me = db.select({ n: people.name }).from(people).where(eq(people.id, personId)).get()?.n ?? "";
  const picker = alias(people, "picker");
  const lender = alias(people, "lender");
  // Every card of every revealed round of those games, named (a card only exists once picks closed).
  const cards = db
    .select({
      gameId: picks.gameId, round: picks.round, slot: gamePrompts.slot, revealedAt: gamePrompts.revealedAt,
      personId: picks.personId, picker: picker.name, lenderId: picks.lenderPersonId, lender: lender.name,
      trackId: picks.trackId, title: picks.title, artist: picks.artist, cover: picks.cover,
    })
    .from(picks)
    .innerJoin(gamePrompts, and(eq(gamePrompts.gameId, picks.gameId), eq(gamePrompts.round, picks.round)))
    .innerJoin(picker, eq(picker.id, picks.personId))
    .leftJoin(lender, eq(lender.id, picks.lenderPersonId))
    .where(and(inArray(picks.gameId, ids), isNotNull(gamePrompts.revealedAt), isNotNull(picks.slot)))
    .orderBy(gamePrompts.revealedAt, picks.slot)
    .all();
  const mine = cards.filter((c) => c.personId === personId);

  for (const c of mine) {
    const list = out.byMood[c.slot as Slot];
    if (list && !list.some((x) => x.trackId === c.trackId)) list.push(t(c));
  }

  // Best-pick votes for this person's cards, as each reveal counted them (Four rounds, frozen at the reveal).
  const snaps = db.select({ gameId: roundResults.gameId, round: roundResults.round, snapshot: roundResults.snapshot }).from(roundResults).where(inArray(roundResults.gameId, ids)).all();
  const loved = new Map<number, { track: T; votes: number }>();
  for (const s of snaps) {
    if (!s.snapshot) continue;
    const card = mine.find((c) => c.gameId === s.gameId && c.round === s.round);
    if (!card) continue;
    const n = (JSON.parse(s.snapshot) as RoundSnapshot).bestVotes.filter((b) => b.picker === me).length;
    if (!n) continue;
    const had = loved.get(card.trackId);
    loved.set(card.trackId, { track: had?.track ?? t(card), votes: (had?.votes ?? 0) + n });
  }
  const top = [...loved.values()].sort((a, b) => b.votes - a.votes)[0];
  if (top) out.mostLoved = { ...top.track, votes: top.votes };

  // Songs this person picked that someone else also picked, in these games.
  const seen = new Set<string>();
  for (const c of cards) {
    if (c.personId === personId) continue;
    const m = mine.find((x) => x.trackId === c.trackId);
    const key = `${c.picker}:${c.trackId}`;
    if (!m || seen.has(key)) continue;
    seen.add(key);
    out.shared.push({ with: c.picker, track: t(m) });
  }

  // Borrows, this person on either side.
  for (const c of cards) {
    if (!c.lenderId) continue;
    if (c.personId === personId) out.borrows.push({ from: c.lender ?? "", track: t(c) });
    else if (c.lenderId === personId) out.borrows.push({ to: c.picker, track: t(c) });
  }
  return out;
}
