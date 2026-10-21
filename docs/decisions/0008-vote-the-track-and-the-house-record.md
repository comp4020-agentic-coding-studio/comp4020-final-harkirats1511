# 0008: Vote the track, and the house record

Status: accepted (final project, after a playtest with friends online).

## Context

We played the live game with friends and it was fun, but two things kept
happening:

- **You voted for a person, so the vote was a guess about who owned the odd
  song**, not about which song didn't fit. The song is the evidence, so the
  vote should be about the song.
- **One song that stands out gets voted off, every time.** That is usually the
  mole's song, so the mole has no way to blend in. It also means someone with
  unusual taste gets voted out for having unusual taste.

The crate was also doing nothing beyond being a shortcut to your own songs.

## Options considered

1. A swap phase after a preview, so the mole can drift towards the room. It adds
   a phase and takes away from just picking and listening.
2. A defence step where the accused points at another track. More talking, and
   it slows the round.
3. **A decoy track in every round (chosen)**, so a standout song might not be
   anyone's.
4. Requiring a majority to eject. It helps the mole, but it doesn't change what
   the room is listening to.

## Choice

**Vote for a track.** During the vote, the tracks are the options (plus skip).
The track with the most votes is ejected: if a player picked it, that player is
out, as before. If it was the house record or a ghost's track, nobody is out and
the round goes to the mole. A tie, or skip winning, ejects nobody.

**Votes are visible while you vote.** Each track shows how many votes it has as
they land, never who cast them. You can change your vote until the timer ends.
Once everyone who can vote has voted, a 5-second last call starts, and then it
locks. At the reveal, everyone sees who voted for which track, so a confident
wrong accusation is remembered.

**One house record in every round.** When a round starts, the server takes a
random artist from a random player's crate and picks a different song by that
artist, one that isn't in any crate at the table, from Deezer's top tracks for
that artist. It plays in a shuffled slot like everyone's picks. It sounds like
someone at the table, so it can't be ruled out by genre, and the standout song
might be it. Everyone knows there's one more track than players. The reveal
labels it: "House record, in the style of Tom's crate".

This is the crate's job: what you put in it shapes the decoys everyone else
has to see through.

## What this changes in the rules

- Nobody sees who has picked, not even a count. Votes are now the exception:
  live counts per track during the vote, and who voted for what at the reveal.
- A vote is no longer final when cast; it is final when the vote locks.
- The house record must never be identifiable before the reveal: same slot
  shuffle, same audio route, same metadata shape (none) as any pick.
- If no house record can be found in time (Deezer down, empty crates), the
  round plays without one. The game never waits for it.

## Cost

- One more track to listen to each round (30 seconds with autoplay).
- A house record that fits neither theme can still be spotted. That's fine:
  even then, the room spent a vote on it.
- Showing who voted for what at the reveal makes votes public after the round.
  The logs still never record who voted for whom.
