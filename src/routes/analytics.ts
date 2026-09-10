import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { ObjectService, ObjectServiceKind } from "../types/index.js";
import {
  LEAD_OPEN_STAGES,
  LEAD_STAGES,
  type LeadLostReason,
  type LeadStage,
} from "../db/schema.js";
import { nextActivityByLead, rottingOf } from "../lib/sales-leads.js";
import {
  ENDING_SOON_DEFAULT_DAYS,
  flagsFromServicesInRange,
  isEndingSoon,
  monthBounds,
  todayIso,
} from "../lib/object-services.js";
import {
  computeEmployeeMonthlyCost,
  computeObjectPersonnelCost,
  parseCostWindow,
  serviceUnits,
  type CmaAllocationInfo,
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
 *   revenue       = coalesce(monthly_zdw,0) + coalesce(monthly_ofi,0) + coalesce(monthly_rental,0)
 *                                                       — abonament ZDW + abonament OFI + dzierżawa sprzętu
 *   personnelCost = personnelDirectCost + personnelCmaCost — koszt osobowy z Kadr
 *   personnelDirectCost = wypłaty × godziny NA TYM obiekcie (ochrona fizyczna)
 *   personnelCmaCost    = udział w koszcie centrum monitorowania, dzielonym po
 *                         dozorowanych jednostkach (SSWiN 1, wideorecepcja 1, kamera 1/szt.)
 *   serviceUnits  = jednostki obiektu, czyli jego waga w podziale CMA
 *   otherCost     = coalesce(monthly_cost, 0)           — monitoring, sprzęt, abonamenty
 *   cost          = personnelCost + otherCost           — KOSZT CAŁKOWITY
 *   profit        = revenue - cost
 *   hasCost       = monthly_cost IS NOT NULL || personnelDirectCost > 0
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
 * Przekrój usługowy — DRUGI, niezależny od zakresu filtr całej analityki.
 *
 *   zdv = zdalny dozór wizyjny: kamery, SSWiN, wideorecepcja (obsługa w CMA)
 *   ofi = ochrona fizyczna: ludzie stojący na obiekcie
 *   all = obie linie razem, czyli to samo, co przed wprowadzeniem parametru
 *
 * ZBIÓR OBIEKTÓW NIE JEST ROZŁĄCZNY, ALE PRZYCHÓD JUŻ TAK. Obiekt z OFI I
 * kamerami POLICZY SIĘ w obu przekrojach (suma `objects` przekracza liczbę
 * obiektów — tak samo jak w przekroju po usługach, `bucketizeServices`), ale
 * wchodzi tam TYLKO SWOJĄ CZĘŚCIĄ PRZYCHODU: abonamentem ZDW (plus dzierżawą)
 * do „zdv" i abonamentem OFI do „ofi". Dzięki temu przychód „zdv" plus „ofi"
 * jest DOKŁADNIE równy „all".
 *
 * Do września 2026 kartoteka trzymała jeden abonament na obiekt i nie było czego
 * dzielić — mieszany obiekt wchodził całą kwotą do obu przekrojów, przez co
 * „zdv" + „ofi" wychodziło więcej niż „all". Rozbicie (migracja 0082,
 * src/lib/abonament-split.ts) daje ten klucz podziału wprost z danych, zamiast
 * zmyślać proporcję po jednostkach czy godzinach.
 */
export type AnalyticsService = "zdv" | "ofi" | "all";

/** Domyślnie „all" — i nieznana wartość też, tak samo jak w `parseScope`. */
function parseService(raw: string | undefined): AnalyticsService {
  return raw === "zdv" ? "zdv" : raw === "ofi" ? "ofi" : "all";
}

/** Ten sam warunek dosłownie — do podzapytań skorelowanych (patrz `SCOPE_SQL`). */
const SERVICE_SQL: Record<AnalyticsService, SQL> = {
  zdv: sql`(objects.has_cameras = 1 or objects.has_sswin = 1 or objects.has_videoreception = 1)`,
  ofi: sql`objects.has_ofi = 1`,
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
  /**
   * Miesiące z wierszami płacowymi, ale bez wprowadzonych kwot — czekają na
   * księgową i są POMIJANE w średniej. UI ma je wymienić z nazwy: „średnia z 3
   * (dane za 2)" bez wskazania miesiąca wygląda na awarię, a jest brakiem
   * rozliczenia konkretnego okresu, który ktoś może domknąć.
   */
  skippedMonths: Array<{ year: number; month: number }>;
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
  /**
   * Audyt podziału kosztu centrum monitorowania: ile wynosi pula, przez ile
   * jednostek się dzieli i ile obiektów nie ma podanej liczby kamer (a więc dostaje
   * ZANIŻONY udział). Front robi z tego przypis i listę braków do uzupełnienia.
   */
  cma: CmaAllocationInfo;
}

function personnelInfo(costWindow: CostWindow, p: PersonnelCostResult): PersonnelInfo {
  return {
    costWindow,
    monthsUsed: p.monthsUsed,
    months: p.months,
    skippedMonths: p.skippedMonths,
    mappedObjects: p.mappedObjects,
    hrObjectsTotal: p.hrObjectsTotal,
    unmappedHoursShare: p.unmappedHoursShare,
    costBasis: p.costBasis,
    employer: p.employer,
    cma: p.cma,
  };
}

