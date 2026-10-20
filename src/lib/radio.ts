import { EventEmitter } from "node:events";

// The shop radio (decision 0006). Nothing is stored per track: what plays is
// worked out from the clock, the mode and the epoch, so every listener agrees.
// Ids are Deezer track ids; audio comes from the signed preview per id, never
// from us.
const STATIONS = [
  {
    id: "after-hours", name: "After Hours",
    tracks: [3512895311, 3512895281, 3512895331, 3512895341, 3512895291, 3099606, 684573392, 5726092, 1031007, 512466312],
  },
  {
    id: "back-room", name: "Back Room",
    tracks: [2791780102, 2791872372, 2791884862, 445960982, 594569672, 13159670, 2465911, 446028242, 84107655, 980535512],
  },
  {
    id: "late-bus", name: "Late Bus",
    tracks: [1951194587, 1951194607, 829306252, 375959421, 1123844, 2562284362, 1733771197],
  },
];

export const SLOT_MS = 30_000;
// A preview is 30 s, so a slot is one preview.
export type Slot = { trackId: number; station: string; startedAt: number };
export type Radio = {
  mode: string;
  stations: { id: string; name: string }[];
  slotMs: number;
  epoch: number;
  now: Slot;
  next: Slot;
};

let mode = "mix";
let epoch = Date.now();
let changedAt = 0;

const bus = new EventEmitter();

export const isMode = (m: unknown): m is string =>
  m === "mix" || STATIONS.some((s) => s.id === m);

function slot(n: number): Slot {
  // Mix: one track from each station in turn, each station advancing a track per lap.
  const station = mode === "mix" ? STATIONS[n % STATIONS.length] : STATIONS.find((s) => s.id === mode)!;
  const i = mode === "mix" ? Math.floor(n / STATIONS.length) : n;
  return { trackId: station.tracks[i % station.tracks.length], station: station.id, startedAt: epoch + n * SLOT_MS };
}

export function getRadio(at = Date.now()): Radio {
  const n = Math.max(0, Math.floor((at - epoch) / SLOT_MS));
  return {
    mode,
    stations: STATIONS.map(({ id, name }) => ({ id, name })),
    slotMs: SLOT_MS,
    epoch,
    now: slot(n),
    next: slot(n + 1),
  };
}

// Seconds until the jukebox may be used again, 0 when it may.
export function retryAfter(at = Date.now()): number {
  return Math.max(0, Math.ceil((changedAt + 60_000 - at) / 1000));
}

export function setMode(next: string, at = Date.now()): Radio {
  mode = next;
  epoch = at;
  changedAt = at;
  const radio = getRadio(at);
  bus.emit("radio", radio);
  return radio;
}

export function watchRadio(fn: (r: Radio) => void): () => void {
  bus.on("radio", fn);
  return () => bus.off("radio", fn);
}
