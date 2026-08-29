import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { asc, desc, eq, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

/**
 * Analityka — trzy widoki TYLKO DO ODCZYTU nad tymi samymi danymi, co lista obiektów:
 * kontrahenci, obiekty i handlowcy w ujęciu przychód / koszt / zysk.
 *
 * Cały moduł stoi na jednym słowniku pojęć liczonym per obiekt:
 *   revenue = coalesce(monthly_value, 0)     — abonament
 *   cost    = coalesce(monthly_cost, 0)      — koszt obsługi
 *   profit  = revenue - cost
 *   hasCost = monthly_cost IS NOT NULL       — NULL to NIE zero, tylko „nikt nie wpisał”
 *   setup   = coalesce(setup_cost, 0)        — jednorazowe wdrożenie
 *   margin  = revenue > 0 ? profit / revenue * 100 : null
 *   payback = setup > 0 && profit > 0 ? ceil(setup / profit) : null  (w miesiącach)
 * Wszystko inne w tym pliku to agregat z tych pięciu liczb — jeśli coś się nie zgadza,
 * błąd jest tutaj, a nie w trzech różnych zapytaniach.
 *
 * Rozróżnienie NULL vs 0 przy koszcie niesie całą historię „pokrycia danymi”
 * (`coverage`): marża obiektu bez wpisanego kosztu jest NIEZNANA, a nie stuprocentowa.
 */
const app = new Hono();

// Handlowiec obiektu i handlowiec jego kontrahenta to ta sama tabela w dwóch rolach —
// tak samo jak na liście obiektów (src/routes/objects.ts:17-18).
const objectSalesperson = alias(schema.salespeople, "object_salesperson");
const contractorSalesperson = alias(schema.salespeople, "contractor_salesperson");

/**
 * Reguła „czyj to obiekt”: własny handlowiec obiektu, a gdy go nie ma — opiekun
 * kontrahenta. JEDNA definicja na cały plik, żeby nie rozjechała się z filtrem listy
 * obiektów (src/routes/objects.ts:150-161) ani z tym, co widzi użytkownik w tabeli.
 *
 * Nazwy tabel piszemy DOSŁOWNIE (`objects.salesperson_id`, nie `${schema.objects.salespersonId}`):
 * drizzle 0.36 renderuje interpolowaną kolumnę wewnątrz szablonu `sql` bez kwalifikatora
 * tabeli, więc w podzapytaniu skorelowanym trafiłaby w kolumnę o tej samej nazwie
 * z zapytania nadrzędnego (patrz komentarz w src/routes/salespeople.ts:59-61).
 */
export const EFFECTIVE_SALESPERSON = sql`coalesce(objects.salesperson_id, contractors.salesperson_id)`;

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

// Ten sam warunek zapisany dosłownie — do wstrzyknięcia w podzapytania skorelowane
// (tam alias drizzle by nie zadziałał, patrz EFFECTIVE_SALESPERSON).
const SCOPE_SQL: Record<AnalyticsScope, SQL> = {
  current: sql`objects.status <> 'inactive'`,
  active: sql`objects.status = 'active'`,
  all: sql`1 = 1`,
};

export interface AnalyticsTotals {
  objects: number;
  objectsWithCost: number;
  coverage: number;
  revenue: number;
  cost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  arpo: number | null;
  unprofitable: number;
  noRevenue: number;
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

/**
 * Podsumowanie firmowe liczone ODDZIELNYM, NIEOGRANICZONYM zapytaniem po wszystkich
 * obiektach z zakresu. Nie wolno go składać z sumy zwróconych wierszy: te są przycięte
 * limitem, więc suma po nich po cichu zaniżałaby przychód całej firmy.
 * Ten sam blok trafia do wszystkich trzech endpointów — te same nazwy pól i ta sama liczba.
 */
async function loadTotals(scope: AnalyticsScope): Promise<AnalyticsTotals> {
  const rows = await db
    .select({
      objects: sql<number>`count(*)`,
      objectsWithCost: sql<number>`coalesce(sum(case when objects.monthly_cost is not null then 1 else 0 end), 0)`,
      revenue: sql<number>`coalesce(sum(coalesce(objects.monthly_value, 0)), 0)`,
      cost: sql<number>`coalesce(sum(coalesce(objects.monthly_cost, 0)), 0)`,
      setupCost: sql<number>`coalesce(sum(coalesce(objects.setup_cost, 0)), 0)`,
      // „Nierentowny" tylko wtedy, gdy koszt JEST znany — obiekt bez kosztu nie jest
      // ani rentowny, ani nierentowny, jest nieopisany.
      unprofitable: sql<number>`coalesce(sum(case when objects.monthly_cost is not null and coalesce(objects.monthly_value, 0) - coalesce(objects.monthly_cost, 0) < 0 then 1 else 0 end), 0)`,
      noRevenue: sql<number>`coalesce(sum(case when objects.monthly_value is null or objects.monthly_value = 0 then 1 else 0 end), 0)`,
    })
    .from(schema.objects)
    .where(SCOPE_WHERE[scope]);

  const r = rows[0];
  const revenue = r?.revenue ?? 0;
  const cost = r?.cost ?? 0;
  const objects = r?.objects ?? 0;
  const objectsWithCost = r?.objectsWithCost ?? 0;
  const profit = revenue - cost;

  return {
    objects,
    objectsWithCost,
    coverage: objects > 0 ? objectsWithCost / objects : 0,
    revenue,
    cost,
    profit,
    margin: marginOf(revenue, profit, objectsWithCost),
    setupCost: r?.setupCost ?? 0,
    arpo: objects > 0 ? revenue / objects : null,
    unprofitable: r?.unprofitable ?? 0,
    noRevenue: r?.noRevenue ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* GET /kontrahenci — ranking klientów wg zysku                        */
/* ------------------------------------------------------------------ */
app.get("/kontrahenci", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));

  const totals = await loadTotals(scope);

  const rows = await db
    .select({
      id: schema.contractors.id,
      name: schema.contractors.name,
      city: schema.contractors.city,
      active: schema.contractors.active,
      salespersonId: schema.salespeople.id,
      salespersonFirstName: schema.salespeople.firstName,
      salespersonLastName: schema.salespeople.lastName,
      objectsCount: sql<number>`count(objects.id)`,
      activeObjectsCount: sql<number>`coalesce(sum(case when objects.status = 'active' then 1 else 0 end), 0)`,
      objectsWithCost: sql<number>`coalesce(sum(case when objects.monthly_cost is not null then 1 else 0 end), 0)`,
      revenue: sql<number>`coalesce(sum(coalesce(objects.monthly_value, 0)), 0)`,
      cost: sql<number>`coalesce(sum(coalesce(objects.monthly_cost, 0)), 0)`,
      setupCost: sql<number>`coalesce(sum(coalesce(objects.setup_cost, 0)), 0)`,
    })
    .from(schema.contractors)
    .leftJoin(schema.objects, eq(schema.objects.contractorId, schema.contractors.id))
    // Handlowiec kontrahenta — tu bierzemy opiekuna z kartoteki klienta, bo wiersz
    // dotyczy klienta, a nie pojedynczego obiektu (obiekt może mieć własnego).
    .leftJoin(schema.salespeople, eq(schema.salespeople.id, schema.contractors.salespersonId))
    .where(SCOPE_WHERE[scope])
    .groupBy(schema.contractors.id)
    // Kontrahent bez obiektów w zakresie nie ma o czym opowiadać, a dopchnąłby ranking
    // wierszami z samymi zerami — przy tej wielkości bazy widać to od razu.
    .having(sql`count(objects.id) > 0`)
    .orderBy(
      desc(sql`coalesce(sum(coalesce(objects.monthly_value, 0)), 0) - coalesce(sum(coalesce(objects.monthly_cost, 0)), 0)`),
      asc(sql`lower(contractors.name)`)
    )
    .limit(limit);

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

  const data = rows.map((r) => {
    const revenue = r.revenue ?? 0;
    const cost = r.cost ?? 0;
    const profit = revenue - cost;
    const setupCost = r.setupCost ?? 0;
    const objectsCount = r.objectsCount ?? 0;
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      active: r.active,
      salesperson: r.salespersonId
        ? {
            id: r.salespersonId,
            firstName: r.salespersonFirstName,
            lastName: r.salespersonLastName,
          }
        : null,
      objectsCount,
      activeObjectsCount: r.activeObjectsCount ?? 0,
      objectsWithCost: r.objectsWithCost ?? 0,
      revenue,
      cost,
      profit,
      margin: marginOf(revenue, profit, r.objectsWithCost ?? 0),
      setupCost,
      payback: paybackOf(setupCost, profit),
      arpo: objectsCount > 0 ? revenue / objectsCount : null,
    };
  });

  return c.json({
    success: true,
    data: {
      scope,
      generatedAt: new Date().toISOString(),
      totals,
      rows: data,
      contractorsWithoutObjects: withoutRows[0]?.count ?? 0,
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
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));

  const totals = await loadTotals(scope);

  // Ten sam zestaw złączeń, co lista obiektów (src/routes/objects.ts:190-223),
  // tylko bez stronicowania — analityka pokazuje cały zakres naraz.
  const rows = await db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      city: schema.objects.city,
      type: schema.objects.type,
      status: schema.objects.status,
      contractorId: schema.objects.contractorId,
      contractorName: schema.contractors.name,
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
    .where(SCOPE_WHERE[scope])
    .orderBy(
      desc(sql`coalesce(objects.monthly_value, 0) - coalesce(objects.monthly_cost, 0)`),
      asc(sql`lower(objects.name)`)
    )
    .limit(limit);

  const data = rows.map((r) => {
    const revenue = r.monthlyValue ?? 0;
    const cost = r.monthlyCost ?? 0;
    const profit = revenue - cost;
    const setupCost = r.objectSetupCost ?? 0;
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      type: r.type,
      status: r.status,
      contractorId: r.contractorId,
      contractorName: r.contractorName,
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
      revenue,
      cost,
      profit,
      margin: marginOf(revenue, profit, r.monthlyCost !== null ? 1 : 0),
      setupCost,
      payback: paybackOf(setupCost, profit),
      // Klucz całej opowieści o pokryciu: koszt 0 zł to informacja, NULL to jej brak.
      hasCost: r.monthlyCost !== null,
    };
  });

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
      generatedAt: new Date().toISOString(),
      totals,
      rows: data,
      byType,
      byStatus,
      byCompany,
      marginBuckets,
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /handlowcy — rentowność portfela per opiekun                    */
/* ------------------------------------------------------------------ */
app.get("/handlowcy", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  const limit = parseLimit(c.req.query("limit"));

  const totals = await loadTotals(scope);
  const scopePredicate = SCOPE_SQL[scope];

  /**
   * Budujemy OD HANDLOWCÓW, nie od obiektów pogrupowanych po opiekunie: handlowiec
   * z pustym portfelem dalej kosztuje firmę i musi się pokazać w zestawieniu
   * (grupowanie po obiektach po prostu by go pominęło).
   *
   * Każdy agregat to osobne podzapytanie skorelowane — ten sam idiom, co lista
   * handlowców (src/routes/salespeople.ts:62-70), z dosłownymi nazwami tabel.
   */
  const rows = await db
    .select({
      salesperson: schema.salespeople,
      // Kontrahenci liczeni po bezpośrednim FK — „ilu klientów prowadzi", tak jak dziś.
      contractorsCount: sql<number>`(
        select count(*) from contractors where contractors.salesperson_id = salespeople.id
      )`,
      objectsCount: sql<number>`(
        select count(*) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
      revenue: sql<number>`(
        select coalesce(sum(objects.monthly_value), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
      objectsCost: sql<number>`(
        select coalesce(sum(objects.monthly_cost), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
      setupCost: sql<number>`(
        select coalesce(sum(objects.setup_cost), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
      objectsWithCost: sql<number>`(
        select coalesce(sum(case when objects.monthly_cost is not null then 1 else 0 end), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
      unprofitableObjects: sql<number>`(
        select coalesce(sum(case when coalesce(objects.monthly_value, 0) - coalesce(objects.monthly_cost, 0) < 0 then 1 else 0 end), 0) from objects
        join contractors on contractors.id = objects.contractor_id
        where ${EFFECTIVE_SALESPERSON} = salespeople.id and ${scopePredicate}
      )`,
    })
    .from(schema.salespeople)
    .orderBy(asc(sql`lower(salespeople.last_name)`), asc(schema.salespeople.firstName));

  /**
   * Portfel bez opiekuna — obiekty, dla których ani obiekt, ani jego kontrahent nie
   * mają handlowca. To przychód, którym nikt nie zarządza; wraca OSOBNYM polem, żeby
   * nigdy nie doklejał się po cichu do wyniku którejś z osób.
   */
  const unassignedRows = await db
    .select({
      objectsCount: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(objects.monthly_value), 0)`,
      objectsCost: sql<number>`coalesce(sum(objects.monthly_cost), 0)`,
      setupCost: sql<number>`coalesce(sum(objects.setup_cost), 0)`,
      objectsWithCost: sql<number>`coalesce(sum(case when objects.monthly_cost is not null then 1 else 0 end), 0)`,
      unprofitableObjects: sql<number>`coalesce(sum(case when coalesce(objects.monthly_value, 0) - coalesce(objects.monthly_cost, 0) < 0 then 1 else 0 end), 0)`,
    })
    .from(schema.objects)
    .innerJoin(schema.contractors, eq(schema.contractors.id, schema.objects.contractorId))
    .where(sql`${EFFECTIVE_SALESPERSON} is null and ${scopePredicate}`);

  const u = unassignedRows[0];
  const unassignedRevenue = u?.revenue ?? 0;
  const unassignedCost = u?.objectsCost ?? 0;
  const unassignedProfit = unassignedRevenue - unassignedCost;
  const unassigned = {
    objectsCount: u?.objectsCount ?? 0,
    objectsWithCost: u?.objectsWithCost ?? 0,
    unprofitableObjects: u?.unprofitableObjects ?? 0,
    revenue: unassignedRevenue,
    objectsCost: unassignedCost,
    setupCost: u?.setupCost ?? 0,
    profit: unassignedProfit,
    margin: marginOf(unassignedRevenue, unassignedProfit, u?.objectsWithCost ?? 0),
  };

  /**
   * Prowizja i koszt własny doliczane w JS, nie w SQL — dzięki temu cały wzór na
   * rentowność handlowca stoi w jednym czytelnym miejscu:
   *   contribution = marża portfela PRZED kosztem handlowca,
   *   profit       = to, co zostaje firmie po jego pensji i prowizji.
   */
  const computed = rows.map((r) => {
    const s = r.salesperson;
    const revenue = r.revenue ?? 0;
    const objectsCost = r.objectsCost ?? 0;
    const ownCost = s.monthlyCost ?? 0;
    const commission = (revenue * (s.commissionRate ?? 0)) / 100;
    const contribution = revenue - objectsCost;
    const profit = contribution - ownCost - commission;
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      region: s.region,
      active: s.active,
      contractorsCount: r.contractorsCount ?? 0,
      objectsCount: r.objectsCount ?? 0,
      objectsWithCost: r.objectsWithCost ?? 0,
      unprofitableObjects: r.unprofitableObjects ?? 0,
      revenue,
      objectsCost,
      setupCost: r.setupCost ?? 0,
      ownCost,
      commissionRate: s.commissionRate,
      commission,
      contribution,
      profit,
      // Znany koszt to albo koszt któregoś obiektu, albo koszt własny handlowca —
      // wystarczy jedno, żeby zysk portfela przestał być samym przychodem.
      margin: marginOf(revenue, profit, (r.objectsWithCost ?? 0) + (s.monthlyCost !== null ? 1 : 0)),
      // Ile złotówek przychodu przypada na złotówkę wydaną na handlowca.
      roi: ownCost + commission > 0 ? revenue / (ownCost + commission) : null,
    };
  });

  // Sumy po WSZYSTKICH handlowcach — liczone przed przycięciem listy limitem,
  // z tego samego powodu, co `totals`: obcięty ranking nie może zaniżać kosztów.
  // Archiwalni (`active = false`) też się liczą: archiwum to znacznik widoczności,
  // a nie informacja, że pensja przestała obciążać firmę — po zwolnieniu handlowca
  // wyczyść mu `monthly_cost`.
  const salespeopleCost = computed.reduce((acc, r) => acc + r.ownCost, 0);
  const commission = computed.reduce((acc, r) => acc + r.commission, 0);
  const salespeopleWithCost = rows.filter((r) => r.salesperson.monthlyCost !== null).length;

  const data = [...computed].sort((a, b) => b.profit - a.profit).slice(0, limit);

  return c.json({
    success: true,
    data: {
      scope,
      generatedAt: new Date().toISOString(),
      totals: {
        ...totals,
        salespeopleCost,
        commission,
        // Zysk firmy po odjęciu kosztu pionu handlowego od marży na obiektach.
        netProfit: totals.profit - salespeopleCost - commission,
        unassignedRevenue,
        salespeopleWithCost,
      },
      rows: data,
      unassigned,
    },
  });
});

export default app;
