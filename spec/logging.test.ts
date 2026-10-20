import { expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers";

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

withToken("logs a round without leaking themes, moles or who picked what until it's public", async () => {
  const ps: { s: Session; name: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = session();
    const name = uniqueName(`lg${i}`);
    await s.call("/api/join", { body: { name, pin: "4680" } });
    ps.push({ s, name });
  }
  for (const p of ps) await fillCrate(p.s);
  const found = (await (await ps[0].s.call("/api/taste")).json()) as { id: number; title: string }[];
  const { code } = (await (await ps[0].s.call("/api/tables", { body: { pickSeconds: 30, voteSeconds: 30 } })).json()) as {
    code: string;
  };
  for (const p of ps.slice(1)) await p.s.call(`/api/tables/${code}/join`, { body: {} });
  await ps[0].s.call(`/api/tables/${code}/start`, { body: {} });
  const themes = await Promise.all(
    ps.map(async (p) => ((await (await p.s.call(`/api/tables/${code}/me`)).json()) as { theme: string }).theme),
  );
  for (const [i, p] of ps.entries()) await p.s.call(`/api/tables/${code}/pick`, { body: { trackId: found[i].id } });
  await sleep(500);

  // Mid-round: picks are logged as actions, but nothing that decides the round.
  const during = linesWith(await logs(), code).join("\n");
  for (const p of ps) expect(linesWith(during, p.name).some((l) => /pick/i.test(l))).toBe(true);
  for (const t of new Set(themes)) expect(during).not.toContain(t);
  for (const t of found.slice(0, 3)) expect(during).not.toContain(t.title);
  expect(during).not.toMatch(/\bmole\b/i);

  // Finish the game by voting out whoever had the odd theme.
  for (let i = 0; i < 40; i++) {
    const s = (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as { game?: { phase: string } };
    if (s.game?.phase === "listen") break;
    await sleep(250);
  }
  await ps[0].s.call(`/api/tables/${code}/advance`, { body: {} });
  const mole = ps[themes.findIndex((t) => themes.filter((x) => x === t).length === 1)];
  for (let i = 0; i < 40; i++) {
    const s = (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as { game?: { phase: string } };
    if (s.game?.phase === "vote") break;
    await sleep(250);
  }
  for (const p of ps) await p.s.call(`/api/tables/${code}/vote`, { body: { name: mole.name } });
  await sleep(800);

  // Once over, the end can be logged: who was ejected, and the themes.
  const after = linesWith(await logs(), code).join("\n");
  expect(after).toMatch(/finish|over|won|winner/i);
  expect(linesWith(after, mole.name).some((l) => /eject|voted out|out/i.test(l))).toBe(true);
  // Who voted for whom is never logged.
  for (const p of ps) expect(linesWith(after, p.name).some((l) => l.includes(`voted for ${mole.name}`))).toBe(false);
});
