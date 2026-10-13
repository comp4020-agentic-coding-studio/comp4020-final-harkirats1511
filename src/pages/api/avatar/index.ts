import type { APIRoute } from "astro";
import { parseAvatar } from "../../../lib/avatar.ts";
import { getAvatar, saveAvatar, tablesOf } from "../../../lib/avatars.ts";
import { json, personFromCookies } from "../../../lib/auth.ts";
import { notifyTable } from "../../../lib/tables.ts";

export const GET: APIRoute = ({ cookies }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  return json(getAvatar(me.id));
};

export const PUT: APIRoute = async ({ cookies, request }) => {
  const me = personFromCookies(cookies);
  if (!me) return json({ error: "Sign in first." }, 401);
  const body = await request.json().catch(() => null);
  const avatar = parseAvatar(body);
  if (!avatar) return json({ error: "Each of the six parts must be one of its listed options." }, 400);
  saveAvatar(me.id, avatar);
  // Open tables show it straight away.
  for (const code of tablesOf(me.id)) notifyTable(code);
  return json(avatar);
};
