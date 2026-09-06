import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { pathToFileURL } from "url";

/** Jak w src/db/index.ts — nadpisywalna, żeby migracje dało się przetestować na kopii. */
const DB_PATH = process.env.ALFA_DB_PATH ?? "./data/alfa.db";

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

  // Egzekwowanie kluczy obcych WYŁĄCZONE na czas migracji — to zalecany przepis
  // SQLite przy zmianach schematu. Zmiana klauzuli ON DELETE wymaga przebudowy
  // tabeli (nowa tabela → przepisanie danych → DROP starej → RENAME), a DROP
  // tabeli, na którą ktoś wskazuje, wywala się przy włączonych kluczach — mimo
  // że sekundę później wstawiamy tabelę pod tą samą nazwą. better-sqlite3
  // włącza je domyślnie, więc trzeba to zrobić jawnie.
  //
  // To bezpieczne, bo połączenie jest krótkotrwałe i osobne od aplikacyjnego
  // (src/db/index.ts ustawia foreign_keys = ON dla ruchu produkcyjnego), a
  // spójność sprawdzamy PO zastosowaniu wszystkich migracji.
  sqlite.pragma("foreign_keys = OFF");

  const db = drizzle(sqlite);

  console.log("Running migrations...");
  migrate(db, { migrationsFolder: "./src/db/migrations" });

  // Migracja, która zostawiłaby wiszące referencje, jest gorsza od migracji,
  // która się nie wykonała — lepiej zatrzymać start aplikacji z czytelnym
  // błędem niż wpuścić ruch na niespójne dane.
  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    sqlite.close();
    throw new Error(
      `Migracje zostawiły ${violations.length} naruszeń kluczy obcych: ` +
        JSON.stringify(violations.slice(0, 5))
    );
  }

  console.log("Migrations completed!");

  sqlite.close();
}

// Run directly: `tsx src/db/migrate.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
