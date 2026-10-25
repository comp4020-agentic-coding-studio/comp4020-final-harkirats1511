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
    // A bot the server plays for (src/lib/bots). It has no session and no PIN that matches anything.
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
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
  // "knockout" (vote someone out each round) or "four" (Four rounds: points, one round per
  // mood, nobody out); decision 0010. Copied onto the game when it starts.
  format: text("format").notNull().default("knockout"),
  // Autoplay: the server plays the round's slots in order, slotSeconds each.
  autoplay: integer("autoplay", { mode: "boolean" }).notNull().default(false),
  slotSeconds: integer("slot_seconds").notNull().default(30),
  // A private booth is left out of the shop's code listing; joining needs the code.
  private: integer("private", { mode: "boolean" }).notNull().default(false),
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
    // "I'm in" for the next game, tapped on the game-over screen. Public, harmless, reset when a game starts.
    rematch: integer("rematch", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tableCode, t.personId] })],
);

// Who the host removed from a table: they can't join it again.
export const tableRemovals = sqliteTable(
  "table_removals",
  {
    tableCode: text("table_code")
      .notNull()
      .references(() => tables.code, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tableCode, t.personId] })],
);

// A report of a table, one per person per table. It only feeds the log.
export const tableReports = sqliteTable(
  "table_reports",
  {
    tableCode: text("table_code")
      .notNull()
      .references(() => tables.code, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    reason: text("reason").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tableCode, t.personId] })],
);

// A person's crate (taste file): 12 tracks they'd actually play, 3 per slot. Deezer ids plus
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
    // Up to 12 tracks, 3 in each of "up" | "down" | "out" | "in" (decision 0009).
    // Rows from before slots existed are null and must be re-slotted by their
    // owner: a crate with a null is incomplete.
    slot: text("slot"),
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
    // The slot that won the last vote (decision 0008), or null when none did
    // (a tie, or skip on top). Whether it was the house record is read from the
    // pick row at that slot; read in phase reveal.
    voteSlot: integer("vote_slot"),
    // 1 once everyone who can vote has: the 5 second last call is running and
    // the deadline has been pulled in to match. Public (it says nothing about who).
    lastCall: integer("last_call").notNull().default(0),
    // The anonymous slot the host has playing now, or null; public, it says
    // which number is playing and nothing about whose it is.
    nowPlaying: integer("now_playing"),
    // "players" | "moles" once the game is over, or "none" for a game that ended
    // with no winner (nobody picked, or an unfinished game a migration ended).
    winner: text("winner"),
    // Why it ended when that isn't the plain win: "final-vote", "round-cap" or "nobody-picked".
    endReason: text("end_reason"),
    // The four slots in this game's order (JSON array, shuffled at the start):
    // round n draws a prompt of slotOrder[(n - 1) % 4], so no slot repeats
    // before all four have come up.
    slotOrder: text("slot_order"),
    // The table's format when this game started ("knockout" | "four"); never changes mid-game.
    format: text("format").notNull().default("knockout"),
    // The steal phase: the voted-out mole, the four prompt ids they may guess
    // from (JSON, shuffled; moles only ever see them in /me), their guess, and
    // whether it was right (read at the reveal). Cleared when the next round begins.
    stealPersonId: text("steal_person_id"),
    stealOptions: text("steal_options"),
    stealGuess: text("steal_guess"),
    stole: integer("stole").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    // Epoch ms the game ended; null while it runs. Games that ended before this
    // column existed carry their startedAt.
    finishedAt: integer("finished_at"),
  },
  (t) => [index("games_table").on(t.tableCode), index("games_finished").on(t.finishedAt)],
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
    // One borrow and one steal per game (1 once used).
    borrowUsed: integer("borrow_used").notNull().default(0),
    stealUsed: integer("steal_used").notNull().default(0),
    // Four rounds: the running score, changed only inside the transaction that opens a reveal.
    score: integer("score").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.personId] })],
);

// The prompt drawn for a round (decision 0009), from src/lib/prompts.ts. Only
// non-moles are ever sent it before the reveal; a mole gets the slot.
export const gamePrompts = sqliteTable(
  "game_prompts",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    promptId: text("prompt_id").notNull(),
    slot: text("slot").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round] })],
);

// The theme pair drawn for a round by the old hidden-theme game (no longer
// written; history still reads it for games played then): most of the table gets `majority`, the
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

// A person's pick for a round. slot is the card's order of play, shuffled once
// when listening starts and then fixed (old games: its anonymous slot).
// lenderPersonId is whose crate it was borrowed from, null for the picker's own.
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
    // The house record (decision 0008) is a pick row whose personId is "house".
    // inspiredBy is the person whose crate's artist it was chosen from, shown
    // only at the reveal.
    inspiredBy: text("inspired_by"),
    lenderPersonId: text("lender_person_id"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.personId] })],
);

// A vote, changeable until the vote locks. choice is the person voted for, null
// for "skip" (decision 0009). slot was the track voted for under 0008 and is
// no longer written.
export const votes = sqliteTable(
  "votes",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    voterPersonId: text("voter_person_id").notNull(),
    choice: text("choice"),
    slot: integer("slot"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.voterPersonId] })],
);

// A person's avatar: one value per part, each from the lists in avatar.ts.
// No row means the default derived from their id.
export const avatars = sqliteTable("avatars", {
  personId: text("person_id")
    .primaryKey()
    .references(() => people.id, { onDelete: "cascade" }),
  character: text("character").notNull(),
  colour: text("colour").notNull(),
  hat: text("hat").notNull(),
  accessory: text("accessory").notNull(),
  aid: text("aid").notNull(),
  mood: text("mood").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Four rounds: who the moles were in each round (roles are dealt again every round, so
// game_players.role stays "player" there). Read for a round only by its own players' /me,
// and public from that round's reveal.
export const roundMoles = sqliteTable(
  "round_moles",
  {
    gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    personId: text("person_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.personId] })],
);

// Four rounds: a person's best-pick vote, changeable until the vote locks. The card is
// named by its picker (one card per picker per round).
export const bestVotes = sqliteTable(
  "best_votes",
  {
    gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    voterPersonId: text("voter_person_id").notNull(),
    pickPersonId: text("pick_person_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.voterPersonId] })],
);

// Four rounds: the points each person got at a round's reveal (the score is their sum).
export const roundScores = sqliteTable(
  "round_scores",
  {
    gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    personId: text("person_id").notNull(),
    points: integer("points").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.personId] })],
);

// Four rounds: how each round's mole vote came out, written at its reveal. accused is the
// room's choice: a mole that got the top vote (or, in a tie between moles, the one chosen to
// steal), or the one non-mole on top; null for a tie that includes a non-mole, or skip on top.
// caught is 1 when the top mole vote was a mole; stole is 1 when that mole then guessed right.
export const roundResults = sqliteTable(
  "round_results",
  {
    gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    accusedPersonId: text("accused_person_id"),
    caught: integer("caught").notNull().default(0),
    stole: integer("stole").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round] })],
);

// Knockout: a ghost's private guess at who the mole is, one per ghost per round, changeable
// until the vote locks. Shown to nobody until the game is over.
export const ghostGuesses = sqliteTable(
  "ghost_guesses",
  {
    gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    ghostPersonId: text("ghost_person_id").notNull(),
    guessPersonId: text("guess_person_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.ghostPersonId] })],
);
