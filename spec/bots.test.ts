import { expect, it, vi } from "vitest";
import { baseUrl, fillCrate, session, uniqueName } from "./helpers";

// Contract for the host's table setup (CLAUDE.md "Bots", "Moles"):
//   POST /api/tables/:code/bots           host only, between games: seats a bot (labelled "bot": true in
//                                         the public members, name "bot-..."), 8 seats in all
//   POST /api/tables/:code/bots/remove {name}   host only: sends a bot home
//   POST /api/tables/:code/moles {moles: 1|2|null}   host only; 2 needs 6 seated (a third of the table)
//   POST /api/tables/:code/rematch {in}   anyone seated, once a game has finished; public, reset at start
//   POST /api/tables {pace?: "quick"|"normal"|"chill", pickSeconds?, ...}
// Members carry crateCount (sorted songs, public) next to crateReady.

vi.setConfig({ testTimeout: 300_000 });
type Session = ReturnType<typeof session>;
type Member = { name: string; crateReady: boolean; crateCount: number; bot?: true; in?: true };
type State = {
  status: string; host: string; moleChoice: number | null; members: Member[];
  game?: { round: number; phase: string; deadline: number | null; winner?: string; moles?: string[]; reveal?: { prompt: string } };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (code: string, p: string) => `/api/tables/${code}/${p}`;

async function human(prefix: string) {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}
const state = async (s: Session, code: string) => (await (await s.call(`/api/tables/${code}`)).json()) as State;
async function until(s: Session, code: string, ok: (st: State) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(s, code);
    if (ok(st)) return st;
    if (Date.now() > end) throw new Error(`timed out waiting: ${JSON.stringify(st).slice(0, 300)}`);
    await sleep(300);
  }
}
async function newTable(h: { s: Session }, body: Record<string, unknown> = {}) {
  return ((await (await h.s.call("/api/tables", { body })).json()) as { code: string }).code;
}
async function addBots(h: { s: Session }, code: string, n: number) {
  for (let i = 0; i < n; i++) expect((await h.s.call(at(code, "bots"), { body: {} })).status).toBe(201);
  // A bot builds its crate in the background the first time it is used.
  return until(h.s, code, (st) => st.members.filter((m) => m.bot).every((m) => m.crateReady), 120_000);
}

it("lets the host add and remove bots, labelled as bots; a guest can't", async () => {
  const host = await human("bh");
  const guest = await human("bg");
  const code = await newTable(host);
  await guest.s.call(at(code, "join"), { body: {} });
  expect((await guest.s.call(at(code, "bots"), { body: {} })).status).toBe(403);
  expect((await guest.s.call(at(code, "bots/remove"), { body: { name: "bot-ivy" } })).status).toBe(403);
  const added = (await (await host.s.call(at(code, "bots"), { body: {} })).json()) as State;
  const bots = added.members.filter((m) => m.bot);
  expect(bots).toHaveLength(1);
  expect(bots[0].name).toMatch(/^bot-/);
  expect(added.host).toBe(host.name);
  // Nobody can sign in as a bot, and a person can't take its name.
  const sneak = session();
  expect([400, 403]).toContain((await sneak.call("/api/join", { body: { name: bots[0].name, pin: "1357" } })).status);
  expect((await host.s.call(at(code, "bots/remove"), { body: { name: "nobody" } })).status).toBe(404);
  expect((await host.s.call(at(code, "bots/remove"), { body: { name: guest.name } })).status).toBe(404);
  const gone = (await (await host.s.call(at(code, "bots/remove"), { body: { name: bots[0].name } })).json()) as State;
  expect(gone.members.some((m) => m.bot)).toBe(false);
  expect(gone.members).toHaveLength(2);
});

it("seats at most 8, bots included", async () => {
  const host = await human("b8");
  const code = await newTable(host);
  for (let i = 0; i < 7; i++) expect((await host.s.call(at(code, "bots"), { body: {} })).status).toBe(201);
  const res = await host.s.call(at(code, "bots"), { body: {} });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/full.*8/);
  const st = await state(host.s, code);
  expect(st.members).toHaveLength(8);
  expect(new Set(st.members.map((m) => m.name)).size).toBe(8);
  const door = await human("b9");
  expect((await door.s.call(at(code, "join"), { body: {} })).status).toBe(409);
  // A table made only of bots does not outlive its last person.
  await host.s.call(at(code, "leave"), { body: {} });
  expect((await (await fetch(new URL(at(code, "").replace(/\/$/, ""), baseUrl))).json() as State).members).toHaveLength(0);
});

