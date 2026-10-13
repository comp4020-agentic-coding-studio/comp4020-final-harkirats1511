import type { APIRoute } from "astro";
import { OPTIONS } from "../../../lib/avatar.ts";

// Public and the same for everyone, so it can be cached.
export const GET: APIRoute = () =>
  new Response(JSON.stringify(OPTIONS), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });

