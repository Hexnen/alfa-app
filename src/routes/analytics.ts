import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { asc, eq, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  computeEmployeeMonthlyCost,
  computeObjectPersonnelCost,
  parseCostWindow,
  type CostWindow,
  type EmployerCostInfo,
  type PersonnelCostBasis,
  type PersonnelCostResult,
} from "../lib/object-personnel-cost.js";

/**
 * Analityka — trzy widoki TYLKO DO ODCZYTU nad tymi samymi danymi, co lista obiektów:
 * kontrahenci, obiekty i handlowcy w ujęciu przychód / koszt / zysk.
 *
 * Cały moduł stoi na jednym słowniku pojęć liczonym per obiekt:
 *   revenue       = coalesce(monthly_value, 0)          — abonament
 *   personnelCost = koszt osobowy z Kadr (wypłaty × godziny na obiekcie)
 *   otherCost     = coalesce(monthly_cost, 0)           — monitoring, sprzęt, abonamenty
 *   cost          = personnelCost + otherCost           — KOSZT CAŁKOWITY
 *   profit        = revenue - cost
 *   hasCost       = monthly_cost IS NOT NULL || personnelCost > 0
 *   setup         = coalesce(setup_cost, 0)             — jednorazowe wdrożenie
 *   margin        = revenue > 0 ? profit / revenue * 100 : null
 *   payback       = setup > 0 && profit > 0 ? ceil(setup / profit) : null  (w miesiącach)
 * Wszystko inne w tym pliku to agregat z tych liczb — jeśli coś się nie zgadza,
 * błąd jest tutaj, a nie w trzech różnych zapytaniach.
 *
 * KOSZTY SIĘ SKŁADAJĄ. `monthly_cost` znaczy „koszt POZOSTAŁY", czyli wszystko poza
 * wynagrodzeniami; pensje załogi dokłada moduł src/lib/object-personnel-cost.ts.
 * Nigdy jedno ZAMIAST drugiego — podmiana zaniżyłaby koszt obiektów fizycznej
 * ochrony dokładnie o pensję ludzi, którzy na nich stoją.
 *
 * Kwoty osobowe to SZACOWANY KOSZT PRACODAWCY, a nie wypłata „na rękę": moduł kosztu
 * osobowego mnoży wypłatę netto przez narzut składkowy zależny od formy zatrudnienia
 * (praca+ZUA / zlecenie+ZUA / zlecenie+ZZA), konfigurowalny globalnie i per spółka.
 * Odpowiedź niesie to jako `totals.personnel.costBasis` (= "employerCost") plus blok
 * `totals.personnel.employer` z audytem: jakie narzuty, ile wierszy którym poszło
 * i jaki wyszedł narzut wypadkowy (`effectiveMarkup`) — UI robi z tego przypis.
 * Pole `net: true` ZNIKŁO celowo: po doliczeniu składek zdanie „bez składek
 * pracodawcy" stało się nieprawdą, a cicha zmiana znaczenia pod tą samą nazwą
 * zostawiłaby w interfejsie kłamstwo, którego nikt by nie zauważył.
 *
 * Rozróżnienie NULL vs 0 przy koszcie niesie całą historię „pokrycia danymi”
 * (`coverage`): marża obiektu bez ŻADNEGO znanego kosztu jest NIEZNANA, a nie
 * stuprocentowa.
 *
 * Dlaczego agregaty liczymy w JS, a nie w SQL: koszt osobowy przychodzi z Kadr
 * jako mapa w pamięci (godziny × wypłaty), więc do SQL-a nie ma jak go wstrzyknąć.
 * Zamiast utrzymywać dwie prawdy, cała analityka stoi na JEDNYM zapytaniu o obiekty
 * z zakresu (bez limitu, ~120 wierszy) i jednym przebiegu w JS.
 */
const app = new Hono();

// Handlowiec obiektu i handlowiec jego kontrahenta to ta sama tabela w dwóch rolach —
// tak samo jak na liście obiektów (src/routes/objects.ts:17-18).
const objectSalesperson = alias(schema.salespeople, "object_salesperson");
const contractorSalesperson = alias(schema.salespeople, "contractor_salesperson");

