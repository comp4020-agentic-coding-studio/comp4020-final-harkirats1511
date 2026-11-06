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
// voted for whom, a ghost's guess, a score, or a steal guess before it resolved. A Knockout mole is
// named only once revealed: the one ejected (or who stole it) at their round, all of them at game over.

export type Sleeve = {
  id: string;
  table: string;
  format: "knockout" | "four";
  round: number;
  revealedAt: number;
  prompt: string;
  mood: Slot;
  picks: { picker: string; lender?: string; trackId: number; title: string; artist: string; cover?: string; best?: boolean }[];
  moles: string[];
  caught: boolean;
  stole?: boolean;
};

export const WALL_DEFAULT = 20;
export const WALL_MAX = 40;
const promptText = new Map(PROMPTS.map((p) => [p.id, p.text]));

// Revealed rounds of games played in public at a table that is still public (its code is on the
// sleeve, and a private table's code is what keeps it private).
const shown = () => and(isNotNull(gamePrompts.revealedAt), eq(games.private, false), eq(tables.private, false));

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
      // Every mole is public at game over (an abandoned game names none); before then only the caught one.
      const over = !!g.winner && g.winner !== "none";
      moles = over ? inGame.filter((p) => p.role === "mole").map((p) => p.name).sort() : caught ? [accused!.name] : [];
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

export function watchWall(fn: (s: Sleeve) => void): () => void {
  bus.on("sleeve", fn);
  return () => bus.off("sleeve", fn);
}

// Called by the engine after a transaction that opened a reveal (or ended a game) commits. Sends the
// new sleeve; when a Knockout game is over, its earlier sleeves too (the moles are named now), so a
// page that upserts by id keeps every sleeve right. Never throws into the engine.
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
