import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import { db } from "./db.ts";
import { people, tableMembers, tables } from "./schema.ts";

// No I or O: they read as 1 and 0 when a code is shouted across a room.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const MIN_PLAYERS = 3;

export function normaliseCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += LETTERS[randomInt(LETTERS.length)];
  return code;
}

export function createTable(hostId: string): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomCode();
    const now = Date.now();
    try {
      db.transaction((tx) => {
        tx.insert(tables).values({ code, hostPersonId: hostId, status: "open", createdAt: now }).run();
        tx.insert(tableMembers).values({ tableCode: code, personId: hostId, joinedAt: now }).run();
      });
      return code;
    } catch {
      // code collision: try another
    }
  }
  throw new Error("could not allocate a table code");
}

export function tableExists(code: string): boolean {
  return !!db.select({ c: tables.code }).from(tables).where(eq(tables.code, code)).get();
}

export function addMember(code: string, personId: string): boolean {
  const res = db
    .insert(tableMembers)
    .values({ tableCode: code, personId, joinedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function isHost(code: string, personId: string): boolean {
  return db.select({ h: tables.hostPersonId }).from(tables).where(eq(tables.code, code)).get()?.h === personId;
}

export function memberCount(code: string): number {
  return db.select().from(tableMembers).where(eq(tableMembers.tableCode, code)).all().length;
}

export function setStatus(code: string, status: string) {
  db.update(tables).set({ status }).where(eq(tables.code, code)).run();
}

// What anyone holding the code may see, and all the event stream ever carries:
// no ids, no PINs, nothing private to one player. Always read from the
// database, so a reconnect or a restart restores it.
export type PublicTable = { code: string; status: string; host: string; members: string[] };

export function publicState(code: string): PublicTable | null {
  const t = db
    .select({ code: tables.code, status: tables.status, host: people.name })
    .from(tables)
    .innerJoin(people, eq(people.id, tables.hostPersonId))
    .where(eq(tables.code, code))
    .get();
  if (!t) return null;
  const members = db
    .select({ name: people.name })
    .from(tableMembers)
    .innerJoin(people, eq(people.id, tableMembers.personId))
    .where(eq(tableMembers.tableCode, code))
    .orderBy(asc(tableMembers.joinedAt), asc(people.name))
    .all()
    .map((m) => m.name);
  return { ...t, members };
}

// In-process pub/sub: the app runs as a single machine. A listener is told a
// table changed and re-reads the state itself.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function notifyTable(code: string) {
  bus.emit(code);
}

export function watchTable(code: string, fn: () => void): () => void {
  bus.on(code, fn);
  return () => bus.off(code, fn);
}
