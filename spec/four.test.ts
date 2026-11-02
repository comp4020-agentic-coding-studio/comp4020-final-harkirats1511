import { expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers";

// Contract for the Four rounds format and the ghost guess, over HTTP (CLAUDE.md "Formats"; decision 0010).
// The rules themselves (scoring, ties, restart) are in four-engine.test.ts, on the engine.
//   POST /api/tables {format?: "knockout"|"four"}        default knockout; 400 for anything else
//   POST /api/tables/:code/format {format}               host only, between games (409 mid-game)
//   POST /api/tables/:code/best {order}                  Four rounds, vote: a card's number, never your own
//   POST /api/tables/:code/guess {name}                  Knockout, vote: a ghost's private guess
// Public: table.format, game.format; Four rounds adds game.scores (as of the last reveal), game.bestTally
// (vote: {order, votes}[]), reveal.{moles, bestVotes, points}, past[].{moles, points}, and at game over
// game.winner "points" with game.winners. /me adds best:{order} (vote) and guess:{name} (ghosts).

vi.setConfig({ testTimeout: 300_000 });
type Session = ReturnType<typeof session>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (code: string, p: string) => `/api/tables/${code}/${p}`;
type Pub = {
  status: string; format: string; members: { name: string; bot?: true }[];
  game?: {
    format: string; round: number; phase: string; winner?: string; winners?: string[]; moles?: string[];
    scores?: { name: string; score: number }[]; bestTally?: { order: number; votes: number }[]; tally?: unknown;
    cards?: { order: number; picker: string; lender?: string }[];
    reveal?: { moles?: string[]; points?: { name: string; points: number }[]; prompt: string };
    past: { round: number; moles?: string[]; points?: unknown[] }[]; prompts?: unknown[];
  };
};
type Me = { role: string; prompt?: string; picked: boolean; played: number[]; best?: { order: number }; steal?: { options: { id: string }[] } };

async function human(prefix: string) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}
const state = async (s: Session, code: string) => (await (await s.call(`/api/tables/${code}`)).json()) as Pub;
async function until(s: Session, code: string, ok: (st: Pub) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(s, code);
    if (ok(st)) return st;
    if (Date.now() > end) throw new Error(`timed out waiting: ${JSON.stringify(st).slice(0, 400)}`);
    await sleep(250);
  }
}
// Private booths: another spec's quick seat must not sit a stranger at a table we mean to start.
async function newTable(h: { s: Session }, body: Record<string, unknown> = {}) {
  return ((await (await h.s.call("/api/tables", { body: { private: true, ...body } })).json()) as { code: string }).code;
}
async function addBots(h: { s: Session }, code: string, n: number) {
  for (let i = 0; i < n; i++) expect((await h.s.call(at(code, "bots"), { body: {} })).status).toBe(201);
  await until(h.s, code, (st) => (st.members as { bot?: true; crateReady?: boolean }[]).filter((m) => m.bot).every((m) => m.crateReady), 120_000);
}

