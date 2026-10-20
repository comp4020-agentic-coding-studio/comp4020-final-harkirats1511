// One Kenney Mini Character: the GLB instanced, tinted, dressed and animated.
// Used by the table scene (seated) and by the /me portraits (standing).
// Everything here is driven by an Avatar (public) and nothing else.
import {
  type AnimComponent,
  type AnimTrack,
  BLEND_NORMAL,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  PIXELFORMAT_SRGBA8,
  Mesh,
  MeshInstance,
  PlaneGeometry,
  SphereGeometry,
  StandardMaterial,
  Texture,
  TorusGeometry,
  Vec3,
} from "playcanvas";
import { type Avatar, COLOURS } from "../lib/avatar.ts";
import type { Engine } from "./engine.ts";

const DARK_BG = new Set(["ink", "blue", "green", "red"]);
const PAPER = "#f2efe6";
const INK = "#16161a";

export type Prim = "box" | "cylinder" | "sphere" | "torus" | "cone" | "plane";

// Shared meshes, materials and recoloured atlases for one engine.
export class Kit {
  private meshes = new Map<string, Mesh>();
  private flats = new Map<string, StandardMaterial>();
  private bodies = new Map<string, StandardMaterial>();
  private atlas: Promise<HTMLCanvasElement | null> | null = null;
  constructor(readonly engine: Engine) {}

  mesh(kind: Prim): Mesh {
    let m = this.meshes.get(kind);
    if (!m) {
      const d = this.engine.app.graphicsDevice;
      const geo =
        kind === "box"
          ? new BoxGeometry()
          : kind === "cylinder"
            ? new CylinderGeometry({ radius: 0.5, height: 1, capSegments: 20, heightSegments: 1 })
            : kind === "sphere"
              ? new SphereGeometry({ radius: 0.5, latitudeBands: 10, longitudeBands: 14 })
              : kind === "cone"
                ? new ConeGeometry({ baseRadius: 0.5, peakRadius: 0, height: 1, capSegments: 20, heightSegments: 1 })
                : kind === "plane"
                  ? new PlaneGeometry()
                  : new TorusGeometry({ tubeRadius: 0.5, ringRadius: 1, segments: 24, sides: 8 });
      m = Mesh.fromGeometry(d, geo);
      this.meshes.set(kind, m);
    }
    return m;
  }

  // A flat, matte colour. Keyed so the same colour is one material.
  flat(hex: string, opts: { emissive?: number } = {}): StandardMaterial {
    const key = `${hex}|${opts.emissive ?? 0}`;
    let m = this.flats.get(key);
    if (!m) {
      m = new StandardMaterial();
      m.diffuse = new Color().fromString(hex);
      m.gloss = 0.15;
      m.metalness = 0;
      if (opts.emissive) {
        m.emissive = new Color().fromString(hex);
        m.emissiveIntensity = opts.emissive;
      }
      m.update();
      this.flats.set(key, m);
    }
    return m;
  }

  prim(kind: Prim, mat: StandardMaterial, pos: [number, number, number], scale: [number, number, number], rot: [number, number, number] = [0, 0, 0], parent?: Entity): Entity {
    const e = new Entity();
    e.addComponent("render", { meshInstances: [new MeshInstance(this.mesh(kind), mat)] });
    e.setLocalPosition(pos[0], pos[1], pos[2]);
    e.setLocalEulerAngles(rot[0], rot[1], rot[2]);
    e.setLocalScale(scale[0], scale[1], scale[2]);
    parent?.addChild(e);
    return e;
  }

  // The colormap atlas with its colourful swatches (rows 8-11, from the third
  // column) recoloured toward the outfit colour. Skin, hair-black, greys and
  // whites are left alone, so the same model reads differently per person.
  private async loadAtlas(): Promise<HTMLCanvasElement | null> {
    this.atlas ??= new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 512;
        const g = c.getContext("2d");
        if (!g) return resolve(null);
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, 512, 512);
        resolve(c);
      };
      img.onerror = () => resolve(null);
      img.src = "/models/Textures/colormap.png";
    });
    return this.atlas;
  }

  // Outfit material for a colour name, with the original head material
  // untouched. Shared by everyone who wears the colour.
  async body(colour: string, original: StandardMaterial): Promise<StandardMaterial> {
    let m = this.bodies.get(colour);
    if (m) return m;
    const base = await this.loadAtlas();
    m = original.clone() as StandardMaterial;
    if (base && COLOURS[colour]) {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const g = c.getContext("2d")!;
      g.drawImage(base, 0, 0);
      const x0 = 64, y0 = 256, w = 512 - x0, h = 128;
      const data = g.getImageData(x0, y0, w, h);
      const t = new Color().fromString(COLOURS[colour]);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]) / 255;
        const f = 0.7 + 0.6 * lum;
        px[i] = Math.min(255, t.r * 255 * f);
        px[i + 1] = Math.min(255, t.g * 255 * f);
        px[i + 2] = Math.min(255, t.b * 255 * f);
      }
      g.putImageData(data, x0, y0);
      const tex = new Texture(this.engine.app.graphicsDevice, { name: `outfit-${colour}`, width: 512, height: 512, format: PIXELFORMAT_SRGBA8, mipmaps: true, minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR });
      tex.setSource(c);
      m.diffuseMap = tex;
      m.update();
    }
    this.bodies.set(colour, m);
    return m;
  }
}

