// The shop's sound effects: all synthesised with Web Audio, so there are no
// audio files to host or license (decision 0006). Nothing here makes a sound
// before `unlock()` has been called from a tap or key press, and nothing is ever
// the only signal for anything: every effect accompanies something on screen.

export type Sfx = {
  // Call from a user gesture; creates and resumes the audio context.
  unlock(): void;
  setEnabled(on: boolean): void;
  setVolume(v: number): void;
  // `gain` (0..1) lets other people's footsteps be quieter with distance.
  footstep(gain?: number): void;
  sit(): void;
  stand(): void;
  jump(): void;
  emote(gain?: number): void;
  needle(): void;
  clunk(): void;
  click(): void;
  destroy(): void;
};

const MASTER = 0.55;

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let enabled = true;
  let volume = 1;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const live = () => (enabled && ctx && ctx.state === "running" && master ? ctx : null);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  // One second of white noise, shared by every burst.
  function noiseBuf(c: AudioContext) {
    if (!noise) {
      noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  // A short filtered noise burst with an attack/decay envelope.
  function burst(c: AudioContext, at: number, o: { type: BiquadFilterType; freq: number; q?: number; dur: number; gain: number; attack?: number; sweepTo?: number }) {
    const src = c.createBufferSource();
    src.buffer = noiseBuf(c);
    const f = c.createBiquadFilter();
    f.type = o.type;
    f.frequency.setValueAtTime(o.freq, at);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, at + o.dur);
    f.Q.value = o.q ?? 1;
    const g = c.createGain();
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(o.gain, at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
    src.connect(f).connect(g).connect(master!);
    src.start(at, Math.random() * 0.5, o.dur + 0.05);
  }

  // A sine that falls (or rises) in pitch, for thumps and pops.
  function tone(c: AudioContext, at: number, o: { from: number; to: number; dur: number; gain: number; type?: OscillatorType }) {
    const osc = c.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.from, at);
    osc.frequency.exponentialRampToValueAtTime(o.to, at + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(o.gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
    osc.connect(g).connect(master!);
    osc.start(at);
    osc.stop(at + o.dur + 0.05);
  }

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const thud = (c: AudioContext, at: number, gain: number) => {
    tone(c, at, { from: 130, to: 52, dur: 0.14, gain });
    burst(c, at, { type: "lowpass", freq: 420, dur: 0.09, gain: gain * 0.7 });
  };

  return {
    unlock() {
      try {
        if (!ctx) {
          const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctor) return;
          ctx = new Ctor();
          master = ctx.createGain();
          master.gain.value = MASTER * volume;
          master.connect(ctx.destination);
        }
        if (ctx.state === "suspended") void ctx.resume();
      } catch {
        ctx = null;
      }
    },
    setEnabled(on) {
      enabled = on;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = MASTER * volume;
    },
    // A heel on boards: a dull knock plus a short band of "wood" noise, a little
    // different each time so a walk doesn't sound like a loop.
    footstep(gain = 1) {
      const c = live();
      if (!c || gain <= 0.02) return;
      const t = c.currentTime;
      tone(c, t, { from: rnd(110, 150), to: rnd(55, 70), dur: 0.07, gain: 0.22 * gain });
      burst(c, t, { type: "bandpass", freq: rnd(700, 1200), q: 1.4, dur: rnd(0.04, 0.07), gain: 0.16 * gain });
    },
    sit() {
      const c = live();
      if (!c) return;
      const t = c.currentTime;
      thud(c, t, 0.34);
      burst(c, t + 0.02, { type: "bandpass", freq: 260, q: 0.8, dur: 0.12, gain: 0.12 });
    },
    stand() {
      const c = live();
      if (!c) return;
      const t = c.currentTime;
      burst(c, t, { type: "bandpass", freq: 500, q: 1.2, dur: 0.16, gain: 0.1, attack: 0.03, sweepTo: 900 });
      tone(c, t + 0.1, { from: 120, to: 80, dur: 0.08, gain: 0.12 });
    },
    // A soft whoosh up, the landing thud as the hop comes down (650 ms).
    jump() {
      const c = live();
      if (!c) return;
      const t = c.currentTime;
      burst(c, t, { type: "bandpass", freq: 600, q: 0.7, dur: 0.22, gain: 0.07, attack: 0.08, sweepTo: 1800 });
      later(560, () => {
        const c2 = live();
        if (c2) thud(c2, c2.currentTime, 0.22);
      });
    },
    emote(gain = 1) {
      const c = live();
      if (!c || gain <= 0.02) return;
      const t = c.currentTime;
      tone(c, t, { from: 520, to: 880, dur: 0.09, gain: 0.12 * gain });
      tone(c, t + 0.07, { from: 880, to: 1040, dur: 0.07, gain: 0.07 * gain });
    },
    // The needle landing on a record: one soft bump, then a few seconds of dust.
    needle() {
      const c = live();
      if (!c) return;
      const t = c.currentTime;
      thud(c, t, 0.16);
      burst(c, t + 0.02, { type: "highpass", freq: 3000, dur: 0.05, gain: 0.2 });
      for (let i = 0; i < 38; i++) {
        const at = t + 0.12 + Math.pow(Math.random(), 0.7) * 1.7;
        burst(c, at, { type: "highpass", freq: rnd(2500, 6000), dur: rnd(0.004, 0.012), gain: rnd(0.04, 0.16), attack: 0.001 });
      }
      burst(c, t + 0.1, { type: "highpass", freq: 4500, dur: 1.7, gain: 0.012, attack: 0.3 });
    },
    // The jukebox changing a record: a heavy clunk and a mechanical click.
    clunk() {
      const c = live();
      if (!c) return;
      const t = c.currentTime;
      tone(c, t, { from: 95, to: 45, dur: 0.18, gain: 0.34, type: "triangle" });
      burst(c, t, { type: "lowpass", freq: 700, dur: 0.1, gain: 0.25 });
      burst(c, t + 0.16, { type: "bandpass", freq: 1800, q: 3, dur: 0.03, gain: 0.12 });
    },
    click() {
      const c = live();
      if (!c) return;
      tone(c, c.currentTime, { from: 1900, to: 1500, dur: 0.03, gain: 0.07 });
    },
    destroy() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      void ctx?.close().catch(() => {});
      ctx = null;
      master = null;
    },
  };
}
