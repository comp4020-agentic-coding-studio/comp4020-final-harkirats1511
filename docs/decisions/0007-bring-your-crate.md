# 0007: Bring your crate

Status: accepted (final project). Changes the picking rule in 0001-0003, where
any Deezer track could be picked and the taste file was optional.

## Context

The game is about your own taste: the room is judging whether a song sounds like
the person who picked it answering a slightly different theme. Until now nothing
enforced a taste file. Starting never looked at it, and the pick endpoint
accepted any Deezer id, with a free search ("Dig for another") on the pick screen.
So someone could play with an empty crate and search for whatever fit the theme,
which turns the game into a search contest and leaves nothing about them to
study.

## Options

1. **No requirement.** What we had. Picks stay a search contest.
2. **A minimum crate to sit down.** Simple, but it locks people out of booths
   they could watch, and nobody can fill a crate from a table they cannot join.
3. **A minimum to play, and pick only from the crate (chosen).** Anyone may sit
   down; starting needs every member to have enough; a pick has to be in your
   own crate.
4. **Pick from the crate or search.** Keeps the crate decorative, since a search
   is always easier than curating.

## Choice

Option 3.

- `MIN_CRATE = 5` (in `src/lib/taste.ts`; the cap stays 10). Five gives a pick
  five rounds' worth of choice without repeating before a game can end.
- Sitting down needs nothing. Starting is refused 409 until every member has 5:
  "Waiting on crates: Ana, Ben (5 tracks each)". Only names are in the message.
  Members short of 5 are not quietly turned into spectators; the host decides to
  wait or to remove them.
- A pick must be in the picker's own crate at the moment of picking, else 403
  "Pick from your crate." and a refused line in the log. The Deezer fallback is
  gone for picks (it stays for adding to a crate). Ghosts follow the same rule.
- Editing a crate mid-game is allowed: a track added in round 2 is already
  yours, so picking it is fine.
- The public state gains `crateReady` per member so the lobby can say who is
  not ready. It is a yes or no; the tracks, and how many someone has, never
  leave the owner's own session.
- The lobby shows "Crate ready" or "Crate: 2/5" (the count only for yourself),
  disables Start with a note naming who is not ready, and links the person to
  `/taste?next=/t/CODE`, which returns them to the table. The pick screen shows
  only your crate plus an "Add to your crate" link. The pick timer keeps running
  while someone is on the taste page.

## Cost

- A new player has to build a crate before their first game. Their friends wait
  in the lobby meanwhile, which is the pressure the rule is meant to apply, but it
  is also a real hurdle for a casual visitor.
- One person's short crate blocks the whole table's start until they fix it or
  are removed.
- A player can fill a crate with five jokes and pick from it. The rule makes
  picks come from a person's own list; it cannot make the list honest.
- Leaving to add a track mid-round costs pick time, since the deadline is fixed.
