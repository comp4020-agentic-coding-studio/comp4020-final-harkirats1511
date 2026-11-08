# Mole

A music deduction game for friends online. Everyone brings a crate of 12 songs, and
each round everyone answers a prompt from their crate, except the mole,
who only knows the mood.

> **Try it (two browsers):** Sign in with any name and a 4-digit PIN. Type some
> artists under **Start from artists you love**, tap **Suggest songs** and **Keep**
> what you'd play. Tap **Start a table** and share its 4-letter code. Tap **Add a bot** to make three, then **Start game**. Come back
> tomorrow with the same name and PIN: your crate, finished games and the shop's
> wall are still there.

## What good means here

Good here means your taste is the evidence. Crates are public and lock when the game starts, so the clue is "you had *that* and played
*this*?". The mole knows their role and has to lie with real songs, and you
catch them because you know your friends. Music quiz games reward knowing songs.
Mole rewards knowing people.

I got here by playing: until the mole knew their role and the crates were public,
nobody had to lie
([0009](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/blob/main/docs/decisions/0009-the-crate-game.md)).

Three things come ahead of features. It has to be secret and fair: the prompt
never reaches a mole, picks stay hidden until picking closes, and every game ends.
It has to feel like being together: screens update within about a second, and the
record shop around the game remembers. Every revealed round goes on a wall, and
anyone can put a song on the jukebox
([0011](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/blob/main/docs/decisions/0011-the-shop-remembers.md)).
And it's built for my friends first. A game needs three players, so bots fill empty
seats, and strangers can play in a public booth.

## What I read and looked at

- Robin Sloan, ["An app can be a home-cooked meal"](https://www.robinsloan.com/notes/home-cooked-app/):
  software for a few people you know, judged by whether they enjoy it.
- Clay Shirky, ["Situated Software"](https://web.archive.org/web/2004/http://shirky.com/writings/situated_software.html):
  an app for one group can lean on what that group already knows about itself.
  Here that's each other's taste.
- Spyfall and The Chameleon: one player lacks the secret word and bluffs. The steal
  came from the Chameleon's last-chance guess.
- Among Us and Werewolf: hidden roles only work if the secret stays secret.

## What the app holds itself to

**Enforced** by the rules in [`CLAUDE.md`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/blob/main/CLAUDE.md) and the checks in [`spec/`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/tree/main/spec):

- A mole never receives the prompt. Every page, JSON response and stream frame a
  mole gets is scanned (`game.test.ts`, `four.test.ts`).
- A pick sends nothing on any stream, not even a count (`game.test.ts`, `shop.test.ts`).
- Nobody sees who voted for whom while a vote is open, and the logs never show it
  (`logging.test.ts`).
- The wall only shows what a reveal already showed (`wall.test.ts`).
- A join reaches other screens within about a second (`tables.test.ts`). Games,
  ballots and bots carry on after a restart (`resume.test.ts`,
  `four-engine.test.ts`, `bots-engine.test.ts`). Shop positions and the jukebox queue are memory only.

**Judged**, and how:

- Is it fun? More than five friend playtests: they all enjoyed it
  and liked the concept. I also watch whether they tap **I'm in** again.
- Does it teach you about your friends' taste? What people say at the reveal.
- Knockout or Four rounds? A playtest agent rated Four rounds'
  scoring 8/10 for clarity, so it's the default.

## What I chose not to build

- No audio hosting: tracks are Deezer ids.
- No accounts beyond a name and PIN.
- No chat: people talk on a call or in the room.
- No auto-filled crates: suggestions only go in when you tap Keep.
