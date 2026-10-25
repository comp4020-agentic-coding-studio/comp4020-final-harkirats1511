// Caps that keep one visitor from costing every table its turn: the app is one
// single-threaded machine, and the event stream needs no sign-in. Pure (no
// database, no log), so a spec can drive it directly; the routes do the logging.
// Anonymous watchers of one table (members of the table are never counted).
export const MAX_WATCHERS_PER_TABLE = 24;
export const MAX_STREAMS_PER_IP = 32;
// A signed-in member's own streams (tabs, devices).
export const MAX_STREAMS_PER_PERSON = 4;
// Acting (pick, vote and vote changes, steal): at most this many per person per window.
export const MAX_ACTIONS_PER_WINDOW = 5;
export const ACTION_WINDOW_MS = 1000;
// A refusal is worth one log line a minute per key, not one per request.
const SAY_EVERY_MS = 60_000;

// Behind Fly's proxy every socket is the proxy; Fly sets fly-client-ip itself.
// Anywhere else that header is the client's to forge, so it is ignored.
export function addressOf(request: Request, clientAddress: string | undefined): string {
  const fly = process.env.FLY_APP_NAME ? request.headers.get("fly-client-ip") : null;
  return fly || clientAddress || "unknown";
}

const perIp = new Map<string, number>();
const said = new Map<string, number>();

// True the first time per key per minute: the caller logs then.
export function firstSaying(key: string, now = Date.now()): boolean {
  if ((said.get(key) ?? 0) > now - SAY_EVERY_MS) return false;
  if (said.size > 500) said.clear();
  said.set(key, now);
  return true;
}

export type StreamSlot = { release: () => void };
const anonPerTable = new Map<string, number>();
const perPerson = new Map<string, number>();

function counted(map: Map<string, number>, key: string): StreamSlot {
  map.set(key, (map.get(key) ?? 0) + 1);
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      const left = (map.get(key) ?? 1) - 1;
      if (left <= 0) map.delete(key);
      else map.set(key, left);
    },
  };
}

const both = (a: StreamSlot, b: StreamSlot): StreamSlot => ({ release() { a.release(); b.release(); } });

// Takes one stream slot, or says which cap is full. A signed-in member of the
// table (`personId`) is never refused for the table's or the address's sake, so
// strangers can't lock the players out; a member's own streams are capped per
// person (several tabs). Anyone else is anonymous, and counts against the
// table's watchers and the address's streams.
export function openStream(code: string, ip: string, personId: string | null = null): StreamSlot | "table" | "ip" | "person" {
  if (personId) {
    if ((perPerson.get(personId) ?? 0) >= MAX_STREAMS_PER_PERSON) return "person";
    return counted(perPerson, personId);
  }
  if ((anonPerTable.get(code) ?? 0) >= MAX_WATCHERS_PER_TABLE) return "table";
  // This machine itself (local dev, the specs) is one address for everyone on it:
  // the per-address cap is for the outside, where Fly tells us who is calling.
  const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (local) return counted(anonPerTable, code);
  if ((perIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) return "ip";
  return both(counted(anonPerTable, code), counted(perIp, ip));
}

const recent = new Map<string, number[]>();

// True when this person has acted too often just now (the caller answers 429).
export function tooFast(personId: string, now = Date.now()): boolean {
  const times = (recent.get(personId) ?? []).filter((t) => t > now - ACTION_WINDOW_MS);
  const over = times.length >= MAX_ACTIONS_PER_WINDOW;
  if (!over) times.push(now);
  if (recent.size > 2000) for (const [k, v] of recent) if (!v.some((t) => t > now - ACTION_WINDOW_MS)) recent.delete(k);
  recent.set(personId, times);
  return over;
}

// The route's whole answer to a person acting too fast: logs once a minute.
export function actedTooFast(personId: string, log: () => void): boolean {
  if (!tooFast(personId)) return false;
  if (firstSaying(`r${personId}`)) log();
  return true;
}
