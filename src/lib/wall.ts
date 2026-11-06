import { EventEmitter } from "node:events";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "./db.ts";
import type { RoundSnapshot } from "./game.ts";
import { PROMPTS, type Slot } from "./prompts.ts";
import { gamePlayers, gamePrompts, games, people, picks, roundResults, tables } from "./schema.ts";

// The shop wall (decision 0011): every revealed round of a public table, as a sleeve. Built from the
// stored rounds alone (game_prompts.revealed_at says a round's reveal has opened), so it survives a
// restart. It holds only what that table saw at the reveal: the prompt, its mood, the picks with their
// pickers and lenders, the moles and whether they were caught, and Four rounds' best card. Never who
// voted for whom, a ghost's guess, a score, or a steal guess before it resolved. A sleeve says what was
// true of its own round: a Knockout sleeve names only the mole caught that round (ejected, or who stole
// it), and once the game is over its last sleeve names the moles who were never caught (`escaped`).

export type Sleeve = {
  id: string;
  table: string;
  format: "knockout" | "four";
  round: number;
  revealedAt: number;
  prompt: string;
  mood: Slot;
  picks: { picker: string; lender?: string; trackId: number; title: string; artist: string; cover?: string; best?: boolean }[];
  // Four rounds: the round's moles. Knockout: the mole caught this round, if any (never anyone else).
  moles: string[];
  caught: boolean;
  stole?: boolean;
  // Knockout, game over, last sleeve only: the moles never caught (they got away).
  escaped?: string[];
  // Knockout: how many moles the game had (public: the table's setting), so the words say "a" or "the".
  moleCount?: number;
};

export const WALL_DEFAULT = 20;
export const WALL_MAX = 40;
const promptText = new Map(PROMPTS.map((p) => [p.id, p.text]));

// Revealed rounds of games played in public at a table that is still public (its code is on the
// sleeve, and a private table's code is what keeps it private).
// A round with no closed card (cut short while picking) has nothing to hang, so it is left out here,
// before the page is cut, never after.
const shown = () =>
  and(
    isNotNull(gamePrompts.revealedAt), eq(games.private, false), eq(tables.private, false),
    sql`exists (select 1 from ${picks} where ${picks.gameId} = ${gamePrompts.gameId} and ${picks.round} = ${gamePrompts.round} and ${picks.slot} is not null)`,
  );

type Row = { gameId: string; round: number; revealedAt: number; promptId: string; slot: string; code: string };

function sleeves(rows: Row[]): Sleeve[] {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.gameId))];
  const game = new Map(
    db.select({ id: games.id, format: games.format, round: games.round, winner: games.winner, stole: games.stole, stealPersonId: games.stealPersonId })
      .from(games).where(inArray(games.id, ids)).all().map((g) => [g.id, g]),
  );
  const players = db
    .select({ gameId: gamePlayers.gameId, id: gamePlayers.personId, name: people.name, role: gamePlayers.role, ejected: gamePlayers.ejectedRound })
    .from(gamePlayers).innerJoin(people, eq(people.id, gamePlayers.personId))
    .where(inArray(gamePlayers.gameId, ids)).all();
  const results = db.select().from(roundResults).where(inArray(roundResults.gameId, ids)).all();
  const lender = alias(people, "lender");
  const cards = db
    .select({ gameId: picks.gameId, round: picks.round, order: picks.slot, picker: people.name, lender: lender.name, trackId: picks.trackId, title: picks.title, artist: picks.artist, cover: picks.cover })
    .from(picks)
    .innerJoin(people, eq(people.id, picks.personId))
    .leftJoin(lender, eq(lender.id, picks.lenderPersonId))
    .where(and(inArray(picks.gameId, ids), isNotNull(picks.slot)))
    .orderBy(picks.slot)
    .all();
  return rows.flatMap((r): Sleeve[] => {
    const g = game.get(r.gameId);
    if (!g) return [];
    const four = g.format === "four";
    const mine = cards.filter((c) => c.gameId === r.gameId && c.round === r.round);
    // A round cut short before its picks closed has nothing to hang.
    if (!mine.length) return [];
    let moles: string[];
    let caught: boolean;
    let stole: boolean | undefined;
    let escaped: string[] | undefined;
    let moleCount: number | undefined;
    let best = new Set<number>();
    if (four) {
      const res = results.find((x) => x.gameId === r.gameId && x.round === r.round);
      const snap = res?.snapshot ? (JSON.parse(res.snapshot) as RoundSnapshot) : null;
      moles = snap?.moles ?? [];
      caught = res?.caught === 1 || (snap?.caught.length ?? 0) > 0;
      stole = res?.stole === 1;
      best = new Set((snap?.best ?? []).map((b) => b.order));
    } else {
      const inGame = players.filter((p) => p.gameId === r.gameId);
      const ejected = inGame.find((p) => p.ejected === r.round);
      const stoleIt = r.round === g.round && g.stole === 1 ? inGame.find((p) => p.id === g.stealPersonId) : undefined;
      const accused = ejected ?? stoleIt;
      caught = accused?.role === "mole";
      stole = !!stoleIt;
      // Only the mole caught this round, before and after game over: a sleeve never says someone was
      // caught in a round they weren't.
      moles = caught ? [accused!.name] : [];
      const all = inGame.filter((p) => p.role === "mole");
      moleCount = all.length;
      // Game over (an abandoned game names nobody): the last sleeve names the moles nobody caught, the
      // ones never ejected and not the one who stole it (who was caught, then guessed right).
      const over = !!g.winner && g.winner !== "none";
      const last = Math.max(...cards.filter((c) => c.gameId === r.gameId).map((c) => c.round));
      if (over && r.round === last) {
        const away = all.filter((p) => p.ejected === null && p.id !== stoleIt?.id).map((p) => p.name).sort();
        if (away.length) escaped = away;
      }
    }
    return [{
      id: `${r.gameId}:${r.round}`,
      table: r.code,
      format: four ? "four" : "knockout",
      round: r.round,
      revealedAt: r.revealedAt,
      prompt: promptText.get(r.promptId) ?? "",
      mood: r.slot as Slot,
      picks: mine.map((c) => ({
        picker: c.picker, ...(c.lender ? { lender: c.lender } : {}), trackId: c.trackId, title: c.title, artist: c.artist,
        ...(c.cover ? { cover: c.cover } : {}), ...(best.has(c.order!) ? { best: true } : {}),
      })),
      moles,
      caught,
      ...(stole ? { stole: true } : {}),
      ...(escaped ? { escaped } : {}),
      ...(moleCount !== undefined ? { moleCount } : {}),
    }];
  });
}

