// Bots that play inside the server. A bot is a person row with is_bot set, seated at a
// table like anyone; this module wakes on table changes and plays its turn after a
// human-like pause.
//
// THE RULE THIS FILE KEEPS: a bot decides only from what a real player is given, the
// same two things the browser gets: its own `myView` (what GET /me returns) and the
// public table state (what every stream carries). It acts only through the functions the
// API routes call (pickTrack, castVote, castSteal) with its own person id, so the engine
// applies exactly the checks it applies to people. It never reads game_players, the
// prompts, other players' roles, or this round's hidden picks, and a bot that is the mole
// is handed a /me with no prompt in it. This file imports no database: seating bots (which needs one)
// is in seats.ts, which nothing here may import. spec/bots-engine.test.ts checks both from outside.
import { castSteal, castVote, myView, pickTrack } from "../game.ts";
import { log } from "../log.ts";
import { botSeats, notifyTable, onTableChange, setRematch, tableFrame } from "../tables.ts";
import { decidePick, decideSteal, decideVote, DELAYS, thinkMs, type MeView, type Pub } from "./brain.ts";

// ---- playing ----

// Per bot: the phase it last reacted to, and its pending timers (dropped on any new phase).
type Mind = { key: string; timers: NodeJS.Timeout[] };
const minds = new Map<string, Mind>();
const mindOf = (code: string, id: string) => {
  const k = `${code}:${id}`;
  let m = minds.get(k);
  if (!m) minds.set(k, (m = { key: "", timers: [] }));
  return m;
};
const later = (m: Mind, ms: number, fn: () => void) => {
  const t = setTimeout(() => {
    try {
      fn();
    } catch (e) {
      log("bots", `a bot's move failed: ${(e as Error).message}`);
    }
  }, ms);
  t.unref();
  m.timers.push(t);
};

// What a player gets: the public state and this person's own /me. The one place a bot's inputs are made.
export function botView(code: string, id: string): { pub: Pub; me: MeView } | null {
  const frame = tableFrame(code);
  if (!frame) return null;
  return { pub: frame.state as unknown as Pub, me: myView(code, id) as MeView };
}

export function react(code: string) {
  const bots = botSeats(code);
  const live = new Set(bots.map((b) => `${code}:${b.id}`));
  for (const k of [...minds.keys()]) if (k.startsWith(`${code}:`) && !live.has(k)) {
    for (const t of minds.get(k)!.timers) clearTimeout(t);
    minds.delete(k);
  }
  if (!bots.length) return;
  const frame = tableFrame(code);
  if (!frame) return;
  const s = frame.state;
  const g = s.game;
  for (const bot of bots) {
    const m = mindOf(code, bot.id);
    const key = !g || s.status === "open" ? "lobby" : g.winner ? `over:${g.winner}` : `${g.round}:${g.phase}`;
    if (key === m.key) continue;
    m.key = key;
    for (const t of m.timers) clearTimeout(t);
    m.timers = [];
    if (!g) continue;
    if (g.winner) {
      // Game over: a bot is always in for another.
      if (g.winner !== "none") {
        later(m, thinkMs(...DELAYS.rematch, null) , () => {
          if (setRematch(code, bot.id, true)) notifyTable(code);
        });
      }
      continue;
    }
    if (g.phase === "pick") later(m, thinkMs(...DELAYS.pick, g.deadline), () => doPick(code, bot));
    else if (g.phase === "vote") later(m, thinkMs(...DELAYS.vote, g.deadline), () => doVote(code, bot, m, true));
    else if (g.phase === "steal") later(m, thinkMs(...DELAYS.steal, g.deadline), () => doSteal(code, bot));
  }
}

type Seat = { id: string; name: string };

function doPick(code: string, bot: Seat) {
  const v = botView(code, bot.id);
  if (!v || v.pub.game?.phase !== "pick" || v.me.role === "spectator" || v.me.role === "ghost") return;
  if (v.me.picked) return;
  const choice = decidePick(v.me, bot.name, v.pub);
  if (!choice) return;
  const from = choice.from;
  pickTrack(code, bot.id, choice.trackId, from);
}

function doVote(code: string, bot: Seat, m: Mind, first: boolean) {
  const v = botView(code, bot.id);
  if (!v || v.pub.game?.phase !== "vote" || (v.me.role !== "player" && v.me.role !== "mole")) return;
  const choice = decideVote(v.me, bot.name, v.pub);
  castVote(code, bot.id, choice);
  // Now and then it changes its mind once before the vote locks.
  if (first && Math.random() < 0.25) {
    const left = (v.pub.game?.deadline ?? Date.now() + 5000) - Date.now();
    later(m, Math.min(3000 + Math.random() * 3000, Math.max(0, left * 0.5)), () => doVote(code, bot, m, false));
  }
}

function doSteal(code: string, bot: Seat) {
  const v = botView(code, bot.id);
  if (!v || !v.me.steal) return;
  const guess = decideSteal(v.me, v.pub);
  if (guess) castSteal(code, bot.id, guess);
}

let started = false;
// Wires the bots to table changes. Idempotent.
export function startBots() {
  if (started) return;
  started = true;
  onTableChange((code) => {
    // Not inside the change that woke us: after it has finished.
    setImmediate(() => react(code));
  });
}

