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
 * ┌── SKŁADKI PRACODAWCY: KWOTY SĄ SZACUNKIEM, NIE WYCIĄGIEM Z LIST PŁAC ──────┐
 * │ `wyplata` z `computePayroll()` to przelew + gotówka, czyli kwota NETTO      │
 * │ „na rękę". Bazy brutto aplikacja NIE ZNA — księgowość podaje do kadr same   │
 * │ kwoty netto — więc składek po stronie pracodawcy nie da się policzyć wprost.│
 * │ Mnożymy więc netto przez konfigurowalny WSPÓŁCZYNNIK, osobny dla każdej     │
 * │ formy zatrudnienia (praca+ZUA / zlecenie+ZUA / zlecenie+ZZA), z możliwością │
 * │ nadpisania per spółka. To jawne przybliżenie: liczba ma być OBRONIALNA      │
 * │ (stąd blok `employer` z audytem), a nie udawać wyciągu z ZUS.               │
 * │ Domyślne współczynniki i ich wyprowadzenie: src/lib/company-config.ts.      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Wynik NIE jest już kwotą „na rękę": API wystawia `costBasis: "employerCost"`
 * w bloku informacyjnym, żeby UI nie napisało pod tabelą, że składek tu nie ma.
 *
 * REGUŁY PŁACOWE NIE SĄ TU POWTARZANE. Miesiąc liczy `computePayroll()`
 * z src/utils/hr-calc.ts — dokładnie ta sama funkcja, którą wywołuje
 * `computeMonth()` w src/routes/hr.ts. Gdyby reguła się zmieniła, zmieni się
 * w jednym miejscu, a nie w dwóch rozjeżdżających się kopiach.
 *
 * ALGORYTM (miesiąc po miesiącu, potem średnia):
 *  1. koszt pracownika w miesiącu = suma `wyplata` × narzut składkowy po jego umowach
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
import { getCompanyConfig } from "./company-config.js";

/** Okno uśredniania w miesiącach: ostatni pełny / średnia z 3 / średnia z 12. */
export type CostWindow = 1 | 3 | 12;

export interface MonthKey {
  year: number;
  month: number; // 1-12
}

/**
 * Forma zatrudnienia w rozumieniu SKŁADEK PRACODAWCY — trzy przypadki, bo tylko
 * one różnią relację „netto na rękę → koszt firmy":
 *  - `uop`         umowa o pracę (zawsze ZUA): pełne składki pracodawcy,
 *  - `zlecenieZua` zlecenie na ZUA: te same składki firmy, ale pracownik nie płaci
 *                  chorobowego, więc z tego samego brutto zostaje mu więcej netto,
 *  - `zlecenieZza` zlecenie tylko na ZZA: samo zdrowotne, w całości po stronie
 *                  pracownika — pracodawca do ZUS nie dopłaca NIC (narzut ≈ 1,22
 *                  bierze się wyłącznie z tego, że netto jest bliżej brutto).
 * `officeFallback` nie jest formą, tylko przyznaniem się do braku danych:
 * rozliczenie biura bez odpowiadającej umowy w `hr_contracts`.
 */
export type EmploymentForm = "uop" | "zlecenieZua" | "zlecenieZza";

/** Który narzut zastosowano do konkretnego wiersza wypłaty. */
export type MarkupBucket = EmploymentForm | "officeFallback";

/**
 * Blok audytowy składek — po to, żeby doliczone kilkadziesiąt procent dało się
 * OBRONIĆ przed księgową: widać, ile wierszy poszło którą ścieżką, jakie były
 * współczynniki i ile w sumie z tego wyszło.
 */
export interface EmployerCostInfo {
  /** Zawsze true — składki są doliczane bezwarunkowo (narzut 1,0 = brak dopłaty). */
  applied: true;
  /** Ile wierszy wypłat (z niezerową kwotą) użyło którego narzutu. */
  byForm: Record<MarkupBucket, number>;
  /** Wartości GLOBALNE z ustawień firmy (nadpisania spółek się tu nie mieszczą). */
  markups: { uop: number; zlecenieZua: number; zlecenieZza: number; officeDefault: number };
  /** Ile spółek ma choć jedno własne nadpisanie (`companies.employer_markup_*`). */
  companyOverrides: number;
  /**
   * Koszt łączny / wypłaty netto łącznie w całym oknie — JEDNA liczba do pokazania
   * w UI („koszt osobowy zawiera ok. +59% składek pracodawcy"). Zawsze mieści się
   * między najniższym a najwyższym faktycznie użytym narzutem. Bez wypłat = 1.
   */
  effectiveMarkup: number;
}

/**
 * Na czym stoją kwoty kosztu osobowego. Dawniej było tu `net: true` („na rękę");
 * od czasu doliczania składek kwota jest SZACOWANYM KOSZTEM PRACODAWCY, więc pole
 * zmieniło nazwę razem ze znaczeniem — front, który nie zauważy zmiany, przestanie
 * się kompilować, zamiast po cichu pisać nieprawdę pod tabelą.
 */
export type PersonnelCostBasis = "employerCost";

