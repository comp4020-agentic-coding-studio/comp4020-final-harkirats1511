import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { refused, tag } from "../../../lib/log.ts";
import { enter, isFull, MAX_PEOPLE } from "../../../lib/shop.ts";

const HEARTBEAT_MS = 15_000;
// A reader this far behind is gone without having closed; drop it.
const MAX_BACKLOG = -64;

// Public shop state only: names, avatars, positions, emotes, booths, radio.
// Signed-in people only, since it says who is here.
export const GET: APIRoute = ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("shop", null, "open the shop stream", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  if (isFull(me.id)) {
    refused("shop", tag(me), "walk in", `the shop is full (${MAX_PEOPLE})`);
    return json({ error: "The shop is full right now." }, 503);
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      send("retry: 2000\n\n");
      const here = enter(me, send)!;
      const beat = setInterval(() => {
        if ((controller.desiredSize ?? 1) < MAX_BACKLOG) return cleanup();
        send(": heartbeat\n\n");
      }, HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        here.leave();
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", cleanup);
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
