import { expect, it } from "vitest";
import { baseUrl, session, uniqueName } from "./helpers";

// Contract: each person has an avatar, a small set of choices from fixed lists,
// shown to everyone at their table (2D badge now, 3D character later).
//   GET  /api/avatar/options -> {[part]: string[]}  every allowed value per part
//   GET  /api/avatar         -> this person's avatar {character, colour, hat,
//                               accessory, aid, mood}; a default until they choose
// The parts follow what the 3D models can show: `character` picks one of the
// CC0 Kenney Mini Characters (hair and skin come with it), `colour` tints the
// outfit, `aid` is a mobility aid from the same pack, `mood` sets the idle pose.
//   PUT  /api/avatar {...}   -> saves it; every part must be one of its options
// Public table state lists members as {name, avatar}, so phones draw each other.

type Avatar = Record<string, string>;
const PARTS = ["character", "colour", "hat", "accessory", "aid", "mood"];

async function signedIn() {
  const s = session();
  const name = uniqueName("av");
  await s.call("/api/join", { body: { name, pin: "3690" } });
  return { s, name };
}

async function options(): Promise<Record<string, string[]>> {
  return (await (await fetch(new URL("/api/avatar/options", baseUrl))).json()) as Record<string, string[]>;
}

it("offers a few choices for every part", async () => {
  const opts = await options();
  expect(Object.keys(opts).sort()).toEqual([...PARTS].sort());
  for (const part of PARTS) expect(opts[part].length).toBeGreaterThanOrEqual(3);
});

it("gives a new person a valid default avatar", async () => {
  const { s } = await signedIn();
  const opts = await options();
  const res = await s.call("/api/avatar");
  expect(res.status).toBe(200);
  const avatar = (await res.json()) as Avatar;
  for (const part of PARTS) expect(opts[part]).toContain(avatar[part]);
});

it("saves an avatar that a returning person finds again", async () => {
  const { s, name } = await signedIn();
  const opts = await options();
  const chosen = Object.fromEntries(PARTS.map((p) => [p, opts[p][opts[p].length - 1]]));
  expect((await s.call("/api/avatar", { method: "PUT", body: chosen })).status).toBeLessThan(300);

  const again = session();
  await again.call("/api/join", { body: { name, pin: "3690" } });
  expect(await (await again.call("/api/avatar")).json()).toEqual(chosen);
});

it("refuses values outside the lists, and missing parts, without changing the saved avatar", async () => {
  const { s } = await signedIn();
  const before = await (await s.call("/api/avatar")).json();
  const opts = await options();
  const good = Object.fromEntries(PARTS.map((p) => [p, opts[p][0]]));

  const bad = { ...good, hat: '<img src=x onerror="alert(1)">' };
  expect((await s.call("/api/avatar", { method: "PUT", body: bad })).status).toBe(400);
  const { colour: _omit, ...missing } = good;
  expect((await s.call("/api/avatar", { method: "PUT", body: missing })).status).toBe(400);
  expect(await (await s.call("/api/avatar")).json()).toEqual(before);
});

it("keeps avatars private to their person until they sit at a table", async () => {
  expect((await session().call("/api/avatar")).status).toBe(401);
  expect((await session().call("/api/avatar", { method: "PUT", body: {} })).status).toBe(401);
});

it("shows each member's avatar on the table's public state", async () => {
  const host = await signedIn();
  const guest = await signedIn();
  const opts = await options();
  const look = Object.fromEntries(PARTS.map((p) => [p, opts[p][1]]));
  await guest.s.call("/api/avatar", { method: "PUT", body: look });

  const { code } = (await (await host.s.call("/api/tables", { body: {} })).json()) as { code: string };
  await guest.s.call(`/api/tables/${code}/join`, { body: {} });
  const state = (await (await fetch(new URL(`/api/tables/${code}`, baseUrl))).json()) as {
    members: { name: string; avatar: Avatar }[];
  };
  const seat = state.members.find((m) => m.name === guest.name)!;
  expect(seat.avatar).toEqual(look);
  for (const m of state.members) for (const part of PARTS) expect(opts[part]).toContain(m.avatar[part]);
});
