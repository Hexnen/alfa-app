// Import modułu Kadry ze skoroszytu "MASTER 38 CZERWIEC.xlsx" (2026):
// pracownicy, obiekty, normy (Rok), godziny Styczeń–Czerwiec, umowy
// (WYNAGRODZENIA), wejścia płacowe za czerwiec (kwoty od księgowości,
// stawki, ręczne nadpisania formuł) i biuro. Na końcu weryfikacja:
// kalkulacja aplikacji vs wartości wyliczone w arkuszu (kolumny V/W/X).
//
// UWAGA po rozdzieleniu obiektów i działów: arkusz „Obiekty" trzyma w jednej
// kolumnie także pozycje, które obiektami nie są („CMA"). Ten skrypt zakłada je
// jako wiersze `hr_objects` i wiąże z nimi godziny — czyli PONOWNE uruchomienie
// odtworzy pozycję „CMA" w słowniku obiektów, mimo że migracja 0070 przeniosła ją
// do `hr_departments` razem z flagą puli centrum monitorowania. Skutek: koszt
// centrum przestaje się rozdzielać na dozorowane obiekty i wraca hack po nazwie.
// Przed kolejnym importem historycznym trzeba dołożyć tu mapę nazw działowych na
// `hr_hours.department_id`. Skrypt jest jednorazowy, więc świadomie tego nie robimy.
//
// Uruchomienie (Node 22 — better-sqlite3):
//   PATH="/config/.nvm/versions/node/v22.22.0/bin:$PATH" npx tsx scripts/import-kadry-master-2026.ts
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { db, schema } from "../src/db/index.js";
import { and, eq } from "drizzle-orm";
import {
  buildHoursAggregates,
  computePayroll,
} from "../src/utils/hr-calc.js";

const FILE = "/config/workspace/programming/MASTER 38 CZERWIEC.xlsx";
const YEAR = 2026;
const IMPORT_MONTH = 6; // rozliczany miesiąc skoroszytu (Rok!H2 = Czerwiec)

const MONTHS: Record<string, number> = {
  Styczeń: 1, Luty: 2, Marzec: 3, Kwiecień: 4, Maj: 5, Czerwiec: 6,
  Lipiec: 7, Sierpień: 8, Wrzesień: 9, Październik: 10, Listopad: 11, Grudzień: 12,
};

const norm = (s: unknown) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ZUA/ZZA: excelowa liczba-data → "DD.MM.RRRR", tekst → bez zmian
function regText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  }
  return norm(v);
}

// --- guard idempotencji ---
const existing = await db.select().from(schema.hrEmployees);
if (existing.length > 0) {
  console.log(`Baza kadr niepusta (${existing.length} pracowników) — przerywam.`);
  process.exit(1);
}

const wb = XLSX.read(readFileSync(FILE), { type: "buffer" });
const sheet = (name: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1,
    raw: true,
  }) as unknown[][];

// ==================== 1. NORMY (Rok) ====================
const rok = sheet("Rok");
let normCount = 0;
for (let i = 1; i <= 12; i++) {
  const r = rok[i];
  if (!r || !MONTHS[norm(r[1])]) continue;
  await db.insert(schema.hrMonthNorms).values({
    year: YEAR,
    month: MONTHS[norm(r[1])],
    workNorm: num(r[2]) ?? 160,
    contractNorm: num(r[3]) ?? 158,
  });
  normCount++;
}
console.log(`Normy: ${normCount} miesięcy ${YEAR}`);

// ==================== 2. OBIEKTY ====================
const objectIds = new Map<string, number>();
async function ensureObject(name: string): Promise<number> {
  const key = name.toUpperCase();
  let id = objectIds.get(key);
  if (id) return id;
  const [row] = await db.insert(schema.hrObjects).values({ name }).returning();
  objectIds.set(key, row.id);
  return row.id;
}
for (const r of sheet("Obiekty").slice(1)) {
  const name = norm(r[0]);
  if (name) await ensureObject(name);
}
console.log(`Obiekty: ${objectIds.size}`);

// ==================== 3. PRACOWNICY ====================
const hoursRows = sheet("Wypracowane godziny").slice(1);
const wyn = sheet("WYNAGRODZENIA");
const biuro = sheet("WYNAGRODZENIA - Biuro").slice(1);
const lista = sheet("Lista pracowników").slice(1);

const codeByName = new Map<string, string>();
for (const r of lista) {
  const name = norm(r[0]);
  const code = norm(r[1]);
  if (name && code) codeByName.set(name, code);
}

const names = new Set<string>();
for (const r of hoursRows) if (norm(r[0])) names.add(norm(r[0]));
for (const r of wyn.slice(1)) if (norm(r[0])) names.add(norm(r[0]));
for (const r of biuro) if (norm(r[0])) names.add(norm(r[0]));

