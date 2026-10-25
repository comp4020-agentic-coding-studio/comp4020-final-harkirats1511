import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CRATES } from "./helpers";

// A bot sees only what a player sees. Run on the engine itself against a scratch database
// (this file never touches the running app's), because a bot's own view is not on the wire.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "bots-spec-")), "app.db");
const SLOTS = ["up", "down", "out", "in"] as const;

it("never hands a bot mole the prompt: its /me and the public state it decides from hold none", async () => {
  const { db } = await import("../src/lib/db.ts");
  const { people, tableMembers, tables, tasteTracks } = await import("../src/lib/schema.ts");
  const { startGame } = await import("../src/lib/game.ts");
  const { PROMPTS } = await import("../src/lib/prompts.ts");
  const { botView } = await import("../src/lib/bots/driver.ts");
  const { decidePick, decideVote, decideSteal } = await import("../src/lib/bots/brain.ts");
  const { currentGame } = await import("../src/lib/tables.ts");
  const { gamePlayers } = await import("../src/lib/schema.ts");
  const { and, eq } = await import("drizzle-orm");

  const now = Date.now();
  let checked = 0;
  for (let attempt = 0; attempt < 12 && checked < 3; attempt++) {
    const code = `BT${String.fromCharCode(65 + attempt)}${String.fromCharCode(65 + attempt)}`;
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const [i, id] of ids.entries()) {
      db.insert(people).values({ id, name: `${i ? "bot-t" : "hum-t"}${attempt}${i}`, pinHash: "x", pinSalt: "x", createdAt: now, isBot: i > 0 }).run();
      for (const [k, trackId] of CRATES[i].entries()) {
        db.insert(tasteTracks).values({ personId: id, trackId, title: `t${trackId}`, artist: "a", slot: SLOTS[Math.floor(k / 3)], addedAt: now + k }).run();
      }
    }
    db.insert(tables).values({ code, hostPersonId: ids[0], status: "open", createdAt: now }).run();
    for (const [i, id] of ids.entries()) db.insert(tableMembers).values({ tableCode: code, personId: id, joinedAt: now + i }).run();
    expect(startGame(code).ok).toBe(true);
    const g = currentGame(code)!;
    for (const bot of ids.slice(1)) {
      const role = db.select({ r: gamePlayers.role }).from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.personId, bot))).get()!.r;
      if (role !== "mole") continue;
      const v = botView(code, bot)!;
      expect(v.me.role).toBe("mole");
      // No prompt text or id anywhere in what the bot is given, nor in what it decides.
      const given = JSON.stringify(v);
      for (const p of PROMPTS) {
        expect(given).not.toContain(p.text);
        expect(given).not.toContain(`"${p.id}"`);
      }
      expect(v.me).not.toHaveProperty("prompt");
      expect(v.me.slot).toBeTruthy();
      const name = db.select({ n: people.name }).from(people).where(eq(people.id, bot)).get()!.n;
      const choice = decidePick(v.me, name, v.pub);
      expect(choice === null || typeof choice.trackId === "number").toBe(true);
      expect(decideVote(v.me, name, v.pub)).toBeTruthy();
      expect(decideSteal(v.me, v.pub)).toBeNull(); // no steal offered: nothing to read it from
      checked++;
    }
    for (const id of ids) db.delete(tableMembers).where(eq(tableMembers.personId, id)).run();
  }
  expect(checked, "saw at least one bot mole").toBeGreaterThan(0);
});

