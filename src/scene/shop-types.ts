// What the shop shows from the room's shared memory (decision 0011), as the
// stage 5 contract defines it. Public data only: the wall is what reveals
// already showed, the jukebox is what anyone on the floor hears, and a booth's
// round is what anyone at that table could see.
import type { Booth } from "../lib/booths.ts";

export type Mood = "up" | "down" | "out" | "in";
export const MOOD_NAME: Record<Mood, string> = { up: "Up", down: "Down", out: "Out", in: "In" };
export const MOOD_HINT: Record<Mood, string> = { up: "energy, hype", down: "sad, slow", out: "going out, social", in: "alone, cosy" };

export type SleevePick = { picker: string; lender?: string; trackId: number; title: string; artist: string; cover?: string; best?: boolean };
export type Sleeve = {
  id: string;
  table: string;
  format: "knockout" | "four";
  round: number;
  revealedAt: number;
  prompt: string;
  mood: Mood;
  picks: SleevePick[];
  moles: string[];
  caught: boolean;
  stole?: boolean;
  escaped?: string[];
  moleCount?: number;
};
export type WallPage = { sleeves: Sleeve[]; more: boolean };

export type Play = { id: string; trackId: number; title: string; artist: string; cover?: string; picker: string; startedAt?: number; ms: number };
export type Jukebox = { now: Play | null; queue: Play[]; skips: number; needed: number };

export type Phase = "pick" | "listen" | "vote" | "steal" | "reveal";
// A booth as the shop stream sends it, with the round you can see into.
export type SeenBooth = Booth & {
  phase?: Phase;
  mood?: Mood;
  format?: "knockout" | "four";
  playing?: { title: string; artist: string; picker: string };
  votes?: number;
};
