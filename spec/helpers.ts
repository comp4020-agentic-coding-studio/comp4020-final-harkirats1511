import { inject } from "vitest";

const baseUrl = inject("baseUrl");

// One browser session: its own cookie jar, talking to the running app.
export function session() {
  let cookie = "";
  return {
    async call(path: string, init: { method?: string; body?: unknown } = {}) {
      const method = init.method ?? (init.body === undefined ? "GET" : "POST");
      const send = () =>
        fetch(new URL(path, baseUrl), {
          method,
          headers: {
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            ...(cookie ? { cookie } : {}),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      // Node's server closes a kept-alive socket after 5 s idle; a GET sent on it at
      // that moment dies before the app sees it. Seen only off loopback, under load.
      const res = await send().catch((e: Error) => {
        if (method === "GET" && /other side closed|socket hang up/i.test(String((e as { cause?: Error }).cause ?? e))) return send();
        throw e;
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

// Known-good Deezer ids, all with previews. A crate is 12 songs, 3 in each of the
// four slots: ids 0-2 are Up, 3-5 Down, 6-8 Out, 9-11 In. Each set is distinct,
// because a song can be played only once per game by anyone, so people at one
// table need different sets.
export const SLOT_NAMES = ["up", "down", "out", "in"] as const;
export const CRATES: number[][] = [
  [13159670, 829306252, 1951194607, 684573392, 3099606, 1444366372, 1031007, 512466312, 2465911, 3512895311, 3512895281, 2791780102],
  [1123844, 445960982, 84107655, 375959421, 1951194587, 5726092, 2791872372, 446028242, 980535512, 1733771197, 2562284362, 3512895331],
  [67238732, 136889400, 136889434, 66609426, 3135563, 3135553, 67238735, 3129775, 67238733, 3135556, 67238730, 3129772],
  [4091937401, 4092329741, 4091932171, 4092324041, 4092312801, 4091936611, 4091936641, 4092335521, 4092326741, 4092323401, 4091936691, 4092326601],
  [8086130, 8086126, 8086135, 82715364, 8086136, 8086128, 1522223672, 138546009, 138545995, 8086127, 940355, 8086129],
  [3128096, 3098840, 114811546, 3098841, 14299589, 142706538, 3106505, 3128097, 3128095, 3128092, 3289333851, 3024257751],
  [124603270, 533609232, 4022917771, 124603286, 63565179, 608410332, 144572210, 118190298, 1484144902, 13529560, 17347964, 70697364],
  [116348656, 116348464, 116348452, 116348632, 3886522131, 116348340, 116348252, 116348204, 116348264, 3567641811, 116348454, 116348272],
];
export const CRATE_IDS = CRATES[0];
export const slotOfIndex = (i: number) => SLOT_NAMES[Math.floor(i / 3)];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Gives this session's person a complete crate (set `which`, default 0) and
// returns its ids. Deezer rate-limits bursts, so a failed lookup is retried.
export async function fillCrate(s: ReturnType<typeof session>, which = 0): Promise<number[]> {
  const ids = CRATES[which];
  for (const [i, trackId] of ids.entries()) {
    for (let attempt = 0; ; attempt++) {
      const res = await s.call("/api/taste", { body: { trackId, slot: slotOfIndex(i) } });
      if (res.status < 300) break;
      if (res.status < 500 && res.status !== 404 || attempt >= 6) throw new Error(`could not add ${trackId} to the crate: ${res.status}`);
      await sleep(1500);
    }
  }
  return ids;
}
