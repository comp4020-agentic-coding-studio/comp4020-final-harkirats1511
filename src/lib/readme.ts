import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";

// README.md sits in the working directory: the repo root locally, /app in the
// image (the Dockerfile copies it there).
export function renderReadme(): string {
  const md = readFileSync(resolve(process.env.README_PATH ?? "README.md"), "utf8");
  return marked.parse(md, { gfm: true, async: false });
}
