import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Server-rendered: pages and API routes run per request against SQLite.
// The app is served at the domain root, so there is no `base`.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    // Fly's proxy terminates TLS; naming the deploy domain lets Astro trust
    // x-forwarded-proto and accept same-origin POSTs.
    allowedDomains: [{ hostname: "**.fly.dev", protocol: "https" }],
  },
});
