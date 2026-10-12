# Process log (working record, to be rewritten)

> **Status:** this is a stored log of the ideation session, written by Claude
> from the conversation at the student's request so nothing is lost. It is
> **not** the final PROCESS.md. The final account (900-1100 words, rewritten at
> each of the week 9-11 crits) has to be in the student's own words. Nothing
> below is a stack decision: the stack is still open and gets its own decision
> record.

## 1. Starting point

- Repo `comp4020-final-harkirats1511` provisioned by the course. The placeholder
  (busybox serving one page plus `README.md` at `/readme/`) was deployed
  unchanged to https://comp4020-final-harkirats1511.fly.dev/ to prove the
  Fly token and deploy path. `pnpm check` (the two shipped invariants: `/`
  answers 200, `/readme/` publishes the README headings) passed against it.
- Target deliverable: crit 8, "It's alive!" (week 9). Its spec: live on
  `*.fly.dev`; a stranger can use the core thing and find their trace on
  return; a first "what good means" in `README.md` served at `/readme/`, with
  the sources behind it; repo public at the cutoff; process evidence
  (`PROCESS.md`, `reflections/crit-8.md`, incremental commits); the student can
  account for how they steered, grounded and corrected the work.
- Final project brief: "Make a multi-user, real-time website that's good."
  Fixed requirements: multi-user (people told apart by the app), real-time
  (changes reach other open sessions within about a second), persistent
  (survives sessions, restarts, redeploys). Marked on process legibility 50%,
  deployed app 25%, response to the brief 25%. The median answer and features
  with no reason behind them are penalised.

## 2. Who it is for

The student's real friend group, usually 4-5 people in a room around one
speaker, meeting 2-3 times a week lately. One friend makes remixes, one plays
guitar and makes music; the rest have taste but no technique and don't know how
to start. They already spend time showing each other music (in the room or in
the car), recognise songs, and say whether they like them. Not very
competitive; warm, occasionally competitive. The student's own caveat: some of
this is their read of the others.

The problem posed: people with taste but not technique, playing alongside
people with both. Treat the skill gap as a design problem rather than smoothing
it over. The student's own seeds, offered as evidence of taste and not as
answers: (1) everyone gets one part of a song and recreates it on a timer;
(2) a musical Gartic Phone. What they liked underneath: being stuck with a role
you didn't choose, meaning drifting as something passes between people, timer
pressure, and a keepable artefact.

Questions asked before brainstorming (the answers changed the ideas): how the
group spends time together, what the producers get out of it, and how the
non-makers express taste. The answers above came from those.

## 3. Brainstorm

Territories explored, about 2 ideas each: sabotage and bluffing, imitation and
misremembering, listening, rituals over days, ideas borrowed from non-music
things, unusual representations of sound, plus two chosen by the agent
(presence-gated things, and roles you didn't pick). Roughly 18 ideas in all,
unranked. Where two shared a core mechanic one was cut; "existing thing but
music" cases were flagged (Mole is Among Us, Season of the Room is a fantasy
league, Blind Crate resembles "guess who added this song").

The student shortlisted five: Mole in the Mix, Blind Crate, Season of the Room,
Jigsaw Shards, Crowd-Steered Set.

## 4. Checking the shortlist against the brief

Each was tested against multi-user, real-time, persistence, "more interesting
with more people" and not-the-median.

- Mole, Jigsaw and Crowd-Steered Set were one-session games: persistence would
  be bolted on, which the brief penalises as a feature without a reason.
  Crowd-Steered Set also didn't tell people apart by default (microphone loudness
  is not identity).
- Blind Crate and Season of the Room persist naturally and suit meeting several
  times a week, but give producers little to do. Season of the Room is close to
  the median answer.
- The student's stated priority: a good **party game** first, with open
  willingness to combine ideas. The agent walked through the first 60 seconds of
  each of the five so the student could compare how they feel in the room.

## 5. Combinations and the choice

