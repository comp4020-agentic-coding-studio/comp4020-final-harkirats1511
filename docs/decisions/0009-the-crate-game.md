# 0009: The crate game

Status: accepted (final project, 24 Oct). Replaces the hidden-theme rounds of
the crit 9 game and decision 0008 (track votes, house record). 0002 (leaving)
and 0005 (public booths) still hold.

## Context

The live game (paired themes, an unaware mole, anonymous tracks, a house record,
track votes) played fine with friends, but nobody in it ever lies: the mole
doesn't know, so the room is guessing at a song, and friends' taste differences
drown out the theme difference. The crate did nothing: it could be edited
mid-round and the same song played every round.

I proposed a crate-first game: build a crate before the game, spread across
moods, and pick only from it when the prompt comes up. I then spotted that if
crates are visible, every song points at its owner. Two versions were planned
and an adversarial review compared them with the live game
(`crate-review-claude.md`, outside the repo). It found that hidden framing
can't work (counting crates exposes every borrow), and that what makes the
idea good is different: a public, locked crate turns each pick into a choice
among known alternatives ("you had *that* and played *this*?"), and a mole who
knows they're the mole gives the game a liar.

## Options

1. Keep the live game and lock the crate (cheap, but still no liar).
2. Crate-first with an unaware mole (the review scored it below the live game).
3. **Crate-first with a mole who knows (chosen)**, with borrowing made public.

## Choice

- A crate is 12 songs in 4 slots of 3 (Up, Down, Out, In), built on `/taste`
  before you sit down, locked for the game and shown to everyone at the table.
- Each round has one prompt tagged with a slot. Non-moles see it; the mole
  sees only the slot. Prompts cycle through the slots.
- Everyone picks a song from their own crate (each song once per game), or uses
  their one borrow from someone else's crate. Picks are shown named.
- The room votes on a name, with the live tally kept from 0008. A mole voted out
  gets a steal: guess the prompt from 4 in that slot. A right guess wins the game
  for the moles. (First planned as "stay in", but the steal opening shows
  everyone who the mole is, so a mole who stayed in would just be voted out next
  round: the review of the server phase caught it.)
- Ghosts watch; Among Us parity decides the game; up to 8 players.

## Cost

- My idea of pretending to be someone else by playing their favourite doesn't
  survive: borrowing is public, so it's a readable choice, not a disguise.
- The house record, the track vote, the anonymous slots and the 100 theme pairs
  are thrown away. 60 slot-tagged prompts replace the pairs.
- Building a 12-song crate in 4 slots takes longer before a first game.
- Online without voice, "why did you play that?" has no channel beyond the
  vote and emotes. This is a known gap to playtest.
