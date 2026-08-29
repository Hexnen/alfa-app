/**
 * Koszt OSOBOWY obiektu — ile wynagrodzeń miesięcznie „siedzi" na danym obiekcie
 * z kartoteki, policzone z modułu Kadry (godziny + wypłaty), a nie wpisane ręcznie.
 *
 * ┌── DLACZEGO TO ISTNIEJE ────────────────────────────────────────────────────┐
 * │ `objects.monthly_cost` to od teraz koszt POZOSTAŁY (monitoring, sprzęt,     │
 * │ abonamenty) — wszystko POZA wynagrodzeniami. Koszt całkowity obiektu to     │
 * │ suma: koszt osobowy stąd + `monthly_cost`. Nigdy jedno ZAMIAST drugiego;    │
 * │ podmiana zaniżyłaby koszt obiektów fizycznej ochrony o całą pensję załogi.  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * KWOTY SĄ NETTO — „na rękę". `wyplata` z `computePayroll()` to przelew + gotówka,
 * czyli to, co pracownik dostaje do ręki. Aplikacja NIE ZNA kosztu pracodawcy
 * (brutto + składki ZUS po stronie firmy), bo nigdzie go nie przechowuje: księgowość
 * podaje wyłącznie kwoty netto. Realny koszt zatrudnienia jest o kilkadziesiąt
 * procent WYŻSZY niż liczby z tego modułu. API wystawia to jako `net: true`
 * w bloku informacyjnym — nikt nie może wziąć tego za pełny koszt zatrudnienia.
 *
 * REGUŁY PŁACOWE NIE SĄ TU POWTARZANE. Miesiąc liczy `computePayroll()`
 * z src/utils/hr-calc.ts — dokładnie ta sama funkcja, którą wywołuje
 * `computeMonth()` w src/routes/hr.ts. Gdyby reguła się zmieniła, zmieni się
 * w jednym miejscu, a nie w dwóch rozjeżdżających się kopiach.
 *
 * ALGORYTM (miesiąc po miesiącu, potem średnia):
 *  1. koszt pracownika w miesiącu = suma `wyplata` po jego umowach
 *     (+ rozliczenie biura z `hr_office_payroll` dla `kind='biuro'`),
 *  2. rozbicie na obiekty proporcjonalnie do `worked_hours` z `hr_hours`,
 *  3. godziny na pozycjach NIEZMAPOWANYCH (`hr_objects.object_id IS NULL`)
 *     nie trafiają nigdzie — to koszt ogólny firmy (CMA, #BIURO, #zlecenie),
 *     a nie koszt konkretnego obiektu. Pracownik z połową godzin na CMA oddaje
 *     obiektowi połowę swojego kosztu i TAK MA BYĆ,
 *  4. suma po `hr_objects.object_id` (kilka pozycji kadrowych może wskazywać
 *     ten sam obiekt kartoteki — sumujemy),
 *  5. średnia po liczbie miesięcy, które FAKTYCZNIE miały dane płacowe.
 */
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { HrContract, HrHours, HrPayroll } from "../db/schema.js";
import { buildHoursAggregates, computePayroll } from "../utils/hr-calc.js";

/** Okno uśredniania w miesiącach: ostatni pełny / średnia z 3 / średnia z 12. */
export type CostWindow = 1 | 3 | 12;

export interface MonthKey {
  year: number;
  month: number; // 1-12
}

