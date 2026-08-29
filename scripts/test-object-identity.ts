/**
 * Niezmienniki tożsamości obiektu — jedno źródło prawdy:
 *   npx tsx scripts/test-object-identity.ts
 *
 * DLACZEGO TEN TEST ISTNIEJE. Aplikacja ma trzy rejestry obiektów, które powstały
 * niezależnie: `objects` (kartoteka), `hr_objects` (kadry, na nim wiszą godziny)
 * i `monitored_objects` (import z systemu monitoringu). Dopóki dokumenty wiązały
 * się z obiektem po NAZWIE, 29 z 289 realizacji (10%) wskazywało inny obiekt niż
 * kalendarz — bo dwanaście obiektów w kartotece ma zduplikowane nazwy
 * („Stacja paliw Bochnia" ×2). Klucze obce to naprawiły; ten test pilnuje, żeby
 * nikt nie wrócił do dopasowywania po tekście.
 *
 * Test jest CZYSTO ODCZYTOWY — nie zakłada fikstur i niczego nie kasuje. Uruchamiaj
 * na dowolnej bazie; sprawdza stan, a nie scenariusz.
 */
import { db, schema } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const count = (q: string): number =>
  (db.all<{ c: number }>(sql.raw(q))[0]?.c ?? 0) as number;

console.log("— powiązania strukturalne —");

// 1. Każda realizacja zna swój obiekt. To jest fundament: z realizacji wyrastają
//    protokoły i wyceny, a z nich liczby w Analityce.
const realizations = count("select count(*) c from realizations");
const withoutObject = count("select count(*) c from realizations where object_id is null");
ok(
  `realizacje bez obiektu: ${withoutObject} z ${realizations}`,
  withoutObject === 0,
  { withoutObject }
);

// 2. FK nie może kłócić się z kalendarzem — to były te 29 błędnych dopasowań.
ok(
  "zero rozjazdów realizacja ↔ wydarzenie kalendarza",
  count(`select count(*) c from realizations r
         join calendar_events e on e.realization_id = r.id
         where e.object_id is not null and r.object_id <> e.object_id`) === 0
);

// 3. Wycena przypięta do realizacji dziedziczy jej obiekt.
ok(
  "zero rozjazdów wycena ↔ realizacja",
  count(`select count(*) c from quotes q
         join realizations r on r.id = q.realization_id
         where q.object_id is not null and r.object_id is not null
           and q.object_id <> r.object_id`) === 0
);

// 4. Protokół sięga obiektu przez realizację (FK NOT NULL) — nie denormalizujemy
//    go drugi raz, żeby nie powstało drugie źródło prawdy.
ok(
  "każdy protokół ma realizację, a ta obiekt",
  count(`select count(*) c from protocols p
         join realizations r on r.id = p.realization_id
         where r.object_id is null`) === 0
);

console.log("\n— rejestry pomocnicze —");

// 5. Pozycja kadrowa nie może być jednocześnie pulą CMA i wskazywać obiekt:
//    ten sam koszt policzyłby się dwa razy.
ok(
  "żadna pozycja kadrowa nie jest naraz pulą CMA i mapowaniem na obiekt",
  count("select count(*) c from hr_objects where is_cma_pool = 1 and object_id is not null") === 0
);

// 6. Mapowania wskazują istniejące obiekty (FK tego pilnuje, ale sprawdzamy też
//    po migracjach ręcznych, które omijają ORM).
for (const [label, table] of [
  ["kadry", "hr_objects"],
  ["rejestr CMA", "monitored_objects"],
] as const) {
  ok(
    `${label}: mapowania wskazują istniejące obiekty`,
    count(`select count(*) c from ${table} t
           where t.object_id is not null
             and not exists (select 1 from objects o where o.id = t.object_id)`) === 0
  );
}

console.log("\n— nazwa nie jest kluczem —");

// 7. Dowód, że nazwa NIE nadaje się na klucz: pokazujemy, ile obiektów dzieli
//    nazwę. Test nie wymaga unikalności (dwa obiekty u różnych klientów mogą
//    nazywać się tak samo) — pilnuje tylko, żeby nikt na tej nazwie nie polegał.
const dupNames = count(`select count(*) c from (
  select lower(trim(name)) n from objects group by 1 having count(*) > 1)`);
console.log(`     (w kartotece ${dupNames} nazw występuje więcej niż raz — dlatego FK, nie tekst)`);

// 8. Ile realizacji dopasowanie po nazwie wskazałoby ŹLE. Ta liczba nie musi być
//    zerem — jest miarą tego, ile błędów kosztowałby powrót do tekstu.
const wouldBeWrong = count(`select count(*) c from realizations r
  join objects o on lower(trim(o.name)) = lower(trim(r.site))
  where r.object_id <> o.id`);
console.log(`     (dopasowanie po nazwie pomyliłoby ${wouldBeWrong} z ${realizations} realizacji)`);

console.log("\n— kod nie łączy po nazwie —");

/**
 * Skan źródeł: szukamy porównań nazwy obiektu użytych jako złączenie. Wzorzec
 * celuje w `lower(trim(...))` na `objects.name` — tak wyglądały obie usunięte
 * funkcje `resolveObject`. Dopasowywanie techników po nazwisku jest osobnym
 * problemem i celowo NIE jest tu łapane.
 */
function scan(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) scan(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const offenders: string[] = [];
for (const file of [...scan("src"), ...scan("frontend/src")]) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    // Wzorzec, o który chodzi: nazwa obiektu ZNORMALIZOWANA `lower()` i użyta
    // w porównaniu — to jest podpis wyszukiwania tożsamości po tekście i tak
    // wyglądały obie usunięte funkcje `resolveObject`.
    //
    // Czego świadomie NIE łapiemy: `like(objects.name, '%szukaj%')` w szukajce
    // użytkownika (to filtrowanie listy, nie ustalanie tożsamości) ani
    // `select({ name: objects.name }).where(eq(objects.id, …))`, gdzie nazwa
    // jest tylko odczytywana. Świadomy wyjątek zwalnia dopisek `identity-ok`.
    const normalizedName = /lower\([^)]*objects\.name[^)]*\)/i.test(line);
    const comparison = /(=|<>|!=|\bLIKE\b)/i.test(line);
    const mentionsName = normalizedName;
    const allowed = /identity-ok/.test(line);
    if (mentionsName && comparison && !allowed) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
ok(
  `zero złączeń po nazwie obiektu w kodzie${offenders.length ? "" : " (0 trafień)"}`,
  offenders.length === 0,
  offenders
);

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} nieudanych asercji`);
process.exit(failures === 0 ? 0 : 1);
