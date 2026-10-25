// Caps that keep one visitor from costing every table its turn: the app is one
// single-threaded machine, and the event stream needs no sign-in. Pure (no
// database, no log), so a spec can drive it directly; the routes do the logging.
export const MAX_WATCHERS_PER_TABLE = 24;
export const MAX_STREAMS_PER_IP = 12;
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
// Takes one stream slot for this table and address, or says which cap is full.
// `watching` is how many streams the table has open now.
export function openStream(watching: number, ip: string): StreamSlot | "table" | "ip" {
  if (watching >= MAX_WATCHERS_PER_TABLE) return "table";
  // This machine itself (local dev, the specs) is one address for everyone on it:
  // the per-address cap is for the outside, where Fly tells us who is calling.
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return { release() {} };
  const n = perIp.get(ip) ?? 0;
  if (n >= MAX_STREAMS_PER_IP) return "ip";
  perIp.set(ip, n + 1);
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    },
  };
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
