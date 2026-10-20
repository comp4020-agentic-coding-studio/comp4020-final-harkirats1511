# 0003: Who can see and change what

Status: accepted (crit 10).

## Context

Mole is a hidden-information game. A round only works if nobody can find out
who the mole is, what the other theme says, or whose track is whose before the
game shows it. So access control here protects the game as much as anyone's
data. The app needs to know who each person is across games, without making a
group of friends sign up for accounts.

## Who counts as a person

A name (unique, case-insensitive) claimed with a 4-8 digit PIN. Options
considered:

1. **An anonymous browser cookie.** Easiest, but you'd lose yourself on a new
   phone, and your taste file and past games are meant to carry over.
2. **A name only.** Anyone could type a friend's name and play as them, which
   in a game about reading each other is the one thing it can't allow.
3. **Name and PIN (chosen).** Enough to stop impersonation, no email or
   password for friends to manage.
4. **Real accounts.** Too much for a party game among people who know each
   other.

PINs are stored as salted scrypt hashes and never sent back. A session is a
random token in an HttpOnly cookie. Eight wrong PINs on one name in ten minutes
locks that name until the window passes: a 4-digit PIN is guessable, and the
throttle is what makes it good enough here.

## Who may do what at a table (checked on the server)

| Action | Who may |
|---|---|
| Start a game, move a phase on, play a track number | the host only |
| Pick a song | players and ghosts, once a round, before the deadline |
| Vote | players who picked that round, once, before the deadline |
| See a theme | each person their own, and nobody else's |
| Change a taste file, avatar, or see past games | that person only |

A table's 4-letter code is the invite: anyone signed in who has it can join,
the way friends share a room code. Joining mid-game makes you a spectator until
the next game.

## What each person may see

The server sends each person only their own view. `/me` returns your own theme,
worded the same as everyone else's, so nothing says who the mole is. The public
table state carries names, phase and who is out, and the reveal only once it's
public. It never carries a theme, a role, a track's owner, or who has picked or
voted. The anonymous round gives slot numbers only.

This has to happen on the server. If every phone got every theme and the page
hid the others, anyone could open the browser's developer tools and find the
mole.

Deliberately public, with no sign-in: a table's live state, the avatar options
and the README, because none of them shows anything that isn't already on every
phone at the table.

## Cost

- **There's no way to kick someone.** Anyone who guesses a table code (one in
  331,776) can sit at your table. A table lasts an evening among friends, so
  this is accepted for now, but it's the first thing to add.
- A 4-digit PIN is weak against a determined guesser. The throttle limits it;
  it's protecting a party game, not a bank.
- The logs (crit 10) name who did what, so whoever reads them sees every
  player's actions. They never contain a theme, the mole, a track title or who
  voted for whom before it's public, or a PIN at all.

Enforced by `spec/identity.test.ts`, `spec/game.test.ts`, `spec/taste.test.ts`,
`spec/avatar.test.ts`, `spec/history.test.ts` and `spec/logging.test.ts`.
