import type { APIRoute } from "astro";
import {
  clearFailures, createPerson, findPersonByName, json, newPinHash, noteFailure, pinMatches,
  startSession, throttled, validName, validPin,
} from "../../lib/auth.ts";
import { log, refused, tag } from "../../lib/log.ts";

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = (await request.json().catch(() => null)) as { name?: unknown; pin?: unknown } | null;
  const name = validName(body?.name);
  const pin = validPin(body?.pin);
  if (!name) {
    refused("auth", null, "sign-in", "bad name");
    return json({ error: "Name must be 1 to 24 characters." }, 400);
  }
  if (!pin) {
    refused("auth", null, `sign-in as ${name}`, "bad PIN format");
    return json({ error: "PIN must be 4 to 8 digits." }, 400);
  }
  if (throttled(name)) {
    refused("auth", null, `sign-in as ${name}`, "too many wrong PINs, throttled");
    return json({ error: "Too many wrong PINs. Try again in a few minutes." }, 429);
  }

  const existing = findPersonByName(name);
  if (existing) {
    if (!(await pinMatches(pin, existing))) {
      noteFailure(name);
      refused("auth", tag(existing), "sign-in", "wrong PIN");
      return json({ error: "That name is taken, and that PIN is not its PIN." }, 403);
    }
    clearFailures(name);
    startSession(existing.id, cookies, request);
    log("auth", `${tag(existing)} signed in · returning`);
    return json({ id: existing.id, name: existing.name });
  }

  const hash = await newPinHash(pin);
  let id: string;
  try {
    id = createPerson(name, hash);
  } catch {
    // lost a race to claim the same name
    refused("auth", null, `sign-in as ${name}`, "name taken (lost a race)");
    return json({ error: "That name is taken, and that PIN is not its PIN." }, 403);
  }
  startSession(id, cookies, request);
  log("auth", `${tag({ id, name })} signed in · new name`);
  return json({ id, name });
};
