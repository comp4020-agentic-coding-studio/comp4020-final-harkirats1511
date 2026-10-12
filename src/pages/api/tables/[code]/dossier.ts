import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { dossierFor } from "../../../../lib/game.ts";
import { currentGame, isMember, normaliseCode, tableExists } from "../../../../lib/tables.ts";

// A mole's study of this round's target. Nobody else gets it, and it follows
// the target when the next round picks a new one.
export const GET: APIRoute = ({ params, cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const code = normaliseCode(params.code);
  if (!tableExists(code)) return json({ error: "No such table." }, 404);
  if (!isMember(code, me.id)) return json({ error: "You are not at this table." }, 403);
  if (!currentGame(code)) return json({ error: "No game is running." }, 409);
  const dossier = dossierFor(code, me.id);
  return dossier ? json(dossier) : json({ error: "Only a mole has a dossier." }, 403);
};