it("picks the format on create or in the lobby: host only, validated, not during a game", async () => {
  const host = await human("fh");
  const guest = await human("fg");
  expect((await host.s.call("/api/tables", { body: { format: "chess" } })).status).toBe(400);
  expect((await host.s.call("/api/tables", { body: { format: 4 } })).status).toBe(400);
  const plain = await newTable(host);
  expect((await state(host.s, plain)).format).toBe("knockout");
  const code = await newTable(host, { format: "four" });
  expect((await state(host.s, code)).format).toBe("four");
  await guest.s.call(at(code, "join"), { body: {} });
  expect((await guest.s.call(at(code, "format"), { body: { format: "knockout" } })).status).toBe(403);
  expect((await session().call(at(code, "format"), { body: { format: "knockout" } })).status).toBe(401);
  expect((await host.s.call(at(code, "format"), { body: { format: "chess" } })).status).toBe(400);
  expect((await host.s.call(at("NOPE", "format"), { body: { format: "four" } })).status).toBe(404);
  const res = await host.s.call(at(code, "format"), { body: { format: "knockout" } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Pub).format).toBe("knockout");
  expect((await host.s.call(at(code, "format"), { body: { format: "four" } })).status).toBe(200);
  expect((await state(guest.s, code)).format).toBe("four");

  // Mid-game the choice is refused, and the running game keeps the format it started with.
  await fillCrate(host.s, 0);
  await guest.s.call(at(code, "leave"), { body: {} });
  await addBots(host, code, 2);
  const begun = await host.s.call(at(code, "start"), { body: {} });
  expect(begun.status, JSON.stringify(await begun.clone().json())).toBeLessThan(300);
  await until(host.s, code, (s) => s.game?.phase === "pick");
  const mid = await host.s.call(at(code, "format"), { body: { format: "knockout" } });
  expect(mid.status).toBe(409);
  expect((await state(host.s, code)).game!.format).toBe("four");
  await host.s.call(at(code, "leave"), { body: {} });
});

it("a Four rounds game over HTTP: two ballots, a mole's /me never has the prompt, scores only at the reveal", async () => {
  const host = await human("fe");
  await fillCrate(host.s, 1);
  const code = await newTable(host, { format: "four", pickSeconds: 30, voteSeconds: 30 });
  await addBots(host, code, 2);
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  // Bots can't act in the way we need, so the host alone checks the endpoints' errors, then the table moves by timers.
  const st = await until(host.s, code, (s) => s.game?.phase === "pick");
  expect(st.game).toMatchObject({ format: "four", round: 1 });
  expect(st.game!.scores!.map((p) => p.score)).toEqual([0, 0, 0]);
  expect(JSON.stringify(st.game)).not.toMatch(/"(moles|bestVotes|points|winners)"\s*:/);
  const me = async () => (await (await host.s.call(at(code, "me"))).json()) as Me;
  const v = await me();
  if (v.role === "mole") expect(Object.keys(v)).not.toContain("prompt");
  else expect(v.prompt).toBeTruthy();
  // No vote is open, so neither ballot can be cast; nobody who isn't at the table can.
  expect((await host.s.call(at(code, "best"), { body: { order: 0 } })).status).toBe(409);
  expect((await host.s.call(at(code, "guess"), { body: { name: "x" } })).status).toBe(409);
  expect((await session().call(at(code, "best"), { body: { order: 0 } })).status).toBe(401);
  expect((await (await human("fx")).s.call(at(code, "best"), { body: { order: 0 } })).status).toBe(403);
  expect((await host.s.call(at(code, "best"), { body: { order: "0" } })).status).toBe(400);
  await host.s.call(at(code, "leave"), { body: {} });
});

