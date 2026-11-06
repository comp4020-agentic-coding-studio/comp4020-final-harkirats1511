import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { sayRefused, skipSong } from "../../../../lib/jukebox.ts";
import { actedTooFast } from "../../../../lib/limits.ts";
import { refused, tag } from "../../../../lib/log.ts";

// One skip per person per play, from someone on the floor; enough of them start the next song.
export const POST: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    sayRefused(null, "skip", "not signed in", () => refused("shop", null, "skip the jukebox song", "not signed in"));
    return json({ error: "Sign in first." }, 401);
  }
  // At most 5 a second per person, like picks and votes (logged once a minute).
  if (actedTooFast(`${me.id}:jukebox-skip`, () => refused("shop", tag(me), "skip the jukebox song", "too many requests in a second"))) return json({ error: "Slow down." }, 429);
  const res = skipSong(me);
  return res.ok ? json({ skips: res.skips, needed: res.needed }) : json({ error: res.error }, res.status);
};