export interface PersonnelCostResult {
  /** objects.id → uśredniony koszt osobowy w zł/mies. (netto × narzut). Brak klucza = 0. */
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
  /** Kwoty to SZACOWANY KOSZT PRACODAWCY (wypłata netto × narzut), nie „na rękę". */
  costBasis: PersonnelCostBasis;
  /** Audyt doliczonych składek — patrz `EmployerCostInfo`. */
  employer: EmployerCostInfo;
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
  employer: EmployerCostInfo;
}

/* ------------------------------------------------------------------ */
/* Narzut składek pracodawcy                                           */
/* ------------------------------------------------------------------ */

/**
 * Nazwa spółki jako klucz dopasowania. W kadrach spółka jest TEKSTEM
 * (`hr_contracts.company`), a nie kluczem obcym do `companies`, więc jedyne, co
 * łączy jedno z drugim, to nazwa. Trim + lowercase, bo różnica wielkości liter
 * albo spacja na końcu nie może kosztować spółki jej własnego narzutu.
 */
const companyKey = (name: string) => name.trim().toLowerCase();

/** Trzy narzuty jednej spółki; null = „użyj globalnego". */
type CompanyMarkups = Record<EmploymentForm, number | null>;

/**
 * Rozwiązywanie narzutu: nadpisanie spółki → wartość globalna.
 * Zbudowane RAZ na przeliczenie okna, nie per wiersz wypłaty — przy 12 miesiącach
 * × ~140 umów to różnica między dwoma zapytaniami a dwoma tysiącami.
 */
interface MarkupResolver {
  /** Narzut dla umowy; `undefined` (brak umowy) → narzut awaryjny biura. */
  forContract(contract: HrContract | undefined): { markup: number; bucket: MarkupBucket };
  /** Wartości globalne do bloku audytowego. */
  globals: EmployerCostInfo["markups"];
  /** Ile spółek ma choć jedno własne nadpisanie. */
  companyOverrides: number;
}

/**
 * Forma zatrudnienia wg tych samych reguł, co gałąź płacowa w `computePayroll()`:
 * umowa o pracę to zawsze ZUA, a przy zleceniu decyduje NIEPUSTE zgłoszenie,
 * przy czym ZUA wygrywa z ZZA (pełniejsze zgłoszenie).
 *
 * Zlecenie BEZ ZUA i BEZ ZZA (w danych nie występuje, ale schemat na to pozwala)
 * traktujemy jak ZZA: skoro nikt nikogo nie zgłosił, pracodawca nie odprowadza
 * składek i doliczanie mu pełnego narzutu byłoby zawyżeniem kosztu obiektu.
 */
function employmentForm(contract: HrContract): EmploymentForm {
  if (contract.contractType === "praca") return "uop";
  return contract.zua.trim() ? "zlecenieZua" : "zlecenieZza";
}

function buildMarkupResolver(): MarkupResolver {
  const cfg = getCompanyConfig().values;
  const globals: EmployerCostInfo["markups"] = {
    uop: cfg.employerMarkupUop,
    zlecenieZua: cfg.employerMarkupZlecenieZua,
    zlecenieZza: cfg.employerMarkupZlecenieZza,
    officeDefault: cfg.employerMarkupOfficeDefault,
  };

  const companyRows = db
    .select({
      name: schema.companies.name,
      uop: schema.companies.employerMarkupUop,
      zlecenieZua: schema.companies.employerMarkupZlecenieZua,
      zlecenieZza: schema.companies.employerMarkupZlecenieZza,
    })
    .from(schema.companies)
    .all();

  const byCompany = new Map<string, CompanyMarkups>();
  let companyOverrides = 0;
  for (const r of companyRows) {
    if (r.uop == null && r.zlecenieZua == null && r.zlecenieZza == null) continue;
    companyOverrides++;
    byCompany.set(companyKey(r.name), {
      uop: r.uop,
      zlecenieZua: r.zlecenieZua,
      zlecenieZza: r.zlecenieZza,
    });
  }

  return {
    globals,
    companyOverrides,
    forContract(contract) {
      // Brak umowy = wiersz biura, którego pracownik w ogóle nie figuruje
      // w `hr_contracts` (156 ze 168 wierszy w produkcyjnej bazie). Formy nie ma
      // skąd odczytać, więc idzie narzut domyślny — i jest to widoczne w `byForm`.
      if (!contract) return { markup: globals.officeDefault, bucket: "officeFallback" };
      const form = employmentForm(contract);
      const override = byCompany.get(companyKey(contract.company))?.[form];
      return { markup: override ?? globals[form], bucket: form };
    },
  };
}