// The leak checks and the whole game: one person and three bots play four rounds by themselves.
it("a bot game in Four rounds reaches game over by itself, moles named only at their reveals, nothing leaked", async () => {
  const host = await human("fb");
  const ids = await fillCrate(host.s, 4);
  const code = await newTable(host, { format: "four", pickSeconds: 5, voteSeconds: 6, slotSeconds: 2, autoplay: true });
  await addBots(host, code, 3);
  const seen = new Set<string>();
  const collect = async () => {
    if (!process.env.LOG_TOKEN) return;
    const text = await (await fetch(new URL(`/api/logs?table=${code}`, baseUrl), { headers: { authorization: `Bearer ${process.env.LOG_TOKEN}` } })).text();
    for (const l of text.split("\n")) if (l) seen.add(l);
  };
  const stream = await host.s.open(at(code, "events"));
  const me = async () => (await (await host.s.call(at(code, "me"))).json()) as Me;
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);

  const done = new Set<string>();
  const bestSeen = new Set<number>();
  const promptsSeenAsMole: string[] = [];
  const end = Date.now() + 280_000;
  let s = await state(host.s, code);
  let lastScores = "";
  while (!s.game?.winner && Date.now() < end) {
    const g = s.game!;
    const key = `${g.round}:${g.phase}`;
    // Scores in the public state change only when a reveal opens.
    const scores = JSON.stringify(g.scores);
    if (g.phase === "pick" || g.phase === "listen" || g.phase === "vote" || g.phase === "steal") {
      if (lastScores && g.round === Number(lastScores.split("|")[0])) expect(scores, `scores moved during ${key}`).toBe(lastScores.split("|")[1]);
      lastScores = `${g.round}|${scores}`;
    }
    if (g.phase === "vote") expect(g.bestTally).toBeDefined();
    else if (g.phase !== "vote") expect(g.bestTally).toBeUndefined();
    if (!done.has(key)) {
      const v = await me();
      if (v.role === "mole") expect(Object.keys(v)).not.toContain("prompt");
      if (g.phase === "pick" && !v.picked) {
        const song = ids.find((id) => !v.played.includes(id));
        if (song) { done.add(key); await host.s.call(at(code, "pick"), { body: { trackId: song } }); }
      } else if (g.phase === "vote") {
        done.add(key);
        // A bot may have borrowed from the host's crate: that card is theirs too, and refused.
        const other = g.cards!.find((c) => c.picker !== host.name && c.lender !== host.name)!;
        const mine = g.cards!.find((c) => c.picker === host.name || c.lender === host.name);
        if (mine) expect((await host.s.call(at(code, "best"), { body: { order: mine.order } })).status).toBe(400);
        expect((await host.s.call(at(code, "best"), { body: { order: other.order } })).status).toBe(200);
        bestSeen.add(other.order);
        expect(((await me()).best)).toEqual({ order: other.order });
        const bot = s.members.find((m) => m.bot)!;
        expect((await host.s.call(at(code, "vote"), { body: { name: bot.name } })).status).toBe(200);
      } else if (g.phase === "steal" && v.steal) {
        done.add(key);
        await host.s.call(at(code, "steal"), { body: { promptId: v.steal.options[0].id } });
      } else if (g.phase === "reveal") {
        done.add(key);
        await host.s.call(at(code, "advance"), { body: {} });
      }
    }
    await sleep(300);
    await collect();
    s = await state(host.s, code);
  }
  await collect();
  const g = s.game!;
  expect(g.winner, "the game should end by itself").toBe("points");
  expect(g.round).toBe(4);
  expect(g.past).toHaveLength(4);
  for (const p of g.past) expect(p.moles!.length).toBeGreaterThanOrEqual(1);
  expect(g.winners!.length).toBeGreaterThanOrEqual(1);
  const top = Math.max(...g.scores!.map((p) => p.score));
  expect(g.winners).toEqual(g.scores!.filter((p) => p.score === top).map((p) => p.name));
  expect(g.prompts).toHaveLength(4);
  // The stream never carried a mole list or a point before a reveal: the first frame with `moles` is a reveal or later.
  const frames = stream.seen.map((e) => e.data as Pub);
  for (const f of frames) {
    if (f.game && !["reveal"].includes(f.game.phase) && !f.game.winner) {
      expect(f.game.reveal).toBeUndefined();
      expect(f.game).not.toHaveProperty("moles");
    }
  }
  stream.close();
  if (process.env.LOG_TOKEN) {
    const mine = [...seen];
    expect(mine.some((l) => /last call · everyone has voted on both/.test(l))).toBe(true);
    expect(mine.filter((l) => /\] reveal · /.test(l))).toHaveLength(4);
    // One line per round at the lock names who cast each ballot, never for whom; none while open.
    const locks = mine.filter((l) => /votes in · mole: /.test(l));
    expect(locks).toHaveLength(4);
    for (const l of locks) expect(l, l).toMatch(/votes in · mole: .* \(\d+ of \d+\) · best pick: .* \(\d+ of \d+\) · round \d/);
    expect(mine.some((l) => /\) (voted|changed their vote|chose a best pick) · round/.test(l))).toBe(false);
    // No prompt before a reveal, and no ballot targets for either ballot.
    for (const l of mine) {
      if (/\] (reveal|game finished)/.test(l)) continue;
      expect(l, l).not.toMatch(/A song for/);
      expect(l, l).not.toMatch(/voted for|best pick of|card \d/);
    }
  }
  void promptsSeenAsMole;
  void bestSeen;
  await host.s.call(at(code, "leave"), { body: {} });
});

