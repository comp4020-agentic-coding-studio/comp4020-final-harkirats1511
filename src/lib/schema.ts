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
  // "open" (lobby) -> "playing" -> "finished"; a finished table can start again.
  status: text("status").notNull().default("open"),
  // Options chosen when the table is made. Seconds; moles null means the default
  // for the player count. speaker is unused since audio became a per-person
  // choice in the browser; the column stays so no data is dropped.
  pickSeconds: integer("pick_seconds").notNull().default(60),
  voteSeconds: integer("vote_seconds").notNull().default(45),
  speaker: text("speaker").notNull().default("host"),
  moles: integer("moles"),
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

// One game at a table; a table can play several, the latest is the current one.
// Everything the engine needs to resume after a restart lives in these rows.
export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    tableCode: text("table_code")
      .notNull()
      .references(() => tables.code, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    // "pick" -> "listen" -> "vote" -> "reveal", then the next round's pick.
    phase: text("phase").notNull(),
    // Epoch ms the phase ends by, or null when only the host moves it on.
    deadline: integer("deadline"),
    // Who the last vote ejected (null: nobody); read in phase reveal.
    ejectedPersonId: text("ejected_person_id"),
    // The anonymous slot the host has playing now, or null; public, it says
    // which number is playing and nothing about whose it is.
    nowPlaying: integer("now_playing"),
    // "players" | "moles" once the game is over.
    winner: text("winner"),
    startedAt: integer("started_at").notNull(),
  },
  (t) => [index("games_table").on(t.tableCode)],
);

// Who is playing. Members with no row here joined after the start and spectate.
export const gamePlayers = sqliteTable(
  "game_players",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    role: text("role").notNull(), // "player" | "mole"
    // The round they were voted out in: from then on a ghost.
    ejectedRound: integer("ejected_round"),
    left: integer("left").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.personId] })],
);

// The theme pair drawn for a round: most of the table gets `majority`, the
// mole(s) get `mole`. Never sent to anyone until the game is over, except that
// each person's own side reaches only their own /me.
export const gameThemes = sqliteTable(
  "game_themes",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    majority: text("majority").notNull(),
    mole: text("mole").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round] })],
);

// A person's pick for a round. slot is the anonymous position it plays in,
// shuffled once when listening starts and then fixed.
export const picks = sqliteTable(
  "picks",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    personId: text("person_id").notNull(),
    trackId: integer("track_id").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    // Kept with the title for the reveal.
    cover: text("cover"),
    slot: integer("slot"),
    pickedAt: integer("picked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.personId] })],
);

// A vote, final once cast. choice is the person voted for, null for "skip".
export const votes = sqliteTable(
  "votes",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    voterPersonId: text("voter_person_id").notNull(),
    choice: text("choice"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.voterPersonId] })],
);
