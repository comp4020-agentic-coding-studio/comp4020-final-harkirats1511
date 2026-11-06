import { expect, it, vi } from "vitest";
import { baseUrl, getUrl, fillCrate, session, uniqueName } from "./helpers";
import { PROMPTS } from "../src/lib/prompts";

// Contract (CLAUDE.md "Logging"): the server logs who did what, one line per
// action, and keeps the recent lines for GET /api/logs, which answers only to
// the token in the app's LOG_TOKEN and is a 404 otherwise. Each line names the
// person (display name + short id) and the table code.
//
// These read the log through /api/logs, so they need the same token as the app:
// run with LOG_TOKEN=... set for both. CI starts the image without one, so the
// token-dependent checks skip there; the 404 check always runs.

vi.setConfig({ testTimeout: 90_000 });
const TOKEN = process.env.LOG_TOKEN;
const withToken = TOKEN ? it : it.skip;

type Session = ReturnType<typeof session>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function logs(): Promise<string> {
  const res = await fetch(new URL("/api/logs", baseUrl), { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return res.text();
}
const linesWith = (text: string, needle: string) => text.split("\n").filter((l) => l.includes(needle));

it("hides the log from anyone without the token", async () => {
  expect((await fetch(new URL("/api/logs", baseUrl))).status).toBe(404);
  const wrong = await fetch(new URL("/api/logs", baseUrl), { headers: { authorization: "Bearer not-the-token" } });
  expect(wrong.status).toBe(404);
});

withToken("tells two people apart and says who did what at which table", async () => {
  const a = session();
  const b = session();
  const ana = uniqueName("ana");
  const ben = uniqueName("ben");
  await a.call("/api/join", { body: { name: ana, pin: "2468" } });
  await b.call("/api/join", { body: { name: ben, pin: "1357" } });
  const { code } = (await (await a.call("/api/tables", { body: {} })).json()) as { code: string };
  await b.call(`/api/tables/${code}/join`, { body: {} });
  await sleep(200);

  const text = await logs();
  expect(linesWith(text, ana).some((l) => /sign|join|new/i.test(l))).toBe(true);
  expect(linesWith(text, ben).some((l) => /sign|join|new/i.test(l))).toBe(true);
  expect(linesWith(text, code).some((l) => l.includes(ana) && /creat/i.test(l))).toBe(true);
  expect(linesWith(text, code).some((l) => l.includes(ben) && /join/i.test(l))).toBe(true);
});

withToken("logs refused attempts with the person and the reason, and never a PIN", async () => {
  const owner = session();
  const name = uniqueName("own");
  await owner.call("/api/join", { body: { name, pin: "1111" } });
  await session().call("/api/join", { body: { name, pin: "9999" } });

  const host = session();
  const guest = session();
  const hostName = uniqueName("hst");
  const guestName = uniqueName("gst");
  await host.call("/api/join", { body: { name: hostName, pin: "2222" } });
  await guest.call("/api/join", { body: { name: guestName, pin: "3333" } });
  const { code } = (await (await host.call("/api/tables", { body: {} })).json()) as { code: string };
  await guest.call(`/api/tables/${code}/join`, { body: {} });
  expect((await guest.call(`/api/tables/${code}/start`, { body: {} })).status).toBe(403);
  await sleep(200);

  const text = await logs();
  expect(linesWith(text, name).some((l) => /refus|wrong|denied|fail/i.test(l))).toBe(true);
  expect(linesWith(text, guestName).some((l) => /refus|denied|not the host|host/i.test(l))).toBe(true);
  for (const pin of ["1111", "9999", "2222", "3333"]) expect(text).not.toMatch(new RegExp(`\\b${pin}\\b`));
  expect(text).not.toMatch(/mole_session|pin_?hash|pinSalt/i);
});

withToken("logs a round without the prompt, moles, picks or votes before they're public", async () => {
  const ps: { s: Session; name: string; ids: number[] }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = session();
    const name = uniqueName(`lg${i}`);
    await s.call("/api/join", { body: { name, pin: "4680" } });
    ps.push({ s, name, ids: await fillCrate(s, i) });
  }
  const titles = (await (await ps[0].s.call("/api/taste")).json()) as { id: number; title: string }[];
  const { code } = (await (await ps[0].s.call("/api/tables", { body: { format: "knockout", pickSeconds: 30, voteSeconds: 30 } })).json()) as {
    code: string;
  };
  for (const p of ps.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await ps[0].s.call(`/api/tables/${code}/start`, { body: {} });
  const views = await Promise.all(
    ps.map(async (p) => (await (await p.s.call(`/api/tables/${code}/me`)).json()) as { role: string; prompt?: string }),
  );
  const prompt = views.find((v) => v.prompt)!.prompt!;
  const mole = ps[views.findIndex((v) => v.role === "mole")];
  // Two players pick; the third hasn't, so picking is still open.
  for (const p of ps.slice(0, 2)) await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: p.ids[0] } });
  await sleep(500);

  // Mid-pick: picks are logged as actions, but not what, and nothing that decides the round.
  const during = linesWith(await logs(), code).join("\n");
  for (const p of ps.slice(0, 2)) expect(linesWith(during, p.name).some((l) => /picked a track/i.test(l))).toBe(true);
  expect(during).not.toContain(prompt);
  for (const x of PROMPTS) expect(during).not.toContain(x.text);
  for (const t of titles.slice(0, 3)) expect(during).not.toContain(t.title);
  expect(during).not.toMatch(/\bmole\b/i);

  // The last pick closes picking: now the picks may be logged with their pickers.
  await ps[2].s.call(`/api/tables/${code}/pick`, { body: { trackId: ps[2].ids[0] } });
  for (let i = 0; i < 40; i++) {
    const s = (await (await getUrl(`/api/tables/${code}`)).json()) as { game?: { phase: string } };
    if (s.game?.phase === "listen") break;
    await sleep(250);
  }
  const listening = linesWith(await logs(), code).join("\n");
  expect(linesWith(listening, "picks closed").some((l) => l.includes(ps[0].name) && l.includes(titles[0].title))).toBe(true);
  expect(listening).not.toContain(prompt);
  expect(listening).not.toMatch(/\bmole\b/i);

  await ps[0].s.call(`/api/tables/${code}/advance`, { body: {} });
  for (let i = 0; i < 40; i++) {
    const s = (await (await getUrl(`/api/tables/${code}`)).json()) as { game?: { phase: string } };
    if (s.game?.phase === "vote") break;
    await sleep(250);
  }
  // While the vote is open nothing is logged per vote: the tally is public, so a line per vote would show whose vote moved which count.
  const [early, ...rest] = ps;
  await early.s.call(`/api/tables/${code}/vote`, { body: early === mole ? { skip: true } : { name: mole.name } });
  await sleep(400);
  const open = linesWith(await logs(), code).join("\n");
  for (const p of ps) expect(linesWith(open, p.name).some((l) => /\) (voted|changed their vote)/.test(l))).toBe(false);
  expect(open).not.toMatch(/votes in/);
  for (const p of rest) await p.s.call(`/api/tables/${code}/vote`, { body: p === mole ? { skip: true } : { name: mole.name } });
  // The mole is voted out and gets a steal; the options are theirs alone, and the guess isn't logged until it resolves.
  for (let i = 0; i < 40; i++) {
    const s = (await (await getUrl(`/api/tables/${code}`)).json()) as { game?: { phase: string } };
    if (s.game?.phase === "steal") break;
    await sleep(250);
  }
  const stealing = linesWith(await logs(), code).join("\n");
  // At the lock, one line names who voted, never whom.
  const lock = linesWith(stealing, "votes in");
  expect(lock).toHaveLength(1);
  for (const p of ps) expect(lock[0]).toContain(p.name);
  expect(lock[0]).toContain("(3 of 3)");
  expect(lock[0]).not.toMatch(/voted for|\bfor\b|\bmole\b/i);
  expect(linesWith(stealing, mole.name).some((l) => /gets a steal/.test(l))).toBe(true);
  expect(stealing).not.toContain(prompt);
  expect(stealing).not.toMatch(/stole it|missed the steal/);
  for (const p of ps) expect(linesWith(stealing, p.name).some((l) => /voted for/.test(l))).toBe(false);
  const options = ((await (await mole.s.call(`/api/tables/${code}/me`)).json()) as { steal: { options: { id: string; text: string }[] } }).steal.options;
  const wrong = options.find((o) => o.text !== prompt)!;
  await mole.s.call(`/api/tables/${code}/steal`, { body: { promptId: wrong.id } });
  await sleep(800);

  // Once it resolves, the reveal may name the prompt, and the steal's outcome.
  const after = linesWith(await logs(), code).join("\n");
  expect(after).toMatch(/finish|over|won|winner/i);
  expect(linesWith(after, mole.name).some((l) => /missed the steal/.test(l))).toBe(true);
  expect(linesWith(after, "reveal").some((l) => l.includes(prompt) && l.includes(mole.name) && /was a mole/.test(l))).toBe(true);
  // Who voted for whom is never logged.
  for (const p of ps) expect(linesWith(after, p.name).some((l) => l.includes(`voted for ${mole.name}`))).toBe(false);
});