export type AnalyticsScope = "current" | "active" | "all";

/**
 * Zakres danych. Domyślnie „current" — czyli to samo, co domyślna zakładka listy
 * obiektów (wszystko poza archiwum), więc liczby z analityki dają się porównać
 * z tym, co użytkownik widzi w Obiektach.
 */
function parseScope(raw: string | undefined): AnalyticsScope {
  return raw === "all" ? "all" : raw === "active" ? "active" : "current";
}

/** Limit wierszy. Rankingi i tak są cięte, ale PODSUMOWANIA liczą się bez limitu. */
function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(Math.floor(n), 5000);
}

// Warunek zakresu dla zapytań budowanych query builderem.
const SCOPE_WHERE: Record<AnalyticsScope, SQL | undefined> = {
  current: ne(schema.objects.status, "inactive"),
  active: eq(schema.objects.status, "active"),
  all: undefined,
};

/**
 * Ten sam warunek zapisany dosłownie — do wstrzyknięcia w podzapytania skorelowane.
 *
 * Nazwy tabel piszemy DOSŁOWNIE (`objects.status`, nie `${schema.objects.status}`):
 * drizzle 0.36 renderuje interpolowaną kolumnę wewnątrz szablonu `sql` bez kwalifikatora
 * tabeli, więc w podzapytaniu skorelowanym trafiłaby w kolumnę o tej samej nazwie
 * z zapytania nadrzędnego (patrz komentarz w src/routes/salespeople.ts:59-61).
 */
const SCOPE_SQL: Record<AnalyticsScope, SQL> = {
  current: sql`objects.status <> 'inactive'`,
  active: sql`objects.status = 'active'`,
  all: sql`1 = 1`,
};

/**
 * Reguła „czyj to obiekt”: własny handlowiec obiektu, a gdy go nie ma — opiekun
 * kontrahenta. JEDNA definicja na cały plik, żeby nie rozjechała się z filtrem listy
 * obiektów (src/routes/objects.ts:150-161) ani z tym, co widzi użytkownik w tabeli.
 */
function effectiveSalespersonId(row: {
  objectSalesId: number | null;
  contractorSalesId: number | null;
}): number | null {
  return row.objectSalesId ?? row.contractorSalesId;
}

/** Blok informacyjny o tym, SKĄD wziął się koszt osobowy — UI robi z niego przypis. */
export interface PersonnelInfo {
  costWindow: CostWindow;
  monthsUsed: number;
  months: Array<{ year: number; month: number }>;
  mappedObjects: number;
  hrObjectsTotal: number;
  unmappedHoursShare: number;
  /**
   * Na czym stoją kwoty: "employerCost" = wypłata netto × szacunkowy narzut składek
   * pracodawcy. Zastępuje dawne `net: true` — kwoty NIE są już „na rękę".
   * (Uwaga na dwa różne „netto": po stronie handlowej kwoty nadal są bez VAT.)
   */
  costBasis: PersonnelCostBasis;
  /** Audyt doliczonych składek — narzuty, rozkład wierszy, narzut wypadkowy. */
  employer: EmployerCostInfo;
}

function personnelInfo(costWindow: CostWindow, p: PersonnelCostResult): PersonnelInfo {
  return {
    costWindow,
    monthsUsed: p.monthsUsed,
    months: p.months,
    mappedObjects: p.mappedObjects,
    hrObjectsTotal: p.hrObjectsTotal,
    unmappedHoursShare: p.unmappedHoursShare,
    costBasis: p.costBasis,
    employer: p.employer,
  };
}

export interface AnalyticsTotals {
  objects: number;
  objectsWithCost: number;
  coverage: number;
  revenue: number;
  cost: number;
  personnelCost: number;
  otherCost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  arpo: number | null;
  unprofitable: number;
  noRevenue: number;
  personnel: PersonnelInfo;
}

