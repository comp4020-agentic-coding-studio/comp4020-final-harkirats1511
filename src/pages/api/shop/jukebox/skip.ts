import type { APIRoute } from "astro";
import { json, personFromCookies } from "../../../../lib/auth.ts";
import { skipSong } from "../../../../lib/jukebox.ts";
import { refused } from "../../../../lib/log.ts";

// One skip per person per play, from someone on the floor; enough of them start the next song.
export const POST: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) {
    refused("shop", null, "skip the jukebox song", "not signed in");
    return json({ error: "Sign in first." }, 401);
  }
  const res = skipSong(me);
  return res.ok ? json({ skips: res.skips, needed: res.needed }) : json({ error: res.error }, res.status);
};
