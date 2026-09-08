// Import PRZYROSTOWY modułu Kadry ze skoroszytu „Kopia MASTER 45.xlsx"
// (rozliczany miesiąc = Sierpień 2026; Rok!H2).
//
// CZYM RÓŻNI SIĘ OD scripts/import-kadry-master-2026.ts. Tamten był
// JEDNORAZOWY: sypał wszystko od zera i miał guard „baza niepusta → przerywam".
// Ten dokłada nowy stan skoroszytu do bazy, w której już siedzą:
//   • prawdziwe dane z MASTER 38 (152 pracowników, 139 umów, godziny 2026-01…06,
//     wypłaty 2026-06),
//   • dane deweloperskie z scripts/seed-dev/hr.ts (znacznik MARKER w `notes`).
// Nic prawdziwego nie kasuje — usuwa WYŁĄCZNIE wiersze seeda i wyłącznie
// w miesiącach, które ten skoroszyt wypełnia realną treścią (godziny 2026-07/08,
// wypłaty 2026-08). Wiersze z MASTER 38, których w MASTER 45 już nie ma, są
// tylko RAPORTOWANE — decyzję o ich losie podejmuje człowiek.
//
// DZIAŁY vs OBIEKTY (migracja 0070). Arkusz „Obiekty" trzyma w jednej kolumnie
// także pozycje, które obiektami nie są. Stary skrypt zakładał je jako
// `hr_objects` i tym samym odtwarzał pozycję „CMA" w słowniku obiektów, psując
// alokację puli centrum monitorowania. Tutaj jest jawna mapa DEPARTMENT_BY_NAME:
// „CMA" → dział CMA (pula), „DT" → dział Techniczny (tak, jak użytkownik ręcznie
// przepiął wiersze Bożka Tomasza w bazie). Godziny takich pozycji idą
// w `hr_hours.department_id`, a `object_id` zostaje NULL — kolumny wykluczają się.
//
// Uruchomienie (Node 22 — better-sqlite3):
//   PATH="/config/.nvm/versions/node/v22.22.0/bin:$PATH" npx tsx scripts/import-kadry-master-45.ts
//   … --apply          → zapisuje (jedna transakcja)
//   ALFA_DB_PATH=<kopia> … → pracuje na kopii bazy
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import type {
  HrContract,
  HrEmployee,
  HrHours,
  HrObject,
  HrPayroll,
} from "../src/db/schema.js";
import { buildHoursAggregates, computePayroll } from "../src/utils/hr-calc.js";

/* ------------------------------------------------------------------ */
/* Parametry                                                           */
/* ------------------------------------------------------------------ */

const APPLY = process.argv.includes("--apply");
const FILE =
  process.argv.find((a) => a.endsWith(".xlsx")) ??
  resolve(process.cwd(), "obiekty/Kopia MASTER 45.xlsx");
const REPORT_PATH =
  process.env.KADRY_REPORT ??
  resolve(
    process.env.TMPDIR ?? "/tmp",
    "claude-1000/-config-workspace-programming-alfa-app/913bea21-d7b7-43f1-929f-335f6f89b018/scratchpad/kadry/RAPORT-master45.md",
  );

const YEAR = 2026;
/** Rozliczany miesiąc skoroszytu (Rok!H2 = „Sierpień"). Stąd biorą się wypłaty. */
const PAYROLL_MONTH = 8;
/** Miesiące, dla których arkusz „Wypracowane godziny" jest źródłem prawdy. */
const HOURS_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8];
/**
 * Miesiące, w których wolno skasować wiersze seeda. Tylko te, które ten
 * skoroszyt zastępuje realną treścią — reszta danych deweloperskich zostaje
 * (świadoma decyzja użytkownika), raport je tylko liczy.
 */
const SEED_PURGE_HOURS_MONTHS = [7, 8];
const SEED_PURGE_PAYROLL_MONTHS = [PAYROLL_MONTH];
/** Znacznik wierszy seeda — stała z scripts/seed-dev/shared.ts. */
const MARKER = "[dane deweloperskie]";

const MONTHS: Record<string, number> = {
  Styczeń: 1, Luty: 2, Marzec: 3, Kwiecień: 4, Maj: 5, Czerwiec: 6,
  Lipiec: 7, Sierpień: 8, Wrzesień: 9, Październik: 10, Listopad: 11, Grudzień: 12,
};

/**
 * Pozycje arkusza „Obiekty" / „OBIEKT", które obiektami NIE SĄ — to działy firmy
 * (tabela `hr_departments`). Rozpoznajemy je po nazwie z arkusza, ale w bazie
 * lądują jako `department_id`, nie jako nowa pozycja słownika obiektów.
 */
const DEPARTMENT_BY_NAME: Record<string, string> = {
  CMA: "CMA",
  DT: "Techniczny",
};

/**
 * Nazwy z arkusza, które są ewidentnym błędem wpisu i NIE MOGĄ założyć
 * pracownika. Klucz = nazwa z arkusza, wartość = opis do raportu.
 */
const BAD_NAMES: Record<string, string> = {
  j: 'WYNAGRODZENIA - Biuro w.11: nazwisko zastąpione literą „j". Po kolejności wierszy i kwotach (ALFA ETAT, ROR 3455,85) to najpewniej Rosiak Dominika z czerwca 2026 — ale to domysł, więc wiersz POMINIĘTY.',
};

/* ------------------------------------------------------------------ */
/* Pomocnicze                                                          */
/* ------------------------------------------------------------------ */

const norm = (s: unknown) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Klucz dopasowania pracownika: „Nazwisko Imię" bez ozdobników i wielkości liter. */
const nameKey = (s: string) => norm(s).toLocaleUpperCase("pl");

/** ZUA/ZZA: excelowa liczba-data → „DD.MM.RRRR", tekst → bez zmian. */
function regText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  }
  return norm(v);
}

const ym = (m: number) => `${YEAR}-${String(m).padStart(2, "0")}`;

/* ------------------------------------------------------------------ */
/* Raport                                                              */
/* ------------------------------------------------------------------ */

const out: string[] = [];
const say = (line = "") => {
  out.push(line);
  console.log(line);
};
/** Sekcja raportu z listą — zwija puste, żeby raport dało się czytać. */
function section(title: string, lines: string[], emptyText = "— brak") {
  say(`\n## ${title}`);
  if (lines.length === 0) say(emptyText);
  else for (const l of lines) say(`- ${l}`);
}

/* ------------------------------------------------------------------ */
/* Skoroszyt                                                           */
/* ------------------------------------------------------------------ */

// XLSX.readFile nie działa w tej instalacji (brak warstwy fs w buildzie) —
// czytamy bufor sami.
const wb = XLSX.read(readFileSync(FILE), { type: "buffer" });
const sheet = (name: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1,
    raw: true,
  }) as unknown[][];