it("validates pace presets and timings on the server", async () => {
  const h = await human("bp");
  expect((await h.s.call("/api/tables", { body: { pace: "turbo" } })).status).toBe(400);
  expect((await h.s.call("/api/tables", { body: { pace: 3 } })).status).toBe(400);
  expect((await h.s.call("/api/tables", { body: { pace: "quick", pickSeconds: "soon" } })).status).toBe(400);
  expect((await h.s.call("/api/tables", { body: { pace: "chill", voteSeconds: 1.5 } })).status).toBe(400);
  for (const pace of ["quick", "normal", "chill", undefined]) expect((await h.s.call("/api/tables", { body: { pace } })).status).toBe(201);
});

it("starts a Quick table with 30 s to pick, and Chill with 60", async () => {
  for (const [pace, secs] of [["quick", 30], ["chill", 60]] as const) {
    const host = await human(`bq${pace[0]}`);
    await fillCrate(host.s, 3);
    // Private: another spec's quick seat must not sit a stranger at a table we mean to start.
    const code = await newTable(host, { pace, private: true });
    await addBots(host, code, 2);
    const started = await host.s.call(at(code, "start"), { body: {} });
    expect(started.status, JSON.stringify(await started.clone().json())).toBeLessThan(300);
    const st = await until(host.s, code, (s) => s.game?.phase === "pick");
    const left = (st.game!.deadline! - Date.now()) / 1000;
    expect(left).toBeGreaterThan(secs - 6);
    expect(left).toBeLessThanOrEqual(secs + 1);
    await host.s.call(at(code, "leave"), { body: {} });
  }
});

it("refuses 2 moles under 6 players and accepts them at 6; only the host chooses", async () => {
  const host = await human("bm");
  const guest = await human("bmg");
  const code = await newTable(host);
  await guest.s.call(at(code, "join"), { body: {} });
  expect((await guest.s.call(at(code, "moles"), { body: { moles: 1 } })).status).toBe(403);
  expect((await host.s.call(at(code, "moles"), { body: { moles: 3 } })).status).toBe(400);
  expect((await host.s.call(at(code, "moles"), { body: { moles: "2" } })).status).toBe(400);
  expect((await host.s.call(at(code, "moles"), { body: { moles: 0 } })).status).toBe(400);
  expect((await host.s.call(at(code, "moles"), { body: { moles: 1 } })).status).toBe(200);
  await host.s.call(at(code, "bots"), { body: {} });
  await host.s.call(at(code, "bots"), { body: {} });
  await host.s.call(at(code, "bots"), { body: {} });
  expect(await state(host.s, code)).toMatchObject({ moleChoice: 1 });
  expect((await host.s.call(at(code, "moles"), { body: { moles: 2 } })).status).toBe(409); // 5 seated
  await host.s.call(at(code, "bots"), { body: {} });
  const res = await host.s.call(at(code, "moles"), { body: { moles: 2 } }); // 6 seated
  expect(res.status).toBe(200);
  expect(((await res.json()) as State).moleChoice).toBe(2);
  expect((await host.s.call(at(code, "moles"), { body: { moles: null } })).status).toBe(200);
  expect((await state(host.s, code)).moleChoice).toBeNull();
});

it("shows who the table waits on with a count, and nothing private", async () => {
  const host = await human("bw");
  const slow = await human("bws");
  await fillCrate(host.s, 4);
  await slow.s.call("/api/taste", { body: { trackId: 1123844, slot: "up" } });
  const code = await newTable(host);
  await slow.s.call(at(code, "join"), { body: {} });
  const raw = await (await slow.s.call(`/api/tables/${code}`)).text();
  const st = JSON.parse(raw) as State;
  expect(st.members.find((m) => m.name === host.name)).toMatchObject({ crateReady: true, crateCount: 12 });
  expect(st.members.find((m) => m.name === slow.name)).toMatchObject({ crateReady: false, crateCount: 1 });
  for (const m of st.members) expect(Object.keys(m).sort()).toEqual(expect.arrayContaining(["avatar", "crateCount", "crateReady", "name"]));
  for (const m of st.members) expect(Object.keys(m).every((k) => ["name", "avatar", "crateReady", "crateCount", "bot", "in", "crate"].includes(k))).toBe(true);
  expect(raw).not.toMatch(/"(pin\w*|\w*hash|\w*salt|token|session\w*|id|personId|trackId|title)"\s*:/i);
  // The page the guest opens carries the waiting-on and finish-your-crate controls.
  const page = await (await slow.s.call(`/t/${code}`)).text();
  expect(page).toContain('id="waiting"');
  expect(page).toMatch(/id="crate-me"[^>]*href="\/taste\?next=\/t\/[A-Z]{4}"/);
  expect(page).toContain("The next game starts after this one");
});

