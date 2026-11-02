import { defineMiddleware } from "astro:middleware";
import { resumeGames } from "./lib/game.ts";
import { guardProcess } from "./lib/log.ts";
import { resumeBots } from "./lib/bots/seats.ts";

// Astro loads this on the server's first request, before handling it: re-arm
// the timer of every game that was mid-phase when the process last stopped, and
// apply any deadline that passed while it was down. On Fly a stopped machine
// only starts because a request arrived, so that is never later than needed.
guardProcess();
resumeGames();
// Bots are driven by table changes; at boot, bots left without a person go home and the rest carry on.
resumeBots();

export const onRequest = defineMiddleware((_context, next) => next());
