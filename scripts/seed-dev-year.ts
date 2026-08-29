/**
 * Generator rocznej bazy DEWELOPERSKIEJ (data/alfa.db):
 *   npx tsx scripts/seed-dev-year.ts            # dogeneruj brakujące dane
 *   npx tsx scripts/seed-dev-year.ts --reset    # skasuj to, co seed dodał wcześniej
 *   npx tsx scripts/seed-dev-year.ts --reset --seed   # od nowa
 *   npx tsx scripts/seed-dev-year.ts --only=commercial,operations
 *
 * Wypełnia dwanaście miesięcy (scripts/seed-dev/shared.ts → PERIOD) tam, gdzie
 * baza deweloperska była pusta albo szczątkowa: kontrahenci, obiekty z kosztami,
 * umowy, zlecenia, kalendarz z realizacjami i protokołami, magazyn oraz
 * domknięcie roku w kadrach.
 *
 * CZEGO NIE RUSZA. Zaimportowane dane są prawdziwe i kosztowne do odtworzenia:
 * kartoteka kadrowa (152 pracowników, 139 umów, godziny 2026-01..09 i wypłaty
 * 2026-06), raporty CMA (39 tys. wpisów), 416 obiektów monitorowanych, projekty
 * i słownik spółek. Seed tylko się do nich dokłada.
 *
 * Każdy wygenerowany wiersz niesie znacznik MARKER w polu tekstowym — po nim
 * `--reset` odróżnia własne dane od zastanych. Kasowanie idzie wyłącznie po tym
 * znaczniku, nigdy „wyczyść tabelę".
 *
 * DETERMINIZM dotyczy TREŚCI, nie kluczy. Dwa przebiegi dają te same nazwy, kwoty
 * i daty, ale inne `id` — SQLite AUTOINCREMENT nie odzyskuje skasowanych numerów,
 * więc po cyklu reset→seed identyfikatory są przesunięte. Porównując dwie bazy,
 * porównuj treść, nie klucze.
 *
 * UWAGA: better-sqlite3 jest zbudowany pod Node 22:
 *   export PATH="/config/.nvm/versions/node/v22.22.0/bin:$PATH"
 */
import { PERIOD, seed as setSeed } from "./seed-dev/shared.js";
import { seedCommercial, resetCommercial } from "./seed-dev/commercial.js";
import { seedOperations, resetOperations } from "./seed-dev/operations.js";
import { seedWarehouse, resetWarehouse } from "./seed-dev/warehouse.js";
import { seedHr, resetHr } from "./seed-dev/hr.js";
import { seedLinks, resetLinks } from "./seed-dev/links.js";
import { seedServices, resetServices } from "./seed-dev/services.js";

/** Ziarno losowości — stałe, żeby dwa uruchomienia dały tę samą bazę. */
const SEED = 20260829;

/** Liczniki z modułu — każdy zwraca własny kształt, raport tylko je wypisuje. */
type Counts = Readonly<Record<string, number>>;

/**
 * Kolejność ma znaczenie: `operations` wiąże wydarzenia i realizacje z obiektami,
 * więc `commercial` musi je najpierw założyć. Reset idzie w drugą stronę.
 */
const MODULES = [
  { name: "commercial", label: "kontrahenci, obiekty, umowy, zlecenia", run: seedCommercial, undo: resetCommercial },
  { name: "operations", label: "kalendarz, realizacje, protokoły, wyceny", run: seedOperations, undo: resetOperations },
  { name: "warehouse", label: "magazyn: towary, dokumenty, stany", run: seedWarehouse, undo: resetWarehouse },
  { name: "hr", label: "kadry: domknięcie roku", run: seedHr, undo: resetHr },
  // Usługi muszą być przed `links`: dobór mapowania mierzy koszt osobowy, a ten
  // zależy od liczby kamer (podział puli centrum monitorowania).
  { name: "services", label: "usługi obiektów: kamery, wideorecepcja", run: seedServices, undo: resetServices },
  // Na końcu: wiąże pozycje kadrowe z obiektami i osoby z listą płac, więc
  // wymaga i obiektów (commercial), i danych płacowych (hr).
  { name: "links", label: "powiązania kartotek: kadry ↔ obiekty ↔ osoby", run: seedLinks, undo: resetLinks },
] as const;

function parseArgs() {
  const argv = process.argv.slice(2);
  const only = argv.find((a) => a.startsWith("--only="))?.slice(7).split(",").filter(Boolean);
  return {
    reset: argv.includes("--reset"),
    // `--reset` bez `--seed` tylko sprząta; samo uruchomienie bez flag generuje.
    generate: !argv.includes("--reset") || argv.includes("--seed"),
    only,
  };
}

function report(title: string, counts: object) {
  const parts = Object.entries(counts)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}: ${v}`);
  console.log(`  ${title}${parts.length ? " — " + parts.join(", ") : " — nic do zrobienia"}`);
}

async function main() {
  const { reset, generate, only } = parseArgs();
  const mods = MODULES.filter((m) => !only || only.includes(m.name));
  if (only && mods.length === 0) {
    console.error(`Nieznany moduł. Dostępne: ${MODULES.map((m) => m.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`Baza deweloperska, okno ${PERIOD.from} … ${PERIOD.to}`);

  if (reset) {
    console.log("\n— kasowanie danych z poprzedniego seeda (po znaczniku) —");
    // Odwrotna kolejność: dzieci przed rodzicami, inaczej FK zablokuje delete.
    for (const m of [...mods].reverse()) report(m.name, await m.undo());
  }

  if (generate) {
    // Ziarno ustawiamy RAZ dla całego przebiegu — moduły dzielą jeden strumień
    // losowości, więc kolejność ich uruchomienia współtworzy wynik. To celowe:
    // pełny przebieg jest powtarzalny, a `--only` służy do szybkich iteracji,
    // nie do odtwarzania bit w bit tej samej bazy.
    setSeed(SEED);
    console.log("\n— generowanie —");
    for (const m of mods) {
      const t0 = Date.now();
      const counts = await m.run();
      report(`${m.name} (${m.label})`, counts);
      console.log(`    ${Date.now() - t0} ms`);
    }
  }

  console.log("\nGotowe.");
}

main().catch((err) => {
  console.error("BŁĄD seeda:", err);
  process.exit(1);
});
