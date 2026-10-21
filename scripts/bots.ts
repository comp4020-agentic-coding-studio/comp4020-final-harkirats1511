#!/usr/bin/env node
// Playtest bots: DEV/TESTING TOOL ONLY. Not part of the app and not shipped in
// the Docker runtime image. You host a table in your own browser; the bots
// take the other seats and play by the rules (pick, vote, leave).
//
//   pnpm bots <TABLECODE> [count=3] [--url <base>] [--stay]
//
// Default base is $APP_URL or the deployed site. The bots never start the game:
// the human host does. Names are fixed (bot-ada, bot-bix, ...) and so is the PIN
// below, so the same bots come back on every run. The PIN is not a secret; this
// is a test tool. Ctrl+C makes every bot leave the table, then exits. Without
// --stay the script also exits when the game finishes.

const PIN = "2580";
const MIN_CRATE = 5; // the app refuses a start until every player has this many
const DEFAULT_URL = "https://comp4020-final-harkirats1511.fly.dev";
// One name and one taste word per bot, so tastes differ.
const BOTS = [
  { name: "bot-ada", genre: "jazz" },
  { name: "bot-bix", genre: "metal" },
  { name: "bot-cyd", genre: "kpop" },
  { name: "bot-dax", genre: "disco" },
  { name: "bot-eli", genre: "reggae" },
  { name: "bot-fay", genre: "folk" },
];

type Track = { id: number; title: string; artist: string };
type Game = { round: number; phase: string; deadline: number | null; alive: string[]; ghosts: string[]; winner?: string };
type State = { status: string; host: string; members: { name: string }[]; game?: Game };
type Me = { role: string; theme?: string; picked?: boolean };

const args = process.argv.slice(2);
let base = process.env.APP_URL ?? DEFAULT_URL;
let stay = false;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") base = args[++i] ?? base;
  else if (args[i] === "--stay") stay = true;
  else positional.push(args[i]);
}
const code = positional[0]?.toUpperCase();
const count = Number(positional[1] ?? 3);
if (!code || !Number.isInteger(count) || count < 1 || count > BOTS.length) {
  console.error(`usage: pnpm bots <TABLECODE> [count 1-${BOTS.length}, default 3] [--url <base>] [--stay]`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pickOne = <T>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)];