export interface PersonnelCostResult {
  /** objects.id → uśredniony koszt osobowy w zł/mies. (netto). Brak klucza = 0. */
  byObjectId: Map<number, number>;
  /** Ile miesięcy faktycznie weszło do średniej — UI pokazuje „średnia z 3, dane za 2". */
  monthsUsed: number;
  /** Które to miesiące, od najstarszego. */
  months: MonthKey[];
  /** Ile pozycji słownika kadrowego ma mapowanie na kartotekę. */
  mappedObjects: number;
  /** Ile pozycji słownika kadrowego jest w ogóle — do przypisu „12 z 44". */
  hrObjectsTotal: number;
  /** 0..1 — jaka część godzin z okna poszła w koszt ogólny zamiast na obiekt. */
  unmappedHoursShare: number;
  /** Zawsze true; kwoty są NETTO, bez kosztu pracodawcy. Pole istnieje, żeby API mogło to powiedzieć wprost. */
  net: true;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Dodaje do akumulatora w mapie (brak klucza = 0). */
const add = (map: Map<number, number>, id: number, value: number) =>
  map.set(id, (map.get(id) ?? 0) + value);

/** Domyślne okno — jeden miesiąc bywa wystrzałowy (premie, wyrównania), 12 rozmywa sezon. */
export const DEFAULT_COST_WINDOW: CostWindow = 3;

/** Parsuje `costWindow` z query stringa; cokolwiek innego → wartość domyślna. */
export function parseCostWindow(raw: string | undefined): CostWindow {
  return raw === "1" ? 1 : raw === "12" ? 12 : DEFAULT_COST_WINDOW;
}

/**
 * Lista pełnych miesięcy okna, od najstarszego. „Pełny" = już się skończył:
 * 29 sierpnia ostatnim pełnym miesiącem jest lipiec, bo sierpień wciąż trwa
 * i jego wypłaty jeszcze nie istnieją — wliczony zaniżałby każdą średnią.
 */
export function fullMonths(window: CostWindow, now = new Date()): MonthKey[] {
  // Indeks miesiąca ciągłego (rok*12 + miesiąc) — arytmetyka bez pułapek przełomu roku.
  const lastFull = now.getFullYear() * 12 + now.getMonth() - 1;
  const out: MonthKey[] = [];
  for (let i = window - 1; i >= 0; i--) {
    const idx = lastFull - i;
    out.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 });
  }
  return out;
}

const ymKey = (year: number, month: number) => year * 100 + month;

/** Wynik pojedynczego przeliczenia okna — obie publiczne funkcje czytają z niego. */
interface WindowComputation {
  byObjectId: Map<number, number>;
  byEmployeeId: Map<number, number>;
  months: MonthKey[];
  mappedObjects: number;
  hrObjectsTotal: number;
  unmappedHoursShare: number;
}

