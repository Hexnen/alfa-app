/**
 * Rozbicie jednego abonamentu (`objects.monthly_value`) na ZDW i OFI:
 *   npx tsx scripts/migrate-abonament-split.ts            # suchy przebieg — tabela rozstrzygnięć, nic nie zapisuje
 *   npx tsx scripts/migrate-abonament-split.ts --apply    # zapis, wszystko w JEDNEJ transakcji
 *   npx tsx scripts/migrate-abonament-split.ts --report=<plik.md>
 *
 * Honoruje ALFA_DB_PATH (src/db/index.ts) — pierwszy przebieg rób na kopii bazy.
 * Wymaga migracji 0082 (kolumny `monthly_zdw`, `monthly_ofi`).
 *
 * DLACZEGO SKRYPT, A NIE SQL W MIGRACJI. Reguła podziału nie stoi na usługach
 * obiektu, tylko na POCHODZENIU CENY: skąd wzięła się ta konkretna kwota (wyciąg
 * bankowy wspólnoty, rozdzielona faktura zbiorcza z flagą ZDV/OFI, raport CMA).
 * Część z tego siedzi w tekście notatek i w rejestrze `monitored_objects`, więc
 * w SQL-u wyszłaby ściana LIKE-ów, której nikt by nie przeczytał ani nie przetestował.
 * Cała logika mieszka w src/lib/abonament-split.ts i jest współdzielona ze
 * skryptami importu (import-baza-obiektowa.ts, uzupelnij-kartoteke.ts).
 *
 * IDEMPOTENCJA: rusza wyłącznie obiekty, które mają `monthly_value` i NIE mają
 * jeszcze ŻADNEJ z nowych kwot. Drugi przebieg nie ma czego zmieniać, a ręczna
 * korekta w aplikacji nie zostanie nadpisana.
 *
 * CZEGO NIE ROBI: nie kasuje `monthly_value` — kolumna zostaje jako @deprecated
 * ślad po źródle, żeby dało się sprawdzić, z czego wyszło rozbicie.
 */
import { writeFileSync } from "node:fs";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { SPLIT_TODO_NOTE, splitAbonament, type SplitSource } from "../src/lib/abonament-split.js";

const apply = process.argv.includes("--apply");
const reportArg = process.argv.find((a) => a.startsWith("--report="));

const out: string[] = [];
function say(line = "") {
  console.log(line);
  out.push(line);
}

const money = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SOURCE_LABEL: Record<SplitSource, string> = {
  "brak-kwoty": "brak kwoty (pominięty)",
  "brak-ofi": "brak OFI → całość ZDW",
  "sama-ofi": "sama ochrona fizyczna → całość OFI",
  "wplyw-bankowy": "cena z wpływu bankowego (wspólnota) → OFI",
  "faktura-ofi": "faktura zbiorcza z flagą OFI → OFI",
  "faktura-zdv": "faktura zbiorcza z flagą ZDV → ZDW",
  "cena-cma": "cena z raportu CMA → ZDW",
  niepewne: "NIEPEWNE → ZDW + dopisek w notatkach",
};

// ---------------------------------------------------------------------------
// Dane
// ---------------------------------------------------------------------------
const objects = await db
  .select({
    id: schema.objects.id,
    name: schema.objects.name,
    monthlyValue: schema.objects.monthlyValue,
    monthlyZdw: schema.objects.monthlyZdw,
    monthlyOfi: schema.objects.monthlyOfi,
    hasOfi: schema.objects.hasOfi,
    hasCameras: schema.objects.hasCameras,
    hasSswin: schema.objects.hasSswin,
    hasVideoreception: schema.objects.hasVideoreception,
    notes: schema.objects.notes,
  })
  .from(schema.objects);

/**
 * Które obiekty mają cenę POCHODZĄCĄ Z REJESTRU CMA — czyli rejestr wpisał im
 * `extra_data1` (cena netto/mies. z raportu obiektów). Raport CMA wycenia dozór,
 * więc taka kwota jest kwotą za ZDW nawet na obiekcie, na którym stoi też wartownik.
 */
const cmaPriced = new Set<number>(
  (
    await db
      .select({ objectId: schema.monitoredObjects.objectId })
      .from(schema.monitoredObjects)
      .where(
        sql`${schema.monitoredObjects.objectId} is not null and trim(coalesce(${schema.monitoredObjects.extraData1}, '')) <> ''`
      )
  )
    .map((r) => r.objectId)
    .filter((id): id is number => id !== null)
);

// ---------------------------------------------------------------------------
// Rozstrzygnięcia
// ---------------------------------------------------------------------------
interface Decision {
  id: number;
  name: string;
  value: number;
  zdw: number | null;
  ofi: number | null;
  source: SplitSource;
  uncertain: boolean;
  notes: string | null;
}

const decisions: Decision[] = [];
const skippedNoValue: number[] = [];
const skippedAlreadySplit: number[] = [];

