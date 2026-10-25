import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Boot-time resume, on the engine itself against a scratch database (this file
// never touches the running app's). A game found in `reveal` with no deadline and
// no winner, as an older build leaves it, gets the usual reveal deadline so the
// table can't sit there forever.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "resume-spec-")), "app.db");

it("gives a reveal with no deadline and no winner a fresh reveal deadline at boot", async () => {
  const { db } = await import("../src/lib/db.ts");
  const { games, gamePlayers, gamePrompts, people, tableMembers, tables } = await import("../src/lib/schema.ts");
  const { resumeGames, REVEAL_SECONDS } = await import("../src/lib/game.ts");
  const { eq } = await import("drizzle-orm");

  const now = Date.now();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of ids.entries()) db.insert(people).values({ id, name: `rs${i}`, pinHash: "x", pinSalt: "x", createdAt: now }).run();
  db.insert(tables).values({ code: "RSME", hostPersonId: ids[0], status: "playing", createdAt: now }).run();
  const gameId = randomUUID();
  db.insert(games)
    .values({ id: gameId, tableCode: "RSME", round: 2, phase: "reveal", deadline: null, startedAt: now, slotOrder: JSON.stringify(["up", "down", "out", "in"]) })
    .run();
  for (const [i, id] of ids.entries()) {
    db.insert(tableMembers).values({ tableCode: "RSME", personId: id, joinedAt: now + i }).run();
    db.insert(gamePlayers).values({ gameId, personId: id, role: i === 0 ? "mole" : "player" }).run();
  }
  db.insert(gamePrompts).values({ gameId, round: 2, promptId: "up-01", slot: "up" }).run();

  const before = Date.now();
  resumeGames();
  const row = db.select().from(games).where(eq(games.id, gameId)).get()!;
  expect(row.phase).toBe("reveal");
  expect(row.winner).toBeNull();
  expect(row.deadline).toBeGreaterThanOrEqual(before + REVEAL_SECONDS * 1000);
  expect(row.deadline).toBeLessThanOrEqual(Date.now() + REVEAL_SECONDS * 1000);
});