export interface AnalyticsTotals {
  objects: number;
  objectsWithCost: number;
  coverage: number;
  revenue: number;
  cost: number;
  personnelCost: number;
  /** Składnik `personnelCost`: alokacja wprost z godzin na obiektach. */
  personnelDirectCost: number;
  /** Składnik `personnelCost`: udziały w koszcie centrum monitorowania. */
  personnelCmaCost: number;
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

/** Usługi obiektu w postaci, w jakiej wychodzą do UI — bez `type`, który odchodzi. */
export interface ObjectServicesInfo {
  sswin: boolean;
  cameras: boolean;
  /** NULL przy `cameras` = usługa jest, ale nikt nie policzył ilu kamer (≠ zero). */
  cameraCount: number | null;
  ofi: boolean;
  videoreception: boolean;
}

interface ObjectRow {
  id: number;
  name: string;
  city: string | null;
  /** @deprecated Zostaje do czasu usunięcia kolumny; przekroje idą po `services`. */
  type: string;
  status: string;
  services: ObjectServicesInfo;
  /**
   * OKRESY usług obiektu — pełna lista, także zakończone. Z nich liczy się seria
   * czasowa (`timeline`) i predykat „kończy się wkrótce"; `services` wyżej to
   * dalej stan NA DZIŚ. Pusta tablica = obiekt bez ani jednego wiersza (D3:
   * skrypty, seedy, dane sprzed migracji 0084) — o takim nie wiemy nic poza dziś.
   */
  servicePeriods: ObjectService[];
  /** Przewidywane zakończenie obsługi całego obiektu (YYYY-MM-DD); null = bezterminowo. */
  expectedEndDate: string | null;
  /** Waga obiektu w podziale kosztu CMA (SSWiN 1 + wideorecepcja 1 + kamery po 1). */
  serviceUnits: number;
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
  /**
   * Składniki przychodu — pole wewnętrzne, poza JSON-em. Potrzebne, bo przekrój
   * usługowy przypisuje przychód do LINII: ZDW + dzierżawa idą do „zdv",
   * abonament OFI do „ofi". Bez rozbicia mieszany obiekt wchodził całą kwotą do
   * obu przekrojów i „zdv" + „ofi" dawało więcej niż „all".
   */
  revenueZdw: number;
  revenueOfi: number;
  personnelCost: number;
  personnelDirectCost: number;
  personnelCmaCost: number;
  otherCost: number;
  cost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  payback: number | null;
  hasCost: boolean;
  /**
   * Czy `monthly_cost` jest WPISANY (a nie tylko wyliczony na zero) — pole
   * wewnętrzne, poza JSON-em. Potrzebne przy przekroju usługowym: `otherCost`
   * gubi różnicę NULL vs 0, a bez niej nie da się policzyć `hasCost` na nowo.
   */
  otherCostKnown: boolean;
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
      hasSswin: schema.objects.hasSswin,
      hasCameras: schema.objects.hasCameras,
      cameraCount: schema.objects.cameraCount,
      hasOfi: schema.objects.hasOfi,
      hasVideoreception: schema.objects.hasVideoreception,
      expectedEndDate: schema.objects.expectedEndDate,
      contractorId: schema.objects.contractorId,
      contractorName: schema.contractors.name,
      contractorCity: schema.contractors.city,
      contractorActive: schema.contractors.active,
      contractorSalespersonId: schema.contractors.salespersonId,
      companyName: schema.companies.name,
      monthlyZdw: schema.objects.monthlyZdw,
      monthlyOfi: schema.objects.monthlyOfi,
      monthlyRental: schema.objects.monthlyRental,
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

  /*
   * Okresy usług — JEDNO dodatkowe zapytanie na cały zakres (`inArray` po id
   * wierszy wyżej), tak samo jak robi to lista obiektów. Bez nich seria czasowa
   * i „kończące się" nie mają z czego powstać, a doczytywanie ich per wiersz
   * dałoby kilkaset zapytań na jedno wejście w zakładkę.
   */
  const periodsByObject = new Map<number, ObjectService[]>();
  if (rows.length > 0) {
    const periodRows = await db
      .select()
      .from(schema.objectServices)
      .where(inArray(schema.objectServices.objectId, rows.map((r) => r.id)))
      .orderBy(asc(schema.objectServices.service), asc(schema.objectServices.startDate));
    for (const p of periodRows) {
      const list = periodsByObject.get(p.objectId);
      if (list) list.push(p);
      else periodsByObject.set(p.objectId, [p]);
    }
  }

  return rows.map((r) => {
    // Przychód miesięczny to OBA abonamenty ORAZ dzierżawa sprzętu — klient
    // płaci wszystkie pozycje co miesiąc. Do sierpnia 2026 liczył się sam
    // abonament, przez co obiekty ze sprzętem w najmie wyglądały na dużo mniej
    // rentowne; od września 2026 abonament jest jeszcze rozbity na linie.
    //
    // Dzierżawa doliczana jest do linii ZDW, bo dzierżawiony sprzęt to sprzęt
    // monitoringu (rejestratory, kamery), a nie wyposażenie wartownika.
    const revenueZdw = (r.monthlyZdw ?? 0) + (r.monthlyRental ?? 0);
    const revenueOfi = r.monthlyOfi ?? 0;
    const revenue = revenueZdw + revenueOfi;
    // Koszt osobowy z Kadr i koszt pozostały z kartoteki SUMUJĄ SIĘ.
    const personnelCost = personnel.byObjectId.get(r.id) ?? 0;
    // ...a sam koszt osobowy składa się z dwóch ścieżek, które też się SUMUJĄ:
    // godzin przepracowanych na tym obiekcie i udziału w koszcie centrum
    // monitorowania. Obiekt z OFI i kamerami dostaje jedno i drugie.
    const personnelDirectCost = personnel.directByObjectId.get(r.id) ?? 0;
    const personnelCmaCost = personnel.cmaShareByObjectId.get(r.id) ?? 0;
    const otherCost = r.monthlyCost ?? 0;
    const cost = personnelCost + otherCost;
    const profit = revenue - cost;
    const setupCost = r.objectSetupCost ?? 0;
    // Koszt 0 zł to informacja, NULL to jej brak — ale gdy z Kadr spłynęła choćby
    // złotówka, koszt tego obiektu ZNAMY, nawet jeśli nikt nie wypełnił `monthly_cost`.
    /*
     * „Znamy koszt tego obiektu" to koszt WPISANY albo godziny ludzi pracujących
     * NA NIM — nie udział w puli centrum monitorowania.
     *
     * Udział CMA dostaje automatycznie każdy aktywny obiekt z kamerami albo
     * SSWiN-em, więc warunek `personnelCost > 0` zapalał `hasCost` praktycznie
     * wszędzie i unieważniał regułę „NULL ≠ 0", o którą walczy nagłówek tego
     * pliku. Na produkcji 15 obiektów bez ŻADNEJ wiedzy o koszcie pokazywało
     * przez to marże 98,6% / 93,9% / 88,7%, a pokrycie raportowało 90% zamiast
     * realnych 77%. To jest dokładnie „najgorsze możliwe kłamstwo tego modułu",
     * tylko wprowadzone okrężną drogą.
     *
     * Udział CMA nadal WCHODZI do kosztu i zysku — jest realnym wydatkiem.
     * Nie czyni jednak kosztu obiektu ZNANYM, więc nie zapala marży.
     */
    const hasCost = r.monthlyCost !== null || personnelDirectCost > 0;
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      type: r.type,
      status: r.status,
      services: {
        sswin: r.hasSswin,
        cameras: r.hasCameras,
        cameraCount: r.cameraCount,
        ofi: r.hasOfi,
        videoreception: r.hasVideoreception,
      },
      servicePeriods: periodsByObject.get(r.id) ?? [],
      expectedEndDate: r.expectedEndDate,
      // Jedna definicja wagi na całą aplikację — ta sama funkcja, którą podział
      // puli liczy w src/lib/object-personnel-cost.ts. Front pokazuje tę liczbę
      // obok udziału CMA, żeby było widać, DLACZEGO obiekt dostał tyle, ile dostał.
      serviceUnits: serviceUnits({
        hasSswin: r.hasSswin,
        hasCameras: r.hasCameras,
        cameraCount: r.cameraCount,
        hasVideoreception: r.hasVideoreception,
      }),
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
      revenueZdw,
      revenueOfi,
      personnelCost,
      personnelDirectCost,
      personnelCmaCost,
      otherCost,
      cost,
      profit,
      margin: marginOf(revenue, profit, hasCost ? 1 : 0),
      setupCost,
      payback: paybackOf(setupCost, profit),
      hasCost,
      otherCostKnown: r.monthlyCost !== null,
    };
  });
}