/**
 * Marża w % — null, a nie liczba, w dwóch przypadkach:
 *  - bez przychodu marża nie istnieje (dzielenie przez zero),
 *  - gdy NIE ZNAMY ani jednego kosztu w tym wierszu. Wtedy `profit` równa się
 *    przychodowi tylko dlatego, że koszty policzyliśmy jako zero, a marża
 *    "100%" byłaby najgorszym możliwym kłamstwem tego modułu: pierwszego dnia,
 *    zanim ktokolwiek wpisze koszt, każdy klient wyglądałby na czysty zysk.
 *    Front ma wtedy pokazać kreskę i onboarding, a nie wynik.
 */
function marginOf(revenue: number, profit: number, knownCosts: number): number | null {
  if (knownCosts <= 0) return null;
  return revenue > 0 ? (profit / revenue) * 100 : null;
}

/** Zwrot z wdrożenia w pełnych miesiącach; obiekt bez zysku nigdy się nie zwróci. */
function paybackOf(setup: number, profit: number): number | null {
  return setup > 0 && profit > 0 ? Math.ceil(setup / profit) : null;
}

/* ------------------------------------------------------------------ */
/* Wspólny fundament: obiekty zakresu z policzonym kosztem całkowitym  */
/* ------------------------------------------------------------------ */

interface ObjectRow {
  id: number;
  name: string;
  city: string | null;
  type: string;
  status: string;
  contractorId: number | null;
  contractorName: string | null;
  contractorCity: string | null;
  contractorActive: boolean | null;
  companyName: string | null;
  salesperson: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    inherited: boolean;
  } | null;
  /** Efektywny opiekun (własny albo odziedziczony) — do rolek per handlowiec. */
  effectiveSalespersonId: number | null;
  contractorSalespersonId: number | null;
  revenue: number;
  personnelCost: number;
  otherCost: number;
  cost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  payback: number | null;
  hasCost: boolean;
}

/**
 * Jedyne zapytanie o obiekty w całym module — ten sam zestaw złączeń, co lista
 * obiektów (src/routes/objects.ts:190-223), bez stronicowania i BEZ limitu:
 * limit tnie dopiero zwracany ranking, nigdy podstawę do podsumowań.
 */
async function loadObjectRows(
  scope: AnalyticsScope,
  personnel: PersonnelCostResult,
): Promise<ObjectRow[]> {
  const rows = await db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      city: schema.objects.city,
      type: schema.objects.type,
      status: schema.objects.status,
      contractorId: schema.objects.contractorId,
      contractorName: schema.contractors.name,
      contractorCity: schema.contractors.city,
      contractorActive: schema.contractors.active,
      contractorSalespersonId: schema.contractors.salespersonId,
      companyName: schema.companies.name,
      monthlyValue: schema.objects.monthlyValue,
      monthlyCost: schema.objects.monthlyCost,
      objectSetupCost: schema.objects.setupCost,
      objectSalesId: objectSalesperson.id,
      objectSalesFirstName: objectSalesperson.firstName,
      objectSalesLastName: objectSalesperson.lastName,
      contractorSalesId: contractorSalesperson.id,
      contractorSalesFirstName: contractorSalesperson.firstName,
      contractorSalesLastName: contractorSalesperson.lastName,
    })
    .from(schema.objects)
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.objects.companyId))
    .leftJoin(objectSalesperson, eq(objectSalesperson.id, schema.objects.salespersonId))
    .leftJoin(contractorSalesperson, eq(contractorSalesperson.id, schema.contractors.salespersonId))
    .where(SCOPE_WHERE[scope]);

  return rows.map((r) => {
    const revenue = r.monthlyValue ?? 0;
    // Koszt osobowy z Kadr i koszt pozostały z kartoteki SUMUJĄ SIĘ.
    const personnelCost = personnel.byObjectId.get(r.id) ?? 0;
    const otherCost = r.monthlyCost ?? 0;
    const cost = personnelCost + otherCost;
    const profit = revenue - cost;
    const setupCost = r.objectSetupCost ?? 0;
    // Koszt 0 zł to informacja, NULL to jej brak — ale gdy z Kadr spłynęła choćby
    // złotówka, koszt tego obiektu ZNAMY, nawet jeśli nikt nie wypełnił `monthly_cost`.
    const hasCost = r.monthlyCost !== null || personnelCost > 0;
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      type: r.type,
      status: r.status,
      contractorId: r.contractorId,
      contractorName: r.contractorName,
      contractorCity: r.contractorCity,
      contractorActive: r.contractorActive,
      companyName: r.companyName,
      // `inherited` mówi UI, że handlowiec jest odziedziczony po kontrahencie,
      // a nie przypisany do samego obiektu (tak samo jak na liście obiektów).
      salesperson: r.objectSalesId
        ? {
            id: r.objectSalesId,
            firstName: r.objectSalesFirstName,
            lastName: r.objectSalesLastName,
            inherited: false,
          }
        : r.contractorSalesId
          ? {
              id: r.contractorSalesId,
              firstName: r.contractorSalesFirstName,
              lastName: r.contractorSalesLastName,
              inherited: true,
            }
          : null,
      effectiveSalespersonId: effectiveSalespersonId(r),
      contractorSalespersonId: r.contractorSalespersonId,
      revenue,
      personnelCost,
      otherCost,
      cost,
      profit,
      margin: marginOf(revenue, profit, hasCost ? 1 : 0),
      setupCost,
      payback: paybackOf(setupCost, profit),
      hasCost,
    };
  });
}

