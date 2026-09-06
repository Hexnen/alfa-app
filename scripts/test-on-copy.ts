/**
 * Uruchamia skrypt testowy na KOPII bazy, nie na produkcyjnej:
 *   npx tsx scripts/test-on-copy.ts scripts/test-analytics.ts
 *   npx tsx scripts/test-on-copy.ts scripts/test-analytics.ts scripts/test-object-identity.ts
 *
 * DLACZEGO. Część testów zmienia stan GLOBALNY, a nie tylko własne fikstury:
 * `test-analytics.ts` przestawia narzuty składek w `app_settings` i wyłącza pulę
 * CMA, żeby sprawdzić arytmetykę przy znanych wartościach. Odtworzenie stanu
 * wisiało wyłącznie na `finally` — SIGKILL, OOM albo restart kontenera w połowie
 * zostawiał produkcyjną bazę z zerowym kosztem centrum monitorowania i kosztami
 * osobowymi bez składek. Cicho, bez żadnego sygnału, a backend serwował z niej
 * zafałszowane liczby.
 *
 * Kopia rozwiązuje to u źródła: test nie ma jak zepsuć czegoś, czego nie dotyka.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const SOURCE = process.env.ALFA_DB_PATH ?? "./data/alfa.db";
const WORKDIR = join(process.env.TMPDIR ?? "/tmp", `alfa-test-${process.pid}`);
const COPY = join(WORKDIR, "alfa.db");

const scripts = process.argv.slice(2);
if (scripts.length === 0) {
  console.error("Podaj skrypty do uruchomienia, np. scripts/test-analytics.ts");
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  console.error(`Nie ma bazy źródłowej: ${SOURCE}`);
  process.exit(1);
}

mkdirSync(dirname(COPY), { recursive: true });

/**
 * `backup()` zamiast kopiowania pliku: baza chodzi w trybie WAL, więc sam plik
 * `.db` bez `-wal` bywa niekompletny, a aplikacja może właśnie w tej chwili pisać.
 */
const src = new Database(SOURCE, { readonly: true });
await src.backup(COPY);
src.close();
console.log(`Kopia bazy: ${COPY}`);

let failed = 0;
for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const res = spawnSync("npx", ["tsx", script], {
    stdio: "inherit",
    env: { ...process.env, ALFA_DB_PATH: COPY },
  });
  if (res.status !== 0) {
    failed++;
    console.error(`— ${script}: KOD WYJŚCIA ${res.status}`);
  }
}

// Kopia znika niezależnie od wyniku — nie zostawiamy śmieci w /tmp.
rmSync(WORKDIR, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\nWszystkie skrypty (${scripts.length}) przeszły na kopii.`
    : `\n${failed} z ${scripts.length} skryptów nie przeszło.`
);
process.exit(failed === 0 ? 0 : 1);
