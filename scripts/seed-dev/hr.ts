/**
 * Generator danych deweloperskich — MODUŁ KADRY.
 *
 * ⚠ TEN MODUŁ DZIAŁA NA PRAWDZIWYCH DANYCH. Kartoteka (152 pracowników),
 * 139 umów i ~1200 wierszy godzin pochodzą z importu skoroszytu MASTER —
 * są nie do odtworzenia i seed ich NIE TWORZY, NIE ZMIENIA i NIE KASUJE.
 * Jedyne, co robi, to DOMYKA ROK tam, gdzie import zostawił dziury:
 *
 *   hr_month_norms      — brakujące miesiące 2025-09…12 (import wypełnił 2026)
 *   hr_hours            — 2025-09…12 od zera + wypełnienie pustych zaczepów
 *                         importu w 2026-07 i 2026-08 (patrz niżej)
 *   hr_payroll          — miesiące z godzinami bez wypłat (import ma tylko 2026-06)
 *   hr_office_payroll   — jw. dla pracowników biura (import ma tylko 2026-06)
 *
 * JAK `--reset` ODRÓŻNIA WYGENEROWANE OD ZAIMPORTOWANEGO — dwa niezależne
 * zamki, obydwa muszą zaskoczyć, żeby wiersz zniknął:
 *
 *   ZAMEK 1 (znacznik). `hr_hours`, `hr_payroll` i `hr_office_payroll` mają
 *   pole `notes` — każdy wiersz seeda niesie w nim MARKER. Wiersze z importu
 *   mają tam albo pusty string, albo prawdziwe adnotacje kadrowej
 *   („komornik", „9xKZ", „zamk. UoP z dniem 30.03.2026") — MARKERa nie mają
 *   i mieć nie mogą.
 *
 *   ZAMEK 2 (okno miesięcy). Kasowanie jest dodatkowo zawężone do miesięcy
 *   wypisanych niżej jako stałe. Miesiące z realną treścią z importu (godziny
 *   2026-01…06 i 2026-09, wypłaty 2026-06) do tych list NIE NALEŻĄ,
 *   a `assertDisjoint()` wywala reset z błędem, gdyby ktoś kiedyś je tam
 *   wpisał. Wyjątkiem są 2026-07 i 2026-08 — leżą w oknie seeda, bo import
 *   zostawił tam wyłącznie puste zaczepy; tam pracuje sam ZAMEK 1.
 *
 *   ZAMEK 3 (rejestr). `hr_month_norms` nie ma pola `notes`, więc ZAMEK 1 tam
 *   nie działa, a samo okno miesięcy nie odróżnia normy seeda od normy wpisanej
 *   ręcznie w tym samym miesiącu — i kasowało obie. Dlatego seed zapisuje
 *   w `app_settings` (REGISTRY_KEY), które normy założył i z jakimi wartościami,
 *   a reset cofa wyłącznie te, których nikt potem nie poprawił.
 */

