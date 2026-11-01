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
import { createSfx } from "../audio/sfx.ts";

export type PublicState = {
  status: string;
  host: string;
  members: { name: string; avatar: Avatar }[];
  game?: {
    round: number;
    phase: "pick" | "listen" | "vote" | "steal" | "reveal";
    nowPlaying: number | null;
    alive: string[];
    ghosts: string[];
    deadline?: number | null;
    format?: string;
    cards?: { order: number; picker: string; lender?: string }[];
    // Vote: a count per alive player (never who voted); skip has no chip.
    tally?: { name: string; votes: number }[];
    // Steal: who the room voted out.
    accused?: string;
    reveal?: { ejected: string | null; wasMole: boolean; accused?: string | null; stole?: boolean; points?: { name: string; points: number }[] };
    winner?: string;
    winners?: string[];
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
  chip: HTMLElement;
  chipN: number;
  lit: boolean;
  lx: number;
  ly: number;
  rx: number;
  rz: number;
  dy: number;
  crown: Entity | null;
  lw: number;
  lh: number;
  gone: boolean;
};

export async function startTableScene(slot: HTMLElement, onFirstFrame: () => void): Promise<TableScene> {
  const canvas = document.createElement("canvas");
  canvas.className = "scene-canvas";
  canvas.setAttribute("aria-hidden", "true");
  slot.append(canvas);
  const sfx = createSfx();
  const unlock = () => sfx.unlock();
  addEventListener("pointerdown", unlock, true);
  addEventListener("keydown", unlock, true);
  let paused = false;
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

  // The lamp: a warm cone that lands on whoever's card is playing, and on a winner.
  const lamp = new Entity("lamp");
  lamp.addComponent("light", { type: "spot", color: new Color().fromString("#ffc873"), intensity: 0, range: 9, innerConeAngle: 14, outerConeAngle: 30 });
  root.addChild(lamp);
  const crownMat = kit.flat("#f4b860", { emissive: 0.5 });

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
  let over: "players" | "moles" | "points" | null = null; // "none" (abandoned) is no ending to act out
  let winners = new Set<string>();
  let lastPhase: string | undefined;
  let lastPlay = "";
  let playName: string | null = null;
  let stealWho: string | null = null;
  let stealTick = -1;
  let outcome: { name: string; win: boolean; t0: number } | null = null;
  let lastPoints = "";
  const leans = new Map<string, { to: string; until: number }>();
  const floaters: { el: HTMLElement; name: string; t0: number }[] = [];
  const CHIP_CSS = "position:absolute;left:0;top:0;min-width:1.15rem;padding:0 0.35rem;border-radius:999px;background:var(--lamp,#f4b860);color:var(--ink,#1b1420);font:700 0.7rem/1.3 var(--ui,sans-serif);text-align:center;will-change:transform;visibility:hidden;box-shadow:0 1px 4px rgba(0,0,0,.5)";
  const FLOAT_CSS = "position:absolute;left:0;top:0;font:400 1.1rem/1 var(--sign,Impact,sans-serif);color:var(--lamp,#f4b860);text-shadow:0 1px 0 #1b1420,0 0 6px #1b1420;will-change:transform,opacity;visibility:hidden";
  const playSound = (fn: () => void) => {
    if (paused) return;
    try { sfx.setEnabled(localStorage.getItem("mole:radio") !== "off"); } catch { /* no storage: on */ }
    fn();
  };
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
    const chip = document.createElement("span");
    chip.style.cssText = CHIP_CSS;
    chip.hidden = true;
    labels.append(chip);
    const p: Person = {
      name, key: JSON.stringify(look), look, seat, x: 0, y: 0, z: 0, yaw: 0, chair: look.aid === "wheelchair" || look.aid === "power-chair", ch: null, rig: new Entity(`seat-${seat}`), stool: null, aid: null,
      born: now, ghost, clip: "", nextFlourish: now + rng(2, 6), flourishUntil: 0, label, chip, chipN: 0, lit: false, lx: 0, ly: 0, rx: 0, rz: 0, dy: 0, crown: null, lw: 60, lh: 20, gone: false,
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
    p.chip.remove();
    leans.delete(p.name);
    people.delete(p.name);
  }

  function update(next: PublicState) {
    state = next;
    const g = next.game;
    const live = next.status === "playing" || (!!g?.winner && g.winner !== "none");
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
    reveal = g?.reveal && phase === "reveal" ? { name: g.reveal.ejected, wasMole: g.reveal.wasMole } : null;
    stamp.hidden = true;
    over = g?.winner === "players" || g?.winner === "moles" || g?.winner === "points" ? g.winner : null;
    winners = new Set(over === "points" ? (g?.winners ?? []) : []);
    // moments, from public fields only
    const live2 = next.status === "playing" || !!g?.winner;
    const ph = live2 ? phase : undefined;
    if (ph === "steal" && lastPhase !== "steal") {
      stealWho = g?.accused ?? null;
      stealTick = -1;
      if (lastPhase !== undefined) playSound(() => sfx.stealSting());
    } else if (lastPhase === "steal" && ph !== "steal" && g?.reveal && stealWho) {
      outcome = { name: stealWho, win: !!g.reveal.stole, t0: now };
      playSound(() => (g.reveal!.stole ? sfx.stealWin() : sfx.stealMiss()));
      stealWho = null;
    }
    lastPhase = ph;
    const card = ph === "listen" && !g?.winner && g?.nowPlaying != null ? g.cards?.find((c) => c.order === g.nowPlaying) : undefined;
    playName = card?.picker ?? null;
    const pk = card ? `${g!.round}:${card.order}` : "";
    if (pk && pk !== lastPlay && card?.lender) {
      // a borrowed card starts: the two lean toward each other for a moment
      leans.set(card.picker, { to: card.lender, until: now + 2.6 });
      leans.set(card.lender, { to: card.picker, until: now + 2.2 });
    }
    lastPlay = pk;
    // vote chips: the public tally only, counts, popping when one changes
    const tally = new Map<string, number>();
    if (ph === "vote" && !g?.winner) for (const t of g?.tally ?? []) tally.set(t.name, t.votes);
    for (const p of people.values()) {
      const n = tally.get(p.name) ?? 0;
      if (n !== p.chipN) {
        p.chip.textContent = String(n);
        p.chip.hidden = n === 0;
        if (n > 0) p.chip.animate([{ scale: "0.4" }, { scale: "1.35" }, { scale: "1" }], { duration: 320, easing: "ease-out" });
        p.chipN = n;
      }
    }
    // Four rounds: +N over heads once, from the reveal's points
    const pts = ph === "reveal" ? (g?.reveal?.points ?? []).filter((r) => r.points > 0) : [];
    const ptsKey = pts.length && g ? `${g.round}:${pts.map((r) => r.name + r.points).join(",")}` : "";
    if (ptsKey !== lastPoints) {
      lastPoints = ptsKey;
      for (const f of floaters.splice(0)) f.el.remove();
      for (const r of pts) {
        const el = document.createElement("span");
        el.style.cssText = FLOAT_CSS;
        el.textContent = `+${r.points}`;
        labels.append(el);
        floaters.push({ el, name: r.name, t0: now });
      }
    }
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
    if (outcome && outcome.name === p.name && now - outcome.t0 < 3.6) return outcome.win ? "emote-yes" : "idle";
    if (over === "points") return winners.has(p.name) ? "emote-yes" : "idle";
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
  let stealing = false;
  let outcomeOn = false;
  let lampI = 0;
  const lampAt = new Vec3();
  const lampPos = new Vec3();
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
      const ln = leans.get(p.name);
      const leanP = ln && now < ln.until ? (people.get(ln.to) ?? null) : null;
      const look = focus && focus !== p ? focus : leanP;
      if (look) {
        const dx = look.x - p.x;
        const dz = look.z - p.z;
        const to = (Math.atan2(dx, dz) * 180) / Math.PI;
        const d = ((((to - p.yaw) % 360) + 540) % 360) - 180;
        want = p.yaw + Math.max(-70, Math.min(70, d)) * 0.8;
      }
      turn.set(p, (turn.get(p) ?? p.yaw) + (((((want - (turn.get(p) ?? p.yaw)) % 360) + 540) % 360) - 180) * (1 - Math.exp(-dt * 5)));
      p.rig.setLocalEulerAngles(0, turn.get(p)!, 0);
      if (!ch) continue;
      // body language: a lean, a fidget, a hop for a right steal, a slump for a miss
      const nervous = stealing && focus === p && !outcomeOn;
      let rx = 0;
      let rz = 0;
      let dy = 0;
      if (leanP) rx = 8;
      if (nervous && focus === p) {
        rz = Math.sin(now * 11) * 2.4;
        rx = 3 + Math.sin(now * 17) * 1.6;
      }
      if (outcome && outcome.name === p.name && outcomeOn) {
        const age = now - outcome.t0;
        if (outcome.win) dy = Math.abs(Math.sin(age * 7)) * 0.32 * Math.max(0, 1 - age / 1.7);
        else rx = 24 * Math.min(1, age * 3) * (age > 3 ? Math.max(0, 1 - (age - 3) / 0.6) : 1);
      }
      const kk = 1 - Math.exp(-dt * 10);
      p.rx += (rx - p.rx) * kk;
      p.rz += (rz - p.rz) * kk;
      p.dy += (dy - p.dy) * kk;
      ch.root.setLocalEulerAngles(p.rx, 0, p.rz);
      ch.root.setLocalPosition(0, (ch.wheelchair ? 0.2 : 0.26) + p.dy, ch.wheelchair ? 0.02 : -0.04);
      // a crown for each winner at the end of a Four rounds game
      const crowned = winners.has(p.name);
      if (crowned && !p.crown) {
        const c = new Entity("crown");
        c.setLocalPosition(0, 0.6, -0.04);
        kit.prim("cylinder", crownMat, [0, 0, 0], [0.34, 0.1, 0.34], [0, 0, 0], c);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          kit.prim("cone", crownMat, [Math.sin(a) * 0.14, 0.1, Math.cos(a) * 0.14], [0.09, 0.14, 0.09], [0, 0, 0], c);
        }
        ch.head.addChild(c);
        p.crown = c;
      } else if (!crowned && p.crown) {
        p.crown.destroy();
        p.crown = null;
      }
      if (p.crown) p.crown.setLocalEulerAngles(0, now * 90, 0);
      let clip = clipFor(p);
      const mood = MOOD[(p.look.mood as Mood) in MOOD ? (p.look.mood as Mood) : "chill"];
      if (clip === "idle" && mood.flourish && !nod) {
        if (now > p.nextFlourish) {
          p.flourishUntil = now + 0.8;
          p.nextFlourish = now + rng(mood.every[0], mood.every[1]);
        }
        if (now < p.flourishUntil) clip = mood.flourish;
      }
      const speed = nervous ? 1.9 : clip === "idle" ? mood.idle : 1;
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
    const g2 = state?.game;
    stealing = !!g2 && g2.phase === "steal" && !g2.winner && !!g2.accused;
    outcomeOn = !!outcome && now - outcome.t0 < 3.6;
    const focusName = stealing ? g2!.accused! : (reveal?.name ?? (outcomeOn ? outcome!.name : null));
    focus = focusName ? (people.get(focusName) ?? null) : null;
    // the steal's clock: a light pulse on each second, and a tick
    let pulse = 0;
    if (stealing && g2!.deadline != null) {
      const rem = g2!.deadline - Date.now();
      if (rem > 0) {
        pulse = Math.pow((((rem % 1000) + 1000) % 1000) / 1000, 4);
        const sec = Math.ceil(rem / 1000);
        if (sec !== stealTick) {
          if (stealTick !== -1) playSound(() => sfx.tick());
          stealTick = sec;
        }
      }
    }
    // the lamp on whoever's card is playing (a winner at the end of Four rounds)
    const lampOn = playName ? people.get(playName) : winners.size === 1 ? people.get([...winners][0]) : undefined;
    if (lampOn) lampAt.set(lampOn.x, 0, lampOn.z);
    lampI += ((lampOn ? 8 : 0) - lampI) * (1 - Math.exp(-dt * 4));
    lampPos.x += (lampAt.x - lampPos.x) * (1 - Math.exp(-dt * 5));
    lampPos.z += (lampAt.z - lampPos.z) * (1 - Math.exp(-dt * 5));
    lamp.light!.intensity = lampI;
    lamp.setLocalPosition(lampPos.x, 3.8, lampPos.z + 0.8);
    lamp.lookAt(new Vec3(lampPos.x, 0.6, lampPos.z));
    const on = focus ? 1 : 0;
    push += (on - push) * (1 - Math.exp(-dt * (calm ? 30 : 2.6)));
    amb += ((focus ? (stealing ? 0.26 : 0.38) : lampOn ? 0.55 : 1) - amb) * (1 - Math.exp(-dt * 3));
    app.scene.ambientLight = new Color().fromString(pal.ambient).mulScalar(amb);
    key.light!.intensity = 1.15 * (0.35 + 0.65 * amb);
    kick.light!.intensity = 1.6 * amb + pulse * 1.2;
    spot.light!.intensity = push * (5 + pulse * 4);
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
      b.p.lx = l + w / 2;
      b.p.ly = t;
    }
    for (const p of people.values()) {
      const lit = playName === p.name;
      if (lit !== p.lit) {
        p.lit = lit;
        p.label.style.background = lit ? "var(--lamp)" : "";
        p.label.style.color = lit ? "var(--ink)" : "";
      }
      const shown = p.label.style.visibility === "visible";
      if (p.chipN > 0 && shown) {
        const cw = p.chip.offsetWidth || 20;
        p.chip.style.visibility = "visible";
        p.chip.style.transform = `translate(${Math.max(2, Math.min(W - cw - 2, p.lx - cw / 2)).toFixed(1)}px, ${Math.max(2, p.ly - 18).toFixed(1)}px)`;
      } else p.chip.style.visibility = "hidden";
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = now - f.t0;
      const p = people.get(f.name);
      if (age > 3.2 || !p || !p.ch) {
        if (age > 3.2) {
          f.el.remove();
          floaters.splice(i, 1);
        } else f.el.style.visibility = "hidden";
        continue;
      }
      const hp = p.ch.head.getPosition();
      const sp = cam.camera!.worldToScreen(new Vec3(hp.x, hp.y + 0.35, hp.z));
      const fw = f.el.offsetWidth || 30;
      f.el.style.visibility = "visible";
      f.el.style.opacity = String(Math.max(0, Math.min(1, (3.2 - age) / 1)));
      f.el.style.transform = `translate(${Math.max(2, Math.min(W - fw - 2, sp.x - fw / 2)).toFixed(1)}px, ${(sp.y - 14 - age * 16).toFixed(1)}px)`;
    }
    // the stamp over the ejected person: public reveal data only
    if (focus && reveal && reveal.name === focus.name && push > 0.35) {
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
      removeEventListener("pointerdown", unlock, true);
      removeEventListener("keydown", unlock, true);
      sfx.destroy();
      for (const f of floaters.splice(0)) f.el.remove();
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
