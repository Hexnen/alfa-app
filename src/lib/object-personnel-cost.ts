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
 *  1. koszt pracownika w miesiącu = JEDEN strumień zgodny z `hr_employees.kind`:
 *     `ochrona` → suma `wyplata` × narzut składkowy po jego umowach,
 *     `biuro`   → rozliczenie z `hr_office_payroll` × narzut.
 *     Wpisy w drugim strumieniu są IGNOROWANE i zgłaszane w `warnings` — osoba
 *     przepięta biuro→ochrona (albo odwrotnie) miałaby inaczej koszt liczony
 *     dwa razy: raz z umowy, raz z tabeli biura,
 *  2. rozbicie na obiekty proporcjonalnie do `worked_hours` z `hr_hours`,
 *  3. do KOSZTU OGÓLNEGO (nierozdzielonego) idą godziny: bez przypisania,
 *     na pozycjach NIEZMAPOWANYCH (`hr_objects.object_id IS NULL` — #BIURO,
 *     #zlecenie) oraz na DZIAŁACH SPOZA PULI (handlowy, księgowość, zarząd).
 *     To nie jest koszt konkretnego obiektu. Pracownik z połową godzin na dziale
 *     handlowym oddaje obiektowi połowę swojego kosztu i TAK MA BYĆ,
 *  4. suma po `hr_objects.object_id` (kilka pozycji kadrowych może wskazywać
 *     ten sam obiekt kartoteki — sumujemy),
 *  5. średnia po liczbie miesięcy, które FAKTYCZNIE miały dane płacowe OCHRONY
 *     (kwoty w `hr_payroll`); miesiąc z samym biurem nie wchodzi do mianownika.
 *
 * ┌── DRUGA ŚCIEŻKA: UDZIAŁ W KOSZCIE CENTRUM MONITOROWANIA (CMA) ─────────────┐
 * │ Obiekt bez ochrony fizycznej nie ma „swoich" godzin — nikt na nim nie stoi. │
 * │ Kosztuje jednak firmę realnie: jego sygnały odbiera dyżurny w CMA. Godziny  │
 * │ CMA były do tej pory kosztem ogólnym i po prostu PRZEPADAŁY, przez co        │
 * │ obiekt z pięcioma kamerami wychodził na czysty zysk.                        │
 * │                                                                             │
 * │ Od teraz DZIAŁ oznaczony `hr_departments.is_cma_pool` tworzy PULĘ,           │
 * │ którą rozdzielamy po dozorowanych JEDNOSTKACH:                              │
 * │   jednostki(obiekt) = SSWiN(1) + wideorecepcja(1) + liczba kamer            │
 * │   udziałCMA(obiekt) = pulaCMA × jednostki(obiekt) / Σ jednostki             │
 * │ Mianownik obejmuje TYLKO obiekty aktywne i w realizacji: obiekt archiwalny   │
 * │ nie obciąża już centrum, więc nie może rozcieńczać kosztu pozostałym. Jest   │
 * │ przez to STAŁY — niezależny od zakresu wybranego w widoku analityki, bo      │
 * │ inaczej koszt tego samego obiektu skakałby przy przełączeniu filtra.         │
 * │                                                                             │
 * │ Obie ścieżki SIĘ SUMUJĄ: obiekt z OFI i kamerami dostaje i pensje swojej     │
 * │ załogi, i udział w centrum. Nigdy jedno zamiast drugiego.                    │
 * │                                                                             │
 * │ Pula mieszka w `hr_departments`, bo centrum monitorowania nie jest obiektem  │
 * │ — nikt na nim nie stoi i nie da się go zmapować do kartoteki. Godziny        │
 * │ wskazują ALBO obiekt (`hr_hours.object_id`), ALBO dział                      │
 * │ (`hr_hours.department_id`); działy spoza puli są kosztem ogólnym.            │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { HrContract, HrHours, HrPayroll } from "../db/schema.js";
import { buildHoursAggregates, computePayroll } from "../utils/hr-calc.js";
import { getCompanyConfig } from "./company-config.js";
import { officeRowTotals } from "./hr-office-total.js";
import {
  flagsFromServicesInRange,
  monthBounds,
  type ServicePeriodLike,
} from "./object-services.js";

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

/**
 * Usługi obiektu w rozumieniu WAGI w podziale kosztu centrum monitorowania.
 * Tylko te cztery pola — reszta kartoteki nie ma tu nic do rzeczy.
 */
export interface ObjectServices {
  hasSswin: boolean;
  hasCameras: boolean;
  cameraCount: number | null;
  hasVideoreception: boolean;
}

/**
 * Statusy obiektów wchodzących do MIANOWNIKA podziału CMA. Decyzja użytkownika:
 * dozorowany jest obiekt aktywny i ten w trakcie realizacji; „pending" jeszcze nie
 * generuje ruchu w centrum, a archiwalny już go nie generuje. Zbiór jest STAŁY —
 * nie zależy od zakresu wybranego w analityce, bo inaczej ten sam obiekt miałby
 * różny koszt na zakładce „bieżące" i „wszystkie".
 */
export const CMA_DENOMINATOR_STATUSES = ["active", "in_progress"] as const;

/**
 * Waga obiektu w podziale kosztu CMA. SSWiN liczy się jako jeden, wideorecepcja
 * jako jeden, kamery po jednej za sztukę.
 *
 * `cameraCount` bierzemy WYŁĄCZNIE, gdy usługa kamer jest włączona: liczba, która
 * została w bazie po odznaczeniu usługi, nie może obciążać obiektu za monitoring,
 * którego mu nie świadczymy. `cameraCount = NULL` przy `hasCameras` to z kolei
 * brak danych, a nie zero — obiekt nie dostaje wtedy wagi za kamery i jest
 * raportowany w `cma.objectsMissingCameraCount`, żeby zaniżony koszt był WIDOCZNY.
 */
export function serviceUnits(o: ObjectServices): number {
  return (
    (o.hasSswin ? 1 : 0) +
    (o.hasVideoreception ? 1 : 0) +
    (o.hasCameras ? (o.cameraCount ?? 0) : 0)
  );
}

/**
 * Audyt podziału kosztu centrum monitorowania — te same intencje, co blok
 * `employer`: liczba ma dać się OBRONIĆ („obiekt dostał 3 jednostki × 41 zł”),
 * a braki danych mają być widoczne, a nie po cichu zaniżać koszt.
 */
export interface CmaAllocationInfo {
  /** Koszt puli CMA w zł/mies. po narzucie składkowym. 0 = mechanizm nieaktywny. */
  pool: number;
  /** Mianownik — suma jednostek wszystkich dozorowanych obiektów w firmie. */
  units: number;
  /** `pool / units`, czyli ile kosztuje jedna dozorowana jednostka. Bez jednostek 0. */
  perUnit: number;
  /** Ile obiektów faktycznie weszło do mianownika (jednostki > 0). */
  objectsInDenominator: number;
  /** Obiekty z usługą kamer, ale bez podanej ilości — nie dostają wagi za kamery. */
  objectsMissingCameraCount: number;
  /**
   * Ile DZIAŁÓW oznaczono jako pula centrum monitorowania (0 = mechanizm
   * nieaktywny, godziny CMA wracają do kosztu ogólnego). W praktyce 1 — CRUD
   * działów pilnuje, że flagę nosi jeden dział naraz.
   */
  poolPositions: number;
}

/** Mianownik podziału puli CMA w JEDNYM miesiącu okna. */
interface CmaDenominator {
  /** Suma jednostek dozorowanych obiektów w tym miesiącu. */
  units: number;
  /** Obiekty z niezerową wagą — po nich rozdziela się pula tego miesiąca. */
  entries: Array<{ id: number; units: number }>;
  /** Obiekty z usługą kamer, ale bez podanej liczby — zaniżają swój udział. */
  missingCameraCount: number;
}

export interface PersonnelCostResult {
  /**
   * objects.id → uśredniony koszt osobowy w zł/mies. (netto × narzut), czyli SUMA
   * obu ścieżek: alokacji wprost z godzin + udziału w koszcie CMA. Brak klucza = 0.
   * Rozbicie na składniki niosą `directByObjectId` i `cmaShareByObjectId`.
   */
  byObjectId: Map<number, number>;
  /** Sama alokacja WPROST (godziny pracowników tego obiektu). Brak klucza = 0. */
  directByObjectId: Map<number, number>;
  /** Sam udział w koszcie centrum monitorowania. Brak klucza = 0. */
  cmaShareByObjectId: Map<number, number>;
  /** Audyt podziału puli CMA. */
  cma: CmaAllocationInfo;
  /** Ile miesięcy faktycznie weszło do średniej — UI pokazuje „średnia z 3, dane za 2". */
  monthsUsed: number;
  /** Które to miesiące, od najstarszego. */
  months: MonthKey[];
  /**
   * Miesiące pominięte, bo mają jakieś wiersze (płacowe albo biura), ale ŻADNEJ
   * wprowadzonej kwoty OCHRONY — czekają na księgową. UI ma o nich powiedzieć
   * wprost: inaczej „średnia z 3 (dane za 2)" wygląda na brak danych, a jest
   * brakiem ROZLICZENIA konkretnego miesiąca.
   */
  skippedMonths: MonthKey[];
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
  /**
   * Niespójności danych, które rachunek OMINĄŁ zamiast liczyć podwójnie — po
   * polsku, gotowe do pokazania: „Kowalski Jan (ochrona) ma wpisy w rozliczeniu
   * biura za 2026-05 — pominięto". Pusta lista = dane czyste.
   */
  warnings: string[];
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
  directByObjectId: Map<number, number>;
  cmaShareByObjectId: Map<number, number>;
  cma: CmaAllocationInfo;
  byEmployeeId: Map<number, number>;
  months: MonthKey[];
  skippedMonths: MonthKey[];
  mappedObjects: number;
  hrObjectsTotal: number;
  unmappedHoursShare: number;
  employer: EmployerCostInfo;
  warnings: string[];
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
  // Kartoteka osób — `kind` decyduje, KTÓRY strumień płacowy liczy się dla
  // danej osoby (umowy albo biuro), a nazwisko trafia do ostrzeżeń.
  const employeeRows = db
    .select({
      id: schema.hrEmployees.id,
      fullName: schema.hrEmployees.fullName,
      kind: schema.hrEmployees.kind,
    })
    .from(schema.hrEmployees)
    .all();
  const employeeById = new Map(employeeRows.map((e) => [e.id, e]));
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
    .select({
      id: schema.hrObjects.id,
      objectId: schema.hrObjects.objectId,
    })
    .from(schema.hrObjects)
    .all();
  // Działy — jedno zapytanie na całe okno, poza pętlą miesięcy (jak `objectRows`
  // niżej): słownik nie zmienia się w trakcie liczenia, a flagi puli szukamy dla
  // każdego z kilkunastu miesięcy tej samej.
  const hrDepartmentRows = db
    .select({
      id: schema.hrDepartments.id,
      isCmaPool: schema.hrDepartments.isCmaPool,
    })
    .from(schema.hrDepartments)
    .all();
  // Usługi obiektów — jedno zapytanie na całe okno, poza pętlą miesięcy: kartoteka
  // nie zmienia się w trakcie liczenia. To flagi NA DZIŚ; służą jako mianownik
  // wyłącznie dla obiektów bez ani jednego wiersza okresu (patrz `periodsByObject`).
  const objectRows = db
    .select({
      id: schema.objects.id,
      status: schema.objects.status,
      hasSswin: schema.objects.hasSswin,
      hasCameras: schema.objects.hasCameras,
      cameraCount: schema.objects.cameraCount,
      hasVideoreception: schema.objects.hasVideoreception,
    })
    .from(schema.objects)
    .all();

  /*
   * OKRESY USŁUG — mianownik CMA liczony PER MIESIĄC, a nie „dzisiejszym stanem".
   *
   * Do września 2026 dwunastomiesięczny koszt centrum dzielił się DZISIEJSZYMI
   * kamerami: obiekt podłączony trzy miesiące temu dostawał udział także za
   * dziewięć miesięcy, w których centrum go nie dozorowało, a obiekt odłączony
   * pół roku temu znikał z mianownika także z miesięcy, w których jeszcze był.
   * Od czasu tabeli `object_services` (migracja 0084) znamy prawdziwe daty, więc
   * każdy miesiąc okna dzieli swoją pulę po usługach aktywnych W TYM MIESIĄCU.
   *
   * Jedno zapytanie o CAŁĄ tabelę (kilkaset wierszy), tak samo jak `objectRows`:
   * filtrowanie po oknie zaoszczędziłoby kilkanaście wierszy, a kosztowałoby
   * drugą definicję „okres nachodzi na okno".
   *
   * Obiekty BEZ ani jednego wiersza (D3: skrypty, seedy, dane sprzed migracji)
   * liczą się z flag `objects.has_*` w każdym miesiącu okna — tak jak przed tą
   * zmianą. Nie mamy o nich historii i cisza nie znaczy „usługi nie było".
   */
  const periodRows = db
    .select({
      objectId: schema.objectServices.objectId,
      service: schema.objectServices.service,
      startDate: schema.objectServices.startDate,
      endDate: schema.objectServices.endDate,
      cameraCount: schema.objectServices.cameraCount,
    })
    .from(schema.objectServices)
    .all();
  const periodsByObject = new Map<number, ServicePeriodLike[]>();
  for (const r of periodRows) {
    const list = periodsByObject.get(r.objectId);
    if (list) list.push(r);
    else periodsByObject.set(r.objectId, [r]);
  }

  /** Mianownik CMA w konkretnym miesiącu: kto dozorowany, z jaką wagą i czego brakuje. */
  const cmaDenominatorFor = (month: MonthKey): CmaDenominator => {
    const { from, to } = monthBounds(month.year, month.month);
    const entries: Array<{ id: number; units: number }> = [];
    let units = 0;
    let missingCameraCount = 0;
    for (const o of objectRows) {
      // Status bierzemy BIEŻĄCY — historii statusów kartoteka nie trzyma, więc
      // obiekt zarchiwizowany dziś nie wnosi jednostek także do dawnych miesięcy.
      // To ta sama zasada, co przed zmianą; okresy usług dokładają do niej
      // wyłącznie wiedzę o tym, KIEDY usługa faktycznie była świadczona.
      if (!(CMA_DENOMINATOR_STATUSES as readonly string[]).includes(o.status)) continue;
      const periods = periodsByObject.get(o.id);
      const s: ObjectServices = periods
        ? flagsFromServicesInRange(periods, from, to)
        : {
            hasSswin: o.hasSswin,
            hasCameras: o.hasCameras,
            cameraCount: o.cameraCount,
            hasVideoreception: o.hasVideoreception,
          };
      const u = serviceUnits(s);
      if (s.hasCameras && s.cameraCount == null) missingCameraCount++;
      if (u <= 0) continue;
      units += u;
      entries.push({ id: o.id, units: u });
    }
    return { units, entries, missingCameraCount };
  };

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
  /**
   * `hr_departments.id` DZIAŁÓW będących PULĄ centrum monitorowania — ich godziny
   * nie idą na żaden obiekt wprost, tylko do wspólnego worka rozdzielanego po
   * jednostkach. Uwaga: to id z INNEJ tabeli niż klucze `objectOf`.
   *
   * Podwójnego liczenia pilnuje sam model: wiersz `hr_hours` wskazuje obiekt ALBO
   * dział (`parseHours` w src/routes/hr.ts odrzuca oba naraz), więc te same godziny
   * nie mogą trafić i na obiekt, i do puli.
   */
  const cmaPoolIds = new Set<number>();
  for (const d of hrDepartmentRows) {
    if (d.isCmaPool) cmaPoolIds.add(d.id);
  }

  const payrollByMonth = groupBy(payrollRows, (r) => ymKey(r.year, r.month));
  const hoursByMonth = groupBy(hoursRows, (r) => ymKey(r.year, r.month));
  const officeByMonth = groupBy(officeRows, (r) => ymKey(r.year, r.month));
  const normByMonth = new Map(normRows.map((r) => [ymKey(r.year, r.month), r]));

  const objectTotals = new Map<number, number>(); // objects.id → suma zł z okna
  const employeeTotals = new Map<number, number>(); // hr_employees.id → suma zł z okna
  const usedMonths: MonthKey[] = [];
  /** Miesiące z wierszami, ale bez kwot — czekają na księgową. */
  const skippedMonths: MonthKey[] = [];
  let cmaPoolCost = 0; // suma zł z okna, która trafiła na pozycje puli CMA
  /** objects.id → suma udziałów w puli CMA z całego okna (dzielone per miesiąc). */
  const cmaTotals = new Map<number, number>();
  /** Mianownik OSTATNIEGO policzonego miesiąca — z niego robi się blok `cma`. */
  let lastDenominator: CmaDenominator = { units: 0, entries: [], missingCameraCount: 0 };
  let mappedHours = 0;
  let cmaHours = 0;
  /** Godziny CMA z miesięcy, w których pula miała się na co podzielić. */
  let cmaHoursAllocated = 0;
  let allHours = 0;
  // Audyt składek: ile wierszy poszło którą ścieżką i jaki wyszedł narzut wypadkowy.
  const byForm = emptyByForm();
  let netTotal = 0;
  let grossCostTotal = 0;
  const warnings: string[] = [];
  /**
   * Ostrzeżenie o osobie z wpisami w NIEWŁAŚCIWYM strumieniu — raz na
   * (osoba, miesiąc), nie raz na wiersz: osoba biura z trzema umowami dałaby
   * inaczej trzy identyczne linijki.
   */
  const warned = new Set<string>();
  const warnWrongStream = (employeeId: number, m: MonthKey, stream: "biuro" | "umowy") => {
    const key = `${employeeId}:${ymKey(m.year, m.month)}:${stream}`;
    if (warned.has(key)) return;
    warned.add(key);
    const emp = employeeById.get(employeeId);
    const who = emp ? `${emp.fullName} (${emp.kind})` : `pracownik #${employeeId}`;
    const where = stream === "biuro" ? "w rozliczeniu biura" : "w wypłatach z umów";
    warnings.push(
      `${who} ma wpisy ${where} za ${m.year}-${String(m.month).padStart(2, "0")} — pominięto, koszt liczony tylko z rozliczenia zgodnego z rodzajem`,
    );
  };

  for (const m of wanted) {
    const key = ymKey(m.year, m.month);
    const monthPayroll: HrPayroll[] = payrollByMonth.get(key) ?? [];
    const monthOffice = officeByMonth.get(key) ?? [];
    /*
     * Miesiąc niewprowadzony NIE jest miesiącem o koszcie zero — wliczony do
     * mianownika rozcieńcza średnią.
     *
     * Sprawdzamy WPROWADZONE KWOTY, a nie istnienie wierszy. Godziny importuje
     * się wcześniej niż kwoty od księgowości, więc miesiąc czekający na
     * rozliczenie ma komplet wierszy z `main_amount = NULL` — i wcześniejszy
     * warunek (`length === 0`) brał go za policzony. Na produkcji był to
     * czerwiec 2026: 90 wierszy, ZERO kwot, przy 470 tys. w maju i 484 tys.
     * w lipcu. Domyślne okno 3 miesięcy dzieliło koszt przez trzy zamiast przez
     * dwa i pokazywało firmie +9,9% marży zamiast −2,2%.
     *
     * Wszystkie pozostałe miesiące mają kwoty w 100% wierszy, więc nie ma tu
     * strefy szarej: albo księgowa wprowadziła miesiąc, albo nie.
     */
    const hasPayrollAmounts = monthPayroll.some((r) => r.mainAmount != null);
    if (!hasPayrollAmounts) {
      // Kwot ochrony nie ma — miesiąc NIE wchodzi do średniej, niezależnie od
      // tego, czy wierszy payrollu jest 90 (czekają na księgową) czy ZERO (nikt
      // nawet nie założył miesiąca). Zero wierszy to brak danych, nie zerowy
      // koszt: miesiąc z samym rozliczeniem biura liczony jako pełnoprawny
      // dzielił koszt ochrony przez jeden miesiąc więcej — przy oknie z dwóch
      // miesięcy zaniżał go o połowę. Ochrona to ~90% kosztu, więc taki miesiąc
      // nie opisuje żadnej realnej stawki miesięcznej.
      //
      // Do `skippedMonths` (UI: „czeka na rozliczenie") trafia miesiąc, który ma
      // JAKIEKOLWIEK wiersze — payrollu albo biura. Miesiąc bez żadnych danych
      // po prostu nie istnieje w oknie i nie ma o czym mówić.
      if (monthPayroll.length > 0 || monthOffice.length > 0) skippedMonths.push(m);
      continue;
    }
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
    // JEDEN strumień na osobę, wybierany po `hr_employees.kind`: ochrona → umowy,
    // biuro → tabela biura. Drugi strumień jest pomijany i zgłaszany. Bez tego
    // osoba przepięta z biura do ochrony (stare wiersze biura zostają w bazie,
    // nowe idą już z umowy) kosztowała firmę dwa razy — a `wyplata = 0` umowy
    // bez kwoty nie ratuje, bo stare wiersze biura kwoty mają.
    // Osoba nieznana kartotece (nie powinno się zdarzyć — FK CASCADE) idzie
    // ścieżką swojego strumienia, żeby nie gubić kosztu po cichu.
    for (const row of computed) {
      const kind = employeeById.get(row.employeeId)?.kind ?? "ochrona";
      if (kind !== "ochrona") {
        if (row.wyplata !== 0) warnWrongStream(row.employeeId, m, "umowy");
        continue;
      }
      add(costByEmployee, row.employeeId, withEmployerCost(row.wyplata, contractById.get(row.contractId)));
    }
    for (const row of monthOffice) {
      const kind = employeeById.get(row.employeeId)?.kind ?? "biuro";
      if (kind !== "biuro") {
        warnWrongStream(row.employeeId, m, "biuro");
        continue;
      }
      // Gdy pracownik biura MA umowę w kadrach, jej forma wygrywa z narzutem domyślnym —
      // domyślny jest tylko dla tych 12 z 13 osób, których w `hr_contracts` nie ma wcale.
      add(
        costByEmployee,
        row.employeeId,
        withEmployerCost(officeRowTotals(row).total, contractOfEmployee.get(row.employeeId)),
      );
    }

    for (const [employeeId, cost] of costByEmployee) {
      add(employeeTotals, employeeId, cost);
    }

    // --- godziny pracownika w tym miesiącu, w rozbiciu na pozycje kadrowe
    /** Godziny centrum W TYM MIESIĄCU — patrz `cmaHoursAllocated` niżej. */
    let monthCmaHours = 0;
    const hoursByEmployee = new Map<
      number,
      { total: number; perObject: Map<number, number>; cma: number }
    >();
    for (const h of monthHours) {
      const worked = h.workedHours ?? 0;
      if (worked <= 0) continue;
      let entry = hoursByEmployee.get(h.employeeId);
      if (!entry) {
        entry = { total: 0, perObject: new Map(), cma: 0 };
        hoursByEmployee.set(h.employeeId, entry);
      }
      /*
       * ┌── UWAGA: TE DWIE LINIE MUSZĄ ZOSTAĆ PRZED ROZGAŁĘZIENIEM ──────────────┐
       * │ `entry.total` jest MIANOWNIKIEM alokacji kosztu pracownika. Wchodzi do  │
       * │ niego KAŻDA przepracowana godzina — także ta na dziale spoza puli.      │
       * │ Naturalny odruch przy dopisywaniu działów („to nie obiekt, pomiń        │
       * │ wiersz") skurczyłby mianownik i obiekty wchłonęłyby koszt Handlowego    │
       * │ i Księgowości: pracownik z połową godzin na dziale oddałby obiektowi    │
       * │ CAŁY swój koszt zamiast połowy. Cicho, bez błędu, z zawyżonym kosztem   │
       * │ obiektu i zaniżonym kosztem ogólnym firmy.                              │
       * └────────────────────────────────────────────────────────────────────────┘
       */
      entry.total += worked;
      allHours += worked;
      if (h.departmentId != null) {
        if (cmaPoolIds.has(h.departmentId)) {
          // Godziny centrum monitorowania — nie wiadomo jeszcze, na które obiekty
          // pójdą, bo to zależy od podziału po jednostkach. Zbieramy do puli.
          cmaHours += worked;
          monthCmaHours += worked;
          entry.cma += worked;
        }
        // Dział spoza puli (handlowy, księgowość, zarząd) — koszt ogólny firmy,
        // nie alokujemy go na żaden obiekt.
        continue;
      }
      const objectId = h.objectId != null ? objectOf.get(h.objectId) : undefined;
      if (objectId != null) {
        mappedHours += worked;
        entry.perObject.set(objectId, (entry.perObject.get(objectId) ?? 0) + worked);
      }
      // else: pozycja niezmapowana albo wpis bez przypisania — koszt ogólny.
    }

    // --- alokacja proporcjonalna
    /** Pula centrum ZA TEN MIESIĄC — dzieli się po usługach aktywnych w nim. */
    let monthCmaCost = 0;
    for (const [employeeId, cost] of costByEmployee) {
      if (cost === 0) continue;
      const entry = hoursByEmployee.get(employeeId);
      // Pracownik bez godzin w miesiącu (biuro, chorobowe, sam UW) — nie ma czym
      // dzielić, więc jego koszt zostaje kosztem ogólnym. Nie dzielimy przez zero.
      if (!entry || entry.total <= 0) continue;
      for (const [objectId, hours] of entry.perObject) {
        add(objectTotals, objectId, (cost * hours) / entry.total);
      }
      // Ta sama proporcja godzin, tylko odbiorcą jest pula, a nie obiekt: dyżurny
      // z połową godzin na CMA oddaje centrum połowę swojego kosztu.
      if (entry.cma > 0) monthCmaCost += (cost * entry.cma) / entry.total;
    }
    cmaPoolCost += monthCmaCost;

    /*
     * --- podział puli TEGO MIESIĄCA po jednostkach dozorowanych W TYM MIESIĄCU
     *
     * Mianownik liczymy w każdym użytym miesiącu, także gdy pula wyszła zerowa:
     * z ostatniego z nich robi się blok audytowy `cma` (units / perUnit / braki
     * liczby kamer), a ten ma opisywać stan NAJBLIŻSZY dzisiejszemu, nie średnią
     * z roku — użytkownik porównuje go z kolumną „jednostki" w tabeli obiektów,
     * a ta pokazuje dzisiejsze usługi.
     */
    const denominator = cmaDenominatorFor(m);
    lastDenominator = denominator;
    if (denominator.units > 0) {
      cmaHoursAllocated += monthCmaHours;
      if (monthCmaCost > 0) {
        const perUnitThisMonth = monthCmaCost / denominator.units;
        for (const e of denominator.entries) {
          add(cmaTotals, e.id, perUnitThisMonth * e.units);
        }
      }
    }
  }

  const monthsUsed = usedMonths.length;
  const directByObjectId = new Map<number, number>();
  const byEmployeeId = new Map<number, number>();
  if (monthsUsed > 0) {
    for (const [id, total] of objectTotals) directByObjectId.set(id, round2(total / monthsUsed));
    for (const [id, total] of employeeTotals) byEmployeeId.set(id, round2(total / monthsUsed));
  }

  /* --- pula CMA: średnia miesięczna z udziałów policzonych PER MIESIĄC ------
   *
   * Sam podział dzieje się w pętli miesięcy wyżej (każdy miesiąc dzieli swoją
   * pulę po SWOICH jednostkach); tutaj zostaje już tylko uśrednienie po liczbie
   * miesięcy okna — dokładnie tak samo, jak przy alokacji wprost z godzin.
   */
  const pool = monthsUsed > 0 ? round2(cmaPoolCost / monthsUsed) : 0;
  const cmaShareByObjectId = new Map<number, number>();
  if (monthsUsed > 0) {
    for (const [id, total] of cmaTotals) {
      const share = round2(total / monthsUsed);
      // Grosze poniżej progu zaokrąglenia (obiekt dozorowany przez jeden miesiąc
      // z dwunastu przy mikroskopijnej puli) nie mają czego opisywać — zero
      // znaczyłoby „policzone i wyszło 0", a to nieprawda o niczym.
      if (share !== 0) cmaShareByObjectId.set(id, share);
    }
  }
  /*
   * Blok audytowy opisuje OSTATNI policzony miesiąc okna, czyli stan najbliższy
   * dzisiejszemu — a nie średnią z roku. Powód jest interfejsowy: front stawia
   * `perUnit` obok kolumny „jednostki", którą liczy z DZISIEJSZYCH usług obiektu
   * (analytics.ts → `serviceUnits`), więc mianownik uśredniony po dwunastu
   * miesiącach nie zgadzałby się z niczym, co widać na ekranie.
   *
   * Konsekwencja do zapamiętania: przy oknie 12 miesięcy iloczyn
   * `perUnit × jednostki` NIE musi się równać udziałowi obiektu, którego usługi
   * w tym roku się zmieniły — jego udział liczy się z miesięcy, w których
   * faktycznie był dozorowany. Dla okna 1 miesiąca obie liczby są tożsame.
   */
  const units = lastDenominator.units;
  const objectsMissingCameraCount = lastDenominator.missingCameraCount;
  // Zero jednostek (np. cała baza bez usług albo świeżo po migracji, gdy nikt nie
  // policzył kamer) → nie dzielimy przez zero; pula zostaje kosztem ogólnym, tak
  // jak przed wprowadzeniem tego mechanizmu, i widać to po `perUnit = 0`.
  const perUnit = units > 0 ? pool / units : 0;

  // Koszt osobowy obiektu = obie ścieżki RAZEM. Rozbicie zostaje dostępne osobno,
  // bo UI ma umieć powiedzieć, z czego ta kwota się składa.
  const byObjectId = new Map<number, number>(directByObjectId);
  for (const [id, share] of cmaShareByObjectId) {
    byObjectId.set(id, round2((byObjectId.get(id) ?? 0) + share));
  }

  return {
    byObjectId,
    directByObjectId,
    cmaShareByObjectId,
    cma: {
      pool,
      units,
      // Zaokrąglenie do groszy dopiero na wyjściu — sam podział liczy się na
      // pełnej precyzji, żeby suma udziałów nie rozjechała się z pulą.
      perUnit: round2(perUnit),
      objectsInDenominator: lastDenominator.entries.length,
      objectsMissingCameraCount,
      poolPositions: cmaPoolIds.size,
    },
    byEmployeeId,
    months: usedMonths,
    skippedMonths,
    mappedObjects: objectOf.size,
    hrObjectsTotal: hrObjectRows.length,
    // Godziny bez ani jednego wpisu w oknie → 0, a nie NaN: „nic nie uciekło
    // w koszt ogólny", bo nie było czego rozdzielać.
    // Godziny CMA liczą się jako ROZDZIELONE, ale tylko z tych miesięcy, w których
    // pula faktycznie miała się na co podzielić (`cmaHoursAllocated`) — z miesiąca
    // bez jednostek w mianowniku wracają do kosztu ogólnego i przypis „X% godzin
    // poza obiektami" musi to uczciwie pokazać.
    unmappedHoursShare:
      allHours > 0 ? (allHours - mappedHours - cmaHoursAllocated) / allHours : 0,
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
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Cache — jedno przeliczenie na (okno × stan danych kadrowych)         */
/* ------------------------------------------------------------------ */

/**
 * Analityka liczy to przy KAŻDYM żądaniu, a trzy zakładki potrafią odpytać
 * backend jedna po drugiej — bez cache'u ten sam rachunek szedłby trzy razy.
 * Klucz to okno + odcisk stanu tabel kadrowych: dopóki nikt nie ruszył godzin,
 * wypłat, umów, mapowania obiektów ani słownika działów, wynik nie ma prawa
 * się zmienić.
 *
 * Sam `max(updated_at)` nie wystarcza — ma rozdzielczość sekundy, więc dwie
 * edycje w tej samej sekundzie dałyby ten sam odcisk. Stąd dokładane liczności
 * i sumy kwot/godzin: żeby zmiana wartości bez zmiany znacznika też unieważniła
 * cache. Do klucza wchodzi też bieżący miesiąc — o północy 1. dnia miesiąca
 * okno przesuwa się samo i stary wynik przestaje dotyczyć tych samych miesięcy.
 *
 * Od czasu podziału puli CMA do odcisku wchodzi też sama tabela `objects`: usługi,
 * liczba kamer i status decydują o mianowniku, więc dopisanie kamery ma odświeżyć
 * wynik tak samo, jak wpisanie wypłaty. Bez tego admin dodałby obiektowi kamery
 * i zobaczył STARY koszt — dane kadrowe przecież nie drgnęły.
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
  -- Przypisanie wiersza godzin do działu. Bez tej sumy przepięcie wpisu z obiektu
  -- na dział w tej samej sekundzie co inna edycja nie zmieniłoby ani h_max
  -- (rozdzielczość sekundy), ani h_cnt, ani h_sum — a koszt obiektu owszem.
  (select coalesce(sum(coalesce(department_id, 0)), 0) from hr_hours) as h_dept,
  (select coalesce(max(updated_at), '') from hr_office_payroll) as o_max,
  (select count(*) from hr_office_payroll) as o_cnt,
  (select coalesce(sum(coalesce(ror_base, 0) + coalesce(amount, 0)), 0) from hr_office_payroll) as o_sum,
  (select coalesce(max(updated_at), '') from hr_contracts) as c_max,
  (select count(*) from hr_contracts) as c_cnt,
  (select coalesce(max(updated_at), '') from hr_objects) as m_max,
  (select count(object_id) from hr_objects) as m_cnt,
  (select coalesce(sum(object_id), 0) from hr_objects) as m_sum,
  -- Działy: sama flaga puli nie wystarczy (przeniesienie jej z działu 1 na dział 2
  -- daje tę samą sumę), stąd max(updated_at) i licznik obok.
  (select coalesce(sum(is_cma_pool * id), 0) from hr_departments) as d_pool,
  (select coalesce(max(updated_at), '') from hr_departments) as d_max,
  (select count(*) from hr_departments) as d_cnt,
  (select coalesce(max(updated_at), '') from objects) as ob_max,
  (select count(*) from objects) as ob_cnt,
  (select coalesce(sum(has_sswin + 2 * has_cameras + 4 * has_videoreception), 0) from objects) as ob_svc,
  (select coalesce(sum(coalesce(camera_count, 0)), 0) from objects) as ob_cam,
  (select count(camera_count) from objects) as ob_cam_known,
  (select count(*) from objects where status in ('active', 'in_progress')) as ob_scope,
  -- Okresy usług: to one, a nie flagi objects.has_*, wyznaczają mianownik CMA
  -- w POSZCZEGÓLNYCH miesiącach okna. Edycja daty albo liczby kamer w okresie
  -- bywa przy tym niewidoczna w tabeli objects (flagi się nie zmieniają, gdy
  -- usługa nadal trwa), więc bez tych czterech liczników admin przesunąłby
  -- początek okresu o rok i dostał STARY koszt — kartoteka przecież nie drgnęła.
  (select count(*) from object_services) as os_cnt,
  (select coalesce(max(updated_at), '') from object_services) as os_max,
  (select coalesce(sum(coalesce(camera_count, 0)), 0) from object_services) as os_cam,
  (select count(camera_count) from object_services) as os_cam_known,
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
 * Kwota to SUMA dwóch ścieżek: alokacji wprost z godzin pracowników tego obiektu
 * (ochrona fizyczna) i udziału w koszcie centrum monitorowania (SSWiN / kamery /
 * wideorecepcja). Rozbicie na składniki niosą `directByObjectId`, `cmaShareByObjectId`
 * i blok `cma`.
 *
 * Przy zerowym mapowaniu (`hr_objects.object_id` wszędzie NULL — stan wyjściowy,
 * mapowanie robi się ręcznie w Kadry → Obiekty) zwraca pustą mapę, `mappedObjects: 0`
 * i `unmappedHoursShare: 1`. To jest poprawna odpowiedź, a nie błąd: dopóki nikt nie
 * powiedział, który posterunek to który obiekt, kosztu osobowego nie ma jak przypisać.
 * Tak samo brak działu z `hr_departments.is_cma_pool` daje `cma.pool = 0` — mechanizm
 * jest wtedy nieaktywny, a nie zepsuty.
 */
export function computeObjectPersonnelCost(
  window: CostWindow,
  now = new Date(),
): PersonnelCostResult {
  const c = windowComputation(window, now);
  return {
    byObjectId: c.byObjectId,
    directByObjectId: c.directByObjectId,
    cmaShareByObjectId: c.cmaShareByObjectId,
    cma: c.cma,
    monthsUsed: c.months.length,
    months: c.months,
    skippedMonths: c.skippedMonths,
    mappedObjects: c.mappedObjects,
    hrObjectsTotal: c.hrObjectsTotal,
    unmappedHoursShare: c.unmappedHoursShare,
    costBasis: "employerCost",
    employer: c.employer,
    warnings: c.warnings,
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