/** Czy obiekt należy do danej linii usługowej. */
function matchesService(s: ObjectServicesInfo, service: AnalyticsService): boolean {
  if (service === "all") return true;
  if (service === "ofi") return s.ofi;
  return s.cameras || s.sswin || s.videoreception;
}

/**
 * Zawężenie całej analityki do jednej linii usługowej — filtr PLUS przeliczenie
 * kosztu osobowego, bo w przekroju liczy się tylko ta jego część, która do linii
 * naprawdę należy:
 *
 *   ofi → koszt godzin przepracowanych NA TYM obiekcie (`personnelDirectCost`);
 *         udział w puli centrum monitorowania jest kosztem dozoru, nie warty,
 *   zdv → udział w puli CMA (`personnelCmaCost`); pensje wartowników z tego
 *         samego obiektu nie mają z dozorem nic wspólnego,
 *   all → obie ścieżki razem, czyli dzisiejsza definicja bez zmian.
 *
 * PRZYCHÓD idzie za linią: „ofi" bierze `revenueOfi` (abonament za ochronę
 * fizyczną), „zdv" bierze `revenueZdw` (abonament za dozór PLUS dzierżawa
 * sprzętu monitoringu). Dzięki temu suma przychodu obu przekrojów równa się
 * przekrojowi „all" i nikt nie liczy mieszanego obiektu dwa razy.
 *
 * KOSZT POZOSTAŁY (`monthly_cost`) zostaje w CAŁOŚCI po obu stronach — kartoteka
 * trzyma jedną kwotę kosztu na obiekt, bez rozbicia na linie. Zmyślony klucz
 * podziału (po jednostkach? po godzinach?) byłby liczbą, której nikt nie umie
 * obronić przed zarządem.
 *
 * `hasCost` liczy się na nowo z tych samych składników co zawsze (wpisany koszt
 * albo godziny na obiekcie), więc w przekroju „zdv" mieszany obiekt bez wpisanego
 * `monthly_cost` znów ma koszt NIEZNANY — jego godziny należą do drugiej linii.
 */
