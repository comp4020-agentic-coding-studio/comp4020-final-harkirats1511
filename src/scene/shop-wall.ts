// The 2D twins of the shop's memory: the wall's sleeves, the liner notes of a
// round, and the jukebox, shared by the 2D lists and the 3D sheet so the two
// say the same thing. Markup from public data only (see shop-types.ts).
import { esc } from "./shop-list.ts";
import { MOOD_HINT, MOOD_NAME, type Jukebox, type Play, type Sleeve } from "./shop-types.ts";

const possessive = (name: string) => `${name}${/s$/i.test(name) ? "'" : "'s"}`;
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// Who the moles were and whether the room caught them, in words.
export function moleLine(s: Sleeve): string {
  const who = s.moles.length ? list(s.moles) : "";
  const one = s.moles.length <= 1;
  if (s.caught) {
    const base = who ? `Caught: ${who}${one ? " was the mole" : " were the moles"}.` : "The room caught the mole.";
    if (s.stole === true) return `${base} Then ${one ? "they" : "one of them"} guessed the prompt, and the moles took it.`;
    if (s.stole === false) return `${base} The steal missed.`;
    return base;
  }
  return who ? `Got away: ${who}${one ? " was the mole" : " were the moles"}.` : "The mole got away.";
}

export const pickLine = (p: Sleeve["picks"][number]) => `${p.picker}${p.lender ? ` (borrowed from ${p.lender})` : ""}: ${p.title}, ${p.artist}`;

// A round's liner notes: the prompt, the picks with pickers, the moles, the best card.
export function linerNotes(s: Sleeve, opts: { heading?: "h3" | "h4" } = {}): string {
  const h = opts.heading ?? "h3";
  const best = s.picks.find((p) => p.best);
  return `<div class="wall-notes">
  <p class="wall-notes-k mono">BOOTH ${esc(s.table)} · ${s.format === "four" ? "Four rounds" : "Knockout"} · round ${s.round} · <time datetime="${new Date(s.revealedAt).toISOString()}">${ago(s.revealedAt)}</time></p>
  <p class="wall-notes-prompt"><span class="sr-only">The prompt: </span><span class="hand">${esc(s.prompt)}</span></p>
  <p class="wall-notes-mood mono">${MOOD_NAME[s.mood].toUpperCase()}: ${MOOD_HINT[s.mood]}</p>
  <${h} class="wall-notes-h">Picks</${h}>
  <ol class="wall-picks">${s.picks.map((p) => `<li${p.best ? ' class="best"' : ""}><span class="who">${esc(p.picker)}${p.lender ? ` <small>borrowed from ${esc(p.lender)}</small>` : ""}</span><span class="what"><b>${esc(p.title)}</b> ${esc(p.artist)}</span>${p.best ? '<span class="stamp best-stamp">Best pick</span>' : ""}</li>`).join("") || "<li>Nobody picked.</li>"}</ol>
  <p class="wall-notes-moles">${s.caught ? '<span class="stamp moles">Caught</span> ' : ""}${esc(moleLine(s))}</p>
  ${best ? `<p class="wall-notes-best">Best pick: <b>${esc(best.title)}</b>, ${esc(possessive(best.picker))} pick${best.lender ? ` (borrowed from ${esc(best.lender)})` : ""}.</p>` : ""}
</div>`;
}

// The sleeve's face: the best card's (or first pick's) cover, or a plain sleeve
// in the mood's colour, with the prompt on a staff-pick card.
function face(s: Sleeve): string {
  const art = (s.picks.find((p) => p.best && p.cover) ?? s.picks.find((p) => p.cover))?.cover;
  return `<span class="wall-face mood-${s.mood}" aria-hidden="true">${art ? `<img src="${esc(art)}" alt="" width="120" height="120" loading="lazy">` : '<span class="wall-ring"></span>'}<span class="wall-mood mono">${MOOD_NAME[s.mood].toUpperCase()}</span></span>`;
}

// One sleeve on the wall: a button that opens its liner notes (the dialog on the
// shop page, which the 3D wall opens too).
export function wallItem(s: Sleeve, opts: { fresh?: boolean } = {}): string {
  const label = `${s.prompt}. ${MOOD_NAME[s.mood]}, booth ${s.table}, round ${s.round}, ${s.picks.length} ${s.picks.length === 1 ? "pick" : "picks"}. ${s.caught ? "Mole caught" : "Mole got away"}`;
  return `<li class="wall-item${opts.fresh ? " fresh" : ""}" data-id="${esc(s.id)}">
  <button type="button" class="wall-sleeve" data-wall="${esc(s.id)}" aria-haspopup="dialog" aria-label="${esc(label)}">${face(s)}<span class="wall-card" aria-hidden="true"><span class="hand">${esc(s.prompt)}</span><span class="wall-meta mono">${esc(s.table)} · R${s.round}${s.caught ? " · CAUGHT" : ""}</span></span></button>
</li>`;
}

export function wallList(sleeves: Sleeve[]): string {
  return sleeves.map((s) => wallItem(s)).join("\n");
}

// ---- the jukebox ----
export const msLeft = (p: Play, now = Date.now()) => Math.max(0, (p.startedAt ?? now) + p.ms - now);
export const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const playSay = (p: Play) => `${p.title} by ${p.artist}, picked by ${p.picker}`;

export function nowPlaying(j: Jukebox): string {
  const p = j.now;
  if (!p) return `<p class="juke-idle">Nothing queued, so the radio plays. Queue a song from your crate and the whole shop hears it, with your name on it.</p>`;
  return `<div class="juke-now">
  <span class="juke-art" aria-hidden="true">${p.cover ? `<img src="${esc(p.cover)}" alt="" width="64" height="64">` : '<span class="wall-ring"></span>'}</span>
  <div class="juke-meta">
    <p class="juke-by mono">Picked by ${esc(p.picker)}</p>
    <p class="juke-title"><b>${esc(p.title)}</b> <span>${esc(p.artist)}</span></p>
    <p class="juke-left mono"><span data-juke-left>${clock(msLeft(p))}</span> left</p>
  </div>
</div>`;
}

export function queueList(j: Jukebox): string {
  if (!j.queue.length) return "";
  return `<h3 class="juke-q-h">Up next</h3><ol class="juke-queue">${j.queue.map((p) => `<li><b>${esc(p.title)}</b>, ${esc(p.artist)} <span class="mono">picked by ${esc(p.picker)}</span></li>`).join("")}</ol>`;
}
