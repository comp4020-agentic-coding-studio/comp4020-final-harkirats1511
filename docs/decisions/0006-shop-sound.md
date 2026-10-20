# 0006: Sound in the shop

Status: accepted (final project).

## Context

A record shop with no music in it is a strange record shop. The shop should
have something playing in the background (smooth jazz, jazz rap, lo-fi hip hop,
and Peter Cat Recording Co., which is what I'd actually put on), and walking,
sitting down and dropping the needle should make a sound. But the game itself
is about listening to tracks, so nothing may ever play over a round.

## Options for the background music

1. **Host our own audio files.** Ruled out by "never host audio" and by
   licences.
2. **Deezer previews, as the game already uses (chosen).** A short list of
   track ids per station in the code. Each plays its 30-second preview and
   fades into the next, so the radio is a mixtape of openings.
3. **Generated music.** No licence problem, but it wouldn't sound like a record
   shop.

## Choice

Option 2, with these rules:

- **Stations.** Three stations: *After Hours* (Peter Cat Recording Co., Bill
  Evans, Chet Baker, Ahmad Jamal), *Back Room* (Nujabes, J Dilla, A Tribe Called
  Quest, Madlib, The Pharcyde) and *Late Bus* (Tom Misch, KAYTRANADA, Masego,
  Erykah Badu, Yussef Dayes). By default the radio keeps switching between them.
- **The jukebox picks the station for everyone.** Walking up to the jukebox lets
  anyone change the station for the whole shop, at most once a minute, and the
  log says who did. Everyone hears the same track at about the same time,
  because which track plays is worked out from the clock and the station, not
  stored.
- **The shop radio stops for a game.** On a table's page, the radio is silent
  from when a game starts until it ends. Only round audio plays there.
- **Off is always one tap away.** Browsers don't play sound until you've
  tapped something, so the radio starts on your first tap and is never on
  without a visible control. Your choice (on, off, volume) is saved on your
  device.
- **Sound effects are made in the browser.** Footsteps on wood, a stool,
  a needle drop and a crackle are synthesised with the Web Audio API, so
  there are no audio files to host or license.
- **Sound is never the only signal.** Everything a sound tells you is also on
  screen.

## Cost

- Each 30-second preview starts at the same point (usually the song's start),
  so the radio is a run of intros, never a whole song.
- Every listener fetches each preview from Deezer, so the radio costs some
  mobile data.
- If Deezer is down, the shop is silent but works.