it("rematch: refused before a game ends; \"I'm in\" is public and resets at the next start", async () => {
  const host = await human("br");
  const code = await newTable(host);
  expect((await host.s.call(at(code, "rematch"), { body: { in: true } })).status).toBe(409);
  const stranger = await human("brx");
  expect((await stranger.s.call(at(code, "rematch"), { body: { in: true } })).status).toBe(403);
});

it("a bot game with 1 human and 3 bots runs to game over by itself, then a rematch resets 'in'", async () => {
  const host = await human("bg1");
  const ids = await fillCrate(host.s, 5);
  const code = await newTable(host, { pickSeconds: 5, voteSeconds: 5, slotSeconds: 2, autoplay: true });
  await addBots(host, code, 3);
  // The log ring is small and shared with every other spec running at once: collect this table's lines as they come.
  const seen = new Set<string>();
  const collect = async () => {
    if (!process.env.LOG_TOKEN) return;
    const text = await (await fetch(new URL(`/api/logs?table=${code}`, baseUrl), { headers: { authorization: `Bearer ${process.env.LOG_TOKEN}` } })).text();
    for (const l of text.split("\n")) if (l) seen.add(l);
  };
  await collect();
  const me = async () => (await (await host.s.call(at(code, "me"))).json()) as { role: string; picked: boolean; borrowUsed: boolean; played: number[]; steal?: { options: { id: string }[] } };
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);

  // The human plays along: picks, votes for a bot, steals, and moves each reveal on.
  const done = new Set<string>();
  const end = Date.now() + 280_000;
  let st = await state(host.s, code);
  while (!st.game?.winner && Date.now() < end) {
    const g = st.game!;
    const key = `${g.round}:${g.phase}`;
    if (!done.has(key)) {
      const v = await me();
      if (g.phase === "pick" && !v.picked && (v.role === "player" || v.role === "mole")) {
        const song = ids.find((id) => !v.played.includes(id));
        if (song) { done.add(key); await host.s.call(at(code, "pick"), { body: { trackId: song } }); }
      } else if (g.phase === "vote" && (v.role === "player" || v.role === "mole")) {
        done.add(key);
        const bot = st.members.find((m) => m.bot && (g as any).tally?.some((t: { name: string }) => t.name === m.name));
        await host.s.call(at(code, "vote"), { body: bot ? { name: bot.name } : { skip: true } });
      } else if (g.phase === "steal" && v.steal) {
        done.add(key);
        await host.s.call(at(code, "steal"), { body: { promptId: v.steal.options[0].id } });
      } else if (g.phase === "reveal") {
        done.add(key);
        await host.s.call(at(code, "advance"), { body: {} });
      }
    }
    await sleep(400);
    await collect();
    st = await state(host.s, code);
  }
  await collect();
  expect(st.game?.winner, "the game should end by itself").toMatch(/players|moles|none/);
  expect(st.game?.winner).not.toBe("none");

  // The bots acted like people in the log, and no prompt appears before a reveal (read now: the ring is shared).
  if (process.env.LOG_TOKEN) {
    const mine = [...seen];
    expect(mine.some((l) => /added a bot \(bot-/.test(l))).toBe(true);
    expect(mine.some((l) => /bot-[\w]+ \(p:\w{4}\) picked a track/.test(l))).toBe(true);
    // Votes are logged once, at the lock, as who voted (never for whom).
    expect(mine.some((l) => /votes in: .*bot-[\w]+ \(p:\w{4}\)/.test(l))).toBe(true);
    expect(mine.some((l) => /\) voted · round/.test(l))).toBe(false);
    for (const l of mine) if (/picked|voted|steal/.test(l) && !/reveal|finished/.test(l)) expect(l).not.toMatch(/A song for|mole/i);
  }

  // History lists people: the bots are a count, never a name.
  const hist = (await (await host.s.call("/api/history")).json()) as { code: string; players: string[]; bots?: number }[];
  const mineGame = hist.find((x) => x.code === code)!;
  expect(mineGame.players).toEqual([host.name]);
  expect(mineGame.bots).toBe(3);

  // Game over: bots say they're in by themselves, the human toggles, and nobody is held up by it.
  st = await until(host.s, code, (s) => s.members.filter((m) => m.bot && m.in).length === 3, 30_000);
  expect(st.members.find((m) => m.name === host.name)?.in).toBeUndefined();
  const inRes = await host.s.call(at(code, "rematch"), { body: { in: true } });
  expect(((await inRes.json()) as State).members.filter((m) => m.in)).toHaveLength(4);
  await host.s.call(at(code, "rematch"), { body: { in: false } });
  expect((await state(host.s, code)).members.filter((m) => m.in)).toHaveLength(3);
  // Between games (game over included) the host may still add a bot.
  expect((await host.s.call(at(code, "bots"), { body: {} })).status).toBe(201);
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  st = await until(host.s, code, (s) => s.game?.phase === "pick" && !s.game.winner);
  expect(st.members.some((m) => m.in)).toBe(false);
  await host.s.call(at(code, "leave"), { body: {} });
  // The people left are none: the bots left with them.
  expect((await state(host.s, code)).members).toHaveLength(0);

}, 400_000);

