import { expect, it, vi } from "vitest";
import { fillCrate, getUrl, session, uniqueName } from "./helpers";

// Contract (decision 0011, CLAUDE.md "The shop"): GET /api/wall?before=&limit= -> {sleeves, more}, public,
// newest first. A sleeve is a revealed round of a public table: {id, table, format, round, revealedAt,
// prompt, mood, picks: {picker, lender?, trackId, title, artist, cover?, best?}[], moles, caught, stole?}.
// The shop stream sends `wall` {sleeve} when one goes up.
// Never on the wall or the shop stream: a running round's prompt or picks before its reveal, anything of
// a private table, a Knockout mole not yet revealed (only the one caught at their round, all at game
// over), who voted for whom, a ghost's guess, a score, a steal guess.
// These play whole games over HTTP and scan /api/wall and the raw shop stream bytes at every phase.

vi.setConfig({ testTimeout: 300_000 });
type Session = ReturnType<typeof session>;
type P = { s: Session; name: string; ids: number[] };
type Sleeve = { id: string; table: string; format: string; round: number; revealedAt: number; prompt: string; mood: string; picks: { picker: string; lender?: string; trackId: number; best?: boolean }[]; moles: string[]; caught: boolean; stole?: boolean };
type Pub = { game?: { round: number; phase: string; winner?: string; moles?: string[]; cards?: { order: number; picker: string }[]; reveal?: { prompt: string } } };
type Me = { role: string; prompt?: string; steal?: { options: { id: string; text: string }[] } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (code: string, p: string) => `/api/tables/${code}/${p}`;

async function player(prefix: string, crate: number): Promise<P> {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name, ids: await fillCrate(s, crate) };
}
const state = async (p: P, code: string) => (await (await p.s.call(at(code, ""))).json()) as Pub;
const me = async (p: P, code: string) => (await (await p.s.call(at(code, "me"))).json()) as Me;
async function until(p: P, code: string, ok: (st: Pub) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(p, code);
    if (ok(st)) return st;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(st.game).slice(0, 300)}`);
    await sleep(200);
  }
}
async function wallText(): Promise<string> {
  return (await getUrl("/api/wall?limit=40")).text();
}
const wallOf = async (code: string) => ((JSON.parse(await wallText()) as { sleeves: Sleeve[] }).sleeves).filter((s) => s.table === code);

// Words that must never be on the wall or the shop stream: ballots by name, ghost guesses, scores, steal options.
const NEVER = ['"voter"', '"choice"', '"guess', '"ghostGuesses"', '"points"', '"score', '"bestVotes"', '"options"', '"tally"', '"role"', '"crate"'];

// The raw shop stream without other tables' wall frames (a concurrent spec's revealed round may share a prompt).
const rawFor = (raw: string, code: string) => raw.split("\n\n").filter((f) => !f.startsWith("event: wall") || f.includes(`"table":"${code}"`)).join("\n\n");

function scan(raw: string, wall: string, code: string, o: { hidden: string[]; round: number; mine: Sleeve[] }) {
  const stream = rawFor(raw, code);
  for (const w of NEVER) {
    expect(stream, `stream carries ${w}`).not.toContain(w);
    expect(wall, `wall carries ${w}`).not.toContain(w);
  }
  for (const h of o.hidden) expect(stream, `stream carries "${h}" before its reveal`).not.toContain(h);
  // The round in play is not on the wall before its reveal.
  expect(o.mine.some((s) => s.round === o.round), `round ${o.round} is on the wall before its reveal`).toBe(false);
}

it("hangs a Knockout game's rounds only after each reveal, and names a mole only once revealed", async () => {
  const ps = await Promise.all([0, 1, 2, 3].map((i) => player("wk", i)));
  const [host] = ps;
  const watcher = { s: session(), name: uniqueName("wkw"), ids: [] as number[] };
  await watcher.s.call("/api/join", { body: { name: watcher.name, pin: "1357" } });
  const stream = await watcher.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  const { code } = (await (await host.s.call("/api/tables", { body: { format: "knockout", pickSeconds: 60, voteSeconds: 60 } })).json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(at(code, "join"), { body: {} });
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  await until(host, code, (st) => st.game?.phase === "pick");
  const roles = await Promise.all(ps.map((p) => me(p, code)));
  const mole = ps[roles.findIndex((r) => r.role === "mole")];
  const prompt1 = roles.find((r) => r.prompt)!.prompt!;
  const check = async (round: number, hidden: string[]) => scan(stream.raw, await wallText(), code, { hidden, round, mine: await wallOf(code) });

  // Round 1: everyone picks; the room votes out a non-mole who isn't the host.
  await check(1, [prompt1]);
  for (const p of ps) expect((await p.s.call(at(code, "pick"), { body: { trackId: p.ids[0] } })).status).toBe(200);
  await until(host, code, (st) => st.game?.phase === "listen");
  await check(1, [prompt1]);
  await host.s.call(at(code, "advance"), { body: {} });
  await until(host, code, (st) => st.game?.phase === "vote");
  const out = ps.find((p) => p !== mole && p !== host)!;
  for (const p of ps) await p.s.call(at(code, "vote"), { body: { name: p === out ? host.name : out.name } });
  await check(1, [prompt1]);
  await until(host, code, (st) => st.game?.phase === "reveal");
  const up1 = await stream.next((e) => e.event === "wall" && e.data.sleeve.table === code && e.data.sleeve.round === 1, 5000);
  expect(up1, "a wall event for round 1").not.toBeNull();
  let mine = await wallOf(code);
  const r1 = mine.find((s) => s.round === 1)!;
  expect(r1).toMatchObject({ format: "knockout", prompt: prompt1, caught: false, moles: [] });
  expect(r1.picks.map((p) => p.picker).sort()).toEqual(ps.map((p) => p.name).sort());
  expect(r1.id).toMatch(/:1$/);
  await host.s.call(at(code, "advance"), { body: {} });
  await until(host, code, (st) => st.game?.round === 2 && st.game.phase === "pick");

  // Round 2: the ghost guesses, the room votes the mole out, the mole guesses the prompt wrong.
  const alive = ps.filter((p) => p !== out);
  const prompt2 = (await me(alive.find((p) => p !== mole)!, code)).prompt!;
  await check(2, [prompt2]);
  // The mole is named nowhere yet: not on round 1's sleeve, not in any frame of this table.
  expect(rawFor(stream.raw, code)).not.toContain(`"moles":["${mole.name}"`);
  for (const p of alive) expect((await p.s.call(at(code, "pick"), { body: { trackId: p.ids[3] } })).status).toBe(200);
  await until(host, code, (st) => st.game?.phase === "listen");
  await host.s.call(at(code, "advance"), { body: {} });
  await until(host, code, (st) => st.game?.phase === "vote");
  expect((await out.s.call(at(code, "guess"), { body: { name: mole.name } })).status).toBe(200);
  for (const p of alive) await p.s.call(at(code, "vote"), { body: { name: p === mole ? alive.find((q) => q !== mole)!.name : mole.name } });
  await until(host, code, (st) => st.game?.phase === "steal");
  await check(2, [prompt2]);
  mine = await wallOf(code);
  expect(mine.find((s) => s.round === 1)!.moles).toEqual([]);
  const options = (await me(mole, code)).steal!.options;
  expect((await mole.s.call(at(code, "steal"), { body: { promptId: options.find((o) => o.text !== prompt2)!.id } })).status).toBe(200);
  const end = await until(host, code, (st) => !!st.game?.winner);
  expect(end.game!.winner).toBe("players");
  await stream.next((e) => e.event === "wall" && e.data.sleeve.table === code && e.data.sleeve.round === 2, 5000);
  await sleep(300);
  // Game over: the caught mole on their round, and every mole on every sleeve; never a ballot or a guess.
  mine = await wallOf(code);
  expect(mine.find((s) => s.round === 2)).toMatchObject({ caught: true, moles: [mole.name], prompt: prompt2 });
  expect(mine.find((s) => s.round === 2)!.stole).toBeUndefined();
  expect(mine.find((s) => s.round === 1)).toMatchObject({ caught: false, moles: [mole.name] });
  const text = await wallText();
  for (const w of NEVER) expect(text).not.toContain(w);
  for (const w of NEVER) expect(rawFor(stream.raw, code)).not.toContain(w);
  stream.close();
});

it("hangs every Four rounds round after its reveal with its moles and best card, and nothing of a private table", async () => {
  const ps = await Promise.all([4, 5, 6, 7].map((i) => player("wf", i)));
  const hidden = await Promise.all([0, 1, 2].map((i) => player("wp", i)));
  const [host] = ps;
  const watcher = { s: session(), name: uniqueName("wfw"), ids: [] as number[] };
  await watcher.s.call("/api/join", { body: { name: watcher.name, pin: "1357" } });
  const stream = await watcher.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  // A private table plays a round to its reveal alongside.
  const { code: secret } = (await (await hidden[0].s.call("/api/tables", { body: { private: true, pickSeconds: 60, voteSeconds: 60 } })).json()) as { code: string };
  for (const p of hidden.slice(1)) await p.s.call(at(secret, "join"), { body: {} });
  expect((await hidden[0].s.call(at(secret, "start"), { body: {} })).status).toBeLessThan(300);
  // Four rounds is the default.
  const { code } = (await (await host.s.call("/api/tables", { body: { pickSeconds: 60, voteSeconds: 60 } })).json()) as { code: string };
  for (const p of ps.slice(1)) await p.s.call(at(code, "join"), { body: {} });
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);

  const privRound = (async () => {
    const h = hidden[0];
    await until(h, secret, (st) => st.game?.phase === "pick");
    for (const p of hidden) await p.s.call(at(secret, "pick"), { body: { trackId: p.ids[0] } });
    await until(h, secret, (st) => st.game?.phase === "listen");
    await h.s.call(at(secret, "advance"), { body: {} });
    await until(h, secret, (st) => st.game?.phase === "vote");
    for (const p of hidden) await p.s.call(at(secret, "vote"), { body: { skip: true } });
    await until(h, secret, (st) => st.game?.phase === "reveal");
  })();

  for (let round = 1; round <= 4; round++) {
    await until(host, code, (st) => st.game?.round === round && st.game.phase === "pick");
    const views = await Promise.all(ps.map((p) => me(p, code)));
    const mole = ps[views.findIndex((v) => v.role === "mole")];
    const prompt = views.find((v) => v.prompt)!.prompt!;
    const check = async () => scan(stream.raw, await wallText(), code, { hidden: [prompt], round, mine: await wallOf(code) });
    await check();
    for (const p of ps) expect((await p.s.call(at(code, "pick"), { body: { trackId: p.ids[round - 1] } })).status).toBe(200);
    const listen = await until(host, code, (st) => st.game?.phase === "listen");
    await check();
    await host.s.call(at(code, "advance"), { body: {} });
    await until(host, code, (st) => st.game?.phase === "vote");
    const cards = listen.game!.cards!;
    // Round 1 catches the mole (a steal follows); the rest let them go. Everyone names a best card not their own.
    for (const p of ps) {
      await p.s.call(at(code, "vote"), { body: round === 1 && p !== mole ? { name: mole.name } : { skip: true } });
      const other = cards.find((c) => c.picker !== p.name)!;
      await p.s.call(at(code, "best"), { body: { order: other.order } });
    }
    await check();
    if (round === 1) {
      await until(host, code, (st) => st.game?.phase === "steal");
      await check();
      const options = (await me(mole, code)).steal!.options;
      await mole.s.call(at(code, "steal"), { body: { promptId: options.find((o) => o.text !== prompt)!.id } });
    }
    await until(host, code, (st) => (st.game?.phase === "reveal" && st.game.round === round) || !!st.game?.winner);
    const up = await stream.next((e) => e.event === "wall" && e.data.sleeve.table === code && e.data.sleeve.round === round, 5000);
    expect(up, `a wall event for round ${round}`).not.toBeNull();
    const sleeve = (await wallOf(code)).find((s) => s.round === round)!;
    expect(sleeve).toMatchObject({ format: "four", prompt, moles: [mole.name], caught: round === 1 });
    expect(sleeve.picks).toHaveLength(4);
    expect(sleeve.picks.filter((p) => p.best).length).toBeGreaterThanOrEqual(1);
    if (round < 4) await host.s.call(at(code, "advance"), { body: {} });
  }
  await until(host, code, (st) => st.game?.winner === "points");
  await privRound;
  await sleep(500);
  // Nothing of the private table: not its code, not its players (its host is all its booth shows), not a sleeve.
  const text = await wallText();
  expect(text).not.toContain(secret);
  for (const p of hidden) expect(text).not.toContain(p.name);
  expect(stream.raw).not.toContain(secret);
  for (const p of hidden.slice(1)) expect(stream.raw).not.toContain(p.name);
  expect(stream.seen.some((e) => e.event === "wall" && e.data.sleeve.table === secret)).toBe(false);
  for (const w of NEVER) expect(rawFor(stream.raw, code)).not.toContain(w);
  // Newest first, and paged: before= the last one's time asks for strictly older sleeves.
  const page = (await (await getUrl("/api/wall?limit=2")).json()) as { sleeves: Sleeve[]; more: boolean };
  expect(page.sleeves.length).toBeGreaterThanOrEqual(2);
  expect(page.sleeves[0].revealedAt).toBeGreaterThanOrEqual(page.sleeves[1].revealedAt);
  expect(page.more).toBe(true);
  const last = page.sleeves.at(-1)!.revealedAt;
  const next = (await (await getUrl(`/api/wall?limit=2&before=${last}`)).json()) as { sleeves: Sleeve[] };
  for (const s of next.sleeves) expect(s.revealedAt).toBeLessThan(last);
  stream.close();
});

it("refuses a bad page and needs no sign-in", async () => {
  expect((await getUrl("/api/wall")).status).toBe(200);
  for (const q of ["limit=0", "limit=41", "limit=x", "before=-5", "before=abc"]) expect((await getUrl(`/api/wall?${q}`)).status, q).toBe(400);
});
