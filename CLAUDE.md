# Harness

The rules below follow from what this app is for: a music game for a group of
friends. Each round everyone gets a secret theme and picks a song for it; the
mole has a different but close theme and doesn't know it. The room listens and
works out whose pick doesn't quite fit. They are decisions, not defaults.

## What the app must never do

- **Leak a pick's owner or title before the reveal.** During a round, nothing the
  server sends to a player (HTML, JSON or an SSE event) may contain who picked a
  track or what it is called. The speaker device plays preview audio from a plain
  `<audio>` element with no title or artwork on screen.
- **Tell anyone they are the mole, or show two themes before the game ends.** Each
  person's session gets only their own theme, worded the same way for everyone.
  Nothing says whose theme is the odd one until the game is over, when every
  round's pair is shown.
- **Let one person act as another.** A name is claimed with a PIN. Acting on
  someone's history needs their session.
- **Expose more of a person than the app needs.** Taste files are for picking
  quickly from your own songs; nothing from outside the app is ever shown, and
  never a PIN.
- **Host audio.** Tracks are Deezer ids and metadata. Preview URLs are signed and
  expire, so store the id and fetch a fresh URL per round.

## Rules the game keeps

- A game needs 3 players to start and the UI recommends 4 or more.
- Moles default by player count (1 up to 5 players, 2 up to 10); the host may
  override within a cap. With two moles both get the same odd theme.
- Voted-out players become ghosts: they still pick tracks, and they cannot vote.
- A change one person makes reaches every open session of that table within about
  a second with no reload. Reconnecting, or returning the next day, restores the
  current state from the database, never from memory.
- Nobody sees who has picked or voted, not even a count. The public state must not
  change when someone picks or votes; only the phase moving on shows it.
- Deadlines are fixed. A pick or vote that arrives after its deadline does not
  count. A phase ends early once everyone eligible has submitted.
- A vote is final once cast. The most-voted is ejected; a tie ejects nobody, and
  "skip" counts as an option.
- Only someone who picked this round can vote in it. Missing the pick means
  sitting the round out: you can listen and talk, but not vote, and the vote
  doesn't wait for you.
- Someone reconnecting mid-round keeps their role and gets whatever pick time is
  left; once the pick deadline has passed they watch that round. Someone who joins
  a table mid-game spectates until the next game.
- The game runs until every mole is out (players win) or the moles are at least as
  many as everyone else still in (moles win), as in Among Us. Leaving counts the
  same way, and a host who leaves passes the host role on.
- Each round draws a new theme pair from `src/lib/themes.ts`, not repeating
  within a game. Which side the majority gets is random. A pair must be close
  enough that one song could answer both.
- The reveal after a vote shows every track and its owner, and who was voted out
  and whether they were a mole. The themes are shown only when the game ends.
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
  a screen during a game:** a theme, who is a mole, a track's title, which
  track is whose, or who someone voted for. The action itself is fine to log
  ("Ana picked a track", "Ben voted"): that is who did what, and it reveals
  nothing a round's outcome depends on. The reveal line may name who owned which
  track and who was ejected, because the reveal screen shows that to everyone.
  Themes are logged only when the game ends, as the game-over screen shows them.
  Who voted for whom is never logged, since no screen ever shows it.
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
  theme, who the mole is, a track's owner or title before the reveal, or who has
  picked or voted, so it can't leak them.
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
  Never a theme, role, pick, title, or who has picked or voted.
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
- Judged, not enforced: whether it is fun, and whether it teaches you something
  about your friends' taste. Those are argued in `README.md`.

## Working with the agent

Corrections go here or into `spec/`, not into re-prompting. When the same
mistake happens twice, add the rule or the check that would have caught it.