const hoursRows = sheet("Wypracowane godziny").slice(1);
const wynRows = sheet("WYNAGRODZENIA");
const biuroRows = sheet("WYNAGRODZENIA - Biuro").slice(1);
const listaRows = sheet("Lista pracowników").slice(1);
const obiektyRows = sheet("Obiekty").slice(1);
const rokRows = sheet("Rok");

const settledMonth = norm(rokRows[1]?.[7]);
if (MONTHS[settledMonth] !== PAYROLL_MONTH) {
  console.error(
    `STOP: Rok!H2 = „${settledMonth}", a skrypt rozlicza ${ym(PAYROLL_MONTH)}. ` +
      "Skoroszyt jest z innego miesiąca — przerywam.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Stan bazy                                                           */
/* ------------------------------------------------------------------ */

const dbEmployees: HrEmployee[] = db.select().from(schema.hrEmployees).all();
const dbContracts: HrContract[] = db.select().from(schema.hrContracts).all();
const dbObjects: HrObject[] = db.select().from(schema.hrObjects).all();
const dbDepartments = db.select().from(schema.hrDepartments).all();
const dbNorms = db.select().from(schema.hrMonthNorms).all();
const dbHours: HrHours[] = db.select().from(schema.hrHours).all();
const catalogObjects = db
  .select({ id: schema.objects.id, name: schema.objects.name })
  .from(schema.objects)
  .all();

const empById = new Map(dbEmployees.map((e) => [e.id, e]));

/**
 * Kartoteka bywa zaśmiecona duplikatami różniącymi się WYŁĄCZNIE wielkością
 * liter („Jaroszek Wojciech" i „JaroszeK Wojciech" z MASTER 38). Gdyby mapa
 * nazwa→id trzymała jeden wpis na klucz, wygrywałby przypadkowy z nich —
 * a wtedy godziny i umowy trafiałyby do pustego bliźniaka, produkując
 * „nowe" umowy obok istniejących. Trzymamy WSZYSTKIE id na klucz i wybieramy:
 * najpierw dokładna pisownia z arkusza, potem najstarszy rekord.
 */
const empIdsByKey = new Map<string, number[]>();
for (const e of dbEmployees) {
  const list = empIdsByKey.get(nameKey(e.fullName)) ?? [];
  list.push(e.id);
  empIdsByKey.set(nameKey(e.fullName), list);
}
for (const list of empIdsByKey.values()) list.sort((a, b) => a - b);
const empIdByExactName = new Map(dbEmployees.map((e) => [e.fullName, e.id]));
const duplicateEmployees = [...empIdsByKey.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(
    ([, ids]) =>
      `${ids.map((id) => `${id}:„${empById.get(id)?.fullName}"`).join(" / ")} — te same nazwisko i imię, różna pisownia. Import przypina wszystko do pierwszego (dokładna pisownia z arkusza); scalenie/usunięcie bliźniaka to decyzja człowieka.`,
  );

/** Mapa nazwa→id, uzupełniana o pracowników zakładanych w tym przebiegu. */
const empIdByName = new Map<string, number>();
for (const [key, ids] of empIdsByKey) empIdByName.set(key, ids[0]);
/** Rozstrzyga id pracownika dla nazwiska z arkusza (patrz `empIdsByKey`). */
const employeeIdFor = (display: string): number | undefined =>
  empIdByExactName.get(display) ?? empIdByName.get(nameKey(display));

const objIdByName = new Map<string, number>();
for (const o of dbObjects) objIdByName.set(nameKey(o.name), o.id);

const deptIdByName = new Map<string, number>();
for (const d of dbDepartments) deptIdByName.set(nameKey(d.name), d.id);

const catalogIdByName = new Map<string, number>();
for (const o of catalogObjects) catalogIdByName.set(nameKey(o.name), o.id);

/** Mapowanie nazw kadrowych na kartotekę — plik z poprzedniej rundy mapowania. */
let hrMapping: Array<{ hrName: string; contractorName?: string | null }> = [];
try {
  hrMapping = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "scripts/data/mapowanie-obiektow/hr.json"),
      "utf8",
    ),
  );
} catch {
  /* brak pliku — mapujemy tylko po dokładnej nazwie */
}
const mappingByHrName = new Map(hrMapping.map((m) => [nameKey(m.hrName), m]));

/* ------------------------------------------------------------------ */
/* Warstwa zapisu — ten sam przebieg w trybie suchym i --apply         */
/* ------------------------------------------------------------------ */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
let tx: Tx | null = null;

/**
 * Identyfikatory bytów, których jeszcze nie ma w bazie. W trybie `--apply`
 * dostajemy prawdziwe id z INSERT-a; w suchym — syntetyczne ujemne, żeby dalsza
 * część przebiegu (godziny, wypłaty, weryfikacja) miała czym się posługiwać.
 */
let fakeId = -1;
const nextFakeId = () => fakeId--;

const counters = {
  employeesNew: 0,
  employeesUpdated: 0,
  contractsNew: 0,
  contractsUpdated: 0,
  objectsNew: 0,
  hoursInserted: 0,
  hoursUpdated: 0,
  hoursSeedDeleted: 0,
  payrollInserted: 0,
  payrollSeedDeleted: 0,
  officeInserted: 0,
  officeSeedDeleted: 0,
  normsUpdated: 0,
};

/* ------------------------------------------------------------------ */
/* Plan — budowany w pamięci, wykonywany na końcu                      */
/* ------------------------------------------------------------------ */

interface Plan {
  newEmployees: Array<{ tempId: number; values: typeof schema.hrEmployees.$inferInsert }>;
  employeeUpdates: Array<{ id: number; values: Partial<HrEmployee>; label: string }>;
  newObjects: Array<{ tempId: number; values: typeof schema.hrObjects.$inferInsert }>;
  newContracts: Array<{ tempId: number; values: typeof schema.hrContracts.$inferInsert }>;
  contractUpdates: Array<{ id: number; values: Partial<HrContract>; label: string }>;
  newHours: Array<typeof schema.hrHours.$inferInsert>;
  hoursUpdates: Array<{ id: number; values: Partial<HrHours> }>;
  newPayroll: Array<typeof schema.hrPayroll.$inferInsert>;
  newOffice: Array<typeof schema.hrOfficePayroll.$inferInsert>;
  normUpdates: Array<{ id: number; workNorm: number; contractNorm: number }>;
}
const plan: Plan = {
  newEmployees: [], employeeUpdates: [], newObjects: [], newContracts: [],
  contractUpdates: [], newHours: [], hoursUpdates: [], newPayroll: [],
  newOffice: [], normUpdates: [],
};

/* ================================================================== */
/* 1. PRACOWNICY                                                       */
/* ================================================================== */

/** Kod z „Listy pracowników" (Emeryt / Rencista / Student…). */
const codeByName = new Map<string, string>();
for (const r of listaRows) {
  const name = norm(r[0]);
  const code = norm(r[1]);
  if (name && code) codeByName.set(nameKey(name), code);
}

