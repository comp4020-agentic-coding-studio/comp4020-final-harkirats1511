// A bot's crate: 12 songs, 3 per mood, kept on the bot's own row (taste_tracks) so it is
// built once and every later game reuses it. Built from Deezer's public search with a small
// budget (a few calls per crate, a few dozen an hour for the whole server); when the budget is
// spent or Deezer is down it takes a ready-made crate from seed.ts instead, so a bot is never
// stuck without one. Preview-less and explicit songs are skipped, as for people.
import { addTaste, crateComplete, listTaste } from "../taste.ts";
import { SLOTS, type Slot } from "../prompts.ts";
import { searchClean } from "../deezer.ts";
import { log } from "../log.ts";
import { GENRES } from "./names.ts";
import { SEED_CRATES } from "./seed.ts";

const SLOT_WORDS: Record<Slot, string> = { up: "dance anthem", down: "sad piano", out: "party", in: "lofi chill" };
// Deezer calls for the whole server: at most this many in an hour, one at a time, spaced out.
const BUDGET_PER_HOUR = 40;
const SPACING_MS = 500;
const calls: number[] = [];
let chain: Promise<unknown> = Promise.resolve();

const budgetLeft = () => {
  const cut = Date.now() - 3_600_000;
  while (calls.length && calls[0] < cut) calls.shift();
  return BUDGET_PER_HOUR - calls.length;
};

type Hit = { id: number; title: string; artist: string; cover?: string };

// Through the server's one Deezer bucket, at the lowest priority: a bot's crate waits (or gives
// up, and the seed crate is used) rather than take a slot a person or a game needs. The same
// clean filter as for people: a preview, neither explicit flag, no slur.
async function search(q: string): Promise<Hit[]> {
  const run = async () => {
    calls.push(Date.now());
    try {
      return (await searchClean(q, 50)).map((t) => ({ id: t.id, title: t.title, artist: t.artist, cover: t.cover }));
    } catch {
      return [];
    } finally {
      await new Promise((r) => setTimeout(r, SPACING_MS));
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

// Sorts a bot's songs until every mood has 3. `index` picks its genre word and its fallback crate.
export async function buildCrate(personId: string, name: string, index: number): Promise<boolean> {
  const have = (slot: Slot) => listTaste(personId).filter((t) => t.slot === slot).length;
  const genre = GENRES[index % GENRES.length];
  let searched = 0;
  for (const slot of SLOTS) {
    if (have(slot) >= 3) continue;
    if (budgetLeft() > 0) {
      searched++;
      for (const hit of await search(`${genre} ${SLOT_WORDS[slot]}`)) {
        if (have(slot) >= 3) break;
        addTaste(personId, { id: hit.id, title: hit.title, artist: hit.artist, cover: hit.cover }, slot);
      }
    }
  }
  if (!crateComplete(personId)) {
    // Fill what is missing from the seed crate (songs it already has are skipped).
    const seed = SEED_CRATES[index % SEED_CRATES.length];
    for (const [i, [id, title, artist, cover]] of seed.entries()) {
      const slot = SLOTS[Math.floor(i / 3)];
      if (have(slot) < 3) addTaste(personId, { id, title, artist, cover: cover || undefined }, slot);
    }
  }
  const ok = crateComplete(personId);
  log("bots", `${name} crate ${ok ? "ready" : "incomplete"} · ${searched} search${searched === 1 ? "" : "es"}, ${Math.max(0, budgetLeft())} left this hour`);
  return ok;
}
