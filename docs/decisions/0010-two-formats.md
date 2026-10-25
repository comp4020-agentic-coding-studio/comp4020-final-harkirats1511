# 0010: Two formats, Knockout and Four rounds

Status: accepted (final project, 26 Oct). Builds on 0009 (the crate game).

## Context

Five reviews compared the live game with the crate game (25 Oct). The crate
game won on every one, but the concept review found the same root under most
of the remaining problems: it is a short knockout.

- 4-player games end in 1-2 rounds, so only 2-3 of the 12 crate songs play.
- Anyone voted out early sits idle for most of the session.
- One steal guess can decide a game the room had won.
- The borrow has no payoff, and voting on a name brings back "the standout gets
  voted out" (0008).

A points game over four rounds fixes all of those by itself, but loses being
voted out, which is the Among Us feel I wanted from the start.

## Options

1. Keep knockout only and patch it (a warm-up round, a job for ghosts).
2. Replace it with points over four rounds.
3. **Both, as a table option (chosen)**, so playtests can tell us which is
   more fun instead of us guessing.

## Choice

- **Knockout** stays as 0009 describes. Ghosts get a private guess each round,
  shown at game over, so being voted out still has something to do.
- **Four rounds**: one round per mood, no eliminations.
  - **Two votes each round:** who's the mole, and best pick (not your own card).
  - **Points:** catching a mole +2; each best-pick vote +1 to the picker, and +1
    to the lender of a borrowed card; moles +2 each when they get away; a right
    steal +3.
  - **Moles are dealt again every round.** In The Chameleon and Spyfall the
    secret role changes every round too. Here it's forced: the steal shows
    who was caught, so a mole kept for the next round couldn't bluff any more.
  - **Scores move only at the reveal**, so a score can't give away a vote.

## Cost

- Two rule sets to explain. The format choice and the How to play have to make
  each clear in a few lines.
- A second scoring path in the engine. The phases become one typed table of
  transitions first (engine review), so the second format is data, not more
  special cases.
- The numbers (+2, +1, +3) are guesses to playtest, kept as constants.
