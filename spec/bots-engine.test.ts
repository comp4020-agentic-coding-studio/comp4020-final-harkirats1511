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
  for (const banned of ["prompts.ts", "gamePlayers", "gamePrompts", "picks", "votes", "stealOptions", "promptById", "playerRow"]) {
    expect(names).not.toContain(banned);
  }
  // It acts through the engine's own functions, with its own person id.
  expect(driver).toMatch(/pickTrack\(code, bot\.id/);
  expect(driver).toMatch(/castVote\(code, bot\.id/);
  expect(driver).toMatch(/castSteal\(code, bot\.id/);
});
