import type { APIRoute } from "astro";
import { normaliseCode, publicState, watchTable } from "../../../../lib/tables.ts";

const HEARTBEAT_MS = 15_000;

// Public table state only, readable without a session. Anything private to
// one player must never be sent here; it belongs on an authenticated endpoint.
export const GET: APIRoute = ({ params, request }) => {
  const code = normaliseCode(params.code);
  if (!publicState(code)) return new Response("No such table.", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const sendState = () => {
        const state = publicState(code);
        if (state) send(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      };
      const unwatch = watchTable(code, sendState);
      const beat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        unwatch();
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
