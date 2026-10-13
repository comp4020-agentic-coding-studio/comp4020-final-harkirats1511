// The 2D avatar badge: a round, drawn character shown wherever a name appears.
// Built from createElement / createElementNS only, never markup strings.
// Fixed colours (not theme tokens) so a person looks the same in light and
// dark; the ring around it uses --ink and so follows the theme. Sized by the
// --s custom property (default 2.5rem), see .avatar in global.css.
import { type Avatar, COLOURS, defaultAvatar, OPTIONS } from "../lib/avatar.ts";

const NS = "http://www.w3.org/2000/svg";
const INK = "#16161a";
const PAPER = "#f2efe6";
const SKIN = "#f4dcc0";
const HAIR = [INK, "#6b3f1d", "#c99a2e", "#8a8a93"];
// Outfit colours dark enough that hats and outlines should be light.
const DARK_BG = new Set(["ink", "blue", "green", "red"]);

type Attrs = Record<string, string | number>;
function s(tag: string, attrs: Attrs, ...kids: SVGElement[]): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

const EYES = [41, 59];
const EYE_Y = 52;

function face(mood: string, stroke: string): SVGElement[] {
  const line = { fill: "none", stroke, "stroke-width": 3.2, "stroke-linecap": "round" };
  switch (mood) {
    case "hyped":
      return [
        ...EYES.map((x) => s("circle", { cx: x, cy: EYE_Y, r: 4.2, fill: stroke })),
        s("path", { d: "M40 62 H60 Q60 74 50 74 Q40 74 40 62Z", fill: stroke }),
      ];
    case "sly":
      return [
        s("path", { d: "M36 50 H46 M54 48 H64", ...line }),
        ...EYES.map((x) => s("circle", { cx: x, cy: EYE_Y + 2, r: 2.6, fill: stroke })),
        s("path", { d: "M42 66 Q53 70 60 62", ...line }),
      ];
    case "sleepy":
      return [
        s("path", { d: "M36 52 Q41 57 46 52 M54 52 Q59 57 64 52", ...line }),
        s("ellipse", { cx: 50, cy: 66, rx: 3.2, ry: 2.6, fill: stroke }),
      ];
    default:
      return [
        ...EYES.map((x) => s("circle", { cx: x, cy: EYE_Y, r: 3, fill: stroke })),
        s("path", { d: "M41 63 Q50 71 59 63", ...line }),
      ];
  }
}

// Six hair shapes (the letter in the character id), four colours.
function hair(character: string): SVGElement[] {
  const [gender, letter] = character.split("-");
  const idx = "abcdef".indexOf(letter);
  const fill = HAIR[(idx + (gender === "male" ? 1 : 0)) % HAIR.length];
  const st = { fill, stroke: INK, "stroke-width": 2 };
  switch (idx) {
    case 0: // short, cropped
      return [s("path", { d: "M28 50 Q26 26 50 26 Q74 26 72 50 Q66 38 50 38 Q34 38 28 50Z", ...st })];
    case 1: // bun on top
      return [
        s("circle", { cx: 50, cy: 22, r: 9, ...st }),
        s("path", { d: "M28 50 Q26 28 50 28 Q74 28 72 50 Q64 38 50 38 Q36 38 28 50Z", ...st }),
      ];
    case 2: // long to the shoulders
      return [
        s("path", { d: "M27 78 Q22 28 50 27 Q78 28 73 78 L66 78 Q68 44 50 40 Q32 44 34 78Z", ...st }),
      ];
    case 3: // spikes
      return [s("path", { d: "M28 50 L30 28 L40 36 L46 22 L54 36 L62 24 L70 36 L72 50 Q66 40 50 40 Q34 40 28 50Z", ...st })];
    case 4: // curls
      return [
        ...[[32, 38], [42, 30], [54, 29], [65, 34], [70, 45], [28, 48]].map(([cx, cy]) => s("circle", { cx, cy, r: 8, ...st })),
      ];
    default: // side part, swept
      return [s("path", { d: "M28 52 Q24 26 52 26 Q76 28 72 52 Q70 40 58 38 Q44 42 28 52Z", ...st })];
  }
}

