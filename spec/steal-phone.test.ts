import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers";

// Contract (CLAUDE.md "The 3D table scene": on a phone the action comes first): at 390x844, in Four rounds
// with the score strip showing, the accused mole's 8 steal options are all on screen during the 15 s guess,
// with the 3D scene running (the docked moment strip once pushed them below the fold). This drives a real
// game: three people pick, the two who are not the mole vote the mole out, and a real Chrome signs in as
// the mole. It runs the scene through SwiftShader so the scene really loads.

vi.setConfig({ testTimeout: 120_000 });
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
  (p): p is string => !!p && existsSync(p),
);
let browser: Browser;
beforeAll(async () => {
  expect(chrome, "a Chrome for the page specs: set CHROME_PATH").toBeTruthy();
  browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
});
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (code: string, p: string) => `/api/tables/${code}/${p}`;
type Pub = { game?: { phase: string; round: number; accused?: string; cards?: { order: number; picker: string; lender?: string }[]; played?: number[] } };
type Me = { role: string; picked: boolean; played: number[]; vote?: unknown; steal?: { options: { id: string }[] } };

it("the accused mole sees all 8 steal options inside 844px at 390 wide, in Four rounds, with the score strip", async () => {
  const players = await Promise.all([0, 1, 2].map(async (i) => {
    const s = session();
    const name = uniqueName(`sp${i}`);
    await s.call("/api/join", { body: { name, pin: "1357" } });
    return { s, name, ids: await fillCrate(s, i + 5) };
  }));
  const [host] = players;
  const code = ((await (await host.s.call("/api/tables", { body: { private: true, format: "four", pickSeconds: 30, voteSeconds: 30, slotSeconds: 5 } })).json()) as { code: string }).code;
  for (const p of players.slice(1)) expect((await p.s.call(at(code, "join"), { body: {} })).status).toBeLessThan(300);
  const state = async () => (await (await host.s.call(at(code, "")))).json() as Promise<Pub>;
  const mine = async (p: (typeof players)[number]) => (await (await p.s.call(at(code, "me"))).json()) as Me;
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);

  // Round 1 by hand, up to the steal. The mole is whoever /me says is one; the other two vote them out.
  let mole: (typeof players)[number] | undefined;
  const end = Date.now() + 100_000;
  let seen = "";
  while (Date.now() < end) {
    const g = (await state()).game;
    if (!g) { await sleep(300); continue; }
    if (g.phase === "steal") break;
    const key = g.phase + g.round;
    if (g.phase === "pick") {
      for (const p of players) {
        const v = await mine(p);
        if (!v.picked) await p.s.call(at(code, "pick"), { body: { trackId: p.ids.find((id) => !v.played.includes(id)) } });
      }
    } else if (g.phase === "listen" && key !== seen) {
      seen = key;
      await host.s.call(at(code, "advance"), { body: {} });
    } else if (g.phase === "vote") {
      const roles = await Promise.all(players.map(mine));
      mole = players[roles.findIndex((r) => r.role === "mole")];
      expect(mole, "somebody is the mole").toBeTruthy();
      for (const p of players) {
        const target = p === mole ? players.find((q) => q !== mole)!.name : mole!.name;
        await p.s.call(at(code, "vote"), { body: { name: target } });
        const c = g.cards!.find((c) => c.picker !== p.name && c.lender !== p.name);
        if (c) await p.s.call(at(code, "best"), { body: { order: c.order } });
      }
    }
    await sleep(300);
  }
  expect(mole, "reached the vote").toBeTruthy();
  expect((await state()).game!.phase).toBe("steal");

  // The mole's own phone, signed in as the same person, opened on the table at the steal.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    expect((await ctx.request.post(new URL("/api/join", baseUrl).href, { data: { name: mole!.name, pin: "1357" } })).status()).toBe(200);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL(`/t/${code}`, baseUrl).href);
    await page.locator("#steal-options button").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    const info = await page.evaluate(() => {
      const r = [...document.querySelectorAll<HTMLElement>("#steal-options button")].map((b) => b.getBoundingClientRect());
      return { n: r.length, top: Math.round(r[0].top), bottom: Math.round(r[r.length - 1].bottom), scores: !document.getElementById("scores")!.hidden, ih: innerHeight, parent: document.getElementById("scene-slot")?.parentElement?.id };
    });
    expect(info.scores, "the score strip is showing").toBe(true);
    expect(info.n).toBe(8);
    expect(info.top).toBeGreaterThanOrEqual(0);
    expect(info.bottom, `the last option ends at ${info.bottom}px, scene parent ${info.parent}`).toBeLessThanOrEqual(844);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    // Let the steal clock run out so the table is not left mid-game.
    for (const p of players) await p.s.call(at(code, "leave"), { body: {} });
  }
});