const log = (who: string, msg: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${who.padEnd(8)} ${msg}`);

class Bot {
  cookie = "";
  taste: Track[] = [];
  lastKey = "";
  run = 0; // bumped on every new phase; stale timers drop out
  left = false;
  name: string;
  genre: string;
  constructor(name: string, genre: string) {
    this.name = name;
    this.genre = genre;
  }

  async call(path: string, body?: unknown, method?: string): Promise<{ ok: boolean; status: number; data: any }> {
    try {
      const res = await fetch(new URL(path, base), {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) this.cookie = set.map((c) => c.split(";")[0]).join("; ");
      const text = await res.text();
      let data: any = text;
      try { data = JSON.parse(text); } catch { /* keep text */ }
      if (!res.ok) log(this.name, `! ${method ?? (body === undefined ? "GET" : "POST")} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      log(this.name, `! ${path} failed: ${(e as Error).message}`);
      return { ok: false, status: 0, data: null };
    }
  }

  async search(q: string): Promise<Track[]> {
    const r = await this.call(`/api/search?q=${encodeURIComponent(q)}`);
    return r.ok && Array.isArray(r.data) ? (r.data as Track[]) : [];
  }

  async setup() {
    const j = await this.call("/api/join", { name: this.name, pin: PIN });
    if (!j.ok) throw new Error(`${this.name} could not sign in`);
    const t = await this.call("/api/taste");
    this.taste = t.ok && Array.isArray(t.data) ? t.data : [];
    if (this.taste.length < 5) {
      const found = await this.search(this.genre);
      const have = new Set(this.taste.map((x) => x.id));
      const want = Math.floor(rand(5, 9));
      let added = 0;
      for (const tr of found) {
        if (this.taste.length >= want || added >= 8) break;
        if (have.has(tr.id)) continue;
        const r = await this.call("/api/taste", { trackId: tr.id });
        if (r.ok && Array.isArray(r.data)) { this.taste = r.data; have.add(tr.id); added++; }
      }
    }
    if (this.taste.length < MIN_CRATE) throw new Error(`${this.name} could only build a crate of ${this.taste.length} (needs ${MIN_CRATE})`);
    log(this.name, `signed in, taste file has ${this.taste.length} tracks (${this.genre})`);
    const jr = await this.call(`/api/tables/${code}/join`, {});
    if (!jr.ok) throw new Error(`${this.name} could not join ${code}`);
    log(this.name, `joined ${code}`);
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    this.run++;
    const r = await this.call(`/api/tables/${code}/leave`, {});
    if (r.ok) log(this.name, "left the table");
  }

  // Milliseconds to wait: random in [lo, hi] s, but never later than deadline - 2 s.
  delay(lo: number, hi: number, deadline: number | null): number {
    let ms = rand(lo, hi) * 1000;
    if (deadline) ms = Math.min(ms, deadline - 2000 - Date.now());
    return Math.max(0, ms);
  }

  onState(s: State) {
    const g = s.game;
    if (!g || s.status === "finished" || g.winner) { if (!g?.winner) this.lastKey = ""; return; }
    const key = `${g.round}:${g.phase}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const mine = ++this.run;
    if (g.phase === "pick") void this.pick(g, mine);
    else if (g.phase === "vote") void this.vote(g, mine);
    else if (g.phase === "reveal") log(this.name, `round ${g.round} reveal`);
  }

  // Bots can't judge a theme, so they play from their own taste file at random:
  // the server only accepts picks from your own crate. The theme is only logged.
  async chooseTrack(): Promise<Track | undefined> {
    return pickOne(this.taste);
  }

  async pick(g: Game, mine: number) {
    const me = (await this.call(`/api/tables/${code}/me`)).data as Me | null;
    if (!me) return;
    if (mine !== this.run) return;
    if (me.role === "spectator") { log(this.name, `round ${g.round}: spectating`); return; }
    log(this.name, `round ${g.round}: theme "${me.theme ?? "?"}" (${me.role})`);
    if (me.picked) return;
    // Prepare the choice while "thinking"; the delay counts from round start.
    const wait = this.delay(3, 15, g.deadline);
    const t0 = Date.now();
    const track = await this.chooseTrack();
    await sleep(Math.max(0, wait - (Date.now() - t0)));
    if (mine !== this.run || !track) return;
    const r = await this.call(`/api/tables/${code}/pick`, { trackId: track.id });
    if (r.ok) log(this.name, `picked "${track.title}" by ${track.artist}`);
  }

  async vote(g: Game, mine: number) {
    const me = (await this.call(`/api/tables/${code}/me`)).data as Me | null;
    if (!me || mine !== this.run) return;
    if (me.role !== "player") return;
    if (!me.picked) { log(this.name, `round ${g.round}: sits the vote out (no pick)`); return; }
    await sleep(this.delay(3, 12, g.deadline));
    if (mine !== this.run) return;
    // Votes are on tracks now. Pick a random slot that is not (we think) our own, or skip.
    // The bot does not know which slot is its own pick (slots are anonymous), so it
    // just votes at random; a vote for your own track is allowed by the server.
    const cast = async () => {
      const n = ((await this.call(`/api/tables/${code}`)).data as { game?: { tally?: { slot: number }[] } } | null)?.game?.tally ?? [];
      const choice = n.length && Math.random() < 0.8 ? { slot: pickOne(n)!.slot } : { skip: true };
      const r = await this.call(`/api/tables/${code}/vote`, choice);
      if (r.ok) log(this.name, "voted" + ("skip" in choice ? " skip" : ` ${sideOf(choice.slot, n.length)}`));
    };
    await cast();
    // May change its mind once, before the vote locks.
    if (Math.random() < 0.4) {
      await sleep(this.delay(1, 3, g.deadline));
      if (mine === this.run) await cast();
    }
  }
}

const sideOf = (n: number, total: number) => {
  const half = Math.max(1, Math.ceil(total / 2));
  return `${n < half ? "A" : "B"}${(n % half) + 1}`;
};

const bots = BOTS.slice(0, count).map((b) => new Bot(b.name, b.genre));
let finished = false;

async function shutdown(code_: number) {
  if (finished) return;
  finished = true;
  await Promise.all(bots.map((b) => b.leave()));
  process.exit(code_);
}
process.on("SIGINT", () => { console.log("\nCtrl+C: bots leaving"); void shutdown(0); });
process.on("SIGTERM", () => void shutdown(0));

// One SSE connection feeds every bot; reconnects when it drops.
async function follow() {
  let announcedWinner = false;
  for (;;) {
    try {
      const res = await fetch(new URL(`/api/tables/${code}/events`, base), { headers: { accept: "text/event-stream" } });
      if (res.status === 404) { console.error(`no such table ${code}`); await shutdown(1); return; }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data || !block.includes("event: state")) continue;
          const s = JSON.parse(data) as State;
          if (s.status === "finished" || s.game?.winner) {
            if (!announcedWinner) {
              announcedWinner = true;
              log("table", `game finished, winner: ${s.game?.winner ?? "?"}`);
              if (!stay) { await shutdown(0); return; }
            }
          } else announcedWinner = false;
          for (const b of bots) b.onState(s);
        }
      }
      throw new Error("stream ended");
    } catch (e) {
      if (finished) return;
      log("table", `stream dropped (${(e as Error).message}), reconnecting`);
      await sleep(2000);
    }
  }
}

for (const b of bots) {
  try { await b.setup(); } catch (e) { console.error((e as Error).message); await shutdown(1); }
}
log("table", `${bots.length} bots seated at ${code} on ${base}; start the game from your browser`);
await follow();
