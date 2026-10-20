import { expect, it, vi } from "vitest";
import { fillCrate, session, uniqueName } from "./helpers";

// Contract: GET /api/shop/booths -> Booth[] (signed in only), the 2D booth list;
// the shop stream's booths event carries the same. A Booth is {spot, private,
// code?, host, seated, max, status: "waiting"|"playing", round?}; code is there
// for public booths only. POST /api/shop/quick-seat -> {code} for the fullest
// public waiting booth, 404 when none. Hosts set POST /api/tables/:code/visibility
// {private} (not mid-game), POST /api/tables/:code/remove {name}; anyone signed in
// may POST /api/tables/:code/report {reason}, once per table (decision 0005).

vi.setConfig({ testTimeout: 30_000 });

type Booth = { spot: number; private: boolean; code?: string; host: string; seated: number; max: number; status: string; round?: number };
type Person = { s: ReturnType<typeof session>; name: string };

async function signedIn(prefix: string): Promise<Person> {
  const s = session();
  const name = uniqueName(prefix);
  await s.call("/api/join", { body: { name, pin: "1357" } });
  return { s, name };
}

async function table(host: Person, body: object = {}, guests: Person[] = []) {
  const { code } = (await (await host.s.call("/api/tables", { body })).json()) as { code: string };
  for (const g of guests) await g.s.call(`/api/tables/${code}/join`, { body: {} });
  return code;
}