// Contract: a person can't be named like a bot (400 with a reason), whatever the case or the spacing.
it("refuses names that start with bot- (or flatten to it), and the same for sign-in", async () => {
  for (const name of ["bot-zed", "BOT-zed", "Bot-Zq", "bot_zed", "bot zed", "bot . zed", "\uFF42ot-zed", "b\u200Bot-zed", "bót-zed"]) {
    const res = await session().call("/api/join", { body: { name, pin: "1357" } });
    expect(res.status, name).toBe(400);
    expect(((await res.json()) as { error: string }).error, name).toMatch(/bot-/);
  }
  // Ordinary names that merely contain or start like it are fine.
  for (const name of ["robot-" + uniqueName("x"), uniqueName("bottle"), uniqueName("bo-t")]) {
    expect((await session().call("/api/join", { body: { name, pin: "1357" } })).status, name).toBe(200);
  }
});

// Contract: bot names are unique per table, not across the server, so many tables can all have bots.
// A host's bots are capped across their tables (14), with a clear message.
it("gives every table its own bots: 8 hosts fill 6 seats each (48 bots, more than there are names); a host is capped at 14", async () => {
  const hosts = await Promise.all(Array.from({ length: 8 }, (_, i) => human(`bt${i}`)));
  const tablesMade: { h: (typeof hosts)[number]; code: string }[] = [];
  for (const h of hosts) {
    const code = await newTable(h);
    tablesMade.push({ h, code });
    for (let i = 0; i < 6; i++) {
      const res = await h.s.call(at(code, "bots"), { body: {} });
      expect(res.status, `${h.name} bot ${i + 1}`).toBe(201);
    }
  }
  for (const { h, code } of tablesMade) {
    const st = await state(h.s, code);
    const bots = st.members.filter((m) => m.bot).map((m) => m.name);
    expect(bots).toHaveLength(6);
    expect(new Set(bots.map((n) => n.toLowerCase())).size, "unique at the table").toBe(6);
    expect(bots.every((n) => /^bot-/.test(n))).toBe(true);
  }
  // One account, three tables: 7 + 7 bots, then the cap speaks.
  const solo = hosts[0];
  const [t2, t3] = [await newTable(solo), await newTable(solo)];
  // Table 1 already has 6: one more makes 7, table 2 takes 7 (14 in all).
  const first = tablesMade[0].code;
  expect((await solo.s.call(at(first, "bots"), { body: {} })).status).toBe(201);
  for (let i = 0; i < 7; i++) expect((await solo.s.call(at(t2, "bots"), { body: {} })).status).toBe(201);
  const capped = await solo.s.call(at(t3, "bots"), { body: {} });
  expect(capped.status).toBe(409);
  expect(((await capped.json()) as { error: string }).error).toMatch(/14 bots/);
  // Another host is not held up by it.
  expect((await hosts[1].s.call(at(tablesMade[1].code, "bots"), { body: {} })).status).toBe(201);
  // Everyone leaves: the bots go with them, so the next host can have them.
  for (const { h, code } of tablesMade) await h.s.call(at(code, "leave"), { body: {} });
  await solo.s.call(at(t2, "leave"), { body: {} });
  const after = await state(solo.s, t2);
  expect(after.members).toHaveLength(0);
});

it("host leaving mid-game ends the game and takes the bots with them", async () => {
  const host = await human("bhl");
  await fillCrate(host.s, 5);
  const code = await newTable(host, { pace: "quick" });
  await addBots(host, code, 2);
  expect((await host.s.call(at(code, "start"), { body: {} })).status).toBeLessThan(300);
  await until(host.s, code, (s) => s.game?.phase === "pick");
  await host.s.call(at(code, "leave"), { body: {} });
  const st = await state(host.s, code);
  expect(st.members).toHaveLength(0);
});
