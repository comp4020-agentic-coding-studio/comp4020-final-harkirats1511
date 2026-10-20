// The record shop room: plum walls, floorboards, the neon sign, crates, the
// jukebox, the counter and the six booth spots. Ported from the approved
// mockup (docs/design/shop-floor-3d.html). Everything static is merged into one
// mesh per material, so the whole room is a few dozen draw calls.
import { Color, Entity, Mat4, Mesh, MeshInstance, Quat, StandardMaterial, Vec2, Vec3 } from "playcanvas";
import { ADDRESS_CLAMP_TO_EDGE, ADDRESS_REPEAT, FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR, PIXELFORMAT_SRGBA8, Texture } from "playcanvas";
import type { Kit, Prim } from "./character.ts";

// The server clamps to x -8..8, z -5.5..4.7; the room is a little larger so
// walls and the front wall sit outside what anyone can reach.
export const ROOM = { x0: -8, x1: 8, z0: -6, z1: 5 };
export const WALK = { minX: -7.72, maxX: 7.72, minZ: -5.5, maxZ: 4.7 };

const C = { wall: "#2a1f30", wallTrim: "#3a2a40", wood: "#7A5333", woodDark: "#4a3020", lamp: "#F4B860", neon: "#FF4F8B", sleeve: "#EFE7D7", ink: "#1B1420", stool: "#2b2030", rug: "#3a2434" };
const SLEEVES = ["#e94f37", "#f4b860", "#3f88c5", "#efe7d7", "#2a9d8f", "#ff4f8b", "#8f5bd6", "#1b1b1b", "#f6d743", "#d9734e", "#5c8a4f", "#c8b6e2"];
// i is rounded: the shelf heights feed fractions in, and an array has no index 13.5.
const sleeve = (i: number) => SLEEVES[(((Math.round(i) * 7 + 3) % SLEEVES.length) + SLEEVES.length) % SLEEVES.length];

export type Box = { x0: number; x1: number; z0: number; z1: number };
export type Circle = { x: number; z: number; r: number };
export type Stool = { x: number; z: number; yaw: number };

// Where the server's spots 0..5 stand: two rows of three in the open middle,
// leaving the crates (left wall), the jukebox and counter (right) and the
// walkway in front of the door clear. Row order fills the back row first.
export const SPOT_AT: [number, number][] = [
  [-4.0, -3.2], [4.0, -3.2], [0.0, -3.2],
  [-4.0, 1.2], [4.0, 1.2], [0.0, 1.2],
];
export const JUKEBOX = { x: 6.8, z: -5.4 };

export type BoothLook = { open: boolean };
export type BoothModel = {
  entity: Entity;
  platter: Entity;
  stools: Stool[];
  circles: Circle[];
  x: number;
  z: number;
  destroy(): void;
};

const rot = (a: [number, number, number]) => new Quat().setFromEulerAngles(a[0], a[1], a[2]);
const local = (pos: [number, number, number], scale: [number, number, number], r: [number, number, number], parent?: Mat4) => {
  const m = new Mat4().setTRS(new Vec3(pos[0], pos[1], pos[2]), rot(r), new Vec3(scale[0], scale[1], scale[2]));
  return parent ? new Mat4().mul2(parent, m) : m;
};

type Group = { pos: number[]; nrm: number[]; uv: number[]; idx: number[] };

// Collects primitives with a world matrix and bakes them into one mesh per material.
class Merge {
  private groups = new Map<StandardMaterial, Group>();
  private src = new Map<Prim, { p: number[]; n: number[]; t: number[]; i: number[] }>();
  readonly meshes: Mesh[] = [];
  constructor(private kit: Kit) {}

  private base(kind: Prim) {
    let s = this.src.get(kind);
    if (!s) {
      const m = this.kit.mesh(kind);
      s = { p: [], n: [], t: [], i: [] };
      m.getPositions(s.p);
      m.getNormals(s.n);
      m.getUvs(0, s.t);
      m.getIndices(s.i);
      this.src.set(kind, s);
    }
    return s;
  }