import { and, eq, like, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import type {
  HrContract,
  HrEmployee,
  HrHours,
  HrPayroll,
} from "../../src/db/schema.js";
import { buildHoursAggregates, computePayroll } from "../../src/utils/hr-calc.js";
import {
  MARKER,
  type Tx,
  assertNotSeeded,
  chance,
  dropRegistry,
  int,
  mark,
  num,
  pick,
  readRegistry,
  rng,
  runInTx,
  writeRegistry,
} from "./shared.js";

/**
 * Rejestr norm dopisanych przez seed — TRZECI ZAMEK dla `hr_month_norms`.
 *
 * Ta jedna tabela nie ma pola `notes`, więc do niedawna broniło jej wyłącznie
 * okno miesięcy: reset kasował WSZYSTKIE normy z 2025-09…12, także te wpisane
 * ręcznie przez kadrową. Teraz zapamiętujemy, które wiersze założyliśmy i z jakimi
 * wartościami — reset kasuje wyłącznie je i tylko wtedy, gdy nikt ich nie poprawił.
 */
const REGISTRY_KEY = "dev.seed.hr";

/** [rok, miesiąc, workNorm, contractNorm] — dokładnie to, co seed wpisał. */
interface HrRegistry {
  monthNorms: Array<[number, number, number, number]>;
}

const EMPTY_REGISTRY: HrRegistry = { monthNorms: [] };

interface YM {
  year: number;
  month: number;
}

const ym = (year: number, month: number): YM => ({ year, month });
const ymKey = (y: number, m: number) => y * 100 + m;
const hasYM = (list: readonly YM[], y: number, m: number) =>
  list.some((v) => v.year === y && v.month === m);

/* ------------------------------------------------------------------ */
/* OKNA MIESIĘCY — jedyna rzecz, którą wolno tknąć resetowi            */
/* ------------------------------------------------------------------ */

/** Normy dogenerowane przez seed. Import napisał wyłącznie rok 2026. */
const SEEDED_NORM_MONTHS: readonly YM[] = [
  ym(2025, 9),
  ym(2025, 10),
  ym(2025, 11),
  ym(2025, 12),
];

/** Miesiące godzin, których import nie miał w ogóle — seed tworzy je od zera. */
const SEEDED_HOURS_MONTHS_NEW: readonly YM[] = SEEDED_NORM_MONTHS;

/**
 * Miesiące, w których import zostawił WYŁĄCZNIE puste zaczepy: wiersze
 * przeniesione z poprzedniego miesiąca (`object_uncertain = 1`), z NULL-ami we
 * wszystkich godzinach — czekające, aż kadrowa je uzupełni. Bez godzin nie ma
 * z czego policzyć wypłat, więc lipiec i sierpień 2026 świeciłyby zerami.
 *
 * Seed NIE nadpisuje zaczepów (to wiersze importu). Dokłada OBOK nich własne,
 * oznaczone wiersze — `hr_hours` jawnie dopuszcza kilka wpisów na osobę
 * w miesiącu, a `buildHoursAggregates()` je sumuje, więc zaczep (0 h) niczego
 * nie zaburza. Reset kasuje wyłącznie te oznaczone; zaczepy zostają.
 */
const SEEDED_HOURS_MONTHS_FILL: readonly YM[] = [ym(2026, 7), ym(2026, 8)];

const SEEDED_HOURS_MONTHS: readonly YM[] = [
  ...SEEDED_HOURS_MONTHS_NEW,
  ...SEEDED_HOURS_MONTHS_FILL,
];

/**
 * Wypłaty dogenerowane przez seed: wszystkie miesiące z godzinami, w których
 * import nie zostawił wypłat. 2026-06 świadomie POMINIĘTE (prawdziwe wypłaty),
 * 2026-09 też — to miesiąc po TODAY, wypłat jeszcze nie ma.
 */
const SEEDED_PAYROLL_MONTHS: readonly YM[] = [
  ...SEEDED_HOURS_MONTHS_NEW,
  ym(2026, 1),
  ym(2026, 2),
  ym(2026, 3),
  ym(2026, 4),
  ym(2026, 5),
  ym(2026, 7),
  ym(2026, 8),
];

/* ------------------------------------------------------------------ */
/* NIETYKALNE — dane z importu                                         */
/* ------------------------------------------------------------------ */

/**
 * Miesiące z PRAWDZIWYMI godzinami z importu MASTER — okno seeda nie może ich
 * dotknąć nawet listą miesięcy, nie mówiąc o DELETE. 2026-09 jest tu, bo leży
 * po TODAY: seed go nie uzupełnia, więc reset też nie ma tam czego szukać.
 *
 * 2026-07 i 2026-08 świadomie NIE są na tej liście — import zostawił tam same
 * puste zaczepy (patrz SEEDED_HOURS_MONTHS_FILL), a seed dokłada obok nich
 * własne wiersze. Zaczepy chroni w tych dwóch miesiącach ZAMEK 1: mają pustą
 * notatkę, więc `LIKE '%MARKER%'` nigdy ich nie złapie.
 */
const IMPORTED_HOURS_MONTHS: readonly YM[] = [
  ym(2026, 1), ym(2026, 2), ym(2026, 3), ym(2026, 4), ym(2026, 5),
  ym(2026, 6), ym(2026, 9),
];

/** Miesiąc prawdziwych wypłat (hr_payroll + hr_office_payroll). */
const IMPORTED_PAYROLL_MONTHS: readonly YM[] = [ym(2026, 6)];

/** Normy z importu — cały 2026. */
const IMPORTED_NORM_MONTHS: readonly YM[] = Array.from({ length: 12 }, (_, i) =>
  ym(2026, i + 1),
);

/**
 * Bezpiecznik: żadne okno seeda nie może zahaczyć o miesiąc importu. Wołane
 * na wejściu resetu — lepiej wywalić skrypt, niż skasować kadry.
 */
function assertDisjoint(label: string, seeded: readonly YM[], imported: readonly YM[]) {
  const clash = seeded.filter((s) => hasYM(imported, s.year, s.month));
  if (clash.length > 0) {
    throw new Error(
      `[seed-dev/hr] STOP: okno „${label}" zachodzi na dane z importu (` +
        clash.map((c) => `${c.year}-${String(c.month).padStart(2, "0")}`).join(", ") +
        "). Reset przerwany — dane kadrowe nietknięte.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Kalendarz — normy godzin                                            */
/* ------------------------------------------------------------------ */

/**
 * Święta ustawowo wolne w oknie 2025-09…12. Wigilia jest tu celowo: od 2025
 * 24 grudnia jest dniem wolnym od pracy, a normy z importu (2026-12 = 160 h)
 * już to uwzględniają — bez niej seed rozjechałby się z resztą tabeli.
 */
const HOLIDAYS_Q4_2025 = [
  "2025-11-01", // Wszystkich Świętych (sobota)
  "2025-11-11", // Święto Niepodległości (wtorek)
  "2025-12-24", // Wigilia
  "2025-12-25", // Boże Narodzenie
  "2025-12-26", // drugi dzień świąt
] as const;

/** Norma zlecenia jest w arkuszu stała — wszystkie wiersze importu mają 158. */
const CONTRACT_NORM = 158;

/**
 * Norma godzin umowy o pracę: (dni robocze − święta w dni robocze − święta
 * w soboty) × 8. Odjęcie świąt sobotnich to nie ozdobnik, tylko wymóg Kodeksu
 * pracy; sprawdzone na normach z importu (2026-08 = 160 h przy święcie
 * 15 sierpnia w sobotę, 2026-12 = 160 h przy 26 grudnia w sobotę).
 */
function workNormFor(year: number, month: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let workdays = 0;
  let holidayOffset = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(Date.UTC(year, month - 1, d));
    const wd = date.getUTCDay();
    const iso = date.toISOString().slice(0, 10);
    const isHoliday = (HOLIDAYS_Q4_2025 as readonly string[]).includes(iso);
    if (wd >= 1 && wd <= 5) {
      workdays++;
      if (isHoliday) holidayOffset++;
    } else if (wd === 6 && isHoliday) {
      // Święto w sobotę obniża wymiar czasu pracy o 8 h.
      holidayOffset++;
    }
  }
  return (workdays - holidayOffset) * 8;
}

/* ------------------------------------------------------------------ */
/* Umowy — od kiedy pracownik w ogóle jest na stanie                   */
/* ------------------------------------------------------------------ */

/**
 * Data zgłoszenia z pola ZUA/ZZA. W arkuszu bywa datą („01.12.2025") albo
 * słowem „tak" (zgłoszenie sprzed czasów arkusza). Słowo traktujemy jako
 * „od zawsze" — inaczej połowa kadry wypadłaby z IV kwartału 2025.
 */
function registrationMonth(value: string): number | null {
  const m = value.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null; // "tak"/"TAK"/"" → brak ograniczenia
  return ymKey(Number(m[3]), Number(m[2]));
}

/** Najwcześniejszy miesiąc, od którego pracownik ma jakąkolwiek umowę. */
function employedFrom(contracts: HrContract[]): number | null {
  let best: number | null = null;
  for (const c of contracts) {
    const reg = registrationMonth(c.zua) ?? registrationMonth(c.zza);
    if (reg === null) return null; // "tak" → od zawsze
    best = best === null ? reg : Math.min(best, reg);
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* SEED                                                                */
/* ------------------------------------------------------------------ */

export interface HrSeedCounts {
  monthNorms: number;
  hours: number;
  payroll: number;
  officePayroll: number;
  monthsCovered: number;
}

/** Skrót: pełny wiersz hr_payroll dla computePayroll (kolumny techniczne są bez znaczenia). */
function asPayrollRow(
  contractId: number,
  year: number,
  month: number,
  input: Partial<HrPayroll>,
): HrPayroll {
  return {
    id: 0,
    contractId,
    year,
    month,
    mainAmount: null,
    bonusRate: null,
    bonusRatePending: false,
    rateAdjustment: null,
    maxHoursOverride: null,
    actualHoursOverride: null,
    bonusAmountOverride: null,
    notes: "",
    createdAt: "",
    updatedAt: "",
    ...input,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function seedHr(outerTx?: Tx): HrSeedCounts {
  const counts: HrSeedCounts = {
    monthNorms: 0,
    hours: 0,
    payroll: 0,
    officePayroll: 0,
    monthsCovered: SEEDED_PAYROLL_MONTHS.length,
  };

  // Drugi przebieg bez resetu dołożyłby drugi komplet godzin i wypłat obok
  // pierwszego — `hr_hours` z założenia dopuszcza kilka wpisów na osobę
  // w miesiącu, więc nic by nie pisnęło, a godziny urosłyby dwukrotnie.
  assertNotSeeded(
    "hr",
    db
      .select({ id: schema.hrHours.id })
      .from(schema.hrHours)
      .where(like(schema.hrHours.notes, `%${MARKER}%`))
      .limit(1)
      .get() !== undefined,
  );

  /* --- Odczyt stanu (same SELECT-y) --------------------------------- */
  // Bez `await`: cały moduł musi być SYNCHRONICZNY, bo orkiestrator uruchamia go
  // w transakcji better-sqlite3, a ta jest synchroniczna. Jedno `await` oddałoby
  // sterowanie do pętli zdarzeń i reszta seeda wykonałaby się PO commicie.
  const employees: HrEmployee[] = db.select().from(schema.hrEmployees).all();
  const contracts: HrContract[] = db.select().from(schema.hrContracts).all();
  const existingHours: HrHours[] = db.select().from(schema.hrHours).all();
  const existingNorms = db.select().from(schema.hrMonthNorms).all();
  const officeTemplate = db
    .select()
    .from(schema.hrOfficePayroll)
    .where(
      and(
        eq(schema.hrOfficePayroll.year, IMPORTED_PAYROLL_MONTHS[0].year),
        eq(schema.hrOfficePayroll.month, IMPORTED_PAYROLL_MONTHS[0].month),
      ),
    )
    .all();

  const normByKey = new Map<number, { workNorm: number; contractNorm: number }>();
  for (const n of existingNorms) {
    normByKey.set(ymKey(n.year, n.month), {
      workNorm: n.workNorm,
      contractNorm: n.contractNorm,
    });
  }

  /* --- 1. Normy godzin dla brakujących miesięcy 2025 ----------------- */
  const newNorms: Array<{ year: number; month: number; workNorm: number; contractNorm: number }> =
    [];
  for (const { year, month } of SEEDED_NORM_MONTHS) {
    if (normByKey.has(ymKey(year, month))) continue; // norma z importu — nie ruszamy
    const workNorm = workNormFor(year, month);
    newNorms.push({ year, month, workNorm, contractNorm: CONTRACT_NORM });
    normByKey.set(ymKey(year, month), { workNorm, contractNorm: CONTRACT_NORM });
  }

  /* --- 2. Godziny: 2025-09…12 od zera + wypełnienie 2026-07/08 ------- */

  // Wzorzec wpisów bierzemy z NAJWCZEŚNIEJSZEGO miesiąca importu, w którym
  // pracownik się pojawia: ile wierszy, na jakich obiektach, czy chodzi nocki.
  // Dzięki temu dogenerowany kwartał wygląda jak przedłużenie prawdziwych
  // danych, a nie jak losowy szum na losowych posterunkach.
  const byEmployee = new Map<number, HrHours[]>();
  for (const h of existingHours) {
    const list = byEmployee.get(h.employeeId) ?? [];
    list.push(h);
    byEmployee.set(h.employeeId, list);
  }

  interface HoursTemplate {
    employeeId: number;
    rows: Array<{ objectId: number | null; night: boolean; worked: number }>;
  }
  const templates: HoursTemplate[] = [];
  for (const emp of [...employees].sort((a, b) => a.id - b.id)) {
    const rows = byEmployee.get(emp.id);
    if (!rows || rows.length === 0) continue; // nigdy nie miał godzin — nie wymyślamy mu ich
    const firstKey = Math.min(...rows.map((r) => ymKey(r.year, r.month)));
    const first = rows.filter((r) => ymKey(r.year, r.month) === firstKey);
    // Skala godzin z całego roku pracownika, nie z jednego miesiąca — jeden
    // chory miesiąc nie może wykrzywić czterech dogenerowanych. Wiersze
    // z NULL-em (puste zaczepy 2026-07…09) są WYŁĄCZONE ze średniej: liczone
    // jako zero zaniżałyby skalę o jedną trzecią.
    const filled = rows.filter((r) => r.workedHours != null);
    const avgWorked = filled.length
      ? filled.reduce((s, r) => s + (r.workedHours ?? 0), 0) / filled.length
      : 0;
    templates.push({
      employeeId: emp.id,
      rows: first.map((r) => ({
        objectId: r.objectId,
        night: (r.nightHours ?? 0) > 0,
        worked: avgWorked > 0 ? avgWorked : 160,
      })),
    });
  }

  const contractsByEmployee = new Map<number, HrContract[]>();
  for (const c of contracts) {
    const list = contractsByEmployee.get(c.employeeId) ?? [];
    list.push(c);
    contractsByEmployee.set(c.employeeId, list);
  }

  const newHours: Array<typeof schema.hrHours.$inferInsert> = [];
  /** Godziny wygenerowane, trzymane też w pamięci — płace liczą się z nich. */
  const seededHoursByMonth = new Map<number, HrHours[]>();

  /** Skala godzin pracownika (średnia z realnych miesięcy) — do wypełniania zaczepów. */
  const scaleByEmployee = new Map<number, number>();
  for (const t of templates) {
    scaleByEmployee.set(t.employeeId, t.rows[0]?.worked ?? 160);
  }

  for (const { year, month } of SEEDED_HOURS_MONTHS) {
    const key = ymKey(year, month);
    const isFill = hasYM(SEEDED_HOURS_MONTHS_FILL, year, month);

    // W miesiącach „NEW" układ wierszy bierzemy z wzorca pracownika;
    // w miesiącach „FILL" — z pustych zaczepów, które import już tam położył.
    // Dzięki temu wypełnienie ląduje na tych samych obiektach, które aplikacja
    // przeniosła z poprzedniego miesiąca, a nie na wymyślonych posterunkach.
    const protos: Array<{ employeeId: number; objectId: number | null; night: boolean; worked: number }> =
      [];
    if (isFill) {
      const stubs = existingHours
        .filter(
          (h) =>
            h.year === year &&
            h.month === month &&
            h.workedHours == null &&
            h.uwHours == null &&
            h.l4Hours == null,
        )
        .sort((a, b) => a.id - b.id);
      for (const s of stubs) {
        if (!scaleByEmployee.has(s.employeeId)) continue; // nie znamy skali — pomijamy
        protos.push({
          employeeId: s.employeeId,
          objectId: s.objectId,
          night: false,
          worked: scaleByEmployee.get(s.employeeId)!,
        });
      }
    } else {
      for (const t of templates) {
        const from = employedFrom(contractsByEmployee.get(t.employeeId) ?? []);
        // Zatrudniony dopiero w 2026 → w IV kwartale 2025 godzin mieć nie może.
        if (from !== null && from > key) continue;
        for (const proto of t.rows) {
          protos.push({ employeeId: t.employeeId, ...proto });
        }
      }
    }

    const bucket: HrHours[] = [];
    {
      for (const proto of protos) {
        const worked = Math.round(proto.worked * num(0.85, 1.15, 3));
        // Rozkłady odtworzone z importu (2026-01, n=143): ~15% urlopów,
        // ~6% L4, ~25% nocek, ~7% potrąceń, ~8% premii, ~4% limitów maks.
        const uw = chance(0.15) ? int(1, 10) * 8 : null;
        const l4 = chance(0.06) ? int(1, 12) * 8 : null;
        const night = proto.night
          ? int(1, 10) * 4
          : chance(0.05)
            ? int(1, 6) * 4
            : null;
        bucket.push({
          id: 0,
          employeeId: proto.employeeId,
          objectId: proto.objectId,
          objectUncertain: false,
          year,
          month,
          nightHours: night,
          workedHours: worked,
          uwHours: uw,
          l4Hours: l4,
          maxHours: chance(0.04)
            ? pick([50, 60, 72, 80, 140, 147, 148, 154, 158, 160, 168, 176])
            : null,
          deductions: chance(0.07) ? round2(num(50, 1000, 2)) : null,
          bonuses: chance(0.08) ? round2(num(100, 1000, 2)) : null,
          notes: mark(),
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    seededHoursByMonth.set(key, bucket);
    for (const h of bucket) {
      newHours.push({
        employeeId: h.employeeId,
        objectId: h.objectId,
        objectUncertain: false,
        year: h.year,
        month: h.month,
        nightHours: h.nightHours,
        workedHours: h.workedHours,
        uwHours: h.uwHours,
        l4Hours: h.l4Hours,
        maxHours: h.maxHours,
        deductions: h.deductions,
        bonuses: h.bonuses,
        // ZAMEK 1: MARKER w notatce — po nim reset pozna swój wiersz.
        notes: h.notes,
      });
    }
  }

  /* --- 3. Wypłaty (hr_payroll) -------------------------------------- */

  // Stawka netto jest cechą pracownika, nie miesiąca — inaczej stawka
  // skakałaby z miesiąca na miesiąc i wykres wynagrodzeń byłby piłą.
  const rateByEmployee = new Map<number, number>();
  for (const emp of [...employees].sort((a, b) => a.id - b.id)) {
    rateByEmployee.set(emp.id, round2(21 + rng() * 8));
  }

  const activeContracts = contracts.filter((c) => c.active);
  const hoursByMonth = new Map<number, HrHours[]>();
  for (const h of existingHours) {
    const key = ymKey(h.year, h.month);
    const list = hoursByMonth.get(key) ?? [];
    list.push(h);
    hoursByMonth.set(key, list);
  }
  // Doklejamy (a nie podmieniamy) — w miesiącach „FILL" obok wierszy seeda
  // leżą puste zaczepy importu i agregat musi widzieć jedno i drugie.
  for (const [key, rows] of seededHoursByMonth) {
    hoursByMonth.set(key, [...(hoursByMonth.get(key) ?? []), ...rows]);
  }

  const newPayroll: Array<typeof schema.hrPayroll.$inferInsert> = [];

  for (const { year, month } of SEEDED_PAYROLL_MONTHS) {
    const key = ymKey(year, month);
    const norms = normByKey.get(key);
    if (!norms) continue; // brak normy → nie ma z czego liczyć
    const monthHours = hoursByMonth.get(key) ?? [];
    if (monthHours.length === 0) continue;

    const hoursByEmployee = buildHoursAggregates(monthHours);
    const employeesWithHours = new Set(monthHours.map((h) => h.employeeId));
    const relevant = activeContracts.filter((c) => {
      if (!employeesWithHours.has(c.employeeId)) return false;
      // Umowa zgłoszona później niż rozliczany miesiąc jeszcze nie istnieje.
      const reg = registrationMonth(c.zua) ?? registrationMonth(c.zza);
      return reg === null || reg <= key;
    });
    if (relevant.length === 0) continue;

    // PRZEBIEG 1 — bez żadnych wejść ręcznych. Interesuje nas tylko, ile
    // godzin aplikacja policzy sama (cap do maks przy ZUA, nadwyżka przy ZZA).
    const base = computePayroll({
      contracts: relevant,
      payrollByContract: new Map(),
      hoursByEmployee,
      workNorm: norms.workNorm,
      contractNorm: norms.contractNorm,
    });
    const faktBase = new Map(base.map((r) => [r.contractId, r.faktGodziny ?? 0]));
    const dodatekBase = new Map(base.map((r) => [r.contractId, r.godzinyDodatek]));

    // Wejścia ręczne dobierane DO wyliczonych godzin — nadpisanie „maks"
    // ustawione poniżej faktycznych godzin realnie generuje nadwyżkę
    // i uruchamia ścieżkę dodatku, zamiast być martwą liczbą w bazie.
    const inputs = new Map<number, HrPayroll>();
    for (const c of relevant) {
      const fakt = faktBase.get(c.id) ?? 0;
      const godzinyDodatku = dodatekBase.get(c.id) ?? 0;
      if (fakt <= 0 && godzinyDodatku <= 0) continue; // nie ma czego rozliczać

      if (fakt <= 0) {
        // Umowa bez godzin do wypłaty głównej, ale z nadwyżką na dodatek —
        // typowa druga umowa (ZZA) osoby pracującej ponad normę. Bez stawki
        // dodatku computePayroll rzuciłby „Dodatek do przeliczenia — brak
        // stawki", bo nie ma z czego wziąć stawki zastępczej (kwoty głównej
        // tu nie ma). Sam bonusRate, kwota główna pusta — dokładnie tak
        // wyglądają prawdziwe wiersze z czerwca 2026.
        inputs.set(
          c.id,
          asPayrollRow(c.id, year, month, { bonusRate: 21 + int(0, 9) * 0.5 }),
        );
        continue;
      }

      const hasBonus = c.bonusType !== "brak";
      inputs.set(
        c.id,
        asPayrollRow(c.id, year, month, {
          // Stawka dodatku podawana tylko tam, gdzie umowa ma kanał dodatku;
          // `bonusRatePending` zostaje na false — flaga „do przeliczenia"
          // wyprodukowałaby ostrzeżenie w computePayroll, a seed ma dawać
          // miesiące policzone do końca, nie listę zadań dla kadrowej.
          bonusRate: hasBonus && chance(0.72) ? 21 + int(0, 9) * 0.5 : null,
          rateAdjustment: chance(0.18) ? round2(num(0.5, 3, 2)) : null,
          maxHoursOverride: chance(0.08) ? Math.round((fakt * num(0.7, 0.95)) / 2) * 2 : null,
          actualHoursOverride: chance(0.1) ? Math.round(fakt * num(0.9, 1.05)) : null,
        }),
      );
    }

    // PRZEBIEG 2 — z wejściami ręcznymi. Dopiero teraz znamy ostateczne
    // „fakt godziny", a więc i kwotę główną, która da sensowną stawkę netto.
    const withInputs = computePayroll({
      contracts: relevant,
      payrollByContract: inputs,
      hoursByEmployee,
      workNorm: norms.workNorm,
      contractNorm: norms.contractNorm,
    });

    for (const computed of withInputs) {
      const input = inputs.get(computed.contractId);
      if (!input) continue;
      const fakt = computed.faktGodziny ?? 0;
      const rate = rateByEmployee.get(computed.employeeId) ?? 24;
      newPayroll.push({
        contractId: computed.contractId,
        year,
        month,
        // Kwota główna = fakt godziny × stawka pracownika. Liczona z wyniku
        // PRZEBIEGU 2, więc stawka netto na ekranie wychodzi dokładnie taka,
        // jaką tu założyliśmy — a licznik „brak kwoty od księgowości"
        // w podsumowaniu miesiąca zostaje pusty. Wiersz bez godzin (sam
        // dodatek) świadomie zostaje bez kwoty — tak jak w danych z importu.
        mainAmount: fakt > 0 ? round2(fakt * rate) : null,
        bonusRate: input.bonusRate,
        bonusRatePending: false,
        rateAdjustment: input.rateAdjustment,
        maxHoursOverride: input.maxHoursOverride,
        actualHoursOverride: input.actualHoursOverride,
        bonusAmountOverride: null,
        // ZAMEK 1
        notes: mark(),
      });
    }
  }

  /* --- 4. Wynagrodzenia biura --------------------------------------- */

  // Kształt wiersza (spółka, które pola są wypełnione) kopiujemy z prawdziwego
  // czerwca — biuro rozlicza się ręcznie i każdy z 13 etatów ma swój wzorzec
  // (etat vs UZ, kwota vs podstawa ROR). Zmieniamy tylko wartości.
  const newOffice: Array<typeof schema.hrOfficePayroll.$inferInsert> = [];
  for (const { year, month } of SEEDED_PAYROLL_MONTHS) {
    const norms = normByKey.get(ymKey(year, month));
    for (const t of [...officeTemplate].sort((a, b) => a.id - b.id)) {
      newOffice.push({
        employeeId: t.employeeId,
        year,
        month,
        company: t.company,
        // Etat chodzi wg normy miesiąca — to jedyna wartość, która ma tu
        // twarde źródło, więc nie zgadujemy jej losowo.
        etatHours: t.etatHours == null ? null : (norms?.workNorm ?? t.etatHours),
        uwL4: chance(0.12) ? int(1, 10) * 8 : null,
        deductions: chance(0.1) ? round2(num(50, 600, 2)) : null,
        bonuses: chance(0.12) ? round2(num(100, 1000, 2)) : null,
        hoursForAccounting:
          t.hoursForAccounting == null ? null : Math.round(num(0, 60)),
        rate: t.rate,
        amount: t.amount == null ? null : round2(t.amount * num(0.97, 1.05, 4)),
        rorBase: t.rorBase == null ? null : round2(t.rorBase * num(0.97, 1.05, 4)),
        cashOverride: t.cashOverride,
        // ZAMEK 1
        notes: mark(),
      });
    }
  }

  /* --- 5. Zapis (jedna transakcja, partiami) ------------------------ */
  runInTx(outerTx, (tx) => {
    if (newNorms.length > 0) {
      tx.insert(schema.hrMonthNorms).values(newNorms).run();
      counts.monthNorms += newNorms.length;
      // Rejestr norm — zapisujemy DOKŁADNIE to, co wstawiliśmy. Tylko po tym
      // reset odróżni normę seeda od normy wpisanej ręcznie przez kadrową.
      writeRegistry(REGISTRY_KEY, {
        monthNorms: [
          ...readRegistry(REGISTRY_KEY, EMPTY_REGISTRY).monthNorms,
          ...newNorms.map(
            (n) => [n.year, n.month, n.workNorm, n.contractNorm] as [number, number, number, number],
          ),
        ],
      } satisfies HrRegistry);
    }
    for (let i = 0; i < newHours.length; i += 200) {
      const chunk = newHours.slice(i, i + 200);
      tx.insert(schema.hrHours).values(chunk).run();
      counts.hours += chunk.length;
    }
    for (let i = 0; i < newPayroll.length; i += 200) {
      const chunk = newPayroll.slice(i, i + 200);
      tx.insert(schema.hrPayroll).values(chunk).run();
      counts.payroll += chunk.length;
    }
    for (let i = 0; i < newOffice.length; i += 200) {
      const chunk = newOffice.slice(i, i + 200);
      tx.insert(schema.hrOfficePayroll).values(chunk).run();
      counts.officePayroll += chunk.length;
    }
  });

  return counts;
}

/* ------------------------------------------------------------------ */
/* RESET                                                               */
/* ------------------------------------------------------------------ */

export interface HrResetCounts {
  monthNorms: number;
  hours: number;
  payroll: number;
  officePayroll: number;
}

/**
 * Warunek „rok-miesiąc należy do listy" jako jedno OR po parach. Świadomie
 * NIE jest to `inArray(year, …) AND inArray(month, …)` — taki zapis złapałby
 * iloczyn kartezjański (np. 2026-11, którego na liście nie ma) i mógłby
 * zahaczyć o miesiąc importu.
 */
function monthsFilter(
  yearCol: SQLWrapper,
  monthCol: SQLWrapper,
  months: readonly YM[],
): SQL | undefined {
  return or(...months.map((m) => and(eq(yearCol, m.year), eq(monthCol, m.month))));
}

/**
 * Kasuje WYŁĄCZNIE wiersze dołożone przez `seedHr()`.
 *
 * Każdy DELETE ma dwa warunki połączone AND-em: MARKER w `notes` (ZAMEK 1)
 * oraz przynależność do okna miesięcy seeda (ZAMEK 2). Prawdziwe wiersze
 * z importu nie spełniają ŻADNEGO z nich — brak MARKERa wyklucza je nawet
 * wtedy, gdyby ktoś rozszerzył okno, a okno wyklucza je nawet wtedy, gdyby
 * kadrowa wkleiła MARKER w notatkę.
 *
 * Wyjątek: `hr_month_norms` nie ma pola `notes`. Tam pracuje ZAMEK 3 — rejestr
 * w `app_settings` z listą norm, które seed sam założył, i z wartościami, jakie
 * im nadał. Kasujemy wyłącznie wiersze z tej listy, nadal mieszczące się w oknie
 * miesięcy i nadal mające te wartości. Norma wpisana ręcznie przez kadrową dla
 * 2025-09…12 (albo poprawiona po seedzie) zostaje w bazie.
 *
 * Reset nie dotyka `hr_employees`, `hr_contracts` ani `hr_objects` — seed ich
 * nie tworzy, więc nie ma tam czego cofać.
 */
export function resetHr(outerTx?: Tx): HrResetCounts {
  assertDisjoint("hr_hours", SEEDED_HOURS_MONTHS, IMPORTED_HOURS_MONTHS);
  assertDisjoint("hr_payroll", SEEDED_PAYROLL_MONTHS, IMPORTED_PAYROLL_MONTHS);
  assertDisjoint("hr_month_norms", SEEDED_NORM_MONTHS, IMPORTED_NORM_MONTHS);

  const counts: HrResetCounts = {
    monthNorms: 0,
    hours: 0,
    payroll: 0,
    officePayroll: 0,
  };

  runInTx(outerTx, (tx) => {
    counts.hours = tx
      .delete(schema.hrHours)
      .where(
        and(
          like(schema.hrHours.notes, `%${MARKER}%`),
          monthsFilter(schema.hrHours.year, schema.hrHours.month, SEEDED_HOURS_MONTHS),
        ),
      )
      .run().changes;

    counts.payroll = tx
      .delete(schema.hrPayroll)
      .where(
        and(
          like(schema.hrPayroll.notes, `%${MARKER}%`),
          monthsFilter(schema.hrPayroll.year, schema.hrPayroll.month, SEEDED_PAYROLL_MONTHS),
        ),
      )
      .run().changes;

    counts.officePayroll = tx
      .delete(schema.hrOfficePayroll)
      .where(
        and(
          like(schema.hrOfficePayroll.notes, `%${MARKER}%`),
          monthsFilter(schema.hrOfficePayroll.year, schema.hrOfficePayroll.month, SEEDED_PAYROLL_MONTHS),
        ),
      )
      .run().changes;

    // Normy — jedyna tabela bez znacznika, więc idziemy po REJESTRZE, a nie po
    // oknie miesięcy. Wcześniej jedno DELETE zabierało wszystkie normy
    // z 2025-09…12: także tę, którą kadrowa wpisała ręcznie, zanim seed
    // w ogóle ruszył (seed omija istniejące normy, więc jej nie zakładał —
    // ale reset i tak ją kasował).
    //
    // Trzy warunki naraz: wiersz jest w rejestrze (ZAMEK 3), leży w oknie
    // miesięcy seeda (ZAMEK 2 — na wypadek rejestru z innej epoki bazy)
    // i ma nadal wartości, które seed wpisał (gdy ktoś je poprawił, zostaje
    // jego wersja).
    const registry = readRegistry(REGISTRY_KEY, EMPTY_REGISTRY);
    for (const [year, month, workNorm, contractNorm] of registry.monthNorms) {
      if (!hasYM(SEEDED_NORM_MONTHS, year, month)) continue;
      counts.monthNorms += tx
        .delete(schema.hrMonthNorms)
        .where(
          and(
            eq(schema.hrMonthNorms.year, year),
            eq(schema.hrMonthNorms.month, month),
            eq(schema.hrMonthNorms.workNorm, workNorm),
            eq(schema.hrMonthNorms.contractNorm, contractNorm),
          ),
        )
        .run().changes;
    }
    dropRegistry(REGISTRY_KEY);
  });

  return counts;
}