for (const o of objects) {
  if (o.monthlyValue === null) {
    skippedNoValue.push(o.id);
    continue;
  }
  // Idempotencja: obiekt już rozbity (choćby ręcznie w aplikacji) zostaje w spokoju.
  if (o.monthlyZdw !== null || o.monthlyOfi !== null) {
    skippedAlreadySplit.push(o.id);
    continue;
  }
  const r = splitAbonament({
    monthlyValue: o.monthlyValue,
    hasOfi: o.hasOfi,
    hasCameras: o.hasCameras,
    hasSswin: o.hasSswin,
    hasVideoreception: o.hasVideoreception,
    notes: o.notes,
    priceFromCma: cmaPriced.has(o.id),
  });
  decisions.push({
    id: o.id,
    name: o.name,
    value: o.monthlyValue,
    zdw: r.monthlyZdw,
    ofi: r.monthlyOfi,
    source: r.source,
    uncertain: r.uncertain,
    notes: o.notes,
  });
}

// ---------------------------------------------------------------------------
// Raport
// ---------------------------------------------------------------------------
say(`# Rozbicie abonamentu na ZDW / OFI (${apply ? "ZAPIS" : "suchy przebieg"})`);
say();
say(`Baza: \`${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}\``);
say();
say(`- obiektów w bazie: **${objects.length}**`);
say(`- bez abonamentu (pominięte): **${skippedNoValue.length}**`);
say(`- już rozbite wcześniej (pominięte): **${skippedAlreadySplit.length}**`);
say(`- do rozbicia: **${decisions.length}**`);
say();

const bySource = new Map<SplitSource, Decision[]>();
for (const d of decisions) {
  const list = bySource.get(d.source) ?? [];
  list.push(d);
  bySource.set(d.source, list);
}

say("## Tabela rozstrzygnięć");
say();
say("| reguła | obiektów | kwota ZDW | kwota OFI |");
say("| --- | ---: | ---: | ---: |");
for (const [source, list] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const zdw = list.reduce((a, d) => a + (d.zdw ?? 0), 0);
  const ofi = list.reduce((a, d) => a + (d.ofi ?? 0), 0);
  say(`| ${SOURCE_LABEL[source]} | ${list.length} | ${money(zdw)} | ${money(ofi)} |`);
}
const totalZdw = decisions.reduce((a, d) => a + (d.zdw ?? 0), 0);
const totalOfi = decisions.reduce((a, d) => a + (d.ofi ?? 0), 0);
say(`| **RAZEM** | **${decisions.length}** | **${money(totalZdw)}** | **${money(totalOfi)}** |`);
say();
const sumBefore = decisions.reduce((a, d) => a + d.value, 0);
say(
  `Suma przed rozbiciem: **${money(sumBefore)}** zł, po rozbiciu: **${money(totalZdw + totalOfi)}** zł` +
    (Math.abs(sumBefore - (totalZdw + totalOfi)) < 0.005 ? " ✓ zgadza się." : " ✗ ROZJAZD!")
);
say();

// Obiekty mieszane wypisujemy CO DO JEDNEGO — to jedyna grupa, w której reguła
// naprawdę coś rozstrzyga, i jedyna, którą warto przejrzeć okiem.
const mixed = decisions.filter(
  (d) => !["brak-ofi", "sama-ofi"].includes(d.source)
);
if (mixed.length > 0) {
  say("## Obiekty mieszane (OFI + dozór) — rozstrzygnięcia jednostkowe");
  say();
  say("| # | obiekt | kwota | → ZDW | → OFI | reguła |");
  say("| ---: | --- | ---: | ---: | ---: | --- |");
  for (const d of mixed.sort((a, b) => b.value - a.value)) {
    say(
      `| ${d.id} | ${d.name.replace(/\|/g, "/")} | ${money(d.value)} | ${money(d.zdw)} | ${money(d.ofi)} | ${SOURCE_LABEL[d.source]} |`
    );
  }
  say();
}

const uncertain = decisions.filter((d) => d.uncertain);
say(`Do potwierdzenia przez człowieka: **${uncertain.length}** obiektów (dostaną dopisek „${SPLIT_TODO_NOTE}”).`);
say();

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------
if (apply) {
  db.transaction((tx) => {
    for (const d of decisions) {
      const notes = d.uncertain
        ? d.notes && d.notes.includes(SPLIT_TODO_NOTE)
          ? d.notes
          : d.notes
            ? `${d.notes.trimEnd()}\n${SPLIT_TODO_NOTE} (cała kwota ${money(d.value)} zł trafiła na ZDW).`
            : `${SPLIT_TODO_NOTE} (cała kwota ${money(d.value)} zł trafiła na ZDW).`
        : d.notes;
      tx.update(schema.objects)
        .set({ monthlyZdw: d.zdw, monthlyOfi: d.ofi, notes })
        .where(eq(schema.objects.id, d.id))
        .run();
    }
  });
  say(`ZAPISANO: ${decisions.length} obiektów.`);
} else {
  say("Suchy przebieg — nic nie zapisano. Uruchom z `--apply`, żeby zapisać.");
}

// Kontrola po zapisie: nic z abonamentem nie może zostać bez rozbicia.
const orphan = await db
  .select({ c: sql<number>`count(*)` })
  .from(schema.objects)
  .where(
    sql`${isNotNull(schema.objects.monthlyValue)} and ${schema.objects.monthlyZdw} is null and ${schema.objects.monthlyOfi} is null`
  );
say();
say(`Obiektów z abonamentem, ale bez rozbicia (po przebiegu): **${orphan[0].c}**`);

if (reportArg) {
  const path = reportArg.slice("--report=".length);
  writeFileSync(path, out.join("\n") + "\n", "utf8");
  console.log(`\nRaport: ${path}`);
}
