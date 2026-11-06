# Design system: a record shop after hours

Chosen direction (the student's pick, replacing the earlier zine): the app is a
record shop at night. The home page is the shopfront under a neon sign, tables
are listening booths, your prompt is a handwritten staff-pick card, tracks are
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
- **Caveat**: handwriting only: the staff-pick prompt and the liner notes.

## Components

- **Panel (`.card`)**: wall-2, 14px radius, 1.5px inset rule. Paper things add
  `.paper` (sleeve fill, ink text, a soft lift).
- **Button**: lamp pill, ink text, 48px high. Secondary: ghost with a 1.5px line.
  On paper: ink pill. Disabled: wall-3 with muted text.
- **Inputs**: dark well with a line border; on paper just a line to write on.
- **Membership card**: the sign-in form, paper, tilted 1deg, perforated stripe.
- **Hours card**: dashed mono box under the sign (static copy; no new queries).
- **Staff pick**: the round's prompt on a sleeve card with tape, handwritten,
  tilted, with its mood (`IN: alone, cosy`). A mole's card is neon on plum and
  names only the mood. Hide flips either to a wood back with the same heading
  and tape for everyone, so a glance at a phone tells nothing.
- **Crate dividers** (`/taste`): four record-store dividers (a cream tab over a
  wooden bin of three sleeves), one per mood: Up, Down, Out, In.
- **The crates**: everyone's crate on the table, one collapsible row per player,
  grouped by mood; a heard song is struck through and stamped PLAYED.
- **Pick list**: your crate with the round's mood first ("fits the mood"), then
  the rest; "Borrow instead" opens the other crates.
- **Needle drop** (listen): sleeve, plinth, platter, record, tonearm in CSS.
  The label shows the playing card's number, picker and title. Cards are named
  sleeves ("Ben: song", "(borrowed from Tom)", a CLASH stamp for a song picked
  twice) the host can press.
- **Vote rows**: each player still in, with their song and a big live count;
  your choice carries a YOUR VOTE tab. Skip is a row like the others.
- **Steal**: a plum panel with the MOLE stamp and a huge countdown; only the
  accused mole gets the eight prompt buttons. On a phone the accused's panel
  is compact (heading and clock on one row) so all eight fit one 390x844
  screen, with the score strip above it and nothing docked between.
- **Mood strip**: four blocks of three dots (Up, Down, Out, In) on each crate
  and on the table, the round's mood lit in lamp, the rest muted. Each block
  has its word under it (mono caps, 11px) and the strip's words are in
  screen-reader text.
- **Moment strip**: on a phone the 3D scene docks as a 220px strip for a
  bystander's steal and for the reveal (after the verdict lines, so the words
  come first), then goes home below the action. The accused mole's steal and
  game over never dock it. Every moment it shows is also in words.
- **Sleeves**: in listen each card is a white-label cream sleeve with a big
  number, a name sticker (and a second for a borrow), a CLASH stamp and a
  PLAYING stamp, with the art small in a corner.
- **YOURS tab**: your own card in listen and vote carries a lamp-on-ink tab, so
  you find it among the sleeves; it shows only once picks are public.
- **Vote chips**: lamp pills over heads in the 3D scene, counts only, from the
  public tally; the vote rows carry the same counts in words.
- **Liner notes**: reveal and game over are a paper back cover: tracklist with
  pickers, the prompt in handwriting, votes by name, a MOLE stamp when the
  ejected person was a mole, and at game end every mole and every round. Past
  games reuse it as record-shelf cards.
- **Stamp**: mono caps, 2px border, rotated a few degrees: HOST, OUT, WATCHING,
  AUTO, MOLE. Colour is never the only signal; each carries words.
- **Ticket**: the table code on a sleeve with punched notches, in mono.
- **Avatar**: the drawn badge with a wall ring; mobility aids are a small drawn
  mark, not an icon font.
- **The wall** (shop, decision 0011): revealed rounds from public booths hung
  as sleeves on wood rails, newest first. Each sleeve shows the best card's (or
  first pick's) cover, or a plain sleeve in the mood's colour with a record
  ring, a mood sticker, and a tilted staff-pick card with the prompt in Caveat
  and `BOOTH · R2 · CAUGHT` in mono. Opening one shows the round's liner notes on
  paper in a dialog: prompt, mood, numbered picks with pickers and lenders, a
  BEST PICK stamp, and a CAUGHT stamp with who the moles were. In 2D it is a
  collapsible section with "More" for older sleeves; in 3D the same sleeves hang
  on the back wall left of the sign (8 by 5, newest 40, one mesh and one texture
  atlas), and tapping one or walking up to it opens the same dialog. A new
  sleeve settles onto its hook (under 1s, none with reduced motion) and is
  announced once.
- **The jukebox**: "Picked by Ana" in mono caps over the title, the cover, and
  time left; an "Up next" list; "Queue a song from your crate" opens your crate
  by mood with a Queue button per song; Skip shows `skips/needed`. In 3D the
  jukebox's front window glows lamp-amber while a song plays, with a lamp tag
  `Now: title · picker` over it. A new song is announced once.
- **Booth signs**: a playing public booth gets one mono line in lamp, in the
  booth list and on a dark sign over the booth in 3D: `Round 2 · Vote · Down ·
  3 voted`, or `Round 1 · Listening: Song by Artist (Ana's pick)`. While a card
  plays, a cream sleeve (no title on it) leans on the booth's turntable.
- **Taste notes** (Your past games): a paper card, "Staff notes on you": what
  you reach for in each mood (mono-caps dividers like the crate's), your most
  loved song with a stamp counting best-pick votes, songs you shared with
  someone, and borrows both ways. Every part has a short empty line.

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
1100px with the 3D scene (a decoration) at the top of the side column.
Tap targets are at least 44px; focus is a 3px lamp ring (ink on paper).