/** Świeży, wyzerowany licznik wierszy per narzut. */
const emptyByForm = (): Record<MarkupBucket, number> => ({
  uop: 0,
  zlecenieZua: 0,
  zlecenieZza: 0,
  officeFallback: 0,
});

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

  // Narzuty składkowe: ustawienia firmy + nadpisania spółek, wczytane raz na okno.
  const markups = buildMarkupResolver();
  // Umowa po id — dla wierszy biura szukamy „jakiejkolwiek" umowy pracownika,
  // żeby odczytać z niej formę zatrudnienia (patrz `contractOfEmployee`).
  const contractById = new Map<number, HrContract>(contracts.map((c) => [c.id, c]));
  /**
   * Umowa reprezentatywna dla pracownika biura. `hr_office_payroll` nie ma formy
   * zatrudnienia ani wskazania na umowę, a osoba może mieć ich kilka — bierzemy
   * AKTYWNĄ o najniższym id (deterministycznie, żeby ten sam stan bazy zawsze
   * dawał tę samą liczbę); gdy nie ma aktywnej, dowolną. Brak umowy → narzut biura.
   */
  const contractOfEmployee = new Map<number, HrContract>();
  for (const c of [...contracts].sort((a, b) => a.id - b.id)) {
    const cur = contractOfEmployee.get(c.employeeId);
    if (!cur || (!cur.active && c.active)) contractOfEmployee.set(c.employeeId, c);
  }

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
  // Audyt składek: ile wierszy poszło którą ścieżką i jaki wyszedł narzut wypadkowy.
  const byForm = emptyByForm();
  let netTotal = 0;
  let grossCostTotal = 0;

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
    //
    // Narzut składkowy nakładamy TU, przed rozdzieleniem na obiekty: alokacja jest
    // proporcjonalna do godzin, więc mnożenie przed nią i po niej daje tę samą kwotę,
    // ale przed nią liczy się raz na pracownika zamiast raz na obiekt.
    const costByEmployee = new Map<number, number>();
    const withEmployerCost = (net: number, contract: HrContract | undefined) => {
      const { markup, bucket } = markups.forContract(contract);
      // Wiersze zerowe (umowa aktywna, ale w tym miesiącu bez wypłaty) nie mówią nic
      // o strukturze zatrudnienia — liczone psułyby proporcje w `byForm`.
      if (net !== 0) {
        byForm[bucket]++;
        netTotal += net;
        grossCostTotal += net * markup;
      }
      return net * markup;
    };
    for (const row of computed) {
      add(costByEmployee, row.employeeId, withEmployerCost(row.wyplata, contractById.get(row.contractId)));
    }
    for (const row of monthOffice) {
      // Gdy pracownik biura MA umowę w kadrach, jej forma wygrywa z narzutem domyślnym —
      // domyślny jest tylko dla tych 12 z 13 osób, których w `hr_contracts` nie ma wcale.
      add(
        costByEmployee,
        row.employeeId,
        withEmployerCost(officeTotal(row), contractOfEmployee.get(row.employeeId)),
      );
    }

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
    employer: {
      applied: true,
      byForm,
      markups: markups.globals,
      companyOverrides: markups.companyOverrides,
      // Bez wypłat w oknie nie ma czego uśredniać — 1 znaczy „nic nie doliczono",
      // a nie 0/0. Zaokrąglenie do 4 miejsc: to mnożnik, nie kwota.
      effectiveMarkup:
        netTotal > 0 ? Math.round((grossCostTotal / netTotal) * 10000) / 10000 : 1,
    },
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
 *
 * Od czasu doliczania składek do odcisku wchodzą TAKŻE narzuty: globalne
 * (`app_settings`, klucze `company.employer_markup_*`) i nadpisania spółek
 * (`companies.employer_markup_*` + nazwa spółki, bo to po niej idzie dopasowanie).
 * Bez tego admin zmieniłby współczynnik w panelu i zobaczył STARE liczby — dane
 * kadrowe przecież nie drgnęły. `order by key` w podzapytaniu, bo kolejność
 * `group_concat` bez sortowania jest w SQLite niezdefiniowana i sam odcisk
 * potrafiłby migotać przy niezmienionych ustawieniach.
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
  (select coalesce(max(updated_at), '') from hr_month_norms) as n_max,
  (select coalesce(group_concat(kv, ';'), '') from (
     select key || '=' || value as kv from app_settings
     where key like 'company.employer_markup_%' order by key)) as s_markup,
  (select coalesce(group_concat(cv, ';'), '') from (
     select name || '=' ||
            coalesce(employer_markup_uop, '-') || '/' ||
            coalesce(employer_markup_zlecenie_zua, '-') || '/' ||
            coalesce(employer_markup_zlecenie_zza, '-') as cv
     from companies
     where employer_markup_uop is not null
        or employer_markup_zlecenie_zua is not null
        or employer_markup_zlecenie_zza is not null
     order by name)) as c_markup`;

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
 * Uśredniony koszt osobowy per obiekt kartoteki (`objects.id`), w zł/mies., jako
 * SZACOWANY KOSZT PRACODAWCY (wypłata netto × narzut składkowy — patrz nagłówek pliku).
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
    costBasis: "employerCost",
    employer: c.employer,
  };
}

/**
 * Uśredniony koszt pojedynczego pracownika (`hr_employees.id`) w zł/mies. —
 * ten sam mechanizm uśredniania i TEN SAM narzut składkowy, tylko bez rozbijania
 * na obiekty. Musi być ten sam, bo inaczej ta sama osoba kosztowałaby firmę
 * inaczej jako „załoga obiektu" niż jako „handlowiec".
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
