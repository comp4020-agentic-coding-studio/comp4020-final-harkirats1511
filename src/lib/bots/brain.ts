// The bots' decisions, as pure functions of what a real player is given: their own
// /me view and the public table state (members and their crates, the round's cards,
// the tally). Nothing here reads a database, a prompt list or a role, so it cannot
// know what a player could not: a bot that is the mole is handed a view with no
// prompt, and a pick made this round is not in anything it receives.
//
// It is shared by the server's bot driver (driver.ts) and by scripts/bots.ts, so it
// has no imports and runs under Node's type stripping as well as in the server.

export type Slot = "up" | "down" | "out" | "in";
// The parts of GET /api/tables/:code/me a bot may use.
export type MeView = {
  role: string;
  slot?: Slot;
  picked?: boolean;
  borrowUsed: boolean;
  played: number[];
  steal?: { options: { id: string; text: string }[] };
};
// The parts of the public table state a bot may use (the same JSON every stream carries).
export type Pub = {
  members: { name: string; crate?: { trackId: number; title?: string; slot: Slot | null }[] }[];
  game?: {
    format?: string;
    phase?: string;
    deadline?: number | null;
    tally?: { name: string }[];
    cards?: { order?: number; picker: string; lender?: string; trackId: number; title?: string; artist?: string }[];
  };
};
export type Rand = () => number;

const pickOne = <T>(xs: T[], rand: Rand): T | undefined => xs[Math.floor(rand() * xs.length)];

// Prefers an unplayed song of the round's mood (a mole only knows the mood too);
// about one round in five, once per game, borrows from someone else's crate instead
// (or when its own crate has nothing left).
export function decidePick(me: MeView, self: string, pub: Pub, rand: Rand = Math.random): { trackId: number; from?: string } | null {
  const heard = new Set(me.played);
  const fresh = <T extends { trackId: number }>(c: T[]) => c.filter((t) => !heard.has(t.trackId));
  const own = fresh(pub.members.find((m) => m.name === self)?.crate ?? []);
  const lenders = pub.members.filter((m) => m.name !== self && fresh(m.crate ?? []).length > 0);
  const borrow = () => {
    if (me.borrowUsed) return null;
    const lender = pickOne(lenders, rand);
    if (!lender) return null;
    const open = fresh(lender.crate ?? []);
    const song = pickOne(open.filter((t) => t.slot === me.slot), rand) ?? pickOne(open, rand);
    return song ? { trackId: song.trackId, from: lender.name } : null;
  };
  if (rand() < 0.2) {
    const b = borrow();
    if (b) return b;
  }
  const song = pickOne(own.filter((t) => t.slot === me.slot), rand) ?? pickOne(own, rand);
  if (song) return { trackId: song.trackId };
  return borrow();
}

// Votes with a little sense: a player whose song is not in the round's mood (by the
// crate it was picked from: the picker's, or the lender's) is the likeliest bluffer, and
// someone who missed the pick a little less so; with nothing to go on, a random name, or
// now and then a skip.
export function decideVote(me: MeView, self: string, pub: Pub, rand: Rand = Math.random): { name: string } | "skip" {
  const others = (pub.game?.tally ?? []).map((t) => t.name).filter((n) => n !== self);
  if (!others.length) return "skip";
  const cards = pub.game?.cards ?? [];
  const moodOf = (owner: string, trackId: number) => pub.members.find((m) => m.name === owner)?.crate?.find((t) => t.trackId === trackId)?.slot ?? null;
  const offMood = others.filter((n) => {
    const c = cards.find((x) => x.picker === n);
    if (!c || !me.slot) return false;
    const mood = moodOf(c.lender ?? c.picker, c.trackId);
    return mood !== null && mood !== me.slot;
  });
  if (offMood.length) return { name: pickOne(offMood, rand)! };
  const silent = others.filter((n) => !cards.some((x) => x.picker === n));
  if (cards.length && silent.length && rand() < 0.5) return { name: pickOne(silent, rand)! };
  return rand() < 0.15 ? "skip" : { name: pickOne(others, rand)! };
}

// Four rounds' best pick: a card that isn't its own (picked or lent by the bot), preferring
// the ones most on-mood (the song's crate slot is the round's mood). The order of the card.
export function decideBest(me: MeView, self: string, pub: Pub, rand: Rand = Math.random): number | null {
  const cards = (pub.game?.cards ?? []).filter((c) => c.picker !== self && c.lender !== self && typeof c.order === "number");
  if (!cards.length) return null;
  const moodOf = (c: { picker: string; lender?: string; trackId: number }) => pub.members.find((m) => m.name === (c.lender ?? c.picker))?.crate?.find((t) => t.trackId === c.trackId)?.slot ?? null;
  const onMood = cards.filter((c) => me.slot && moodOf(c) === me.slot);
  return pickOne(onMood.length ? onMood : cards, rand)!.order!;
}

// A ghost's private guess (Knockout): the same reading of the table as a vote, but always a name.
export function decideGuess(me: MeView, self: string, pub: Pub, rand: Rand = Math.random): string | null {
  const v = decideVote(me, self, pub, rand);
  if (v !== "skip") return v.name;
  const others = (pub.game?.tally ?? []).map((t) => t.name).filter((n) => n !== self);
  return pickOne(others, rand) ?? null;
}

// A voted-out mole's guess: the option sharing the most words with the songs that
// just played (a weak hint, since they were picked for the prompt), else any.
export function decideSteal(me: MeView, pub: Pub, rand: Rand = Math.random): string | null {
  const options = me.steal?.options ?? [];
  if (!options.length) return null;
  const heard = (pub.game?.cards ?? []).map((c) => `${c.title ?? ""} ${c.artist ?? ""}`.toLowerCase()).join(" ");
  const score = (text: string) => text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 3 && heard.includes(w)).length;
  const best = Math.max(...options.map((o) => score(o.text)));
  return pickOne(options.filter((o) => score(o.text) === best), rand)!.id;
}

// Human-like waiting: a random time in [lo, hi] seconds, never more than 60% of
// what is left before the deadline, so a short table still hears from its bots.
export function thinkMs(lo: number, hi: number, deadline: number | null, now = Date.now(), rand: Rand = Math.random): number {
  let ms = (lo + rand() * (hi - lo)) * 1000;
  if (deadline !== null) ms = Math.min(ms, Math.max(0, deadline - now) * 0.6);
  return Math.max(0, ms);
}
export const DELAYS = { pick: [3, 12], vote: [4, 14], steal: [2, 8], rematch: [2, 6] } as const;
