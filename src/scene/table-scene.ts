// The 3D table: a studio corner in the zine's paper-and-ink tones, a round table
// with a record player, and one seated character per member. Decoration only.
//
// It is driven by the table's PUBLIC state alone (the same JSON the 2D page
// follows over SSE), so it cannot know a theme, a mole, a pick's owner or title
// before the reveal, or who has picked or voted: nobody animates differently
// because of a pick or a vote, and nothing here reads anything else.
import { Color, Entity, Quat, StandardMaterial, Vec3 } from "playcanvas";
import { type Avatar, defaultAvatar, OPTIONS } from "../lib/avatar.ts";
import { Character, Kit } from "./character.ts";
import { createEngine, type Engine } from "./engine.ts";

export type PublicState = {
  status: string;
  host: string;
  members: { name: string; avatar: Avatar }[];
  game?: {
    round: number;
    phase: "pick" | "listen" | "vote" | "reveal";
    nowPlaying: number | null;
    alive: string[];
    ghosts: string[];
    reveal?: { ejected: string | null; wasMole: boolean };
    winner?: "players" | "moles";
  };
};

export type TableScene = {
  update(state: PublicState): void;
  setPaused(paused: boolean): void;
  destroy(): void;
};

const MAX_SEATS = 10;
const GHOST_K = 1.25; // ghosts drift outward from their seat
const TABLE_TOP = 0.47;
const ROW_A = 1.5; // radius of the front row (nearest the table)
const ROW_B = 2.7; // radius of the raised back row
const RISER = 0.5;
const CHAIR_OUT = 0.3; // a mobility aid is pulled out from the table so the chair is seen

// One palette: a booth in the record shop after hours (plum walls, floorboards,
// lamp light), the same room as /shop. The page has no light theme any more.
const PALETTE = {
  shop: { paper: "#1b1420", wall: "#2a1f30", floor: "#6b4a33", ink: "#efe7d7", stool: "#2b2030", ambient: "#8a7480", sun: "#ffe2bf" },
};

type Seat = { x: number; y: number; z: number; yaw: number };

const linspace = (n: number, half: number) => (n === 1 ? [0] : Array.from({ length: n }, (_, i) => -half + (2 * half * i) / (n - 1)));
const at = (deg: number, r: number, y: number): Seat => {
  const a = (deg * Math.PI) / 180;
  return { x: r * Math.sin(a), y, z: -r * Math.cos(a), yaw: -deg };
};

// Seats for n people. Up to five share one arc round the back of the table; more
// than that go into two rows, the second raised and staggered so every face still
// shows. Mobility-aid users take the ends of the front row (seen side-on, pulled
// out from the table) so the chair is never hidden behind it.
export function seatsFor(n: number): { seats: Seat[]; ends: number[] } {
  const nA = n <= 5 ? n : Math.ceil(n / 2);
  const nB = n - nA;
  const hA = nA <= 1 ? 0 : nA === 2 ? 55 : nA === 3 ? 72 : 88;
  const rowA = linspace(nA, hA);
  const seats: Seat[] = rowA.map((d) => at(d, ROW_A, 0));
  const hB = nB <= 1 ? 0 : nB === 2 ? 36 : nB === 3 ? 54 : 66;
  const rowB = nB === nA - 1 && nA > 1 ? rowA.slice(0, -1).map((d, i) => (d + rowA[i + 1]) / 2) : linspace(nB, hB);
  for (const d of rowB) seats.push(at(d, ROW_B, RISER));
  // indices ordered from the ends of the front row inward
  const ends = rowA.map((_, i) => i).sort((i, j) => Math.abs(rowA[j]) - Math.abs(rowA[i]));
  return { seats, ends };
}

