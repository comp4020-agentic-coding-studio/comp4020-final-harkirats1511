import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Server-rendered: pages and API routes run per request against SQLite.
// The app is served at the domain root, so there is no `base`.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
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