/** Grupowanie tablicy w mapę list — jedno przejście zamiast filter() w pętli po miesiącach. */
function groupBy<T>(rows: T[], keyOf: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/**
 * Rozliczenie biura — ta sama formuła, co `withOfficeComputed()` w src/routes/hr.ts
 * (kwota = godziny × stawka, gotówka = kwota − podstawa ROR, razem = ROR + gotówka).
 * Powtórzona tutaj świadomie: tamta funkcja jest prywatna dla routera kadr, a ten
 * moduł nie ma prawa importować routera (cykl: routes/analytics → lib → routes/hr).
 * Jeśli formuła się zmieni, trzeba ruszyć oba miejsca — dlatego jest tak krótka.
 *
 * W praktyce biuro i tak prawie nigdy nie wpływa na koszt OBIEKTU: osoby
 * `kind='biuro'` nie mają wierszy w `hr_hours` (albo mają je na #BIURO), więc
 * wypadają z alokacji. Liczymy je dla `computeEmployeeMonthlyCost()`, gdzie
 * chodzi o koszt konkretnej osoby (handlowiec bywa właśnie z biura).
 */
function officeTotal(row: typeof schema.hrOfficePayroll.$inferSelect): number {
  const amount =
    row.amount ??
    (row.hoursForAccounting != null && row.rate != null
      ? row.hoursForAccounting * row.rate
      : null);
  const cash =
    row.cashOverride ??
    (amount != null && row.rorBase != null && amount > row.rorBase
      ? amount - row.rorBase
      : null);
  return (row.rorBase ?? 0) + (cash ?? 0);
}

/**
 * Jedno przeliczenie okna. Wszystkie dane wczytujemy HURTEM (sześć zapytań na
 * całe okno, nie sześć na miesiąc) — przy 12 miesiącach × ~140 umów N+1 byłby
 * widoczny w czasie odpowiedzi analityki, która wywołuje to przy każdym żądaniu.
 */
function computeWindow(window: CostWindow, now = new Date()): WindowComputation {
  const wanted = fullMonths(window, now);
  const lo = ymKey(wanted[0].year, wanted[0].month);
  const hi = ymKey(wanted[wanted.length - 1].year, wanted[wanted.length - 1].month);
  // Miesiące okna są ciągłe, więc `rok*100 + miesiąc` jest w tym zakresie
  // monotoniczny i BETWEEN wystarczy zamiast listy par (rok, miesiąc).
  const contracts = db.select().from(schema.hrContracts).all();
  const payrollRows = db
    .select()
    .from(schema.hrPayroll)
    .where(sql`(hr_payroll.year * 100 + hr_payroll.month) between ${lo} and ${hi}`)
    .all();
  const hoursRows = db
    .select()
    .from(schema.hrHours)
    .where(sql`(hr_hours.year * 100 + hr_hours.month) between ${lo} and ${hi}`)
    .all();
  const officeRows = db
    .select()
    .from(schema.hrOfficePayroll)
    .where(
      sql`(hr_office_payroll.year * 100 + hr_office_payroll.month) between ${lo} and ${hi}`,
    )
    .all();
  const normRows = db
    .select()
    .from(schema.hrMonthNorms)
    .where(sql`(hr_month_norms.year * 100 + hr_month_norms.month) between ${lo} and ${hi}`)
    .all();
  const hrObjectRows = db
    .select({ id: schema.hrObjects.id, objectId: schema.hrObjects.objectId })
    .from(schema.hrObjects)
    .all();

  // hr_objects.id → objects.id; brak wpisu = pozycja niezmapowana (koszt ogólny).
  const objectOf = new Map<number, number>();
  for (const r of hrObjectRows) {
    if (r.objectId != null) objectOf.set(r.id, r.objectId);
  }

  const payrollByMonth = groupBy(payrollRows, (r) => ymKey(r.year, r.month));
  const hoursByMonth = groupBy(hoursRows, (r) => ymKey(r.year, r.month));
  const officeByMonth = groupBy(officeRows, (r) => ymKey(r.year, r.month));
  const normByMonth = new Map(normRows.map((r) => [ymKey(r.year, r.month), r]));

  const objectTotals = new Map<number, number>(); // objects.id → suma zł z okna
  const employeeTotals = new Map<number, number>(); // hr_employees.id → suma zł z okna
  const usedMonths: MonthKey[] = [];
  let mappedHours = 0;
  let allHours = 0;

  for (const m of wanted) {
    const key = ymKey(m.year, m.month);
    const monthPayroll: HrPayroll[] = payrollByMonth.get(key) ?? [];
    const monthOffice = officeByMonth.get(key) ?? [];
    // Miesiąc bez ŻADNYCH danych płacowych nie jest „miesiącem z kosztem zero" —
    // to miesiąc, którego jeszcze nie wprowadzono. Wliczony do mianownika
    // rozcieńczyłby średnią (3 miesiące danych podzielone przez 12).
    if (monthPayroll.length === 0 && monthOffice.length === 0) continue;
    usedMonths.push(m);

    const monthHours: HrHours[] = hoursByMonth.get(key) ?? [];
    const payrollByContract = new Map(monthPayroll.map((p) => [p.contractId, p]));

    // Ten sam dobór umów, co `computeMonth()` w src/routes/hr.ts: aktywne
    // + nieaktywne, które mają wpis płacowy w tym miesiącu (historia).
    const relevant: HrContract[] = contracts.filter(
      (c) => c.active || payrollByContract.has(c.id),
    );
    const norms = normByMonth.get(key);

    const computed = computePayroll({
      contracts: relevant,
      payrollByContract,
      hoursByEmployee: buildHoursAggregates(monthHours),
      // Domyślne normy identyczne jak `getNorms()` w src/routes/hr.ts.
      workNorm: norms?.workNorm ?? 160,
      contractNorm: norms?.contractNorm ?? 158,
    });

    // --- koszt pracownika w tym miesiącu (umowy ochrony + rozliczenie biura)
    const costByEmployee = new Map<number, number>();
    for (const row of computed) add(costByEmployee, row.employeeId, row.wyplata);
    for (const row of monthOffice) add(costByEmployee, row.employeeId, officeTotal(row));

    for (const [employeeId, cost] of costByEmployee) {
      add(employeeTotals, employeeId, cost);
    }

    // --- godziny pracownika w tym miesiącu, w rozbiciu na pozycje kadrowe
    const hoursByEmployee = new Map<number, { total: number; perObject: Map<number, number> }>();
    for (const h of monthHours) {
      const worked = h.workedHours ?? 0;
      if (worked <= 0) continue;
      let entry = hoursByEmployee.get(h.employeeId);
      if (!entry) {
        entry = { total: 0, perObject: new Map() };
        hoursByEmployee.set(h.employeeId, entry);
      }
      entry.total += worked;
      allHours += worked;
      const objectId = h.objectId != null ? objectOf.get(h.objectId) : undefined;
      if (objectId != null) {
        mappedHours += worked;
        entry.perObject.set(objectId, (entry.perObject.get(objectId) ?? 0) + worked);
      }
      // else: pozycja niezmapowana albo wpis bez obiektu — koszt ogólny, nie alokujemy.
    }

    // --- alokacja proporcjonalna
    for (const [employeeId, cost] of costByEmployee) {
      if (cost === 0) continue;
      const entry = hoursByEmployee.get(employeeId);
      // Pracownik bez godzin w miesiącu (biuro, chorobowe, sam UW) — nie ma czym
      // dzielić, więc jego koszt zostaje kosztem ogólnym. Nie dzielimy przez zero.
      if (!entry || entry.total <= 0) continue;
      for (const [objectId, hours] of entry.perObject) {
        add(objectTotals, objectId, (cost * hours) / entry.total);
      }
    }
  }

  const monthsUsed = usedMonths.length;
  const byObjectId = new Map<number, number>();
  const byEmployeeId = new Map<number, number>();
  if (monthsUsed > 0) {
    for (const [id, total] of objectTotals) byObjectId.set(id, round2(total / monthsUsed));
    for (const [id, total] of employeeTotals) byEmployeeId.set(id, round2(total / monthsUsed));
  }

  return {
    byObjectId,
    byEmployeeId,
    months: usedMonths,
    mappedObjects: objectOf.size,
    hrObjectsTotal: hrObjectRows.length,
    // Godziny bez ani jednego wpisu w oknie → 0, a nie NaN: „nic nie uciekło
    // w koszt ogólny", bo nie było czego rozdzielać.
    unmappedHoursShare: allHours > 0 ? (allHours - mappedHours) / allHours : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Cache — jedno przeliczenie na (okno × stan danych kadrowych)         */
/* ------------------------------------------------------------------ */

/**
 * Analityka liczy to przy KAŻDYM żądaniu, a trzy zakładki potrafią odpytać
 * backend jedna po drugiej — bez cache'u ten sam rachunek szedłby trzy razy.
 * Klucz to okno + odcisk stanu tabel kadrowych: dopóki nikt nie ruszył godzin,
 * wypłat, umów ani mapowania obiektów, wynik nie ma prawa się zmienić.
 *
 * Sam `max(updated_at)` nie wystarcza — ma rozdzielczość sekundy, więc dwie
 * edycje w tej samej sekundzie dałyby ten sam odcisk. Stąd dokładane liczności
 * i sumy kwot/godzin: żeby zmiana wartości bez zmiany znacznika też unieważniła
 * cache. Do klucza wchodzi też bieżący miesiąc — o północy 1. dnia miesiąca
 * okno przesuwa się samo i stary wynik przestaje dotyczyć tych samych miesięcy.
 */
const FINGERPRINT_SQL = sql`select
  (select coalesce(max(updated_at), '') from hr_payroll) as p_max,
  (select count(*) from hr_payroll) as p_cnt,
  (select coalesce(sum(main_amount), 0) from hr_payroll) as p_sum,
  (select coalesce(max(updated_at), '') from hr_hours) as h_max,
  (select count(*) from hr_hours) as h_cnt,
  (select coalesce(sum(worked_hours), 0) from hr_hours) as h_sum,
  (select coalesce(max(updated_at), '') from hr_office_payroll) as o_max,
  (select count(*) from hr_office_payroll) as o_cnt,
  (select coalesce(sum(coalesce(ror_base, 0) + coalesce(amount, 0)), 0) from hr_office_payroll) as o_sum,
  (select coalesce(max(updated_at), '') from hr_contracts) as c_max,
  (select count(*) from hr_contracts) as c_cnt,
  (select coalesce(max(updated_at), '') from hr_objects) as m_max,
  (select count(object_id) from hr_objects) as m_cnt,
  (select coalesce(sum(object_id), 0) from hr_objects) as m_sum,
  (select coalesce(max(updated_at), '') from hr_month_norms) as n_max`;

function fingerprint(now: Date): string {
  const rows = db.all<Record<string, unknown>>(FINGERPRINT_SQL);
  const month = `${now.getFullYear()}-${now.getMonth()}`;
  return `${month}|${Object.values(rows[0] ?? {}).join("|")}`;
}

const cache = new Map<CostWindow, { fp: string; value: WindowComputation }>();

/** Ręczne czyszczenie cache'u — przydaje się testom, które podmieniają dane w locie. */
export function clearPersonnelCostCache(): void {
  cache.clear();
}

function windowComputation(window: CostWindow, now = new Date()): WindowComputation {
  const fp = fingerprint(now);
  const hit = cache.get(window);
  if (hit && hit.fp === fp) return hit.value;
  const value = computeWindow(window, now);
  cache.set(window, { fp, value });
  return value;
}

/* ------------------------------------------------------------------ */
/* API modułu                                                          */
/* ------------------------------------------------------------------ */

/**
 * Uśredniony koszt osobowy per obiekt kartoteki (`objects.id`), w zł/mies. NETTO.
 *
 * Przy zerowym mapowaniu (`hr_objects.object_id` wszędzie NULL — stan wyjściowy,
 * mapowanie robi się ręcznie w Kadry → Obiekty) zwraca pustą mapę, `mappedObjects: 0`
 * i `unmappedHoursShare: 1`. To jest poprawna odpowiedź, a nie błąd: dopóki nikt nie
 * powiedział, który posterunek to który obiekt, kosztu osobowego nie ma jak przypisać.
 */
export function computeObjectPersonnelCost(
  window: CostWindow,
  now = new Date(),
): PersonnelCostResult {
  const c = windowComputation(window, now);
  return {
    byObjectId: c.byObjectId,
    monthsUsed: c.months.length,
    months: c.months,
    mappedObjects: c.mappedObjects,
    hrObjectsTotal: c.hrObjectsTotal,
    unmappedHoursShare: c.unmappedHoursShare,
    net: true,
  };
}

/**
 * Uśredniony koszt pojedynczego pracownika (`hr_employees.id`) w zł/mies. NETTO —
 * ten sam mechanizm uśredniania, tylko bez rozbijania na obiekty.
 *
 * Po to jest, żeby handlowiec i technik POWIĄZANY z kartoteką kadrową
 * (`salespeople.employee_id`, `technicians.employee_id`) miał koszt własny liczony
 * z realnych wypłat, a nie z ręcznego `monthly_cost`. Bez tego ta sama osoba
 * kosztowałaby firmę dwa razy: raz w Kadrach, raz w Analityce.
 */
export function computeEmployeeMonthlyCost(
  window: CostWindow,
  now = new Date(),
): Map<number, number> {
  return windowComputation(window, now).byEmployeeId;
}