/**
 * Podsumowanie firmowe liczone po WSZYSTKICH obiektach z zakresu. Nie wolno go składać
 * z sumy zwróconych wierszy rankingu: te są przycięte limitem, więc suma po nich po cichu
 * zaniżałaby przychód całej firmy. Dlatego `rows` przychodzi tu ZAWSZE nieprzycięte,
 * a `.slice(limit)` dzieje się dopiero w endpoincie.
 * Ten sam blok trafia do wszystkich trzech endpointów — te same nazwy pól i ta sama liczba.
 */
function loadTotals(
  rows: ObjectRow[],
  costWindow: CostWindow,
  personnel: PersonnelCostResult,
): AnalyticsTotals {
  let revenue = 0;
  let personnelCost = 0;
  let otherCost = 0;
  let setupCost = 0;
  let objectsWithCost = 0;
  let unprofitable = 0;
  let noRevenue = 0;
  for (const r of rows) {
    revenue += r.revenue;
    personnelCost += r.personnelCost;
    otherCost += r.otherCost;
    setupCost += r.setupCost;
    if (r.hasCost) objectsWithCost += 1;
    // „Nierentowny" tylko wtedy, gdy koszt JEST znany — obiekt bez kosztu nie jest
    // ani rentowny, ani nierentowny, jest nieopisany.
    if (r.hasCost && r.profit < 0) unprofitable += 1;
    if (r.revenue === 0) noRevenue += 1;
  }
  const objects = rows.length;
  const cost = personnelCost + otherCost;
  const profit = revenue - cost;

  return {
    objects,
    objectsWithCost,
    coverage: objects > 0 ? objectsWithCost / objects : 0,
    revenue,
    cost,
    personnelCost,
    otherCost,
    profit,
    margin: marginOf(revenue, profit, objectsWithCost),
    setupCost,
    arpo: objects > 0 ? revenue / objects : null,
    unprofitable,
    noRevenue,
    personnel: personnelInfo(costWindow, personnel),
  };
}

/** Wspólne wejście każdego endpointu: zakres, limit i okno uśredniania kosztu osobowego. */
async function baseline(c: {
  req: { query: (k: string) => string | undefined };
}) {
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));
  const costWindow = parseCostWindow(c.req.query("costWindow"));
  const personnel = computeObjectPersonnelCost(costWindow);
  const rows = await loadObjectRows(scope, personnel);
  return { scope, limit, costWindow, personnel, rows, totals: loadTotals(rows, costWindow, personnel) };
}

