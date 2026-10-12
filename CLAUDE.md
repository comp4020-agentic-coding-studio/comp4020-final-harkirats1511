# Harness

The rules below follow from what this app is for: a music game for a group of
friends, where one player (the mole) is secretly told to pick what a target would
pick, and the room works out who is faking. They are decisions, not defaults.

## What the app must never do

- **Leak a pick's owner or title before the reveal.** During a round, nothing the
  server sends to a player (HTML, JSON or an SSE event) may contain who picked a
  track or what it is called. The speaker device plays preview audio from a plain
  `<audio>` element with no title or artwork on screen.
- **Tell the target they are the target.** Neither the room nor the target is told.
  Only the mole's own session receives its target.
- **Let one person act as another.** A name is claimed with a PIN. Acting on
  someone's history needs their session.
- **Expose more of a person than the table rules allow.** A public table may show
  a person's taste file and past picks inside this app. It never shows anything
  from outside it (we cannot see anyone's listening anyway), and never a PIN.
- **Host audio.** Tracks are Deezer ids and metadata. Preview URLs are signed and
  expire, so store the id and fetch a fresh URL per round.

## Rules the game keeps

- A game needs 3 players to start and the UI recommends 4 or more.
- Moles default by player count (1 up to 5 players, 2 up to 10); the host may
  override within a cap. Nobody targets themselves and moles never target each
  other.
- Voted-out players become ghosts: they still pick tracks, they cannot vote, and
  they are never a target.
- A change one person makes reaches every open session of that table within about
  a second with no reload. Reconnecting, or returning the next day, restores the
  current state from the database, never from memory.

## Where things live

- Decisions: `docs/decisions/`. Write a new record when one changes.
- Checks: `spec/`, run by `pnpm check` against the running app (`APP_URL`).
- Judged, not enforced: whether it is fun, and whether it teaches you something
  about your friends' taste. Those are argued in `README.md`.

## Working with the agent

Corrections go here or into `spec/`, not into re-prompting. When the same
mistake happens twice, add the rule or the check that would have caught it.
