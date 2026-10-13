import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { type Avatar, defaultAvatar, PARTS } from "./avatar.ts";
import { avatars, tableMembers } from "./schema.ts";

export function getAvatar(personId: string): Avatar {
  const row = db.select().from(avatars).where(eq(avatars.personId, personId)).get();
  if (!row) return defaultAvatar(personId);
  return Object.fromEntries(PARTS.map((p) => [p, row[p]])) as Avatar;
}

export function saveAvatar(personId: string, a: Avatar) {
  const values = { personId, ...a, updatedAt: Date.now() };
  db.insert(avatars).values(values).onConflictDoUpdate({ target: avatars.personId, set: values }).run();
}

// Codes of the tables this person sits at, so open sessions can be told.
export function tablesOf(personId: string): string[] {
  return db.select({ c: tableMembers.tableCode }).from(tableMembers).where(eq(tableMembers.personId, personId)).all().map((r) => r.c);
}
