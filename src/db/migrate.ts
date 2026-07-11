import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { pathToFileURL } from "url";

const DB_PATH = "./data/alfa.db";

/**
 * Apply pending migrations. Idempotent — safe to call on every boot.
 * Uses its own short-lived connection so it can run before the app's
 * shared db connection is used.
 */
export function runMigrations() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);

  console.log("Running migrations...");
  migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations completed!");

  sqlite.close();
}

// Run directly: `tsx src/db/migrate.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