  // Adds one primitive and returns its world matrix so children can hang off it.
  add(kind: Prim, mat: StandardMaterial, pos: [number, number, number], scale: [number, number, number], r: [number, number, number] = [0, 0, 0], parent?: Mat4): Mat4 {
    const w = local(pos, scale, r, parent);
    const s = this.base(kind);
    let g = this.groups.get(mat);
    if (!g) this.groups.set(mat, (g = { pos: [], nrm: [], uv: [], idx: [] }));
    const nm = w.clone().invert().transpose();
    const v = new Vec3();
    const first = g.pos.length / 3;
    for (let i = 0; i < s.p.length; i += 3) {
      w.transformPoint(v.set(s.p[i], s.p[i + 1], s.p[i + 2]), v);
      g.pos.push(v.x, v.y, v.z);
      nm.transformVector(v.set(s.n[i], s.n[i + 1], s.n[i + 2]), v).normalize();
      g.nrm.push(v.x, v.y, v.z);
    }
    for (const t of s.t) g.uv.push(t);
    for (const i of s.i) g.idx.push(first + i);
    return w;
  }

  // One entity per material under `parent`.
  finish(parent: Entity): void {
    const d = this.kit.engine.app.graphicsDevice;
    for (const [mat, g] of this.groups) {
      const mesh = new Mesh(d);
      mesh.setPositions(new Float32Array(g.pos));
      mesh.setNormals(new Float32Array(g.nrm));
      mesh.setUvs(0, new Float32Array(g.uv));
      mesh.setIndices(new Uint32Array(g.idx));
      mesh.update();
      const e = new Entity();
      e.addComponent("render", { meshInstances: [new MeshInstance(mesh, mat)], castShadows: true });
      parent.addChild(e);
      this.meshes.push(mesh);
    }
    this.groups.clear();
  }
}

function canvasTexture(kit: Kit, cv: HTMLCanvasElement, wrap = false): Texture {
  const t = new Texture(kit.engine.app.graphicsDevice, {
    width: cv.width, height: cv.height, format: PIXELFORMAT_SRGBA8, mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR,
    addressU: wrap ? ADDRESS_REPEAT : ADDRESS_CLAMP_TO_EDGE, addressV: wrap ? ADDRESS_REPEAT : ADDRESS_CLAMP_TO_EDGE,
  });
  t.setSource(cv);
  return t;
}

export type Room = {
  boxes: Box[];
  buildBooth(spot: number, look: BoothLook): BoothModel;
  destroy(): void;
};

