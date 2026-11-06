// The wall of sleeves on the shop's back wall (decision 0011): every revealed
// round of a public table, newest top left. One mesh and one texture atlas for
// all of them (at most WALL.cols x WALL.rows, the newest 40), so a phone draws
// the whole wall in a single call. It only knows what the wall API and the
// `wall` event already publish.
import { Color, Entity, Mesh, MeshInstance, StandardMaterial } from "playcanvas";
import type { Kit } from "./character.ts";
import { canvasTexture, WALL } from "./shop-room.ts";
import type { Mood, Sleeve } from "./shop-types.ts";

const CELL = 256;
const MOOD_FILL: Record<Mood, string> = { up: "#f4b860", down: "#85728c", out: "#7a5333", in: "#e4dac4" };
const MOOD_INK: Record<Mood, string> = { up: "#1b1420", down: "#1b1420", out: "#efe7d7", in: "#1b1420" };
const ARRIVE_MS = 900;

export type SleeveWall = {
  readonly max: number;
  set(list: Sleeve[], freshId?: string): void;
  // Which sleeve a point on the wall plane (world x, y) is, or null.
  at(x: number, y: number): Sleeve | null;
  // Where a sleeve hangs (world), for walking up to it.
  where(id: string): { x: number; y: number } | null;
  // The sleeves of the column nearest a floor x, top to bottom.
  column(x: number): Sleeve[];
  tick(t: number): void;
  destroy(): void;
};

