import type { APIRoute } from "astro";
import { frameFeed, normaliseCode, tableExists, tableWatchers, watchTable } from "../../../../lib/tables.ts";
import { addressOf, firstSaying, MAX_STREAMS_PER_IP, MAX_WATCHERS_PER_TABLE, openStream } from "../../../../lib/limits.ts";
import { refused } from "../../../../lib/log.ts";

const HEARTBEAT_MS = 15_000;

// Public table state only, readable without a session. Anything private to
// one player must never be sent here; it belongs on an authenticated endpoint.
//
// The frame is built once per change per table (tables.ts) and shared by every
// stream. By default each frame is the complete public state. `?slim=1` is for
// a client that keeps what it has: its first frame is complete, and a later
// frame leaves out `members[].crate` or `game.past` when they are unchanged
// since that stream's last frame, naming what it left out in `same`
// (["crates"], ["past"]); the client keeps its last copy of those.
export const GET: APIRoute = ({ params, request, clientAddress }) => {
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return new Response("No such table.", { status: 404 });

  const ip = addressOf(request, clientAddress);
  const slot = openStream(tableWatchers(code), ip);
  if (slot === "table") {
    if (firstSaying(`t${code}`)) refused("streams", null, `watch table ${code}`, `${MAX_WATCHERS_PER_TABLE} watchers already`);
    return new Response("This table has too many watchers.", { status: 429 });
  }
  if (slot === "ip") {
    if (firstSaying(`i${ip}`)) refused("streams", null, `watch table ${code}`, `${MAX_STREAMS_PER_IP} streams open from one address`);
    return new Response("Too many open streams from your address.", { status: 429 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const slim = new URL(request.url).searchParams.get("slim") === "1";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      // A frame identical to the last one on this connection is never sent: it
      // would only tell the viewer that something (a pick) happened.
      const next = frameFeed(code, slim);
      const sendState = () => {
        const data = next();
        if (data !== null) send(`event: state\ndata: ${data}\n\n`);
      };
      const unwatch = watchTable(code, sendState);
      const beat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        unwatch();
        slot.release();
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", cleanup);
      send("retry: 2000\n\n");
      sendState();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
};