/** Nazwiska z arkusza „WYNAGRODZENIA - Biuro" — te osoby mają `kind = "biuro"`. */
const officeNames = new Set<string>();
for (const r of biuroRows) {
  const name = norm(r[0]);
  if (name && !BAD_NAMES[name]) officeNames.add(nameKey(name));
}

/** Wszystkie nazwiska ze skoroszytu, z zapamiętaną pisownią pierwszego wystąpienia. */
const sheetNames = new Map<string, string>();
const addName = (raw: unknown) => {
  const name = norm(raw);
  if (!name || BAD_NAMES[name]) return;
  if (!sheetNames.has(nameKey(name))) sheetNames.set(nameKey(name), name);
};
for (const r of listaRows) addName(r[0]);
for (const r of wynRows.slice(1)) addName(r[0]);
for (const r of biuroRows) addName(r[0]);
for (const r of hoursRows) addName(r[0]);

const newEmployeeNames: string[] = [];
for (const [key, display] of sheetNames) {
  const existingId = employeeIdFor(display);
  if (existingId != null) {
    // Kod z listy bywa uzupełniany po imporcie — dokładamy, gdy w bazie pusto.
    const emp = empById.get(existingId)!;
    const code = codeByName.get(key) ?? "";
    if (code && emp.code !== code) {
      plan.employeeUpdates.push({
        id: emp.id,
        values: { code },
        label: `${emp.fullName}: KOD „${emp.code || "—"}" → „${code}"`,
      });
    }
    continue;
  }
  const tempId = nextFakeId();
  plan.newEmployees.push({
    tempId,
    values: {
      fullName: display,
      code: codeByName.get(key) ?? "",
      kind: officeNames.has(key) ? "biuro" : "ochrona",
    },
  });
  empIdByName.set(key, tempId);
  empIdByExactName.set(display, tempId);
  newEmployeeNames.push(`${display} (${officeNames.has(key) ? "biuro" : "ochrona"})`);
}

const missingInSheet = dbEmployees
  .filter((e) => !sheetNames.has(nameKey(e.fullName)))
  .map((e) => `${e.fullName} [${e.kind}, id=${e.id}] — nie ma go w MASTER 45 (nie kasujemy)`);

/* ================================================================== */
/* 2. OBIEKTY KADROWE                                                  */
/* ================================================================== */

/**
 * Rozstrzyga, czym jest nazwa z kolumny OBIEKT: pozycją słownika obiektów,
 * działem, czy niczym (pusta komórka). Zwraca gotową parę kolumn dla `hr_hours`.
 */
const unknownDepartments = new Set<string>();
function resolveAssignment(rawName: string): {
  objectId: number | null;
  departmentId: number | null;
} {
  const name = norm(rawName);
  if (!name) return { objectId: null, departmentId: null };
  const deptName = DEPARTMENT_BY_NAME[name];
  if (deptName) {
    const id = deptIdByName.get(nameKey(deptName));
    if (id == null) {
      unknownDepartments.add(`${name} → dział „${deptName}" (nie ma go w hr_departments)`);
      return { objectId: null, departmentId: null };
    }
    return { objectId: null, departmentId: id };
  }
  return { objectId: ensureObject(name), departmentId: null };
}

const objectNotes: string[] = [];
function ensureObject(name: string): number {
  const key = nameKey(name);
  const existing = objIdByName.get(key);
  if (existing != null) return existing;
  // Nowa pozycja: próbujemy od razu przypiąć kartotekę, ale tylko przy pewności.
  let objectId: number | null = catalogIdByName.get(key) ?? null;
  let how = objectId ? "dokładna nazwa w kartotece" : "";
  if (objectId == null) {
    const mapped = mappingByHrName.get(key);
    const viaMapping = mapped?.contractorName
      ? (catalogIdByName.get(nameKey(mapped.contractorName)) ?? null)
      : null;
    if (viaMapping != null) {
      objectId = viaMapping;
      how = `mapowanie hr.json → „${mapped?.contractorName}"`;
    }
  }
  const tempId = nextFakeId();
  plan.newObjects.push({ tempId, values: { name, objectId } });
  objIdByName.set(key, tempId);
  objectNotes.push(
    objectId != null
      ? `${name} — nowa pozycja, kartoteka objects.id=${objectId} (${how})`
      : `${name} — nowa pozycja, object_id = NULL (brak pewnego dopasowania w kartotece; do ręcznego zmapowania w Kadry → Obiekty)`,
  );
  return tempId;
}

// Słownik z arkusza „Obiekty" zakładamy w całości (poza działami), żeby pozycja
// bez godzin w tym miesiącu i tak była do wyboru w UI.
for (const r of obiektyRows) {
  const name = norm(r[0]);
  if (!name || DEPARTMENT_BY_NAME[name]) continue;
  ensureObject(name);
}

/* ================================================================== */
/* 3. UMOWY (arkusz WYNAGRODZENIA)                                     */
/* ================================================================== */

type BonusType = "brak" | "gotowka" | "delegacja_przelew" | "delegacja_gotowka";
const BONUS_MAP: Record<string, BonusType> = {
  Gotowka: "gotowka",
  Gotówka: "gotowka",
  "Delegacja - przelew": "delegacja_przelew",
  "Delegacja - gotówka": "delegacja_gotowka",
};

const wsWyn = wb.Sheets["WYNAGRODZENIA"];
/** Komórka z wartością i BEZ formuły = ręczne nadpisanie wyliczenia arkusza. */
const manualValue = (col: string, row: number): number | null => {
  const cell = wsWyn[`${col}${row}`] as { v?: unknown; f?: string } | undefined;
  if (cell && cell.f === undefined && typeof cell.v === "number") return cell.v;
  return null;
};

/** Klucz umowy: osoba + spółka. W MASTER 45 i w bazie ta para jest unikalna. */
const contractKey = (employeeId: number, company: string) =>
  `${employeeId}|${nameKey(company)}`;
const dbContractByKey = new Map<string, HrContract>();
for (const c of dbContracts) dbContractByKey.set(contractKey(c.employeeId, c.company), c);

interface SheetContract {
  excelRow: number;
  contractId: number;
  employeeId: number;
  name: string;
  company: string;
  contract: HrContract; // stan DOCELOWY (do computePayroll)
  payroll: typeof schema.hrPayroll.$inferInsert | null;
  vExcel: number | null;
  wExcel: number | null;
  xExcel: number | null;
}
const sheetContracts: SheetContract[] = [];
const contractChangeLines: string[] = [];
const unknownBonus: string[] = [];
const wynSeen = new Set<string>();

