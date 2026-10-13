// Placeholder avatar: a circle with the first letter of the name, coloured
// deterministically from the name using only design tokens (the pairs live in
// global.css as .av-0 to .av-4). A later phase replaces this with real
// avatars, so everything about it stays in this one small module.
const SLOTS = 5;

export function avatarSlot(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % SLOTS;
}

export function avatarInitial(name: string): string {
  return ([...name.trim()][0] ?? "?").toUpperCase();
}

export function avatar(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `avatar av-${avatarSlot(name)}`;
  el.setAttribute("aria-hidden", "true");
  el.textContent = avatarInitial(name);
  return el;
}
