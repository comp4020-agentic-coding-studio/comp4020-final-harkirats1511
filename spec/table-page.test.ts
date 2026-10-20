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
  expect(text).toContain("Back to the shop floor (keeps your seat)");
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
