# 0011: The shop remembers (the wall, the jukebox, booths you can see into)

Status: accepted (final project, 6 Nov). Builds on 0004 (the shop floor), 0006
(shop sound) and 0009 (the crate game).

## Context

The pre-merge reviews (2 Nov) found the game itself does co-presence well: a
table is more fun with more people at it. The shop, the open world around the
tables, was a lobby: you walk in, see booths, hear a fixed radio and sit down.
It didn't use the crates, and nothing anyone did there stayed. The brief asks
for an app that is more interesting because other people are using it at the
same time, and the showcase is a room full of people at once.

## Options

1. Leave the shop as a lobby and put the time into the game.
2. More things to do in the shop (mini-games, chat). Features with no reason in
   our definition of good, and chat needs moderation we can't give it.
3. **Make the shop show and share the room's taste (chosen).** Three pieces,
   each from something the game already makes public, none changing a round.

## Choice

- **The wall.** Every revealed round from a public table goes up on the shop
  wall as a sleeve: the prompt, its mood, every pick with its picker (and
  lender), the moles and whether they were caught, and the best card in Four
  rounds. It is built from the stored rounds, so it stays across restarts. At
  the showcase it fills up through the day; later, anyone can browse what
  people chose for "a song for a rainy Sunday". Private tables never go on it,
  and a table made private later takes its earlier sleeves down, because each
  sleeve carries the table's code, which is what keeps a private table private.
- **The jukebox.** Anyone on the floor can queue one song from their own crate.
  The whole shop hears it, named ("picked by Ana"); while the queue is empty the
  radio plays. Enough people on the floor tapping skip moves it on. Only songs
  clean enough for the crate starter (no explicit flag, no slur) can be queued,
  because strangers hear them. A jukebox play never marks a song as heard in a
  game.
- **Booths you can see into.** A playing booth shows its round, phase and mood,
  and while a card plays, its title and picker, over the table in 3D and in
  words in the booth list. All of it is already public at that table.
- **Taste notes** on "Your past games": what you picked for each mood, your
  most best-picked song, songs you and someone else both played, and who
  borrowed from whom. Only from games you sat in, all of it public to you at
  their reveals.
- **Four rounds is the default format.** The Four rounds playtest recommended it
  (clarity 8/10); the host can still choose Knockout.

## Not chosen

- A "play now" button that signs you in and fills your crate. A crate filled for
  you would defeat the point of the crate (0009); the starter from your own
  artists stays one tap per mood.

## Cost

- More public surface. A wall sleeve is public forever, so it may only hold what
  the table already saw at the reveal, and only from public tables. A spec
  scans the wall and the shop stream for anything a running round hasn't
  revealed.
- The jukebox plays strangers' songs to strangers, so it reuses the starter's
  clean filter and the skip vote, and the radio's rules (after a tap, a visible
  off control, silent on a table page during a game).
