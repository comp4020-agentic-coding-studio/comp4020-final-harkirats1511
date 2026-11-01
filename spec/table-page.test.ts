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

// Contract (stage 3 review): How to play says the rules a player could otherwise only learn by losing points,
// and the vote shell has the line that says which ballot is still to cast.
it("says the Four rounds rules in How to play and has the 'still to cast' line", async () => {
  const host = await signedIn("tblhow");
  const { code } = (await (await host.s.call("/api/tables", { body: { format: "four" } })).json()) as { code: string };
  const text = (await html(host.s, `/t/${code}`)).replace(/\s+/g, " ");
  expect(text).toContain("a mole's own mole vote scores nothing");
  expect(text).toContain("a tie made only of moles");
  expect(text).toContain("You can't best-pick a song you lent");
  expect(text).toContain("without repeats");
  expect(text).toContain("Each mole is judged on their own");
  expect(text).toContain("A mole who leaves counts as caught");
  expect(text).toContain('id="vote-todo"');
  // The tab panels get their role and labels from the script, only in Four rounds: none is baked in pointing at a missing id.
  expect(text).not.toMatch(/id="vote-mole-panel"[^>]*aria-labelledby/);
  expect(text).not.toMatch(/id="vote-best-panel"[^>]*aria-labelledby/);
});

// Contract (graphics review): the page shell holds the two-column pieces (the scene and the crates live in the
// right column, which is sticky from 1100px), the dock the scene moves to for the phone moment strip, and the
// copy that explains the crate mood strips.
it("puts the scene and the crates in the side column, with a dock for the phone strip", async () => {
  const host = await signedIn("tblcol");
  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  const text = await html(host.s, `/t/${code}`);
  const side = text.slice(text.indexOf('id="side-col"'));
  expect(side).toContain('id="scene-slot"');
  expect(side).toContain('id="crates"');
  expect(text.indexOf('id="strip-dock"')).toBeLessThan(text.indexOf('id="side-col"'));
  expect(text).toContain("four blocks of three dots");
});

// Contract: the mole's mood line is handwriting, vote counts pop under a transform-only keyframe that reduced motion
// switches off, and the reveal's reasons read as sentences ("+2 from 2 best-pick votes").
it("styles the pop, the strip and the mole line as the design asks", async () => {
  const css = await (await fetch(new URL("/", baseUrl))).text();
  const href = css.match(/href="([^"]+\.css)"/)?.[1];
  expect(href).toBeTruthy();
  const sheet = await (await fetch(new URL(href!, baseUrl))).text();
  expect(sheet).toMatch(/\.mole-line\{[^}]*var\(--hand\)/);
  const pop = sheet.match(/@keyframes count-pop\{[^]*?\}\}/)?.[0] ?? "";
  expect(pop).toContain("transform");
  expect(pop).not.toMatch(/left|top|width|height|margin/);
  expect(sheet).toMatch(/prefers-reduced-motion:reduce\)\{\.count\.pop/);
  expect(sheet).toMatch(/\.strip-dock:empty\{display:none\}/);
});
