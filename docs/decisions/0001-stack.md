# 0001: Stack

Status: accepted (crit 8/9 planning). Revisit if the app outgrows it, and write a
new record rather than editing this one.

## Context

The app is a live game for a group of friends in one room: phones join a table,
play rounds together, and the history of every pick has to survive restarts and
redeploys. The deploy shape is fixed by `fly.toml`: one shared-cpu-1x machine,
256 MB, one volume at `/data`, HTTP on `0.0.0.0:$PORT`, no separate database
server. Real-time means a change reaches other open sessions within about a
second with no reload.

## Options

1. **Astro (Node adapter) + SQLite/Drizzle on `/data` + server-sent events.**
   The same base crit 7 already ran on this exact Fly setup.
2. **Custom Node server + WebSockets + SQLite.** Two-way socket, but a bespoke
   server around everything, and none of it already proven here.
3. **Python/FastAPI + SQLite.** Fine technically, but a second language beside
   the repo's TypeScript checks, and no prior experience on this setup.

## Choice

Option 1. Updates only ever flow server to phone (a pick count changed, the
round advanced); actions go back as ordinary requests. That is exactly what SSE
does, and it is enough for the one-second requirement. SQLite on `/data` is the
only storage that survives a redeploy, and it fits 256 MB.

## Cost

- SSE is one-way. If a feature ever needs low-latency client-to-server streaming
  (live reactions at tap speed, say), this choice has to be revisited.
- Each open session holds a connection on a 256 MB machine, which is fine for a
  room of friends and would not be for hundreds.
- The Astro `base` and build config are re-derived for this repo, not copied from
  crit 7, because `base` embeds the repo name.