Three combinations were proposed and compared: **Forged Crate** (Mole + Blind
Crate), **Saboteur Shards** (Jigsaw + Mole), **Season of the Crate** (Season +
Blind Crate + reactions). Forged Crate was judged strongest because persistence
has a job in it (the mole needs a target's pick history to impersonate), identity
is the whole game, it suits a party-game first minute (role, secrecy, reveal,
accusation), and it is the least derivative. Saboteur Shards had the best spark
but weak persistence; Season of the Crate had the best persistence but the
weakest spark and originality.

The student chose Forged Crate and made two changes of their own:
- **Dropped the producer-forger role.** Producers play like everyone else. (This
  gives up the one idea that gave producers a distinct job; the skill-gap
  problem is now carried by taste alone and is still open.)
- **Made it Among Us-like:** the mole can be caught by a vote each round, and
  keeps getting new targets whose taste they have to imitate.

The student also said they don't mind music licensing since they are only
playing tracks, not distributing them. Agent's note: playing through an
official embedded player is fine, hosting audio files is not (and the Fly
machine's storage is small anyway), so the app should hold track links and
metadata only.

## 6. The idea as it stands (Forged Crate)

A game is a few rounds. Each round:
1. Everyone is a player ("pick a song you'd really play") except the mole, who
   is secretly given a target and has to pick what the target would pick, using
   the target's pick history.
2. Everyone locks in one track within a timer.
3. Tracks play anonymously one at a time through the room's speaker.
4. Discussion and claims ("number 3 is mine"); conflicting claims and "that's
   very them but they wouldn't pick it" are the clues.
5. Simultaneous hidden vote for who the mole is.
6. Reveal: true owner of each track, the vote result, and whether the mole was
   caught. The mole gets a new target next round if they survive.

Ways the mole can be caught: conflicting claims, taste mismatch, the mole's
own claim not holding up. Players win by voting out the mole; the mole wins by
surviving, or by getting their track pinned on the target.

## 7. Basics of the app (functionality, not implementation)

- **People and persistence:** a name and some way of being recognised on return;
  a "taste file" at onboarding (about 10 favourite tracks each) so the mole has
  history from the very first game; a growing pick history; a ledger of who gets
  fooled, who spots moles, who plays the best mole; replay of past games.
- **Real-time:** lobby with room code and presence; synced timers; "X of Y have
  picked/voted" counters that hide the content; everyone on the same current
  track within about a second; votes and reveal landing together.
- **Music:** search and link-based playback via an embedded player on one
  "speaker" device. Known problem: embedded players tend to show the track
  title, which would leak who picked what, so the speaker device's screen has to
  be hidden or the title covered.
- **Screens:** onboarding (taste file), lobby, role reveal, pick, listen,
  discuss and vote, reveal, ledger and replay.

## 8. Decisions and open questions (as of this point)

The student's answers, with the agent's pushback recorded where it disagreed:

- **Ghosts:** voted-out players become ghosts, who still pick tracks but can't
  vote, so nobody sits out a 4-5 person room. *Accepted.* Caveat: a ghost's
  track still counts for the round, and a ghost can't be the target.
- **Number of moles:** roughly 1 for up to 5 players and 2 up to 10, or let the
  host choose. *Accepted with a cap.* Free choice lets a group set 3 moles in 4
  players and break the game; default by player count, host can override within a
  limit. Moles must not target each other, and nobody targets themselves.
- **Is the target known?** The student asked whether the target has to be known;
  read as "the room shouldn't know who the target is". *Accepted, and extended:*
  the target shouldn't be told either, or they would be tipped off. The claim
  clue still works because they know their own pick.
- **Identity:** name plus avatar. *Partly accepted.* The name is core; the
  avatar is a nice-to-have that helps tell people apart on screen but isn't
  needed to prove it works. Real question left open: a name alone lets any friend
  type another's name, which matters in a game about impersonation, so some light
  recognition on return (a PIN or remembered device) is likely needed.
- **Implementation:** the student is happy to leave it open and work it out as we
  go. Agent's flag: stack, track source, the speaker/title leak and the
  cold-start taste file are the things most worth settling before building,
  because they decide whether the core loop works at all.

Still open: minimum number of players (three feels too thin); exact win
conditions and the cost of a wrong vote; what "good" means for this app (the
README argument, and the sources the student reads for it); the stack and its
decision record; what the first-version slice for crit 8 contains.

## 9. How the work was steered

- The agent asked questions before brainstorming rather than assuming the group,
  and the answers changed the idea set.
- Ideas were checked against the spec as written, not just liked: the persistence
  weakness of the party games was caught at this stage rather than after
  building.
- The student rejected one agent-proposed element (the producer forger) and
  directed the voting change, so the design is the student's call, not the
  agent's first suggestion.
- No code has been written yet. The README ("what good means") and the final
  PROCESS.md are to be written by the student.

## 10. Decisions made while planning the crit 8 slice

- **Skill gap dropped as a requirement.** The student pointed out the brief
  doesn't need one; it was only in the first message as a real-world example.
  The game is now simply a catch-the-imposter game, music edition.
- **First slice (works for one stranger alone):** join, add a taste file of
  about 10 favourite tracks, then guess whose pick each track in the shared
  crate is. It leaves a persistent trace (their picks and guess history) and
  builds the history the mole needs later. The full mole round needs 4+ people
  online, so it isn't the first slice.
- **Music source: Deezer 30-second previews.** Checked against the live API: no
  login needed, search works, the preview URL served `audio/mpeg`. Previews are
  plain audio so the app controls the player and no title leaks on the speaker
  device. The preview URLs are signed and expire, so the app stores track IDs
  and fetches a fresh URL per round.
- **Identity: name plus a short PIN**, so a friend can't take over another
  friend's name and history.
- **Stack: not yet decided.** The student's earlier full-stack repo (crit 7)
  already ran Astro on the Node adapter with SQLite (better-sqlite3 and Drizzle)
  on the same Fly constraints. The agent's first suggestion (a custom Node server
  with WebSockets) ignored that; the real choice is between keeping that
  familiar base and a custom server. To be written up as a decision record.
