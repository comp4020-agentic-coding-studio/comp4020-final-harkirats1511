# 0002: A player leaving mid-round

Status: accepted (crit 9).

## Context

A player can drop out in the middle of a round. For example, their connection
suddenly drops, or they close the game because of a call or something else.

## Options

1. Give them extra time when they come back.
2. Make them a spectator for the rest of the round.
3. Give them the remaining time, if they come back before the picks are done.

## Choice

Option 3. The person gets the remaining time if the pick window is still open;
otherwise they spectate the round. It doesn't make sense for everyone else to
pause their game, or wait extra time, in case one person has to leave or take an
important call.

This is enforced in the server: picks have a fixed deadline and a late pick is
refused ([`5920f1f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/5920f1f),
[`0d3df87`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/0d3df87)),
and someone who reconnects gets their role back from the database
([`69a50fe`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/69a50fe)).

## Cost

If someone can't submit in time, they have to sit that round out.
