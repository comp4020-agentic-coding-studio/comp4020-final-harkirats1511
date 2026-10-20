# 0004: The shop floor (free roam)

Status: accepted (final project).

## Context

Until now you only met people at a table whose code someone had told you. For
the final, the app becomes a record shop after hours: a 3D room you walk around
as your character, where tables are listening booths, and you can sit at a
stranger's booth the way you'd walk up to a table in Among Us's lobby. Everyone
in the shop sees everyone else move, wave and sit down, close to live.

That is the first thing in the app that streams from the phone to the server
many times a second, which is exactly the cost 0001 named for server-sent
events.

## Options for moving people around

1. **WebSockets.** Two-way and the usual answer for games. The Astro Node
   adapter doesn't serve them, so it means a second server beside Astro (or
   replacing its entry point), a second protocol to test, and the 2D page and
   the 3D shop would no longer share one way of getting updates.
2. **Server-sent events down, small POSTs up (chosen).** Each phone sends its
   position at most 8 times a second while it is moving, and nothing while it
   stands still. The server keeps the latest position per person in memory and
   sends everyone one batched frame at most 10 times a second, only for the
   people who moved. Phones smooth between frames, so 8–10 updates a second
   reads as walking, not teleporting.
3. **Polling.** Simplest, but every phone asking several times a second even
   when nobody moves is wasted work on a 256 MB machine.

## Choice

Option 2. It keeps one transport for the whole app and the existing test style
(plain HTTP against the running app). Movement is a social nicety here, not a
reflex game: nobody loses because a wave arrived 150 ms late.

## The rules that come with it

- **Where you are is not game state.** Positions live in memory only and are
  lost on a restart; you reappear at the door. Everything that decides a game
  (tables, members, picks, votes) is still in SQLite. This is the one exception
  to "restore from the database", and it's deliberate: writing 8 positions a
  second per person to disk would cost more than the feature is worth.
- **Being in the shop means having the shop stream open.** Closing the tab, or
  20 seconds without the stream, takes you out of the shop.
- **The server decides what's possible.** Positions are clamped to the room,
  speed is capped (no teleporting across the shop), and more than 8 moves a
  second from one person are dropped, not queued. Emotes are a fixed list.
- **The shop knows nothing private.** The shop stream carries names, avatars,
  positions, emotes and each booth's public state (code, open or private, host,
  seats taken, waiting or playing). Never a theme, a role, a pick, a title or who
  has picked or voted: it is built from the same public table state as the 2D
  page, so it can't.
- **Booths stand in fixed spots.** The server gives each live table a spot in
  the shop, so everyone sees the same booth in the same place. Tables beyond the
  spots the room has are still listed in the 2D booth list. A table is a booth
  while someone has its page open, or for two minutes after it's made; a lobby
  everyone walked away from leaves the shop instead of standing there empty.
- **People walk in spread out** round the door, so two arrivals don't stand
  inside each other.
- **3D stays decoration.** Every action in the shop (see open booths, take a
  seat, knock with a code, report) is also a button in the 2D list, which is
  what keyboards, screen readers and slow phones use.

## Cost

- Positions vanish on a restart or redeploy, so everyone walks back in from the
  door.
- The shop holds one stream per person on the same 256 MB machine. The shop is
  capped (40 people) and the cap is a number to watch in the logs, not a promise
  of scale.
- Two people can stand in the same spot; there's no collision between people,
  only with the furniture.
