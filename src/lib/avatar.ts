// Avatar choices, shared by the server (validation, defaults) and the pages
// (badge, editor). Pure data and functions: nothing here touches the database.
//
// `character` is the file stem of a CC0 Kenney Mini Character in
// public/models (character-<id>.glb). `colour` tints the outfit: the hex is
// what the 3D phase multiplies into the colormap and what the 2D badge fills
// with. `mood` picks the idle animation in 3D and the face in 2D.

export const PARTS = ["character", "colour", "hat", "accessory", "aid", "mood"] as const;
export type Part = (typeof PARTS)[number];
export type Avatar = Record<Part, string>;

export const COLOURS: Record<string, string> = {
  pink: "#f0477e",
  blue: "#1a5fcc",
  ink: "#16161a",
  paper: "#f2efe6",
  green: "#17703f",
  red: "#c2272d",
};

export const OPTIONS: Record<Part, string[]> = {
  character: [
    "female-a", "female-b", "female-c", "female-d", "female-e", "female-f",
    "male-a", "male-b", "male-c", "male-d", "male-e", "male-f",
  ],
  colour: Object.keys(COLOURS),
  hat: ["none", "cap", "beanie", "headphones", "bucket"],
  accessory: ["none", "glasses", "sunglasses"],
  aid: ["none", "wheelchair", "power-chair", "cane", "crutch"],
  mood: ["chill", "hyped", "sly", "sleepy"],
};

// Plain labels for the editor.
export const PART_LABELS: Record<Part, string> = {
  character: "Character",
  colour: "Outfit colour",
  hat: "Hat",
  accessory: "Eyewear",
  aid: "Mobility aid",
  mood: "Mood",
};

export const VALUE_LABELS: Record<string, string> = {
  none: "None",
  cap: "Cap",
  beanie: "Beanie",
  headphones: "Headphones",
  bucket: "Bucket hat",
  glasses: "Glasses",
  sunglasses: "Sunglasses",
  wheelchair: "Wheelchair",
  "power-chair": "Power chair",
  cane: "Cane",
  crutch: "Crutch",
  chill: "Chill",
  hyped: "Hyped",
  sly: "Sly",
  sleepy: "Sleepy",
  pink: "Pink",
  blue: "Blue",
  ink: "Ink",
  paper: "Paper",
  green: "Green",
  red: "Red",
};

export function valueLabel(part: Part, value: string): string {
  if (part === "character") return `Character ${OPTIONS.character.indexOf(value) + 1}`;
  return VALUE_LABELS[value] ?? value;
}

// FNV-1a: a small stable hash, so the same id always gives the same default.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Everyone starts with a plain look that differs from most other people's:
// character, colour and mood vary; no hat, eyewear or aid until they choose.
export function defaultAvatar(seed: string): Avatar {
  const pick = (part: Part) => OPTIONS[part][hash(`${part}:${seed}`) % OPTIONS[part].length];
  return {
    character: pick("character"),
    colour: pick("colour"),
    hat: "none",
    accessory: "none",
    aid: "none",
    mood: pick("mood"),
  };
}

// Strict: exactly the six keys, each a string from its list.
export function parseAvatar(raw: unknown): Avatar | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length !== PARTS.length) return null;
  const out = {} as Avatar;
  for (const part of PARTS) {
    const v = obj[part];
    if (typeof v !== "string" || !OPTIONS[part].includes(v)) return null;
    out[part] = v;
  }
  return out;
}
