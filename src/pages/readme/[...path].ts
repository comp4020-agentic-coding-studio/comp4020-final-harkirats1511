import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { APIRoute } from "astro";

// README images are committed under docs/ and linked relatively (docs/x.png),
// which resolves to /readme/docs/x.png from the published README.
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export const GET: APIRoute = async ({ params }) => {
  const rel = params.path ?? "";
  const type = TYPES[extname(rel).toLowerCase()];
  const root = resolve("docs");
  const file = resolve(root, rel.replace(/^docs\//, ""));
  if (!rel.startsWith("docs/") || !type || !file.startsWith(root + sep)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    return new Response(await readFile(file), { headers: { "content-type": type } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