export function buildSleeveWall(kit: Kit, world: Entity, opts: { reduced: boolean }): SleeveWall {
  const max = WALL.cols * WALL.rows;
  const device = kit.engine.app.graphicsDevice;
  const cv = document.createElement("canvas");
  cv.width = WALL.cols * CELL;
  cv.height = WALL.rows * CELL;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#2a1f30";
  g.fillRect(0, 0, cv.width, cv.height);
  const tex = canvasTexture(kit, cv);
  const mat = new StandardMaterial();
  mat.diffuseMap = tex;
  mat.diffuse = new Color(1, 1, 1);
  mat.emissiveMap = tex;
  mat.emissive = new Color(0.32, 0.3, 0.28); // readable in the dim shop, still lit by the lamps
  mat.gloss = 0.25;
  mat.metalness = 0;
  mat.update();

  let shown: Sleeve[] = [];
  const covers = new Map<string, HTMLImageElement | null>();
  let arrival: { index: number; t0: number } | null = null;

  // cell i -> centre on the wall (row 0 is the top row)
  const centre = (i: number) => {
    const c = i % WALL.cols, r = Math.floor(i / WALL.cols);
    return { x: WALL.x0 + c * WALL.pitch, y: WALL.y0 + (WALL.rows - 1 - r) * WALL.pitch };
  };

  // 4 vertices per cell; positions are rewritten only while a sleeve arrives
  const pos = new Float32Array(max * 12);
  const nrm = new Float32Array(max * 12);
  const uv = new Float32Array(max * 8);
  const idx = new Uint16Array(max * 6);
  const writeCell = (i: number, lift = 0, scale = 1) => {
    const { x, y } = centre(i);
    const h = (WALL.size / 2) * (i < shown.length ? scale : 0); // an empty cell has no area
    const z = WALL.z + 0.02 + lift * 0.4;
    const yy = y + lift;
    pos.set([x - h, yy - h, z, x + h, yy - h, z, x + h, yy + h, z, x - h, yy + h, z], i * 12);
  };
  for (let i = 0; i < max; i++) {
    nrm.set([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], i * 12);
    const c = i % WALL.cols, r = Math.floor(i / WALL.cols);
    // the canvas is uploaded top row first, so v runs down the atlas
    const u0 = c / WALL.cols, u1 = (c + 1) / WALL.cols, vTop = r / WALL.rows, vBottom = (r + 1) / WALL.rows;
    uv.set([u0, vBottom, u1, vBottom, u1, vTop, u0, vTop], i * 8);
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const mesh = new Mesh(device);
  const upload = () => {
    mesh.setPositions(pos);
    mesh.setNormals(nrm);
    mesh.setUvs(0, uv);
    mesh.setIndices(idx);
    mesh.update();
  };
  for (let i = 0; i < max; i++) writeCell(i);
  upload();
  const ent = new Entity("sleeve-wall");
  ent.addComponent("render", { meshInstances: [new MeshInstance(mesh, mat)], castShadows: false });
  world.addChild(ent);

  // wrap a short string into at most `lines` lines that fit `w`
  const wrap = (text: string, w: number, lines: number) => {
    const words = text.split(/\s+/);
    const out: string[] = [];
    let line = "";
    for (const word of words) {
      const t = line ? `${line} ${word}` : word;
      if (g.measureText(t).width <= w || !line) line = t;
      else { out.push(line); line = word; }
      if (out.length === lines) break;
    }
    if (out.length < lines && line) out.push(line);
    if (out.length === lines && words.join(" ") !== out.join(" ")) out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, "") + "...";
    return out;
  };

  function paint(i: number) {
    const s = shown[i];
    const c = i % WALL.cols, r = Math.floor(i / WALL.cols);
    const x = c * CELL, y = r * CELL;
    g.save();
    g.beginPath();
    g.rect(x, y, CELL, CELL);
    g.clip();
    g.fillStyle = "#2a1f30";
    g.fillRect(x, y, CELL, CELL);
    if (s) {
      const art = covers.get(coverOf(s) ?? "");
      if (art) {
        g.drawImage(art, x, y, CELL, CELL);
      } else {
        // a plain sleeve in the mood's colour, with a record ring and the prompt handwritten
        g.fillStyle = MOOD_FILL[s.mood];
        g.fillRect(x, y, CELL, CELL);
        g.strokeStyle = "rgba(27,20,32,.18)";
        g.lineWidth = 4;
        g.beginPath();
        g.arc(x + CELL * 0.72, y + CELL * 0.32, CELL * 0.2, 0, 7);
        g.stroke();
        g.fillStyle = MOOD_INK[s.mood];
        g.font = '600 34px Caveat, "Segoe Print", cursive';
        wrap(s.prompt, CELL - 36, 3).forEach((l, k) => g.fillText(l, x + 18, y + 120 + k * 34));
      }
      // the catalogue sticker: mood and booth, like a shop's price tag
      g.fillStyle = "#efe7d7";
      g.fillRect(x + 12, y + CELL - 46, CELL - 24, 34);
      g.fillStyle = "#1b1420";
      g.font = '600 20px "IBM Plex Mono", monospace';
      g.fillText(`${s.mood.toUpperCase()} · ${s.table} R${s.round}${s.caught ? " · CAUGHT" : ""}`, x + 22, y + CELL - 22);
    }
    g.restore();
  }
  const coverOf = (s: Sleeve) => (s.picks.find((p) => p.best && p.cover) ?? s.picks.find((p) => p.cover))?.cover;

  function load(url: string) {
    if (covers.has(url)) return;
    covers.set(url, null);
    const img = new Image();
    img.crossOrigin = "anonymous"; // drawing it into the atlas needs CORS; without it the plain sleeve stays
    img.onload = () => {
      covers.set(url, img);
      let any = false;
      shown.forEach((s, i) => { if (coverOf(s) === url) { paint(i); any = true; } });
      if (any) tex.upload();
    };
    img.src = url;
  }

  return {
    max,
    set(list, freshId) {
      shown = list.slice(0, max);
      for (let i = 0; i < max; i++) paint(i);
      for (const s of shown) { const u = coverOf(s); if (u) load(u); }
      tex.upload();
      const fi = freshId ? shown.findIndex((s) => s.id === freshId) : -1;
      arrival = fi >= 0 && !opts.reduced ? { index: fi, t0: performance.now() } : null;
      for (let i = 0; i < max; i++) writeCell(i, arrival?.index === i ? 0.12 : 0, arrival?.index === i ? 0.9 : 1);
      upload();
    },
    at(x, y) {
      for (let i = 0; i < shown.length; i++) {
        const c = centre(i);
        if (Math.abs(x - c.x) <= WALL.pitch / 2 && Math.abs(y - c.y) <= WALL.pitch / 2) return shown[i];
      }
      return null;
    },
    where(id) {
      const i = shown.findIndex((s) => s.id === id);
      return i < 0 ? null : centre(i);
    },
    column(x) {
      const c = Math.round((x - WALL.x0) / WALL.pitch);
      if (c < 0 || c >= WALL.cols) return [];
      return shown.filter((_, i) => i % WALL.cols === c);
    },
    tick(t) {
      if (!arrival) return;
      // a quiet arrival: the new sleeve settles onto its hook
      const k = Math.min(1, (t - arrival.t0) / ARRIVE_MS);
      const e = 1 - (1 - k) ** 3;
      writeCell(arrival.index, 0.12 * (1 - e), 0.9 + 0.1 * e);
      upload();
      if (k >= 1) arrival = null;
    },
    destroy() {
      ent.destroy();
      mesh.destroy();
      tex.destroy();
      mat.destroy();
    },
  };
}
