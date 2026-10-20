// The shop radio (decision 0006): Deezer previews from the server's clock-based
// schedule, played through plain <audio> elements, never hosted by us. Which
// track plays is /api/shop/radio's business; this only follows it, seeks into
// the current preview and crossfades at the join. It starts only after a user
// gesture and never when the saved preference is "off".
//
// Written to be reused: the table page can call mute(true) while a game runs
// and mute(false) after it, without touching the saved preference.

export type Slot = { trackId: number; station: string; startedAt: number };
export type RadioInfo = {
  mode: string;
  stations: { id: string; name: string }[];
  slotMs: number;
  epoch: number;
  now: Slot;
  next: Slot;
};
export type RadioState = {
  on: boolean; // the saved preference
  playing: boolean; // sound is actually coming out (or about to)
  muted: boolean;
  volume: number;
  mode: string;
  stationName: string;
};
export type RadioPlayer = {
  state(): RadioState;
  // The person asked for the radio (the button): remembers "on" and begins.
  start(): void;
  // The person turned it off: remembers "off" and fades out.
  stop(): void;
  setVolume(v: number): void;
  // Silence it for now (a game is on) without changing the saved choice.
  mute(m: boolean): void;
  // Tell it a first tap/click/key has happened, so playing is allowed.
  gesture(): void;
  // Feed it the radio from the snapshot, the `radio` event or a GET.
  update(r: RadioInfo, opts?: { changed?: boolean }): void;
  // Called whenever the state above changes. Returns an unsubscribe.
  subscribe(fn: (s: RadioState) => void): () => void;
  destroy(): void;
};

const KEY_ON = "mole:radio";
const KEY_VOL = "mole:radio-vol";
export const DEFAULT_VOLUME = 0.35;
const CROSSFADE_MS = 1500;
const SWITCH_FADE_MS = 400;
const MAX_SEEK_S = 30;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not saved */ } };

// One <audio> element with a fade level of its own (0..1) under the master volume.
class Voice {
  readonly el = new Audio();
  key = "";
  private level = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private master: () => number) {
    this.el.preload = "auto";
    this.el.crossOrigin = "anonymous";
  }
  apply() {
    this.el.volume = Math.max(0, Math.min(1, this.level * this.master()));
  }
  fade(to: number, ms: number, done?: () => void) {
    if (this.timer) clearInterval(this.timer);
    const from = this.level;
    const t0 = performance.now();
    if (ms <= 0 || from === to) {
      this.level = to;
      this.apply();
      done?.();
      return;
    }
    this.timer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      this.level = from + (to - from) * k;
      this.apply();
      if (k >= 1) {
        clearInterval(this.timer!);
        this.timer = null;
        done?.();
      }
    }, 40);
  }
  silence() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.level = 0;
    this.key = "";
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
  }
}

