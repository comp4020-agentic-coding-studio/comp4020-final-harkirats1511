# Design system: record-shop zine

Chosen direction (student's pick, 14 Oct): a record-shop zine. The game should
feel like a flyer stapled to a gig noticeboard: bold cut-out type, newsprint,
one loud ink colour, things that look pasted on. Phone-first, played with
friends in one room.

Design read: a phone-first party game for a friend group, in a handmade
print/zine language, built with native CSS on Astro (no framework).
Dials: variance 7, motion 4, density 4.

## Tokens (CSS custom properties on `:root`)

Light ("newsprint"), the default:
- `--paper` #F2EFE6 (page), `--paper-2` #E6E1D3 (sunk panels), `--card` #FBFAF6
- `--ink` #16161A (text, borders, hard shadows), `--ink-2` #45434A (secondary)
- `--accent` #F0477E (riso pink fill: primary buttons, the theme card, highlights)
- `--accent-ink` #16161A (text on an accent fill: 5.08:1)
- `--accent-text` #C21F57 (pink used AS text on paper/card: 5.04:1. Never put
  `--accent` itself on paper as text; it is 3.6:1)
- `--accent-2` #1A5FCC (riso blue, 5.14:1 on paper: used ONLY as the second print layer in
  overprint/misregistration effects and the "playing now" state, never a
  second button colour)
- `--ok` #17703F (5.33:1), `--bad` #C2272D (5.04:1) (for real state only: errors, the mole reveal)

Dark ("night print"): under `prefers-color-scheme: dark` and
`[data-theme="dark"]`, with `:root:not([data-theme="light"])` guarding the media
query:
- `--paper` #17161B, `--paper-2` #201F26, `--card` #24232B
- `--ink` #F2EFE6, `--ink-2` #B9B5AA, `--accent` #FF5C8A, `--accent-ink` #17161B,
  `--accent-text` #FF5C8A (6.13:1 on paper)
- `--accent-2` #5B9BFF, `--ok` #4CC38A, `--bad` #FF6B6B (check both on paper)
Body always sets an explicit `background: var(--paper)` and `color: var(--ink)`.

Every text/background pair must pass WCAG AA (4.5:1 body, 3:1 for 18px+ bold).
The light-mode values above were measured; the first draft's pink (#E8336D)
failed with ink (4.40:1) and was replaced. Check any new pair, don't assume.

## Type

- Display: **Archivo Black** (`@fontsource/archivo-black`), uppercase allowed
  only for short labels and headings, tight tracking (`-0.01em`), leading 1.0-1.1.
- Body/UI: **Archivo** variable (`@fontsource-variable/archivo`), including its
  condensed width axis for stamps and tags.
- Numbers, codes, timers: **JetBrains Mono** variable.
- Self-hosted via the Fontsource packages, `font-display: swap`. No Inter, no
  serif, no Google Fonts link.
- Scale (rem): 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.5 / 3.5. Table code and the
  theme text use the top steps.

## Shape and depth

- Corners: **sharp** (radius 0) everywhere, except avatars (circle) and the
  sticker motif (circle). No other radii.
- Borders: 2px solid `var(--ink)` on cards, inputs, buttons.
- Shadows: hard offset, no blur, ink-coloured: `4px 4px 0 var(--ink)` on cards,
  `3px 3px 0` on buttons. Pressed: translate(3px, 3px) and shadow 0 (a physical
  push). Never a soft blurred shadow.
- Texture: one fixed, `pointer-events: none` grain overlay (an inline SVG
  feTurbulence as a CSS background on `body::before`, ~6% opacity, mix-blend
  multiply in light, screen in dark). Never on scrolling elements.
- Cut-out details: slight rotation (-1.5deg to 2deg) on a FEW elements only
  (the theme card, stamps, the table code), never on body text or forms.
  Tape strips (a translucent rectangle at a card's top edge) on the theme card
  only.

## Components

- **Button (primary)**: accent fill, accent-ink text, 2px ink border, hard
  shadow, Archivo Black, min height 48px, full-width on phones in forms. 
  **Secondary**: card fill, ink text. **Disabled**: paper-2 fill, ink-2 text,
  no shadow, not-allowed cursor, plus visible text explaining why when it
  matters.
- **Card**: card fill, 2px ink border, 4px hard shadow, 16-20px padding.
- **Stamp**: condensed uppercase Archivo, ink border, slight rotation, used for
  states: HOST, OUT, WATCHING, PICKED, MOLE, CAUGHT.
- **Ticket**: the table code, set in JetBrains Mono at display size inside a
  perforated-edge ticket shape (CSS mask or dashed border), rotated slightly.
- **Theme card**: the hero of every round. Accent background, huge display text,
  tape strip, a "Hide" toggle that flips it face-down (a paper-2 back with a
  repeating "MOLE" pattern), honoring reduced motion.
- **Track slot**: a vinyl-sleeve square (card with a circle "record" peeking
  out), big number. Playing state: the record spins (CSS rotate, disabled under
  reduced motion) and the sleeve gets the accent-2 overprint.
- **Inputs**: label above, 2px ink border, card fill, 48px height, focus ring
  3px accent with offset. No placeholder-as-label.
- **Timer**: JetBrains Mono, large, ink; under 10 s it turns accent.
- Icons: Phosphor (`@phosphor-icons/web`, one weight: bold). No emoji. No
  hand-drawn SVG icons.

## Motion (intensity 4)

Only motivated motion: phase changes slide/flip the main card in (feedback that
the round moved on), the reveal deals the track sleeves out one by one
(storytelling), button press push (feedback), the playing record spins (state).
CSS transitions/animations on transform and opacity only,
`cubic-bezier(0.16, 1, 0.3, 1)`, 200-450ms. Everything collapses to instant under
`prefers-reduced-motion: reduce`.

## Copy rules

- No em dashes or en dashes anywhere visible. Use full stops, commas, colons.
- Plain, warm, short. One instruction per screen, at the top.
- No AI filler ("elevate", "seamless"), no fake numbers.

## Layout

- Phone first (375px), single column, 16px gutters, no horizontal scroll ever.
- Desktop (1024px+): the table page becomes two columns: main game column
  (max ~640px) plus a side column for players and how-to-play; other pages stay
  centred with max-width ~720px. The 3D scene (a later phase) will sit at the top
  of the main column.
- Tap targets at least 44px.