const list = async (p: Person) => (await (await p.s.call("/api/shop/booths")).json()) as Booth[];
const crowd = (n: number, prefix: string) => Promise.all(Array.from({ length: n }, () => signedIn(prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("needs a sign-in for the list, quick seat, visibility, remove and report", async () => {
  const anon = session();
  expect((await anon.call("/api/shop/booths")).status).toBe(401);
  expect((await anon.call("/api/shop/quick-seat", { body: {} })).status).toBe(401);
  for (const path of ["visibility", "remove", "report"]) {
    expect((await anon.call(`/api/tables/ABCD/${path}`, { body: {} })).status).toBe(401);
  }
});

it("lists a public booth with its code and a private one without", async () => {
  const [pub, priv, watcher] = await crowd(3, "bth");
  const open = await table(pub);
  const secret = await table(priv, { private: true });
  const stream = await watcher.s.open("/api/shop/events");
  const snap = await stream.next((e) => e.event === "snapshot");
  const booths = await list(watcher);

  const a = booths.find((b) => b.code === open)!;
  expect(a).toMatchObject({ private: false, host: pub.name, seated: 1, max: 10, status: "waiting" });
  const b = booths.find((b) => b.host === priv.name)!;
  expect(b).toMatchObject({ private: true, seated: 1 });
  expect(b.code).toBeUndefined();
  expect(JSON.stringify(booths)).not.toContain(secret);
  expect(JSON.stringify(snap!.data.booths)).not.toContain(secret);
  // Booths come in spot order, tables beyond the six last with spot -1.
  const spots = booths.map((x) => x.spot);
  expect(spots.filter((s) => s >= 0)).toEqual([...spots.filter((s) => s >= 0)].sort((x, y) => x - y));
  expect(spots.lastIndexOf(-1) === -1 || spots.indexOf(-1) > spots.findLastIndex((s) => s >= 0)).toBe(true);

  // Flipping a booth private and public again shows in the stream, and never leaks the code.
  await pub.s.call(`/api/tables/${open}/visibility`, { body: { private: true } });
  await stream.next((e) => e.event === "booths" && e.data.some((x: Booth) => x.host === pub.name && x.private));
  await priv.s.call(`/api/tables/${secret}/visibility`, { body: { private: false } });
  await stream.next((e) => e.event === "booths" && e.data.some((x: Booth) => x.code === secret));
  await priv.s.call(`/api/tables/${secret}/visibility`, { body: { private: true } });
  await sleep(600);
  const afterPrivate = await stream.next((e) => e.event === "booths" && !e.data.some((x: Booth) => x.code === secret), 2000, 1);
  expect(afterPrivate).not.toBeNull();
  stream.close();
});

it("never puts a private booth's code in a shop event", async () => {
  const [host, watcher] = await crowd(2, "bth");
  const stream = await watcher.s.open("/api/shop/events");
  await stream.next((e) => e.event === "snapshot");
  const secret = await table(host, { private: true });
  await stream.next((e) => e.event === "booths" && e.data.some((x: Booth) => x.host === host.name));
  await sleep(500);
  expect(stream.raw).not.toContain(secret);
  stream.close();
});

it("lets only the host change visibility, and not mid-game", async () => {
  const [host, guest, third] = await crowd(3, "vis");
  const code = await table(host, {}, [guest, third]);
  for (const p of [host, guest, third]) await fillCrate(p.s);
  expect((await guest.s.call(`/api/tables/${code}/visibility`, { body: { private: true } })).status).toBe(403);
  expect((await host.s.call(`/api/tables/${code}/visibility`, { body: { private: "yes" } })).status).toBe(400);
  const ok = await host.s.call(`/api/tables/${code}/visibility`, { body: { private: true } });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { private: boolean }).private).toBe(true);
  expect((await host.s.call(`/api/tables/${code}/start`, { body: {} })).status).toBe(202);
  expect((await host.s.call(`/api/tables/${code}/visibility`, { body: { private: false } })).status).toBe(409);
  expect((await (await host.s.call("/api/tables", { body: { private: "no" } })).status)).toBe(400);
});

it("lets only the host remove someone, who then cannot rejoin", async () => {
  const [host, guest, other] = await crowd(3, "rem");
  const code = await table(host, {}, [guest, other]);
  expect((await guest.s.call(`/api/tables/${code}/remove`, { body: { name: other.name } })).status).toBe(403);
  expect((await host.s.call(`/api/tables/${code}/remove`, { body: { name: host.name } })).status).toBe(400);
  expect((await host.s.call(`/api/tables/${code}/remove`, { body: { name: "nobody-here" } })).status).toBe(404);
  const res = await host.s.call(`/api/tables/${code}/remove`, { body: { name: guest.name } });
  expect(res.status).toBe(200);
  const state = (await (await host.s.call(`/api/tables/${code}`)).json()) as { members: { name: string }[] };
  expect(state.members.map((m) => m.name)).not.toContain(guest.name);
  expect((await guest.s.call(`/api/tables/${code}/join`, { body: {} })).status).toBe(403);
});

it("treats a player removed mid-game like one who left", async () => {
  const people = await crowd(4, "rmg");
  const [host, ...rest] = people;
  const code = await table(host, {}, rest);
  for (const p of people) await fillCrate(p.s);
  expect((await host.s.call(`/api/tables/${code}/start`, { body: {} })).status).toBe(202);
  await host.s.call(`/api/tables/${code}/remove`, { body: { name: rest[0].name } });
  const state = (await (await host.s.call(`/api/tables/${code}`)).json()) as {
    members: { name: string }[]; game: { alive: string[]; ghosts: string[] };
  };
  expect(state.members.map((m) => m.name)).not.toContain(rest[0].name);
  expect(state.game.alive).not.toContain(rest[0].name);
  expect(state.game.ghosts).not.toContain(rest[0].name);
  expect((await rest[0].s.call(`/api/tables/${code}/join`, { body: {} })).status).toBe(403);
});

it("takes one report per person per table, with a reason from the list", async () => {
  const [host, reporter] = await crowd(2, "rep");
  const code = await table(host);
  expect((await reporter.s.call(`/api/tables/${code}/report`, { body: { reason: "boring" } })).status).toBe(400);
  expect((await reporter.s.call(`/api/tables/${code}/report`, { body: { reason: "spam" } })).status).toBe(200);
  expect((await reporter.s.call(`/api/tables/${code}/report`, { body: { reason: "rude names" } })).status).toBe(409);
  expect((await host.s.call(`/api/tables/${code}/report`, { body: { reason: "something else" } })).status).toBe(200);
});

it("quick seat picks the fullest public waiting booth and skips private, playing and removed ones", async () => {
  const guests = await crowd(7, "qsg");
  const [bigHost, ...rest] = await crowd(8, "qsh");
  await table(bigHost, {}, rest.slice(0, 5));
  const priv = await table(guests[0], { private: true }, guests.slice(1, 7));
  const playHost = (await crowd(1, "qsp"))[0];
  const playing = await table(playHost, {}, [rest[5], rest[6], guests[1]]);
  for (const p of [playHost, rest[5], rest[6], guests[1]]) await fillCrate(p.s);
  await playHost.s.call(`/api/tables/${playing}/start`, { body: {} });

  const seeker = await signedIn("qsk");
  const before = await list(seeker);
  const best = Math.max(...before.filter((b) => !b.private && b.status === "waiting" && b.seated < b.max).map((b) => b.seated));
  const res = await seeker.s.call("/api/shop/quick-seat", { body: {} });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  expect(code).not.toBe(priv);
  expect(code).not.toBe(playing);
  const sat = before.find((b) => b.code === code)!;
  expect(sat.seated).toBe(best);
  expect(best).toBeGreaterThanOrEqual(6);
  const state = (await (await seeker.s.call(`/api/tables/${code}`)).json()) as { members: { name: string }[] };
  expect(state.members.map((m) => m.name)).toContain(seeker.name);

  // Removed from the fullest, the next quick seat goes elsewhere.
  const target = (await list(seeker)).find((b) => b.code === code)!;
  const host = [bigHost, ...rest, ...guests, playHost].find((p) => p.name === target.host);
  if (host) {
    await host.s.call(`/api/tables/${code}/remove`, { body: { name: seeker.name } });
    const again = await seeker.s.call("/api/shop/quick-seat", { body: {} });
    if (again.status === 200) expect(((await again.json()) as { code: string }).code).not.toBe(code);
  }
});
