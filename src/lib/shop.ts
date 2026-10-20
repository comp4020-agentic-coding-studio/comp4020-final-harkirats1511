import type { Person } from "./auth.ts";
import type { Avatar } from "./avatar.ts";
import { getAvatar } from "./avatars.ts";
import { booths } from "./booths.ts";
import { log, tag } from "./log.ts";
import { getRadio, watchRadio } from "./radio.ts";
import { watchAnyTable } from "./tables.ts";

// Who is in the shop and where (decisions 0004, 0005). Memory only, gone after
// a restart: nothing a game depends on lives here. The server is the referee:
// it clamps every position to the room and caps speed, and a client is never
// believed about how far it moved.
export const BOUNDS = { minX: -8, maxX: 8, minZ: -5.5, maxZ: 4.7 };
export const DOOR = { x: 0.6, z: 4.2 };
export const MAX_PEOPLE = 40;
export const EMOTES = ["wave", "nope", "jump", "dance"];
const SPEED = 4; // metres per second
const SPEED_SLACK = 0.25; // metres, so a steady walker is never nudged by jitter
const MOVES_PER_SECOND = 8;
const FRAME_MS = 100;
const BOOTHS_MS = 250;
const REJOIN_MS = 20_000;

type Here = {
  id: string;
  name: string;
  avatar: Avatar;
  x: number;
  z: number;
  yaw: number;
  // Open streams (tabs) of this person; they leave when the last one closes.
  streams: Set<(text: string) => void>;
  lastAt: number;
  // When the last 8 accepted moves landed, a ring: the oldest says whether a ninth is too soon.
  recent: number[];
  emoteAt: number;
  moved: boolean;
};

const here = new Map<string, Here>();
// Where someone stood when their last stream closed, for 20 s.
const lastSpot = new Map<string, { x: number; z: number; yaw: number; until: number }>();
const moved = new Set<Here>();

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const normYaw = (d: number) => round2((((d + 180) % 360) + 360) % 360 - 180);
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const spot = (p: Here) => ({ x: p.x, z: p.z, yaw: p.yaw });

function broadcast(text: string, except?: Here) {
  for (const p of here.values()) if (p !== except) for (const send of p.streams) send(text);
}

// ---- the shared timers: running only while someone is in the shop ----

let frame: NodeJS.Timeout | null = null;
let boothsTimer: NodeJS.Timeout | null = null;
let lastBooths = "";
let unwatch: (() => void)[] = [];

function startWatching() {
  frame = setInterval(() => {
    if (!moved.size) return;
    const people = [...moved].map((p) => ({ name: p.name, ...spot(p) }));
    for (const p of moved) p.moved = false;
    moved.clear();
    broadcast(sse("moves", { people }));
  }, FRAME_MS);
  frame.unref();
  lastBooths = JSON.stringify(booths());
  unwatch = [
    watchAnyTable(() => {
      if (boothsTimer) return;
      boothsTimer = setTimeout(() => {
        boothsTimer = null;
        const list = JSON.stringify(booths());
        if (list === lastBooths) return;
        lastBooths = list;
        broadcast(`event: booths\ndata: ${list}\n\n`);
      }, BOOTHS_MS);
      boothsTimer.unref();
    }),
    watchRadio((r) => broadcast(sse("radio", r))),
  ];
}

function stopWatching() {
  if (frame) clearInterval(frame);
  if (boothsTimer) clearTimeout(boothsTimer);
  frame = boothsTimer = null;
  for (const off of unwatch) off();
  unwatch = [];
}

// ---- coming and going ----

// A new person can't come in once 40 are here; one already in may open more tabs.
export const isFull = (personId: string) => !here.has(personId) && here.size >= MAX_PEOPLE;

// Opens a stream for this person (check isFull first).
export function enter(me: Person, send: (text: string) => void): { leave: () => void } {
  let p = here.get(me.id);
  if (!p) {
    const back = lastSpot.get(me.id);
    lastSpot.delete(me.id);
    const at = back && back.until > Date.now() ? back : { ...DOOR, yaw: 180 };
    p = {
      id: me.id, name: me.name, avatar: getAvatar(me.id), x: at.x, z: at.z, yaw: at.yaw,
      streams: new Set(), lastAt: Date.now(), recent: [], emoteAt: 0, moved: false,
    };
    if (!here.size) startWatching();
    here.set(me.id, p);
    log("shop", `${tag(me)} walked in`);
    broadcast(sse("joined", { name: p.name, avatar: p.avatar, ...spot(p) }), p);
  }
  p.streams.add(send);
  send(sse("snapshot", {
    you: p.name,
    people: [...here.values()].map((q) => ({ name: q.name, avatar: q.avatar, ...spot(q) })),
    booths: booths(),
    radio: getRadio(),
  }));
  const self = p;
  return {
    leave() {
      self.streams.delete(send);
      if (self.streams.size || here.get(self.id) !== self) return;
      here.delete(self.id);
      moved.delete(self);
      const now = Date.now();
      for (const [id, r] of lastSpot) if (r.until <= now) lastSpot.delete(id);
      lastSpot.set(self.id, { ...spot(self), until: now + REJOIN_MS });
      log("shop", `${tag(self)} walked out`);
      broadcast(sse("left", { name: self.name }));
      if (!here.size) stopWatching();
    },
  };
}

// ---- acting ----

// False when this person isn't in the shop (no open stream).
export function isHere(personId: string): boolean {
  return here.has(personId);
}

// Accepts a move: dropped past 8 a second, otherwise clamped to the room and to
// what 4 m/s allows since the last accepted one. Never rejected for distance.
export function move(personId: string, x: number, z: number, yaw: number): boolean {
  const p = here.get(personId);
  if (!p) return false;
  const now = Date.now();
  if (p.recent.length >= MOVES_PER_SECOND && now - p.recent[0] < 1000) return true;
  let tx = clamp(x, BOUNDS.minX, BOUNDS.maxX);
  let tz = clamp(z, BOUNDS.minZ, BOUNDS.maxZ);
  const reach = SPEED * ((now - p.lastAt) / 1000) + SPEED_SLACK;
  const d = Math.hypot(tx - p.x, tz - p.z);
  if (d > reach) {
    tx = p.x + ((tx - p.x) * reach) / d;
    tz = p.z + ((tz - p.z) * reach) / d;
  }
  p.recent.push(now);
  if (p.recent.length > MOVES_PER_SECOND) p.recent.shift();
  p.lastAt = now;
  p.x = round2(tx);
  p.z = round2(tz);
  p.yaw = normYaw(yaw);
  if (!p.moved) {
    p.moved = true;
    moved.add(p);
  }
  return true;
}

// At most one a second per person; extra ones are ignored. False when not in the shop.
export function emote(personId: string, name: string): boolean {
  const p = here.get(personId);
  if (!p) return false;
  const now = Date.now();
  if (now - p.emoteAt < 1000) return true;
  p.emoteAt = now;
  broadcast(sse("emote", { name: p.name, emote: name }));
  return true;
}