it("a Knockout game with a ghost: the ghost can guess, nobody sees it before game over, bots guess too", async () => {
  const host = await human("fk");
  const ids = await fillCrate(host.s, 3);
  const code = await newTable(host, { pickSeconds: 5, voteSeconds: 6, slotSeconds: 2, autoplay: true });
  await addBots(host, code, 4);
  const stream = await host.s.open(at(code, "events"));
  const me = async () => (await (await host.s.call(at(code, "me"))).json()) as Me & { guess?: { name: string } };
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  const done = new Set<string>();
  const end = Date.now() + 280_000;
  let s = await state(host.s, code);
  let guessed = false;
  while (!s.game?.winner && Date.now() < end) {
    const g = s.game!;
    const key = `${g.round}:${g.phase}`;
    const v = await me();
    if (v.role === "ghost" && g.phase === "vote" && !done.has(key)) {
      done.add(key);
      const target = s.members.find((m) => m.bot && (g as unknown as { alive: string[] }).alive.includes(m.name))!;
      expect((await host.s.call(at(code, "guess"), { body: { name: target.name } })).status).toBe(200);
      expect((await host.s.call(at(code, "guess"), { body: { name: host.name } })).status).toBe(400);
      expect((await me()).guess).toEqual({ name: target.name });
      guessed = true;
    } else if (!done.has(key) && v.role !== "ghost" && v.role !== "spectator") {
      if (g.phase === "pick" && !v.picked) {
        const song = ids.find((id) => !v.played.includes(id));
        if (song) { done.add(key); await host.s.call(at(code, "pick"), { body: { trackId: song } }); }
      } else if (g.phase === "vote") {
        done.add(key);
        // Vote someone out each round, so a ghost exists in the next one.
        const bot = s.members.find((m) => m.bot && (g as unknown as { alive: string[] }).alive.includes(m.name))!;
        await host.s.call(at(code, "vote"), { body: { name: bot.name } });
      } else if (g.phase === "steal" && v.steal) {
        done.add(key);
        await host.s.call(at(code, "steal"), { body: { promptId: v.steal.options[0].id } });
      }
    }
    if (g.phase === "reveal" && !done.has(key)) { done.add(key); await host.s.call(at(code, "advance"), { body: {} }); }
    // Until game over nothing public mentions a guess.
    if (!g.winner) expect(JSON.stringify(s)).not.toMatch(/ghostGuesses|"guess"/);
    await sleep(300);
    s = await state(host.s, code);
  }
  expect(s.game?.winner, "the game should end by itself").toMatch(/players|moles/);
  const end2 = s.game as unknown as { ghostGuesses?: { ghost: string; hits: number; guesses: { round: number; guess: string; hit: boolean }[] }[] };
  // Bots that became ghosts guessed too; whoever guessed is listed with their hits, and only now.
  expect(end2.ghostGuesses, "ghost guesses are shown at game over").toBeDefined();
  if (guessed) expect(end2.ghostGuesses!.some((x) => x.ghost === host.name)).toBe(true);
  for (const gg of end2.ghostGuesses!) expect(gg.hits).toBe(gg.guesses.filter((x) => x.hit).length);
  for (const f of stream.seen) if (!(f.data as Pub).game?.winner) expect(JSON.stringify(f.data)).not.toMatch(/ghostGuesses/);
  stream.close();
  await host.s.call(at(code, "leave"), { body: {} });
});
