// One token bucket for every call this server makes to Deezer. Deezer allows about
// 50 requests per 5 s per IP; we aim at 40. A call is let through when fewer than
// `limit - reserve[priority]` calls were made in the last window, so the lower the
// priority, the sooner it is held back and the more room is left for the ones above
// it: a game in progress (card audio, previews) never waits behind a starter.
export type Priority = "card" | "normal" | "suggest" | "background";

export type BucketOptions = { limit: number; windowMs: number; reserve: Record<Priority, number> };

export class Bucket {
  private stamps: number[] = [];
  private pausedUntil = 0;
  private o: BucketOptions;
  constructor(o: BucketOptions) {
    this.o = o;
  }

  private used(now: number): number {
    const cut = now - this.o.windowMs;
    while (this.stamps.length && this.stamps[0] <= cut) this.stamps.shift();
    return this.stamps.length;
  }

  // Calls made in the window now (for tests and logs).
  inWindow(): number {
    return this.used(Date.now());
  }

  // Takes a slot now if the priority allows it.
  tryTake(priority: Priority): boolean {
    const now = Date.now();
    if (priority !== "card" && now < this.pausedUntil) return false;
    if (this.used(now) >= this.o.limit - this.o.reserve[priority]) return false;
    this.stamps.push(now);
    return true;
  }

  // Deezer itself said "too fast": everything but card audio holds off for a moment.
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  // Waits up to maxWaitMs for a slot; false means give up (the caller says "busy").
  async take(priority: Priority, maxWaitMs: number): Promise<boolean> {
    const until = Date.now() + maxWaitMs;
    for (;;) {
      if (this.tryTake(priority)) return true;
      const now = Date.now();
      // The next slot opens when the call that sits at the threshold leaves the window.
      const room = this.o.limit - this.o.reserve[priority];
      const idx = this.stamps.length - Math.max(1, room);
      const opens = (this.stamps[Math.max(0, idx)] ?? now) + this.o.windowMs;
      const wait = Math.max(10, Math.min(Math.max(opens, this.pausedUntil) - now, 250));
      if (now + wait > until) return false;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export const DEEZER_BUCKET = new Bucket({
  limit: 40,
  windowMs: 5000,
  // card 40 of 40, normal 35, suggest 30, background 24
  reserve: { card: 0, normal: 5, suggest: 10, background: 16 },
});

// How long each class waits for a slot before giving up. Search and add (normal) wait the longest of
// the people-facing calls: the bucket still never lets more than 40 calls into any 5 s window (Deezer
// allows 50), so waiting longer costs a person a few seconds, never a quota error.
export const MAX_WAIT: Record<Priority, number> = { card: 2000, normal: 6000, suggest: 5000, background: 800 };
