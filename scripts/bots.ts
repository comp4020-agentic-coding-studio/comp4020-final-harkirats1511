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

// The brain is the server's own (src/lib/bots/brain.ts): the same picking, borrowing, voting and
// stealing, deciding only from /me and the public state. The app can also seat bots itself now
// (the host's "Add a bot" button); this script is for testing against any server over HTTP.
// It plays both formats: Knockout (pick, vote, steal, and a ghost's private guess) and Four rounds
// (pick, the mole vote, and a best pick that isn't its own card).
import { decideBest, decideGuess, decidePick, decideSteal, decideVote, type MeView, type Pub } from "../src/lib/bots/brain.ts";

const PIN = "2580";
// A crate is 3 songs in each of 4 slots; the app refuses a start until every player has one.
const SLOTS = ["up", "down", "out", "in"] as const;
const PER_SLOT = 3;
// Words searched per slot to find songs that fit its mood. Bots ask Deezer's public
// search directly (the app's search hides previews and the explicit flag), trying the
// bot's own genre first so tastes differ, and keep only songs with a preview, no explicit lyrics.
const SLOT_WORDS: Record<(typeof SLOTS)[number], string> = { up: "dance anthem", down: "sad piano", out: "party", in: "lofi chill" };
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

type Track = { id: number; title: string; artist: string; slot?: string | null };
type Game = {
  format?: string; round: number; phase: string; deadline: number | null; alive: string[]; ghosts: string[]; winner?: string; accused?: string;
  tally?: { name: string }[];
};
type State = { status: string; host: string; members: { name: string; crate?: { trackId: number; title: string; slot: string | null }[] }[]; game?: Game };
type Me = {
  role: string; prompt?: string; slot?: string; picked: boolean; borrowUsed: boolean; played: number[];
  steal?: { options: { id: string; text: string }[] };
};

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
  members: State["members"] = [];
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
    try {
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=50`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { data?: { id: number; title: string; preview?: string; explicit_lyrics?: boolean; artist?: { name?: string } }[] };
      const ok = (body.data ?? []).filter((r) => r.preview && !r.explicit_lyrics).map((r) => ({ id: r.id, title: r.title, artist: r.artist?.name ?? "" }));
      if (ok.length) return ok;
    } catch { /* fall back to the app's own search */ }
    const r = await this.call(`/api/search?q=${encodeURIComponent(q)}`);
    return r.ok && Array.isArray(r.data) ? (r.data as Track[]) : [];
  }

  // Builds a complete 12-track crate: searches the slot's words (with the bot's
  // genre first) and adds songs it doesn't already have until it has 3 in each slot.
  async setup() {
    const j = await this.call("/api/join", { name: this.name, pin: PIN });
    if (!j.ok) throw new Error(`${this.name} could not sign in`);
    const t = await this.call("/api/taste");
    this.taste = t.ok && Array.isArray(t.data) ? t.data : [];
    // Rows from before slots (no slot) fill the cap and count for nothing: clear them.
    for (const old of this.taste.filter((x) => !x.slot)) await this.call(`/api/taste/${old.id}`, undefined, "DELETE");
    this.taste = this.taste.filter((x) => x.slot);
    const have = new Set(this.taste.map((x) => x.id));
    for (const slot of SLOTS) {
      const mine = () => this.taste.filter((x) => x.slot === slot).length;
      if (mine() >= PER_SLOT) continue;
      const found = [...(await this.search(`${this.genre} ${SLOT_WORDS[slot]}`)), ...(await this.search(SLOT_WORDS[slot]))];
      for (const tr of found) {
        if (mine() >= PER_SLOT) break;
        if (have.has(tr.id)) continue;
        const r = await this.call("/api/taste", { trackId: tr.id, slot });
        if (r.ok && Array.isArray(r.data)) { this.taste = r.data; have.add(tr.id); }
      }
    }
    if (!SLOTS.every((s) => this.taste.filter((x) => x.slot === s).length === PER_SLOT)) {
      throw new Error(`${this.name} could not build a complete crate (${this.taste.length} tracks); it may be locked or have unslotted tracks`);
    }
    log(this.name, `signed in, crate of ${this.taste.length} tracks (${this.genre})`);
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
    this.members = s.members;
    const key = `${g.round}:${g.phase}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const mine = ++this.run;
    if (g.phase === "pick") void this.pick(g, mine);
    else if (g.phase === "vote") void this.vote(g, mine);
    else if (g.phase === "steal") void this.steal(g, mine);
    else if (g.phase === "reveal") log(this.name, `round ${g.round} reveal`);
  }

  async pick(g: Game, mine: number) {
    const me = (await this.call(`/api/tables/${code}/me`)).data as Me | null;
    if (!me) return;
    if (mine !== this.run) return;
    if (me.role === "spectator") { log(this.name, `round ${g.round}: spectating`); return; }
    // Never the role, the prompt or the slot: the human host reads this terminal.
    log(this.name, `round ${g.round}: picking`);
    if (me.picked || me.role === "ghost") return;
    const wait = this.delay(3, 15, g.deadline);
    await sleep(wait);
    if (mine !== this.run) return;
    // The crate may be short of unplayed songs late in a long game; then it sits out.
    const view = (await this.call(`/api/tables/${code}/me`)).data as Me;
    const pub = (await this.call(`/api/tables/${code}`)).data as Pub;
    // Its own crate is in the public state only while a game runs; it also knows it from building it.
    const own = pub.members.find((m) => m.name === this.name);
    if (own && !own.crate) own.crate = this.taste.map((t) => ({ trackId: t.id, title: t.title, slot: (t.slot as MeView["slot"]) ?? null }));
    const choice = decidePick(view as MeView, this.name, pub);
    if (!choice) return;
    const r = await this.call(`/api/tables/${code}/pick`, { trackId: choice.trackId, ...(choice.from ? { from: choice.from } : {}) });
    if (r.ok) log(this.name, "picked a track");
  }

  async vote(g: Game, mine: number) {
    const me = (await this.call(`/api/tables/${code}/me`)).data as Me | null;
    if (!me || mine !== this.run) return;
    // A Knockout ghost can't vote: it makes a private guess at who the mole is (changeable).
    const ghost = me.role === "ghost";
    if (!ghost && me.role !== "player" && me.role !== "mole") return;
    await sleep(this.delay(3, 12, g.deadline));
    if (mine !== this.run) return;
    // A player whose song is off the round's mood first, else a random name.
    const cast = async () => {
      const pub = (await this.call(`/api/tables/${code}`)).data as Pub;
      const view = (await this.call(`/api/tables/${code}/me`)).data as Me;
      if (ghost) {
        const name = decideGuess(view as MeView, this.name, pub);
        if (name && (await this.call(`/api/tables/${code}/guess`, { name })).ok) log(this.name, "guessed");
        return;
      }
      const pick = decideVote(view as MeView, this.name, pub);
      const r = await this.call(`/api/tables/${code}/vote`, pick === "skip" ? { skip: true } : pick);
      if (r.ok) log(this.name, "voted");
      // Four rounds: the second ballot, a best pick that isn't its own card.
      if (pub.game?.format === "four") {
        const order = decideBest(view as MeView, this.name, pub);
        if (order !== null && (await this.call(`/api/tables/${code}/best`, { order })).ok) log(this.name, "chose a best pick");
      }
    };
    await cast();
    // May change its mind once, before the vote locks.
    if (Math.random() < 0.4) {
      await sleep(this.delay(1, 3, g.deadline));
      if (mine === this.run) await cast();
    }
  }

  // A voted-out mole guesses one of the eight prompts, leaning on the songs just played.
  async steal(g: Game, mine: number) {
    const me = (await this.call(`/api/tables/${code}/me`)).data as Me | null;
    if (!me?.steal || mine !== this.run) return;
    await sleep(this.delay(2, 8, g.deadline));
    if (mine !== this.run) return;
    const guess = decideSteal(me as MeView, (await this.call(`/api/tables/${code}`)).data as Pub);
    if (!guess) return;
    const r = await this.call(`/api/tables/${code}/steal`, { promptId: guess });
    if (r.ok) log(this.name, "guessed");
  }
}

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
