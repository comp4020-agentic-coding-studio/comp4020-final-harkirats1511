# 0005: Public booths, kicking and reporting

Status: accepted (final project). Changes 0003, which assumed a table's code
was only ever shared between friends.

## Context

In the shop, anyone can walk up to a booth and sit down. That is the point of
the shop, and it removes the one protection 0003 relied on: that only people
you gave the code to could join. 0003 already named "there's no way to kick
someone" as the first thing to add.

## Options

1. **Every table public.** Simplest, but a group of friends who only want each
   other has nowhere to go.
2. **Public by default, private if the host says so (chosen).** A public booth
   is lit up in the shop and anyone signed in can take a seat. A private booth
   is dim, shows only that it's private and who's hosting, and needs its code,
   exactly as tables work now.
3. **Private by default.** The shop would be a room of closed doors.

## Choice

Option 2, plus two things public tables need:

- **The host can remove someone from the table.** They leave exactly as if
  they'd left (0002's rules apply: a removed player in a game counts as gone,
  and the host role can't be removed from yourself). They can't sit back down at
  that table until it's closed, so removing someone means something.
- **Anyone at or near a booth can report it.** A report writes one log line
  naming who reported which table and the reason they chose from a short list.
  It's for whoever reads the logs; there's no moderation queue. One person can
  report a table once.
- **Taking a seat.** Joining a public booth that's waiting puts you in the next
  game. Joining one that's mid-game makes you a spectator until the next game,
  as joining mid-game already does.
- **Quick seat.** A button that sits you at the fullest public booth that's
  still waiting for players, so a person on their own finds a game in one tap.

## What changes in "who may do what"

| Action | Who may |
|---|---|
| Make a booth private or public | the host, before a game starts |
| Sit at a public booth | anyone signed in, unless removed from it |
| Sit at a private booth | anyone signed in with its code, unless removed |
| Remove someone | the host, not themselves |
| Report a booth | anyone signed in, once per table |

## Cost

- A stranger can still sit at a public booth and pick a joke song every round.
  The host can remove them, but only after they've noticed.
- A report only writes a log line. Nobody is told, and nothing happens
  automatically.
- Removal lasts as long as the table, not across tables, because there's no
  account behind a name beyond its PIN.
