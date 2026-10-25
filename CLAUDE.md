# Harness

The rules below follow from what this app is for: a music game for friends
playing online. Everyone builds a crate of songs before they sit down; the
crates go on the table for all to see. Each round, everyone but the mole gets a
prompt and answers it with a song from their crate. The mole knows they're the
mole and only knows the prompt's mood, so they have to bluff with their own
songs. The room hears every pick with its picker's name and votes someone out.
They are decisions, not defaults (see `docs/decisions/0009`).

## What the app must never do

- **Let the prompt reach a mole.** Nothing the server sends a mole (HTML, JSON or
  an SSE event) may contain the round's prompt before the reveal: not the text,
  not an id, not the other steal options' ordering in a way that marks it. A
  mole gets the slot only. Non-moles get the prompt.
- **Tell anyone else who the mole is.** Roles are private until the reveal of the
  round a mole is voted out, or the game ends. A mole's screen says they're the
  mole; nobody else's screen or data says anything about anyone's role. Two
  moles are not told about each other.
- **Show a pick before the pick phase closes.** Nobody sees who has picked, what,
  or a count, until picking ends; then every pick is shown with its picker (and
  lender, for a borrow). A pick must not send anything on any stream, not even
  an identical frame, and the log line for a pick says only "picked a track".
- **Let one person act as another.** A name is claimed with a PIN. Acting on
  someone's history needs their session.
- **Expose more of a person than the app needs.** Crates are shown at the table
  they're playing at; nothing from outside the app is ever shown, and never a
  PIN.
- **Host audio.** Tracks are Deezer ids and metadata. Preview URLs are signed and
  expire, so store the id and fetch a fresh URL per round.

## Rules the game keeps