export function createRadio(opts: { endpoint?: string } = {}): RadioPlayer {
  const radioUrl = opts.endpoint ?? "/api/shop/radio";
  let pref = read(KEY_ON) !== "off";
  let volume = (() => {
    const v = Number(read(KEY_VOL));
    return read(KEY_VOL) !== null && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT_VOLUME;
  })();
  let muted = false;
  let gestured = false;
  let radio: RadioInfo | null = null;
  let destroyed = false;
  let lastFetch = 0;
  const failed = new Set<string>();
  const urls = new Map<number, { url: string; at: number }>();
  const listeners = new Set<(s: RadioState) => void>();
  const voices = [new Voice(() => volume), new Voice(() => volume)];
  let cur: Voice | null = null;
  // The slot whose preview is being fetched, so a slow fetch isn't restarted every tick.
  let pending = "";
  // Bumped on every switch so a late preview fetch can tell it was overtaken.
  let epoch = 0;

  const should = () => pref && gestured && !muted && !destroyed;
  const stationName = () => {
    if (!radio) return "";
    return radio.mode === "mix" ? `Mix: ${radio.stations.find((s) => s.id === radio!.now.station)?.name ?? ""}` : (radio.stations.find((s) => s.id === radio!.mode)?.name ?? "");
  };
  const state = (): RadioState => ({ on: pref, playing: should() && !!cur, muted, volume, mode: radio?.mode ?? "mix", stationName: stationName() });
  const emit = () => { const s = state(); for (const fn of listeners) fn(s); };

  async function previewUrl(id: number): Promise<string | null> {
    const hit = urls.get(id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.url;
    try {
      const res = await fetch(`/api/tracks/${id}/preview`, { credentials: "same-origin" });
      if (!res.ok) return null;
      const { url } = (await res.json()) as { url?: string };
      if (!url) return null;
      urls.set(id, { url, at: Date.now() });
      return url;
    } catch {
      return null;
    }
  }

  // Start a slot on the idle voice, seeking into it, fading in; the old voice fades out.
  async function play(slot: Slot, fadeMs: number) {
    const key = `${slot.trackId}@${slot.startedAt}`;
    if (failed.has(key) || pending === key || (cur?.key === key && !cur.el.paused)) return;
    const mine = ++epoch;
    pending = key;
    const url = await previewUrl(slot.trackId);
    if (pending === key) pending = "";
    if (mine !== epoch || !should()) return;
    if (!url) {
      failed.add(key); // skip silently; the next slot is tried when it comes
      return;
    }
    const v = voices.find((x) => x !== cur) ?? voices[0];
    v.silence();
    v.key = key;
    v.el.src = url;
    const seek = (Date.now() - slot.startedAt) / 1000;
    const startAt = seek > 0.5 && seek < MAX_SEEK_S ? seek : 0;
    const go = () => {
      if (mine !== epoch) return;
      if (startAt) { try { v.el.currentTime = startAt; } catch { /* not seekable yet */ } }
      v.fade(1, fadeMs);
      v.el.play().catch(() => {
        // Blocked (no gesture yet) or the preview failed: stay quiet, try the next slot.
        failed.add(key);
        if (cur === v) cur = null;
        emit();
      });
    };
    v.el.addEventListener("loadedmetadata", go, { once: true });
    v.el.addEventListener("error", () => { failed.add(key); if (cur === v) { cur = null; emit(); } }, { once: true });
    const old = cur;
    cur = v;
    if (old) old.fade(0, fadeMs, () => { if (old !== cur) old.silence(); });
    v.apply();
    emit();
  }

  function stopAll(fadeMs = 400) {
    epoch++;
    pending = "";
    const old = cur;
    cur = null;
    for (const v of voices) {
      if (v === old) v.fade(0, fadeMs, () => { if (v !== cur) v.silence(); });
      else v.silence();
    }
    emit();
  }

  async function refresh() {
    if (Date.now() - lastFetch < 4000) return;
    lastFetch = Date.now();
    try {
      const res = await fetch(radioUrl, { credentials: "same-origin" });
      if (res.ok) update((await res.json()) as RadioInfo);
    } catch { /* offline: try again on a later tick */ }
  }

  // Once a second: which slot should be playing, and is a crossfade due?
  function tick() {
    if (!should() || !radio) return;
    const now = Date.now();
    const { now: a, next: b, slotMs } = radio;
    let slot: Slot | null = null;
    if (now >= a.startedAt && now < a.startedAt + slotMs) slot = a;
    else if (now >= b.startedAt && now < b.startedAt + slotMs) slot = b;
    if (!slot) {
      void refresh(); // ran out of known slots
      return;
    }
    if (slot === b) void refresh(); // b is now the current one: learn the one after
    const key = `${slot.trackId}@${slot.startedAt}`;
    if (cur?.key !== key && !failed.has(key)) {
      // A crossfade already started into it counts: cur.key is the next slot's key.
      void play(slot, cur ? CROSSFADE_MS : 800);
      return;
    }
    const upcoming = slot === a ? b : null;
    if (upcoming && upcoming.startedAt - now <= CROSSFADE_MS) {
      const nk = `${upcoming.trackId}@${upcoming.startedAt}`;
      if (cur?.key !== nk && !failed.has(nk)) void play(upcoming, CROSSFADE_MS);
    }
  }
  const timer = setInterval(tick, 500);

  function update(r: RadioInfo, o: { changed?: boolean } = {}) {
    const modeChanged = !!radio && radio.mode !== r.mode;
    radio = r;
    if (modeChanged || o.changed) {
      // The jukebox was used: swap now with a short fade.
      if (should()) void play(r.now, SWITCH_FADE_MS);
    } else tick();
    emit();
  }

  function sync() {
    if (should()) { if (radio) tick(); else void refresh(); } else stopAll();
  }

  return {
    state,
    start() {
      pref = true;
      write(KEY_ON, "on");
      gestured = true; // called from the button, which is a gesture
      sync();
      emit();
    },
    stop() {
      pref = false;
      write(KEY_ON, "off");
      stopAll();
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      write(KEY_VOL, String(volume));
      for (const x of voices) x.apply();
      emit();
    },
    mute(m) {
      if (m === muted) return;
      muted = m;
      sync();
      emit();
    },
    gesture() {
      if (gestured) return;
      gestured = true;
      sync();
    },
    update,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      stopAll(0);
      listeners.clear();
    },
  };
}
