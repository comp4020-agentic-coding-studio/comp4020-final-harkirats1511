import { expect, it } from "vitest";
import { session, uniqueName } from "./helpers";

// Contract: POST /api/join {name, pin} claims a new name or signs in to an
// existing one, and sets a session cookie. GET /api/me says who this session is.

it("tells two people in separate sessions apart", async () => {
  const a = session();
  const b = session();
  const nameA = uniqueName("ana");
  const nameB = uniqueName("ben");
  expect((await a.call("/api/join", { body: { name: nameA, pin: "1234" } })).status).toBe(200);
  expect((await b.call("/api/join", { body: { name: nameB, pin: "5678" } })).status).toBe(200);

  expect(((await (await a.call("/api/me")).json()) as { name: string }).name).toBe(nameA);
  expect(((await (await b.call("/api/me")).json()) as { name: string }).name).toBe(nameB);
});

it("lets a returning person back in with their PIN, as the same person", async () => {
  const name = uniqueName("ret");
  await session().call("/api/join", { body: { name, pin: "4321" } });

  const again = session();
  expect((await again.call("/api/join", { body: { name, pin: "4321" } })).status).toBe(200);
  expect(((await (await again.call("/api/me")).json()) as { name: string }).name).toBe(name);
});

it("does not let someone claim a taken name with the wrong PIN", async () => {
  const name = uniqueName("own");
  await session().call("/api/join", { body: { name, pin: "1111" } });

  const impostor = session();
  const res = await impostor.call("/api/join", { body: { name, pin: "9999" } });
  expect(res.status).toBe(403);
  expect((await impostor.call("/api/me")).status).toBe(401);
});

it("never sends a PIN back", async () => {
  const s = session();
  const res = await s.call("/api/join", { body: { name: uniqueName("pin"), pin: "2468" } });
  const body = await res.text();
  expect(body).not.toContain("2468");
  expect(await (await s.call("/api/me")).text()).not.toContain("2468");
});
