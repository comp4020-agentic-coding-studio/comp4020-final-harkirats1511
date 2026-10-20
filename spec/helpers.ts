import { inject } from "vitest";

const baseUrl = inject("baseUrl");

// One browser session: its own cookie jar, talking to the running app.
export function session() {
  let cookie = "";
  return {
    async call(path: string, init: { method?: string; body?: unknown } = {}) {
      const res = await fetch(new URL(path, baseUrl), {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return res;
    },
    // An open server-sent-event stream as this person.
    async open(path: string) {
      const controller = new AbortController();
      const res = await fetch(new URL(path, baseUrl), {
        headers: { accept: "text/event-stream", ...(cookie ? { cookie } : {}) },
        signal: controller.signal,
      });
      return reader(res, controller);
    },
  };
}

export type SseEvent = { event: string; data: any };

// Reads a stream's frames as they arrive. `raw` is every byte seen so far.
function reader(res: Response, controller: AbortController) {
  const body = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let raw = "";
  let pending = "";
  const wake: { fn?: () => void } = {};
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        pending += text;
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) seen.push({ event, data: JSON.parse(data) });
        }
        wake.fn?.();
      }
    } catch {
      // aborted
    }
    wake.fn?.();
  })();
  return {
    status: res.status,
    seen,
    get raw() {
      return raw;
    },
    // The first frame (from `from` on) that satisfies `ok`, or null after `ms`.
    async next(ok: (e: SseEvent) => boolean, ms = 2000, from = 0): Promise<SseEvent | null> {
      const until = Date.now() + ms;
      for (let i = from; ; i++) {
        while (i >= seen.length) {
          const left = until - Date.now();
          if (left <= 0) return null;
          await new Promise<void>((resolve) => {
            wake.fn = resolve;
            setTimeout(resolve, left);
          });
        }
        if (ok(seen[i])) return seen[i];
      }
    },
    close: () => controller.abort(),
  };
}

// Unique per run, so repeated runs against a live database don't collide.
export const uniqueName = (prefix: string): string =>
  `${prefix}${Math.random().toString(36).slice(2, 8)}`;

export { baseUrl };

// Known-good Deezer ids: a crate needs 5 to play, and a pick must come from it.
export const CRATE_IDS = [3512895311, 3512895281, 13159670, 2791780102, 1951194587, 1123844, 445960982, 84107655];

// Gives this session's person `n` tracks (default 5, the minimum to play).
export async function fillCrate(s: ReturnType<typeof session>, n = 5): Promise<number[]> {
  const ids = CRATE_IDS.slice(0, n);
  for (const trackId of ids) {
    const res = await s.call("/api/taste", { body: { trackId } });
    if (res.status >= 300) throw new Error(`could not add ${trackId} to the crate: ${res.status}`);
  }
  return ids;
}
