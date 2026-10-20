// The 2D booth list's markup, shared by the server render and the browser so the
// two cannot drift. Public booth state only (the Booth type): a private booth
// has no code here, so none can reach the HTML.
import type { Booth } from "../lib/booths.ts";

export const REPORT_REASONS = ["rude names", "spam", "trolling the game", "something else"];

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function boothItem(b: Booth, i: number): string {
  const full = b.seated >= b.max;
  const status = b.status === "playing" ? `Playing${b.round ? `, round ${b.round}` : ""}` : "Waiting for players";
  const seats = `${b.seated}/${b.max} seated`;
  const id = `bk-${i}`;
  if (b.private || !b.code) {
    return `<li class="shop-booth" data-key="private-${i}">
  <div class="shop-booth-head"><h3>Private booth</h3><span class="shop-pill dim">Code only</span></div>
  <p>${esc(b.host)} is hosting. ${seats}. ${status}.</p>
  <form class="shop-knock" data-form="knock" novalidate>
    <label for="${id}-code">Booth code</label>
    <div class="shop-inline">
      <input id="${id}-code" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" data-key="private-${i}-code">
      <button type="submit" class="secondary">Knock</button>
    </div>
    <p class="shop-msg" role="status"></p>
  </form>
</li>`;
  }
  return `<li class="shop-booth" data-key="${b.code}">
  <div class="shop-booth-head"><h3>Booth ${esc(b.code)}</h3><span class="shop-pill">Open to anyone</span></div>
  <p>${esc(b.host)}'s table. ${seats}. ${status}.${b.status === "playing" ? " You would join the next game." : ""}</p>
  <div class="shop-actions">
    <button type="button" data-act="sit" data-code="${b.code}"${full ? " disabled" : ""}>Take a seat</button>
    <details class="shop-report">
      <summary>Report</summary>
      <form data-form="report" data-code="${b.code}" novalidate>
        <label for="${id}-why">Reason</label>
        <select id="${id}-why" name="reason" data-key="${b.code}-why">${REPORT_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select>
        <button type="submit" class="secondary sm">Send report</button>
      </form>
    </details>
  </div>
  <p class="shop-msg" role="status"></p>
</li>`;
}

export function boothList(list: Booth[]): string {
  return list.length ? list.map(boothItem).join("\n") : `<li class="shop-empty">No booths are open. Start a table from the home page and it appears here.</li>`;
}
