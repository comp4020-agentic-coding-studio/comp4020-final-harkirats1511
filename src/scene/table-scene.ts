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
const SEAT_R = 1.45;
const GHOST_R = 2.25;
const ARC = 125; // degrees either side of straight back
// Fill order: spread out first, so three or four people don't clump.
const FILL = [2, 7, 4, 5, 3, 6, 1, 8, 0, 9];
const TABLE_TOP = 0.47;

const PALETTE = {
  light: { paper: "#f2efe6", wall: "#e6e1d3", floor: "#cfc8b6", ink: "#16161a", stool: "#16161a", ambient: "#b8b0a0", sun: "#fff1d6" },
  dark: { paper: "#17161b", wall: "#201f26", floor: "#2b2a33", ink: "#f2efe6", stool: "#3a3943", ambient: "#6a6678", sun: "#ffd9b0" },
};

type Seat = { angle: number; pos: Vec3; yaw: number };
const seats: Seat[] = Array.from({ length: MAX_SEATS }, (_, k) => {
  const angle = -ARC + (2 * ARC * k) / (MAX_SEATS - 1);
  const a = (angle * Math.PI) / 180;
  return { angle, pos: new Vec3(SEAT_R * Math.sin(a), 0, -SEAT_R * Math.cos(a)), yaw: -angle };
});

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

  const engine = await createEngine(canvas);
  const { app } = engine;
  const kit = new Kit(engine);
  app.autoRender = true;
  const root = app.root;

  // ---- the studio ----
  const dark = () => document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  let pal = PALETTE[dark() ? "dark" : "light"];
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
  const floor = kit.prim("cylinder", mats.floor, [0, -0.025, 0], [9, 0.05, 9], [0, 0, 0], stage);
  kit.prim("box", mats.wall, [0, 2.0, -4.2], [10, 4.4, 0.2], [0, 0, 0], stage);
  kit.prim("box", mats.wall2, [-4.6, 2.0, -0.4], [0.2, 4.4, 9], [0, 0, 0], stage);
  void floor;
  // a rug: ink ring on the floor under the table
  const ink = kit.flat("#16161a");
  const pink = kit.flat("#f0477e", { emissive: 0.5 });
  const pinkMat = kit.flat("#f0477e");
  const cream = kit.flat("#f2efe6");
  kit.prim("cylinder", ink, [0, 0.004, 0], [3.9, 0.008, 3.9], [0, 0, 0], stage);
  kit.prim("cylinder", pinkMat, [0, 0.008, 0], [3.7, 0.008, 3.7], [0, 0, 0], stage);
  kit.prim("cylinder", mats.floor, [0, 0.012, 0], [3.55, 0.008, 3.55], [0, 0, 0], stage);
  // the table
  const woodMat = kit.flat("#c98a4b");
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
  sign.setLocalPosition(1.7, 2.5, -4.05);
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
  cam.addComponent("camera", { fov: 46, horizontalFov: true, nearClip: 0.5, farClip: 30, clearColor: new Color().fromString(pal.paper) });
  const camTarget = new Vec3(0, 0.42, -0.1);
  cam.setLocalPosition(2.1, 3.1, 4.7);
  cam.lookAt(camTarget);
  root.addChild(cam);

  const applyTheme = () => {
    pal = PALETTE[dark() ? "dark" : "light"];
    setCol(mats.floor, pal.floor);
    setCol(mats.wall, pal.wall);
    setCol(mats.wall2, pal.wall);
    setCol(mats.stool, pal.stool);
    cam.camera!.clearColor = new Color().fromString(pal.paper);
    key.light!.color = new Color().fromString(pal.sun);
    app.scene.ambientLight = new Color().fromString(pal.ambient);
  };
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", applyTheme);

  // ---- people ----
  const people = new Map<string, Person>();
  let state: PublicState | null = null;
  let now = 0;
  let spin = false;
  let nod = false;
  let reveal: { name: string | null; wasMole: boolean } | null = null;
  let over: "players" | "moles" | null = null;
  const rng = (a: number, b: number) => a + Math.random() * (b - a);

  function freeSeat(): number {
    const used = new Set([...people.values()].map((p) => p.seat));
    for (const k of FILL) if (!used.has(k)) return k;
    return -1;
  }

  function place(p: Person) {
    const s = seats[p.seat];
    const r = p.ghost ? GHOST_R / SEAT_R : 1;
    p.rig.setLocalPosition(s.pos.x * r, 0, s.pos.z * r);
    p.rig.setLocalEulerAngles(0, s.yaw, 0);
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
    const seat = freeSeat();
    if (seat < 0) return;
    const label = document.createElement("span");
    label.className = "scene-label";
    labels.append(label);
    const p: Person = {
      name, key: JSON.stringify(look), look, seat, ch: null, rig: new Entity(`seat-${seat}`), stool: null, aid: null,
      born: now, ghost, clip: "", nextFlourish: now + rng(2, 6), flourishUntil: 0, label, gone: false,
    };
    root.addChild(p.rig);
    place(p);
    people.set(name, p);
    void build(p);
  }

  function leave(p: Person) {
    p.gone = true;
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
    for (const m of next.members.slice(0, MAX_SEATS)) {
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
        place(p);
        p.ch?.ghost(ghost);
      }
    }
    const phase = g?.phase;
    spin = next.status === "playing" && !g?.winner && (phase === "listen" || phase === "vote") && g?.nowPlaying != null;
    nod = spin && phase === "listen";
    reveal = g?.reveal && phase === "reveal" && !g.winner ? { name: g.reveal.ejected, wasMole: g.reveal.wasMole } : null;
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
    if (!g || state?.status !== "playing") {
      if (over && !p.ghost) return over === "players" ? "emote-yes" : "emote-no";
      return "idle";
    }
    if (p.ghost) return "idle";
    switch (g.phase) {
      case "pick":
        return "interact-right";
      case "reveal":
        if (!reveal || reveal.name === null) return "idle";
        if (p.name === reveal.name) return reveal.wasMole ? "die" : "emote-no";
        return reveal.wasMole ? "emote-yes" : "emote-no";
      default:
        return "idle";
    }
  }

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
    // labels follow the heads
    const rect = canvas.getBoundingClientRect();
    last = rect.width;
    for (const p of people.values()) {
      const ch = p.ch;
      if (!ch) {
        p.label.style.visibility = "hidden";
        continue;
      }
      const wp = ch.head.getPosition();
      const sp = cam.camera!.worldToScreen(new Vec3(wp.x, wp.y + 0.62, wp.z));
      const inView = sp.z > 0;
      p.label.style.visibility = inView ? "visible" : "hidden";
      p.label.style.transform = `translate(-50%, -100%) translate(${sp.x.toFixed(1)}px, ${sp.y.toFixed(1)}px)`;
    }
  });

  // Sizing: the canvas fills the slot; resolution follows its CSS size.
  const fit = () => {
    const r = slot.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) engine.app.resizeCanvas(r.width, r.height);
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
      themeObserver.disconnect();
      mq.removeEventListener("change", applyTheme);
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
