import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { people } from "./schema.ts";

// One line per event on stdout (Fly collects it and timestamps each line, so
// there is no time in the text), also kept in a small ring for GET /api/logs.
//
// Shape: `[scope] who verb ... · context`, e.g.
//   [table KGZW] Ana (p:3f2a) picked a track · round 2
//   [auth] REFUSED Ben (p:9c1d) sign-in: wrong PIN
//
// A person is "display name (p:xxxx)": xxxx is the first 4 hex characters of
// their person id (a random UUID), enough to tell two "Ana"s apart. A table is
// its 4-letter code.
//
// What must never reach a line, before it is public: a theme, who is a mole, a
// track's title or id, which track is whose, or who voted for whom. And never
// a PIN, hash, session token or cookie. Callers pass only what is safe; log()
// never throws into a request.

const RING_MAX = 500;
const ring: string[] = [];

export const tableScope = (code: string) => `table ${code}`;

// Display name and short id. Names are user-typed, so strip control characters
// so one cannot forge a second log line.
export const tag = (p: { id: string; name: string }) => `${clean(p.name)} (p:${p.id.slice(0, 4)})`;

export function personTag(personId: string): string {
  try {
    const row = db.select({ name: people.name }).from(people).where(eq(people.id, personId)).get();
    return row ? tag({ id: personId, name: row.name }) : `unknown (p:${personId.slice(0, 4)})`;
  } catch {
    return `unknown (p:${personId.slice(0, 4)})`;
  }
}

function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
}

export function log(scope: string, message: string): void {
  try {
    const line = `[${clean(scope)}] ${clean(message)}`;
    ring.push(line);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    console.log(line);
  } catch {
    // logging never breaks a request
  }
}

// A refused attempt. `who` is a tag(), or null when nobody is signed in.
export function refused(scope: string, who: string | null, what: string, reason: string): void {
  log(scope, `REFUSED ${who ? `${who} ` : ""}${what}: ${reason}`);
}

// The recent lines, oldest first (newest last), optionally for one table.
export function recentLines(table?: string): string[] {
  if (!table) return [...ring];
  const prefix = `[${tableScope(table)}]`;
  return ring.filter((l) => l.startsWith(prefix));
}
