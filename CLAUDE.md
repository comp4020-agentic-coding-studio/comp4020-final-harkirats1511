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

## Where things live

- Decisions: `docs/decisions/`. Write a new record when one changes.
- Checks: `spec/`, run by `pnpm check` against the running app (`APP_URL`).
- Judged, not enforced: whether it is fun, and whether it teaches you something
  about your friends' taste. Those are argued in `README.md`.

## Working with the agent

Corrections go here or into `spec/`, not into re-prompting. When the same
mistake happens twice, add the rule or the check that would have caught it.
