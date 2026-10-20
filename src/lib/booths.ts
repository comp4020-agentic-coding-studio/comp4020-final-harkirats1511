import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { currentGame, isRemoved, MAX_PLAYERS } from "./tables.ts";
import { people, tableMembers, tables } from "./schema.ts";

// Booths are the shop's view of tables: only what publicState already shows
// (status, host, how many, round), and the code only for a public booth.
export const SPOTS = 6;
export type Booth = {
  spot: number;
  private: boolean;
  code?: string;
  host: string;
  seated: number;
  max: number;
  status: "waiting" | "playing";
  round?: number;
};
type Row = Booth & { code: string };

// A table keeps its spot while it is a booth. Memory only, like positions.
const spots = new Map<string, number>();

function rows(): Row[] {
  const found = db
    .select({
      code: tables.code,
      host: people.name,
      private: tables.private,
      status: tables.status,
      seated: sql<number>`(select count(*) from ${tableMembers} where ${tableMembers.tableCode} = ${tables.code})`,
    })
    .from(tables)
    .innerJoin(people, eq(people.id, tables.hostPersonId))
    .where(inArray(tables.status, ["open", "playing"]))
    .orderBy(asc(tables.createdAt), sql`${tables}.rowid`)
    .all()
    .filter((t) => t.seated > 0);
  const live = new Set(found.map((t) => t.code));
  for (const code of spots.keys()) if (!live.has(code)) spots.delete(code);
  const taken = new Set(spots.values());
  for (const t of found) {
    if (spots.has(t.code)) continue;
    for (let s = 0; s < SPOTS; s++) {
      if (!taken.has(s)) {
        spots.set(t.code, s);
        taken.add(s);
        break;
      }
    }
  }
  return found
    .map((t) => {
      const playing = t.status === "playing";
      const round = playing ? currentGame(t.code)?.round : undefined;
      return {
        spot: spots.get(t.code) ?? -1,
        private: t.private,
        code: t.code,
        host: t.host,
        seated: t.seated,
        max: MAX_PLAYERS,
        status: playing ? ("playing" as const) : ("waiting" as const),
        ...(round === undefined ? {} : { round }),
      };
    })
    .sort((a, b) => (a.spot < 0 ? 1 : 0) - (b.spot < 0 ? 1 : 0) || a.spot - b.spot);
}

export function booths(): Booth[] {
  return rows().map(({ code, ...rest }) => (rest.private ? rest : { ...rest, code }));
}

// The public, waiting booth with the most people that has room and that this
// person wasn't removed from; the earlier table wins a tie.
export function quickSeatCode(personId: string): string | null {
  let best: Row | null = null;
  for (const b of rows()) {
    if (b.private || b.status !== "waiting" || b.seated >= b.max || isRemoved(b.code, personId)) continue;
    if (!best || b.seated > best.seated) best = b;
  }
  return best?.code ?? null;
}