function applyServiceView(rows: ObjectRow[], service: AnalyticsService): ObjectRow[] {
  if (service === "all") return rows;
  const out: ObjectRow[] = [];
  for (const r of rows) {
    if (!matchesService(r.services, service)) continue;
    const personnelDirectCost = service === "ofi" ? r.personnelDirectCost : 0;
    const personnelCmaCost = service === "zdv" ? r.personnelCmaCost : 0;
    const personnelCost = personnelDirectCost + personnelCmaCost;
    const cost = personnelCost + r.otherCost;
    const revenue = service === "ofi" ? r.revenueOfi : r.revenueZdw;
    const profit = revenue - cost;
    const hasCost = r.otherCostKnown || personnelDirectCost > 0;
    out.push({
      ...r,
      revenue,
      personnelCost,
      personnelDirectCost,
      personnelCmaCost,
      cost,
      profit,
      margin: marginOf(revenue, profit, hasCost ? 1 : 0),
      payback: paybackOf(r.setupCost, profit),
      hasCost,
    });
  }
  return out;
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
  let personnelDirectCost = 0;
  let personnelCmaCost = 0;
  let otherCost = 0;
  let setupCost = 0;
  let objectsWithCost = 0;
  let unprofitable = 0;
  let noRevenue = 0;
  for (const r of rows) {
    revenue += r.revenue;
    personnelCost += r.personnelCost;
    personnelDirectCost += r.personnelDirectCost;
    personnelCmaCost += r.personnelCmaCost;
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
    // Uwaga: suma udziałów CMA w zakresie NIE równa się całej puli — obiekt spoza
    // zakresu (np. archiwalny w widoku „bieżące") swojego udziału tu nie wnosi,
    // a obiekt „pending" nie ma go wcale. To celowe: mianownik jest stały, więc
    // pula rozkłada się na dozorowane obiekty niezależnie od tego, co widać.
    personnelDirectCost,
    personnelCmaCost,
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
  const service = parseService(c.req.query("service"));
  const limit = parseLimit(c.req.query("limit"));
  const costWindow = parseCostWindow(c.req.query("costWindow"));
  const personnel = computeObjectPersonnelCost(costWindow);
  // Filtr usługowy działa PRZED jakąkolwiek agregacją: kontrahenci, handlowcy,
  // przekroje i podsumowania mają liczyć się z tego samego, zawężonego zbioru
  // obiektów — inaczej kafelki mówiłyby o firmie, a tabela o jednej linii.
  const rows = applyServiceView(await loadObjectRows(scope, personnel), service);
  return {
    scope,
    service,
    limit,
    costWindow,
    personnel,
    rows,
    totals: loadTotals(rows, costWindow, personnel),
  };
}

/* ------------------------------------------------------------------ */
/* GET /kontrahenci — ranking klientów wg zysku                        */
/* ------------------------------------------------------------------ */
app.get("/kontrahenci", async (c) => {
  const { scope, service, limit, costWindow, personnel, rows, totals } = await baseline(c);

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
    personnelDirectCost: number;
    personnelCmaCost: number;
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
        personnelDirectCost: 0,
        personnelCmaCost: 0,
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
    a.personnelDirectCost += r.personnelDirectCost;
    a.personnelCmaCost += r.personnelCmaCost;
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
        // Rozbicie kosztu osobowego klienta na obie ścieżki: ile płacimy ludziom
        // stojącym na jego obiektach, a ile kosztuje nas dozorowanie go w centrum.
        personnelDirectCost: a.personnelDirectCost,
        personnelCmaCost: a.personnelCmaCost,
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

  // Ilu klientów wypadło z zestawienia, bo nie ma obiektów w tym zakresie ANI
  // w tym przekroju usługowym — liczymy osobno i bez limitu, żeby licznik nie
  // zależał od przycięcia rankingu.
  const withoutRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors)
    .where(
      sql`not exists (
        select 1 from objects
        where objects.contractor_id = contractors.id
          and ${SCOPE_SQL[scope]} and ${SERVICE_SQL[service]}
      )`
    );

  return c.json({
    success: true,
    data: {
      scope,
      service,
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

// Stała kolejność przekroju po statusie — naturalna kolejność procesu, a nie
// alfabet po wartościach z bazy (tak samo jak przy sortowaniu listy obiektów,
// src/routes/objects.ts:35-36).
const STATUS_ORDER = ["pending", "in_progress", "active", "inactive"];

/**
 * Przekrój po USŁUGACH — zastąpił dawny przekrój po `objects.type`, bo jeden wybór
 * („monitoring" albo „physical") nie opisywał obiektu, na którym jest i alarm,
 * i kamery, i warta.
 *
 * UWAGA: TO NIE JEST PODZIAŁ ROZŁĄCZNY. Obiekt z SSWiN-em i kamerami wpada do
 * DWÓCH kubełków, więc suma `count` przekracza liczbę obiektów, a suma `revenue`
 * przekracza przychód firmy. Tak ma być — pytanie brzmi „ile przychodu dotyka
 * usługi X", a nie „jak podzielić firmę na rozłączne części". Nie „naprawiaj"
 * tych sum: każda próba doprowadzenia ich do całości wymaga wymyślenia reguły,
 * do którego jednego kubełka wrzucić obiekt z trzema usługami — czyli powrotu
 * do `type`, od którego właśnie odchodzimy.
 */
const SERVICE_ORDER = ["ofi", "kamery", "sswin", "wideorecepcja"] as const;
type ServiceKey = (typeof SERVICE_ORDER)[number];

const SERVICE_LABELS: Record<ServiceKey, string> = {
  ofi: "Ochrona fizyczna",
  kamery: "Kamery",
  sswin: "SSWiN",
  wideorecepcja: "Wideorecepcja",
};

function servicesOf(s: ObjectServicesInfo): ServiceKey[] {
  const out: ServiceKey[] = [];
  if (s.ofi) out.push("ofi");
  if (s.cameras) out.push("kamery");
  if (s.sswin) out.push("sswin");
  if (s.videoreception) out.push("wideorecepcja");
  return out;
}

/**
 * Kubełkowanie po usługach — wiersz trafia do KAŻDEGO kubełka swojej usługi.
 * Kubełki puste zostają w odpowiedzi (count 0), żeby wykres nie przeskakiwał przy
 * zmianie zakresu; obiekt bez ani jednej usługi nie pojawia się nigdzie.
 */
function bucketizeServices<T extends BucketSource & { services: ObjectServicesInfo }>(
  rows: T[],
): AnalyticsBucket[] {
  const out = new Map<ServiceKey, AnalyticsBucket>(
    SERVICE_ORDER.map((key) => [
      key,
      { key, label: SERVICE_LABELS[key], count: 0, revenue: 0, cost: 0, profit: 0 },
    ]),
  );
  for (const row of rows) {
    for (const key of servicesOf(row.services)) {
      const b = out.get(key)!;
      b.count += 1;
      b.revenue += row.revenue;
      b.cost += row.cost;
      b.profit += row.profit;
    }
  }
  return [...out.values()];
}

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

/* --- „Kończące się" i seria czasowa usług -------------------------------- */

/**
 * Horyzont zestawienia „kończy się wkrótce" (`?horizonDays=`). Domyślnie te same
 * 90 dni, co filtr listy obiektów — kafelek linkuje do `/objects?endingIn=90`
 * i obie liczby muszą znaczyć to samo. Zakres 1–730 dni: zero dni nie jest
 * pytaniem, a dwa lata to górna granica, przy której „wkrótce" jeszcze cokolwiek
 * znaczy (i zabezpieczenie przed `?horizonDays=999999`).
 */
function parseHorizonDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return ENDING_SOON_DEFAULT_DAYS;
  return Math.min(Math.max(Math.floor(n), 1), 730);
}

/** Ile miesięcy wstecz pokazuje seria czasowa — rok włącznie z bieżącym. */
const TIMELINE_MONTHS = 12;

export interface AnalyticsTimelinePoint {
  /** YYYY-MM */
  month: string;
  activeObjects: number;
  /** Jednostki usług aktywnych w miesiącu; kamery = suma sztuk, reszta po obiekcie. */
  activeUnits: Record<ObjectServiceKind, number>;
  /**
   * Okresy usług ROZPOCZĘTE w tym miesiącu — wyłącznie te z datą, którą znamy.
   * Okresy z `startEstimated` są policzone osobno, w `startedEstimated`.
   */
  started: number;
  /**
   * Ile okresów o dacie startu ZGADNIĘTEJ (backfill 0084, fallback importu)
   * wypadło w tym miesiącu i zostało POMINIĘTYCH w `started`.
   *
   * Bez tego pola wykres milczałby o dziurze: użytkownik widzi „0 rozpoczętych"
   * w miesiącu, w którym kartoteka urosła o 147 usług, i nie ma jak się
   * dowiedzieć, że to nie zapaść sprzedaży, tylko dzień wgrania danych.
   * Front dopisuje tę liczbę w opisie punktu („+147 z datą szacowaną").
   */
  startedEstimated: number;
  ended: number;
  revenue: number;
}

/**
 * SERIA CZASOWA USŁUG — 12 ostatnich miesięcy WŁĄCZNIE z bieżącym.
 *
 * Liczona z OKRESÓW (`object_services`), ale kwotami BIEŻĄCYMI: kartoteka trzyma
 * jeden komplet stawek na obiekt, bez historii cen. `revenue` odpowiada więc na
 * pytanie „ile dzisiejszymi stawkami warte były obiekty wtedy dozorowane", a NIE
 * „ile wtedy zafakturowano" — front ma to napisać przy wykresie, bo to dwie
 * różne liczby i tylko jedną z nich umiemy podać.
 *
 * Obiekty BEZ ani jednego wiersza okresów (D3) wchodzą jako aktywne w KAŻDYM
 * miesiącu, z dzisiejszymi flagami. Alternatywa — pominąć je — narysowałaby
 * wykres, na którym firma nagle traci połowę kartoteki, bo skrypty i dane sprzed
 * migracji 0084 nie mają dat. Ich okresów nie ma, więc do `started`/`ended` nie
 * wnoszą nic.
 *
 * Wiersze przychodzą PO filtrze przekroju usługowego (`applyServiceView`), więc
 * seria opisuje ten sam zbiór, co kafelki nad nią.
 */
function buildTimeline(rows: ObjectRow[], today: string): AnalyticsTimelinePoint[] {
  // Indeks miesiąca ciągłego (rok*12 + miesiąc) — arytmetyka bez pułapek przełomu
  // roku, tak samo jak w `fullMonths()` modułu kosztu osobowego.
  const lastIdx = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const out: AnalyticsTimelinePoint[] = [];
  for (let i = TIMELINE_MONTHS - 1; i >= 0; i--) {
    const idx = lastIdx - i;
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    const { from, to } = monthBounds(year, month);
    const activeUnits: Record<ObjectServiceKind, number> = {
      kamery: 0,
      sswin: 0,
      wideorecepcja: 0,
      ofi: 0,
    };
    let activeObjects = 0;
    let started = 0;
    let startedEstimated = 0;
    let ended = 0;
    let revenue = 0;

    for (const r of rows) {
      if (r.servicePeriods.length === 0) {
        activeObjects += 1;
        revenue += r.revenue;
        // Kamery bez policzonej liczby nie wnoszą sztuk (NULL ≠ 0), ale obiekt
        // nadal jest aktywny — tak samo, jak w mianowniku kosztu CMA.
        if (r.services.cameras) activeUnits.kamery += r.services.cameraCount ?? 0;
        if (r.services.sswin) activeUnits.sswin += 1;
        if (r.services.videoreception) activeUnits.wideorecepcja += 1;
        if (r.services.ofi) activeUnits.ofi += 1;
        continue;
      }
      for (const p of r.servicePeriods) {
        if (p.startDate >= from && p.startDate <= to) {
          // Data startu wzięta z daty założenia kartoteki (backfill 0084) albo
          // z dnia importu NIE JEST rozpoczęciem usługi — usługa istniała
          // wcześniej, tylko nikt nie zapisał od kiedy. Liczymy ją osobno,
          // żeby wykres nie pokazywał dnia wgrania danych jako rekordu sprzedaży.
          if (p.startEstimated) startedEstimated += 1;
          else started += 1;
        }
        if (p.endDate && p.endDate >= from && p.endDate <= to) ended += 1;
      }
      const flags = flagsFromServicesInRange(r.servicePeriods, from, to);
      if (!flags.hasCameras && !flags.hasSswin && !flags.hasVideoreception && !flags.hasOfi) {
        continue;
      }
      activeObjects += 1;
      revenue += r.revenue;
      if (flags.hasCameras) activeUnits.kamery += flags.cameraCount ?? 0;
      if (flags.hasSswin) activeUnits.sswin += 1;
      if (flags.hasVideoreception) activeUnits.wideorecepcja += 1;
      if (flags.hasOfi) activeUnits.ofi += 1;
    }

    out.push({
      month: `${year}-${String(month).padStart(2, "0")}`,
      activeObjects,
      activeUnits,
      started,
      startedEstimated,
      ended,
      revenue,
    });
  }
  return out;
}

app.get("/obiekty", async (c) => {
  const { scope, service, limit, costWindow, personnel, rows, totals } = await baseline(c);
  const today = todayIso();
  const horizonDays = parseHorizonDays(c.req.query("horizonDays"));

  /*
   * „Kończące się" liczymy po WSZYSTKICH wierszach zakresu, nie po przyciętym
   * limitem rankingu — tak samo, jak `totals` (patrz `loadTotals`). Predykat
   * to ten sam helper, którego w SQL-u używa filtr listy obiektów
   * (`?endingIn=`), więc kafelek i lista, do której linkuje, pokazują tę samą
   * liczbę. `revenue` jest przychodem BIEŻĄCEGO PRZEKROJU (`service`/`scope`):
   * w widoku „ofi" zagrożony jest tylko abonament za ochronę fizyczną.
   */
  let endingSoonCount = 0;
  let endingSoonRevenue = 0;
  for (const r of rows) {
    if (!isEndingSoon(r, r.servicePeriods, today, horizonDays)) continue;
    endingSoonCount += 1;
    endingSoonRevenue += r.revenue;
  }

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
      services: r.services,
      // Okresy jadą do UI w całości (także zakończone): druga linia w kolumnie
      // „Usługi" pokazuje daty, a karta obiektu — historię świadczenia.
      servicePeriods: r.servicePeriods,
      expectedEndDate: r.expectedEndDate,
      serviceUnits: r.serviceUnits,
      contractorId: r.contractorId,
      contractorName: r.contractorName,
      companyName: r.companyName,
      salesperson: r.salesperson,
      revenue: r.revenue,
      cost: r.cost,
      personnelCost: r.personnelCost,
      // Rozbicie kosztu osobowego — bez niego nie da się obronić kwoty na obiekcie
      // bez ani jednego pracownika („skąd 120 zł, skoro nikt tam nie stoi?").
      personnelDirectCost: r.personnelDirectCost,
      personnelCmaCost: r.personnelCmaCost,
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
  const byService = bucketizeServices(data);
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
      service,
      costWindow,
      generatedAt: new Date().toISOString(),
      totals,
      rows: data,
      // Przekrój po usługach NIE SUMUJE SIĘ do całości — patrz `bucketizeServices`.
      byService,
      byStatus,
      byCompany,
      marginBuckets,
      // Horyzont wraca w odpowiedzi, bo front pisze go w opisie kafelka („≤ 90 dni")
      // i przy braku parametru nie zna wartości domyślnej.
      endingSoon: { count: endingSoonCount, revenue: endingSoonRevenue, horizonDays },
      // Seria czasowa liczy się z PEŁNEGO zbioru wierszy, nie z przyciętego rankingu.
      timeline: buildTimeline(rows, today),
      personnel: personnelInfo(costWindow, personnel),
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /handlowcy — rentowność portfela per opiekun                    */
/* ------------------------------------------------------------------ */
app.get("/handlowcy", async (c) => {
  const { scope, service, limit, costWindow, personnel, rows, totals } = await baseline(c);

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
      service,
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


/* ------------------------------------------------------------------ */
/* GET /lejek — lejek sprzedaży (konwersja etapów, win rate, powody)    */
/* ------------------------------------------------------------------ */

/**
 * Lejek handlowy — DRUGI słownik pojęć w tym pliku, całkowicie niezależny od
 * rentowności portfela wyżej. Tamten liczy pieniądze z obiektów, ten opisuje
 * DROGĘ szansy przez etapy: ile ich wpadło, ile doszło do oferty, gdzie się
 * zatrzymały i dlaczego przepadły.
 *
 * KOHORTA. Wszystkie liczby (poza dwiema wyraźnie oznaczonymi) dotyczą jednego
 * zbioru: szans UTWORZONYCH w zakresie `from`–`to` i nieusuniętych
 * (`deleted_at IS NULL`). Nie mieszamy „utworzonych w tym roku" z „wygranymi
 * w tym roku": lejek, konwersja, wygrane i przegrane muszą opisywać ten sam
 * zbiór, inaczej konwersja etapów potrafi przekroczyć 100%. Wyjątki to
 * `rotting` i `openNow` — one z definicji są stanem NA TERAZ, nie historią
 * kohorty, i są tak opisane w odpowiedzi.
 *
 * ŹRÓDŁO HISTORII. Etap, w którym szansa jest DZIŚ, siedzi w `leads.stage`,
 * ale droga do niego wyłącznie w `activity_log` (`entity_type='lead'`,
 * `action='stage_changed'`, `field='stage'`, `old_value`→`new_value`). Stąd:
 *  • „dotarła do etapu" = etap początkowy albo któreś `new_value` w historii,
 *    więc cofnięcie szansy o etap NIE odbiera jej dotarcia (lejek liczy
 *    zasięg, nie stan),
 *  • czas w etapie = różnica znaczników kolejnych zmian; pierwszy etap liczy
 *    się od `leads.created_at`. Trwający pobyt (etap jeszcze nieopuszczony)
 *    NIE wchodzi do średniej — inaczej świeża szansa zaniżałaby każdy wynik.
 * Szansa bez ANI JEDNEGO wpisu w dzienniku (import, zapis sprzed modułu) ma
 * tylko etap bieżący; ile takich jest, mówi `coverage` — bez tego „średnio
 * 0 dni w etapie" wyglądałoby jak wynik, a znaczy „nie wiemy".
 *
 * Kształt JSON-a jest kontraktem z frontem (frontend/src/lib/api.ts:
 * `AnalyticsFunnel`) — front NIE liczy tu niczego poza formatowaniem:
 * ```
 * {
 *   from, to,                       // YYYY-MM-DD, zakres kohorty (to włącznie)
 *   salespersonId,                  // filtr: id | null (wszyscy) | "none" (bez opiekuna)
 *   generatedAt,
 *   leads,                          // liczność kohorty
 *   funnel: [{ stage, reached, current, conversion, avgDays, avgDaysSamples,
 *              monthly, setup }],   // etapy otwarte + „wygrany" na końcu
 *   won:  { count, monthly, setup, medianDaysToWin },
 *   lost: { count, byReason: [{ reason, count }] },   // reason: null = nie podano
 *   winRate,                        // 0..100 | null, won / (won + lost)
 *   bySalesperson: [{ salespersonId, name, leads, won, lost, open, winRate,
 *                     wonMonthly, wonSetup, avgDaysToWin }],
 *   rotting, openNow,               // STAN NA TERAZ, nie kohorta
 *   coverage: { leadsWithHistory, leads }
 * }
 * ```
 * Parametr `scope` (pasek Analityki) jest przyjmowany i IGNOROWANY: lejek nie ma
 * wymiaru „archiwum obiektów", a ciche filtrowanie po nim dawałoby liczby, których
 * nie da się wytłumaczyć.
 */

/** Etapy lejka: otwarte + „wygrany" jako domknięcie (przegrany ma własny blok). */
const FUNNEL_STAGES: LeadStage[] = [...LEAD_OPEN_STAGES, "wygrany"];

/** Domyślny zakres kohorty — rok wstecz, jak seria czasowa obiektów. */
const FUNNEL_MONTHS = 12;

export interface AnalyticsFunnelStage {
  stage: LeadStage;
  /** Ile szans kohorty KIEDYKOLWIEK dotarło do tego etapu. */
  reached: number;
  /** Ile stoi na nim DZIŚ. */
  current: number;
  /**
   * Dotarcia do NASTĘPNEGO etapu / dotarcia do tego, w % (null: ostatni etap
   * albo `reached = 0`). To proporcja lejka, nie ścieżka pojedynczej szansy:
   * etapy wolno przeskakiwać, więc wartość potrafi przekroczyć 100% i NIE
   * przycinamy jej — przycięta wyglądałaby na wynik, którego nie ma.
   */
  conversion: number | null;
  /** Średni czas ZAKOŃCZONEGO pobytu w etapie (dni); null = brak próbek. */
  avgDays: number | null;
  /** Ile pobytów weszło do średniej — bez tego „0 dni" nie da się odczytać. */
  avgDaysSamples: number;
  /** Wartość szans, które dotarły do etapu (MRR netto / wdrożenie netto). */
  monthly: number;
  setup: number;
}

export interface AnalyticsFunnelSalesperson {
  /** null = szanse bez opiekuna. */
  salespersonId: number | null;
  name: string;
  leads: number;
  won: number;
  lost: number;
  open: number;
  winRate: number | null;
  wonMonthly: number;
  wonSetup: number;
  avgDaysToWin: number | null;
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite) albo ISO → ms; null gdy nie da się odczytać. */
function stampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

const DAY_MS = 86_400_000;

/** Data YYYY-MM-DD z parametru; cokolwiek innego → `fallback`. */
function parseDateParam(raw: string | undefined, fallback: string): string {
  const t = (raw || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : fallback;
}

/** Dzień po `date` — górna granica porównania `created_at < …` (żeby `to` weszło w całości). */
function nextDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + DAY_MS).toISOString().slice(0, 10) : date;
}

/** Mediana z próbki (pusta → null). */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

app.get("/lejek", (c) => {
  try {
    const today = todayIso();
    const to = parseDateParam(c.req.query("to"), today);
    const defaultFrom = (() => {
      const d = new Date(`${to}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - FUNNEL_MONTHS);
      return d.toISOString().slice(0, 10);
    })();
    const from = parseDateParam(c.req.query("from"), defaultFrom);
    const toExclusive = nextDay(to);

    // Filtr opiekuna: konkretny handlowiec, „none" (szanse niczyje) albo brak filtra.
    const rawSp = (c.req.query("salespersonId") || "").trim();
    const spId = Number(rawSp);
    const salespersonFilter: number | "none" | null =
      rawSp === "none" ? "none" : Number.isInteger(spId) && spId > 0 ? spId : null;
    const spWhere: SQL[] =
      salespersonFilter === "none"
        ? [sql`leads.salesperson_id is null`]
        : salespersonFilter !== null
          ? [sql`leads.salesperson_id = ${salespersonFilter}`]
          : [];

    // ---- Kohorta -------------------------------------------------------
    const cohort = db
      .select({
        id: schema.leads.id,
        stage: schema.leads.stage,
        salespersonId: schema.leads.salespersonId,
        monthly: sql<number>`coalesce(leads.estimated_monthly, 0)`,
        setup: sql<number>`coalesce(leads.estimated_setup, 0)`,
        createdAt: schema.leads.createdAt,
        wonAt: schema.leads.wonAt,
        lostReason: schema.leads.lostReason,
      })
      .from(schema.leads)
      .where(
        and(
          isNull(schema.leads.deletedAt),
          sql`leads.created_at >= ${from}`,
          sql`leads.created_at < ${toExclusive}`,
          ...spWhere
        )
      )
      .all();

    // ---- Historia etapów ----------------------------------------------
    // Złączenie z `leads` zamiast `inArray(ids)`: kohorta bywa większa niż limit
    // parametrów SQLite, a warunek i tak jest ten sam.
    const changes = db
      .select({
        leadId: schema.activityLog.entityId,
        oldValue: schema.activityLog.oldValue,
        newValue: schema.activityLog.newValue,
        at: schema.activityLog.createdAt,
      })
      .from(schema.activityLog)
      .innerJoin(schema.leads, eq(schema.leads.id, schema.activityLog.entityId))
      .where(
        and(
          eq(schema.activityLog.entityType, "lead"),
          eq(schema.activityLog.action, "stage_changed"),
          eq(schema.activityLog.field, "stage"),
          isNull(schema.leads.deletedAt),
          sql`leads.created_at >= ${from}`,
          sql`leads.created_at < ${toExclusive}`,
          ...spWhere
        )
      )
      .orderBy(asc(schema.activityLog.entityId), asc(schema.activityLog.createdAt), asc(schema.activityLog.id))
      .all();

    const isStage = (v: string | null): v is LeadStage =>
      v != null && (LEAD_STAGES as readonly string[]).includes(v);

    const historyOf = new Map<number, { at: number; to: LeadStage; from: LeadStage | null }[]>();
    for (const r of changes) {
      if (!isStage(r.newValue)) continue;
      const at = stampMs(r.at);
      if (at === null) continue;
      const list = historyOf.get(r.leadId) ?? [];
      list.push({ at, to: r.newValue, from: isStage(r.oldValue) ? r.oldValue : null });
      historyOf.set(r.leadId, list);
    }

    // ---- Przebieg kohorty ---------------------------------------------
    const reachedCount = new Map<LeadStage, number>();
    const reachedMonthly = new Map<LeadStage, number>();
    const reachedSetup = new Map<LeadStage, number>();
    const currentCount = new Map<LeadStage, number>();
    const stageDays = new Map<LeadStage, { sum: number; n: number }>();
    const bump = (m: Map<LeadStage, number>, s: LeadStage, v = 1) => m.set(s, (m.get(s) ?? 0) + v);

    const daysToWin: number[] = [];
    const perSales = new Map<number | null, AnalyticsFunnelSalesperson & { _winDays: number[] }>();
    const lostByReason = new Map<LeadLostReason | null, number>();
    let leadsWithHistory = 0;
    let wonCount = 0;
    let wonMonthly = 0;
    let wonSetup = 0;
    let lostCount = 0;

    for (const lead of cohort) {
      const hist = historyOf.get(lead.id) ?? [];
      if (hist.length) leadsWithHistory++;
      // Etap początkowy: `old_value` pierwszej zmiany (a gdy go brak — wartość
      // domyślna kolumny), przy pustej historii po prostu etap bieżący.
      const initial: LeadStage = hist.length ? (hist[0].from ?? "nowy") : lead.stage;

      const reached = new Set<LeadStage>([initial, lead.stage]);
      for (const h of hist) reached.add(h.to);
      for (const s of reached) {
        bump(reachedCount, s);
        bump(reachedMonthly, s, lead.monthly);
        bump(reachedSetup, s, lead.setup);
      }
      bump(currentCount, lead.stage);

      // Zakończone pobyty w etapach — od `created_at` przez kolejne zmiany.
      let prevStage = initial;
      let prevAt = stampMs(lead.createdAt);
      for (const h of hist) {
        if (prevAt !== null && h.at >= prevAt) {
          const acc = stageDays.get(prevStage) ?? { sum: 0, n: 0 };
          acc.sum += (h.at - prevAt) / DAY_MS;
          acc.n += 1;
          stageDays.set(prevStage, acc);
        }
        prevStage = h.to;
        prevAt = h.at;
      }

      // Zamknięcia — liczone z etapu BIEŻĄCEGO, bo tylko on mówi, jak szansa stoi dziś.
      const createdMs = stampMs(lead.createdAt);
      const wonMs = stampMs(lead.wonAt) ?? [...hist].reverse().find((h) => h.to === "wygrany")?.at ?? null;
      const winDays =
        lead.stage === "wygrany" && createdMs !== null && wonMs !== null && wonMs >= createdMs
          ? (wonMs - createdMs) / DAY_MS
          : null;
      if (lead.stage === "wygrany") {
        wonCount++;
        wonMonthly += lead.monthly;
        wonSetup += lead.setup;
        if (winDays !== null) daysToWin.push(winDays);
      }
      if (lead.stage === "przegrany") {
        lostCount++;
        lostByReason.set(lead.lostReason ?? null, (lostByReason.get(lead.lostReason ?? null) ?? 0) + 1);
      }

      const key = lead.salespersonId;
      let sp = perSales.get(key);
      if (!sp) {
        sp = {
          salespersonId: key,
          name: "",
          leads: 0,
          won: 0,
          lost: 0,
          open: 0,
          winRate: null,
          wonMonthly: 0,
          wonSetup: 0,
          avgDaysToWin: null,
          _winDays: [],
        };
        perSales.set(key, sp);
      }
      sp.leads++;
      if (lead.stage === "wygrany") {
        sp.won++;
        sp.wonMonthly += lead.monthly;
        sp.wonSetup += lead.setup;
        if (winDays !== null) sp._winDays.push(winDays);
      } else if (lead.stage === "przegrany") {
        sp.lost++;
      } else {
        sp.open++;
      }
    }

    // ---- Lejek ---------------------------------------------------------
    const funnel: AnalyticsFunnelStage[] = FUNNEL_STAGES.map((stage, i) => {
      const reached = reachedCount.get(stage) ?? 0;
      const nextReached = i + 1 < FUNNEL_STAGES.length ? (reachedCount.get(FUNNEL_STAGES[i + 1]) ?? 0) : null;
      const days = stageDays.get(stage);
      return {
        stage,
        reached,
        current: currentCount.get(stage) ?? 0,
        conversion: nextReached === null || reached === 0 ? null : (nextReached / reached) * 100,
        avgDays: days && days.n > 0 ? days.sum / days.n : null,
        avgDaysSamples: days?.n ?? 0,
        monthly: reachedMonthly.get(stage) ?? 0,
        setup: reachedSetup.get(stage) ?? 0,
      };
    });

    // ---- Handlowcy -----------------------------------------------------
    const names = new Map<number, string>();
    for (const s of db
      .select({ id: schema.salespeople.id, firstName: schema.salespeople.firstName, lastName: schema.salespeople.lastName })
      .from(schema.salespeople)
      .all()) {
      names.set(s.id, `${s.firstName} ${s.lastName}`.trim());
    }
    const bySalesperson: AnalyticsFunnelSalesperson[] = [...perSales.values()]
      .map(({ _winDays, ...row }) => ({
        ...row,
        name: row.salespersonId === null ? "Bez handlowca" : (names.get(row.salespersonId) ?? `#${row.salespersonId}`),
        winRate: row.won + row.lost > 0 ? (row.won / (row.won + row.lost)) * 100 : null,
        avgDaysToWin: _winDays.length ? _winDays.reduce((a, b) => a + b, 0) / _winDays.length : null,
      }))
      .sort((a, b) => b.won - a.won || b.leads - a.leads || a.name.localeCompare(b.name, "pl"));

    // ---- Stan NA TERAZ: gnijące szanse ---------------------------------
    // Definicja „gnicia" ma jedno źródło (src/lib/sales-leads.ts) — ta sama
    // funkcja, którą liczy lista i kanban, żeby trzy ekrany nie mówiły trzech rzeczy.
    const openNowRows = db
      .select({
        id: schema.leads.id,
        stage: schema.leads.stage,
        lastActivityAt: schema.leads.lastActivityAt,
        createdAt: schema.leads.createdAt,
      })
      .from(schema.leads)
      .where(and(isNull(schema.leads.deletedAt), inArray(schema.leads.stage, [...LEAD_OPEN_STAGES]), ...spWhere))
      .limit(2000)
      .all();
    const nextByLead = nextActivityByLead(db, openNowRows.map((r) => r.id));
    const rotting = openNowRows.filter((r) => rottingOf(r, nextByLead.get(r.id)).rotting).length;

    return c.json({
      success: true,
      data: {
        from,
        to,
        salespersonId: salespersonFilter,
        generatedAt: new Date().toISOString(),
        leads: cohort.length,
        funnel,
        won: {
          count: wonCount,
          monthly: wonMonthly,
          setup: wonSetup,
          medianDaysToWin: median(daysToWin),
        },
        lost: {
          count: lostCount,
          byReason: [...lostByReason.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),
        },
        winRate: wonCount + lostCount > 0 ? (wonCount / (wonCount + lostCount)) * 100 : null,
        bySalesperson,
        rotting,
        openNow: openNowRows.length,
        coverage: { leadsWithHistory, leads: cohort.length },
      },
    });
  } catch (error) {
    console.error("Błąd lejka sprzedaży:", error);
    return c.json({ success: false, error: "Błąd pobierania lejka sprzedaży" }, 500);
  }
});

export default app;