function hat(kind: string, fill: string): SVGElement[] {
  const st = { fill, stroke: INK, "stroke-width": 2 };
  switch (kind) {
    case "cap":
      return [
        s("path", { d: "M28 42 Q28 22 50 22 Q72 22 72 42Z", ...st }),
        s("path", { d: "M66 42 Q86 40 90 46 Q80 50 66 46Z", ...st }),
      ];
    case "beanie":
      return [
        s("path", { d: "M28 42 Q28 20 50 20 Q72 20 72 42Z", ...st }),
        s("rect", { x: 26, y: 38, width: 48, height: 9, ...st }),
        s("circle", { cx: 50, cy: 17, r: 5, ...st }),
      ];
    case "bucket":
      return [
        s("path", { d: "M32 40 Q32 22 50 22 Q68 22 68 40Z", ...st }),
        s("ellipse", { cx: 50, cy: 41, rx: 30, ry: 6, ...st }),
      ];
    case "headphones":
      return [
        s("path", { d: "M27 56 Q24 24 50 24 Q76 24 73 56", fill: "none", stroke: INK, "stroke-width": 7, "stroke-linecap": "round" }),
        s("path", { d: "M27 56 Q24 24 50 24 Q76 24 73 56", fill: "none", stroke: fill, "stroke-width": 3.4, "stroke-linecap": "round" }),
        s("rect", { x: 20, y: 48, width: 11, height: 20, rx: 4, ...st }),
        s("rect", { x: 69, y: 48, width: 11, height: 20, rx: 4, ...st }),
      ];
    default:
      return [];
  }
}

function eyewear(kind: string): SVGElement[] {
  if (kind === "glasses")
    return [
      ...EYES.map((x) => s("circle", { cx: x, cy: EYE_Y, r: 8.5, fill: "rgba(255,255,255,0.35)", stroke: INK, "stroke-width": 2.6 })),
      s("path", { d: "M49.5 51 H50.5", stroke: INK, "stroke-width": 2.6 }),
    ];
  if (kind === "sunglasses")
    return [
      s("path", { d: "M30 47 H70 V53 Q70 62 61 62 Q52 62 51 53 H49 Q48 62 39 62 Q30 62 30 53Z", fill: INK, stroke: INK, "stroke-width": 2, "stroke-linejoin": "round" }),
      s("path", { d: "M34 50 L40 50", stroke: "#ffffff", "stroke-width": 1.8, "stroke-linecap": "round", opacity: 0.7 }),
    ];
  return [];
}

function aidMark(kind: string, outline: string): SVGElement[] {
  const draw = (d: string) => [
    s("path", { d, fill: "none", stroke: outline, "stroke-width": 8, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    s("path", { d, fill: "none", stroke: INK, "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }),
  ];
  if (kind === "cane") return draw("M90 98 V74 Q90 66 82 66");
  if (kind === "crutch") return [...draw("M92 100 L82 66"), ...draw("M74 70 L92 74")];
  return [];
}

export function avatarSvg(a: Avatar): SVGElement {
  const dark = DARK_BG.has(a.colour);
  const bg = COLOURS[a.colour] ?? COLOURS.pink;
  const contrast = dark ? PAPER : INK;
  return s(
    "svg",
    { viewBox: "0 0 100 100", width: "100%", height: "100%", focusable: "false" },
    s("rect", { width: 100, height: 100, fill: bg }),
    s("ellipse", { cx: 50, cy: 104, rx: 36, ry: 26, fill: bg, stroke: contrast, "stroke-width": 3 }),
    s("circle", { cx: 50, cy: 52, r: 23, fill: SKIN, stroke: INK, "stroke-width": 2.4 }),
    ...(a.hat === "none" || a.hat === "headphones" ? hair(a.character) : []),
    ...face(a.mood, INK),
    ...eyewear(a.accessory),
    ...hat(a.hat, contrast),
    ...aidMark(a.aid, contrast),
  );
}

export function describeAvatar(a: Avatar): string {
  return `${a.mood} ${a.colour} character`;
}

// A name's badge. `a` is their avatar; with none (someone who has left the
// table) a default from the name keeps the row from looking broken.
export function avatar(name: string, a?: Avatar): HTMLElement {
  const look = a && OPTIONS.character.includes(a.character) ? a : defaultAvatar(name);
  const el = document.createElement("span");
  el.className = "avatar";
  el.setAttribute("aria-hidden", "true");
  const disc = document.createElement("span");
  disc.className = "av-disc";
  disc.append(avatarSvg(look));
  el.append(disc);
  if (look.aid === "wheelchair" || look.aid === "power-chair") {
    const chip = document.createElement("span");
    chip.className = "av-aid";
    const i = document.createElement("i");
    i.className = `ph-bold ${look.aid === "power-chair" ? "ph-wheelchair-motion" : "ph-wheelchair"}`;
    chip.append(i);
    el.append(chip);
  }
  return el;
}
