import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

// One SQLite file is the app's whole persistent state. In production it lives
// on the Fly volume at /data, which is what survives restarts and redeploys.
const path = process.env.DATABASE_PATH ?? "/data/app.db";
mkdirSync(dirname(path), { recursive: true });

export const client = new Database(path);
client.pragma("journal_mode = WAL");
client.pragma("foreign_keys = ON");

export const db = drizzle(client, { schema });

// Committed migrations in drizzle/ are applied at boot, on the machine that
// holds the volume. Edit schema.ts, `pnpm db:generate`, commit the output.
migrate(db, { migrationsFolder: process.env.MIGRATIONS_PATH ?? "./drizzle" });
