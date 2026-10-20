// The 3D shop floor: the room, the booths and everyone in the shop, walking
// about as their character. Decoration on top of the 2D shop page, never the
// shop itself: it is driven only by the shop stream's public state (names,
// avatars, positions, emotes, booths) and by hooks the page gives it.
//
// Your own figure moves here first (client prediction) and the page tells the
// server; everyone else is drawn a little behind the latest position the
// server sent and smoothed toward it.
import { Color, Entity, GAMMA_SRGB, TONEMAP_ACES, Vec3 } from "playcanvas";
import type { Avatar } from "../lib/avatar.ts";
import type { Booth } from "../lib/booths.ts";
import type { Sfx } from "../audio/sfx.ts";
import { Character, Kit } from "./character.ts";
import { createEngine } from "./engine.ts";
import { type BoothModel, buildRoom, JUKEBOX, type Room, SPOT_AT, WALK } from "./shop-room.ts";

export type Emote = "wave" | "nope" | "jump" | "dance";
export type Spot = { name: string; avatar: Avatar; x: number; z: number; yaw: number };
export type Target = { kind: "booth"; spot: number } | { kind: "jukebox" } | null;

export type ShopHooks = {
  // Your position, at most ~8 a second while moving and once more when you stop.
  sendMove(x: number, z: number, yaw: number): void;
  // Your own emote, so the page can tell the server (others get it from the stream).
  sendEmote(e: Emote): void;
  // Walked up to (or away from) a booth or the jukebox.
  onNear(t: Target): void;
  // The E key.
  onPrimary(): void;
  sfx: Sfx;
};

export type ShopScene = {
  setYou(name: string): void;
  reset(people: Spot[]): void;
  add(p: Spot): void;
  remove(name: string): void;
  moves(list: { name: string; x: number; z: number; yaw: number }[]): void;
  emote(name: string, e: Emote): void;
  setBooths(list: Booth[]): void;
  setStick(x: number, z: number): void;
  myEmote(e: Emote): void;
  walkToBooth(spot: number): void;
  walkToJukebox(): void;
  // Get up from a stool, beside the booth.
  standUp(): void;
  // Walk to a stool of the booth and sit; false if it could not.
  sitAt(spot: number): Promise<boolean>;
  setPaused(paused: boolean): void;
  debug(): unknown;
  destroy(): void;
};

const SPEED = 2.6; // m/s, the player
const RADIUS = 0.28;
const SEND_MS = 130;
const NEAR_BOOTH = 2.3;
const NEAR_BOOTH_OUT = 2.7;
const NEAR_JUKEBOX = 1.9;
const HOP_MS = 650;
const HOP_H = 0.55;
const CHAIR_Y = 0.2;
const BUBBLE: Record<Emote, string> = { wave: "Hi!", nope: "Nope.", jump: "", dance: "la la la" };

