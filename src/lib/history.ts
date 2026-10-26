// Display-only extras for the history page: who won a Four rounds game and with what scores.
// historyFor (tables.ts) says winner "points" but not who; this reads the scores the engine
// already stored (game_players.score) for those games. Nothing here changes a game.
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { gamePlayers, games, people } from "./schema.ts";

export type PointsResult = { winners: string[]; scores: { name: string; score: number }[] };

export function pointsResult(code: string, finishedAt: number): PointsResult | null {
  const game = db
    .select({ id: games.id, final: games.finalResult })
    .from(games)
    .where(and(eq(games.tableCode, code), eq(games.winner, "points"), sql`coalesce(${games.finishedAt}, ${games.startedAt}) = ${finishedAt}`))
    .get();
  if (!game) return null;
  // The result stored when the game ended; older games (before it was stored) are read from the scores.
  if (game.final) {
    const f = JSON.parse(game.final) as PointsResult;
    return { winners: f.winners, scores: [...f.scores].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)) };
  }
  const scores = db
    .select({ name: people.name, score: gamePlayers.score })
    .from(gamePlayers)
    .innerJoin(people, eq(people.id, gamePlayers.personId))
    .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.left, 0)))
    .all()
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = scores[0]?.score ?? 0;
  return { winners: scores.filter((x) => x.score === top).map((x) => x.name), scores };
}