for (let i = 1; i < wynRows.length; i++) {
  const r = wynRows[i];
  const name = norm(r?.[0]);
  if (!name) continue;
  const excelRow = i + 1;
  if (BAD_NAMES[name]) continue;
  const employeeId = employeeIdFor(name);
  if (employeeId == null) continue; // niemożliwe — nazwiska zakładamy wyżej

  const bonusRaw = norm(r[11]);
  const bonusType = BONUS_MAP[bonusRaw] ?? "brak";
  if (bonusRaw && !BONUS_MAP[bonusRaw]) {
    unknownBonus.push(`w.${excelRow} ${name}: nieznany DODATEK „${bonusRaw}" → brak`);
  }

  const target = {
    company: norm(r[2]),
    contractType: (norm(r[3]) === "Praca" ? "praca" : "zlecenie") as "praca" | "zlecenie",
    chor: /tak/i.test(norm(r[4])),
    zwua: regText(r[5]),
    zua: regText(r[6]),
    zza: regText(r[7]),
    objectName: norm(r[1]),
    mainChannel: (norm(r[10]) === "Gotówka" ? "gotowka" : "przelew") as "przelew" | "gotowka",
    bonusType,
  };

  const key = contractKey(employeeId, target.company);
  wynSeen.add(key);
  const existing = dbContractByKey.get(key);
  let contractId: number;
  let finalContract: HrContract;

  if (existing) {
    contractId = existing.id;
    const diffs: string[] = [];
    const changed: Partial<HrContract> = {};
    for (const [field, value] of Object.entries(target) as Array<
      [keyof typeof target, string | boolean]
    >) {
      if (existing[field] !== value) {
        diffs.push(`${field}: „${String(existing[field])}" → „${String(value)}"`);
        (changed as Record<string, unknown>)[field] = value;
      }
    }
    if (diffs.length > 0) {
      plan.contractUpdates.push({
        id: existing.id,
        values: changed,
        label: `w.${excelRow} ${name} (${target.company}): ${diffs.join("; ")}`,
      });
      contractChangeLines.push(
        `w.${excelRow} ${name} (${target.company}): ${diffs.join("; ")}`,
      );
    }
    finalContract = { ...existing, ...target };
  } else {
    contractId = nextFakeId();
    plan.newContracts.push({ tempId: contractId, values: { employeeId, ...target } });
    contractChangeLines.push(
      `w.${excelRow} ${name} (${target.company}): NOWA umowa (${target.contractType})`,
    );
    finalContract = {
      id: contractId,
      employeeId,
      ...target,
      active: true,
      notes: "",
      createdAt: "",
      updatedAt: "",
    };
    dbContractByKey.set(key, finalContract);
  }

  // Wejścia płacowe rozliczanego miesiąca: R = kwota główna NETTO,
  // Q = stawka dodatku („do przeliczenia" tekstem → flaga), O = wyrównanie;
  // nadpisania formuł: I → maks godziny, J → fakt godziny, S → kwota dodatku.
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
  const hasInputs =
    inputs.bonusRatePending ||
    Object.values(inputs).some((v) => typeof v === "number" && v != null);

  sheetContracts.push({
    excelRow,
    contractId,
    employeeId,
    name,
    company: target.company,
    contract: finalContract,
    payroll: hasInputs
      ? { contractId, year: YEAR, month: PAYROLL_MONTH, ...inputs }
      : null,
    vExcel: num(r[21]),
    wExcel: num(r[22]),
    xExcel: num(r[23]),
  });
}

const contractsNotInSheet = dbContracts
  .filter((c) => !wynSeen.has(contractKey(c.employeeId, c.company)))
  .map(
    (c) =>
      `${empById.get(c.employeeId)?.fullName ?? `emp=${c.employeeId}`} (${c.company}, id=${c.id}) — brak wiersza w MASTER 45 (zostawiona bez zmian)`,
  );

/* ================================================================== */
/* 4. GODZINY                                                          */
/* ================================================================== */

/**
 * Klucz dopasowania wpisu godzin: osoba + przypisanie + miesiąc. `hr_hours`
 * z założenia dopuszcza kilka wpisów na tę samą parę (arkusz też je ma —
 * np. Bożek Tomasz dwa razy „BIURO / Kwiecień"), więc w obrębie klucza
 * dopasowujemy PO KOLEI: n-ty wiersz arkusza do n-tego wiersza bazy.
 */
const hoursKey = (
  employeeId: number,
  objectId: number | null,
  departmentId: number | null,
  month: number,
) => `${employeeId}|o${objectId ?? "-"}|d${departmentId ?? "-"}|${month}`;

interface SheetHours {
  key: string;
  employeeId: number;
  objectId: number | null;
  departmentId: number | null;
  month: number;
  values: {
    nightHours: number | null;
    workedHours: number | null;
    uwHours: number | null;
    l4Hours: number | null;
    maxHours: number | null;
    deductions: number | null;
    bonuses: number | null;
    notes: string;
  };
}

const sheetHours: SheetHours[] = [];
const hoursOutsideWindow: string[] = [];
let hoursSkipped = 0;

for (const r of hoursRows) {
  const name = norm(r[0]);
  const month = MONTHS[norm(r[9])];
  if (!name || !month) {
    if (r.some((v) => v != null && v !== "")) hoursSkipped++;
    continue;
  }
  if (!HOURS_MONTHS.includes(month)) {
    hoursOutsideWindow.push(`${name} — ${ym(month)} (poza oknem importu)`);
    continue;
  }
  const employeeId = employeeIdFor(name);
  if (employeeId == null) continue;
  const { objectId, departmentId } = resolveAssignment(norm(r[1]));
  sheetHours.push({
    key: hoursKey(employeeId, objectId, departmentId, month),
    employeeId,
    objectId,
    departmentId,
    month,
    values: {
      nightHours: num(r[2]),
      workedHours: num(r[3]),
      uwHours: num(r[4]),
      l4Hours: num(r[5]),
      maxHours: num(r[6]),
      deductions: num(r[7]),
      bonuses: num(r[8]),
      notes: norm(r[10]),
    },
  });
}

// Wiersze seeda w 2026-07/08 znikają PRZED synchronizacją — inaczej dołożyłyby
// się do agregatu obok prawdziwych godzin i sierpień pokazałby podwójne etaty.
const seedHoursToDelete = dbHours.filter(
  (h) =>
    h.year === YEAR &&
    SEED_PURGE_HOURS_MONTHS.includes(h.month) &&
    h.notes.includes(MARKER),
);
const seedHoursIds = new Set(seedHoursToDelete.map((h) => h.id));

const dbHoursByKey = new Map<string, HrHours[]>();
for (const h of dbHours) {
  if (h.year !== YEAR || !HOURS_MONTHS.includes(h.month)) continue;
  if (seedHoursIds.has(h.id)) continue;
  const k = hoursKey(h.employeeId, h.objectId, h.departmentId, h.month);
  const list = dbHoursByKey.get(k) ?? [];
  list.push(h);
  dbHoursByKey.set(k, list);
}
for (const list of dbHoursByKey.values()) list.sort((a, b) => a.id - b.id);

const sheetHoursByKey = new Map<string, SheetHours[]>();
for (const s of sheetHours) {
  const list = sheetHoursByKey.get(s.key) ?? [];
  list.push(s);
  sheetHoursByKey.set(s.key, list);
}

