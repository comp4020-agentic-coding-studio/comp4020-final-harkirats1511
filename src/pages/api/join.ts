import type { APIRoute } from "astro";
import {
  clearFailures, createPerson, findPersonByName, json, newPinHash, noteFailure, pinMatches,
  startSession, throttled, validName, validPin,
} from "../../lib/auth.ts";

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = (await request.json().catch(() => null)) as { name?: unknown; pin?: unknown } | null;
  const name = validName(body?.name);
  const pin = validPin(body?.pin);
  if (!name) return json({ error: "Name must be 1 to 24 characters." }, 400);
  if (!pin) return json({ error: "PIN must be 4 to 8 digits." }, 400);
  if (throttled(name)) return json({ error: "Too many wrong PINs. Try again in a few minutes." }, 429);

  const existing = findPersonByName(name);
  if (existing) {
    if (!(await pinMatches(pin, existing))) {
      noteFailure(name);
      return json({ error: "That name is taken, and that PIN is not its PIN." }, 403);
    }
    clearFailures(name);
    startSession(existing.id, cookies, request);
    return json({ id: existing.id, name: existing.name });
  }

  const hash = await newPinHash(pin);
  let id: string;
  try {
    id = createPerson(name, hash);
  } catch {
    // lost a race to claim the same name
    return json({ error: "That name is taken, and that PIN is not its PIN." }, 403);
  }
  startSession(id, cookies, request);
  return json({ id, name });
};