// The clips used. `base` clips move the whole body (sit, die); `act` clips only
// move torso, head and arms, and play over the base.
// The shop adds the standing clips (idle, walk, jump, wheelchair-move-forward).
const BASE_CLIPS = ["sit", "wheelchair-sit", "die", "static", "idle", "walk", "jump", "wheelchair-move-forward"] as const;
const ACT_CLIPS = ["idle", "emote-yes", "emote-no", "interact-right", "holding-right", "interact-left"] as const;
const ONE_SHOT = new Set(["die", "jump"]);

// `shadows` lets the figure cast a shadow (the shop has a sun; the table does not).
export type CharacterOpts = { seated: boolean; shadows?: boolean };

export class Character {
  readonly root = new Entity("person");
  private anim!: AnimComponent;
  private actClip = "";
  private baseClip = "";
  head!: Entity;
  private bodyMi: MeshInstance | null = null;
  private headMi: MeshInstance | null = null;
  private extras: Entity[] = [];
  private ghostMats: StandardMaterial[] = [];
  private solid = new Map<MeshInstance, StandardMaterial>();
  private ghosted = false;
  readonly wheelchair: boolean;
  constructor(readonly look: Avatar) {
    this.wheelchair = look.aid === "wheelchair" || look.aid === "power-chair";
  }

  static async create(kit: Kit, look: Avatar, opts: CharacterOpts): Promise<Character> {
    const ch = new Character(look);
    await ch.build(kit, opts);
    return ch;
  }

  private async build(kit: Kit, opts: CharacterOpts) {
    const res = await kit.engine.load(`/models/character-${this.look.character}.glb`);
    const model = res.instantiateRenderEntity(opts.shadows ? { castShadows: true } : undefined);
    this.root.addChild(model);
    for (const r of model.findComponents("render")) {
      for (const mi of (r as unknown as { meshInstances: MeshInstance[] }).meshInstances) {
        if (mi.node.name === "body-mesh") this.bodyMi = mi;
        else if (mi.node.name === "head-mesh") this.headMi = mi;
      }
    }
    if (this.bodyMi) this.bodyMi.material = await kit.body(this.look.colour, this.bodyMi.material as StandardMaterial);
    this.head = model.findByName("head") as Entity;

    // Animation: a base layer for the pose of the whole body and an overlay
    // for what the torso, head and arms are doing.
    const tracks = new Map<string, AnimTrack>();
    for (const a of res.animations) if (a.resource) tracks.set((a.resource as AnimTrack).name, a.resource as AnimTrack);
    model.addComponent("anim", { activate: true });
    const anim = model.anim!;
    this.anim = anim;
    const basePose = opts.seated ? (this.wheelchair ? "wheelchair-sit" : "sit") : "static";
    const first = tracks.get(basePose);
    if (!first) throw new Error("character has no clips");
    anim.assignAnimation(basePose, first);
    for (const n of BASE_CLIPS) {
      const t = tracks.get(n);
      if (t && n !== basePose) anim.assignAnimation(n, t, undefined, 1, !ONE_SHOT.has(n));
    }
    const prefix = model.name;
    const mask: Record<string, { value: boolean }> = {};
    for (const p of ["root/torso", "root/torso/head", "root/torso/arm-left", "root/torso/arm-right"]) mask[`${prefix}/${p}`] = { value: true };
    const act = anim.addLayer("act", 1, mask as never);
    let firstAct = true;
    for (const n of ACT_CLIPS) {
      const t = tracks.get(n);
      if (!t) continue;
      anim.assignAnimation(n, t, "act", 1, true);
      if (firstAct) firstAct = false;
    }
    this.baseClip = basePose;
    this.actClip = "idle";
    void act;
    this.dress(kit);
  }