export function buildRoom(kit: Kit, world: Entity): Room {
  const flat = (hex: string, emissive = 0) => kit.flat(hex, emissive ? { emissive } : {});
  const owned: { destroy(): void }[] = [];
  const mg = new Merge(kit);
  const boxes: Box[] = [];
  const P = (k: Prim, mat: StandardMaterial, pos: [number, number, number], scale: [number, number, number], r?: [number, number, number], parent?: Mat4) => mg.add(k, mat, pos, scale, r, parent);

  // floorboards: a tiled canvas texture on the floor slab
  {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 512;
    const g = cv.getContext("2d")!;
    for (let r = 0; r < 8; r++) {
      let x = -((r * 97) % 200);
      while (x < 512) {
        const w = 160 + ((r * 31 + x) % 120);
        const l = 34 + ((r * 13 + x * 7) % 14);
        g.fillStyle = `hsl(26, 38%, ${l}%)`;
        g.fillRect(x, r * 64, w, 64);
        g.fillStyle = "rgba(0,0,0,.35)";
        g.fillRect(x, r * 64, 3, 64);
        for (let k = 0; k < 6; k++) { g.fillStyle = "rgba(0,0,0,.06)"; g.fillRect(x, r * 64 + 8 + k * 9, w, 2); }
        x += w;
      }
      g.fillStyle = "rgba(0,0,0,.45)";
      g.fillRect(0, r * 64, 512, 3);
    }
    const m = new StandardMaterial();
    m.diffuseMap = canvasTexture(kit, cv, true);
    m.diffuseMapTiling = new Vec2(5, 3.5);
    m.diffuse = new Color(0.85, 0.75, 0.7);
    m.gloss = 0.35;
    m.metalness = 0;
    m.update();
    owned.push(m);
    kit.prim("box", m, [0, -0.05, -0.5], [ROOM.x1 - ROOM.x0 + 0.4, 0.1, ROOM.z1 - ROOM.z0 + 0.4], [0, 0, 0], world);
  }
  // the street outside, a low front wall with the door gap, the doormat
  P("box", flat("#120d15"), [0, -0.12, 9], [40, 0.1, 9]);
  P("box", flat(C.woodDark), [-4.6, 0.25, ROOM.z1 + 0.2], [7.2, 0.5, 0.25]);
  P("box", flat(C.woodDark), [5.0, 0.25, ROOM.z1 + 0.2], [6.4, 0.5, 0.25]);
  P("box", flat("#3a2434"), [0.6, 0.006, ROOM.z1 - 0.2], [1.4, 0.01, 0.8]);
  // walls with a dado rail and skirting
  P("box", flat(C.wall), [0, 2, ROOM.z0 - 0.1], [16.6, 4, 0.2]);
  P("box", flat(C.wall), [ROOM.x0 - 0.1, 2, -0.5], [0.2, 4, 11.4]);
  P("box", flat(C.wall), [ROOM.x1 + 0.1, 2, -0.5], [0.2, 4, 11.4]);
  P("box", flat(C.wallTrim), [0, 0.9, ROOM.z0 + 0.01], [16.4, 0.08, 0.04]);
  P("box", flat(C.woodDark), [0, 0.2, ROOM.z0 + 0.02], [16.4, 0.4, 0.06]);

  // the neon sign: MOLE (the O is a record) over RECORDS
  {
    const cv = document.createElement("canvas");
    cv.width = 1024;
    cv.height = 300;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#140e18";
    g.fillRect(0, 0, cv.width, cv.height);
    g.textBaseline = "alphabetic";
    const FACE = 'Bungee, "Archivo Black", "Arial Black", Impact, sans-serif';
    g.font = `180px ${FACE}`;
    const glow = (col: string, blur: number) => { g.shadowColor = col; g.shadowBlur = blur; };
    const wM = g.measureText("M").width, wLE = g.measureText("LE").width, rO = 70;
    const x = (cv.width - (wM + rO * 2 + 24 + wLE)) / 2;
    const base = 195;
    for (const blur of [40, 16, 0]) {
      glow("#FF4F8B", blur);
      g.fillStyle = blur ? "#FF4F8B" : "#ffd6e5";
      g.fillText("M", x, base);
      g.fillText("LE", x + wM + rO * 2 + 24, base);
    }
    const cx = x + wM + 12 + rO, cy = base - 66;
    glow("#FF4F8B", 24);
    g.fillStyle = "#0b070d";
    g.beginPath(); g.arc(cx, cy, rO, 0, 7); g.fill();
    g.lineWidth = 7; g.strokeStyle = "#ffd6e5"; g.stroke();
    g.shadowBlur = 0; g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 2;
    for (const r of [56, 46, 38]) { g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke(); }
    g.fillStyle = "#FF4F8B";
    g.beginPath(); g.arc(cx, cy, 22, 0, 7); g.fill();
    g.font = `64px ${FACE}`;
    g.letterSpacing = "18px";
    glow("#F4B860", 22);
    g.fillStyle = "#F4B860";
    const w = g.measureText("RECORDS").width;
    g.fillText("RECORDS", (cv.width - w) / 2 + 9, 278);
    const m = new StandardMaterial();
    m.diffuse = new Color(0, 0, 0);
    m.emissiveMap = canvasTexture(kit, cv);
    m.emissive = new Color(1, 1, 1);
    m.emissiveIntensity = 1.4;
    m.useLighting = false;
    m.update();
    owned.push(m);
    kit.prim("plane", m, [0, 2.75, ROOM.z0 + 0.03], [4.6, 1, 1.35], [90, 0, 0], world);
    const l = new Entity();
    l.addComponent("light", { type: "omni", color: new Color().fromString(C.neon), range: 5, intensity: 0.9, castShadows: false });
    l.setLocalPosition(0, 2.6, ROOM.z0 + 0.8);
    world.addChild(l);
  }

  // wall shelves of records on the back wall, either side of the sign
  for (const [sx, w] of [[-5.2, 4.2], [5.2, 2.0]] as [number, number][]) {
    for (const y of [1.35, 2.05]) {
      P("box", flat(C.woodDark), [sx, y, ROOM.z0 + 0.18], [w, 0.05, 0.32]);
      const n = Math.floor(w / 0.32);
      for (let i = 0; i < n; i++) {
        const tilt = i % 5 === 2 ? 12 : 0;
        P("box", flat(sleeve(i + y * 10)), [sx - w / 2 + 0.18 + i * 0.32, y + 0.17, ROOM.z0 + 0.2], [0.28, 0.3, 0.02], [0, 0, tilt]);
      }
    }
  }

  // crates of records on tables, down the left wall
  const crate = (x: number, z: number) => {
    const g = local([x, 0, z], [1, 1, 1], [0, 0, 0]);
    P("box", flat(C.woodDark), [0, 0.3, 0], [0.9, 0.6, 1.8], [0, 0, 0], g);
    for (const dz of [-0.45, 0.45]) {
      P("box", flat(C.wood), [0, 0.72, dz], [0.75, 0.24, 0.8], [0, 0, 0], g);
      for (let i = 0; i < 9; i++) {
        P("box", flat(sleeve(i + Math.round(dz * 10) + x * 3)), [0, 0.86, dz - 0.32 + i * 0.08], [0.6, 0.42, 0.02], [-8 - (i === 4 ? 12 : 0), 0, 0], g);
      }
    }
    boxes.push({ x0: x - 0.6, x1: x + 0.6, z0: z - 1.05, z1: z + 1.05 });
  };
  crate(-7.2, -3.6);
  crate(-7.2, -1.0);
  crate(-7.2, 1.6);

  // the jukebox, glowing in the back-right corner
  {
    const g = local([JUKEBOX.x, 0, JUKEBOX.z], [1, 1, 1], [0, 0, 0]);
    P("box", flat("#3a1d30"), [0, 0.7, 0], [1.1, 1.4, 0.7], [0, 0, 0], g);
    P("cylinder", flat(C.neon, 1.2), [0, 1.4, 0], [1.1, 0.7, 1.1], [90, 0, 0], g);
    P("cylinder", flat("#3a1d30"), [0, 1.4, 0.03], [0.9, 0.72, 0.9], [90, 0, 0], g);
    P("box", flat(C.lamp, 1.4), [0, 0.95, 0.36], [0.7, 0.32, 0.02], [0, 0, 0], g);
    P("box", flat("#ffd6e5", 0.6), [0, 0.45, 0.36], [0.8, 0.06, 0.02], [0, 0, 0], g);
    const l = new Entity();
    l.addComponent("light", { type: "omni", color: new Color().fromString(C.neon), range: 4, intensity: 1.2 });
    l.setLocalPosition(JUKEBOX.x, 1.4, JUKEBOX.z + 0.8);
    world.addChild(l);
    boxes.push({ x0: 6.15, x1: 7.45, z0: -5.85, z1: -4.95 });
  }

  // the counter, with a till and a lamp
  {
    const g = local([7.0, 0, 1.6], [1, 1, 1], [0, 0, 0]);
    P("box", flat(C.woodDark), [0, 0.48, 0], [0.8, 0.96, 3.2], [0, 0, 0], g);
    P("box", flat(C.wood), [0, 0.98, 0], [0.95, 0.05, 3.35], [0, 0, 0], g);
    P("box", flat("#2a2a2e"), [0, 1.12, -0.8], [0.4, 0.22, 0.34], [0, 0, 0], g);
    P("box", flat("#7CFFB0", 0.8), [-0.2, 1.17, -0.8], [0.01, 0.08, 0.2], [0, 0, 0], g);
    for (let i = 0; i < 6; i++) P("box", flat(sleeve(i + 20)), [0, 1.16, 0.6 + i * 0.04 - 0.1], [0.32, 0.32, 0.02], [0, 0, 0], g);
    boxes.push({ x0: 6.5, x1: 7.6, z0: -0.1, z1: 3.3 });
  }

  // a rug in the walkway between the booth rows
  P("cylinder", flat("#4a2a3a"), [0.4, 0.005, -0.9], [3.4, 0.01, 1.0]);

  // lights: warm sun with shadows, an amber fill, a lilac fill
  const sun = new Entity();
  const small = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
  sun.addComponent("light", {
    type: "directional", color: new Color(1, 0.88, 0.78), intensity: 0.8, castShadows: true,
    shadowResolution: small ? 1024 : 2048, shadowDistance: 22, shadowBias: 0.3, normalOffsetBias: 0.06,
  });
  sun.setLocalEulerAngles(55, 25, 0);
  world.addChild(sun);
  const fill = new Entity();
  fill.addComponent("light", { type: "omni", color: new Color().fromString(C.lamp), range: 7, intensity: 0.6 });
  fill.setLocalPosition(0.4, 3, 1.6);
  world.addChild(fill);
  const fill2 = new Entity();
  fill2.addComponent("light", { type: "omni", color: new Color(0.8, 0.7, 1), range: 6, intensity: 0.4 });
  fill2.setLocalPosition(-6, 3, -1);
  world.addChild(fill2);

  mg.finish(world);

  function buildBooth(spot: number, look: BoothLook): BoothModel {
    const [x, z] = SPOT_AT[spot];
    const open = look.open;
    const g = new Entity(`booth-${spot}`);
    g.setLocalPosition(x, 0, z);
    world.addChild(g);
    const b = new Merge(kit);
    const B = (k: Prim, mat: StandardMaterial, pos: [number, number, number], scale: [number, number, number], r?: [number, number, number], parent?: Mat4) => b.add(k, mat, pos, scale, r, parent);
    // lit amber ring (public) over the rug
    if (open) B("cylinder", flat(C.lamp, 0.5), [0, 0.006, 0], [3.9, 0.01, 3.9]);
    B("cylinder", flat(open ? C.rug : "#2a2030"), [0, 0.012, 0], [3.7, 0.01, 3.7]);
    // a curved-back partition, three panels
    for (const a of [-50, 0, 50]) {
      const r = 1.75, rad = (a * Math.PI) / 180;
      const p = B("box", flat("#3a2836"), [r * Math.sin(rad), 0.55, -r * Math.cos(rad)], [1.5, 1.1, 0.12], [0, -a, 0]);
      B("box", open ? flat(C.lamp, 0.9) : flat("#4a3a50"), [0, 0.52, 0], [1, 0.04, 1.3], [0, 0, 0], p);
    }
    // the table and its record player (the platter spins separately)
    B("cylinder", flat(C.woodDark), [0, 0.22, 0], [0.16, 0.44, 0.16]);
    B("cylinder", flat(C.wood), [0, 0.46, 0], [1.3, 0.05, 1.3]);
    B("box", flat("#2a1d24"), [0, 0.51, 0], [0.56, 0.06, 0.46]);
    B("box", flat("#c9c4bd"), [0.18, 0.58, 0.02], [0.02, 0.02, 0.3], [0, 18, 0]);
    // six stools round the table, the open side facing the camera
    const stools: Stool[] = [];
    for (const a of [-60, -20, 20, 60, 140, 220]) {
      const rad = (a * Math.PI) / 180, r = 0.98;
      const sx = r * Math.sin(rad), sz = -r * Math.cos(rad);
      B("cylinder", flat(C.stool), [sx, 0.11, sz], [0.36, 0.22, 0.36]);
      stools.push({ x: x + sx, z: z + sz, yaw: (Math.atan2(-sx, -sz) * 180) / Math.PI });
    }
    // a pendant lamp
    B("cylinder", flat("#1a1418"), [0, 2.6, 0], [0.01, 1.6, 0.01]);
    B("cone", flat(open ? "#3a2a1a" : "#2a2230"), [0, 1.75, 0], [0.55, 0.32, 0.55]);
    B("sphere", flat(open ? C.lamp : "#a99bb8", open ? 2 : 0.6), [0, 1.62, 0], [0.16, 0.16, 0.16]);
    b.finish(g);
    const platter = new Entity("platter");
    platter.setLocalPosition(-0.05, 0.555, 0);
    g.addChild(platter);
    const pm = new Merge(kit);
    pm.add("cylinder", flat("#0e0b10"), [0, 0, 0], [0.38, 0.02, 0.38]);
    pm.add("cylinder", flat(open ? C.lamp : C.sleeve), [0, 0.012, 0], [0.13, 0.01, 0.13]);
    pm.add("box", flat("#ffffff"), [0.1, 0.014, 0], [0.04, 0.004, 0.01]);
    pm.finish(platter);
    const l = new Entity();
    l.addComponent("light", { type: "omni", color: new Color().fromString(open ? C.lamp : "#a99bb8"), range: open ? 4.5 : 3, intensity: open ? 1.8 : 0.5, castShadows: false });
    l.setLocalPosition(0, 1.5, 0);
    g.addChild(l);
    const circles: Circle[] = [{ x, z, r: 0.85 }];
    for (const a of [-50, 0, 50]) {
      const rad = (a * Math.PI) / 180;
      circles.push({ x: x + 1.75 * Math.sin(rad), z: z - 1.75 * Math.cos(rad), r: 0.6 });
    }
    return {
      entity: g, platter, stools, circles, x, z,
      destroy() {
        g.destroy();
        for (const m of [...b.meshes, ...pm.meshes]) m.destroy();
      },
    };
  }

  return {
    boxes,
    buildBooth,
    destroy() {
      for (const o of owned) o.destroy();
      for (const m of mg.meshes) m.destroy();
    },
  };
}
