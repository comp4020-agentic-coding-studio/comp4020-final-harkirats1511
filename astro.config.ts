import { appendFileSync, existsSync } from "node:fs";
import node from "@astrojs/node";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";

// Astro loads the middleware (and everything it imports) on the first request,
// but a running game's timers must be re-armed when the server boots. This
// appends an eager import of the built middleware to the server entry; the
// middleware calls resumeGames() when it loads.
function resumeOnBoot(): AstroIntegration {
  let server: URL;
  return {
    name: "resume-games-on-boot",
    hooks: {
      "astro:config:done": ({ config }) => {
        server = config.build.server;
      },
      "astro:build:done": () => {
        const entry = new URL("entry.mjs", server);
        if (!existsSync(entry) || !existsSync(new URL("virtual_astro_middleware.mjs", server))) {
          throw new Error("resume-games-on-boot: the built server layout changed; update astro.config.ts");
        }
        appendFileSync(entry, '\nimport("./virtual_astro_middleware.mjs");\n');
      },
    },
  };
}

// Server-rendered: pages and API routes run per request against SQLite.
// The app is served at the domain root, so there is no `base`.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [resumeOnBoot()],
  vite: {
    ssr: {
      // drizzle-orm ships a ~180 KB package.json and hundreds of small files.
      // Loaded unbundled, Node re-reads that package.json for each file and the
      // transient garbage grows the V8 heap by ~150 MB on the first database
      // request, which is fatal on a 256 MB machine. Bundling it avoids that.
      noExternal: ["drizzle-orm"],
    },
  },
  security: {
    // Fly's proxy terminates TLS; naming the deploy domain lets Astro trust
    // x-forwarded-proto and accept same-origin POSTs.
    allowedDomains: [{ hostname: "**.fly.dev", protocol: "https" }],
  },
});
