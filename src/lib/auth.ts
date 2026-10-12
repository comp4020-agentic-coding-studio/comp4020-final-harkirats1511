import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AstroCookies } from "astro";
import { eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { people, sessions } from "./schema.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const COOKIE = "mole_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 90;

export type Person = { id: string; name: string };

export function validName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= 24 ? name : null;
}

export function validPin(raw: unknown): string | null {
  return typeof raw === "string" && /^\d{4,8}$/.test(raw) ? raw : null;
}

async function hashPin(pin: string, salt: Buffer): Promise<string> {
  return (await scrypt(pin, salt, 32)).toString("hex");
}

export async function newPinHash(pin: string) {
  const salt = randomBytes(16);
  return { pinSalt: salt.toString("hex"), pinHash: await hashPin(pin, salt) };
}

export async function pinMatches(pin: string, row: { pinHash: string; pinSalt: string }) {
  const got = Buffer.from(await hashPin(pin, Buffer.from(row.pinSalt, "hex")), "hex");
  const want = Buffer.from(row.pinHash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function findPersonByName(name: string) {
  return db.select().from(people).where(sql`lower(${people.name}) = lower(${name})`).get();
}

export function createPerson(name: string, hash: { pinHash: string; pinSalt: string }) {
  const id = randomUUID();
  db.insert(people).values({ id, name, ...hash, createdAt: Date.now() }).run();
  return id;
}

export function startSession(personId: string, cookies: AstroCookies, request: Request) {
  const token = randomBytes(32).toString("base64url");
  db.insert(sessions).values({ token, personId, createdAt: Date.now() }).run();
  const secure =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: SESSION_MAX_AGE,
  });
}

export function personFromCookies(cookies: AstroCookies): Person | null {
  const token = cookies.get(COOKIE)?.value;
  if (!token) return null;
  const row = db
    .select({ id: people.id, name: people.name })
    .from(sessions)
    .innerJoin(people, eq(people.id, sessions.personId))
    .where(eq(sessions.token, token))
    .get();
  return row ?? null;
}

// Light brake on PIN guessing: after 8 wrong PINs for a name within 10
// minutes, further attempts on it are refused until the window passes.
const failures = new Map<string, { count: number; since: number }>();
const WINDOW = 10 * 60 * 1000;
const MAX_FAILS = 8;
export function throttled(name: string): boolean {
  const f = failures.get(name.toLowerCase());
  return !!f && Date.now() - f.since < WINDOW && f.count >= MAX_FAILS;
}
export function noteFailure(name: string) {
  const key = name.toLowerCase();
  const f = failures.get(key);
  if (!f || Date.now() - f.since >= WINDOW) failures.set(key, { count: 1, since: Date.now() });
  else f.count++;
}
export function clearFailures(name: string) {
  failures.delete(name.toLowerCase());
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
