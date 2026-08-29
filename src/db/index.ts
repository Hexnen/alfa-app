import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Ścieżka bazy. Domyślnie produkcyjna, ale nadpisywalna zmienną ALFA_DB_PATH —
 * dzięki temu skrypty testowe mogą pracować na KOPII zamiast deptać po danych.
 * Wcześniej jedynym sposobem było uruchamianie z innego katalogu roboczego, co
 * łatwo pominąć: test analityki globalnie przestawiał narzuty składek i wyłączał
 * pulę CMA na prawdziwej bazie, a odtworzenie stanu wisiało wyłącznie na `finally`.
 * Przerwany proces zostawiał firmie zerowy koszt centrum monitorowania i koszty
 * osobowe bez składek — po cichu, bez żadnego sygnału.
 */
const DB_PATH = process.env.ALFA_DB_PATH ?? "./data/alfa.db";

// Ensure data directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
// Wait up to 5s for a lock instead of raising SQLITE_BUSY -> 500 when a
// second OS process (backup/replicator/CLI) holds the write lock.
sqlite.pragma("busy_timeout = 5000");
// Recommended pairing with WAL: fewer fsyncs, still crash-safe under WAL.
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export { schema };