/* ------------------------------------------------------------------ */
/* GET /kontrahenci — ranking klientów wg zysku                        */
/* ------------------------------------------------------------------ */
app.get("/kontrahenci", async (c) => {
  const { scope, limit, costWindow, personnel, rows, totals } = await baseline(c);

  // Rolka po kontrahencie z tych samych wierszy obiektów — kontrahent bez obiektów
  // w zakresie nie ma o czym opowiadać i po prostu się tu nie pojawia (dopchnąłby
  // ranking wierszami z samymi zerami); liczymy go osobno, niżej.
  interface ContractorAcc {
    id: number;
    name: string | null;
    city: string | null;
    active: boolean | null;
    salespersonId: number | null;
    objectsCount: number;
    activeObjectsCount: number;
    objectsWithCost: number;
    revenue: number;
    personnelCost: number;
    otherCost: number;
    setupCost: number;
  }
  const acc = new Map<number, ContractorAcc>();
  for (const r of rows) {
    if (r.contractorId == null) continue;
    let a = acc.get(r.contractorId);
    if (!a) {
      a = {
        id: r.contractorId,
        name: r.contractorName,
        city: r.contractorCity,
        active: r.contractorActive,
        salespersonId: r.contractorSalespersonId,
        objectsCount: 0,
        activeObjectsCount: 0,
        objectsWithCost: 0,
        revenue: 0,
        personnelCost: 0,
        otherCost: 0,
        setupCost: 0,
      };
      acc.set(r.contractorId, a);
    }
    a.objectsCount += 1;
    if (r.status === "active") a.activeObjectsCount += 1;
    if (r.hasCost) a.objectsWithCost += 1;
    a.revenue += r.revenue;
    a.personnelCost += r.personnelCost;
    a.otherCost += r.otherCost;
    a.setupCost += r.setupCost;
  }

  // Handlowiec kontrahenta — tu bierzemy opiekuna z kartoteki klienta, bo wiersz
  // dotyczy klienta, a nie pojedynczego obiektu (obiekt może mieć własnego).
  const salespeople = await db.select().from(schema.salespeople);
  const salespersonById = new Map(salespeople.map((s) => [s.id, s]));

  const data = [...acc.values()]
    .map((a) => {
      const cost = a.personnelCost + a.otherCost;
      const profit = a.revenue - cost;
      const s = a.salespersonId != null ? salespersonById.get(a.salespersonId) : undefined;
      return {
        id: a.id,
        name: a.name,
        city: a.city,
        active: a.active,
        salesperson: s
          ? { id: s.id, firstName: s.firstName, lastName: s.lastName }
          : null,
        objectsCount: a.objectsCount,
        activeObjectsCount: a.activeObjectsCount,
        objectsWithCost: a.objectsWithCost,
        revenue: a.revenue,
        cost,
        personnelCost: a.personnelCost,
        otherCost: a.otherCost,
        profit,
        margin: marginOf(a.revenue, profit, a.objectsWithCost),
        setupCost: a.setupCost,
        payback: paybackOf(a.setupCost, profit),
        arpo: a.objectsCount > 0 ? a.revenue / a.objectsCount : null,
      };
    })
    .sort(
      (x, y) =>
        y.profit - x.profit ||
        (x.name ?? "").toLowerCase().localeCompare((y.name ?? "").toLowerCase()),
    )
    .slice(0, limit);

  // Ilu klientów wypadło z zestawienia, bo nie ma obiektów w tym zakresie —
  // liczymy osobno i bez limitu, żeby licznik nie zależał od przycięcia rankingu.
  const withoutRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors)
    .where(
      sql`not exists (
        select 1 from objects
        where objects.contractor_id = contractors.id and ${SCOPE_SQL[scope]}
      )`
    );

  return c.json({
    success: true,
    data: {
      scope,
      costWindow,
      generatedAt: new Date().toISOString(),
      totals,
      rows: data,
      contractorsWithoutObjects: withoutRows[0]?.count ?? 0,
      personnel: personnelInfo(costWindow, personnel),
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /obiekty — pełna lista obiektów z rentownością + przekroje      */
/* ------------------------------------------------------------------ */

export interface AnalyticsBucket {
  key: string;
  label?: string;
  count: number;
  revenue: number;
  cost: number;
  profit: number;
}

interface BucketSource {
  revenue: number;
  cost: number;
  profit: number;
}

/** Kubełkowanie wierszy po kluczu; kolejność wstawiania zachowana (Map). */
function bucketize<T extends BucketSource>(
  rows: T[],
  keyOf: (row: T) => string,
  labelOf?: (row: T) => string | undefined
): AnalyticsBucket[] {
  const out = new Map<string, AnalyticsBucket>();
  for (const row of rows) {
    const key = keyOf(row);
    let b = out.get(key);
    if (!b) {
      b = { key, label: labelOf?.(row), count: 0, revenue: 0, cost: 0, profit: 0 };
      out.set(key, b);
    }
    b.count += 1;
    b.revenue += row.revenue;
    b.cost += row.cost;
    b.profit += row.profit;
  }
  return [...out.values()];
}

// Stała kolejność przekrojów — ta sama, co przy sortowaniu listy obiektów
// (src/routes/objects.ts:35-36): status ma naturalną kolejność procesu, typ —
// kolejność polskich etykiet. Alfabet po wartościach z bazy nic tu nie znaczy.
const TYPE_ORDER = ["alarm", "mixed", "monitoring", "physical"];
const STATUS_ORDER = ["pending", "in_progress", "active", "inactive"];

function inOrder(buckets: AnalyticsBucket[], order: string[]): AnalyticsBucket[] {
  return [...buckets].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

// Progi marży. „brak danych" łapie zarówno obiekty bez przychodu (marża nie istnieje),
// jak i te bez wpisanego kosztu — inaczej obiekt z pustym `monthly_cost` wpadałby
// do kubełka „60%+" i sugerował rentowność, której nikt nie policzył.
const MARGIN_BUCKETS = ["<0%", "0–20", "20–40", "40–60", "60%+", "brak danych"];

function marginBucketKey(margin: number | null, hasCost: boolean): string {
  if (margin === null || !hasCost) return "brak danych";
  if (margin < 0) return "<0%";
  if (margin < 20) return "0–20";
  if (margin < 40) return "20–40";
  if (margin < 60) return "40–60";
  return "60%+";
}

app.get("/obiekty", async (c) => {
  const { scope, limit, costWindow, personnel, rows, totals } = await baseline(c);

  // Sortowanie po zysku dzieje się w JS, a nie w SQL: zysk zawiera teraz koszt
  // osobowy, którego baza nie zna, więc ORDER BY po `monthly_cost` układałby
  // ranking wg nieaktualnej definicji.
  const data = [...rows]
    .sort((a, b) => b.profit - a.profit || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      type: r.type,
      status: r.status,
      contractorId: r.contractorId,
      contractorName: r.contractorName,
      companyName: r.companyName,
      salesperson: r.salesperson,
      revenue: r.revenue,
      cost: r.cost,
      personnelCost: r.personnelCost,
      otherCost: r.otherCost,
      profit: r.profit,
      margin: r.margin,
      setupCost: r.setupCost,
      payback: r.payback,
      // Klucz całej opowieści o pokryciu: koszt 0 zł to informacja, NULL to jej brak.
      hasCost: r.hasCost,
    }));

  // Przekroje liczymy w JS z tych samych wierszy — kilkaset pozycji, więc drugie
  // zapytanie do bazy nic by nie dało poza kolejnym miejscem na rozjazd definicji.
  const byType = inOrder(bucketize(data, (r) => r.type), TYPE_ORDER);
  const byStatus = inOrder(bucketize(data, (r) => r.status), STATUS_ORDER);
  const byCompany = bucketize(
    data,
    (r) => r.companyName ?? "none",
    (r) => r.companyName ?? "Bez spółki"
  ).sort((a, b) => b.profit - a.profit);

  const marginByKey = bucketize(data, (r) => marginBucketKey(r.margin, r.hasCost));
  // Puste progi zostawiamy w odpowiedzi (count 0), żeby wykres na froncie miał
  // zawsze te same sześć słupków i nie przeskakiwał przy zmianie zakresu.
  const marginBuckets: AnalyticsBucket[] = MARGIN_BUCKETS.map(
    (key) =>
      marginByKey.find((b) => b.key === key) ?? {
        key,
        count: 0,
        revenue: 0,
        cost: 0,
        profit: 0,
      }
  );

  return c.json({
    success: true,
    data: {
      scope,
      costWindow,
      generatedAt: new Date().toISOString(),
      totals,
      rows: data,
      byType,
      byStatus,
      byCompany,
      marginBuckets,
      personnel: personnelInfo(costWindow, personnel),
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /handlowcy — rentowność portfela per opiekun                    */
/* ------------------------------------------------------------------ */
app.get("/handlowcy", async (c) => {
  const { scope, limit, costWindow, personnel, rows, totals } = await baseline(c);

  // Rolka portfela po EFEKTYWNYM opiekunie; klucz `null` to portfel niczyj.
  interface Portfolio {
    objectsCount: number;
    objectsWithCost: number;
    unprofitableObjects: number;
    revenue: number;
    personnelCost: number;
    otherCost: number;
    setupCost: number;
  }
  const empty = (): Portfolio => ({
    objectsCount: 0,
    objectsWithCost: 0,
    unprofitableObjects: 0,
    revenue: 0,
    personnelCost: 0,
    otherCost: 0,
    setupCost: 0,
  });
  const portfolios = new Map<number | null, Portfolio>();
  for (const r of rows) {
    const key = r.effectiveSalespersonId;
    let p = portfolios.get(key);
    if (!p) portfolios.set(key, (p = empty()));
    p.objectsCount += 1;
    if (r.hasCost) p.objectsWithCost += 1;
    if (r.hasCost && r.profit < 0) p.unprofitableObjects += 1;
    p.revenue += r.revenue;
    p.personnelCost += r.personnelCost;
    p.otherCost += r.otherCost;
    p.setupCost += r.setupCost;
  }

  /**
   * Budujemy OD HANDLOWCÓW, nie od obiektów pogrupowanych po opiekunie: handlowiec
   * z pustym portfelem dalej kosztuje firmę i musi się pokazać w zestawieniu
   * (grupowanie po obiektach po prostu by go pominęło).
   *
   * `contractorsCount` liczymy po bezpośrednim FK — „ilu klientów prowadzi", tak jak
   * na liście handlowców (src/routes/salespeople.ts:62-70), z dosłownymi nazwami tabel.
   */
  const salesRows = await db
    .select({
      salesperson: schema.salespeople,
      contractorsCount: sql<number>`(
        select count(*) from contractors where contractors.salesperson_id = salespeople.id
      )`,
    })
    .from(schema.salespeople)
    .orderBy(asc(sql`lower(salespeople.last_name)`), asc(schema.salespeople.firstName));

  // Koszt własny handlowca POWIĄZANEGO z kartoteką kadrową bierze się z jego wypłat.
  // Ręczny `salespeople.monthly_cost` jest wtedy IGNOROWANY (front go blokuje) —
  // inaczej ten sam człowiek kosztowałby firmę dwa razy: raz w Kadrach, raz tutaj.
  const employeeCost = computeEmployeeMonthlyCost(costWindow);

  /**
   * Portfel bez opiekuna — obiekty, dla których ani obiekt, ani jego kontrahent nie
   * mają handlowca. To przychód, którym nikt nie zarządza; wraca OSOBNYM polem, żeby
   * nigdy nie doklejał się po cichu do wyniku którejś z osób.
   */
  const u = portfolios.get(null) ?? empty();
  const unassignedCost = u.personnelCost + u.otherCost;
  const unassignedProfit = u.revenue - unassignedCost;
  const unassigned = {
    objectsCount: u.objectsCount,
    objectsWithCost: u.objectsWithCost,
    unprofitableObjects: u.unprofitableObjects,
    revenue: u.revenue,
    objectsCost: unassignedCost,
    objectsPersonnelCost: u.personnelCost,
    objectsOtherCost: u.otherCost,
    setupCost: u.setupCost,
    profit: unassignedProfit,
    margin: marginOf(u.revenue, unassignedProfit, u.objectsWithCost),
  };

  /**
   * Prowizja i koszt własny doliczane w JS, nie w SQL — dzięki temu cały wzór na
   * rentowność handlowca stoi w jednym czytelnym miejscu:
   *   contribution = marża portfela PRZED kosztem handlowca,
   *   profit       = to, co zostaje firmie po jego pensji i prowizji.
   */
  const computed = salesRows.map((r) => {
    const s = r.salesperson;
    const p = portfolios.get(s.id) ?? empty();
    const revenue = p.revenue;
    const objectsCost = p.personnelCost + p.otherCost;

    // Powiązanie z kadrami wygrywa z polem ręcznym — i mówimy o tym wprost,
    // żeby front wiedział, co pokazać i które pole zablokować.
    const linked = s.employeeId != null;
    const ownCostSource: "kadry" | "reczny" = linked ? "kadry" : "reczny";
    const ownCost = linked ? (employeeCost.get(s.employeeId!) ?? 0) : (s.monthlyCost ?? 0);
    // Koszt własny ZNANY: powiązanego liczymy z wypłat (choćby wyszło 0 — to wynik,
    // a nie brak danych), niepowiązanego tylko wtedy, gdy ktoś wpisał kwotę.
    const ownCostKnown = linked || s.monthlyCost !== null;

    const commission = (revenue * (s.commissionRate ?? 0)) / 100;
    const contribution = revenue - objectsCost;
    const profit = contribution - ownCost - commission;
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      region: s.region,
      active: s.active,
      employeeId: s.employeeId,
      contractorsCount: r.contractorsCount ?? 0,
      objectsCount: p.objectsCount,
      objectsWithCost: p.objectsWithCost,
      unprofitableObjects: p.unprofitableObjects,
      revenue,
      objectsCost,
      objectsPersonnelCost: p.personnelCost,
      objectsOtherCost: p.otherCost,
      setupCost: p.setupCost,
      ownCost,
      ownCostSource,
      /** Kwota z pola ręcznego — front pokazuje ją wyszarzoną, gdy źródłem są kadry. */
      manualMonthlyCost: s.monthlyCost,
      commissionRate: s.commissionRate,
      commission,
      contribution,
      profit,
      // Znany koszt to albo koszt któregoś obiektu, albo koszt własny handlowca —
      // wystarczy jedno, żeby zysk portfela przestał być samym przychodem.
      margin: marginOf(revenue, profit, p.objectsWithCost + (ownCostKnown ? 1 : 0)),
      // Ile złotówek przychodu przypada na złotówkę wydaną na handlowca.
      roi: ownCost + commission > 0 ? revenue / (ownCost + commission) : null,
    };
  });

  // Sumy po WSZYSTKICH handlowcach — liczone przed przycięciem listy limitem,
  // z tego samego powodu, co `totals`: obcięty ranking nie może zaniżać kosztów.
  // Archiwalni (`active = false`) też się liczą: archiwum to znacznik widoczności,
  // a nie informacja, że pensja przestała obciążać firmę — po zwolnieniu handlowca
  // wyczyść mu `monthly_cost` (albo zdejmij powiązanie z kadrami).
  const salespeopleCost = computed.reduce((sum, r) => sum + r.ownCost, 0);
  const commission = computed.reduce((sum, r) => sum + r.commission, 0);
  const salespeopleWithCost = computed.filter(
    (r) => r.ownCostSource === "kadry" || r.manualMonthlyCost !== null
  ).length;

  const data = [...computed].sort((a, b) => b.profit - a.profit).slice(0, limit);

  return c.json({
    success: true,
    data: {
      scope,
      costWindow,
      generatedAt: new Date().toISOString(),
      totals: {
        ...totals,
        salespeopleCost,
        commission,
        // Zysk firmy po odjęciu kosztu pionu handlowego od marży na obiektach.
        netProfit: totals.profit - salespeopleCost - commission,
        unassignedRevenue: u.revenue,
        salespeopleWithCost,
      },
      rows: data,
      unassigned,
      personnel: personnelInfo(costWindow, personnel),
    },
  });
});

export default app;