type Figure = {
  name: string;
  look: Avatar;
  chair: boolean;
  rig: Entity;
  ch: Character | null;
  aid: Entity | null;
  x: number; z: number; yaw: number;
  tx: number; tz: number; tyaw: number;
  moving: boolean;
  mode: "free" | "toSeat" | "seated";
  hopStart: number;
  emoteUntil: number;
  danceUntil: number;
  danceFlip: number;
  stepAt: number;
  label: HTMLElement;
  bubble: HTMLElement;
  bubbleUntil: number;
  gone: boolean;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const angleDiff = (to: number, from: number) => ((to - from + 540) % 360) - 180;

export async function startShopScene(slot: HTMLElement, hooks: ShopHooks, onFirstFrame: () => void): Promise<ShopScene> {
  const canvas = document.createElement("canvas");
  canvas.className = "shop-canvas";
  canvas.setAttribute("aria-hidden", "true");
  slot.prepend(canvas);
  const labels = document.createElement("div");
  labels.className = "shop-labels";
  labels.setAttribute("aria-hidden", "true");
  slot.insertBefore(labels, canvas.nextSibling);

  // The sign is painted on a canvas, so its fonts must be loaded first.
  await document.fonts.load("180px Bungee").catch(() => {});
  const engine = await createEngine(canvas);
  const { app } = engine;
  const kit = new Kit(engine);
  const { sfx } = hooks;
  app.autoRender = true;
  app.scene.ambientLight = new Color(0.42, 0.33, 0.4);

  const world = new Entity("shop");
  app.root.addChild(world);
  const room: Room = buildRoom(kit, world);

  // ---- camera ----
  const camE = new Entity("camera");
  camE.addComponent("camera", { clearColor: new Color().fromString("#1B1420"), fov: 40, nearClip: 0.1, farClip: 60, toneMapping: TONEMAP_ACES, gammaCorrection: GAMMA_SRGB });
  app.root.addChild(camE);
  const camPos = new Vec3(0, 6, 12);
  const camLook = new Vec3(0, 0.5, 4);
  camE.setPosition(camPos);
  camE.lookAt(camLook);
  const cam = camE.camera!;

  // ---- booths ----
  type Slotted = { spot: number; key: string; model: BoothModel; data: Booth; tag: HTMLElement };
  const slotted = new Map<number, Slotted>();
  let circles: { x: number; z: number; r: number }[] = [];
  const tagText = (b: Booth) => (b.private ? "Private" : `${b.code} · ${b.status === "playing" ? "playing" : "open"} · ${b.seated}/${b.max}`);

  function setBooths(list: Booth[]) {
    const next = new Map<number, Booth>();
    for (const b of list) if (b.spot >= 0 && b.spot < SPOT_AT.length) next.set(b.spot, b);
    for (const [spot, s] of slotted) {
      if (!next.has(spot)) {
        s.model.destroy();
        s.tag.remove();
        slotted.delete(spot);
      }
    }
    for (const [spot, b] of next) {
      const key = b.private ? "private" : "open";
      const have = slotted.get(spot);
      if (have && have.key === key) {
        have.data = b;
        continue;
      }
      have?.model.destroy();
      const tag = have?.tag ?? document.createElement("div");
      if (!have) labels.append(tag);
      tag.className = b.private ? "tag private" : "tag";
      slotted.set(spot, { spot, key, model: room.buildBooth(spot, { open: !b.private }), data: b, tag });
    }
    circles = [...slotted.values()].flatMap((s) => s.model.circles);
    for (const s of slotted.values()) {
      s.tag.className = s.data.private ? "tag private" : "tag";
      const t = tagText(s.data);
      if (s.tag.textContent !== t) s.tag.textContent = t;
    }
  }

  // ---- people ----
  const people = new Map<string, Figure>();
  let youName = "";
  let me: Figure | null = null;
  const now = () => performance.now();

  function place(f: Figure, t: number) {
    let y = 0;
    if (f.hopStart) {
      const k = (t - f.hopStart) / HOP_MS;
      if (k >= 1) f.hopStart = 0;
      else y = Math.sin(k * Math.PI) * HOP_H;
    }
    if (f.danceUntil > t) y += Math.abs(Math.sin(t * 0.012)) * 0.07;
    f.rig.setLocalPosition(f.x, y, f.z);
    f.rig.setLocalEulerAngles(0, f.yaw, 0);
  }

  async function build(f: Figure) {
    try {
      const ch = await Character.create(kit, f.look, { seated: false, shadows: true });
      if (f.gone) return ch.destroy();
      f.ch = ch;
      ch.setBase("idle", 0);
      ch.root.setLocalPosition(0, f.chair ? CHAIR_Y : 0, f.chair ? 0.02 : 0);
      f.rig.addChild(ch.root);
      const aid = await ch.aid(kit);
      if (f.gone) return;
      if (aid) {
        f.aid = aid;
        if (!f.chair) {
          aid.setLocalPosition(0.36, 0, 0.18);
          aid.setLocalEulerAngles(0, 0, 14);
        }
        f.rig.addChild(aid);
      }
      if (f.mode === "seated") sitPose(f);
    } catch {
      /* one bad figure never breaks the shop: it just isn't drawn */
    }
  }

  function add(p: Spot) {
    people.get(p.name) && remove(p.name);
    const label = document.createElement("div");
    label.className = "name";
    label.textContent = p.name;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.hidden = true;
    labels.append(label, bubble);
    const f: Figure = {
      name: p.name, look: p.avatar, chair: p.avatar.aid === "wheelchair" || p.avatar.aid === "power-chair",
      rig: new Entity(`person-${p.name}`), ch: null, aid: null,
      x: p.x, z: p.z, yaw: p.yaw, tx: p.x, tz: p.z, tyaw: p.yaw, moving: false, mode: "free",
      hopStart: 0, emoteUntil: 0, danceUntil: 0, danceFlip: 0, stepAt: 0, label, bubble, bubbleUntil: 0, gone: false,
    };
    app.root.addChild(f.rig);
    place(f, now());
    people.set(p.name, f);
    if (p.name === youName) {
      me = f;
      f.label.classList.add("you");
    }
    void build(f);
  }
  function remove(name: string) {
    const f = people.get(name);
    if (!f) return;
    f.gone = true;
    f.ch?.destroy();
    f.aid?.destroy();
    f.rig.destroy();
    f.label.remove();
    f.bubble.remove();
    people.delete(name);
    if (me === f) me = null;
  }

  const say = (f: Figure, text: string, ms = 2600) => {
    if (!text) return;
    f.bubble.textContent = text;
    f.bubble.hidden = false;
    f.bubbleUntil = now() + ms;
  };
  function hop(f: Figure) {
    if (f.mode !== "free" || f.chair || f.hopStart || !f.ch) return false;
    f.ch.setBase("jump", 0.05);
    f.ch.setOverlay(0);
    f.hopStart = now();
    f.emoteUntil = f.hopStart + HOP_MS;
    return true;
  }
  function play(f: Figure, e: Emote) {
    if (!f.ch) return;
    const t = now();
    if (e === "jump") {
      hop(f);
    } else if (e === "dance") {
      f.danceUntil = t + 3200;
      f.danceFlip = 0;
      f.emoteUntil = f.danceUntil;
    } else {
      f.ch.play(e === "wave" ? "emote-yes" : "emote-no", { blend: 0.1 });
      f.emoteUntil = t + 1600;
    }
    say(f, BUBBLE[e]);
  }

  // Others: a little behind the latest server position, eased toward it.
  function glide(f: Figure, dt: number, t: number) {
    const dx = f.tx - f.x, dz = f.tz - f.z, d = Math.hypot(dx, dz);
    if (d > 3.5) {
      f.x = f.tx;
      f.z = f.tz;
    } else if (d > 0.01) {
      const k = 1 - Math.exp(-dt * 10);
      f.x += dx * k;
      f.z += dz * k;
    }
    f.yaw += angleDiff(f.tyaw, f.yaw) * Math.min(1, dt * 10);
    // hysteresis so the legs don't flicker at the end of a step
    f.moving = f.moving ? d > 0.05 : d > 0.12;
    if (f.moving && me && f.ch && f.mode === "free") {
      f.stepAt -= dt;
      if (f.stepAt <= 0) {
        f.stepAt = 1 / 2.2;
        const dist = Math.hypot(f.x - me.x, f.z - me.z);
        if (dist < 4) sfx.footstep(0.45 * (1 - dist / 4));
      }
    }
    void t;
  }

  function sitPose(f: Figure) {
    if (!f.ch) return;
    f.ch.setBase("sit", 0.15);
    f.ch.setOverlay(1);
    f.ch.root.setLocalPosition(0, f.chair ? CHAIR_Y : 0.24, f.chair ? 0.02 : -0.04);
  }

  // ---- controls ----
  const keys = new Set<string>();
  let stick = { x: 0, z: 0 };
  let walkTo: { x: number; z: number } | null = null;
  let near: Target = null;
  let seating: { spot: number; stool: { x: number; z: number; yaw: number }; done: (ok: boolean) => void } | null = null;
  const textual = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const pressable = (t: EventTarget | null) => t instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(t.tagName);
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || textual(e.target)) return;
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      keys.add(k);
      if (k.startsWith("arrow") && !pressable(e.target)) e.preventDefault();
    } else if (k === "e" && !e.repeat) hooks.onPrimary();
    else if (k === " " && !pressable(e.target)) {
      e.preventDefault();
      if (!e.repeat) myEmote("jump");
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  addEventListener("keydown", onKey);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);

  function floorPoint(cx: number, cy: number) {
    const r = canvas.getBoundingClientRect();
    const a = new Vec3(), b = new Vec3();
    cam.screenToWorld(cx - r.left, cy - r.top, cam.nearClip, a);
    cam.screenToWorld(cx - r.left, cy - r.top, cam.farClip, b);
    if (Math.abs(b.y - a.y) < 1e-5) return null;
    const t = -a.y / (b.y - a.y);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  // Somewhere on the open side of a booth to stand at.
  function approach(cx: number, cz: number, r: number) {
    if (!me) return { x: cx, z: cz + r };
    let dx = me.x - cx, dz = me.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    if (dz < 0.35) {
      dx = dx < 0 ? -0.9 : 0.9;
      dz = 0.45;
    }
    const n = Math.hypot(dx, dz);
    return { x: cx + (dx / n) * r, z: cz + (dz / n) * r };
  }
  const onPointer = (e: PointerEvent) => {
    if (!me || me.mode !== "free" || e.button > 0) return;
    const p = floorPoint(e.clientX, e.clientY);
    if (!p) return;
    sfx.unlock();
    const booth = [...slotted.values()].find((s) => Math.hypot(p.x - s.model.x, p.z - s.model.z) < 1.9);
    if (booth) walkTo = approach(booth.model.x, booth.model.z, 2.1);
    else if (Math.hypot(p.x - JUKEBOX.x, p.z - JUKEBOX.z) < 1.3) walkTo = approach(JUKEBOX.x, JUKEBOX.z, 1.5);
    else walkTo = { x: clamp(p.x, WALK.minX, WALK.maxX), z: clamp(p.z, WALK.minZ, WALK.maxZ) };
  };
  canvas.addEventListener("pointerdown", onPointer);

  function myEmote(e: Emote) {
    if (!me || me.mode !== "free") return;
    if (e === "jump" && (me.chair || me.hopStart)) return;
    play(me, e);
    if (e === "jump") sfx.jump();
    else sfx.emote();
    hooks.sendEmote(e);
  }

  // ---- movement and collision ----
  function collide(f: Figure) {
    for (const c of circles) {
      const dx = f.x - c.x, dz = f.z - c.z, d = Math.hypot(dx, dz), min = c.r + RADIUS;
      if (d < min && d > 1e-4) {
        f.x = c.x + (dx / d) * min;
        f.z = c.z + (dz / d) * min;
      }
    }
    for (const b of room.boxes) {
      if (f.x > b.x0 - RADIUS && f.x < b.x1 + RADIUS && f.z > b.z0 - RADIUS && f.z < b.z1 + RADIUS) {
        const pen = [f.x - (b.x0 - RADIUS), b.x1 + RADIUS - f.x, f.z - (b.z0 - RADIUS), b.z1 + RADIUS - f.z];
        const i = pen.indexOf(Math.min(...pen));
        if (i === 0) f.x = b.x0 - RADIUS;
        else if (i === 1) f.x = b.x1 + RADIUS;
        else if (i === 2) f.z = b.z0 - RADIUS;
        else f.z = b.z1 + RADIUS;
      }
    }
    f.x = clamp(f.x, WALK.minX, WALK.maxX);
    f.z = clamp(f.z, WALK.minZ, WALK.maxZ);
  }
  function turnTo(f: Figure, dx: number, dz: number, dt: number) {
    const want = (Math.atan2(dx, dz) * 180) / Math.PI;
    f.yaw += angleDiff(want, f.yaw) * Math.min(1, dt * 12);
  }
  function stepToward(f: Figure, x: number, z: number, dt: number) {
    const dx = x - f.x, dz = z - f.z, d = Math.hypot(dx, dz);
    if (d < 0.06) return true;
    const s = Math.min(d, SPEED * dt);
    f.x += (dx / d) * s;
    f.z += (dz / d) * s;
    turnTo(f, dx, dz, dt);
    return false;
  }

  let lastSend = 0;
  let wasMoving = false;
  let resend = 0;
  let stillFor = 0;
  let echo: { x: number; z: number } | null = null;
  const send = (f: Figure) => hooks.sendMove(+f.x.toFixed(2), +f.z.toFixed(2), +f.yaw.toFixed(1));

  function driveMe(dt: number, t: number) {
    const f = me!;
    let moving = false;
    if (f.mode === "free") {
      let ix = 0, iz = 0;
      if (keys.has("w") || keys.has("arrowup")) iz -= 1;
      if (keys.has("s") || keys.has("arrowdown")) iz += 1;
      if (keys.has("a") || keys.has("arrowleft")) ix -= 1;
      if (keys.has("d") || keys.has("arrowright")) ix += 1;
      ix += stick.x;
      iz += stick.z;
      const m = Math.hypot(ix, iz);
      if (m > 0.15) {
        walkTo = null;
        const k = Math.min(1, m) / m;
        f.x += ix * k * SPEED * dt;
        f.z += iz * k * SPEED * dt;
        turnTo(f, ix, iz, dt);
        moving = true;
        sfx.unlock();
      } else if (walkTo) {
        const ox = f.x, oz = f.z;
        if (stepToward(f, walkTo.x, walkTo.z, dt)) walkTo = null;
        else moving = true;
        collide(f);
        if (walkTo && Math.hypot(f.x - ox, f.z - oz) < SPEED * dt * 0.2) {
          walkTo = null; // stuck on something
          moving = false;
        }
      }
      collide(f);
    } else if (f.mode === "toSeat" && seating) {
      moving = true;
      if (stepToward(f, seating.stool.x, seating.stool.z, dt)) {
        const s = seating;
        seating = null;
        f.mode = "seated";
        f.x = s.stool.x;
        f.z = s.stool.z;
        f.yaw = s.stool.yaw;
        sitPose(f);
        moving = false;
        sfx.sit();
        sfx.needle();
        send(f);
        s.done(true);
      }
    }
    f.moving = moving;
    if (f.ch && f.mode !== "seated") {
      if (!f.hopStart) f.ch.setBase(moving ? "walk" : "idle", 0.15);
      f.ch.setOverlay(moving || f.hopStart ? 0 : 1);
    }
    if (moving) {
      stillFor = 0;
      f.stepAt -= dt;
      if (f.stepAt <= 0 && !f.hopStart) {
        f.stepAt = 1 / 2.2;
        sfx.footstep(1);
      }
      if (t - lastSend >= SEND_MS) {
        lastSend = t;
        send(f);
      }
    } else {
      stillFor += dt;
      if (wasMoving) {
        lastSend = t;
        resend = t + 450;
        send(f);
      } else if (resend && t > resend) {
        resend = 0; // once more, in case the first was dropped by the 8 a second cap
        send(f);
      }
    }
    wasMoving = moving;
    // Reconcile only when standing still: while walking the echo is always behind.
    if (echo && !moving && stillFor > 0.8 && Math.hypot(echo.x - f.x, echo.z - f.z) > 0.75) {
      const k = 1 - Math.exp(-dt * 4);
      f.x += (echo.x - f.x) * k;
      f.z += (echo.z - f.z) * k;
    }
    if (f.emoteUntil && t > f.emoteUntil && !f.hopStart) {
      f.emoteUntil = 0;
      f.ch?.play("idle");
    }
  }

  function updateNear() {
    if (!me || me.mode !== "free") {
      if (near) hooks.onNear((near = null));
      return;
    }
    let best: Target = null;
    let bestD = Infinity;
    for (const s of slotted.values()) {
      const d = Math.hypot(me.x - s.model.x, me.z - s.model.z);
      const lim = near?.kind === "booth" && near.spot === s.spot ? NEAR_BOOTH_OUT : NEAR_BOOTH;
      if (d < lim && d < bestD) {
        best = { kind: "booth", spot: s.spot };
        bestD = d;
      }
    }
    const dj = Math.hypot(me.x - JUKEBOX.x, me.z - JUKEBOX.z);
    if (dj < NEAR_JUKEBOX && dj < bestD) best = { kind: "jukebox" };
    const same = (best === null && near === null) || (best && near && best.kind === near.kind && (best.kind === "jukebox" || (near.kind === "booth" && best.spot === near.spot)));
    if (!same) {
      near = best;
      hooks.onNear(best);
    }
  }

  // ---- the loop ----
  const tmp = new Vec3();
  const sp = new Vec3();
  app.on("update", (rawDt: number) => {
    const dt = Math.min(rawDt, 0.05);
    const t = now();
    for (const s of slotted.values()) if (s.data.status === "playing") s.model.platter.rotateLocal(0, -dt * 200, 0);

    if (me) driveMe(dt, t);
    for (const f of people.values()) {
      if (f !== me) {
        glide(f, dt, t);
        if (f.ch && f.mode === "free") {
          if (!f.hopStart) f.ch.setBase(f.moving ? "walk" : "idle", 0.2);
          f.ch.setOverlay(f.moving || f.hopStart ? 0 : 1);
        }
      }
      if (f.danceUntil > t && f.ch) {
        if (t > f.danceFlip) {
          f.danceFlip = t + 450;
          f.ch.play(Math.floor(t / 450) % 2 ? "emote-yes" : "emote-no", { blend: 0.1 });
        }
      } else if (f !== me && f.emoteUntil && t > f.emoteUntil && !f.hopStart) {
        f.emoteUntil = 0;
        f.ch?.play("idle");
      }
      place(f, t);
    }
    updateNear();

    // camera: follow from behind and above; settle over the booth when seated
    const portrait = innerHeight > innerWidth;
    const fov = portrait ? 58 : 40;
    if (cam.fov !== fov) cam.fov = fov;
    let tx = me?.x ?? 0.6, tz = me?.z ?? 4.2, seated = false;
    if (me?.mode === "seated" && seating === null) {
      const s = nearestBooth(me.x, me.z);
      if (s) {
        tx = s.model.x;
        tz = s.model.z;
        seated = true;
      }
    }
    const back = (seated ? 4.4 : 6.6) * (portrait ? 1.2 : 1), up = (seated ? 3.6 : 5.6) * (portrait ? 1.25 : 1);
    const k = 1 - Math.exp(-dt * 4);
    camPos.lerp(camPos, tmp.set(tx, up, tz + back), k);
    camLook.lerp(camLook, tmp.set(tx, 0.6, tz - (seated ? 0.2 : 0.6)), k);
    camE.setPosition(camPos);
    camE.lookAt(camLook);

    // labels over heads and booths
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const f of people.values()) {
      const lift = f.hopStart ? Math.sin(Math.min(1, (t - f.hopStart) / HOP_MS) * Math.PI) * HOP_H : 0;
      cam.worldToScreen(tmp.set(f.x, (f.mode === "seated" ? 1.25 : f.chair ? 1.45 : 1.32) + lift, f.z), sp);
      const vis = sp.z > 0 && sp.x > -80 && sp.x < w + 80 && sp.y > -40 && sp.y < h + 40;
      f.label.style.display = vis ? "" : "none";
      f.label.style.transform = `translate(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (!f.bubble.hidden) {
        if (t > f.bubbleUntil || !vis) f.bubble.hidden = t > f.bubbleUntil;
        f.bubble.style.display = vis ? "" : "none";
        f.bubble.style.transform = `translate(${sp.x.toFixed(1)}px, ${(sp.y - 18).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    for (const s of slotted.values()) {
      cam.worldToScreen(tmp.set(s.model.x, 2.05, s.model.z), sp);
      s.tag.style.display = sp.z > 0 ? "" : "none";
      s.tag.style.transform = `translate(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  });
  const nearestBooth = (x: number, z: number) => {
    let best: Slotted | null = null;
    let bd = Infinity;
    for (const s of slotted.values()) {
      const d = Math.hypot(x - s.model.x, z - s.model.z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  };

  // Sizing: the canvas fills the slot; resolution follows its CSS size.
  const fit = () => {
    const r = slot.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      app.graphicsDevice.resizeCanvas(r.width, r.height);
      app.graphicsDevice.updateClientRect();
    }
  };
  const ro = new ResizeObserver(fit);
  ro.observe(slot);
  fit();

  let first = true;
  app.on("frameend", () => {
    if (first) {
      first = false;
      onFirstFrame();
    }
  });
  app.start();

  let paused = false;
  const cancelFrame = () => {
    const id = app.frameRequestId;
    if (id) {
      cancelAnimationFrame(id);
      app.frameRequestId = undefined;
    }
  };

  return {
    setYou(name) {
      youName = name;
    },
    reset(list) {
      for (const n of [...people.keys()]) remove(n);
      for (const p of list) add(p);
      if (me) {
        camPos.set(me.x, 5.6, me.z + 6.6);
        camLook.set(me.x, 0.6, me.z - 0.6);
      }
    },
    add,
    remove,
    moves(list) {
      for (const m of list) {
        const f = people.get(m.name);
        if (!f) continue;
        if (f === me) {
          echo = { x: m.x, z: m.z };
          continue;
        }
        f.tx = m.x;
        f.tz = m.z;
        f.tyaw = m.yaw;
      }
    },
    emote(name, e) {
      const f = people.get(name);
      if (!f || f === me) return; // your own plays at once, from your keypress
      play(f, e);
      if (me) {
        const d = Math.hypot(f.x - me.x, f.z - me.z);
        if (d < 5) sfx.emote(0.5 * (1 - d / 5));
      }
    },
    setBooths,
    setStick(x, z) {
      stick = { x, z };
      if (x || z) walkTo = null;
    },
    myEmote,
    walkToBooth(spot) {
      const s = slotted.get(spot);
      if (s && me?.mode === "free") walkTo = approach(s.model.x, s.model.z, 2.1);
    },
    walkToJukebox() {
      if (me?.mode === "free") walkTo = approach(JUKEBOX.x, JUKEBOX.z, 1.5);
    },
    sitAt(spot) {
      const s = slotted.get(spot);
      if (!s || !me || me.mode !== "free" || !me.ch) return Promise.resolve(false);
      const f = me;
      // the nearest stool, so the walk never crosses the table
      let stool = s.model.stools[0];
      for (const c of s.model.stools) if (Math.hypot(c.x - f.x, c.z - f.z) < Math.hypot(stool.x - f.x, stool.z - f.z)) stool = c;
      return new Promise<boolean>((resolve) => {
        walkTo = null;
        f.mode = "toSeat";
        f.ch?.setBase("walk", 0.15);
        const timer = setTimeout(() => {
          if (seating) {
            seating = null;
            f.mode = "free";
            resolve(false);
          }
        }, 12000);
        seating = { spot, stool, done: (ok) => { clearTimeout(timer); resolve(ok); } };
      });
    },
    standUp() {
      const f = me;
      if (!f || f.mode !== "seated") return;
      const s = nearestBooth(f.x, f.z);
      if (s) {
        const dx = f.x - s.model.x, dz = f.z - s.model.z, d = Math.hypot(dx, dz) || 1;
        f.x = s.model.x + (dx / d) * 1.45;
        f.z = s.model.z + (dz / d) * 1.45;
        collide(f);
      }
      f.mode = "free";
      f.ch?.root.setLocalPosition(0, f.chair ? CHAIR_Y : 0, f.chair ? 0.02 : 0);
      f.ch?.setBase("idle", 0.15);
      sfx.stand();
      send(f);
    },
    setPaused(v) {
      if (v === paused) return;
      paused = v;
      if (v) {
        app.autoRender = false;
        cancelFrame();
        keys.clear();
      } else {
        app.autoRender = true;
        app.requestAnimationFrame();
      }
    },
    debug() {
      return {
        me: me && { x: me.x, z: me.z, yaw: me.yaw, mode: me.mode },
        people: [...people.values()].map((f) => ({ name: f.name, x: +f.x.toFixed(2), z: +f.z.toFixed(2), moving: f.moving })),
        tags: [...slotted.values()].map((s) => s.tag.textContent),
        near,
      };
    },
    destroy() {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKeyUp);
      removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onPointer);
      ro.disconnect();
      cancelFrame();
      for (const n of [...people.keys()]) remove(n);
      for (const s of slotted.values()) s.model.destroy();
      slotted.clear();
      room.destroy();
      engine.destroy();
      canvas.remove();
      labels.remove();
    },
  };
}