it("the bot brain and driver read no prompt list, role or hidden pick: they import only what a player is given", () => {
  const root = join(import.meta.dirname, "..", "src", "lib", "bots");
  const brain = readFileSync(join(root, "brain.ts"), "utf8");
  expect(brain).not.toMatch(/^import /m);
  const driver = readFileSync(join(root, "driver.ts"), "utf8");
  const names = [...driver.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)].flatMap((m) => m[1].split(",").map((x) => `${m[2]}:${x.trim()}`)).join(" ");
  // Nothing that reads roles, prompts or other hidden rows: no database, no schema, no game row,
  // no seating module (which can see the database).
  for (const banned of [
    "prompts.ts", "gamePlayers", "gamePrompts", "picks", "votes", "stealOptions", "promptById", "playerRow",
    "currentGame", "db.ts", "schema.ts", "seats.ts", "crate.ts", "taste.ts", "auth.ts", "people", "tableMembers", "tables.ts:db",
    "cardTrackId", "startGame", "effectiveMoles", "tableOptions", "drizzle",
  ]) {
    expect(names, `driver imports ${banned}`).not.toContain(banned);
  }
  expect(driver).not.toMatch(/from "\.\.\/db\.ts"|from "drizzle-orm"|from "\.\/seats\.ts"/);
  expect(driver).not.toMatch(/currentGame/);
  // It acts through the engine's own functions, with its own person id.
  expect(driver).toMatch(/pickTrack\(code, bot\.id/);
  expect(driver).toMatch(/castVote\(code, bot\.id/);
  expect(driver).toMatch(/castSteal\(code, bot\.id/);
});

// The seating code needs the database; it lives apart (seats.ts) and neither the brain nor the
// driver, which decide and play, may import it.
it("the seating module is imported by no decision code", () => {
  const root = join(import.meta.dirname, "..", "src", "lib", "bots");
  for (const f of ["brain.ts", "driver.ts"]) expect(readFileSync(join(root, f), "utf8")).not.toMatch(/^import .*seats\.ts/m);
});

// What a restart does: bots are driven from the database, so a table that still has a person
// carries on (its bots pick without anyone nudging them), and one with nobody sends them home.
it("after a restart, bots at a table with a person pick by themselves; bots with nobody leave", async () => {
  const { db } = await import("../src/lib/db.ts");
  const { people, tableMembers, tables, tasteTracks, picks } = await import("../src/lib/schema.ts");
  const { startGame } = await import("../src/lib/game.ts");
  const { resumeBots } = await import("../src/lib/bots/seats.ts");
  const { currentGame, botSeats } = await import("../src/lib/tables.ts");
  const { eq } = await import("drizzle-orm");
  const now = Date.now();
  const mk = (name: string, bot: boolean, crate: number) => {
    const id = randomUUID();
    db.insert(people).values({ id, name, pinHash: "x", pinSalt: "x", createdAt: now, isBot: bot }).run();
    for (const [k, trackId] of CRATES[crate].entries()) {
      db.insert(tasteTracks).values({ personId: id, trackId, title: `t${trackId}`, artist: "a", slot: SLOTS[Math.floor(k / 3)], addedAt: now + k }).run();
    }
    return id;
  };
  const seat = (code: string, ids: string[]) => {
    db.insert(tables).values({ code, hostPersonId: ids[0], status: "open", pickSeconds: 40, createdAt: now }).run();
    for (const [i, id] of ids.entries()) db.insert(tableMembers).values({ tableCode: code, personId: id, joinedAt: now + i }).run();
  };
  const human = mk("rs-human", false, 0);
  const bots = [mk("bot-rs1", true, 1), mk("bot-rs2", true, 2), mk("bot-rs3", true, 3)];
  seat("RSAA", [human, ...bots]);
  expect(startGame("RSAA").ok).toBe(true);
  // A table of only bots, left behind by a crashed process.
  const lone = [mk("bot-rs4", true, 4), mk("bot-rs5", true, 5)];
  seat("RSBB", [lone[0], lone[1]]);

  resumeBots(); // the boot step, run on a database that already holds all this
  expect(botSeats("RSBB")).toHaveLength(0);
  expect(botSeats("RSAA")).toHaveLength(3);
  const g = currentGame("RSAA")!;
  const end = Date.now() + 25_000;
  let n = 0;
  while (Date.now() < end && (n = db.select().from(picks).where(eq(picks.gameId, g.id)).all().length) < 3) await new Promise((r) => setTimeout(r, 500));
  expect(n, "all three bots picked on their own after the restart").toBe(3);
}, 40_000);

it("a chosen 2 moles, with only 5 seated at the start, deals 1", async () => {
  const { db } = await import("../src/lib/db.ts");
  const { people, tableMembers, tables, tasteTracks, gamePlayers } = await import("../src/lib/schema.ts");
  const { startGame } = await import("../src/lib/game.ts");
  const { currentGame } = await import("../src/lib/tables.ts");
  const { and, eq } = await import("drizzle-orm");
  const now = Date.now();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const [i, id] of ids.entries()) {
    db.insert(people).values({ id, name: `mole5-${i}`, pinHash: "x", pinSalt: "x", createdAt: now }).run();
    for (const [k, trackId] of CRATES[i].entries()) {
      db.insert(tasteTracks).values({ personId: id, trackId, title: `t${trackId}`, artist: "a", slot: SLOTS[Math.floor(k / 3)], addedAt: now + k }).run();
    }
  }
  db.insert(tables).values({ code: "MLAA", hostPersonId: ids[0], status: "open", moles: 2, createdAt: now }).run();
  for (const [i, id] of ids.entries()) db.insert(tableMembers).values({ tableCode: "MLAA", personId: id, joinedAt: now + i }).run();
  expect(startGame("MLAA").ok).toBe(true);
  const g = currentGame("MLAA")!;
  const moles = db.select().from(gamePlayers).where(and(eq(gamePlayers.gameId, g.id), eq(gamePlayers.role, "mole"))).all();
  expect(moles).toHaveLength(1);
});

it("bots leave a lobby nobody has had open for a while, and a table with no person", async () => {
  const { db } = await import("../src/lib/db.ts");
  const { people, tableMembers, tables } = await import("../src/lib/schema.ts");
  const { sweepBots } = await import("../src/lib/bots/seats.ts");
  const { botSeats } = await import("../src/lib/tables.ts");
  const now = Date.now();
  const mk = (name: string, bot: boolean) => {
    const id = randomUUID();
    db.insert(people).values({ id, name, pinHash: "x", pinSalt: "x", createdAt: now, isBot: bot }).run();
    return id;
  };
  const host = mk("sw-host", false);
  const b = [mk("bot-sw1", true), mk("bot-sw2", true)];
  db.insert(tables).values({ code: "SWAA", hostPersonId: host, status: "open", createdAt: now }).run();
  for (const [i, id] of [host, ...b].entries()) db.insert(tableMembers).values({ tableCode: "SWAA", personId: id, joinedAt: now + i }).run();
  sweepBots(now); // first sight: the clock starts
  expect(botSeats("SWAA")).toHaveLength(2);
  sweepBots(now + 5 * 60_000);
  expect(botSeats("SWAA"), "5 minutes is not long enough").toHaveLength(2);
  sweepBots(now + 11 * 60_000);
  expect(botSeats("SWAA"), "unwatched for 11 minutes: sent home").toHaveLength(0);
  expect(db.select().from(tableMembers).all().some((m) => m.tableCode === "SWAA" && m.personId === host), "the person stays").toBe(true);
});
