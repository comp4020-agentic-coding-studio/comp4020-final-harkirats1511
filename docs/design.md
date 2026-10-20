# Design system: a record shop after hours

Chosen direction (the student's pick, replacing the earlier zine): the app is a
record shop at night. The home page is the shopfront under a neon sign, tables
are listening booths, your theme is a handwritten staff-pick card, tracks are
white-label records, and the reveal is the liner notes on a back cover. The
approved reference is `docs/design/record-shop.html` (and `shop-floor-3d.html`
for the later 3D shop). One theme, dark by design, native CSS, no framework.

## Tokens (`src/styles/global.css`)

- `--wall` #1B1420 page, `--wall-2` #261C2C panels, `--wall-3` #34283C disabled and
  sunk, `--rule` #4A3B4E hairlines, `--line` #85728C control borders.
- `--lamp` #F4B860 the accent: primary buttons, focus ring, highlights, timers
  (10.2:1 on the wall). Text on a lamp fill is `--ink` #1B1420.
- `--neon` #FF4F8B only the sign, and the mole (the stamp, the 3D mole stamp).
  `--neon-ink` #A81C55 is the same idea on paper (5.8:1 on `--sleeve`).
- `--sleeve` #EFE7D7 paper: the membership card, the staff pick, liner notes,
  past games, the table-code ticket. `--ink-2` #5B4E4A secondary text on paper (6.5:1).
- `--text` #F3EADB, `--muted` #B9A9B8 (7.3:1 on `--wall-2`), `--wood` #7A5333,
  `--bad` #FF9A8B and `--ok` #9AD9A8 for refusals and saved states.
- `color-scheme: dark`; there is no light mode and no theme switch. Every
  text pair is at least 4.5:1; check any new pair.

## Type (self-hosted through Fontsource, no Google Fonts)

- **Bungee**: the sign and logo only (the O is a record), plus the big stamp.
- **Bricolage Grotesque** (variable): all UI text and headings.
- **IBM Plex Mono**: catalogue numbers and codes (`BOOTH KGZW`, `A1`), timers,
  small mono-caps labels (phase names, `h3`).
- **Caveat**: handwriting only: the staff-pick theme and the pressing notes.

## Components

- **Panel (`.card`)**: wall-2, 14px radius, 1.5px inset rule. Paper things add
  `.paper` (sleeve fill, ink text, a soft lift).
- **Button**: lamp pill, ink text, 48px high. Secondary: ghost with a 1.5px line.
  On paper: ink pill. Disabled: wall-3 with muted text.
- **Inputs**: dark well with a line border; on paper just a line to write on.
- **Membership card**: the sign-in form, paper, tilted 1deg, perforated stripe.
- **Hours card**: dashed mono box under the sign (static copy; no new queries).
- **Staff pick**: your theme on a sleeve card with tape, handwritten, tilted;
  Hide flips it to a wood back that is the same for everyone.
- **Your crate**: the pick panel is a wooden crate; tracks are rows with a
  record peeking from the cover.
- **Needle drop** (listen): sleeve, plinth, platter, record, tonearm in CSS.
  A slot that starts playing replays the drop; the label shows only side and
  track (A1, A2, B1...) derived from the slot number, never a title, artist,
  owner or cover. Slots are sleeves (A1, B2...) the host can press.
- **Liner notes**: reveal and game over are a paper back cover: tracklist with
  owners, a MOLE stamp when the ejected person was a mole, and at game end the
  themes as handwritten pressing notes. Past games reuse it as record-shelf cards.
- **Stamp**: mono caps, 2px border, rotated a few degrees: HOST, OUT, WATCHING,
  AUTO, MOLE. Colour is never the only signal; each carries words.
- **Ticket**: the table code on a sleeve with punched notches, in mono.
- **Avatar**: the drawn badge with a wall ring; mobility aids are a small drawn
  mark, not an icon font.

## Motion

Only motivated motion: the needle drop and spinning record (state), phase panels
sliding in, reveal sleeves dealt out, press scale on buttons. Transform and
opacity only. Under `prefers-reduced-motion` everything stops: the record just
sits on the platter with the arm down.

## Do / don't

- Do use paper for things that are paper, the wall for everything else, lamp for
  action. Do set codes, counts and timers in mono, themes and notes in Caveat.
- Don't use neon for anything but the sign and the mole. Don't use emoji or an
  icon font. Don't add gradients on surfaces (the wall glow and wood grain are
  the only ones), drop shadows other than the paper lift, or card-in-card stacks.
- Don't show a theme other than your own, a role, a title or owner before the
  reveal, or who has picked or voted; the look never changes what is shown.
- No em or en dashes in visible copy. Plain, warm, short.

## Layout

Phone first (390px), 16px gutters, no horizontal scroll. Home becomes sign on the
left and forms on the right from 52rem; the table page is two columns from
1024px with the 3D scene (a decoration) at the top of the game column.
Tap targets are at least 44px; focus is a 3px lamp ring (ink on paper).