const employeeIds = new Map<string, number>();
for (const name of [...names].sort((a, b) => a.localeCompare(b, "pl"))) {
  const [row] = await db
    .insert(schema.hrEmployees)
    .values({ fullName: name, code: codeByName.get(name) ?? "" })
    .returning();
  employeeIds.set(name, row.id);
}
console.log(`Pracownicy: ${employeeIds.size}`);

// ==================== 4. GODZINY (Styczeń–Czerwiec) ====================
let hoursCount = 0;
let hoursSkipped = 0;
for (const r of hoursRows) {
  const name = norm(r[0]);
  const month = MONTHS[norm(r[9])];
  if (!name || !month) {
    if (r.some((v) => v != null && v !== "")) hoursSkipped++;
    continue;
  }
  const objectName = norm(r[1]);
  await db.insert(schema.hrHours).values({
    employeeId: employeeIds.get(name)!,
    objectId: objectName ? await ensureObject(objectName) : null,
    year: YEAR,
    month,
    nightHours: num(r[2]),
    workedHours: num(r[3]),
    uwHours: num(r[4]),
    l4Hours: num(r[5]),
    maxHours: num(r[6]),
    deductions: num(r[7]),
    bonuses: num(r[8]),
    notes: norm(r[10]),
  });
  hoursCount++;
}
console.log(`Godziny: ${hoursCount} wpisów (pominięte niekompletne: ${hoursSkipped})`);

// ==================== 5. UMOWY + WEJŚCIA PŁACOWE (czerwiec) ====================
// Nadpisania formuł wykrywane wprost: komórka z wartością, bez formuły.
const ws = wb.Sheets["WYNAGRODZENIA"];
const cellAt = (col: string, row: number) =>
  ws[`${col}${row}`] as { v?: unknown; f?: string } | undefined;
const manualValue = (col: string, row: number): number | null => {
  const cell = cellAt(col, row);
  if (cell && cell.f === undefined && typeof cell.v === "number") return cell.v;
  return null;
};

type BonusType = "brak" | "gotowka" | "delegacja_przelew" | "delegacja_gotowka";
const BONUS_MAP: Record<string, BonusType> = {
  "Gotowka": "gotowka",
  "Gotówka": "gotowka",
  "Delegacja - przelew": "delegacja_przelew",
  "Delegacja - gotówka": "delegacja_gotowka",
};

interface ExcelRow {
  excelRow: number;
  contractId: number;
  name: string;
  company: string;
  vExcel: number | null;
  wExcel: number | null;
  xExcel: number | null;
}
const excelRows: ExcelRow[] = [];
let contractCount = 0;
let payrollCount = 0;

for (let i = 1; i < wyn.length; i++) {
  const r = wyn[i];
  const name = norm(r?.[0]);
  if (!name) continue;
  const excelRow = i + 1;
  const bonusRaw = norm(r[11]);
  const bonusType = BONUS_MAP[bonusRaw] ?? "brak";
  if (bonusRaw && !BONUS_MAP[bonusRaw]) {
    console.warn(`  UWAGA w.${excelRow}: nieznany DODATEK "${bonusRaw}" → brak`);
  }
  const [contract] = await db
    .insert(schema.hrContracts)
    .values({
      employeeId: employeeIds.get(name)!,
      company: norm(r[2]),
      contractType: norm(r[3]) === "Praca" ? "praca" : "zlecenie",
      chor: /tak/i.test(norm(r[4])),
      zwua: regText(r[5]),
      zua: regText(r[6]),
      zza: regText(r[7]),
      objectName: norm(r[1]),
      mainChannel: norm(r[10]) === "Gotówka" ? "gotowka" : "przelew",
      bonusType,
    })
    .returning();
  contractCount++;

  // wejścia płacowe czerwca: R=kwota główna, Q=stawka dodatku ("do przeliczenia"
  // → flaga), O=wyrównanie; nadpisania formuł: I→maks, J→fakt, S→kwota dodatku
  const qRaw = r[16];
  const inputs = {
    mainAmount: num(r[17]),
    bonusRate: num(qRaw),
    bonusRatePending: typeof qRaw === "string" && qRaw.trim() !== "",
    rateAdjustment: num(r[14]),
    maxHoursOverride: manualValue("I", excelRow),
    actualHoursOverride: manualValue("J", excelRow),
    bonusAmountOverride: manualValue("S", excelRow),
  };
  if (
    Object.values(inputs).some((v) => v != null && v !== false) ||
    inputs.bonusRatePending
  ) {
    await db.insert(schema.hrPayroll).values({
      contractId: contract.id,
      year: YEAR,
      month: IMPORT_MONTH,
      ...inputs,
    });
    payrollCount++;
  }

  excelRows.push({
    excelRow,
    contractId: contract.id,
    name,
    company: norm(r[2]),
    vExcel: num(r[21]),
    wExcel: num(r[22]),
    xExcel: num(r[23]),
  });
}
console.log(`Umowy: ${contractCount}, wpisy płacowe czerwca: ${payrollCount}`);

