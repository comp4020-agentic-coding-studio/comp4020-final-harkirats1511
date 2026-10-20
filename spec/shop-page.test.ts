import { expect, it } from "vitest";
import { session, uniqueName } from "./helpers";

// Contract: /shop is the free-roam floor. Signed out it sends you to the front
// door. Signed in, its HTML already holds the 2D booth list (heading, quick seat,
// a booth per live table) so it works with no script and no 3D, and nothing in it
// gives away a private booth's code.

async function signedIn(prefix: string) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}
const html = async (s: ReturnType<typeof session>, path: string) => {
  const r = await s.call(path);
  return { status: r.status, text: await r.text() };
};

it("sends someone signed out to the front door", async () => {
  const res = await session().call("/shop");
  // fetch follows redirects, so look at where it ended up
  expect(new URL(res.url).pathname).toBe("/");
});

it("renders the 2D booth list and quick seat in the page itself", async () => {
  const a = await signedIn("shopp");
  const { status, text } = await html(a.s, "/shop");
  expect(status).toBe(200);
  expect(text).toMatch(/<h2[^>]*>Booths<\/h2>/);
  expect(text).toContain('id="quick-seat"');
  expect(text).toContain('id="booth-list"');
  expect(text).toMatch(/<h2[^>]*>Radio<\/h2>/);
  expect(text).toContain("Sound:");
});

it("lists a public booth with its code and a private one without", async () => {
  const host = await signedIn("shoph");
  const pub = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  const priv = await signedIn("shopv");
  const pc = (await (await priv.s.call("/api/tables", { body: {} })).json()) as { code: string };
  expect((await priv.s.call(`/api/tables/${pc.code}/visibility`, { body: { private: true } })).status).toBe(200);

  const viewer = await signedIn("shopw");
  const { text } = await html(viewer.s, "/shop");
  expect(text).toContain(`Booth ${pub.code}`);
  expect(text).toContain(`data-code="${pub.code}"`);
  expect(text).toContain("Private booth");
  expect(text).toContain(priv.name);
  // the private code is in no booth markup: not its heading, an attribute or a key
  // (the bare four letters could match unrelated page text by luck, so look at those)
  expect(text).not.toContain(`Booth ${pc.code}`);
  expect(text).not.toMatch(new RegExp(`(data-code|data-key|value)="${pc.code}"`));
  const li = text.slice(text.indexOf('id="booth-list"'), text.indexOf("</ul>", text.indexOf('id="booth-list"')));
  expect(li).not.toContain(pc.code);
});
