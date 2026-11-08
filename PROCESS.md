# Process

## From the brief to a game

The brief asks for a real-time site that's good for a specific
group. Mine is my friends, who have taste in music but not much technique. I used
the agent to widen my options: it questioned me about the group and came up with
about eighteen ideas, and I shortlisted five and checked each against the spec
([b7e6766](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/b7e6766)).
The one that survived was a hidden-role music game, because persistence had a real use: your songs and past games are the
evidence.

The game changed three times.

1. In the first version the mole copied one friend's taste. All 28 tests passed,
   but when I played it, the copied friend would know their own pick, so the mole
   stood out. I threw that mechanic out
   ([0f0ba0d](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/0f0ba0d),
   [56d4b5f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/56d4b5f)).
2. Next, the mole got a near-identical theme and didn't know they were the mole,
   and after a playtest I rewrote the theme pairs to the same mood in a different
   situation ([83117b7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/83117b7)).
   In my [crit 10 reflection](reflections/crit-10.md) I said this was what made it
   a real game. My friends found it "not bad", but online
   it was mostly guessing. Nobody was lying, so nobody could be caught.
3. The version that stuck is the crate game. Crates are public
   and lock when the game starts, and the mole knows their role but only sees the
   mood, so they bluff with real songs. I wrote it up as a decision
   before any code
   ([b0a708d](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/b0a708d),
   [0009](docs/decisions/0009-the-crate-game.md)). Five comparison reviews on 25 Oct found 4-player games
   ended in 1-2 rounds and used only 2-3 of the 12 songs, so I added a second format, Four rounds, and kept
   Knockout because it has the Among Us feel
   ([0a817b7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/0a817b7),
   [0010](docs/decisions/0010-two-formats.md)). 

The last big change came from the pre-merge review, which said the game handled
co-presence well but the shop around it was just a lobby. Now the shop keeps a
record: every revealed round goes on a wall, and anyone can put a song on a shared jukebox
([4802840](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/4802840),
[0011](docs/decisions/0011-the-shop-remembers.md)).

## Stack

I went with Astro on the Node adapter, SQLite through Drizzle on the Fly volume,
and server-sent events ([0001](docs/decisions/0001-stack.md)). I'd run this
setup in crit 7, and it fits on one 256 MB machine with no database server. Nearly everything goes server to players, which suits SSE.
Shop movement goes up, and for that I weighed WebSockets: the Node adapter doesn't
serve them, so they'd mean a second server and protocol to test. Small POSTs, at
most 8 a second, do the job
([0004](docs/decisions/0004-the-shop-floor.md)).

The first-request heap spiked past the
machine's memory, which I only saw on Fly. I fixed it by bundling Drizzle into the
build and capping V8
([c756e11](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/c756e11),
[e3d765b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/e3d765b),
[1da1f32](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/1da1f32)).
Music comes from Deezer ids and is never hosted, so I depend on a free, rate-limited API. When four people building crates at once silenced everyone's
previews, I put every Deezer call behind one server-wide bucket that serves game
audio first
([93f99f5](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/93f99f5)).
The 3D shop is decoration and only loads after the page
works. Everything also works in the 2D page, for screen readers and slow phones.

## Agent workflow

I set up the harness before the app: a stack decision, `CLAUDE.md` rules and
failing specs before any code
([341eab5](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/341eab5),
[5920f1f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/5920f1f)).
Every rule change since has gone in the same order: the rule into `CLAUDE.md` or a
decision record, then a spec, then code.

I ran Claude (Opus) as an orchestrator only. In each phase it wrote the rules and a brief, then handed building to Sonnet
subagents in separate git worktrees, so two could work at once
([d2bbea9](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/d2bbea9),
[2c9bef8](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/2c9bef8)).
The history shows the split: 166 commits are co-authored by Sonnet and about
90 by Opus. After every phase an adversarial review agent that hadn't seen the build tried
to break it, and the fixes were re-checked before the next phase
([c100d06](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/c100d06),
[53a7da6](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/53a7da6)).
I chose this over one long session because a single agent tends to mark its own work
as done. The reviews kept finding things the builders' tests had passed, like a
phone layout that hid the steal
([51f89eb](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/51f89eb)).
The cost is time: every phase was built, then attacked.

These orchestration rules lived in my prompts and Claude Code's memory, not in the
repo's `CLAUDE.md`, though my crit 9 reflection says I added them.
The commits are the only trace, which is a gap.

The checks needed fixing too. The per-address stream cap skipped loopback, so the specs never hit it, and it would have locked the 13th phone out of a classroom on one wifi. Players at a table are now never counted
against it
([6bf601a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/6bf601a)).
I made the design calls, and twice my playtests overruled the agent. My friends
rejected a ground-up rethink it proposed. When I misread borrowing as a mole tell,
the agent started on a redesign, but all it needed was clearer wording
([8ae823d](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/8ae823d)).

## Corrections that landed in the harness

- My first "a mole never sees the prompt" check couldn't fail, because it scanned
  an empty page shell. It now scans everything a mole receives
  ([ef974a2](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/ef974a2)).
- A pick sent the same frame to everyone, so you could tell someone had picked. The rule is now "a pick sends nothing on any stream"
  ([c100d06](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/c100d06),
  [2179ca1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/2179ca1)).
- A review found three skipping players could run a game to 64 rounds, so every game now ends by rule
  ([676f7e2](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/676f7e2),
  [788596b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/788596b)).
- Twice a run looked green when it wasn't: once on a stale build, once when leak specs skipped without a token. `CLAUDE.md` now says a full check
  has to show 0 skipped
  ([0af71d0](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/0af71d0)).
- To stop one person being the mole too often, I added "no repeats until
  everyone's had a turn"
  ([095226b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/095226b)).
  A later review showed the room could then work out the last round's mole by
  elimination, so it's now weighted but never certain, with a simulation spec
  ([72bc52b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/72bc52b),
  [d26d4f5](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/d26d4f5)).
- "X voted" log lines showed up as the public tally moved, which gave away every
  ballot. Votes are now logged once, when voting locks
  ([31024ce](https://github.com/comp4020-agentic-coding-studio/comp4020-final-harkirats1511/commit/31024ce)).

## What I'd do differently

My README stayed as the course template and this file stayed an agent-written
ideation log through all three crits, and I didn't write a crit 8 reflection. So the record of my definition of good changing lives in the decision
records instead. The tests proved the app did what the rules said,
but only playing it told me whether the rules made a game worth playing. Next time I'd playtest before writing 28 tests around a mechanic.