withToken("doesn't say a pick was a borrow, or log a round cut short by a leaver, before picks are public", async () => {
  const ps: { s: Session; name: string; ids: number[] }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = session();
    const name = uniqueName(`bw${i}`);
    await s.call("/api/join", { body: { name, pin: "4680" } });
    ps.push({ s, name, ids: await fillCrate(s, i) });
  }
  const { code } = (await (await ps[0].s.call("/api/tables", { body: { format: "knockout", pickSeconds: 60, voteSeconds: 30 } })).json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await ps[0].s.call(`/api/tables/${code}/start`, { body: {} });
  const views = await Promise.all(ps.map(async (p) => (await (await p.s.call(`/api/tables/${code}/me`)).json()) as { role: string }));
  const mole = ps[views.findIndex((v) => v.role === "mole")];
  const [first, second] = ps.filter((p) => p !== mole);
  // One borrow, one own pick; the mole hasn't picked, so picking is open.
  expect((await first.s.call(`/api/tables/${code}/pick`, { body: { trackId: second.ids[0], from: second.name } })).status).toBe(200);
  await second.s.call(`/api/tables/${code}/pick`, { body: { trackId: second.ids[1] } });
  await sleep(400);
  const during = linesWith(await logs(), code).join("\n");
  expect(linesWith(during, first.name).some((l) => /picked a track/.test(l))).toBe(true);
  expect(during).not.toMatch(/borrow/i);

  // The mole walks out mid-pick: the game ends, and the round's hidden picks are never logged.
  await mole.s.call(`/api/tables/${code}/leave`, { body: {} });
  await sleep(600);
  const after = linesWith(await logs(), code).join("\n");
  expect(after).toMatch(/game finished/);
  expect(after).not.toMatch(/picks closed/);
  expect(after).not.toMatch(/borrow/i);
});

withToken("never writes the session token or cookie to /api/logs", async () => {
  const name = uniqueName("tok");
  const res = await fetch(new URL("/api/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, pin: "5791" }) });
  expect(res.status).toBeLessThan(300);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  expect(cookie.length).toBeGreaterThan(0);
  const s = session();
  // Some activity as that person, then a wrong-PIN attempt and a table.
  const mine = await fetch(new URL("/api/tables", baseUrl), { method: "POST", headers: { "content-type": "application/json", cookie: cookie.join("; ") }, body: JSON.stringify({}) });
  expect(mine.status).toBeLessThan(300);
  await s.call("/api/join", { body: { name, pin: "0000" } });
  await sleep(200);
  const text = await logs();
  for (const c of cookie) {
    const [key, value] = [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)];
    expect(text).not.toContain(value);
    expect(text).not.toContain(c);
    expect(text).not.toContain(key);
  }
  expect(text).not.toContain(TOKEN!);
});
