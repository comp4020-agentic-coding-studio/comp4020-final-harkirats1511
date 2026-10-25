import { expect, it } from "vitest";
import { session, uniqueName } from "./helpers";

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

// Contract (decision 0009): the page shell holds the crate game's sections. (That a mole
// is never sent a prompt is checked in game.test.ts, over every channel and phase.)
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

// Contract (decision 0010): the page shell holds the format choice, the score strip, the two ballots
// and the Four rounds parts of How to play; the create form offers both formats.
it("renders the format controls and the Four rounds shell", async () => {
  const host = await signedIn("tblfmt");
  const { code } = (await (await host.s.call("/api/tables", { body: { format: "four" } })).json()) as { code: string };
  const text = await html(host.s, `/t/${code}`);
  for (const id of ["format-lobby", "format-guest", "scores", "vote-tabs", "best-list", "four-points", "scoreboard", "ghost-results"]) expect(text).toContain(`id="${id}"`);
  expect(text).toContain("Four rounds");
  expect(text).toContain("Knockout");
  const home = await html(host.s, "/");
  expect(home).toContain('id="fmt-four"');
  expect(home).toContain('id="fmt-knockout"');
});
