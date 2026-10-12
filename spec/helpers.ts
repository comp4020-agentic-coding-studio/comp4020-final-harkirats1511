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
  };
}

// Unique per run, so repeated runs against a live database don't collide.
export const uniqueName = (prefix: string): string =>
  `${prefix}${Math.random().toString(36).slice(2, 8)}`;

export { baseUrl };
