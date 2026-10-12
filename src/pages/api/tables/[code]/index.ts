import type { APIRoute } from "astro";
import { json } from "../../../../lib/auth.ts";
import { normaliseCode, publicState } from "../../../../lib/tables.ts";

export const GET: APIRoute = ({ params }) => {
  const state = publicState(normaliseCode(params.code));
  return state ? json(state) : json({ error: "No such table." }, 404);
};
