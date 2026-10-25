// The bots' names. A bot is a person row flagged is_bot, found by name; its crate is kept
// on that row, so it is built once and reused by every game it sits at. The "bot-" prefix is
// part of the label: a name is never shown as a person's without it.
// Bot i takes its genre word and its fallback crate from i % 8, and two bots at one table
// never share that class, so two crates at a table never hold the same songs.
export const GENRES = ["jazz", "metal", "kpop", "disco", "reggae", "folk", "blues", "funk"] as const;
export const CLASSES = GENRES.length;
const FIRST = [
  "ivy", "gus", "hal", "isa", "jun", "kit", "lou", "mae", "ned", "oli",
  "pip", "quin", "ray", "sol", "tia", "uma", "val", "wes", "xan", "yara", "zed", "abe", "bea", "cal", "dee", "eve",
  "fin", "gia", "hux", "ida", "jax", "kai", "lia", "moe", "nia", "oz", "pax", "rue", "sky", "tod", "uri", "vee",
];
export const BOT_NAMES: readonly string[] = FIRST.map((n) => `bot-${n}`);
export const classOf = (index: number) => index % CLASSES;
// A bot's row name is its base name, plus a number once the base is in use at another table
// ("bot-ivy", "bot-ivy2"): people rows have unique names, and a row sits at one table at a time.
export const baseName = (name: string) => name.toLowerCase().replace(/\d+$/, "");
export const rowName = (base: string, n: number) => (n <= 1 ? base : `${base}${n}`);