type Mood = "chill" | "hyped" | "sly" | "sleepy";
const MOOD: Record<Mood, { idle: number; every: [number, number]; flourish: string | null }> = {
  chill: { idle: 0.7, every: [0, 0], flourish: null },
  hyped: { idle: 1.25, every: [4, 8], flourish: "emote-yes" },
  sly: { idle: 0.9, every: [5, 10], flourish: "emote-no" },
  sleepy: { idle: 0.4, every: [0, 0], flourish: null },
};

type Person = {
  name: string;
  key: string; // avatar identity: a change rebuilds the figure
  look: Avatar;
  seat: number;
  x: number;
  z: number;
  y: number;
  yaw: number;
  chair: boolean;
  ch: Character | null;
  rig: Entity;
  stool: Entity | null;
  aid: Entity | null;
  born: number;
  ghost: boolean;
  clip: string;
  nextFlourish: number;
  flourishUntil: number;
  label: HTMLElement;
  lw: number;
  lh: number;
  gone: boolean;
};

export async function startTableScene(slot: HTMLElement, onFirstFrame: () => void): Promise<TableScene> {
  const canvas = document.createElement("canvas");
  canvas.className = "scene-canvas";
  canvas.setAttribute("aria-hidden", "true");
  slot.append(canvas);
  const labels = document.createElement("div");
  labels.className = "scene-labels";
  labels.setAttribute("aria-hidden", "true");
  slot.append(labels);

  const stamp = document.createElement("div");
  stamp.className = "scene-stamp";
  stamp.hidden = true;
  stamp.setAttribute("aria-hidden", "true");
  labels.append(stamp);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const engine = await createEngine(canvas);
  const { app } = engine;
  const kit = new Kit(engine);
  app.autoRender = true;
  const root = app.root;

  // ---- the studio ----
  const pal = PALETTE.shop;
  const paperMat = kit.flat(pal.floor);
  const wallMat = kit.flat(pal.wall);
  const mats = { floor: new StandardMaterial(), wall: new StandardMaterial(), wall2: new StandardMaterial(), stool: new StandardMaterial() };
  void paperMat;
  void wallMat;
  const setCol = (m: StandardMaterial, hex: string) => {
    m.diffuse = new Color().fromString(hex);
    m.gloss = 0.1;
    m.metalness = 0;
    m.update();
  };

  const stage = new Entity("stage");
  root.addChild(stage);
  // floor: a big flat disc and two walls forming a corner behind and left
  const floor = kit.prim("cylinder", mats.floor, [0, -0.025, 0], [16, 0.05, 16], [0, 0, 0], stage);
  kit.prim("box", mats.wall, [0, 2.2, -4.4], [16, 5, 0.2], [0, 0, 0], stage);
  kit.prim("box", mats.wall2, [-5.2, 2.2, 0], [0.2, 5, 14], [0, 0, 0], stage);
  void floor;
  // a rug: ink ring on the floor under the table
  const ink = kit.flat("#16161a");
  const pink = kit.flat("#ff4f8b", { emissive: 0.8 });
  const pinkMat = kit.flat("#f4b860", { emissive: 0.35 });
  const cream = kit.flat("#efe7d7");
  kit.prim("cylinder", ink, [0, 0.004, 0], [3.9, 0.008, 3.9], [0, 0, 0], stage);
  kit.prim("cylinder", pinkMat, [0, 0.008, 0], [3.7, 0.008, 3.7], [0, 0, 0], stage);
  kit.prim("cylinder", mats.floor, [0, 0.012, 0], [3.55, 0.008, 3.55], [0, 0, 0], stage);
  // the table
  const woodMat = kit.flat("#7a5333");
  kit.prim("cylinder", ink, [0, 0.22, 0], [0.22, 0.44, 0.22], [0, 0, 0], stage);
  kit.prim("cylinder", ink, [0, 0.02, 0], [0.7, 0.04, 0.7], [0, 0, 0], stage);
  kit.prim("cylinder", ink, [0, TABLE_TOP - 0.025, 0], [1.74, 0.07, 1.74], [0, 0, 0], stage);
  kit.prim("cylinder", woodMat, [0, TABLE_TOP + 0.015, 0], [1.66, 0.04, 1.66], [0, 0, 0], stage);
  // the record player
  const deck = new Entity("deck");
  deck.setLocalPosition(0, TABLE_TOP + 0.035, 0);
  stage.addChild(deck);
  kit.prim("box", ink, [0, 0.05, 0], [0.78, 0.1, 0.62], [0, 0, 0], deck);
  const platter = new Entity("platter");
  platter.setLocalPosition(-0.06, 0.11, 0);
  deck.addChild(platter);
  kit.prim("cylinder", kit.flat("#2b2a33"), [0, 0, 0], [0.5, 0.025, 0.5], [0, 0, 0], platter);
  kit.prim("cylinder", pinkMat, [0, 0.016, 0], [0.17, 0.01, 0.17], [0, 0, 0], platter);
  kit.prim("box", cream, [0.15, 0.02, 0], [0.05, 0.012, 0.012], [0, 0, 0], platter);
  const arm = new Entity("arm");
  arm.setLocalPosition(0.3, 0.12, -0.2);
  deck.addChild(arm);
  kit.prim("box", cream, [-0.12, 0, 0.14], [0.03, 0.025, 0.34], [0, 14, 0], arm);
  kit.prim("sphere", cream, [0, 0, 0], [0.07, 0.05, 0.07], [0, 0, 0], arm);
  // the pink accent: a neon ring on the back wall
  const sign = new Entity("sign");
  sign.setLocalPosition(1.9, 1.35, -4.05)
  sign.setLocalScale(0.72, 0.72, 0.72);
  stage.addChild(sign);
  kit.prim("torus", pink, [0, 0, 0], [0.9, 0.09, 0.9], [90, 0, 0], sign);
  kit.prim("cylinder", pink, [0, 0, 0], [0.34, 0.06, 0.34], [90, 0, 0], sign);
  // a speaker stack against the wall
  kit.prim("box", ink, [-3.1, 0.6, -3.5], [0.9, 1.2, 0.7], [0, 12, 0], stage);
  kit.prim("cylinder", cream, [-3.1 + 0.1, 0.85, -3.14], [0.5, 0.04, 0.5], [90, 12, 0], stage);
  kit.prim("cylinder", cream, [-3.1 + 0.1, 0.38, -3.14], [0.36, 0.04, 0.36], [90, 12, 0], stage);

  // light: warm key from the front-left, soft ambient, a pink kick from the right
  const key = new Entity("key");
  key.addComponent("light", { type: "directional", color: new Color().fromString(pal.sun), intensity: 1.15 });
  key.setLocalEulerAngles(48, -28, 0);
  root.addChild(key);
  const kick = new Entity("kick");
  kick.addComponent("light", { type: "omni", color: new Color().fromString("#ff5c8a"), intensity: 1.6, range: 6 });
  kick.setLocalPosition(2.6, 2.3, -2.2);
  root.addChild(kick);
  app.scene.ambientLight = new Color().fromString(pal.ambient);

  const cam = new Entity("camera");
  cam.addComponent("camera", { fov: 52, horizontalFov: true, nearClip: 0.5, farClip: 30, clearColor: new Color().fromString(pal.paper) });
  const HOME_POS = new Vec3(0.5, 3.4, 4.9);
  const HOME_AT = new Vec3(0, 0.55, -0.7);
  cam.setLocalPosition(HOME_POS);
  cam.lookAt(HOME_AT);
  root.addChild(cam);
  // The reveal spotlight: a cone from above, off until a reveal names someone.
  const spot = new Entity("spot");
  spot.addComponent("light", { type: "spot", color: new Color().fromString("#fff6e0"), intensity: 0, range: 9, innerConeAngle: 18, outerConeAngle: 34 });
  root.addChild(spot);

  const applyTheme = () => {
    setCol(mats.floor, pal.floor);
    setCol(mats.wall, pal.wall);
    setCol(mats.wall2, pal.wall);
    setCol(mats.stool, pal.stool);
    cam.camera!.clearColor = new Color().fromString(pal.paper);
    key.light!.color = new Color().fromString(pal.sun);
    app.scene.ambientLight = new Color().fromString(pal.ambient);
  };
  applyTheme();

  // ---- people ----
  const people = new Map<string, Person>();
  let state: PublicState | null = null;
  let now = 0;
  let spin = false;
  let nod = false;
  let reveal: { name: string | null; wasMole: boolean } | null = null;
  let over: "players" | "moles" | null = null;
  const rng = (a: number, b: number) => a + Math.random() * (b - a);

  // Everyone's seat is recomputed from the member list: aid users take the ends
  // of the front row, the rest fill in order. Figures glide to their new seat.
  function assign(list: { name: string; chair: boolean }[]) {
    const { seats, ends } = seatsFor(list.length);
    const free = new Set(seats.keys());
    const slotOf = new Map<string, number>();
    let e = 0;
    for (const m of list) {
      if (m.chair && e < ends.length) {
        const k = ends[e++];
        slotOf.set(m.name, k);
        free.delete(k);
      }
    }
    const rest = [...free].sort((i, j) => i - j);
    for (const m of list) if (!slotOf.has(m.name)) slotOf.set(m.name, rest.shift()!);
    for (const [name, k] of slotOf) {
      const p = people.get(name);
      if (p) {
        p.seat = k;
        p.chair = list.find((m) => m.name === name)!.chair;
        seatTarget(p, seats[k]);
      }
    }
  }
  const targets = new Map<Person, { x: number; y: number; z: number; yaw: number }>();
  function seatTarget(p: Person, s: Seat) {
    let r = p.ghost ? GHOST_K : 1;
    if (p.chair && !p.ghost) r *= 1 + CHAIR_OUT / Math.hypot(s.x, s.z);
    targets.set(p, { x: s.x * r, y: s.y, z: s.z * r, yaw: s.yaw });
  }
  function place(p: Person) {
    const t = targets.get(p);
    if (!t) return;
    p.x = t.x;
    p.y = t.y;
    p.z = t.z;
    p.yaw = t.yaw;
    p.rig.setLocalPosition(p.x, p.y, p.z);
    p.rig.setLocalEulerAngles(0, p.yaw, 0);
  }

  async function build(p: Person) {
    p.ch?.destroy();
    p.aid?.destroy();
    p.stool?.destroy();
    p.ch = null;
    p.aid = null;
    p.stool = null;
    try {
      const ch = await Character.create(kit, p.look, { seated: true });
      if (p.gone) return ch.destroy();
      p.ch = ch;
      const chair = ch.wheelchair;
      if (!chair) {
        p.stool = kit.prim("cylinder", mats.stool, [0, 0.11, 0.0], [0.42, 0.22, 0.42], [0, 0, 0], p.rig);
      }
      ch.root.setLocalPosition(0, chair ? 0.2 : 0.26, chair ? 0.02 : -0.04);
      p.rig.addChild(ch.root);
      const aid = await ch.aid(kit);
      if (p.gone) return;
      if (aid) {
        p.aid = aid;
        if (chair) aid.setLocalPosition(0, 0, 0);
        else aid.setLocalPosition(0.36, 0, 0.18);
        if (!chair) aid.setLocalEulerAngles(0, 0, 14);
        p.rig.addChild(aid);
      }
      ch.ghost(p.ghost);
      p.clip = "";
    } catch {
      /* one bad figure never breaks the scene: it just isn't drawn */
    }
  }

  function join(name: string, look: Avatar, ghost: boolean) {
    const seat = 0;
    const label = document.createElement("span");
    label.className = "scene-label";
    labels.append(label);
    const p: Person = {
      name, key: JSON.stringify(look), look, seat, x: 0, y: 0, z: 0, yaw: 0, chair: look.aid === "wheelchair" || look.aid === "power-chair", ch: null, rig: new Entity(`seat-${seat}`), stool: null, aid: null,
      born: now, ghost, clip: "", nextFlourish: now + rng(2, 6), flourishUntil: 0, label, lw: 60, lh: 20, gone: false,
    };
    root.addChild(p.rig);
    people.set(name, p);
    fresh.add(p);
    void build(p);
  }

  const fresh = new Set<Person>();
  function leave(p: Person) {
    p.gone = true;
    targets.delete(p);
    fresh.delete(p);
    p.ch?.destroy();
    p.rig.destroy();
    p.label.remove();
    people.delete(p.name);
  }

  function update(next: PublicState) {
    state = next;
    const g = next.game;
    const live = next.status === "playing" || !!g?.winner;
    const ghosts = new Set(live ? (g?.ghosts ?? []) : []);
    const names = new Set(next.members.map((m) => m.name));
    for (const p of [...people.values()]) if (!names.has(p.name)) leave(p);
    const shown = next.members.slice(0, MAX_SEATS);
    for (const m of shown) {
      const look = m.avatar && OPTIONS.character.includes(m.avatar.character) ? m.avatar : defaultAvatar(m.name);
      const ghost = ghosts.has(m.name);
      const p = people.get(m.name);
      if (!p) {
        join(m.name, look, ghost);
        continue;
      }
      const k = JSON.stringify(look);
      if (k !== p.key) {
        p.key = k;
        p.look = look;
        void build(p);
      }
      if (ghost !== p.ghost) {
        p.ghost = ghost;
        p.ch?.ghost(ghost);
      }
    }
    assign(shown.filter((m) => people.has(m.name)).map((m) => {
      const a = people.get(m.name)!.look.aid;
      return { name: m.name, chair: a === "wheelchair" || a === "power-chair" };
    }));
    for (const p of fresh) {
      place(p);
      fresh.delete(p);
    }
    const nShown = people.size;
    labels.dataset.density = nShown > 8 ? "3" : nShown > 5 ? "2" : "1";
    const phase = g?.phase;
    spin = next.status === "playing" && !g?.winner && (phase === "listen" || phase === "vote") && g?.nowPlaying != null;
    nod = spin && phase === "listen";
    const prevReveal = reveal;
    reveal = g?.reveal && phase === "reveal" ? { name: g.reveal.ejected, wasMole: g.reveal.wasMole } : null;
    void prevReveal;
    stamp.hidden = true;
    over = g?.winner ?? null;
    for (const p of people.values()) {
      const tag = p.label;
      tag.replaceChildren(document.createTextNode(p.name));
      if (p.name === next.host) {
        const h = document.createElement("b");
        h.textContent = "HOST";
        tag.append(h);
      }
      tag.classList.toggle("ghost", p.ghost);
    }
  }

  // What this person does right now, from public state only.
  function clipFor(p: Person): string {
    const g = state?.game;
    if (!g) return "idle";
    // the ejected person's fate is public once the reveal is
    if (reveal?.name === p.name && g.phase === "reveal") return reveal.wasMole ? "die" : "emote-no";
    if (over) {
      if (p.ghost && reveal?.name !== p.name) return "idle";
      return over === "players" ? "emote-yes" : "emote-no";
    }
    if (p.ghost) return "idle";
    switch (g.phase) {
      case "pick":
        return "interact-right";
      case "reveal":
        if (!reveal || reveal.name === null) return "idle";
        return reveal.wasMole ? "emote-yes" : "emote-no";
      default:
        return "idle";
    }
  }

  const turn = new Map<Person, number>();
  let focus: Person | null = null;
  let amb = 1;
  let push = 0;
  const camPos = new Vec3();
  const camAt = new Vec3();
  const q = new Quat();
  const headQ = new Quat();
  let last = 0;
  app.on("update", (dt: number) => {
    now += dt;
    if (spin) platter.rotateLocal(0, -220 * dt, 0);
    arm.setLocalEulerAngles(0, spin ? -22 : 8, 0);
    for (const p of people.values()) {
      const ch = p.ch;
      // pop in: a quick overshoot scale
      const t = Math.min(1, (now - p.born) / 0.5);
      const sc = t < 1 ? 1 + Math.sin(t * Math.PI) * 0.18 - (1 - t) * (1 - t) * 1.0 : 1;
      p.rig.setLocalScale(sc, sc, sc);
      const tg = targets.get(p);
      if (tg) {
        const k = 1 - Math.exp(-dt * 6);
        p.x += (tg.x - p.x) * k;
        p.y += (tg.y - p.y) * k;
        p.z += (tg.z - p.z) * k;
        p.yaw = tg.yaw;
        p.rig.setLocalPosition(p.x, p.y, p.z);
      }
      // at the reveal everyone else turns to look at the ejected person
      let want = p.yaw;
      if (focus && focus !== p) {
        const dx = focus.x - p.x;
        const dz = focus.z - p.z;
        const to = (Math.atan2(dx, dz) * 180) / Math.PI;
        const d = ((((to - p.yaw) % 360) + 540) % 360) - 180;
        want = p.yaw + Math.max(-70, Math.min(70, d)) * 0.8;
      }
      turn.set(p, (turn.get(p) ?? p.yaw) + (((((want - (turn.get(p) ?? p.yaw)) % 360) + 540) % 360) - 180) * (1 - Math.exp(-dt * 5)));
      p.rig.setLocalEulerAngles(0, turn.get(p)!, 0);
      if (!ch) continue;
      let clip = clipFor(p);
      const mood = MOOD[(p.look.mood as Mood) in MOOD ? (p.look.mood as Mood) : "chill"];
      if (clip === "idle" && mood.flourish && !nod) {
        if (now > p.nextFlourish) {
          p.flourishUntil = now + 0.8;
          p.nextFlourish = now + rng(mood.every[0], mood.every[1]);
        }
        if (now < p.flourishUntil) clip = mood.flourish;
      }
      const speed = clip === "idle" ? mood.idle : 1;
      if (clip !== p.clip) {
        p.clip = clip;
        ch.play(clip);
      }
      ch.setSpeed(speed);
      if (nod) {
        const wob = Math.sin(now * 5.2 + p.seat * 0.9) * 7 + 4;
        headQ.setFromEulerAngles(wob, 0, 0);
        q.copy(ch.head.getLocalRotation());
        ch.head.setLocalRotation(q.mul(headQ));
      }
    }
    // the reveal: dim the room, spotlight and push in toward the ejected person
    focus = reveal?.name ? (people.get(reveal.name) ?? null) : null;
    const on = focus ? 1 : 0;
    push += (on - push) * (1 - Math.exp(-dt * (calm ? 30 : 2.6)));
    amb += ((focus ? 0.38 : 1) - amb) * (1 - Math.exp(-dt * 3));
    app.scene.ambientLight = new Color().fromString(pal.ambient).mulScalar(amb);
    key.light!.intensity = 1.15 * (0.35 + 0.65 * amb);
    kick.light!.intensity = 1.6 * amb;
    spot.light!.intensity = push * 5;
    camPos.copy(HOME_POS);
    camAt.copy(HOME_AT);
    if (focus && push > 0.001) {
      const fp = new Vec3(focus.x, focus.y + 0.6, focus.z);
      const dir = new Vec3(HOME_POS.x - fp.x, 0, HOME_POS.z - fp.z).normalize();
      const goal = new Vec3(fp.x + dir.x * 3.2, fp.y + 1.2, fp.z + dir.z * 3.2);
      camPos.lerp(HOME_POS, goal, push * 0.9);
      camAt.lerp(HOME_AT, fp, push);
      spot.setLocalPosition(fp.x, 4.2, fp.z + 0.8);
      spot.lookAt(new Vec3(fp.x, 0.5, fp.z));
    }
    cam.setLocalPosition(camPos);
    cam.lookAt(camAt);

    // labels follow the heads, are kept inside the stage and nudged apart
    const rect = canvas.getBoundingClientRect();
    last = rect.width;
    const W = rect.width;
    const H = rect.height;
    const boxes: { p: Person; x: number; y: number }[] = [];
    for (const p of people.values()) {
      const ch = p.ch;
      if (!ch) {
        p.label.style.visibility = "hidden";
        continue;
      }
      const wp = ch.head.getPosition();
      const sp = cam.camera!.worldToScreen(new Vec3(wp.x, wp.y + 0.5, wp.z));
      if (sp.z <= 0) {
        p.label.style.visibility = "hidden";
        continue;
      }
      if (!p.lw) {
        p.lw = p.label.offsetWidth;
        p.lh = p.label.offsetHeight;
      }
      boxes.push({ p, x: sp.x, y: sp.y });
    }
    boxes.sort((a, b) => a.y - b.y);
    const placed: { l: number; t: number; w: number; h: number }[] = [];
    for (const b of boxes) {
      const w = b.p.label.offsetWidth || b.p.lw;
      const h = b.p.label.offsetHeight || b.p.lh;
      b.p.lw = w;
      b.p.lh = h;
      let l = Math.max(2, Math.min(W - w - 2, b.x - w / 2));
      let t = Math.max(2, Math.min(H - h - 2, b.y - h));
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((o) => l < o.l + o.w + 2 && l + w + 2 > o.l && t < o.t + o.h + 2 && t + h + 2 > o.t);
        if (!hit) break;
        // slide sideways if there is room, otherwise stack above
        const right = hit.l + hit.w + 3;
        const left = hit.l - w - 3;
        if (right + w <= W - 2 && Math.abs(right - l) <= Math.abs(l - left)) l = right;
        else if (left >= 2) l = left;
        else t = Math.max(2, hit.t - h - 2);
      }
      placed.push({ l, t, w, h });
      b.p.label.style.visibility = "visible";
      b.p.label.style.transform = `translate(${l.toFixed(1)}px, ${t.toFixed(1)}px)`;
    }
    // the stamp over the ejected person: public reveal data only
    if (focus && reveal && push > 0.35) {
      const fh = focus.ch?.head.getPosition();
      if (fh) {
        const sp = cam.camera!.worldToScreen(new Vec3(fh.x, fh.y + 0.1, fh.z));
        stamp.textContent = reveal.wasMole ? "MOLE" : "NOT THE MOLE";
        stamp.classList.toggle("mole", reveal.wasMole);
        stamp.hidden = false;
        const w = stamp.offsetWidth;
        const h = stamp.offsetHeight;
        const l = Math.max(2, Math.min(W - w - 2, sp.x - w / 2));
        const t = Math.max(2, Math.min(H - h - 2, sp.y - h * 0.5));
        stamp.style.transform = `translate(${l.toFixed(1)}px, ${t.toFixed(1)}px) rotate(-6deg)`;
      }
    } else {
      stamp.hidden = true;
    }
  });

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
  void last;

  let paused = false;
  return {
    update,
    setPaused(v: boolean) {
      if (v === paused) return;
      paused = v;
      if (v) {
        engine.app.autoRender = false;
        cancelFrame(engine);
      } else {
        engine.app.autoRender = true;
        engine.app.requestAnimationFrame();
      }
    },
    destroy() {
      ro.disconnect();
      cancelFrame(engine);
      for (const p of [...people.values()]) leave(p);
      engine.destroy();
      canvas.remove();
      labels.remove();
    },
  };
}

function cancelFrame(engine: Engine) {
  const id = engine.app.frameRequestId;
  if (id) {
    cancelAnimationFrame(id);
    engine.app.frameRequestId = undefined;
  }
}