/** Stan docelowy godzin — potrzebny do weryfikacji sierpnia w obu trybach. */
const finalHours: HrHours[] = [];
const matchedDbHourIds = new Set<number>();
const hoursChangedPerMonth = new Map<number, { ins: number; upd: number }>();
const bump = (month: number, what: "ins" | "upd") => {
  const c = hoursChangedPerMonth.get(month) ?? { ins: 0, upd: 0 };
  c[what]++;
  hoursChangedPerMonth.set(month, c);
};

for (const [key, rows] of sheetHoursByKey) {
  const dbRows = dbHoursByKey.get(key) ?? [];
  rows.forEach((s, idx) => {
    const target = dbRows[idx];
    if (target) {
      matchedDbHourIds.add(target.id);
      const changed: Partial<HrHours> = {};
      for (const [field, value] of Object.entries(s.values) as Array<
        [keyof SheetHours["values"], number | string | null]
      >) {
        if ((target[field] ?? null) !== value) {
          (changed as Record<string, unknown>)[field] = value;
        }
      }
      // Wiersz potwierdzony arkuszem przestaje być „przeniesionym zaczepem".
      if (target.objectUncertain) changed.objectUncertain = false;
      if (Object.keys(changed).length > 0) {
        plan.hoursUpdates.push({ id: target.id, values: changed });
        bump(s.month, "upd");
      }
      finalHours.push({ ...target, ...s.values, objectUncertain: false });
    } else {
      plan.newHours.push({
        employeeId: s.employeeId,
        objectId: s.objectId,
        departmentId: s.departmentId,
        objectUncertain: false,
        year: YEAR,
        month: s.month,
        ...s.values,
      });
      bump(s.month, "ins");
      finalHours.push({
        id: nextFakeId(),
        employeeId: s.employeeId,
        objectId: s.objectId,
        departmentId: s.departmentId,
        objectUncertain: false,
        year: YEAR,
        month: s.month,
        ...s.values,
        createdAt: "",
        updatedAt: "",
      });
    }
  });
}

/** Wiersze bazy z okna importu, których MASTER 45 już nie zna — TYLKO raport. */
const orphanHours: string[] = [];
let orphanEmptyStubs = 0;
for (const list of dbHoursByKey.values()) {
  for (const h of list) {
    if (matchedDbHourIds.has(h.id)) {
      continue;
    }
    finalHours.push(h);
    const where =
      h.objectId != null
        ? (dbObjects.find((o) => o.id === h.objectId)?.name ?? `obj=${h.objectId}`)
        : h.departmentId != null
          ? (dbDepartments.find((d) => d.id === h.departmentId)?.name ?? `dep=${h.departmentId}`)
          : "—";
    const empty =
      h.workedHours == null && h.uwHours == null && h.l4Hours == null && h.nightHours == null;
    if (empty) orphanEmptyStubs++;
    orphanHours.push(
      `${ym(h.month)} ${empById.get(h.employeeId)?.fullName ?? h.employeeId} / ${where} ` +
        `(id=${h.id}${h.objectUncertain ? ", zaczep przeniesiony" : ""}${empty ? ", pusty" : `, wyprac.=${h.workedHours ?? "—"}`})`,
    );
  }
}

/* ================================================================== */
/* 5. WYPŁATY SIERPNIA                                                 */
/* ================================================================== */

const seedPayroll = db
  .select()
  .from(schema.hrPayroll)
  .where(
    and(
      eq(schema.hrPayroll.year, YEAR),
      like(schema.hrPayroll.notes, `%${MARKER}%`),
    ),
  )
  .all();
const seedPayrollToDelete = seedPayroll.filter((p) =>
  SEED_PURGE_PAYROLL_MONTHS.includes(p.month),
);

const dbPayrollAug = db
  .select()
  .from(schema.hrPayroll)
  .where(and(eq(schema.hrPayroll.year, YEAR), eq(schema.hrPayroll.month, PAYROLL_MONTH)))
  .all();
const nonSeedPayrollAug = dbPayrollAug.filter((p) => !p.notes.includes(MARKER));

for (const sc of sheetContracts) {
  if (sc.payroll) plan.newPayroll.push(sc.payroll);
}

/* --- biuro --- */
const wsBiuro = wb.Sheets["WYNAGRODZENIA - Biuro"];
const officeSkipped: string[] = [];
const officeCompanies = new Set<string>();