const base = () =>
  db
    .select({ gameId: gamePrompts.gameId, round: gamePrompts.round, revealedAt: sql<number>`${gamePrompts.revealedAt}`, promptId: gamePrompts.promptId, slot: gamePrompts.slot, code: games.tableCode })
    .from(gamePrompts)
    .innerJoin(games, eq(games.id, gamePrompts.gameId))
    .innerJoin(tables, eq(tables.code, games.tableCode));

// Newest first, `limit` at a time; `before` is the revealedAt of the last sleeve already shown. A page
// never splits sleeves revealed in the same millisecond (the next page asks for strictly older ones),
// so it may run a little over `limit`.
export function wallPage(before: number | null, limit = WALL_DEFAULT): { sleeves: Sleeve[]; more: boolean } {
  const where = before === null ? shown() : and(shown(), lt(gamePrompts.revealedAt, before));
  const rows = base().where(where).orderBy(desc(gamePrompts.revealedAt), desc(gamePrompts.gameId), desc(gamePrompts.round)).limit(limit + 1).all() as Row[];
  let page = rows.slice(0, limit);
  let more = rows.length > limit;
  if (more && rows[limit].revealedAt === page[page.length - 1].revealedAt) {
    const at = rows[limit].revealedAt;
    const ties = base().where(and(shown(), eq(gamePrompts.revealedAt, at))).all() as Row[];
    const have = new Set(page.map((r) => `${r.gameId}:${r.round}`));
    page = [...page, ...ties.filter((r) => !have.has(`${r.gameId}:${r.round}`))];
    more = !!base().where(and(shown(), lt(gamePrompts.revealedAt, at))).limit(1).get();
  }
  return { sleeves: sleeves(page), more };
}

// The sleeves of one game (or one round of it) as they stand now; empty when the game isn't on the wall.
export function gameSleeves(gameId: string, round?: number): Sleeve[] {
  const rows = base()
    .where(and(shown(), eq(gamePrompts.gameId, gameId), round === undefined ? undefined : eq(gamePrompts.round, round)))
    .orderBy(gamePrompts.revealedAt, gamePrompts.round)
    .all() as Row[];
  return sleeves(rows);
}

// ---- the shop stream's `wall` event ----

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function watchWall(fn: (s: Sleeve) => void, gone?: (table: string) => void): () => void {
  bus.on("sleeve", fn);
  if (gone) bus.on("gone", gone);
  return () => { bus.off("sleeve", fn); if (gone) bus.off("gone", gone); };
}

// A table made private takes its sleeves down (CLAUDE.md, 0011): tell open shop pages to drop them too.
export function announceGone(table: string): void {
  bus.emit("gone", table);
}

// Called by the engine after a transaction that opened a reveal (or ended a game) commits. Sends the
// new sleeve; when a Knockout game is over, its earlier sleeves too (re-sent as they stand; the last one
// now names who got away), so a page that upserts by id keeps every sleeve right. Never throws into the engine.
export function announceReveal(gameId: string, round: number): void {
  try {
    if (!bus.listenerCount("sleeve")) return;
    const all = gameSleeves(gameId);
    const g = db.select({ format: games.format, winner: games.winner }).from(games).where(eq(games.id, gameId)).get();
    const knockoutOver = g?.format !== "four" && !!g?.winner && g.winner !== "none";
    for (const s of all) if (s.round === round || knockoutOver) bus.emit("sleeve", s);
  } catch {
    // the wall is decoration on the shop; a failure here never breaks a game
  }
}