  // Hats and eyewear, attached to the head node; aids beside or under the seat
  // are placed by the caller because they depend on the seat.
  private dress(kit: Kit) {
    const { hat, accessory, colour } = this.look;
    const dark = DARK_BG.has(colour);
    const contrast = kit.flat(dark ? PAPER : INK);
    const ink = kit.flat(INK);
    const pink = kit.flat(COLOURS.pink);
    const outfit = kit.flat(COLOURS[colour] ?? COLOURS.pink);
    const add = (e: Entity) => {
      this.head.addChild(e);
      this.extras.push(e);
    };
    // The head pivots at its base: the crown is about y 0.43, the face centre
    // about y 0.2, and the face looks along +z.
    const P = (k: Prim, mat: StandardMaterial, pos: [number, number, number], scale: [number, number, number], rot: [number, number, number] = [0, 0, 0]) =>
      add(kit.prim(k, mat, pos, scale, rot));
    if (hat === "cap") {
      P("sphere", outfit, [0, 0.38, -0.04], [0.5, 0.3, 0.52]);
      P("box", outfit, [0, 0.335, 0.21], [0.34, 0.025, 0.24], [-8, 0, 0]);
    } else if (hat === "beanie") {
      P("cylinder", contrast, [0, 0.385, -0.04], [0.5, 0.15, 0.5]);
      P("sphere", contrast, [0, 0.43, -0.04], [0.46, 0.22, 0.46]);
      P("sphere", pink, [0, 0.55, -0.04], [0.09, 0.09, 0.09]);
    } else if (hat === "bucket") {
      P("cylinder", contrast, [0, 0.43, -0.04], [0.44, 0.17, 0.44]);
      P("cylinder", contrast, [0, 0.35, -0.04], [0.66, 0.025, 0.66]);
    } else if (hat === "headphones") {
      P("torus", ink, [0, 0.31, -0.04], [0.205, 0.04, 0.205], [90, 90, 0]);
      for (const sx of [-1, 1]) P("cylinder", pink, [sx * 0.235, 0.2, -0.04], [0.14, 0.1, 0.14], [0, 0, 90]);
    }
    if (accessory === "glasses" || accessory === "sunglasses") {
      void kit.engine.load(`/models/aid-${accessory}.glb`).then((r) => {
        const g = r.instantiateRenderEntity();
        g.setLocalPosition(0, 0.17, 0.2);
        g.setLocalScale(1.35, 1.35, 1.35);
        add(g);
      }).catch(() => {});
    }
  }

  // The aids: returns an entity to stand on the floor by the seat or null.
  async aid(kit: Kit): Promise<Entity | null> {
    const { aid } = this.look;
    if (aid === "none") return null;
    const file = aid === "power-chair" ? "wheelchair-power" : aid === "wheelchair" ? "wheelchair" : aid === "cane" ? "aid-cane" : "aid-crutch";
    const res = await kit.engine.load(`/models/${file}.glb`);
    return res.instantiateRenderEntity();
  }

  // Play a clip on the overlay (torso, head, arms), or take over the whole body.
  play(clip: string, opts: { speed?: number; blend?: number } = {}) {
    const blend = opts.blend ?? 0.25;
    const layers = this.anim.layers;
    const base = layers[0];
    const act = layers[1];
    if (clip === "die") {
      if (this.baseClip !== "die") {
        base.transition("die", 0.1);
        this.baseClip = "die";
      }
      act.weight = 0;
      return;
    }
    if (this.baseClip === "die") {
      base.transition(this.wheelchair ? "wheelchair-sit" : "sit", 0.1);
      this.baseClip = this.wheelchair ? "wheelchair-sit" : "sit";
    }
    act.weight = 1;
    if (clip !== this.actClip) {
      act.transition(clip, blend);
      this.actClip = clip;
    }
  }

  // Whole-body clip for someone standing about: idle, walk, jump or sit.
  // Wheelchair users get the chair clips in their place.
  setBase(clip: string, blend = 0.2) {
    if (this.wheelchair) clip = clip === "walk" ? "wheelchair-move-forward" : clip === "idle" || clip === "sit" ? "wheelchair-sit" : clip;
    if (clip === this.baseClip) return;
    this.anim.layers[0].transition(clip, blend);
    this.baseClip = clip;
  }

  // How much the torso/arm overlay shows: 0 while the legs carry a walk or a hop.
  setOverlay(weight: number) {
    this.anim.layers[1].weight = weight;
  }

  // Make the whole figure see-through (a ghost) or solid again.
  ghost(on: boolean) {
    if (on === this.ghosted) return;
    this.ghosted = on;
    for (const mi of [this.bodyMi, this.headMi]) {
      if (!mi) continue;
      if (on) {
        this.solid.set(mi, mi.material as StandardMaterial);
        const m = (mi.material as StandardMaterial).clone() as StandardMaterial;
        m.blendType = BLEND_NORMAL;
        m.opacity = 0.4;
        m.depthWrite = false;
        m.update();
        this.ghostMats.push(m);
        mi.material = m;
      } else {
        const orig = this.solid.get(mi);
        if (orig) mi.material = orig;
      }
    }
    for (const e of this.extras) e.enabled = !on;
  }

  setSpeed(v: number) {
    this.anim.speed = v;
  }

  setPose(vis: boolean) {
    this.root.enabled = vis;
  }

  worldHead(out = new Vec3()): Vec3 {
    return this.head ? this.head.getPosition().clone() : out;
  }

  destroy() {
    for (const m of this.ghostMats) m.destroy();
    this.root.destroy();
  }
}