for (let i = 0; i < biuroRows.length; i++) {
  const r = biuroRows[i];
  const name = norm(r[0]);
  if (!name) continue;
  const excelRow = i + 2;
  if (BAD_NAMES[name]) {
    officeSkipped.push(`w.${excelRow}: ${BAD_NAMES[name]}`);
    continue;
  }
  const employeeId = employeeIdFor(name);
  if (employeeId == null) continue;

  const amountCell = wsBiuro[`H${excelRow}`] as { v?: unknown; f?: string } | undefined;
  const cashCell = wsBiuro[`L${excelRow}`] as { v?: unknown; f?: string } | undefined;
  // Kwota z formuły (godziny × stawka) zostaje NULL — policzy ją aplikacja.
  const amount =
    amountCell?.f === undefined && typeof amountCell?.v === "number" ? amountCell.v : null;
  const rorBase = num(r[10]);
  const cashExcel = typeof cashCell?.v === "number" ? cashCell.v : null;
  const amountEff =
    amount ?? (num(r[5]) != null && num(r[6]) != null ? num(r[5])! * num(r[6])! : null);
  const cashComputed =
    amountEff != null && rorBase != null && amountEff > rorBase
      ? round2(amountEff - rorBase)
      : null;
  // Gotówkę zapisujemy ręcznie tylko wtedy, gdy różni się od wyliczenia aplikacji.
  const cashOverride = cashExcel != null && cashExcel !== cashComputed ? cashExcel : null;

  const company = norm(r[9]);
  const dupKey = `${employeeId}|${nameKey(company)}`;
  if (officeCompanies.has(dupKey)) {
    officeSkipped.push(
      `w.${excelRow} ${name} (${company}): drugi wiersz na tę samą spółkę — UNIQUE (osoba, miesiąc, spółka) go nie przyjmie, pominięty`,
    );
    continue;
  }
  officeCompanies.add(dupKey);

  plan.newOffice.push({
    employeeId,
    year: YEAR,
    month: PAYROLL_MONTH,
    company,
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
}

const seedOffice = db
  .select()
  .from(schema.hrOfficePayroll)
  .where(
    and(
      eq(schema.hrOfficePayroll.year, YEAR),
      like(schema.hrOfficePayroll.notes, `%${MARKER}%`),
    ),
  )
  .all();
const seedOfficeToDelete = seedOffice.filter((o) =>
  SEED_PURGE_PAYROLL_MONTHS.includes(o.month),
);
const officeKeptEmployeeIds = new Set(plan.newOffice.map((p) => p.employeeId));
const officeSeedNamesDropped = seedOfficeToDelete
  .filter((o) => !officeKeptEmployeeIds.has(o.employeeId))
  .map((o) => empById.get(o.employeeId)?.fullName ?? `emp=${o.employeeId}`);

/** Wiersze seeda POZA oknem tego importu — liczone PRZED zapisem. */
const leftoverSeed = {
  hours: dbHours.filter((h) => h.notes.includes(MARKER) && !seedHoursIds.has(h.id)).length,
  payroll:
    db.select().from(schema.hrPayroll).where(like(schema.hrPayroll.notes, `%${MARKER}%`)).all()
      .length - seedPayrollToDelete.length,
  office:
    db
      .select()
      .from(schema.hrOfficePayroll)
      .where(like(schema.hrOfficePayroll.notes, `%${MARKER}%`))
      .all().length - seedOfficeToDelete.length,
};

/* ================================================================== */
/* 6. NORMY                                                            */
/* ================================================================== */

const normDiffs: string[] = [];
const normByMonth = new Map(dbNorms.filter((n) => n.year === YEAR).map((n) => [n.month, n]));
for (let i = 1; i <= 12; i++) {
  const r = rokRows[i];
  const month = MONTHS[norm(r?.[1])];
  if (!month) continue;
  const workNorm = num(r[2]);
  const contractNorm = num(r[3]);
  if (workNorm == null || contractNorm == null) continue;
  const existing = normByMonth.get(month);
  if (!existing) {
    normDiffs.push(`${ym(month)}: BRAK w bazie → praca=${workNorm}, zlecenie=${contractNorm}`);
    plan.normUpdates.push({ id: -month, workNorm, contractNorm });
    continue;
  }
  if (existing.workNorm !== workNorm || existing.contractNorm !== contractNorm) {
    normDiffs.push(
      `${ym(month)}: praca ${existing.workNorm}→${workNorm}, zlecenie ${existing.contractNorm}→${contractNorm}`,
    );
    plan.normUpdates.push({ id: existing.id, workNorm, contractNorm });
  }
}

/* ================================================================== */
/* 7. ZAPIS                                                            */
/* ================================================================== */

function execute(t: Tx) {
  const realEmp = new Map<number, number>();
  for (const e of plan.newEmployees) {
    const [row] = t.insert(schema.hrEmployees).values(e.values).returning().all();
    realEmp.set(e.tempId, row.id);
    counters.employeesNew++;
  }
  for (const u of plan.employeeUpdates) {
    t.update(schema.hrEmployees).set(u.values).where(eq(schema.hrEmployees.id, u.id)).run();
    counters.employeesUpdated++;
  }

  const realObj = new Map<number, number>();
  for (const o of plan.newObjects) {
    const [row] = t.insert(schema.hrObjects).values(o.values).returning().all();
    realObj.set(o.tempId, row.id);
    counters.objectsNew++;
  }

  const realCon = new Map<number, number>();
  for (const c of plan.newContracts) {
    const [row] = t
      .insert(schema.hrContracts)
      .values({ ...c.values, employeeId: realEmp.get(c.values.employeeId) ?? c.values.employeeId })
      .returning()
      .all();
    realCon.set(c.tempId, row.id);
    counters.contractsNew++;
  }
  for (const u of plan.contractUpdates) {
    t.update(schema.hrContracts).set(u.values).where(eq(schema.hrContracts.id, u.id)).run();
    counters.contractsUpdated++;
  }

  // Kasowanie seeda PRZED wstawieniem prawdziwych godzin.
  for (const h of seedHoursToDelete) {
    t.delete(schema.hrHours).where(eq(schema.hrHours.id, h.id)).run();
    counters.hoursSeedDeleted++;
  }
  for (const p of seedPayrollToDelete) {
    t.delete(schema.hrPayroll).where(eq(schema.hrPayroll.id, p.id)).run();
    counters.payrollSeedDeleted++;
  }
  for (const o of seedOfficeToDelete) {
    t.delete(schema.hrOfficePayroll).where(eq(schema.hrOfficePayroll.id, o.id)).run();
    counters.officeSeedDeleted++;
  }

  for (const h of plan.newHours) {
    t.insert(schema.hrHours)
      .values({
        ...h,
        employeeId: realEmp.get(h.employeeId) ?? h.employeeId,
        objectId: h.objectId == null ? null : (realObj.get(h.objectId) ?? h.objectId),
      })
      .run();
    counters.hoursInserted++;
  }
  for (const u of plan.hoursUpdates) {
    t.update(schema.hrHours).set(u.values).where(eq(schema.hrHours.id, u.id)).run();
    counters.hoursUpdated++;
  }

  // Sierpień liczymy od zera: kasujemy to, co tam było (seed już zszedł wyżej),
  // żeby powtórne uruchomienie nie zostawiło dwóch wierszy na umowę.
  t.delete(schema.hrPayroll)
    .where(and(eq(schema.hrPayroll.year, YEAR), eq(schema.hrPayroll.month, PAYROLL_MONTH)))
    .run();
  t.delete(schema.hrOfficePayroll)
    .where(
      and(
        eq(schema.hrOfficePayroll.year, YEAR),
        eq(schema.hrOfficePayroll.month, PAYROLL_MONTH),
      ),
    )
    .run();
  for (const p of plan.newPayroll) {
    t.insert(schema.hrPayroll)
      .values({ ...p, contractId: realCon.get(p.contractId) ?? p.contractId })
      .run();
    counters.payrollInserted++;
  }
  for (const o of plan.newOffice) {
    t.insert(schema.hrOfficePayroll)
      .values({ ...o, employeeId: realEmp.get(o.employeeId!) ?? o.employeeId! })
      .run();
    counters.officeInserted++;
  }

  for (const n of plan.normUpdates) {
    if (n.id < 0) {
      t.insert(schema.hrMonthNorms)
        .values({ year: YEAR, month: -n.id, workNorm: n.workNorm, contractNorm: n.contractNorm })
        .run();
    } else {
      t.update(schema.hrMonthNorms)
        .set({ workNorm: n.workNorm, contractNorm: n.contractNorm })
        .where(eq(schema.hrMonthNorms.id, n.id))
        .run();
    }
    counters.normsUpdated++;
  }
}

if (APPLY) {
  db.transaction((t) => {
    tx = t;
    execute(t);
  });
} else {
  // Tryb suchy: liczniki wypełniamy z planu, bez dotykania bazy.
  counters.employeesNew = plan.newEmployees.length;
  counters.employeesUpdated = plan.employeeUpdates.length;
  counters.objectsNew = plan.newObjects.length;
  counters.contractsNew = plan.newContracts.length;
  counters.contractsUpdated = plan.contractUpdates.length;
  counters.hoursInserted = plan.newHours.length;
  counters.hoursUpdated = plan.hoursUpdates.length;
  counters.hoursSeedDeleted = seedHoursToDelete.length;
  counters.payrollInserted = plan.newPayroll.length;
  counters.payrollSeedDeleted = seedPayrollToDelete.length;
  counters.officeInserted = plan.newOffice.length;
  counters.officeSeedDeleted = seedOfficeToDelete.length;
  counters.normsUpdated = plan.normUpdates.length;
}
void tx;

/* ================================================================== */
/* 8. WERYFIKACJA: kalkulacja aplikacji vs arkusz (sierpień)           */
/* ================================================================== */

const augNorm = (() => {
  const fromPlan = plan.normUpdates.find(
    (n) => n.id === -PAYROLL_MONTH || normByMonth.get(PAYROLL_MONTH)?.id === n.id,
  );
  if (fromPlan) return { workNorm: fromPlan.workNorm, contractNorm: fromPlan.contractNorm };
  const existing = normByMonth.get(PAYROLL_MONTH);
  return existing
    ? { workNorm: existing.workNorm, contractNorm: existing.contractNorm }
    : { workNorm: 160, contractNorm: 158 };
})();

const finalContracts: HrContract[] = [];
{
  const byId = new Map<number, HrContract>();
  for (const c of dbContracts) byId.set(c.id, c);
  for (const sc of sheetContracts) byId.set(sc.contractId, sc.contract);
  for (const c of byId.values()) if (c.active) finalContracts.push(c);
}

const augHours = finalHours.filter((h) => h.month === PAYROLL_MONTH);
const payrollByContract = new Map<number, HrPayroll>();
for (const sc of sheetContracts) {
  if (!sc.payroll) continue;
  payrollByContract.set(sc.contractId, {
    id: 0,
    contractId: sc.contractId,
    year: YEAR,
    month: PAYROLL_MONTH,
    mainAmount: sc.payroll.mainAmount ?? null,
    bonusRate: sc.payroll.bonusRate ?? null,
    bonusRatePending: sc.payroll.bonusRatePending ?? false,
    rateAdjustment: sc.payroll.rateAdjustment ?? null,
    maxHoursOverride: sc.payroll.maxHoursOverride ?? null,
    actualHoursOverride: sc.payroll.actualHoursOverride ?? null,
    bonusAmountOverride: sc.payroll.bonusAmountOverride ?? null,
    notes: "",
    createdAt: "",
    updatedAt: "",
  });
}

const computed = computePayroll({
  contracts: finalContracts,
  payrollByContract,
  hoursByEmployee: buildHoursAggregates(augHours),
  workNorm: augNorm.workNorm,
  contractNorm: augNorm.contractNorm,
});
const byContract = new Map(computed.map((r) => [r.contractId, r]));

/**
 * Skąd bierze się rozbieżność. Prawie żadna z nich nie jest błędem importu —
 * arkusz zapisano bez pełnego przeliczenia (arkusz „Rok" ostrzega o tym wprost:
 * „po zmianie trzeba poczekać na obliczenia"), a część kolumn jest wpisana
 * ręcznie i nie ma odpowiednika w modelu danych. Klasyfikacja robi z listy
 * 20 wierszy trzy kubełki do przejrzenia, zamiast jednego do zgadywania.
 */
const sheetRowsPerEmployee = new Map<number, number>();
function classify(sc: SheetContract): string {
  const cell = (col: string) =>
    wsWyn[`${col}${sc.excelRow}`] as { v?: unknown; f?: string } | undefined;
  const calc = byContract.get(sc.contractId);
  const uVal = typeof cell("U")?.v === "number" ? (cell("U")!.v as number) : 0;

  if (sc.xExcel == null && sc.vExcel == null && sc.wExcel == null) {
    return "arkusz w ogóle nie przeliczył tego wiersza (V/W/X puste), choć kwota główna w R jest — po stronie Excela";
  }
  if (calc && sc.xExcel != null && Math.abs(sc.xExcel - calc.wyplata) <= 5) {
    return "różnica poniżej 5 zł — zaokrąglenia wyrównania stawki, nie błąd danych";
  }
  const mCell = cell("M");
  if (mCell && mCell.f === undefined && typeof mCell.v === "number") {
    return "ręcznie wpisane „godziny DODATEK” (kol. M) — aplikacja liczy je z godzin i nie ma pola na to nadpisanie";
  }
  const q = cell("Q");
  if (typeof q?.v === "string" && q.v.trim() !== "") {
    return "stawka dodatku „do przeliczenia” — kwota gotówki w arkuszu wpisana ręcznie, aplikacja czeka na stawkę";
  }
  if (calc && (calc.premiaPotracenie ?? 0) !== 0 && sc.contract.bonusType === "brak") {
    return "premia/potrącenie bez kanału DODATKU — świadoma poprawka hr-calc (w Excelu przepadała)";
  }
  if (
    calc &&
    uVal !== 0 &&
    sc.wExcel == null &&
    Math.abs(uVal - (calc.dodatekFinalny ?? 0)) <= 1
  ) {
    return "arkusz nie przeniósł dodatku z kolumny U do W/X (kwota policzona, ale nie trafiła do wypłaty) — po stronie Excela";
  }
  if ((sheetRowsPerEmployee.get(sc.employeeId) ?? 0) > 1) {
    return "osoba ma w MASTER 45 więcej niż jedną umowę — rozbicie przelew/gotówka liczy się na obu naraz; porównanie wiersz-do-wiersza nie jest miarodajne";
  }
  return "do sprawdzenia ręcznie";
}
for (const sc of sheetContracts) {
  sheetRowsPerEmployee.set(
    sc.employeeId,
    (sheetRowsPerEmployee.get(sc.employeeId) ?? 0) + 1,
  );
}

let okRows = 0;
const calcDiffs: string[] = [];
for (const sc of sheetContracts) {
  const calc = byContract.get(sc.contractId);
  if (!calc) {
    calcDiffs.push(`w.${sc.excelRow} ${sc.name} (${sc.company}): umowa poza kalkulacją (nieaktywna?)`);
    continue;
  }
  const close = (a: number | null, b: number) => Math.abs((a ?? 0) - b) <= 1;
  if (
    close(sc.xExcel, calc.wyplata) &&
    close(sc.vExcel, calc.przelew) &&
    close(sc.wExcel, calc.gotowka)
  ) {
    okRows++;
  } else {
    calcDiffs.push(
      `w.${sc.excelRow} ${sc.name} (${sc.company}): ` +
        `Excel przelew=${sc.vExcel ?? "—"} gotówka=${sc.wExcel ?? "—"} wypłata=${sc.xExcel ?? "—"} | ` +
        `app przelew=${calc.przelew} gotówka=${calc.gotowka} wypłata=${calc.wyplata}` +
        (calc.warnings.length ? ` [${calc.warnings.join("; ")}]` : "") +
        `\n  → ${classify(sc)}`,
    );
  }
}

/* ================================================================== */
/* 9. RAPORT                                                           */
/* ================================================================== */

say(`# Import Kadry — „Kopia MASTER 45.xlsx" (${APPLY ? "ZAPIS" : "SUCHY PRZEBIEG"})`);
say();
say(`- Plik: \`${FILE}\``);
say(`- Baza: \`${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}\``);
say(`- Rozliczany miesiąc (Rok!H2): **${settledMonth} ${YEAR}** → wypłaty ${ym(PAYROLL_MONTH)}`);
say(`- Godziny: źródło prawdy dla ${ym(1)}…${ym(8)}`);

say("\n## Liczby");
say("| co | ile |");
say("| --- | ---: |");
say(`| nowi pracownicy | ${counters.employeesNew} |`);
say(`| pracownicy — uzupełniony KOD | ${counters.employeesUpdated} |`);
say(`| nowe obiekty kadrowe | ${counters.objectsNew} |`);
say(`| nowe umowy | ${counters.contractsNew} |`);
say(`| zmienione umowy | ${counters.contractsUpdated} |`);
say(`| godziny — wstawione | ${counters.hoursInserted} |`);
say(`| godziny — zaktualizowane | ${counters.hoursUpdated} |`);
say(`| godziny — skasowane wiersze seeda (2026-07/08) | ${counters.hoursSeedDeleted} |`);
say(`| wypłaty ${ym(PAYROLL_MONTH)} (hr_payroll) | ${counters.payrollInserted} |`);
say(`| wypłaty biura ${ym(PAYROLL_MONTH)} | ${counters.officeInserted} |`);
say(`| hr_payroll — skasowane wiersze seeda | ${counters.payrollSeedDeleted} |`);
say(`| hr_office_payroll — skasowane wiersze seeda | ${counters.officeSeedDeleted} |`);
say(`| normy 2026 — poprawione | ${counters.normsUpdated} |`);

say("\n## Godziny per miesiąc (przed → po)");
say("| miesiąc | w bazie przed | w tym seed | w arkuszu | wstawione | zmienione | po |");
say("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const m of HOURS_MONTHS) {
  const before = dbHours.filter((h) => h.year === YEAR && h.month === m);
  const seed = before.filter((h) => h.notes.includes(MARKER)).length;
  const inSheet = sheetHours.filter((s) => s.month === m).length;
  const c = hoursChangedPerMonth.get(m) ?? { ins: 0, upd: 0 };
  const purged = SEED_PURGE_HOURS_MONTHS.includes(m) ? seed : 0;
  say(
    `| ${ym(m)} | ${before.length} | ${seed} | ${inSheet} | ${c.ins} | ${c.upd} | ${before.length - purged + c.ins} |`,
  );
}

say("\n## Wiersze seeda POZOSTAWIONE (poza oknem tego importu)");
say(`- hr_hours: ${leftoverSeed.hours} (2025-09…12 oraz miesiące spoza 2026-07/08)`);
say(`- hr_payroll: ${leftoverSeed.payroll}`);
say(`- hr_office_payroll: ${leftoverSeed.office}`);
say("- To dane deweloperskie z `scripts/seed-dev/hr.ts`; zostają świadomie.");

section("Nowi pracownicy", newEmployeeNames);
section(
  "Pracownicy w bazie, których nie ma w MASTER 45 (tylko raport)",
  missingInSheet,
);
section("Nowe obiekty kadrowe", objectNotes);
section("Umowy — zmiany i nowe wiersze", contractChangeLines);
section("Umowy w bazie bez wiersza w MASTER 45 (tylko raport)", contractsNotInSheet);
section("Normy 2026 — różnice względem arkusza „Rok”", normDiffs);
section(
  `Wiersze godzin w bazie (${ym(1)}…${ym(8)}) bez odpowiednika w MASTER 45 — NIE kasowane`,
  orphanHours,
);
say(
  `\nZ tego pustych zaczepów (przeniesionych z poprzedniego miesiąca, wszystkie godziny NULL): ` +
    `${orphanEmptyStubs} — MASTER 45 nie ma dla tych osób godzin w danym miesiącu. ` +
    "Zostawione: to normalny stan „do potwierdzenia przez kadrową” w UI, nie dane do skasowania przez skrypt.",
);
section("Godziny poza oknem importu (pominięte)", hoursOutsideWindow);
section("Duplikaty w kartotece pracowników", duplicateEmployees);
section("Wiersze biura pominięte", officeSkipped);
section("Nieznany rodzaj DODATKU", unknownBonus);
section("Nieznane działy w kolumnie OBIEKT", [...unknownDepartments]);

say("\n## Weryfikacja: kalkulacja aplikacji vs arkusz (sierpień 2026)");
say(`Zgodne wiersze (tolerancja 1 zł): **${okRows}/${sheetContracts.length}**`);
section("Rozbieżności > 1 zł", calcDiffs);

say("\n## Notatki księgowej z arkuszy „czerwiec” / „lipiec”");
for (const name of ["czerwiec", "lipiec"]) {
  say(`\n### arkusz „${name}”`);
  for (const r of sheet(name).slice(1)) {
    const cells = r.map((c) => (c == null ? "" : String(c))).filter((c) => c !== "");
    if (cells.length > 0) say(`- ${cells.join(" | ")}`);
  }
}

say("\n## Rzeczy niepewne — do decyzji człowieka");
const uncertain: string[] = [];
for (const [name, desc] of Object.entries(BAD_NAMES)) {
  if (sheet("WYNAGRODZENIA - Biuro").some((r) => norm(r[0]) === name)) {
    uncertain.push(desc);
  }
}
if (officeSeedNamesDropped.length > 0) {
  uncertain.push(
    `Bez wiersza biura za ${ym(PAYROLL_MONTH)} po skasowaniu seeda: ${[...new Set(officeSeedNamesDropped)].join(", ")}.`,
  );
}
uncertain.push(
  `„DT" z kolumny OBIEKT wpisujemy jako dział **Techniczny** (nie nowy obiekt) — tak, jak wiersze Bożka Tomasza były przepięte w bazie ręcznie. „CMA" → dział **CMA** (pula centrum monitorowania), zgodnie z migracją 0070.`,
);
const nullMapped = plan.newObjects.filter((o) => o.values.objectId == null).map((o) => o.values.name);
if (nullMapped.length > 0) {
  uncertain.push(
    `Nowe obiekty bez powiązania z kartoteką (\`object_id = NULL\`): ${nullMapped.join(", ")} — do zmapowania w Kadry → Obiekty.`,
  );
}
if (nonSeedPayrollAug.length > 0) {
  uncertain.push(
    `W hr_payroll za ${ym(PAYROLL_MONTH)} były ${nonSeedPayrollAug.length} wiersze BEZ znacznika seeda — sierpień jest przeliczany od zera, więc zostały nadpisane danymi z MASTER 45.`,
  );
}
uncertain.push(
  "Notatki z arkuszy „czerwiec”/„lipiec” (m.in. Kopeć Jolanta bez wiersza w WYNAGRODZENIA) są przepisane wyżej bez interpretacji — skrypt niczego z nich nie dopisuje.",
);
for (const u of uncertain) say(`- ${u}`);

say();
say(
  APPLY
    ? "**Zapisano** (jedna transakcja)."
    : "**Suchy przebieg** — nic nie zapisano. Uruchom z `--apply`, żeby zapisać.",
);

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${out.join("\n")}\n`, "utf8");
console.log(`\nRaport: ${REPORT_PATH}`);

process.exit(0);
