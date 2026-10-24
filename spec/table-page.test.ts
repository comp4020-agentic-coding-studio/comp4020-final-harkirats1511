import { expect, it } from "vitest";
import { fillCrate, session, uniqueName } from "./helpers";

// Contract: the HTML of /t/CODE already holds the booth controls (decision 0005):
// a visibility tag, the host's public/private switch, and the report form; the
// home page's "Start a table" card asks "Who can sit down?".

async function signedIn(prefix: string) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}
const html = async (s: ReturnType<typeof session>, path: string) => (await s.call(path)).text();

it("renders the visibility and report controls on the table page", async () => {
  const host = await signedIn("tblh");
  const { code } = (await (await host.s.call("/api/tables", { body: { private: true } })).json()) as { code: string };
  const text = await html(host.s, `/t/${code}`);
  expect(text).toContain('id="vis-tag"');
  expect(text).toContain("Private");
  expect(text).toContain('id="vis-host"');
  expect(text).toContain('id="vis-public"');
  expect(text).toContain('id="vis-private"');
  expect(text).toContain('id="report-form"');
  expect(text).toContain("Report this table");
  expect(text).toMatch(/id="to-shop"[^>]*aria-label="Back to the shop floor. You keep your seat here."/);
});

it("says a public booth is open to anyone", async () => {
  const host = await signedIn("tblp");
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  expect(await html(host.s, `/t/${code}`)).toContain("Open to anyone");
});

it("asks who can sit down on the home page when signed in", async () => {
  const a = await signedIn("tbli");
  const text = await html(a.s, "/");
  expect(text).toMatch(/<fieldset[^>]*>[\s\S]*Who can sit down\?[\s\S]*<\/fieldset>/);
  expect(text).toContain("Anyone in the shop");
  expect(text).toContain("Only people with the code");
});

// Contract (decision 0009): the page shell holds the crate game's sections, and a
// mole's server-rendered page never carries a prompt.
it("renders the crate game's sections in the page shell", async () => {
  const host = await signedIn("tblsec");
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  const text = await html(host.s, `/t/${code}`);
  for (const id of ["crates", "card", "pick", "listen", "vote", "steal", "reveal"]) expect(text).toContain(`id="${id}"`);
  expect(text).toContain("3 each for Up, Down, Out and In");
  // The old game is gone from the page.
  expect(text).not.toContain("Your theme");
  expect(text).not.toContain("house record");
});

it("never puts a prompt in a mole's server-rendered table page", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/lib/prompts.ts", import.meta.url), "utf8");
  const texts = [...source.matchAll(/text:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  expect(texts.length).toBeGreaterThan(40);
  const players = [];
  for (const prefix of ["pgm1", "pgm2", "pgm3"]) players.push(await signedIn(prefix));
  const { code } = (await (await players[0].s.call("/api/tables", { body: { private: true } })).json()) as { code: string };
  for (const p of players) {
    expect((await p.s.call(`/api/tables/${code}/join`, { body: {} })).status).toBe(200);
    await fillCrate(p.s, players.indexOf(p));
  }
  expect((await players[0].s.call(`/api/tables/${code}/start`, { body: {} })).status).toBe(200);
  const views = await Promise.all(players.map(async (p) => ({ p, me: (await (await p.s.call(`/api/tables/${code}/me`)).json()) as { role: string; prompt?: string } })));
  const mole = views.find((v) => v.me.role === "mole");
  const other = views.find((v) => v.me.role === "player");
  expect(mole && other).toBeTruthy();
  expect(mole!.me.prompt).toBeUndefined();
  const page = await html(mole!.p.s, `/t/${code}`);
  const found = texts.filter((t) => page.includes(t) || page.includes(t.replace(/'/g, "&#39;")));
  expect(found).toEqual([]);
  // The prompt is fetched from /me, never rendered into anyone's shell.
  expect(other!.me.prompt).toBeTruthy();
  expect(await html(other!.p.s, `/t/${code}`)).not.toContain(other!.me.prompt!);
}, 60_000);
