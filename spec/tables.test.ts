import { expect, it } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract: POST /api/tables creates a table and returns {code}.
// POST /api/tables/:code/join joins it. GET /api/tables/:code/events is a
// server-sent-event stream of that table's state; POST /api/tables/:code/start
// begins a game and refuses to with fewer than 3 players.

async function signedIn(prefix: string) {
  const s = session();
  await s.call("/api/join", { body: { name: uniqueName(prefix), pin: "1357" } });
  return s;
}

it("shows one person's join to another open session within about a second", async () => {
  const host = await signedIn("host");
  const guest = await signedIn("gst");
  const { code } = (await (await host.call("/api/tables", { body: {} })).json()) as {
    code: string;
  };

  // Watch the table the way a second phone would: an open stream, no reload.
  const controller = new AbortController();
  const stream = await fetch(new URL(`/api/tables/${code}/events`, baseUrl), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();

  const joinedAt = Date.now();
  await guest.call(`/api/tables/${code}/join`, { body: {} });

  let seen = "";
  const decoder = new TextDecoder();
  while (Date.now() - joinedAt < 1000) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1000 - (Date.now() - joinedAt)));
    const chunk = await Promise.race([reader.read(), timeout]);
    if (!chunk || chunk.done) break;
    seen += decoder.decode(chunk.value);
    if (/gst/.test(seen)) break;
  }
  controller.abort();

  expect(seen).toMatch(/gst/);
  expect(Date.now() - joinedAt).toBeLessThan(1500);
});

it("will not start a game with fewer than 3 players", async () => {
  const host = await signedIn("solo");
  const { code } = (await (await host.call("/api/tables", { body: {} })).json()) as {
    code: string;
  };
  const res = await host.call(`/api/tables/${code}/start`, { body: {} });
  expect(res.status).toBe(409);
});
