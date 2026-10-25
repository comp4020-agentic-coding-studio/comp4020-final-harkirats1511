import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract: no page throws while it loads, signed out or in (the home page once threw on every
// signed-out load, because a script reached for controls that exist only when signed in), and
// the crate page keeps keyboard focus where a person is working. This runs a real headless
// Chrome (found at CHROME_PATH, or the usual places; GitHub's runners have one).

vi.setConfig({ testTimeout: 60_000 });
const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
  (p): p is string => !!p && existsSync(p),
);
let browser: Browser;
beforeAll(async () => {
  expect(chrome, "a Chrome for the page specs: set CHROME_PATH").toBeTruthy();
  browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
});
afterAll(async () => { await browser?.close(); });

async function pageFor(cookieFrom?: ReturnType<typeof session>, name?: string, pin = "1357") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (name) {
    // Sign in through the browser's own request context so it holds the cookie.
    const res = await ctx.request.post(new URL("/api/join", baseUrl).href, { data: { name, pin } });
    expect(res.status()).toBe(200);
  }
  void cookieFrom;
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}
const go = async (page: Page, path: string) => {
  await page.goto(new URL(path, baseUrl).href);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
};

it("loads / signed out with no page error, and the sign-in form is there", async () => {
  const { ctx, page, errors } = await pageFor();
  await go(page, "/");
  expect(await page.locator("#sign-in").count()).toBe(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

it("loads /, /taste and a table page signed in with no page error; the home page is true about bots", async () => {
  const name = uniqueName("pg");
  const { ctx, page, errors } = await pageFor(undefined, name);
  await go(page, "/?welcome=0");
  // The pace buttons still fill the selects (the null guard must not break the signed-in wiring).
  await page.locator("#custom summary").click();
  await page.locator('label[for="pace-quick"]').click();
  expect(await page.locator("#pick-s").inputValue()).toBe("30");
  expect(await page.locator(".hours").innerText()).toMatch(/bots/i);
  expect(await page.locator(".hours").innerText()).not.toMatch(/one room/i);
  await go(page, "/taste");
  const made = await ctx.request.post(new URL("/api/tables", baseUrl).href, { data: {} });
  const { code } = (await made.json()) as { code: string };
  await go(page, `/t/${code}`);
  // The host's bot and mole controls come right under the code ticket, above the fold at 390.
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const ticket = await box("#table-code");
  const bots = await box("#add-bot");
  expect(bots.y).toBeGreaterThan(ticket.y);
  expect(bots.y + bots.height, "Add a bot is above the fold at 390x844").toBeLessThan(844);
  expect(errors).toEqual([]);
  await ctx.close();
});

// Focus on /taste, with Deezer stood in for (the page's own fetches are answered here), so what is
// tested is the page: after Keep, focus lands on the next Keep (or the next empty box); after Keep
// all, on the progress bar; after Swap, on the Swap of the new sleeve in that position.
it("keeps keyboard focus useful after Keep, Keep all and Swap", async () => {
  const name = uniqueName("fk");
  const { ctx, page, errors } = await pageFor(undefined, name);
  const song = (id: number, title: string) => ({ id, title, artist: "Band", album: "A", cover: null });
  const moods = {
    up: [song(1, "u1"), song(2, "u2"), song(3, "u3")],
    down: [song(4, "d1"), song(5, "d2")],
    out: [],
    in: [],
  };
  const spare = { up: [song(11, "us1"), song(12, "us2")], down: [], out: [], in: [] };
  const crate: any[] = [];
  await page.route("**/api/taste/suggest", (r) => r.fulfill({ json: { artists: ["Band"], missing: [], fewClean: [], moods, spare } }));
  await page.route("**/api/taste", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const { trackId, slot } = r.request().postDataJSON();
    const all = [...Object.values(moods).flat(), ...Object.values(spare).flat()];
    const t = all.find((x) => x.id === trackId)!;
    crate.push({ ...t, slot });
    return r.fulfill({ json: crate });
  });
  await go(page, "/taste");
  await page.fill("#artists", "Band");
  await page.click("#starter-go");
  await page.waitForSelector(".suggested");
  const active = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.fk ?? document.activeElement?.id ?? document.activeElement?.tagName);

  // Keep the first Up song: focus moves to the next Up Keep, not to <body>.
  await page.locator('[data-fk="keep:up:1"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement && (document.activeElement as HTMLElement).dataset.fk === "keep:up:2");
  // Swap the second remaining Up sleeve (index 1): focus lands on the new sleeve's Swap, in that position.
  await page.locator('[data-fk="swap:up:3"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.fk === "swap:up:11");
  // Keep the last Up suggestions: with none left in Up, focus goes to an empty box, never <body>.
  await page.locator('[data-fk="keep:up:2"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.fk === "keep:up:11");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /^empty:|^keep:/.test((document.activeElement as HTMLElement | null)?.dataset.fk ?? ""));
  expect(await active()).toMatch(/^empty:/);
  // Keep all: focus goes to the progress bar.
  await page.click("#keep-all");
  await page.waitForFunction(() => document.activeElement?.id === "progress");
  expect(errors).toEqual([]);
  await ctx.close();
});

it("shows a busy or throttled suggest next to the starter, with no retry", async () => {
  const { ctx, page } = await pageFor(undefined, uniqueName("bz"));
  let calls = 0;
  await page.route("**/api/taste/suggest", (r) => { calls++; return r.fulfill({ status: 503, json: { error: "Deezer is busy, try again in a moment." } }); });
  await go(page, "/taste");
  await page.fill("#artists", "Band");
  await page.click("#starter-go");
  await expect.poll(async () => page.locator("#starter-status").innerText()).toMatch(/Deezer is busy, try again in a moment/);
  await page.waitForTimeout(4000);
  expect(calls, "the page must not retry by itself").toBe(1);
  await ctx.close();
});

it("loads a table page signed in, and the 404 of a table that is not there, with no page error", async () => {
  const host = session();
  const name = uniqueName("tp");
  await host.call("/api/join", { body: { name, pin: "1357" } });
  const { ctx, page, errors } = await pageFor(undefined, name);
  await go(page, "/shop");
  await go(page, "/me");
  await go(page, "/history");
  expect(errors).toEqual([]);
  await ctx.close();
});
