import { defineMiddleware } from "astro:middleware";
import { resumeGames } from "./lib/game.ts";

// Runs once when the server loads, before any request: re-arm the timer of
// every game that was mid-phase when the process last stopped.
resumeGames();

export const onRequest = defineMiddleware((_context, next) => next());
