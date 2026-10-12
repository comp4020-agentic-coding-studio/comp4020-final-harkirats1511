import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Ids are random text; times are epoch milliseconds. Later phases add taste
// files, rounds, picks and votes as tables that reference these.

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // scrypt output and its per-person salt, both hex. Never leaves the server.
    pinHash: text("pin_hash").notNull(),
    pinSalt: text("pin_salt").notNull(),
    // scrypt cost as "N:r:p". Null means Node's defaults (16384:8:1), which is
    // how every hash made before this column existed was computed.
    pinParams: text("pin_params"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("people_name_nocase").on(sql`lower(${t.name})`)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("sessions_person").on(t.personId)],
);

export const tables = sqliteTable("tables", {
  code: text("code").primaryKey(),
  hostPersonId: text("host_person_id")
    .notNull()
    .references(() => people.id),
  // "open" -> "lobby_ready" now; later phases add the game states.
  status: text("status").notNull().default("open"),
  createdAt: integer("created_at").notNull(),
});

export const tableMembers = sqliteTable(
  "table_members",
  {
    tableCode: text("table_code")
      .notNull()
      .references(() => tables.code, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tableCode, t.personId] })],
);

// A person's taste file: up to 10 tracks they'd actually play. Deezer ids plus
// metadata only; audio is never hosted.
export const tasteTracks = sqliteTable(
  "taste_tracks",
  {
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    trackId: integer("track_id").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    cover: text("cover"),
    addedAt: integer("added_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.trackId] })],
);