- A game needs 3 players to start and at most 8; the UI recommends 4 or more.
- **The crate.** 12 songs in 4 slots of 3: Up, Down, Out, In. It is built on
  `/taste` before you sit down. Starting needs every player's crate complete
  (3 per slot), otherwise 409 "Waiting on crates: …". From start to game over,
  crates are locked (edits refused 409) and shown to everyone at the table.
  A song can't be picked once it has been heard in an earlier round. Two players
  picking the same song in the same round is allowed (refusing the second would
  reveal the first's hidden pick); both cards play and are marked as a clash.
- Roles are assigned when the game starts, after crates lock. The host may
  choose 1 or 2 moles; the default is the plain rule, 1 mole for 3 to 5 players
  and 2 for 6 to 8. Never more than a third of the table, rounded down, with a
  minimum of 1, so 2 moles need 6 or more players: a choice that no longer fits
  by the start is cut down to what does. Moles don't know each other.
- **Bots.** The host may add bots to fill a table: up to 8 seats in all, and
  never in a private booth unless the host adds them. A bot is labelled as a bot
  everywhere (the name badge says "BOT") and can't be the host. It plays by the
  same rules as a person and sees only what a player sees (its own `/me` and the
  public state): a bot that is the mole never gets the prompt. The host can
  remove them, they leave when the table has no people left, and they don't
  appear in anyone's history as a person.
- **Each round has one prompt from `src/lib/prompts.ts`**, tagged with a slot.
  Prompts cycle through the four slots before any slot repeats, and don't repeat
  within a game. Non-moles see the prompt; moles see only its slot.
- **Pick:** any unplayed song from your own crate, or one borrow per game from
  another player's crate (the mole has one too). Picks are hidden until the
  pick phase closes, then shown named: "Ben: song" or "Ben (borrowed from Tom):
  song". A player who misses the pick is "dead air" and can still vote.
- **Vote on a name** (not yourself). While the vote is open, everyone sees how many votes each
  player has, never who cast them, and may change their vote until it locks.
  Once everyone who can vote has voted, a 5-second last call runs, then it
  locks. The most votes ejects that player; a tie, or skip on top, ejects nobody.
- **Steal.** When a mole is voted out, they get one guess from 8 prompts of that
  round's slot: the real one and 7 decoys never used earlier in the game, in
  random order. (Eight, not four: at four, a lucky guess decided too many
  games the room had won.) Right: **the moles win the game** (as in The Chameleon). Wrong
  or out of time: they're out and the game goes on. The steal opening shows the
  accused was a mole; that's the point of the moment.
- Voted-out players are ghosts: they watch, don't pick and don't vote. Their crate
  can still be borrowed from.
- The reveal moves on to the next round by itself after 30 seconds (the host
  can move it sooner), so a quiet host never stalls a table.
- Deadlines are fixed. A pick, vote or steal that arrives after its deadline does
  not count. A phase ends early once everyone eligible has submitted.
- A change one person makes reaches every open session of that table within about
  a second with no reload. Reconnecting, or returning the next day, restores the
  current state from the database, never from memory.
- Someone reconnecting mid-round keeps their role and gets whatever pick time is
  left. Someone who joins a table mid-game spectates until the next game.
- The game runs until every mole is out (players win) or the moles are at least as
  many as everyone else still in (moles win), as in Among Us. Leaving counts the
  same way, and a host who leaves passes the host role on. A leaver's crate
  leaves with them.
- **Every game ends.** The moles also win if, with three players left, a vote
  ejects nobody (a tie or skip on top: the room had its last chance), or if they
  survive round 12 (a crate has 12 songs). A round in which nobody picks at all
  ends the game with no winner (an abandoned table), so crates never stay locked
  behind a game nobody is playing. Someone with no song left to pick is told so,
  and can still borrow if they haven't.
- The reveal after a vote shows the prompt, every pick with its picker, the votes
  by name, and who was out and whether they were a mole. The public state keeps
  every finished round of the game (prompt, cards, ejected), who has used their
  borrow, and which songs have been heard, so a page restores from the server
  alone. At game over every mole is named, including any who left.
- Each player chooses where they hear tracks: on their own phone, or from the
  host's. The host's phone always plays. The choice is per person, saved, and can
  be changed during a game.

## Logging

The server logs who did what, so the deployed app can be read from
`flyctl logs` alone: which person, at which table, did which action, and
whether it was refused. It is how we (and the agent) find out what a live app
did when something goes wrong, so it stays after any crit.

- One line per meaningful action, written to stdout: sign-in (new name or
  returning), table created/joined/left, game started, pick made, vote cast,
  phase moved on (by whom, or by the timer), track played, game finished, and
  every refused attempt with the reason (wrong PIN, not the host, ghost voting,
  late pick, not signed in where it matters).
- Each line names the person by their display name and short id, and the table
  by its code, so two people with similar names are still told apart.
- **Never logged before it is public, because the logs may be read aloud or on
  a screen during a game:** a prompt, who is a mole, what someone picked before
  picking closes, or who someone voted for. The action itself is fine to log
  ("Ana picked a track", "Ben voted"): that is who did what, and it reveals
  nothing a round's outcome depends on. Once picking closes, picks may be
  logged with their picker (the listen screen shows them). The reveal line may
  name the prompt, who was ejected and whether they were a mole.
  Who voted for whom is never logged: the reveal shows it on screen, but the
  logs don't need it to explain what happened. The prompt is never logged
  before the reveal (logs may be on screen), and a steal guess only after it
  resolves.
- Never logged at all: PINs, PIN hashes, session tokens, cookies.
- The same lines are kept in a small in-memory ring (the last few hundred) that
  `GET /api/logs` returns to whoever presents the admin token in
  `LOG_TOKEN` (an env var set as a Fly secret, never committed). Without a valid
  token it answers 404, so nobody learns it exists.

## The 3D table scene

- It is decoration on top of the game, never the game. Every action, every piece
  of information, and every state stays available in the 2D page, which is what
  the keyboard, screen readers and small or slow phones use.
- It only loads on the table page, after the page is usable, and only when the
  device can run WebGL 2 and the person hasn't asked for reduced motion or turned
  the scene off. Anything else gets the 2D page alone, with no error.
- It shows only what the public table state already shows. It never knows a
  prompt, who the mole is, a pick before picking closes, or who has voted for
  whom, so it can't leak them.
- Models are the CC0 Kenney Mini Characters in `public/models/` (credited in
  `public/models/CREDITS.md`). New assets need a licence that allows it, recorded
  there.

## The shop (free roam)

The app is a record shop after hours: the home page is the shopfront, `/shop`
is the floor you walk around as your character, and tables are listening
booths. See `docs/decisions/0004`, `0005` and `0006`.

- **Positions are not game state.** Where people stand lives in server memory
  only and is gone after a restart. Nothing a game depends on may ever live
  there.
- **The shop stream is public-state only.** It carries names, avatars,
  positions, emotes and each booth's public state, built from `publicState`.
  Never a prompt, role, pick, crate, or who has picked or voted.
- **The server is the referee for movement.** Positions are clamped to the room,
  speed is capped, more than 8 moves a second from one person are dropped, and
  emotes come from a fixed list. A client is never trusted to say where someone
  else is.
- **Booths are public unless the host makes them private.** A private booth
  shows only that it is private and who hosts it; joining needs the code. A
  removed person can't rejoin that table. Reports and removals are logged like
  every other action.
- **Every shop action has a 2D twin.** The booth list (take a seat, quick seat,
  knock with a code, report) works with the 3D off, with a keyboard and with a
  screen reader. The 3D shop only loads where the 3D table scene may load.
- **Sound.** The shop radio plays Deezer previews from fixed station lists and
  is never hosted by us. It is silent on a table page from when a game starts
  until it ends. It starts only after a tap, always has a visible off control,
  and the choice is saved on the device. Sound effects are synthesised with Web
  Audio, never files. No sound is the only signal for anything.
- **The look is the record shop.** Tokens and fonts come from
  `src/styles/global.css` (wall plum, lamp amber, neon pink only for the sign and
  the mole stamp, sleeve cream, wood). The reference is the mockups the student
  approved in `docs/design/`; don't drift back to generic cards, gradients or
  emoji.

## Where things live

- Decisions: `docs/decisions/`. Write a new record when one changes.
- Checks: `spec/`, run by `pnpm check` against the running app (`APP_URL`).
  A full check is `APP_URL=… LOG_TOKEN=… DATABASE_PATH=… pnpm check` against a
  fresh local build, and it must show 0 skipped. Without the token and the
  database path the leak and legacy-crate specs skip, and a skip is not a pass.
  CI runs it that way.
- `pnpm typecheck:astro` must show 0 errors. `pnpm check` doesn't cover the pages.
- Judged, not enforced: whether it is fun, and whether it teaches you something
  about your friends' taste. Those are argued in `README.md`.

## Working with the agent

Corrections go here or into `spec/`, not into re-prompting. When the same
mistake happens twice, add the rule or the check that would have caught it.

A new migration isn't done until it has booted on a database made by the
previous release, with a game left running in it.