// ==================== 6. BIURO (czerwiec) ====================
const wsB = wb.Sheets["WYNAGRODZENIA - Biuro"];
let officeCount = 0;
for (let i = 0; i < biuro.length; i++) {
  const r = biuro[i];
  const name = norm(r[0]);
  if (!name) continue;
  const excelRow = i + 2;
  const amountCell = wsB[`H${excelRow}`] as { v?: unknown; f?: string } | undefined;
  const cashCell = wsB[`L${excelRow}`] as { v?: unknown; f?: string } | undefined;
  const amount =
    amountCell?.f === undefined && typeof amountCell?.v === "number"
      ? amountCell.v
      : null; // formuła godziny×stawka → policzy aplikacja
  const rorBase = num(r[10]);
  const cashExcel = typeof cashCell?.v === "number" ? cashCell.v : null;
  // gotówka: zapisz ręcznie tylko gdy różna od tego, co wyliczy aplikacja
  const amountEff =
    amount ?? (num(r[5]) != null && num(r[6]) != null ? num(r[5])! * num(r[6])! : null);
  const cashComputed =
    amountEff != null && rorBase != null && amountEff > rorBase
      ? round2(amountEff - rorBase)
      : null;
  const cashOverride =
    cashExcel != null && cashExcel !== cashComputed ? cashExcel : null;

  await db.insert(schema.hrOfficePayroll).values({
    employeeId: employeeIds.get(name)!,
    year: YEAR,
    month: IMPORT_MONTH,
    company: norm(r[9]),
    etatHours: num(r[1]),
    uwL4: num(r[2]),
    deductions: num(r[3]),
    bonuses: num(r[4]),
    hoursForAccounting: num(r[5]),
    rate: num(r[6]),
    amount,
    rorBase,
    cashOverride,
    notes: "",
  });
  officeCount++;
}
console.log(`Biuro: ${officeCount} wpisów czerwca`);

// ==================== 7. WERYFIKACJA vs arkusz ====================
console.log("\n=== WERYFIKACJA: kalkulacja aplikacji vs Excel (czerwiec) ===");
const [contracts, payrollRows, hRows, normRow] = await Promise.all([
  db.select().from(schema.hrContracts),
  db
    .select()
    .from(schema.hrPayroll)
    .where(
      and(eq(schema.hrPayroll.year, YEAR), eq(schema.hrPayroll.month, IMPORT_MONTH)),
    ),
  db
    .select()
    .from(schema.hrHours)
    .where(and(eq(schema.hrHours.year, YEAR), eq(schema.hrHours.month, IMPORT_MONTH))),
  db
    .select()
    .from(schema.hrMonthNorms)
    .where(
      and(
        eq(schema.hrMonthNorms.year, YEAR),
        eq(schema.hrMonthNorms.month, IMPORT_MONTH),
      ),
    ),
]);

const computed = computePayroll({
  contracts,
  payrollByContract: new Map(payrollRows.map((p) => [p.contractId, p])),
  hoursByEmployee: buildHoursAggregates(hRows),
  workNorm: normRow[0].workNorm,
  contractNorm: normRow[0].contractNorm,
});
const byContract = new Map(computed.map((r) => [r.contractId, r]));

let ok = 0;
const diffs: string[] = [];
for (const er of excelRows) {
  const calc = byContract.get(er.contractId)!;
  const close = (a: number | null, b: number) => Math.abs((a ?? 0) - b) < 0.02;
  if (close(er.xExcel, calc.wyplata) && close(er.vExcel, calc.przelew) && close(er.wExcel, calc.gotowka)) {
    ok++;
  } else {
    diffs.push(
      `  w.${er.excelRow} ${er.name} (${er.company}): ` +
        `Excel V=${er.vExcel ?? "—"} W=${er.wExcel ?? "—"} X=${er.xExcel ?? "—"} | ` +
        `app przelew=${calc.przelew} gotówka=${calc.gotowka} wypłata=${calc.wyplata}` +
        (calc.warnings.length ? ` [${calc.warnings.join("; ")}]` : ""),
    );
  }
}
console.log(`Zgodne wiersze: ${ok}/${excelRows.length}`);
if (diffs.length) {
  console.log("Rozbieżności (spodziewane m.in. premie bez DODATKU — poprawka logiki):");
  for (const d of diffs) console.log(d);
}

process.exit(0);
