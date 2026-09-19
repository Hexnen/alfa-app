// Moduł Kadry — pracownicy, obiekty, normy, godziny, umowy, wynagrodzenia.
// Kalkulacja płac: src/utils/hr-calc.ts (agregacja godzin + jeden przebieg).
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type {
  NewHrContract,
  NewHrDepartment,
  NewHrEmployee,
  NewHrHours,
  NewHrObject,
  NewHrOfficePayroll,
} from "../db/schema.js";
import {
  buildHoursAggregates,
  computePayroll,
  type PayrollComputed,
} from "../utils/hr-calc.js";
// Okres obowiązywania umowy (valid_from / valid_to, migracja 0112) — reguły dat
// w jednym miejscu, wspólne z kalkulacją i z kosztem osobowym obiektu.
import {
  contractCoversMonth,
  contractStatus,
  dayBefore,
  daysBetween,
  formatDatePl,
  isIsoDate,
  periodLabelPl,
  shiftIsoDate,
  todayIso,
  type HrContractStatus,
} from "../lib/hr-contract-period.js";
import { fetchObjectCatalog } from "../lib/object-catalog.js";
import { departmentLabel, getCompanyConfig } from "../lib/company-config.js";
import { officeRowTotals } from "../lib/hr-office-total.js";
import { logActivity } from "../lib/activity-log.js";
import { getUser } from "../middleware/auth.js";
// Dziennik zmian Kadr: definicje pól i składanie summary (src/lib/hr-activity.ts),
// odczyt osi czasu (src/routes/hr-activity.ts).
import {
  hrEmployeeName,
  logHrCreated,
  logHrDeleted,
  logHrEvent,
  logHrUpdated,
} from "../lib/hr-activity.js";
import hrActivity, { hrEmployeeActivity } from "./hr-activity.js";
// Zamknięcie miesiąca: lista kontrolna + blokada zapisu w zamkniętym okresie
// (src/lib/hr-month.ts), trasy stanu miesiąca (src/routes/hr-month.ts).
import {
  assertMonthOpen,
  buildMonthChecklist,
  isMonthClosed,
  monthStatusRow,
} from "../lib/hr-month.js";
import { createHrMonthRoutes } from "./hr-month.js";
// Rezerwacja listy do edycji (migracja 0109): reguły w src/lib/hr-locks.ts,
// trasy /hr/locks/* w src/routes/hr-locks.ts. Tu wchodzi wyłącznie strażnik
// zapisu (`writeGuard`) — obok blokady zamkniętego miesiąca.
import {
  assertEditLock,
  portalOfContract,
  portalOfDepartment,
  portalOfEmployee,
  portalsOfHoursIds,
  type HrLockScope,
  type WritePortals,
} from "../lib/hr-locks.js";
import hrLocks from "./hr-locks.js";
// Sekcje działowe Kadr („Godziny działu” w CMA, OFI, Handlowym i Technicznym):
// kto widzi i pisze KTÓRE wiersze godzin — src/lib/hr-scope.ts. Prefiksy `/hr/*`
// w API_TAB_MAP są tylko bramką modułu; zawężenie wierszy jest TUTAJ i musi być
// wołane z KAŻDEJ trasy godzin (pominięta trasa = wyciek między sekcjami).
import {
  departmentIdsOfPortal,
  departmentInPortal,
  employeeIdsOfPortal,
  employeeOutsidePortalError,
  isDenial,
  outsidePortalError,
  dictionaryPortalScope,
  hasAnyHrTab,
  hasDirectoryAccess,
  HR_PORTALS,
  isHrPortal,
  portalFromQuery,
  portalHasObjects,
  writablePortalScope,
  type HrPortalKey,
} from "../lib/hr-scope.js";
// Kadry „na żywo”: publikacja sygnałów po każdej udanej mutacji (middleware
// niżej) i strumień SSE `GET /hr/live` — src/routes/hr-live.ts.
import hrLive, { hrLivePublisher } from "./hr-live.js";
// Wymiar czasu pracy z art. 130 k.p. i słownik dni wolnych (src/routes/hr-norms.ts,
// wyliczenie w src/lib/hr-norms.ts) — montowane na końcu pliku.
import hrNorms from "./hr-norms.js";

const app = new Hono();

// Sygnał „na żywo” po KAŻDEJ udanej mutacji w Kadrach — jedno miejsce zamiast
// wywołania w trzydziestu handlerach (uzasadnienie: src/routes/hr-live.ts).
// MUSI stać PRZED definicjami tras: middleware dopisane niżej nie obejmuje
// handlerów zarejestrowanych wcześniej.
app.use("*", hrLivePublisher);

/** Nazwy miesięcy do summary dziennika zmian (dane miesięczne bez miesiąca są nieczytelne). */
const MONTH_NAMES_PL = [
  "styczeń",
  "luty",
  "marzec",
  "kwiecień",
  "maj",
  "czerwiec",
  "lipiec",
  "sierpień",
  "wrzesień",
  "październik",
  "listopad",
  "grudzień",
];

const monthLabel = (year: number, month: number) =>
  `${MONTH_NAMES_PL[month - 1]} ${year}`;

/** Dopełniacz — zdania typu „z sierpnia do września" czyta człowiek, nie parser. */
const MONTH_NAMES_PL_GEN = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
];

const monthLabelGen = (year: number, month: number) =>
  `${MONTH_NAMES_PL_GEN[month - 1]} ${year}`;

/** „1 wpis” / „3 wpisy” / „7 wpisów” — do summary operacji zbiorczych. */
const plHours = (n: number): string => {
  if (n === 1) return "wpis";
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14) ? "wpisy" : "wpisów";
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Blokada zamkniętego miesiąca dla JEDNEGO handlera: zwraca gotową odpowiedź
 * 423 (Locked) albo `null`, gdy miesiąc jest otwarty i zapis ma iść dalej.
 *
 * Obejmuje wyłącznie dane MIESIĘCZNE (godziny, wypłaty, biuro, normy) —
 * słowniki (pracownicy, umowy, obiekty, działy) nie należą do okresu i zostają
 * edytowalne także wtedy, gdy miesiąc jest już rozliczony.
 *
 * 423, a nie 409: to nie konflikt wersji (który front rozwiązuje przeładowaniem
 * wiersza), tylko zasób zablokowany do odwołania — i front po tym kodzie
 * pokazuje pasek „miesiąc zamknięty”, zamiast proponować powtórzenie zapisu.
 */
/** Okres wiersza (null, gdy niekompletny — walidacja zapisu zajmie się resztą). */
const periodOf = (r: { year?: number | null; month?: number | null }) =>
  r.year != null && r.month != null ? { year: r.year, month: r.month } : null;

function monthLockResponse(
  c: Context,
  ...periods: Array<{ year: number; month: number } | null | undefined>
) {
  for (const p of periods) {
    if (!p) continue;
    const locked = assertMonthOpen(p.year, p.month);
    if (locked) return c.json<ApiResponse<null>>({ success: false, error: locked }, 423);
  }
  return null;
}

/**
 * Strażnik zapisu danych miesięcznych — DWIE blokady w jednym `if`:
 *  1. miesiąc musi być otwarty (`monthLockResponse`, migracja 0106),
 *  2. listę musi trzymać wołający (`assertEditLock`, migracja 0109) — czyli
 *     ktoś, kto wcisnął „Edycja” i ma aktywną rezerwację tej listy.
 *
 * Oba przypadki to 423 (Locked) i oba front rozpoznaje po komunikacie oraz po
 * `lock` w ciele: „miesiąc zamknięty” pokazuje pasek okresu, „listę edytuje
 * ktoś inny” — pytanie o prośbę o zwolnienie, a „rezerwacja wygasła” — ciche
 * ponowne wzięcie listy i powtórkę zapisu.
 *
 * KOLEJNOŚĆ MA ZNACZENIE: zamknięty miesiąc jest ważniejszy od rezerwacji —
 * w zamkniętym okresie nie pomoże nawet zwolnienie listy przez właściciela,
 * więc taki komunikat byłby myląco optymistyczny.
 *
 * Wywołanie odnawia przy okazji termin rezerwacji (patrz `assertEditLock`):
 * kto pisze, ten trzyma, niezależnie od heartbeatu z przeglądarki.
 */
function writeGuard(
  c: Context,
  scope: HrLockScope,
  /**
   * Czego dotyczy zapis: portale zapisywanych WIERSZY (dział wpisu godzin,
   * dział pracownika przy wypłacie i biurze; `null` = wiersz bez działu) albo
   * `"all"` dla operacji zbiorczych, które dotykają całej listy.
   *
   * Dzięki temu rezerwacja portalu OFI blokuje wyłącznie wiersze OFI, a nie
   * cały miesiąc — i odwrotnie: pełne Kadry nie wpiszą się w wiersze działu,
   * który właśnie wypełnia jego własna sekcja.
   */
  portals: WritePortals,
  ...periods: Array<{ year: number; month: number } | null | undefined>
) {
  const closed = monthLockResponse(c, ...periods);
  if (closed) return closed;
  for (const p of periods) {
    if (!p) continue;
    const blocked = assertEditLock(getUser(c), scope, p.year, p.month, portals);
    if (blocked) {
      return c.json(
        {
          success: false,
          error: blocked.error,
          data: { lock: blocked.lock, portal: blocked.portal },
        },
        423,
      );
    }
  }
  return null;
}

// Uchwyt transakcji drizzle (ten sam wzorzec, co w src/lib/activity-log.ts) —
// helpery działów muszą przyjmować i `db`, i `tx`, żeby niezmiennik puli CMA
// wykonywał się atomowo razem z zapisem działu.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

// Liczba lub null — akceptuje number i string w zapisie DZIESIĘTNYM z kropką
// albo przecinkiem ("7,5", "-12", "100"). Wcześniej `Number()`: nie czyta prefiksu
// jak `parseFloat()` ("3abc" → 3), ale przepuszczał "0x10" jako 16 i "1e1" jako
// 10 — wartości, których nikt nie wpisuje w godziny ani kwoty świadomie. Regex
// zamyka obie strony: to, co nie wygląda jak liczba, jest null i o dalszym losie
// (400 czy „brak wartości") decyduje wywołujący przez `isBlank()`.
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim().replace(",", ".");
    if (DECIMAL_RE.test(t)) return Number(t);
  }
  return null;
}

/** Pole „nie podane": brak klucza, null albo pusty string — to NIE jest błąd. */
const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Pole liczbowe opcjonalne: puste → null (jak dotąd), liczba → liczba, a string,
 * który liczbą nie jest ("12h", "abc") → błąd z NAZWĄ pola. Wcześniej `toNum`
 * samo zerowało nieparsowalne wartości i zapis kończył się 201 z `null` w
 * kolumnie — operator nie miał jak zauważyć, że jego „12h" zniknęło.
 */
function optionalNum(
  body: Record<string, unknown>,
  key: string,
  label: string,
): { value: number | null; error?: string } {
  const raw = body[key];
  if (isBlank(raw)) return { value: null };
  const n = toNum(raw);
  if (n == null) return { value: null, error: `${label}: nieprawidłowa liczba` };
  return { value: n };
}

/**
 * Zestaw pól liczbowych opcjonalnych naraz: `{ workedHours: "Godziny" }` →
 * `{ data: { workedHours: 7.5 } }` albo `{ error: "Godziny: nieprawidłowa liczba" }`
 * (pierwszy błąd przerywa — jeden komunikat na raz, jak w pozostałych parserach).
 */
function parseNumericFields<K extends string>(
  body: Record<string, unknown>,
  labels: Record<K, string>,
): { data?: Record<K, number | null>; error?: string } {
  const data = {} as Record<K, number | null>;
  for (const key of Object.keys(labels) as K[]) {
    const { value, error } = optionalNum(body, key, labels[key]);
    if (error) return { error };
    data[key] = value;
  }
  return { data };
}

/** Zakres roku, jaki w ogóle ma sens w ewidencji — reszta to literówka, nie data. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

const isValidYear = (y: number | null): y is number =>
  y != null && Number.isInteger(y) && y >= YEAR_MIN && y <= YEAR_MAX;
const isValidMonth = (m: number | null): m is number =>
  m != null && Number.isInteger(m) && m >= 1 && m <= 12;

const YEAR_MONTH_ERROR = `Nieprawidłowy rok/miesiąc (rok ${YEAR_MIN}–${YEAR_MAX}, miesiąc 1–12, liczby całkowite)`;

/**
 * Rok i miesiąc z query stringa. POMINIĘTY parametr = bieżący (wygoda dla
 * wywołań bez kontekstu), ale parametr PODANY musi być poprawny — inaczej 400.
 * Wcześniej `parseInt(...) || bieżący`: `month=0`, `month=abc` czy `year=0`
 * po cichu zwracały bieżący miesiąc i klient dostawał dane INNEGO okresu niż
 * ten, o który pytał, z kodem 200. `month=1.9` czytał się jako styczeń.
 */
function yearMonth(c: {
  req: { query: (k: string) => string | undefined };
}): { year: number; month: number } | { error: string } {
  const now = new Date();
  const rawYear = c.req.query("year");
  const rawMonth = c.req.query("month");
  const year = isBlank(rawYear) ? now.getFullYear() : toNum(rawYear);
  const month = isBlank(rawMonth) ? now.getMonth() + 1 : toNum(rawMonth);
  if (!isValidYear(year) || !isValidMonth(month)) return { error: YEAR_MONTH_ERROR };
  return { year, month };
}

/**
 * Rok i miesiąc z CIAŁA żądania — odpowiednik `yearMonth()` dla zapisów.
 * W odróżnieniu od query stringa oba pola są OBOWIĄZKOWE: zapis bez okresu to
 * nie „bieżący miesiąc”, tylko niekompletne żądanie.
 *
 * Jedno miejsce, bo warunek rozjeżdżał się po pliku: `PUT /payroll` sprawdzał
 * `!year || !month || month < 1 || month > 12`, czyli przyjąłby `year: 2026.5`
 * i `month: 9.5` — wiersz zapisany na taki okres nie pasuje do żadnego miesiąca
 * w `GET /payroll` i znika z ekranu mimo odpowiedzi 200.
 */
function parseYearMonth(body: Record<string, unknown>):
  | { year: number; month: number }
  | { error: string } {
  const year = toNum(body.year);
  const month = toNum(body.month);
  if (!isValidYear(year) || !isValidMonth(month)) return { error: YEAR_MONTH_ERROR };
  return { year, month };
}

// Normy godzin miesiąca; brak wpisu → wartości domyślne (jak w arkuszu Rok)
async function getNorms(year: number, month: number) {
  const [row] = await db
    .select()
    .from(schema.hrMonthNorms)
    .where(
      and(
        eq(schema.hrMonthNorms.year, year),
        eq(schema.hrMonthNorms.month, month),
      ),
    );
  return {
    workNorm: row?.workNorm ?? 160,
    contractNorm: row?.contractNorm ?? 158,
    fromDb: !!row,
  };
}

// ==================== PRACOWNICY ====================

/**
 * Nazwa działu po id — null, gdy takiego działu nie ma. Zapytanie po PK, więc
 * wołamy je synchronicznie (jak `departmentNameTaken` niżej): raz przy walidacji
 * zapisu, raz przy składaniu etykiety do odpowiedzi.
 */
function departmentNameById(id: number): string | null {
  const row = db
    .select({ name: schema.hrDepartments.name })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.id, id))
    .get();
  return row?.name ?? null;
}

/**
 * GOTOWA etykieta działu pracownika („ALFA GROUP:Handlowy”) albo pusty string.
 * Front Kadr nie zna `company.name` (app_settings za `requireAdmin`), więc sklejać
 * ją musi serwer — patrz `departmentLabel()` w src/lib/company-config.ts.
 * Dla POJEDYNCZEGO wiersza (odpowiedź POST/PUT); listy składają etykietę same,
 * z jednym `getCompanyConfig()` na całą odpowiedź.
 */
function employeeDepartmentLabel(departmentId: number | null | undefined): string {
  if (departmentId == null) return "";
  const name = departmentNameById(departmentId);
  if (name == null) return "";
  return departmentLabel(name, getCompanyConfig().values);
}

app.get("/employees", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  // LEFT JOIN, bo dział jest opcjonalny — osoba bez przypisania ma zostać na
  // liście (INNER wyciąłby po cichu wszystkich nieprzypisanych).
  let rows = await db
    .select({
      employee: schema.hrEmployees,
      departmentRawName: schema.hrDepartments.name,
    })
    .from(schema.hrEmployees)
    .leftJoin(
      schema.hrDepartments,
      eq(schema.hrEmployees.departmentId, schema.hrDepartments.id),
    )
    .orderBy(asc(schema.hrEmployees.fullName));
  if (onlyActive) rows = rows.filter((r) => r.employee.active);
  // Kartoteka jest niezależna od miesiąca, a spółka pracownika biura siedzi
  // w miesięcznych wierszach rozliczenia — doklejamy więc komplet spółek z
  // całej historii, żeby lista pokazywała je bez wybierania miesiąca.
  const officeRows = await db
    .selectDistinct({
      employeeId: schema.hrOfficePayroll.employeeId,
      company: schema.hrOfficePayroll.company,
    })
    .from(schema.hrOfficePayroll);
  const byEmployee = new Map<number, string[]>();
  for (const r of officeRows) {
    if (!r.company) continue;
    const list = byEmployee.get(r.employeeId);
    if (list) list.push(r.company);
    else byEmployee.set(r.employeeId, [r.company]);
  }
  // Nazwa firmy raz na odpowiedź, nie raz na wiersz — kartoteka to kilkaset osób
  // (ten sam wzorzec, co w GET /hr/hours i w `loadDepartments`).
  const { values } = getCompanyConfig();
  const data = rows.map((r) => ({
    ...r.employee,
    officeCompanies: (byEmployee.get(r.employee.id) ?? []).sort(),
    // Etykieta gotowa do wyświetlenia; pusty string = osoba bez działu.
    departmentName:
      r.departmentRawName != null ? departmentLabel(r.departmentRawName, values) : "",
  }));
  return c.json({ success: true, data });
});

/**
 * Walidacja ciała POST/PUT pracownika. `current` (tylko PUT) to wiersz sprzed
 * zapisu: pole POMINIĘTE w body zostaje bez zmian, pole podane (także `null`)
 * nadpisuje. Bez tego rozróżnienia PUT był pełnym nadpisaniem — brak klucza
 * `departmentId` znaczył `toNum(undefined)` = null, czyli kasował przypisanie
 * do działu, którego dla osób biura nie da się odtworzyć z żadnych danych
 * (patrz migracja 0073). Ten sam wzór co `parseTextHead` w routes/offers.ts.
 */
function parseEmployee(
  body: Record<string, unknown>,
  current?: NewHrEmployee,
): {
  data?: Partial<NewHrEmployee>;
  error?: string;
} {
  const fullName =
    typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!fullName) return { error: "Nazwisko i imię są wymagane" };
  /**
   * Dział z KARTOTEKI = stałe miejsce pracy osoby. To NIE jest to samo, co
   * `hr_hours.department_id`, który mówi, czego dotyczył pojedynczy wpis godzin:
   * technik przypisany do działu technicznego może mieć godziny zapisane na
   * obiekcie i nie ma w tym sprzeczności. Oba pola są niezależne i żadne nie
   * wynika z drugiego.
   *
   * null = brak przypisania i to jest stan domyślny (np. ochrona na posterunkach).
   * undefined (klucza nie ma w body) = zostaw, co jest.
   */
  const departmentId =
    body.departmentId === undefined
      ? current?.departmentId ?? null
      : toNum(body.departmentId);
  if (departmentId != null && !Number.isInteger(departmentId)) {
    return { error: "Dział: nieprawidłowy identyfikator" };
  }
  // Wartość podana, ale nieparsowalna ("abc") — to błąd klienta, nie prośba
  // o wyczyszczenie; ciche zerowanie ukryłoby wadę pod poprawnym zapisem.
  if (
    departmentId == null &&
    body.departmentId !== undefined &&
    body.departmentId !== null &&
    body.departmentId !== ""
  ) {
    return { error: "Dział: nieprawidłowy identyfikator" };
  }
  // Sprawdzamy istnienie działu, zamiast liczyć na FK: SQLite z wyłączonymi
  // kluczami obcymi przyjąłby wskazanie na nieistniejący dział bez słowa, a wtedy
  // kartoteka pokazywałaby pustą etykietę i nikt nie wiedziałby dlaczego.
  if (departmentId != null && departmentNameById(departmentId) === null) {
    return { error: "Wskazany dział nie istnieje — odśwież listę działów" };
  }
  // Pola NIENULLOWALNE (`kind`, `active`): `undefined` = zostaw, co jest, ale
  // jawny `null` to błąd klienta, nie wartość. Wcześniej `kind: null` po cichu
  // resetował rodzaj rozliczenia do „ochrona", a `active: null` dezaktywował
  // osobę — PUT z wyzerowanym formularzem przepinał człowieka między tabelami.
  if (body.kind === null) return { error: "kind nie może być puste" };
  if (body.kind !== undefined && body.kind !== "biuro" && body.kind !== "ochrona") {
    return { error: "kind: dozwolone wartości to „ochrona” albo „biuro”" };
  }
  if (body.active === null) return { error: "active nie może być puste" };
  return {
    data: {
      fullName,
      departmentId,
      code: typeof body.code === "string" ? body.code : current?.code ?? "",
      // Rodzaj rozliczenia — decyduje, czy osoba trafia do tabeli ochrony
      // (umowy) czy do zestawienia biura w wynagrodzeniach.
      kind: body.kind === undefined ? current?.kind ?? "ochrona" : body.kind,
      notes: typeof body.notes === "string" ? body.notes : current?.notes ?? "",
      active:
        body.active === undefined ? current?.active ?? true : Boolean(body.active),
    },
  };
}

app.post("/employees", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseEmployee(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Wstawka i wpis do dziennika w JEDNEJ transakcji — historia nie może się
  // rozjechać z kartoteką (ten sam wzorzec we wszystkich mutacjach Kadr).
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .insert(schema.hrEmployees)
      .values(data as NewHrEmployee)
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_employee",
      entityId: rows[0].id,
      user,
      after: rows[0],
    });
    return rows;
  });
  // Zwracamy wiersz w tym samym kształcie, co GET /employees (z etykietą działu),
  // żeby front mógł podmienić pozycję w tabeli bez pobierania listy od nowa.
  return c.json(
    {
      success: true,
      data: {
        ...result[0],
        departmentName: employeeDepartmentLabel(result[0].departmentId),
      },
      message: "Pracownik dodany",
    },
    201,
  );
});

app.put("/employees/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseEmployee(body, existing);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Optymistyczna kontrola współbieżności: gdy klient odeśle odczytany updatedAt,
  // zapis przechodzi tylko jeśli wiersz się nie zmienił — inaczej 409. Bez tego
  // dwóch operatorów zapisujących ten sam wiersz nadpisuje sobie nawzajem cały
  // payload (lost update).
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .update(schema.hrEmployees)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(
        expectedUpdatedAt
          ? and(
              eq(schema.hrEmployees.id, id),
              eq(schema.hrEmployees.updatedAt, expectedUpdatedAt),
            )
          : eq(schema.hrEmployees.id, id),
      )
      .returning()
      .all();
    if (rows.length > 0) {
      logHrUpdated(tx, {
        entityType: "hr_employee",
        entityId: id,
        user,
        employeeName: existing.fullName,
        before: existing,
        after: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Pracownik został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({
    success: true,
    data: {
      ...result[0],
      departmentName: employeeDepartmentLabel(result[0].departmentId),
    },
    message: "Pracownik zapisany",
  });
});

// ---------------------------------------------------------------------------
// Kasowanie kartoteki a dane MIESIĘCZNE (FK ON DELETE CASCADE / SET NULL)
// ---------------------------------------------------------------------------

/**
 * `hr_hours.employee_id`, `hr_office_payroll.employee_id` i
 * `hr_contracts.employee_id` są `ON DELETE CASCADE` (a `hr_payroll.contract_id`
 * kaskaduje dalej), `foreign_keys = ON` — więc jedno DELETE na kartotece zabiera
 * rozliczone godziny i kwoty, także z miesiąca ZAMKNIĘTEGO. Zamknięcie okresu
 * ma znaczyć „tych liczb już się nie rusza”, więc liczymy skutki PRZED
 * kasowaniem: wiersz w zamkniętym miesiącu odmawia bezwarunkowo (423, bez
 * `?force=1`), a to, co zniknęło, ląduje w dzienniku per miesiąc.
 */
interface PeriodCount {
  year: number;
  month: number;
  count: number;
}

function groupPeriods(rows: { year: number; month: number }[]): PeriodCount[] {
  const map = new Map<string, PeriodCount>();
  for (const r of rows) {
    const key = `${r.year}-${r.month}`;
    const hit = map.get(key);
    if (hit) hit.count += 1;
    else map.set(key, { year: r.year, month: r.month, count: 1 });
  }
  return [...map.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Nazwy ZAMKNIĘTYCH miesięcy spośród podanych zestawów (bez powtórzeń). */
function closedPeriodLabels(...lists: PeriodCount[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const p of list) {
      const key = `${p.year}-${p.month}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isMonthClosed(p.year, p.month)) out.push(monthLabel(p.year, p.month));
    }
  }
  return out;
}

/** „godziny: 3 (wrzesień 2026), 1 (sierpień 2026)” — człon opisu kaskady. */
function impactPart(label: string, list: PeriodCount[]): string | null {
  if (list.length === 0) return null;
  return `${label}: ${list
    .map((p) => `${p.count} (${monthLabel(p.year, p.month)})`)
    .join(", ")}`;
}

const impactSummary = (parts: Array<string | null>): string | null => {
  const filled = parts.filter((p): p is string => p != null);
  return filled.length > 0 ? filled.join("; ") : null;
};

const CLOSED_CASCADE_ERROR = (what: string, months: string[]) =>
  `Nie można usunąć — ${what} z ZAMKNIĘTEGO miesiąca (${months.join(", ")}). ` +
  `Otwórz ten miesiąc, jeśli te dane naprawdę mają zniknąć.`;

/** Godziny / biuro / wypłaty JEDNEGO pracownika, pogrupowane po miesiącach. */
function employeeMonthlyImpact(employeeId: number) {
  const hours = groupPeriods(
    db
      .select({ year: schema.hrHours.year, month: schema.hrHours.month })
      .from(schema.hrHours)
      .where(eq(schema.hrHours.employeeId, employeeId))
      .all(),
  );
  const office = groupPeriods(
    db
      .select({ year: schema.hrOfficePayroll.year, month: schema.hrOfficePayroll.month })
      .from(schema.hrOfficePayroll)
      .where(eq(schema.hrOfficePayroll.employeeId, employeeId))
      .all(),
  );
  const contractIds = db
    .select({ id: schema.hrContracts.id })
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.employeeId, employeeId))
    .all()
    .map((r) => r.id);
  const payroll = groupPeriods(
    contractIds.length === 0
      ? []
      : db
          .select({ year: schema.hrPayroll.year, month: schema.hrPayroll.month })
          .from(schema.hrPayroll)
          .where(inArray(schema.hrPayroll.contractId, contractIds))
          .all(),
  );
  return { hours, office, payroll };
}

/** Wypłaty JEDNEJ umowy, pogrupowane po miesiącach. */
const contractMonthlyImpact = (contractId: number): PeriodCount[] =>
  groupPeriods(
    db
      .select({ year: schema.hrPayroll.year, month: schema.hrPayroll.month })
      .from(schema.hrPayroll)
      .where(eq(schema.hrPayroll.contractId, contractId))
      .all(),
  );

app.delete("/employees/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const user = getUser(c);
  const impact = employeeMonthlyImpact(id);
  const closed = closedPeriodLabels(impact.hours, impact.office, impact.payroll);
  if (closed.length > 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: CLOSED_CASCADE_ERROR(
          "razem z pracownikiem zniknęłyby godziny, wypłaty lub rozliczenie biura",
          closed,
        ),
      },
      423,
    );
  }
  const cascade = impactSummary([
    impactPart("godziny", impact.hours),
    impactPart("wypłaty", impact.payroll),
    impactPart("biuro", impact.office),
  ]);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrEmployees)
      .where(eq(schema.hrEmployees.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, {
        entityType: "hr_employee",
        entityId: id,
        user,
        before: rows[0],
        cascade,
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Pracownik usunięty" });
});

// ==================== OBIEKTY ====================

/**
 * Słownik kadrowy obiektów (posterunków) — to na nim wiszą godziny. Do każdej
 * pozycji doklejamy:
 *  - obiekt z kartoteki, na który wskazuje ręczne mapowanie (`object_id`),
 *    razem z miastem i kontrahentem, żeby front nie musiał dociągać kartoteki
 *    po id pozycja po pozycji;
 *  - wagę pozycji: sumę godzin i liczbę osób z CAŁEJ historii `hr_hours`,
 *    a nie z wybranego miesiąca. Mapowanie robi się raz i na stałe, więc ma je
 *    porządkować realny wolumen pracy, a nie to, kto akurat był na urlopie
 *    w miesiącu otwartym w zakładce.
 */
app.get("/objects", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  // Posterunki wiszą na dziale OBIEKTOWYM (`has_objects`, w praktyce OFI), więc
  // sekcja, która takiego działu nie ma, nie ma też prawa do tej listy —
  // dostaje pustą, a nie 403: brak posterunków to dla niej normalny stan, a nie
  // błąd (select obiektu jest u niej i tak zablokowany).
  const user = getUser(c);
  const scope = dictionaryPortalScope(c.req.query("portal"), user, hasAnyHrTab(user));
  if (isDenial(scope)) {
    return c.json<ApiResponse<null>>({ success: false, error: scope.error }, scope.status);
  }
  if (scope.portal != null && !portalHasObjects(scope.portal)) {
    return c.json({ success: true, data: [] });
  }
  const rows = await db
    .select({
      row: schema.hrObjects,
      objectName: schema.objects.name,
      objectCity: schema.objects.city,
      contractorName: schema.contractors.name,
      // Kolumnę nadrzędną piszemy DOSŁOWNIE (`hr_objects.id`) — drizzle renderuje
      // ${schema.hrObjects.id} w szablonie jako niekwalifikowane "id", które
      // wewnątrz podzapytania trafiłoby w kolumnę tabeli z podzapytania.
      hoursTotal: sql<number>`(
        select coalesce(sum(coalesce(hr_hours.worked_hours, 0)), 0)
        from hr_hours where hr_hours.object_id = hr_objects.id
      )`,
      employeesCount: sql<number>`(
        select count(distinct hr_hours.employee_id)
        from hr_hours where hr_hours.object_id = hr_objects.id
      )`,
    })
    .from(schema.hrObjects)
    .leftJoin(schema.objects, eq(schema.hrObjects.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id),
    )
    .orderBy(asc(schema.hrObjects.name));
  const data = rows
    .filter((r) => !onlyActive || r.row.active)
    .map((r) => ({
      ...r.row,
      // Mapowanie może wskazywać na obiekt skasowany w międzyczasie (FK jest
      // "set null", więc taki stan długo nie potrwa) — stąd null zamiast obiektu
      // z pustymi polami.
      object:
        r.row.objectId != null && r.objectName != null
          ? {
              id: r.row.objectId,
              name: r.objectName,
              city: r.objectCity,
              contractorName: r.contractorName ?? "",
            }
          : null,
      hoursTotal: r.hoursTotal ?? 0,
      employeesCount: r.employeesCount ?? 0,
    }));
  return c.json({ success: true, data });
});

/**
 * Kartoteka obiektów w formie listy wyboru do mapowania. Świadomie pod `/hr`,
 * a nie przez `GET /objects`: mapowanie robi kadrowa, która nie musi mieć
 * dostępu do modułu Kontrahenci/Obiekty, a tutaj potrzebuje wyłącznie nazw.
 * Samo zapytanie jest wspólne z bliźniaczym ekranem w CMA — patrz
 * src/lib/object-catalog.ts.
 */
app.get("/object-catalog", async (c) => {
  return c.json({ success: true, data: await fetchObjectCatalog() });
});

/**
 * Skrócona lista pracowników kadr (bez danych płacowych) — potrzebna poza
 * Kadrami: formularz handlowca i technika wiąże osobę z listą płac. Prefiks
 * `/hr/directory` ma w API_TAB_MAP własny, węższy wpis, żeby handlowiec-edytor
 * bez dostępu do Kadr mógł wybrać osobę, ale nie zobaczył jej wynagrodzenia.
 *
 * CELOWO BEZ DZIAŁU: lista służy wyłącznie do wskazania osoby po nazwisku
 * (formularz handlowca i technika), a poszerzanie jej o strukturę organizacyjną
 * wypuszczałoby dane kadrowe do ról, które Kadr nie widzą. Dział pracownika
 * zwraca GET /hr/employees, chroniony uprawnieniem do Kadr.
 */
app.get("/directory/employees", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  // `?portal=` — sekcja działowa bierze stąd ludzi do wpisu godzin i ma
  // zobaczyć WYŁĄCZNIE swoich. Konto bez innego tytułu do tej listy (klucz
  // Kadr, Handlowcy, Technicy) musi portal podać: bez niego dostałoby nazwiska
  // całej firmy, co jest dokładnie tym, przed czym broni podział na sekcje.
  const user = getUser(c);
  const scope = dictionaryPortalScope(c.req.query("portal"), user, hasDirectoryAccess(user));
  if (isDenial(scope)) {
    return c.json<ApiResponse<null>>({ success: false, error: scope.error }, scope.status);
  }
  // Ludzie sekcji = dział z kartoteki ALBO wpis godzin w tej sekcji. Sam dział
  // by nie wystarczył: dyżury CMA obsadza ochrona przypisana do OFI, więc lista
  // wyboru w sekcji CMA byłaby pusta (uzasadnienie przy `employeeIdsOfPortal`).
  const portalPeople = scope.portal == null ? null : [...employeeIdsOfPortal(scope.portal)];
  const rows = await db
    .select({
      id: schema.hrEmployees.id,
      fullName: schema.hrEmployees.fullName,
      kind: schema.hrEmployees.kind,
      active: schema.hrEmployees.active,
      // KOD (Emeryt / Student…) — wyszukiwarka pracownika w mini-Kadrach filtruje
      // po nazwisku i kodzie, tak samo jak w pełnych Kadrach.
      code: schema.hrEmployees.code,
    })
    .from(schema.hrEmployees)
    .where(
      portalPeople == null
        ? undefined
        : portalPeople.length > 0
          ? inArray(schema.hrEmployees.id, portalPeople)
          : sql`0 = 1`,
    )
    .orderBy(asc(schema.hrEmployees.fullName));
  return c.json({
    success: true,
    data: onlyActive ? rows.filter((e) => e.active) : rows,
  });
});

app.post("/objects", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nazwa obiektu jest wymagana" },
      400,
    );
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .insert(schema.hrObjects)
      .values({ name, active: body.active === undefined ? true : Boolean(body.active) })
      .returning()
      .all();
    logHrCreated(tx, { entityType: "hr_object", entityId: rows[0].id, user, after: rows[0] });
    return rows;
  });
  return c.json({ success: true, data: result[0], message: "Obiekt dodany" }, 201);
});

app.put("/objects/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nazwa obiektu jest wymagana" },
      400,
    );
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const before = tx
      .select()
      .from(schema.hrObjects)
      .where(eq(schema.hrObjects.id, id))
      .get();
    if (!before) return [];
    const rows = tx
      .update(schema.hrObjects)
      .set({
        name,
        active: body.active === undefined ? true : Boolean(body.active),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.hrObjects.id, id))
      .returning()
      .all();
    logHrUpdated(tx, {
      entityType: "hr_object",
      entityId: id,
      user,
      before,
      // Mapowania ten endpoint nie rusza — z `after` wypada, więc diff go pomija.
      after: { name: rows[0].name, active: rows[0].active },
    });
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({ success: true, data: result[0], message: "Obiekt zapisany" });
});

/**
 * Ręczne mapowanie pozycji kadrowej na obiekt z kartoteki.
 * `{ objectId: null }` = zdejmij mapowanie (tak zostają pozycje typu #BIURO
 * czy CMA — to koszt ogólny, nie koszt konkretnego obiektu).
 *
 * Osobny endpoint zamiast pola w PUT /objects/:id, bo mapowanie ustawia się
 * jednym selectem w tabeli, bez przechodzenia przez formularz nazwy — i nie
 * chcemy, żeby zapis samej nazwy przypadkiem czyścił powiązanie.
 */
app.put("/objects/:id/mapping", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const raw = body.objectId;
  let objectId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const n = toNum(raw);
    if (n == null || !Number.isInteger(n) || n <= 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy obiekt" },
        400,
      );
    }
    objectId = n;
  }
  if (objectId !== null) {
    const [obj] = await db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(eq(schema.objects.id, objectId))
      .limit(1);
    if (!obj) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie znaleziono obiektu w kartotece" },
        404,
      );
    }
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const before = tx
      .select()
      .from(schema.hrObjects)
      .where(eq(schema.hrObjects.id, id))
      .get();
    if (!before) return [];
    const rows = tx
      .update(schema.hrObjects)
      .set({ objectId, updatedAt: new Date().toISOString() })
      .where(eq(schema.hrObjects.id, id))
      .returning()
      .all();
    // Mapowanie to nie „edycja pola”, tylko decyzja operatora — dlatego własne
    // zdanie w dzienniku, a nie suchy diff `object_id: 12 → 34`.
    if ((before.objectId ?? null) !== objectId) {
      const targetName =
        objectId == null
          ? null
          : tx
              .select({ name: schema.objects.name })
              .from(schema.objects)
              .where(eq(schema.objects.id, objectId))
              .get()?.name ?? `#${objectId}`;
      logHrEvent(tx, {
        entityType: "hr_object",
        entityId: id,
        user,
        action: "updated",
        field: "object_id",
        oldValue: before.objectId,
        newValue: objectId,
        summary:
          targetName == null
            ? `Pozycja ${before.name}: zdjęto przypisanie do obiektu z kartoteki`
            : `Pozycja ${before.name}: przypisano do obiektu ${targetName}`,
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({
    success: true,
    data: result[0],
    message: objectId === null ? "Mapowanie usunięte" : "Mapowanie zapisane",
  });
});

/**
 * Usunięcie pozycji kadrowej. FK `hr_hours.object_id` jest ON DELETE SET NULL,
 * więc kasowanie NIE usuwa godzin — po cichu ODPINA je od posterunku, a wpisy
 * lądują w „bez przypisania" i w koszcie ogólnym firmy. Dlatego, tak samo jak
 * przy działach, pozycja z godzinami wymaga świadomego potwierdzenia
 * (`?force=1`), inaczej 409 z liczbą wpisów.
 */
app.delete("/objects/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const force = c.req.query("force") === "1";
  // FK jest SET NULL, ale wiersz godzin z ZAMKNIĘTEGO miesiąca i tak zmieniłby
  // przypisanie — a to już jest edycja rozliczonego okresu. Bez obejścia `force`.
  const objectHours = groupPeriods(
    db
      .select({ year: schema.hrHours.year, month: schema.hrHours.month })
      .from(schema.hrHours)
      .where(eq(schema.hrHours.objectId, id))
      .all(),
  );
  const closedObject = closedPeriodLabels(objectHours);
  if (closedObject.length > 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: CLOSED_CASCADE_ERROR(
          "obiekt ma przypisane godziny",
          closedObject,
        ),
      },
      423,
    );
  }
  if (!force) {
    const [used] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.hrHours)
      .where(eq(schema.hrHours.objectId, id));
    const rowsUsing = Number(used?.count ?? 0);
    if (rowsUsing > 0) {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: `Obiekt ma przypisane godziny (wpisów: ${rowsUsing}). Usunięcie odepnie je od obiektu — potwierdź operację.`,
        },
        409,
      );
    }
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrObjects)
      .where(eq(schema.hrObjects.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, { entityType: "hr_object", entityId: id, user, before: rows[0] });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Obiekt usunięty" });
});

// ==================== DZIAŁY ====================

/*
 * Słownik działów firmy (Kadry → Działy). Rodzeństwo `hr_objects`, nie kartoteka:
 * wpis godzin wskazuje ALBO obiekt (posterunek), ALBO dział — pracę, która nie
 * należy do żadnego obiektu (handlowy, księgowość, zarząd, centrum monitorowania).
 * Wcześniej rolę działów pełniły pozycje słownika obiektów rozpoznawane po NAZWIE
 * (prefiks „#", literalne „CMA"); nazwa przestała być kluczem.
 */

export interface HrDepartmentDto {
  id: number;
  name: string;
  /**
   * Nazwa z prefiksem firmy („ALFA GROUP:Handlowy”). Składana na serwerze, bo
   * `company.name` żyje w app_settings za `requireAdmin` — front Kadr nie ma jak
   * jej przeczytać. Patrz `departmentLabel()` w src/lib/company-config.ts.
   */
  label: string;
  isCmaPool: boolean;
  /**
   * Kolor pigułki działu — nazwa tonu z palety kalendarza (`PillTone`), nie HEX.
   * `null` = dział bez koloru, czyli neutralna pigułka. Patrz schema.ts.
   */
  color: string | null;
  /**
   * Portal działowy (`hr_departments.portal`, migracja 0109) — sekcja Kadr,
   * która wypełnia swoje godziny sama. Front używa go do rezerwacji listy:
   * wiersze działu, którego portal trzyma ktoś inny, są wyszarzone.
   * `null` = dział bez portalu (jego wiersze należą tylko do pełnych Kadr).
   */
  portal: string | null;
  sortOrder: number;
  active: boolean;
  /** Waga działu: suma godzin z CAŁEJ historii `hr_hours`. */
  hoursTotal: number;
  /**
   * DWA liczniki osób, bo to dwa niezależne przypisania (patrz `parseEmployee`):
   * `employeesCount` — osoby z KARTOTEKI (`hr_employees.department_id`); dla
   *   działów biura (Handlowy, Księgowość, Zarząd) to JEDYNA więź, bo biuro nie
   *   ma wierszy w `hr_hours`. Jeden licznik z godzin pokazywał tu „—" i admin
   *   widział dział jako pusty, choć wisiało na nim sześć osób.
   * `hoursEmployeesCount` — distinct osoby z wpisów godzin; potrzebny dla CMA
   *   i Technicznego, gdzie kartoteka przypisań nie ma, a godziny są.
   */
  employeesCount: number;
  hoursEmployeesCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Działy razem z wagą. `where` zawężające do jednego id używamy po zapisie —
 * POST i PUT mają zwracać dokładnie ten sam kształt, co GET, żeby front mógł
 * podmienić wiersz w tabeli bez ponownego pobierania listy.
 */
async function loadDepartments(where?: SQL): Promise<HrDepartmentDto[]> {
  const rows = await db
    .select({
      row: schema.hrDepartments,
      // Kolumnę nadrzędną piszemy DOSŁOWNIE (`hr_departments.id`) — z tego samego
      // powodu co w GET /objects: drizzle zrenderowałby ${schema.hrDepartments.id}
      // jako niekwalifikowane "id", trafiające w kolumnę tabeli z podzapytania.
      hoursTotal: sql<number>`(
        select coalesce(sum(coalesce(hr_hours.worked_hours, 0)), 0)
        from hr_hours where hr_hours.department_id = hr_departments.id
      )`,
      employeesCount: sql<number>`(
        select count(*)
        from hr_employees where hr_employees.department_id = hr_departments.id
      )`,
      hoursEmployeesCount: sql<number>`(
        select count(distinct hr_hours.employee_id)
        from hr_hours where hr_hours.department_id = hr_departments.id
      )`,
    })
    .from(schema.hrDepartments)
    .where(where)
    .orderBy(asc(schema.hrDepartments.sortOrder), asc(schema.hrDepartments.name));
  // Nazwa firmy czytana RAZ na odpowiedź, nie raz na wiersz — to zapytanie po PK,
  // ale w pętli po kilkunastu działach byłoby kilkanaście identycznych.
  const { values } = getCompanyConfig();
  return rows.map((r) => ({
    ...r.row,
    label: departmentLabel(r.row.name, values),
    hoursTotal: r.hoursTotal ?? 0,
    employeesCount: r.employeesCount ?? 0,
    hoursEmployeesCount: r.hoursEmployeesCount ?? 0,
  }));
}

/** Czy błąd to naruszenie UNIQUE na nazwie działu (wyścig dwóch zapisów)? */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
      err.message.includes("UNIQUE constraint failed"))
  );
}

/**
 * `partial = true` (PUT): zmieniają się tylko pola obecne w body. Przy POST nazwa
 * jest obowiązkowa, reszta bierze wartości domyślne ze schematu.
 */
/**
 * Tony pigułek dozwolone jako kolor działu — podzbiór `PillTone` z
 * `frontend/src/lib/calendar-labels.ts` (bez `neutral`/`muted`, bo te znaczą
 * „brak koloru" i zapisuje się je jako NULL).
 */
/**
 * NIEZMIENNIK: dział-pula centrum monitorowania NIGDY nie jest działem
 * obiektowym. Godziny puli rozdzielają się na WSZYSTKIE dozorowane obiekty
 * (`src/lib/object-personnel-cost.ts` — gałąź `objectId == null &&
 * departmentId != null`); wpis puli wskazujący obiekt wypadłby z tej gałęzi
 * i pula po cichu zeszłaby do zera, a koszt centrum wylądowałby u jednego
 * klienta. Żadna ścieżka zapisu nie ma prawa ustawić obu flag naraz.
 */
const POOL_NOT_OBJECT =
  "Dział-pula centrum monitorowania nie może być działem obiektowym — " +
  "godziny puli rozdzielają się na wszystkie obiekty, więc nie wskazują żadnego";

const DEPARTMENT_COLORS = [
  "sky",
  "emerald",
  "amber",
  "violet",
  "orange",
  "indigo",
  "teal",
  "rose",
  "red",
] as const;
type DepartmentColor = (typeof DEPARTMENT_COLORS)[number];

function parseDepartment(
  body: Record<string, unknown>,
  partial: boolean,
): { data?: Partial<NewHrDepartment>; error?: string } {
  const data: Partial<NewHrDepartment> = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "Nazwa działu jest wymagana" };
    if (name.length > 100) return { error: "Nazwa działu: maks. 100 znaków" };
    data.name = name;
  }
  if (body.isCmaPool !== undefined) data.isCmaPool = Boolean(body.isCmaPool);
  // Dział obiektowy (OFI) — w nim i tylko w nim wpisy godzin wskazują obiekt.
  if (body.hasObjects !== undefined) data.hasObjects = Boolean(body.hasObjects);
  // NIEZMIENNIK: dział-pula NIE JEST działem obiektowym (patrz
  // `POOL_NOT_OBJECT` niżej). Tu łapiemy tylko zapis podający OBA pola naraz
  // (POST i „pełny” PUT); PUT częściowy sprawdza wartości wypadkowe w transakcji.
  if (data.hasObjects === true && data.isCmaPool === true) {
    return { error: POOL_NOT_OBJECT };
  }
  if (body.sortOrder !== undefined) {
    const n = toNum(body.sortOrder);
    if (n == null || !Number.isInteger(n)) {
      return { error: "Kolejność musi być liczbą całkowitą" };
    }
    data.sortOrder = n;
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  // Kolor pigułki — nazwa tonu z palety kalendarza, nie HEX (patrz schema.ts).
  // Whitelist, bo wartość trafia wprost do klasy Tailwind na froncie: cokolwiek
  // spoza listy skończyłoby się pigułką bez tła (albo, przy złośliwym wejściu,
  // klasą, której nikt tu nie zaplanował).
  if (body.color !== undefined) {
    if (body.color === null || body.color === "") {
      data.color = null;
    } else {
      const color = typeof body.color === "string" ? body.color.trim() : "";
      if (!DEPARTMENT_COLORS.includes(color as DepartmentColor)) {
        return { error: `Kolor działu: dozwolone tony to ${DEPARTMENT_COLORS.join(", ")}` };
      }
      data.color = color;
    }
  }
  /*
   * PORTAL DZIAŁU — sekcja sidebara, która wypełnia swoje godziny sama
   * (`src/lib/hr-scope.ts`). `null`/pusty = dział wyłącznie dla pełnych Kadr.
   *
   * Whitelist z tego samego powodu co przy kolorze, tylko poważniejszego:
   * wartość decyduje o tym, KTO WIDZI wiersze tego działu. Literówka („ofii”)
   * nie może dać działu-widma, którego nie widzi ani sekcja, ani nikt inny.
   */
  if (body.portal !== undefined) {
    if (body.portal === null || body.portal === "") {
      data.portal = null;
    } else {
      const portal = typeof body.portal === "string" ? body.portal.trim() : "";
      if (!isHrPortal(portal)) {
        return { error: `Portal działu: dozwolone sekcje to ${HR_PORTALS.join(", ")}` };
      }
      data.portal = portal;
    }
  }
  return { data };
}

/**
 * NIEZMIENNIK: pula centrum monitorowania jest JEDNA. `object-personnel-cost.ts`
 * zniesie wiele działów z flagą (zsumuje ich godziny w jedną pulę), ale operacyjnie
 * byłby to błąd — nikt nie zamierza mieć dwóch centrów. Dlatego zaznaczenie puli
 * zdejmuje flagę z pozostałych działów, w tej samej transakcji co zapis.
 */
function clearOtherPools(tx: DbOrTx, keepId: number): void {
  tx.update(schema.hrDepartments)
    .set({ isCmaPool: false, updatedAt: new Date().toISOString() })
    .where(
      and(eq(schema.hrDepartments.isCmaPool, true), ne(schema.hrDepartments.id, keepId)),
    )
    .run();
}

/** Kolizja nazwy — bez rozróżniania wielkości liter, jak przy spółkach. */
function departmentNameTaken(tx: DbOrTx, name: string, exceptId?: number): boolean {
  return (
    tx
      .select({ id: schema.hrDepartments.id })
      .from(schema.hrDepartments)
      .where(
        exceptId == null
          ? sql`lower(${schema.hrDepartments.name}) = lower(${name})`
          : sql`lower(${schema.hrDepartments.name}) = lower(${name}) and ${schema.hrDepartments.id} <> ${exceptId}`,
      )
      .get() != null
  );
}

const DEPARTMENT_NAME_TAKEN = "Dział o tej nazwie już istnieje";

app.get("/departments", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  // `?portal=` zawęża słownik do działów SEKCJI — select w mini-Kadrach ma
  // pokazywać dwie pozycje (OFI, Operacyjny), a nie całą strukturę firmy.
  // Kto ma dowolny klucz Kadr, czyta jak dotąd całość (kartoteka, wpis godzin,
  // zakładka Działy); konto z samym kluczem sekcji MUSI podać portal.
  const user = getUser(c);
  const scope = dictionaryPortalScope(c.req.query("portal"), user, hasAnyHrTab(user));
  if (isDenial(scope)) {
    return c.json<ApiResponse<null>>({ success: false, error: scope.error }, scope.status);
  }
  const rows = await loadDepartments(
    scope.portal == null ? undefined : eq(schema.hrDepartments.portal, scope.portal),
  );
  return c.json({
    success: true,
    data: onlyActive ? rows.filter((d) => d.active) : rows,
  });
});

app.post("/departments", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseDepartment(body, false);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const user = getUser(c);
  let outcome: { status: 201; id: number } | { status: 409 };
  try {
    outcome = db.transaction((tx) => {
      if (departmentNameTaken(tx, data.name as string)) {
        return { status: 409 as const };
      }
      const [created] = tx
        .insert(schema.hrDepartments)
        .values(data as NewHrDepartment)
        .returning()
        .all();
      if (created.isCmaPool) clearOtherPools(tx, created.id);
      logHrCreated(tx, {
        entityType: "hr_department",
        entityId: created.id,
        user,
        after: created,
      });
      return { status: 201 as const, id: created.id };
    });
  } catch (err) {
    // Wyścig: nazwa wolna przy sprawdzeniu, zajęta przy INSERT. Spójność pilnuje
    // UNIQUE — tłumaczymy je na ten sam czytelny 409 zamiast surowego 500.
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: DEPARTMENT_NAME_TAKEN }, 409);
    }
    throw err;
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>({ success: false, error: DEPARTMENT_NAME_TAKEN }, 409);
  }
  const [dto] = await loadDepartments(eq(schema.hrDepartments.id, outcome.id));
  return c.json({ success: true, data: dto, message: "Dział dodany" }, 201);
});

app.put("/departments/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseDepartment(body, true);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const user = getUser(c);
  let outcome:
    | { status: 200 }
    | { status: 404 }
    | { status: 409 }
    | { status: 400 | 409; error: string };
  try {
    outcome = db.transaction((tx) => {
      const existing = tx
        .select()
        .from(schema.hrDepartments)
        .where(eq(schema.hrDepartments.id, id))
        .get();
      if (!existing) return { status: 404 as const };
      if (data.name != null && departmentNameTaken(tx, data.name, id)) {
        return { status: 409 as const };
      }
      // NIEZMIENNIKI FLAG — liczone na wartościach WYPADKOWYCH, bo PUT bywa
      // częściowy (`{"hasObjects": true}` na dziale, który już jest pulą).
      const nextHasObjects = data.hasObjects ?? existing.hasObjects;
      const nextIsCmaPool = data.isCmaPool ?? existing.isCmaPool;
      if (nextHasObjects && nextIsCmaPool) {
        return { status: 400 as const, error: POOL_NOT_OBJECT };
      }
      // Zdjęcie flagi „dział obiektowy” unieruchamia WSZYSTKIE istniejące wpisy
      // godzin z obiektem w tym dziale: każdy zapis inline wysyła cały wiersz,
      // więc od tej chwili odbija się o 400 („Obiekty rozliczają się tylko
      // w dziale obiektowym”) — także poprawka w samych Uwagach. Dlatego
      // odmawiamy z LICZBĄ wpisów; dział bez takich wpisów przechodzi.
      if (existing.hasObjects && data.hasObjects === false) {
        const used = tx
          .select({ count: sql<number>`count(*)` })
          .from(schema.hrHours)
          .where(
            and(
              eq(schema.hrHours.departmentId, id),
              sql`${schema.hrHours.objectId} is not null`,
            ),
          )
          .get();
        const rowsUsing = Number(used?.count ?? 0);
        if (rowsUsing > 0) {
          return {
            status: 409 as const,
            error:
              `Dział ma ${rowsUsing} ${plHours(rowsUsing)} godzin z obiektem — ` +
              `po zdjęciu znacznika żadnego z nich nie dałoby się już zapisać. ` +
              `Najpierw przenieś te wpisy do innego działu obiektowego.`,
          };
        }
      }
      const updated = tx
        .update(schema.hrDepartments)
        .set({ ...data, updatedAt: new Date().toISOString() })
        .where(eq(schema.hrDepartments.id, id))
        .returning()
        .all();
      // `data` niesie tylko pola obecne w body (PUT częściowy) — diff bierze
      // wartości z zapisanego wiersza, ale porównuje wyłącznie te klucze.
      logHrUpdated(tx, {
        entityType: "hr_department",
        entityId: id,
        user,
        before: existing,
        after: Object.fromEntries(Object.keys(data).map((k) => [k, (updated[0] as Record<string, unknown>)[k]])),
      });
      // Flaga puli zdejmowana z pozostałych DOPIERO po zapisie tego działu —
      // inaczej `keepId` nie miałby jeszcze ustawionej flagi i wyczyścilibyśmy ją
      // wszystkim, łącznie z tym, który właśnie miał ją dostać.
      if (data.isCmaPool === true) clearOtherPools(tx, id);
      return { status: 200 as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: DEPARTMENT_NAME_TAKEN }, 409);
    }
    throw err;
  }
  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono działu" }, 404);
  }
  if ("error" in outcome) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, outcome.status);
  }
  if (outcome.status === 409) {
    return c.json<ApiResponse<null>>({ success: false, error: DEPARTMENT_NAME_TAKEN }, 409);
  }
  const [dto] = await loadDepartments(eq(schema.hrDepartments.id, id));
  return c.json({ success: true, data: dto, message: "Dział zapisany" });
});

/**
 * Usunięcie działu. Dwa FK są ON DELETE SET NULL — `hr_hours.department_id`
 * i `hr_employees.department_id` — więc kasowanie NIE usuwa godzin ani ludzi,
 * tylko po cichu ODPINA ich od przypisania.
 *
 * DECYZJA: dział z godzinami LUB z pracownikami w kartotece wymaga świadomego
 * potwierdzenia (`?force=1`), inaczej 409 z liczbami. Guard liczący TYLKO godziny
 * nie chronił działów biura: biuro nie ma wierszy w `hr_hours`, więc Handlowy czy
 * Księgowość kasowały się bez pytania, a przypisań 11 osób z migracji 0073 nie
 * da się odtworzyć z żadnych innych danych.
 *
 * DZIAŁ-PULA (`is_cma_pool = 1`) NIE DA SIĘ usunąć wcale — 409 bez obejścia przez
 * `force`. To nie jest „dużo godzin" (31 tys. z całej historii), które użytkownik
 * może świadomie odpiąć: razem z wierszem znika flaga, alokacja kosztów centrum
 * po cichu przestaje działać (`cma.pool = 0` w `object-personnel-cost.ts`), a
 * odtworzenia nie ma — FK SET NULL zostawia wpisy bez działu i z UI nie da się
 * ich zbiorczo przypiąć z powrotem. Ścieżka legalna: najpierw przenieś flagę
 * puli na inny dział (PUT `isCmaPool: true` na nim), dopiero potem kasuj.
 */
const CMA_POOL_UNDELETABLE =
  "Ten dział jest pulą centrum monitorowania — najpierw przenieś flagę puli na inny dział";

app.delete("/departments/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const force = c.req.query("force") === "1";
  const [target] = await db
    .select({ isCmaPool: schema.hrDepartments.isCmaPool })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.id, id));
  if (!target) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono działu" },
      404,
    );
  }
  if (target.isCmaPool) {
    return c.json<ApiResponse<null>>({ success: false, error: CMA_POOL_UNDELETABLE }, 409);
  }
  // Jak przy obiektach: SET NULL na wierszu godzin z zamkniętego miesiąca to
  // zmiana rozliczonego okresu — odmowa bezwarunkowa.
  const deptHours = groupPeriods(
    db
      .select({ year: schema.hrHours.year, month: schema.hrHours.month })
      .from(schema.hrHours)
      .where(eq(schema.hrHours.departmentId, id))
      .all(),
  );
  const closedDept = closedPeriodLabels(deptHours);
  if (closedDept.length > 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: CLOSED_CASCADE_ERROR("dział ma przypisane godziny", closedDept) },
      423,
    );
  }
  if (!force) {
    const [used] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.hrHours)
      .where(eq(schema.hrHours.departmentId, id));
    const [staff] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.hrEmployees)
      .where(eq(schema.hrEmployees.departmentId, id));
    const rowsUsing = Number(used?.count ?? 0);
    const staffUsing = Number(staff?.count ?? 0);
    if (rowsUsing > 0 || staffUsing > 0) {
      // Komunikat wymienia tylko niezerowe liczniki — „0 pracowników" to szum,
      // który odciąga uwagę od tego, co naprawdę zostanie odpięte.
      const parts: string[] = [];
      if (rowsUsing > 0) parts.push(`przypisane godziny (wpisów: ${rowsUsing})`);
      if (staffUsing > 0) parts.push(`pracowników w kartotece (${staffUsing})`);
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: `Dział ma ${parts.join(" i ")}. Usunięcie odepnie ich od działu — potwierdź operację.`,
        },
        409,
      );
    }
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrDepartments)
      .where(eq(schema.hrDepartments.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, { entityType: "hr_department", entityId: id, user, before: rows[0] });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono działu" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Dział usunięty" });
});

// ==================== NORMY GODZIN ====================

/** 31 dni × 24 h — więcej godzin w miesiącu fizycznie nie ma. */
const MAX_MONTH_HOURS = 744;

app.get("/norms", async (c) => {
  const rawYear = c.req.query("year");
  const year = isBlank(rawYear) ? new Date().getFullYear() : toNum(rawYear);
  if (!isValidYear(year)) {
    return c.json<ApiResponse<null>>({ success: false, error: YEAR_MONTH_ERROR }, 400);
  }
  const rows = await db
    .select()
    .from(schema.hrMonthNorms)
    .where(eq(schema.hrMonthNorms.year, year))
    .orderBy(asc(schema.hrMonthNorms.month));
  return c.json({ success: true, data: rows });
});

// Upsert normy jednego miesiąca
app.put("/norms", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ymNorms = parseYearMonth(body);
  if ("error" in ymNorms) {
    return c.json<ApiResponse<null>>({ success: false, error: ymNorms.error }, 400);
  }
  const { year, month } = ymNorms;
  const workNorm = toNum(body.workNorm);
  const contractNorm = toNum(body.contractNorm);
  if (workNorm == null || contractNorm == null) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane: rok, miesiąc (1-12), norma pracy i zlecenia" },
      400,
    );
  }
  // Norma jest MIANOWNIKIEM stawki godzinowej (kwota / norma) — zero albo liczba
  // ujemna dawały stawkę nieskończoną lub ujemną i psuły cały miesiąc wypłat.
  // Sufit: 31 dni × 24 h = 744 — więcej godzin miesiąc nie ma.
  if (workNorm <= 0 || contractNorm <= 0 || workNorm > MAX_MONTH_HOURS || contractNorm > MAX_MONTH_HOURS) {
    return c.json<ApiResponse<null>>(
      { success: false, error: `Norma godzin musi być większa od 0 i nie większa niż ${MAX_MONTH_HOURS}` },
      400,
    );
  }
  // Norma jest mianownikiem stawki — zmiana normy w zamkniętym miesiącu
  // przeliczyłaby wypłaty, które już wyszły.
  const normLocked = monthLockResponse(c, { year, month });
  if (normLocked) return normLocked;
  // Upsert w jednej synchronicznej transakcji — select i insert/update są
  // atomowe, więc równoległe PUT /norms dla tego samego (rok, miesiąc) nie
  // wstawią dwóch wierszy normy.
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.hrMonthNorms)
      .where(
        and(eq(schema.hrMonthNorms.year, year), eq(schema.hrMonthNorms.month, month)),
      )
      .get();
    const period = { year, month };
    if (existing) {
      const rows = tx
        .update(schema.hrMonthNorms)
        .set({ workNorm, contractNorm, updatedAt: new Date().toISOString() })
        .where(eq(schema.hrMonthNorms.id, existing.id))
        .returning()
        .all();
      logHrUpdated(tx, {
        entityType: "hr_norm",
        entityId: existing.id,
        user,
        period,
        before: existing,
        after: { workNorm, contractNorm },
      });
      return rows;
    }
    const created = tx
      .insert(schema.hrMonthNorms)
      .values({ year, month, workNorm, contractNorm })
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_norm",
      entityId: created[0].id,
      user,
      period,
      after: created[0],
    });
    return created;
  });
  return c.json({ success: true, data: result[0], message: "Norma zapisana" });
});

// ==================== GODZINY ====================

/** Czy wiersz o tym id istnieje — zapytanie po PK, wołane synchronicznie jak `departmentNameById`. */
function rowExists(
  table: typeof schema.hrEmployees | typeof schema.hrObjects | typeof schema.hrDepartments,
  id: number,
): boolean {
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() != null;
}

/**
 * Identyfikator z body: liczba całkowita dodatnia wskazująca ISTNIEJĄCY wiersz.
 * Istnienie sprawdzamy sami, a nie przez FK: naruszenie klucza obcego to 500
 * z komunikatem SQLite, a klient wysłał po prostu złe dane — należy mu się 400
 * z nazwą pola. Puste/null → null (pole opcjonalne), o obowiązkowości decyduje
 * wywołujący.
 */
function refId(
  raw: unknown,
  table: typeof schema.hrEmployees | typeof schema.hrObjects | typeof schema.hrDepartments,
  label: string,
): { id: number | null; error?: string } {
  if (isBlank(raw)) return { id: null };
  const n = toNum(raw);
  if (n == null || !Number.isInteger(n) || n <= 0) {
    return { id: null, error: `${label}: nieprawidłowy identyfikator` };
  }
  if (!rowExists(table, n)) return { id: null, error: `${label}: nie istnieje (odśwież listę)` };
  return { id: n };
}

/** Etykiety pól liczbowych wpisu godzin — do komunikatów 400 z nazwą pola. */
const HOURS_LABELS = {
  nightHours: "Godziny nocne",
  workedHours: "Godziny",
  uwHours: "Urlop (godz.)",
  l4Hours: "L4 (godz.)",
  maxHours: "Godziny maks.",
  deductions: "Potrącenia",
  bonuses: "Dodatki",
} as const;

/**
 * Id działów obiektowych (`has_objects`). Zapytanie po flagowanej kolumnie,
 * więc synchronicznie — jak `departmentNameById` wyżej. W praktyce lista ma
 * jeden element (OFI), ale kod nie zakłada tego na sztywno.
 */
function objectDepartmentIds(): number[] {
  return db
    .select({ id: schema.hrDepartments.id })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.hasObjects, true))
    .all()
    .map((r) => r.id);
}

const departmentHasObjects = (id: number): boolean =>
  db
    .select({ hasObjects: schema.hrDepartments.hasObjects })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.id, id))
    .get()?.hasObjects === true;

function parseHours(body: Record<string, unknown>): {
  data?: Partial<NewHrHours>;
  error?: string;
} {
  const emp = refId(body.employeeId, schema.hrEmployees, "Pracownik");
  if (emp.error) return { error: emp.error };
  if (emp.id == null) return { error: "Pracownik jest wymagany" };
  const employeeId = emp.id;
  // Całkowite i w zakresie: `month = 5.5` czy `year = 2020.7` zapisywały się
  // dosłownie i taki wiersz nie pasował do żadnego miesiąca w GET /hours.
  const ym = parseYearMonth(body);
  if ("error" in ym) return { error: ym.error };
  const { year, month } = ym;
  const obj = refId(body.objectId, schema.hrObjects, "Obiekt");
  if (obj.error) return { error: obj.error };
  const dep = refId(body.departmentId, schema.hrDepartments, "Dział");
  if (dep.error) return { error: dep.error };
  const objectId = obj.id;
  let departmentId = dep.id;
  // Obiekt należy DO działu obiektowego (OFI), a nie „zamiast działu” — patrz
  // komentarz przy `hrHours.objectId` w schemacie.
  if (objectId != null) {
    if (departmentId == null) {
      // Wpis z samym obiektem (stary klient, import, carry-over sprzed zmiany)
      // dostaje dział obiektowy — o ile jest dokładnie jeden, bo przy dwóch nie
      // ma jak zgadnąć, do którego należy posterunek.
      const objectDepts = objectDepartmentIds();
      if (objectDepts.length !== 1) {
        return {
          error:
            "Wpis z obiektem wymaga działu obiektowego — wskaż dział w formularzu",
        };
      }
      departmentId = objectDepts[0];
    } else if (!departmentHasObjects(departmentId)) {
      return {
        error:
          "Obiekty rozliczają się tylko w dziale obiektowym (OFI) — wybierz ten dział albo zdejmij obiekt",
      };
    }
  }
  // Pola liczbowe opcjonalne: puste → null, „12h" → 400 z nazwą pola — ta sama
  // zasada, co dla `departmentId` i `sortOrder`; wcześniej te pola zerowały się
  // po cichu i zapis wracał 201.
  const nums = parseNumericFields(body, HOURS_LABELS);
  if (nums.error || !nums.data) return { error: nums.error };
  // Godziny nie bywają ujemne — `-8` to literówka, a zapisana zaniżałaby sumę
  // miesiąca i (przy UoP) fakt godzin do wypłaty. Kwoty (potrącenia/dodatki)
  // zostawiamy bez ograniczenia znaku: korekta „na minus" bywa zamierzona.
  const hourFields = ["nightHours", "workedHours", "uwHours", "l4Hours", "maxHours"] as const;
  for (const key of hourFields) {
    const v = nums.data[key];
    if (v != null && v < 0) {
      return { error: `${HOURS_LABELS[key]}: godziny nie mogą być ujemne` };
    }
  }
  return {
    data: {
      employeeId,
      objectId,
      departmentId,
      year,
      month,
      ...nums.data,
      notes: typeof body.notes === "string" ? body.notes : "",
      // Flaga „przypisanie do potwierdzenia" (carry-over) — jedna dla obiektu
      // i dla działu. Formularz jej nie wysyła, więc każdy zapis wpisu przez
      // użytkownika zdejmuje pytajnik.
      objectUncertain: body.objectUncertain === true,
    },
  };
}

/** Godziny tej samej osoby i tego samego przypisania z miesiąca poprzedniego. */
export interface HrHoursPrev {
  workedHours: number | null;
  uwHours: number | null;
  l4Hours: number | null;
  nightHours: number | null;
}

/**
 * Poprzedni miesiąc dla CAŁEJ listy naraz — JEDNO zapytanie, nie jedno na
 * wiersz. Klucz to `carryOverPairKey` (pracownik + obiekt/dział), czyli
 * dokładnie ta sama para, którą przenosi carry-over: wiersz wrześniowy szuka
 * swojego sierpniowego odpowiednika po tym, KOGO i CZEGO dotyczy, a nie po id
 * (te są w każdym miesiącu inne).
 *
 * Zawężenie sekcji (`inPortal`) idzie i tutaj: bez niego konto CMA dostałoby
 * w kolumnie „pop.” godziny ochrony obiektowej.
 */
async function loadPrevHours(
  year: number,
  month: number,
  inPortal: SQL | null,
): Promise<Map<string, HrHoursPrev>> {
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const rows = await db
    .select({
      employeeId: schema.hrHours.employeeId,
      objectId: schema.hrHours.objectId,
      departmentId: schema.hrHours.departmentId,
      workedHours: schema.hrHours.workedHours,
      uwHours: schema.hrHours.uwHours,
      l4Hours: schema.hrHours.l4Hours,
      nightHours: schema.hrHours.nightHours,
    })
    .from(schema.hrHours)
    .where(
      and(
        eq(schema.hrHours.year, prevYear),
        eq(schema.hrHours.month, prevMonth),
        ...(inPortal ? [inPortal] : []),
      ),
    );
  const out = new Map<string, HrHoursPrev>();
  for (const r of rows) {
    const key = carryOverPairKey(r);
    // Ta sama para dwa razy w jednym miesiącu nie powinna się zdarzyć (carry-over
    // jej nie zdubluje), ale nic tego nie wymusza w bazie — wtedy SUMUJEMY, bo
    // tyle właśnie ta osoba przepracowała wtedy na tym przypisaniu.
    const hit = out.get(key);
    const add = (a: number | null, b: number | null) =>
      a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    out.set(
      key,
      hit
        ? {
            workedHours: add(hit.workedHours, r.workedHours),
            uwHours: add(hit.uwHours, r.uwHours),
            l4Hours: add(hit.l4Hours, r.l4Hours),
            nightHours: add(hit.nightHours, r.nightHours),
          }
        : {
            workedHours: r.workedHours,
            uwHours: r.uwHours,
            l4Hours: r.l4Hours,
            nightHours: r.nightHours,
          },
    );
  }
  return out;
}

/**
 * Wpisy godzin miesiąca z etykietami (pracownik, obiekt, dział) — jedno
 * zapytanie z joinami. Osobna funkcja, bo czyta je i `GET /hours`, i zbiorczy
 * `GET /month`.
 */
async function loadHoursRows(
  year: number,
  month: number,
  /**
   * Sekcja działowa (`null` = pełne Kadry, czyli bez zawężenia). Filtr idzie po
   * DZIALE wpisu, a nie po pracowniku: wpis mówi, czego dotyczyła praca w tym
   * miesiącu, i to on należy do sekcji. Wiersze bez działu zostają wyłącznie
   * dla pełnych Kadr — nie ma sekcji, która mogłaby się o nie upomnieć.
   */
  portal: HrPortalKey | null = null,
  /**
   * Dołóż `prev` — godziny TEJ SAMEJ osoby na TYM SAMYM przypisaniu w miesiącu
   * poprzednim (kolumna „pop.” w tabeli Godzin). Domyślnie wyłączone, bo to
   * dodatkowe zapytanie, a zbiorczy `GET /month` czyta tę funkcję cztery razy
   * i nie ma z czego rysować poprzedniego miesiąca (sam go już wczytuje).
   */
  withPrev = false,
) {
  const portalDepts = portal == null ? [] : departmentIdsOfPortal(portal);
  // Sekcja bez ANI JEDNEGO działu (ktoś zdjął portal w słowniku) ma zobaczyć
  // pustą listę, a nie całą firmę — `inArray` z pustą tablicą bywa w drizzle
  // wyjątkiem, więc warunek piszemy wprost.
  const inPortal =
    portal == null
      ? null
      : portalDepts.length > 0
        ? inArray(schema.hrHours.departmentId, portalDepts)
        : sql`0 = 1`;
  const rows = await db
    .select({
      hours: schema.hrHours,
      employeeName: schema.hrEmployees.fullName,
      objectName: schema.hrObjects.name,
      departmentRawName: schema.hrDepartments.name,
    })
    .from(schema.hrHours)
    .innerJoin(schema.hrEmployees, eq(schema.hrHours.employeeId, schema.hrEmployees.id))
    .leftJoin(schema.hrObjects, eq(schema.hrHours.objectId, schema.hrObjects.id))
    .leftJoin(
      schema.hrDepartments,
      eq(schema.hrHours.departmentId, schema.hrDepartments.id),
    )
    .where(
      and(
        eq(schema.hrHours.year, year),
        eq(schema.hrHours.month, month),
        ...(inPortal ? [inPortal] : []),
      ),
    )
    .orderBy(asc(schema.hrEmployees.fullName));
  // Nazwa firmy raz na odpowiedź, nie raz na wiersz — miesiąc potrafi mieć
  // kilkaset wpisów godzin.
  const { values } = getCompanyConfig();
  const prevByPair = withPrev ? await loadPrevHours(year, month, inPortal) : null;
  return rows.map((r) => ({
    ...r.hours,
    // Poprzedni miesiąc tej samej osoby na tym samym przypisaniu — `null`, gdy
    // wtedy jej tam nie było (nowy człowiek, przeniesiony posterunek).
    prev: prevByPair ? (prevByPair.get(carryOverPairKey(r.hours)) ?? null) : null,
    employeeName: r.employeeName,
    objectName: r.objectName ?? "",
    // GOTOWA etykieta („ALFA GROUP:Handlowy"), a nie sama nazwa: front Kadr nie
    // ma dostępu do `company.name` (app_settings za requireAdmin).
    departmentName:
      r.departmentRawName != null ? departmentLabel(r.departmentRawName, values) : "",
  }));
}

app.get("/hours", async (c) => {
  const ym = yearMonth(c);
  if ("error" in ym) return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  // `?portal=` — sekcja działowa. Konto bez pełnych Kadr MUSI go podać (inaczej
  // 403): „brak parametru” nie może znaczyć ani „pokaż wszystko”, ani cichego
  // zawężenia, bo jedno i drugie zgaduje za użytkownika.
  const scope = portalFromQuery(c, getUser(c));
  if (isDenial(scope)) {
    return c.json<ApiResponse<null>>({ success: false, error: scope.error }, scope.status);
  }
  return c.json({
    success: true,
    // `withPrev`: kolumna „pop.” w tabeli Godzin — wartości tej samej osoby na
    // tym samym przypisaniu z miesiąca poprzedniego (jedno dodatkowe zapytanie).
    data: await loadHoursRows(ym.year, ym.month, scope.portal, true),
  });
});

/**
 * SEKCJA ZAPISU (`?portal=`) — wspólna bramka czterech tras godzin.
 *
 * Zwraca gotową odpowiedź 400/403 albo sekcję, w której imieniu piszemy
 * (`null` = pełne Kadry, bez zawężenia). Konto sekcji bez parametru dostaje
 * 403: zapis „nie wiadomo gdzie” trafiłby w cudzy dział.
 */
function hoursWriteScope(
  c: Context,
): { portal: HrPortalKey | null } | { deny: Response } {
  const scope = writablePortalScope(c.req.query("portal"), getUser(c));
  if (isDenial(scope)) {
    return {
      deny: c.json<ApiResponse<null>>({ success: false, error: scope.error }, scope.status),
    };
  }
  return scope;
}

/**
 * Czy zapisywany WIERSZ należy do sekcji: dział wpisu i osoba. Dwa warunki,
 * bo to dwie różne dziury:
 *  - dział wpisu spoza sekcji = dopisanie godzin do cudzej listy,
 *  - pracownik spoza sekcji = wciągnięcie cudzego człowieka na swoją listę
 *    (a przy okazji ujawnienie, że taki w ogóle istnieje).
 *
 * „Pracownik sekcji" to `employeeIdsOfPortal` — dział z kartoteki ALBO wpis
 * godzin w tej sekcji. NIE sam dział z kartoteki: dyżury w CMA obsadza ochrona
 * obiektowa przypisana do OFI, więc wtedy sekcja CMA nie mogłaby zapisać ani
 * jednego ze swoich wierszy.
 */
function assertHoursRowInPortal(
  c: Context,
  portal: HrPortalKey | null,
  row: { employeeId?: number | null; departmentId?: number | null },
) {
  if (portal == null) return null;
  if (!departmentInPortal(row.departmentId, portal)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: outsidePortalError(portal) },
      403,
    );
  }
  if (row.employeeId != null && !employeeIdsOfPortal(portal).has(row.employeeId)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: employeeOutsidePortalError(portal) },
      403,
    );
  }
  return null;
}

app.post("/hours", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseHours(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  const outside = assertHoursRowInPortal(c, scope.portal, data);
  if (outside) return outside;
  // Portal wiersza godzin bierze się z jego DZIAŁU — rezerwacja sekcji OFI
  // blokuje wpisy OFI, a nie cały miesiąc.
  const locked = writeGuard(
    c,
    "hours",
    [portalOfDepartment(data.departmentId)],
    periodOf(data),
  );
  if (locked) return locked;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .insert(schema.hrHours)
      .values(data as NewHrHours)
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_hours",
      entityId: rows[0].id,
      user,
      employeeName: hrEmployeeName(tx, rows[0].employeeId),
      period: { year: rows[0].year, month: rows[0].month },
      after: rows[0],
    });
    return rows;
  });
  return c.json({ success: true, data: result[0], message: "Godziny dodane" }, 201);
});

/** Pola, które wolno ruszyć zapisem ZBIORCZYM (reszta zostaje po staremu). */
const BULK_HOURS_FIELDS = ["workedHours", "uwHours", "l4Hours", "nightHours"] as const;
type BulkHoursField = (typeof BULK_HOURS_FIELDS)[number];

/**
 * ZBIORCZY ZAPIS GODZIN — „Skopiuj z poprzedniego miesiąca” i „Wklej z arkusza”.
 *
 * MUSI stać PRZED `PUT /hours/:id`: Hono dopasowuje trasy w kolejności
 * rejestracji, więc `/hours/bulk` wpadłby w parametr `:id` i skończył się
 * czterysta-czwórką po `parseInt("bulk")`.
 *
 * Kształt: `{ year, month, rows: [{ id, workedHours?, uwHours?, l4Hours?,
 * nightHours? }], expected? }`. Pole nieobecne w wierszu zostaje NIETKNIĘTE —
 * wklejka z samą kolumną „wypracowane” nie ma czyścić urlopu i L4.
 * `expected` to opcjonalna mapa `id → updatedAt` (optymistyczna kontrola
 * współbieżności jak w `PUT /hours/:id`, tyle że na całą paczkę: rozjazd na
 * JEDNYM wierszu odrzuca CAŁE żądanie, bo połowicznie zapisana wklejka jest
 * gorsza niż żadna).
 *
 * Wszystko w jednej transakcji, maks. 500 wierszy, rezerwacja `writeGuard`
 * z portalami RUSZANYCH wierszy, a `?portal=` zawęża tak samo jak w pozostałych
 * trasach godzin (wiersz spoza sekcji = 403 na całość).
 */
app.put("/hours/bulk", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ym = parseYearMonth(body);
  if ("error" in ym) {
    return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  }
  const { year, month } = ym;
  const raw = Array.isArray(body.rows) ? body.rows : null;
  if (!raw || raw.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Brak wierszy do zapisania" },
      400,
    );
  }
  if (raw.length > 500) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo wierszy naraz (maks. 500)" },
      400,
    );
  }
  // Parsujemy CAŁOŚĆ przed zapisem (jak w `PUT /payroll/bulk`): błąd w 80.
  // wierszu po zapisaniu 79 poprzednich zostawiałby miesiąc w stanie, którego
  // nikt nie zamawiał.
  const parsed: Array<{ id: number; values: Partial<Record<BulkHoursField, number | null>> }> = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy wiersz" }, 400);
    }
    const row = item as Record<string, unknown>;
    const id = toNum(row.id);
    if (!id || !Number.isInteger(id) || id <= 0) {
      return c.json<ApiResponse<null>>({ success: false, error: "Wiersz bez wpisu (id)" }, 400);
    }
    if (seen.has(id)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Ten sam wpis godzin dwa razy na liście" },
        400,
      );
    }
    seen.add(id);
    const values: Partial<Record<BulkHoursField, number | null>> = {};
    for (const key of BULK_HOURS_FIELDS) {
      if (!(key in row)) continue;
      const { value, error } = optionalNum(row, key, HOURS_LABELS[key]);
      if (error) return c.json<ApiResponse<null>>({ success: false, error }, 400);
      if (value != null && value < 0) {
        return c.json<ApiResponse<null>>(
          { success: false, error: `${HOURS_LABELS[key]}: godziny nie mogą być ujemne` },
          400,
        );
      }
      values[key] = value;
    }
    if (Object.keys(values).length === 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Wiersz bez żadnej godziny do zapisania" },
        400,
      );
    }
    parsed.push({ id, values });
  }
  const expected =
    typeof body.expected === "object" && body.expected !== null
      ? (body.expected as Record<string, unknown>)
      : null;

  const ids = parsed.map((r) => r.id);
  const existingRows = db
    .select()
    .from(schema.hrHours)
    .where(inArray(schema.hrHours.id, ids))
    .all();
  const byId = new Map(existingRows.map((r) => [r.id, r]));
  if (existingRows.length !== ids.length) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu godzin z listy" },
      404,
    );
  }
  // Wszystkie wiersze MUSZĄ należeć do okresu z żądania: `writeGuard` blokuje
  // podany miesiąc, więc wiersz z innego przemknąłby obok zamknięcia okresu.
  const foreignPeriod = existingRows.find((r) => r.year !== year || r.month !== month);
  if (foreignPeriod) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Wpis z innego miesiąca na liście (${monthLabel(foreignPeriod.year, foreignPeriod.month)})`,
      },
      400,
    );
  }
  // Sekcja: dział ORAZ pracownik każdego wiersza. Jeden cudzy wpis odrzuca całą
  // paczkę — tak samo jak przy zbiorczym potwierdzaniu przypisań.
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  for (const r of existingRows) {
    const outside = assertHoursRowInPortal(c, scope.portal, r);
    if (outside) return outside;
  }
  const locked = writeGuard(c, "hours", portalsOfHoursIds(ids), { year, month });
  if (locked) return locked;
  // Kontrola współbieżności PRZED transakcją — 409 ma być odpowiedzią na całe
  // żądanie, a nie stanem po połowicznym zapisie.
  if (expected) {
    const stale = existingRows.find((r) => {
      const want = expected[String(r.id)];
      return typeof want === "string" && want !== r.updatedAt;
    });
    if (stale) {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error:
            "Wpis godzin został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie.",
        },
        409,
      );
    }
  }

  const user = getUser(c);
  const saved = db.transaction((tx) => {
    let count = 0;
    for (const r of parsed) {
      const existing = byId.get(r.id)!;
      // Bez zmiany = bez zapisu i bez wpisu w dzienniku: wklejka z arkusza
      // powtarza zwykle to, co już jest, a „zmiana" 8 → 8 zaśmieca historię.
      const changed = BULK_HOURS_FIELDS.some(
        (k) => k in r.values && (r.values[k] ?? null) !== (existing[k] ?? null),
      );
      if (!changed) continue;
      const [after] = tx
        .update(schema.hrHours)
        .set({ ...r.values, updatedAt: new Date().toISOString() })
        .where(eq(schema.hrHours.id, r.id))
        .returning()
        .all();
      // Diffy per wiersz tym samym helperem co zapis pojedynczy — historia
      // wpisu ma wyglądać identycznie bez względu na to, którędy przyszła.
      logHrUpdated(tx, {
        entityType: "hr_hours",
        entityId: r.id,
        user,
        employeeName: hrEmployeeName(tx, after.employeeId),
        period: { year: after.year, month: after.month },
        before: existing,
        after,
      });
      count += 1;
    }
    if (count > 0) {
      // JEDEN wpis zbiorczy na całą operację — oś czasu ma odpowiadać „skąd
      // wzięło się 140 zmian naraz", a nie tonąć w nich.
      logHrEvent(tx, {
        entityType: "hr_hours",
        entityId: 0,
        user,
        action: "updated",
        // Bez miesiąca w treści — `logHrEvent` dokłada go sam z `period`
        // (inaczej summary kończyłoby się dwoma „(wrzesień 2026)”).
        summary: `Zbiorczy zapis godzin: ${count} ${plHours(count)}`,
        period: { year, month },
      });
    }
    return count;
  });
  return c.json({
    success: true,
    data: { saved },
    message: `Zapisano godziny: ${saved}`,
  });
});

app.put("/hours/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrHours)
    .where(eq(schema.hrHours.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu godzin" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseHours(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Oba okresy: zamknięty jest i ten, z którego wiersz wychodzi, i ten, do
  // którego miałby trafić — przeniesienie godzin do rozliczonego miesiąca to
  // taka sama zmiana jego sum, jak wpisanie ich tam wprost.
  // Oba portale: dział sprzed edycji i po niej — przepięcie wpisu z OFI do CMA
  // dotyka obu sekcji, więc obie muszą być wolne dla piszącego.
  //
  // SEKCJA sprawdza oba wiersze z tego samego powodu: wpis wolno ruszyć tylko
  // wtedy, gdy i stan sprzed edycji, i po niej należy do niej. Inaczej dałoby
  // się wyprowadzić wiersz z cudzej listy albo go tam wstawić.
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  const outsideBefore = assertHoursRowInPortal(c, scope.portal, existing);
  if (outsideBefore) return outsideBefore;
  const outsideAfter = assertHoursRowInPortal(c, scope.portal, data);
  if (outsideAfter) return outsideAfter;
  const locked = writeGuard(
    c,
    "hours",
    [portalOfDepartment(existing.departmentId), portalOfDepartment(data.departmentId)],
    existing,
    periodOf(data),
  );
  if (locked) return locked;
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .update(schema.hrHours)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(
        expectedUpdatedAt
          ? and(
              eq(schema.hrHours.id, id),
              eq(schema.hrHours.updatedAt, expectedUpdatedAt),
            )
          : eq(schema.hrHours.id, id),
      )
      .returning()
      .all();
    if (rows.length > 0) {
      // Zapis inline z tabeli godzin idzie tą samą trasą, co formularz — jedno
      // miejsce logowania wystarcza na oba.
      logHrUpdated(tx, {
        entityType: "hr_hours",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        period: { year: rows[0].year, month: rows[0].month },
        before: existing,
        after: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wpis godzin został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({ success: true, data: result[0], message: "Godziny zapisane" });
});

/**
 * Klucz deduplikacji carry-over: (pracownik, przypisanie). Przypisanie to obiekt
 * ALBO dział, więc w kluczu muszą być oba id — z prefiksami `o`/`d`, żeby obiekt
 * nr 5 nie zlał się z działem nr 5. Jeden helper zamiast dwóch kopii wzoru:
 * rozjazd między nimi objawiłby się dopiero zdublowanymi wierszami godzin.
 */
const carryOverPairKey = (r: {
  employeeId: number;
  objectId: number | null;
  departmentId: number | null;
}) => `${r.employeeId}:o${r.objectId ?? ""}:d${r.departmentId ?? ""}`;

// Przeniesienie aktywnych pracowników z poprzedniego miesiąca: dla każdego
// wpisu godzin z miesiąca poprzedzającego (year, month) — o ile pracownik jest
// aktywny, a para (pracownik, przypisanie) nie istnieje jeszcze w miesiącu
// docelowym — tworzy pusty wpis z flagą objectUncertain (przypisanie do
// potwierdzenia). Kopiuje się zarówno obiekt, jak i dział.
// Idempotentny: ponowne wywołanie niczego nie dubluje. Uprawnienie edycji
// egzekwuje tabPermissionGuard (zapis na /hr/* wymaga poziomu "edit"),
// tak samo jak dla POST /hours.
//
// CO SIĘ PRZENOSI, a co nie:
//  - wiersz BEZ godzin (wypracowane, UW i L4 wszystkie puste/zero) — nie: to
//    najczęściej sam stub z poprzedniego carry-over, którego nikt nie wypełnił;
//    kopiowany dalej mnożyłby się miesiąc w miesiąc,
//  - wiersz „nic" (bez obiektu i bez działu) — nie: nie ma czego potwierdzać,
//  - wiersz na pozycji/dziale `active = 0` — nie: zdezaktywowane znika z listy
//    wyboru, więc stub wskazywałby coś, czego w selekcie nie ma.
// Całość w JEDNEJ synchronicznej transakcji: odczyt istniejących par i INSERT
// są atomowe, więc dwa carry-over odpalone naraz z dwóch kart nie zdublują
// wierszy (drugi widzi już wstawki pierwszego).
app.post("/hours/carry-over", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ym = parseYearMonth(body);
  if ("error" in ym) {
    return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  }
  const { year, month } = ym;
  // Sekcja działowa przenosi WYŁĄCZNIE swoje wiersze — i wystarcza jej
  // rezerwacja własnego portalu. Pełne Kadry przenoszą całość, więc jak dotąd
  // wymagają rezerwacji całej listy (i braku cudzych rezerwacji działowych).
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  const portalDepts = scope.portal == null ? null : departmentIdsOfPortal(scope.portal);
  // Blokujemy MIESIĄC DOCELOWY: przeniesienie zakłada w nim nowe wiersze.
  // Miesiąc źródłowy wolno mieć zamknięty — czytamy go, nie zmieniamy.
  const locked = writeGuard(
    c,
    "hours",
    scope.portal == null ? "all" : [scope.portal],
    { year, month },
  );
  if (locked) return locked;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const user = getUser(c);

  const inserted = db.transaction((tx) => {
    // Wpisy poprzedniego miesiąca — tylko aktywni pracownicy, tylko aktywne
    // przypisania (LEFT JOIN, bo wiersz wskazuje obiekt ALBO dział).
    const prevRows = tx
      .select({
        hours: schema.hrHours,
        objectActive: schema.hrObjects.active,
        departmentActive: schema.hrDepartments.active,
      })
      .from(schema.hrHours)
      .innerJoin(schema.hrEmployees, eq(schema.hrHours.employeeId, schema.hrEmployees.id))
      .leftJoin(schema.hrObjects, eq(schema.hrHours.objectId, schema.hrObjects.id))
      .leftJoin(schema.hrDepartments, eq(schema.hrHours.departmentId, schema.hrDepartments.id))
      .where(
        and(
          eq(schema.hrHours.year, prevYear),
          eq(schema.hrHours.month, prevMonth),
          eq(schema.hrEmployees.active, true),
        ),
      )
      .all();

    // Dedup: pary (pracownik, przypisanie) już obecne w miesiącu docelowym
    const existing = tx
      .select({
        employeeId: schema.hrHours.employeeId,
        objectId: schema.hrHours.objectId,
        departmentId: schema.hrHours.departmentId,
      })
      .from(schema.hrHours)
      .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month)))
      .all();
    const seen = new Set(existing.map(carryOverPairKey));

    const toInsert: NewHrHours[] = [];
    for (const { hours: prev, objectActive, departmentActive } of prevRows) {
      // Sekcja przenosi tylko SWOJE wiersze — inaczej „Przenieś z poprzedniego
      // miesiąca” w CMA zakładałoby stuby ochrony obiektowej.
      if (portalDepts && (prev.departmentId == null || !portalDepts.includes(prev.departmentId)))
        continue;
      if (prev.objectId == null && prev.departmentId == null) continue;
      if (prev.objectId != null && objectActive === false) continue;
      if (prev.departmentId != null && departmentActive === false) continue;
      const hasHours =
        (prev.workedHours ?? 0) > 0 || (prev.uwHours ?? 0) > 0 || (prev.l4Hours ?? 0) > 0;
      if (!hasHours) continue;
      const key = carryOverPairKey(prev);
      if (seen.has(key)) continue;
      seen.add(key);
      toInsert.push({
        employeeId: prev.employeeId,
        objectId: prev.objectId,
        departmentId: prev.departmentId,
        objectUncertain: true,
        year,
        month,
        nightHours: null,
        workedHours: null,
        uwHours: null,
        l4Hours: null,
        maxHours: null,
        deductions: null,
        bonuses: null,
        notes: "",
      });
    }
    if (toInsert.length > 0) {
      tx.insert(schema.hrHours).values(toInsert).run();
      // JEDEN wpis na całą operację, nie N: dziennik ma odpowiedzieć „skąd wzięło
      // się 130 wierszy”, a nie zasypać miesiąc stu trzydziestoma zdarzeniami.
      logHrEvent(tx, {
        entityType: "hr_hours",
        entityId: 0,
        user,
        action: "created",
        summary: `Przeniesiono ${toInsert.length} ${plHours(toInsert.length)} godzin z ${monthLabelGen(prevYear, prevMonth)}`,
        period: { year, month },
      });
    }
    return toInsert.length;
  });
  return c.json({ success: true, data: { inserted } });
});

/**
 * Zbiorcze potwierdzenie przypisań przeniesionych przez carry-over: zdejmuje
 * `objectUncertain` (pytajnik „?" przy obiekcie/dziale) z podanych wpisów.
 * Po carry-over miesiąc ma ~130 takich wierszy, a pojedyncze potwierdzanie
 * wymagało zapisania każdego wpisu z osobna. Idempotentny — wpisy już
 * potwierdzone po prostu nie zmieniają stanu i nie liczą się do wyniku.
 */
app.post("/hours/confirm-assignments", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const raw = Array.isArray(body.ids) ? body.ids : null;
  if (!raw || raw.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagana lista wpisów (ids)" },
      400,
    );
  }
  const ids = [
    ...new Set(
      raw
        .map((v) => toNum(v))
        .filter((v): v is number => v != null && Number.isInteger(v) && v > 0),
    ),
  ];
  if (ids.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagana lista wpisów (ids)" },
      400,
    );
  }
  // Sekcja potwierdza wyłącznie SWOJE wpisy. Sprawdzamy wszystkie wskazane id
  // naraz (jedno zapytanie) — żądanie z jednym cudzym wierszem jest odrzucane
  // w całości, żeby nie zostawiać połowicznego wyniku.
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  if (scope.portal != null) {
    const portalDepts = departmentIdsOfPortal(scope.portal);
    const foreign = db
      .select({ id: schema.hrHours.id, departmentId: schema.hrHours.departmentId })
      .from(schema.hrHours)
      .where(inArray(schema.hrHours.id, ids))
      .all()
      .some((r) => r.departmentId == null || !portalDepts.includes(r.departmentId));
    if (foreign) {
      return c.json<ApiResponse<null>>(
        { success: false, error: outsidePortalError(scope.portal) },
        403,
      );
    }
  }
  // Potwierdzenie przypisania zmienia wiersze godzin, więc podlega tej samej
  // blokadzie — okresy bierzemy z samych wskazanych wpisów (żądanie ich nie podaje).
  const periods = db
    .selectDistinct({ year: schema.hrHours.year, month: schema.hrHours.month })
    .from(schema.hrHours)
    .where(inArray(schema.hrHours.id, ids))
    .all();
  const locked = writeGuard(c, "hours", portalsOfHoursIds(ids), ...periods);
  if (locked) return locked;
  const user = getUser(c);
  const confirmed = db.transaction((tx) => {
    // Tylko wiersze faktycznie niepotwierdzone — inaczej licznik i wpis
    // w dzienniku mówiłyby o zmianie, której nie było.
    const rows = tx
      .select({
        id: schema.hrHours.id,
        year: schema.hrHours.year,
        month: schema.hrHours.month,
      })
      .from(schema.hrHours)
      .where(
        and(
          inArray(schema.hrHours.id, ids),
          eq(schema.hrHours.objectUncertain, true),
        ),
      )
      .all();
    if (rows.length === 0) return 0;
    tx.update(schema.hrHours)
      .set({ objectUncertain: false, updatedAt: new Date().toISOString() })
      .where(inArray(schema.hrHours.id, rows.map((r) => r.id)))
      .run();
    // JEDEN wpis per MIESIĄC, a nie jeden na całą operację z miesiącem
    // PIERWSZEGO wiersza: `ids` przychodzą z zaznaczenia w tabeli i nic nie
    // gwarantuje, że należą do jednego okresu — a wpis podpisany cudzym
    // miesiącem jest gorszy niż brak wpisu. Przy okazji idzie przez `logHrEvent`
    // (jak carry-over), więc niesie `period` i wpada do filtra okresu dziennika.
    for (const p of groupPeriods(rows)) {
      logHrEvent(tx, {
        entityType: "hr_hours",
        entityId: 0,
        user,
        action: "updated",
        summary: `Potwierdzono przypisanie ${p.count} ${plHours(p.count)} godzin`,
        period: { year: p.year, month: p.month },
      });
    }
    return rows.length;
  });
  return c.json({ success: true, data: { confirmed } });
});

app.delete("/hours/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  // Okres bierzemy z wiersza PRZED usunięciem — po `delete` nie ma już czego
  // pytać o miesiąc.
  const existing = db
    .select({
      year: schema.hrHours.year,
      month: schema.hrHours.month,
      // Dział wiersza — po nim rozstrzyga się, czyja rezerwacja pokrywa
      // to usunięcie (sekcja działu czy pełne Kadry).
      departmentId: schema.hrHours.departmentId,
      employeeId: schema.hrHours.employeeId,
    })
    .from(schema.hrHours)
    .where(eq(schema.hrHours.id, id))
    .get();
  // Sekcja kasuje wyłącznie wiersze swojego działu. Wiersz nieistniejący
  // przechodzi dalej i kończy się 404 — inaczej odpowiedź zdradzałaby, czy
  // wpis o tym id w ogóle jest (i w czyim dziale).
  const scope = hoursWriteScope(c);
  if ("deny" in scope) return scope.deny;
  if (existing) {
    const outside = assertHoursRowInPortal(c, scope.portal, existing);
    if (outside) return outside;
  }
  const locked = writeGuard(
    c,
    "hours",
    [portalOfDepartment(existing?.departmentId)],
    existing,
  );
  if (locked) return locked;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrHours)
      .where(eq(schema.hrHours.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, {
        entityType: "hr_hours",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        period: { year: rows[0].year, month: rows[0].month },
        before: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu godzin" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Wpis godzin usunięty" });
});

// ==================== UMOWY ====================

/**
 * Spółka umowy pochodzi ze słownika spółek (tabela `companies`), z którym kadry
 * wiążą się po NAZWIE. Sprawdzamy istnienie nazwy, żeby literówka nie utworzyła
 * "spółki widmo" niewidocznej w zestawieniach. Wiersze historyczne ze spółką
 * spoza słownika da się zapisać dalej — pod warunkiem, że pole nie było ruszane.
 */
async function companyInDictionary(name: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.name, name));
  return rows.length > 0;
}

const UNKNOWN_COMPANY_ERROR =
  "Spółka spoza słownika — dodaj ją najpierw w zakładce Spółki";

/**
 * Daty okresu obowiązywania z ciała żądania. Pusty napis, `null` i brak klucza
 * znaczą to samo: bezterminowo z tej strony (NULL w bazie).
 */
function parsePeriod(
  body: Record<string, unknown>,
): { validFrom: string | null; validTo: string | null } | { error: string } {
  const read = (
    v: unknown,
    label: string,
  ): { value: string | null } | { error: string } => {
    if (typeof v !== "string" || v.trim() === "") return { value: null };
    const s = v.trim();
    if (!isIsoDate(s)) {
      return { error: `Pole „${label}” ma niepoprawną datę (format RRRR-MM-DD)` };
    }
    return { value: s };
  };
  const from = read(body.validFrom, "obowiązuje od");
  if ("error" in from) return { error: from.error };
  const to = read(body.validTo, "obowiązuje do");
  if ("error" in to) return { error: to.error };
  if (from.value && to.value && from.value > to.value) {
    return {
      error:
        "Data „obowiązuje od” jest późniejsza niż „obowiązuje do” — taka umowa nie obowiązywałaby w żadnym dniu",
    };
  }
  return { validFrom: from.value, validTo: to.value };
}

function parseContract(body: Record<string, unknown>): {
  data?: Partial<NewHrContract>;
  error?: string;
} {
  const employeeId = toNum(body.employeeId);
  const company = typeof body.company === "string" ? body.company.trim() : "";
  if (!employeeId) return { error: "Pracownik jest wymagany" };
  if (!company) return { error: "Spółka jest wymagana" };
  const contractType = body.contractType === "praca" ? "praca" : "zlecenie";
  const mainChannel = body.mainChannel === "gotowka" ? "gotowka" : "przelew";
  const bonusTypes = ["brak", "gotowka", "delegacja_przelew", "delegacja_gotowka"];
  const bonusType = bonusTypes.includes(body.bonusType as string)
    ? (body.bonusType as NewHrContract["bonusType"])
    : "brak";
  // OKRES OBOWIĄZYWANIA (migracja 0112). Puste pole = bezterminowo, więc pusty
  // napis i brak klucza znaczą to samo — NULL. Data musi być kalendarzowa
  // („2026-02-31” przechodzi wzorzec, a nie istnieje), a początek nie może być
  // po końcu: umowa „od 01.12 do 30.11” nie obowiązywałaby nigdy i cicho
  // zniknęłaby z każdego miesiąca.
  const period = parsePeriod(body);
  if ("error" in period) return { error: period.error };
  return {
    data: {
      employeeId,
      company,
      contractType,
      validFrom: period.validFrom,
      validTo: period.validTo,
      chor: Boolean(body.chor),
      zua: typeof body.zua === "string" ? body.zua.trim() : "",
      zza: typeof body.zza === "string" ? body.zza.trim() : "",
      zwua: typeof body.zwua === "string" ? body.zwua.trim() : "",
      objectName: typeof body.objectName === "string" ? body.objectName.trim() : "",
      mainChannel,
      bonusType,
      active: body.active === undefined ? true : Boolean(body.active),
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  };
}

app.get("/contracts", async (c) => {
  const onlyActive = c.req.query("active") === "true";
  const rows = await db
    .select({
      contract: schema.hrContracts,
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.hrContracts)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrContracts.employeeId, schema.hrEmployees.id),
    )
    .orderBy(asc(schema.hrEmployees.fullName), asc(schema.hrContracts.id));
  // Status liczy SERWER, nie przeglądarka: „dziś” w Kadrach to dzień firmy,
  // a nie zegar laptopa użytkownika (i nie strefa, w której akurat siedzi).
  const today = todayIso();
  let data = rows.map((r) => ({
    ...r.contract,
    employeeName: r.employeeName,
    status: contractStatus(r.contract, today),
  }));
  if (onlyActive) data = data.filter((r) => r.active);
  return c.json({ success: true, data });
});

/**
 * UMOWY DO PRZEDŁUŻENIA — `GET /hr/contracts/expiring?days=30`.
 *
 * Dwie listy w jednej, bo w kadrach to jedno zadanie („komu kończy się umowa”):
 *  - `konczaca` — `valid_to` wypada w ciągu najbliższych N dni,
 *  - `zakonczona` — `valid_to` już minął, a nikt nie podpisał następnej.
 *
 * NASTĘPCZYNI to inna umowa TEJ SAMEJ osoby w TEJ SAMEJ spółce, która jest
 * aktywna albo dopiero wejdzie w życie (status „aktywna” / „przyszła”).
 * Umowa z następczynią znika z listy także w grupie „kończąca się” — została
 * przedłużona, więc nie ma o czym przypominać.
 *
 * Ręcznie wyłączone umowy (`active = 0`) nie przypominają o sobie wcale:
 * wyłącznik jest świadomą decyzją („tej umowy nie liczymy”), a nie zaległością.
 */
app.get("/contracts/expiring", async (c) => {
  const raw = Number(c.req.query("days") ?? 30);
  const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 365) : 30;
  const today = todayIso();
  const horizon = shiftIsoDate(today, days);
  const rows = await db
    .select({
      contract: schema.hrContracts,
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.hrContracts)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrContracts.employeeId, schema.hrEmployees.id),
    )
    .orderBy(asc(schema.hrEmployees.fullName), asc(schema.hrContracts.id));

  const hasSuccessor = (ct: (typeof rows)[number]["contract"]) =>
    rows.some((other) => {
      const o = other.contract;
      if (o.id === ct.id) return false;
      if (o.employeeId !== ct.employeeId || o.company !== ct.company) return false;
      const st = contractStatus(o, today);
      return st === "aktywna" || st === "przyszła";
    });

  const data = rows
    .filter((r) => r.contract.active && r.contract.validTo)
    .map((r) => {
      const ct = r.contract;
      const validTo = ct.validTo as string;
      const reason: "konczaca" | "zakonczona" =
        validTo < today ? "zakonczona" : "konczaca";
      return {
        ...ct,
        employeeName: r.employeeName,
        status: contractStatus(ct, today),
        // Ujemne = tyle dni temu się skończyła.
        daysLeft: daysBetween(today, validTo),
        reason,
        hasSuccessor: hasSuccessor(ct),
        periodLabel: periodLabelPl(ct),
      };
    })
    .filter((r) => !r.hasSuccessor)
    .filter((r) => (r.reason === "konczaca" ? (r.validTo as string) <= horizon : true))
    .sort((a, b) => (a.validTo as string).localeCompare(b.validTo as string));

  return c.json({
    success: true,
    data,
    meta: {
      days,
      today,
      konczace: data.filter((r) => r.reason === "konczaca").length,
      zakonczone: data.filter((r) => r.reason === "zakonczona").length,
    },
  });
});

app.post("/contracts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseContract(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  if (!(await companyInDictionary(data.company as string))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: UNKNOWN_COMPANY_ERROR },
      400,
    );
  }
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .insert(schema.hrContracts)
      .values(data as NewHrContract)
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_contract",
      entityId: rows[0].id,
      user,
      employeeName: hrEmployeeName(tx, rows[0].employeeId),
      after: rows[0],
    });
    return rows;
  });
  return c.json({ success: true, data: result[0], message: "Umowa dodana" }, 201);
});

app.put("/contracts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseContract(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Zmiana spółki musi trafić w słownik; zostawienie starej (historycznej)
  // wartości bez zmian nie blokuje edycji pozostałych pól.
  if (
    data.company !== existing.company &&
    !(await companyInDictionary(data.company as string))
  ) {
    return c.json<ApiResponse<null>>(
      { success: false, error: UNKNOWN_COMPANY_ERROR },
      400,
    );
  }
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .update(schema.hrContracts)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(
        expectedUpdatedAt
          ? and(
              eq(schema.hrContracts.id, id),
              eq(schema.hrContracts.updatedAt, expectedUpdatedAt),
            )
          : eq(schema.hrContracts.id, id),
      )
      .returning()
      .all();
    if (rows.length > 0) {
      logHrUpdated(tx, {
        entityType: "hr_contract",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        before: existing,
        after: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Umowa została zmieniona przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({ success: true, data: result[0], message: "Umowa zapisana" });
});

/**
 * ZMIANA WARUNKÓW — `POST /hr/contracts/:id/supersede { validFrom, ...pola }`.
 *
 * Zmiana stawki czy rodzaju dodatku w trakcie roku to NIE edycja umowy: sierpień
 * ma się dalej liczyć na starych warunkach, wrzesień na nowych. Nadpisanie
 * wiersza przeliczyłoby wstecz wszystkie zamknięte miesiące, a ręczne robienie
 * tego w dwóch krokach (dopisz nową, wróć i skróć starą) zostawiało po drodze
 * stan, w którym obie umowy obowiązują naraz albo żadna.
 *
 * Dlatego jedna transakcja: bieżąca dostaje `valid_to` = dzień przed startem
 * nowej, nowa powstaje z jej danymi i własnym `valid_from`. Dwa wpisy
 * w dzienniku, bo to dwie zmiany — skrócenie starej i utworzenie nowej.
 */
app.post("/contracts/:id/supersede", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const validFrom =
    typeof body.validFrom === "string" ? body.validFrom.trim() : "";
  if (!isIsoDate(validFrom)) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Podaj datę, od której obowiązuje nowa umowa (RRRR-MM-DD)",
      },
      400,
    );
  }
  if (existing.validFrom && validFrom <= existing.validFrom) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Nowa umowa musi zaczynać się po rozpoczęciu bieżącej (${periodLabelPl(existing)})`,
      },
      400,
    );
  }
  // Pola nowej umowy: dane bieżącej, nadpisane tym, co przyszło z formularza.
  // `employeeId` zostaje zawsze z bieżącej — zmiana warunków nie przenosi
  // umowy na inną osobę (na to jest zwykłe „Dodaj umowę”).
  const { data, error } = parseContract({
    company: existing.company,
    contractType: existing.contractType,
    chor: existing.chor,
    zua: existing.zua,
    zza: existing.zza,
    zwua: existing.zwua,
    objectName: existing.objectName,
    mainChannel: existing.mainChannel,
    bonusType: existing.bonusType,
    notes: existing.notes,
    active: true,
    ...body,
    employeeId: existing.employeeId,
    validFrom,
  });
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  if (
    data.company !== existing.company &&
    !(await companyInDictionary(data.company as string))
  ) {
    return c.json<ApiResponse<null>>(
      { success: false, error: UNKNOWN_COMPANY_ERROR },
      400,
    );
  }
  // Bieżąca kończy się dzień przed startem nowej — chyba że skończyła się
  // jeszcze wcześniej (przerwa w zatrudnieniu): wtedy jej data zostaje, bo
  // „zamknięcie” nie może umowy PRZEDŁUŻYĆ.
  const cutoff = dayBefore(validFrom);
  const newValidTo =
    existing.validTo && existing.validTo < cutoff ? existing.validTo : cutoff;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const employeeName = hrEmployeeName(tx, existing.employeeId);
    const updated = tx
      .update(schema.hrContracts)
      .set({ validTo: newValidTo, updatedAt: new Date().toISOString() })
      .where(eq(schema.hrContracts.id, id))
      .returning()
      .all();
    if (updated.length > 0 && existing.validTo !== newValidTo) {
      logHrUpdated(tx, {
        entityType: "hr_contract",
        entityId: id,
        user,
        employeeName,
        before: existing,
        after: updated[0],
      });
    }
    const created = tx
      .insert(schema.hrContracts)
      .values(data as NewHrContract)
      .returning()
      .all();
    logHrCreated(tx, {
      entityType: "hr_contract",
      entityId: created[0].id,
      user,
      employeeName,
      after: created[0],
    });
    return { previous: updated[0], created: created[0] };
  });
  return c.json(
    {
      success: true,
      data: result,
      message: `Nowa umowa od ${formatDatePl(validFrom)} — poprzednia obowiązuje do ${formatDatePl(newValidTo)}`,
    },
    201,
  );
});

app.delete("/contracts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const user = getUser(c);
  // `hr_payroll.contract_id` jest ON DELETE CASCADE — wypłaty umowy znikają
  // razem z nią, więc zamknięty miesiąc blokuje kasowanie (jak przy pracowniku).
  const payroll = contractMonthlyImpact(id);
  const closed = closedPeriodLabels(payroll);
  if (closed.length > 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: CLOSED_CASCADE_ERROR("razem z umową zniknęłyby wypłaty", closed),
      },
      423,
    );
  }
  const cascade = impactPart("wypłaty", payroll);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrContracts)
      .where(eq(schema.hrContracts.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, {
        entityType: "hr_contract",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        before: rows[0],
        cascade,
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Umowa usunięta" });
});

// ==================== WYNAGRODZENIA (kalkulacja) ====================

/**
 * Podstawiane wejścia płacowe JEDNEJ umowy — używane przez `POST /payroll/preview`.
 * Podgląd na żywo w dialogu wypłaty musi liczyć się DOKŁADNIE tą samą funkcją,
 * co zapis; odwzorowanie wzorów w JS front-endu rozjechałoby się przy pierwszej
 * zmianie reguły (a reguł jest tu kilkanaście: maks, ZZA, kanały, premia).
 */
type PayrollOverride = {
  contractId: number;
  values: Pick<
    typeof schema.hrPayroll.$inferSelect,
    | "mainAmount"
    | "bonusRate"
    | "bonusRatePending"
    | "rateAdjustment"
    | "maxHoursOverride"
    | "actualHoursOverride"
    | "bonusAmountOverride"
  >;
};

// Wiersze płacowe miesiąca: umowa + wejścia ręczne + wartości wyliczone
async function computeMonth(
  year: number,
  month: number,
  override?: PayrollOverride,
) {
  const [contracts, payrollRows, hoursRows, norms] = await Promise.all([
    db
      .select({
        contract: schema.hrContracts,
        employeeName: schema.hrEmployees.fullName,
      })
      .from(schema.hrContracts)
      .innerJoin(
        schema.hrEmployees,
        eq(schema.hrContracts.employeeId, schema.hrEmployees.id),
      )
      .orderBy(asc(schema.hrEmployees.fullName), asc(schema.hrContracts.id)),
    db
      .select()
      .from(schema.hrPayroll)
      .where(and(eq(schema.hrPayroll.year, year), eq(schema.hrPayroll.month, month))),
    db
      .select()
      .from(schema.hrHours)
      .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month))),
    getNorms(year, month),
  ]);

  const payrollByContract = new Map(payrollRows.map((p) => [p.contractId, p]));
  if (override) {
    // Podgląd: wejścia z formularza zamiast zapisanych. Wiersz-widmo (gdy w bazie
    // nic jeszcze nie ma) dostaje neutralne pola techniczne — kalkulacja ich nie
    // czyta, ale typ rekordu jest pełny.
    const base = payrollByContract.get(override.contractId);
    payrollByContract.set(override.contractId, {
      id: base?.id ?? 0,
      contractId: override.contractId,
      year,
      month,
      notes: base?.notes ?? "",
      createdAt: base?.createdAt ?? "",
      updatedAt: base?.updatedAt ?? "",
      ...override.values,
    });
  }
  // Umowy miesiąca: aktywne i OBOWIĄZUJĄCE w tym miesiącu (okres `valid_from` /
  // `valid_to` przecina miesiąc — umowa od 15.09 liczy się we wrześniu w całości,
  // bo miesiąc jest najmniejszą jednostką rozliczenia) + wszystkie, które mają
  // wpis płacowy w tym miesiącu. Ten drugi warunek trzyma historię: umowa
  // zakończona 31.08 znika z września, ale jeśli komuś zapisano na niej kwotę,
  // wiersz zostaje — z ostrzeżeniem z `computePayroll`, a nie po cichu.
  const relevant = contracts.filter(
    (r) =>
      (r.contract.active && contractCoversMonth(r.contract, year, month)) ||
      payrollByContract.has(r.contract.id),
  );
  const hoursByEmployee = buildHoursAggregates(hoursRows);

  const computed = computePayroll({
    contracts: relevant.map((r) => r.contract),
    payrollByContract,
    hoursByEmployee,
    workNorm: norms.workNorm,
    contractNorm: norms.contractNorm,
    year,
    month,
  });
  const computedByContract = new Map<number, PayrollComputed>(
    computed.map((r) => [r.contractId, r]),
  );

  return relevant.map((r) => {
    const p = payrollByContract.get(r.contract.id);
    const calc = computedByContract.get(r.contract.id)!;
    return {
      ...calc,
      employeeName: r.employeeName,
      company: r.contract.company,
      contractType: r.contract.contractType,
      chor: r.contract.chor,
      zua: r.contract.zua,
      zza: r.contract.zza,
      objectName: r.contract.objectName,
      mainChannel: r.contract.mainChannel,
      bonusType: r.contract.bonusType,
      contractActive: r.contract.active,
      inputs: {
        mainAmount: p?.mainAmount ?? null,
        bonusRate: p?.bonusRate ?? null,
        bonusRatePending: p?.bonusRatePending ?? false,
        rateAdjustment: p?.rateAdjustment ?? null,
        maxHoursOverride: p?.maxHoursOverride ?? null,
        actualHoursOverride: p?.actualHoursOverride ?? null,
        bonusAmountOverride: p?.bonusAmountOverride ?? null,
        notes: p?.notes ?? "",
      },
      normsFromDb: norms.fromDb,
    };
  });
}

app.get("/payroll", async (c) => {
  const ym = yearMonth(c);
  if ("error" in ym) return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  const { year, month } = ym;
  const data = await computeMonth(year, month);
  return c.json({ success: true, data });
});

// Upsert wejść płacowych umowy na miesiąc (kwoty od księgowości, stawki, nadpisania)
app.put("/payroll", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const contractId = toNum(body.contractId);
  if (!contractId || !Number.isInteger(contractId) || contractId <= 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagana umowa" },
      400,
    );
  }
  // Ten sam warunek okresu, co w `/payroll/bulk` i `/payroll/preview` — patrz
  // `parseYearMonth`. Wcześniej strażnik rezerwacji listy przypadkiem zasłaniał
  // tę dziurę (rezerwacji na `month = 9.5` nie da się wziąć), ale to blokada
  // współbieżności, a nie walidacja danych.
  const ym = parseYearMonth(body);
  if ("error" in ym) {
    return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  }
  const { year, month } = ym;
  const [contract] = await db
    .select()
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, contractId));
  if (!contract) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  // Portal wypłaty bierze się z DZIAŁU PRACOWNIKA w kartotece (umowa sama
  // działu nie ma) — wiersz osoby bez działu pokrywa tylko rezerwacja całości.
  const locked = writeGuard(
    c,
    "payroll",
    [portalOfEmployee(contract.employeeId)],
    { year, month },
  );
  if (locked) return locked;
  // Nieparsowalna kwota → 400 z nazwą pola (patrz `optionalNum`), nie ciche null.
  const nums = parseNumericFields(body, {
    mainAmount: "Kwota główna",
    bonusRate: "Stawka dodatku",
    rateAdjustment: "Korekta stawki",
    maxHoursOverride: "Godziny maks. (nadpisanie)",
    actualHoursOverride: "Godziny faktyczne (nadpisanie)",
    bonusAmountOverride: "Kwota dodatku (nadpisanie)",
  });
  if (nums.error || !nums.data) {
    return c.json<ApiResponse<null>>({ success: false, error: nums.error }, 400);
  }
  const values = {
    ...nums.data,
    bonusRatePending: Boolean(body.bonusRatePending),
    notes: typeof body.notes === "string" ? body.notes : "",
  };
  // Upsert w jednej synchronicznej transakcji — select i insert/update są
  // atomowe, więc równoległe PUT /payroll dla tego samego (umowa, rok, miesiąc)
  // nie wstawią dwóch wierszy płacowych (co po cichu gubiłoby wpisy księgowości).
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.hrPayroll)
      .where(
        and(
          eq(schema.hrPayroll.contractId, contractId),
          eq(schema.hrPayroll.year, year),
          eq(schema.hrPayroll.month, month),
        ),
      )
      .get();
    // entityId = id UMOWY, nie wiersza wejść: wiersz `hr_payroll` powstaje dopiero
    // przy pierwszym zapisie miesiąca, a historia ma się kleić do umowy. Miesiąc
    // odróżnia dopisek „(wrzesień 2026)” w summary (patrz src/lib/hr-activity.ts).
    const logCtx = {
      entityType: "hr_payroll" as const,
      entityId: contractId,
      user,
      employeeName: hrEmployeeName(tx, contract.employeeId),
      period: { year, month },
    };
    if (existing) {
      const rows = tx
        .update(schema.hrPayroll)
        .set({ ...values, updatedAt: new Date().toISOString() })
        .where(eq(schema.hrPayroll.id, existing.id))
        .returning()
        .all();
      logHrUpdated(tx, { ...logCtx, before: existing, after: values });
      return rows;
    }
    const rows = tx
      .insert(schema.hrPayroll)
      .values({ contractId, year, month, ...values })
      .returning()
      .all();
    logHrCreated(tx, { ...logCtx, after: rows[0] });
    return rows;
  });
  // Odpowiedź to PRZELICZONY wiersz (ten sam kształt, co w GET /payroll), a nie
  // sam rekord wejść: tabela wypłat wpisuje kwoty komórka po komórce i po każdym
  // zapisie musi pokazać stawkę, dodatek i wypłatę — bez tego jedyną drogą byłoby
  // przeładowanie całego miesiąca (147 umów) po każdej wpisanej liczbie.
  const rows = await computeMonth(year, month);
  const computed = rows.find((r) => r.contractId === contractId) ?? null;
  return c.json({
    success: true,
    data: computed ?? result[0],
    message: "Dane płacowe zapisane",
  });
});

/**
 * ZBIORCZY zapis kwot głównych — „Wklej z arkusza" w Wynagrodzeniach.
 * Księgowość przysyła kwoty listą (arkusz albo wydruk), a wpisywanie ich po
 * jednej to 147 osobnych żądań i 147 wpisów w dzienniku. Tutaj: jedna
 * transakcja, jeden wpis zbiorczy w dzienniku + diff per umowa (żeby historia
 * pojedynczej umowy dalej pokazywała, skąd wzięła się jej kwota).
 *
 * Dotyka WYŁĄCZNIE kwoty głównej: stawka dodatku, nadpisania i notatka
 * zostają nietknięte, bo wklejana lista nic o nich nie mówi.
 */
app.put("/payroll/bulk", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ym = parseYearMonth(body);
  if ("error" in ym) {
    return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  }
  const { year, month } = ym;
  // Wklejka z arkusza dotyka dowolnych wierszy listy — jak przeniesienie
  // z poprzedniego miesiąca wymaga więc rezerwacji CAŁOŚCI.
  const locked = writeGuard(c, "payroll", "all", { year, month });
  if (locked) return locked;
  const raw = Array.isArray(body.rows) ? body.rows : null;
  if (!raw || raw.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Brak wierszy do zapisania" },
      400,
    );
  }
  if (raw.length > 500) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo wierszy naraz (maks. 500)" },
      400,
    );
  }
  // Parsujemy CAŁOŚĆ przed zapisem: wklejka ma wejść w komplecie albo wcale,
  // inaczej po błędzie w 80. wierszu nie wiadomo, co już siedzi w bazie.
  const parsed: Array<{ contractId: number; mainAmount: number | null }> = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy wiersz" }, 400);
    }
    const row = item as Record<string, unknown>;
    const contractId = toNum(row.contractId);
    if (!contractId) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Wiersz bez umowy (contractId)" },
        400,
      );
    }
    if (seen.has(contractId)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Ta sama umowa dwa razy na liście" },
        400,
      );
    }
    seen.add(contractId);
    const { value, error } = optionalNum(row, "mainAmount", "Kwota główna");
    if (error) return c.json<ApiResponse<null>>({ success: false, error }, 400);
    parsed.push({ contractId, mainAmount: value });
  }

  const user = getUser(c);
  const outcome = db.transaction((tx) => {
    const contracts = tx
      .select()
      .from(schema.hrContracts)
      .where(inArray(schema.hrContracts.id, parsed.map((r) => r.contractId)))
      .all();
    const byId = new Map(contracts.map((ct) => [ct.id, ct]));
    const missing = parsed.filter((r) => !byId.has(r.contractId));
    if (missing.length > 0) return { error: "Nie znaleziono umowy z listy" } as const;

    let saved = 0;
    for (const r of parsed) {
      const contract = byId.get(r.contractId)!;
      const existing = tx
        .select()
        .from(schema.hrPayroll)
        .where(
          and(
            eq(schema.hrPayroll.contractId, r.contractId),
            eq(schema.hrPayroll.year, year),
            eq(schema.hrPayroll.month, month),
          ),
        )
        .get();
      if (existing && existing.mainAmount === r.mainAmount) continue; // bez zmiany
      const logCtx = {
        entityType: "hr_payroll" as const,
        entityId: r.contractId,
        user,
        employeeName: hrEmployeeName(tx, contract.employeeId),
        period: { year, month },
      };
      if (existing) {
        tx.update(schema.hrPayroll)
          .set({ mainAmount: r.mainAmount, updatedAt: new Date().toISOString() })
          .where(eq(schema.hrPayroll.id, existing.id))
          .run();
        logHrUpdated(tx, {
          ...logCtx,
          before: existing,
          after: { mainAmount: r.mainAmount },
        });
      } else {
        const [created] = tx
          .insert(schema.hrPayroll)
          .values({
            contractId: r.contractId,
            year,
            month,
            mainAmount: r.mainAmount,
            bonusRatePending: false,
            notes: "",
          })
          .returning()
          .all();
        logHrCreated(tx, { ...logCtx, after: created });
      }
      saved += 1;
    }
    if (saved > 0) {
      // Wpis zbiorczy — w osi czasu ma być widać JEDNO zdarzenie „wklejono
      // kwoty", a nie 147 zmian bez wspólnego mianownika.
      logActivity(tx, {
        entityType: "hr_payroll",
        entityId: 0,
        user,
        action: "updated",
        summary: `Wklejono kwoty główne dla ${saved} umów (${monthLabel(year, month)})`,
      });
    }
    return { saved } as const;
  });
  if ("error" in outcome) {
    return c.json<ApiResponse<null>>({ success: false, error: outcome.error }, 404);
  }
  // Odpowiedź to przeliczony CAŁY miesiąc: wklejka rusza kilkadziesiąt wierszy
  // naraz, więc front i tak podmienia całą tabelę.
  const rows = await computeMonth(year, month);
  return c.json({
    success: true,
    data: { saved: outcome.saved, rows },
    message: `Zapisano kwoty: ${outcome.saved}`,
  });
});

/**
 * Podgląd kalkulacji BEZ zapisu — dla dialogu wypłaty, który po wpisaniu kwoty
 * głównej pokazuje wyliczoną stawkę netto i szacowaną wypłatę. Ta sama funkcja
 * kalkulacji co przy zapisie, więc podgląd nie może rozjechać się z wynikiem.
 */
app.post("/payroll/preview", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const contractId = toNum(body.contractId);
  const ym = parseYearMonth(body);
  if (!contractId || "error" in ym) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane: umowa, rok, miesiąc (1-12)" },
      400,
    );
  }
  const { year, month } = ym;
  const nums = parseNumericFields(body, {
    mainAmount: "Kwota główna",
    bonusRate: "Stawka dodatku",
    rateAdjustment: "Korekta stawki",
    maxHoursOverride: "Godziny maks. (nadpisanie)",
    actualHoursOverride: "Godziny faktyczne (nadpisanie)",
    bonusAmountOverride: "Kwota dodatku (nadpisanie)",
  });
  if (nums.error || !nums.data) {
    return c.json<ApiResponse<null>>({ success: false, error: nums.error }, 400);
  }
  const rows = await computeMonth(year, month, {
    contractId,
    values: { ...nums.data, bonusRatePending: Boolean(body.bonusRatePending) },
  });
  const computed = rows.find((r) => r.contractId === contractId);
  if (!computed) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono umowy" },
      404,
    );
  }
  return c.json({ success: true, data: computed });
});

// ==================== BIURO ====================

function parseOffice(body: Record<string, unknown>): {
  data?: Partial<NewHrOfficePayroll>;
  error?: string;
} {
  const emp = refId(body.employeeId, schema.hrEmployees, "Pracownik");
  if (emp.error) return { error: emp.error };
  if (emp.id == null) return { error: "Pracownik jest wymagany" };
  const employeeId = emp.id;
  const ym = parseYearMonth(body);
  if ("error" in ym) return { error: ym.error };
  const { year, month } = ym;
  const labels = {
    etatHours: "Godziny etatu",
    uwL4: "UW/L4",
    deductions: "Potrącenia",
    bonuses: "Dodatki",
    hoursForAccounting: "Godziny do księgowej",
    rate: "Stawka",
    amount: "Kwota",
    rorBase: "Podstawa ROR",
    cashOverride: "Gotówka (nadpisanie)",
  } as const;
  const nums = parseNumericFields(body, labels);
  if (nums.error || !nums.data) return { error: nums.error };
  // Wszystko tu jest godzinami albo kwotami do WYPŁATY — ujemna „podstawa ROR"
  // czy ujemna kwota nie ma interpretacji (potrącenia są kolumną samą w sobie,
  // dodatnią). Na produkcji nie ma ani jednego ujemnego wiersza; `-3000` to
  // literówka, która zaniżyłaby koszt biura, nie korekta.
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const v = nums.data[key];
    if (v != null && v < 0) return { error: `${labels[key]}: wartość nie może być ujemna` };
  }
  return {
    data: {
      employeeId,
      year,
      month,
      company: typeof body.company === "string" ? body.company.trim() : "",
      ...nums.data,
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  };
}

// Kwota, gotówka i koszt całkowity wiersza biura — formuła wspólna z kosztem
// osobowym w analityce: src/lib/hr-office-total.ts (tam też semantyka kolumn).
function withOfficeComputed(row: typeof schema.hrOfficePayroll.$inferSelect) {
  return { ...row, ...officeRowTotals(row) };
}

/** Wiersze biura miesiąca z nazwiskiem i wyliczeniami — dla `GET /office` i `GET /month`. */
async function loadOfficeRows(year: number, month: number) {
  const rows = await db
    .select({
      office: schema.hrOfficePayroll,
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.hrOfficePayroll)
    .innerJoin(
      schema.hrEmployees,
      eq(schema.hrOfficePayroll.employeeId, schema.hrEmployees.id),
    )
    .where(
      and(
        eq(schema.hrOfficePayroll.year, year),
        eq(schema.hrOfficePayroll.month, month),
      ),
    )
    .orderBy(asc(schema.hrEmployees.fullName));
  return rows.map((r) => ({
    ...withOfficeComputed(r.office),
    employeeName: r.employeeName,
  }));
}

app.get("/office", async (c) => {
  const ym = yearMonth(c);
  if ("error" in ym) return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  return c.json({ success: true, data: await loadOfficeRows(ym.year, ym.month) });
});

/**
 * UPSERT po kluczu (pracownik, rok, miesiąc, SPÓŁKA) — ten sam wzorzec, co
 * `PUT /payroll`. Wcześniej goły INSERT: dwa kliknięcia „Dodaj" (albo dwie karty)
 * dawały dwa wiersze i `officeTotal` w podsumowaniu liczył pensję podwójnie.
 * Spółka MUSI być w kluczu: osoba z etatem w dwóch spółkach ma legalnie dwa
 * wiersze na miesiąc (na produkcji: Jaworski Sławomir, ALFA ETAT + CONTROL ETAT).
 * Od migracji 0078 pilnuje tego też UNIQUE w bazie — transakcja jest po to,
 * żeby wyścig kończył się aktualizacją, a nie 500 z SQLite.
 * Odpowiedź: 201 gdy powstał nowy wiersz, 200 gdy zaktualizowano istniejący.
 */
app.post("/office", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseOffice(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  const values = data as NewHrOfficePayroll;
  // Portal wpisu biura — z działu pracownika w kartotece.
  const locked = writeGuard(
    c,
    "office",
    [portalOfEmployee(values.employeeId)],
    periodOf(values),
  );
  if (locked) return locked;
  const user = getUser(c);
  const outcome = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.hrOfficePayroll)
      .where(
        and(
          eq(schema.hrOfficePayroll.employeeId, values.employeeId),
          eq(schema.hrOfficePayroll.year, values.year),
          eq(schema.hrOfficePayroll.month, values.month),
          eq(schema.hrOfficePayroll.company, values.company ?? ""),
        ),
      )
      .get();
    const logCtx = {
      entityType: "hr_office" as const,
      user,
      employeeName: hrEmployeeName(tx, values.employeeId),
      period: { year: values.year, month: values.month },
    };
    if (existing) {
      const [row] = tx
        .update(schema.hrOfficePayroll)
        .set({ ...values, updatedAt: new Date().toISOString() })
        .where(eq(schema.hrOfficePayroll.id, existing.id))
        .returning()
        .all();
      // Ten endpoint robi UPSERT — „dodaj” z formularza trafiające w istniejący
      // wiersz jest w dzienniku edycją, bo tym faktycznie jest.
      logHrUpdated(tx, { ...logCtx, entityId: existing.id, before: existing, after: row });
      return { created: false as const, row };
    }
    const [row] = tx.insert(schema.hrOfficePayroll).values(values).returning().all();
    logHrCreated(tx, { ...logCtx, entityId: row.id, after: row });
    return { created: true as const, row };
  });
  return c.json(
    {
      success: true,
      data: withOfficeComputed(outcome.row),
      message: outcome.created ? "Wpis dodany" : "Wpis zaktualizowany",
    },
    outcome.created ? 201 : 200,
  );
});

/**
 * Przeniesienie wpisów biura z poprzedniego miesiąca — odpowiednik
 * `POST /hours/carry-over` po stronie biura. Kopiuje SZKIELET wiersza
 * (pracownik, spółka, etat, stawka), a nie kwoty: godziny do księgowej, kwota,
 * podstawa ROR i gotówka przychodzą od księgowości i w nowym miesiącu są inne.
 * Idempotentny: para (pracownik, spółka) obecna już w miesiącu docelowym jest
 * pomijana — ten sam klucz, co UNIQUE w bazie, więc drugie wywołanie nie
 * kończy się ani duplikatem, ani 500.
 */
app.post("/office/carry-over", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ym = parseYearMonth(body);
  if ("error" in ym) {
    return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  }
  const { year, month } = ym;
  // Jak w carry-over godzin: blokuje miesiąc DOCELOWY (to w nim powstają
  // wiersze) i wymaga rezerwacji całej listy — wpisy powstają w dowolnych działach.
  const locked = writeGuard(c, "office", "all", { year, month });
  if (locked) return locked;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const user = getUser(c);

  const inserted = db.transaction((tx) => {
    const prevRows = tx
      .select({ office: schema.hrOfficePayroll })
      .from(schema.hrOfficePayroll)
      .innerJoin(
        schema.hrEmployees,
        eq(schema.hrOfficePayroll.employeeId, schema.hrEmployees.id),
      )
      .where(
        and(
          eq(schema.hrOfficePayroll.year, prevYear),
          eq(schema.hrOfficePayroll.month, prevMonth),
          eq(schema.hrEmployees.active, true),
        ),
      )
      .all();

    const existing = tx
      .select({
        employeeId: schema.hrOfficePayroll.employeeId,
        company: schema.hrOfficePayroll.company,
      })
      .from(schema.hrOfficePayroll)
      .where(
        and(
          eq(schema.hrOfficePayroll.year, year),
          eq(schema.hrOfficePayroll.month, month),
        ),
      )
      .all();
    const seen = new Set(existing.map((r) => `${r.employeeId}:${r.company ?? ""}`));

    const toInsert: NewHrOfficePayroll[] = [];
    for (const { office: prev } of prevRows) {
      const key = `${prev.employeeId}:${prev.company ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toInsert.push({
        employeeId: prev.employeeId,
        year,
        month,
        company: prev.company,
        etatHours: prev.etatHours,
        rate: prev.rate,
        uwL4: null,
        deductions: null,
        bonuses: null,
        hoursForAccounting: null,
        amount: null,
        rorBase: null,
        cashOverride: null,
        notes: "",
      });
    }
    if (toInsert.length > 0) {
      tx.insert(schema.hrOfficePayroll).values(toInsert).run();
      // Jeden wpis na całą operację, nie N wpisów: dziennik ma pokazać „skąd
      // wzięło się 14 wierszy", a nie zasypać miesiąc czternastoma zdarzeniami.
      logActivity(tx, {
        entityType: "hr_office",
        entityId: 0,
        user,
        action: "created",
        summary: `Przeniesiono ${toInsert.length} wpisów biura z ${monthLabelGen(prevYear, prevMonth)} do ${monthLabelGen(year, month)}`,
      });
    }
    return toInsert.length;
  });
  return c.json({ success: true, data: { inserted } });
});

app.put("/office/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [existing] = await db
    .select()
    .from(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.id, id));
  if (!existing) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu" },
      404,
    );
  }
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseOffice(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }
  // Okres i portal sprzed edycji i po niej — jak przy godzinach.
  const locked = writeGuard(
    c,
    "office",
    [portalOfEmployee(existing.employeeId), portalOfEmployee(data.employeeId)],
    existing,
    periodOf(data),
  );
  if (locked) return locked;
  // Optymistyczna kontrola współbieżności (patrz PUT /employees/:id) — zapis
  // tylko gdy odczytany updatedAt wciąż aktualny, inaczej 409.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .update(schema.hrOfficePayroll)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(
        expectedUpdatedAt
          ? and(
              eq(schema.hrOfficePayroll.id, id),
              eq(schema.hrOfficePayroll.updatedAt, expectedUpdatedAt),
            )
          : eq(schema.hrOfficePayroll.id, id),
      )
      .returning()
      .all();
    if (rows.length > 0) {
      logHrUpdated(tx, {
        entityType: "hr_office",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        period: { year: rows[0].year, month: rows[0].month },
        before: existing,
        after: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wpis został zmieniony przez kogoś innego. Odśwież i spróbuj ponownie." },
      409,
    );
  }
  return c.json({
    success: true,
    data: withOfficeComputed(result[0]),
    message: "Wpis zapisany",
  });
});

app.delete("/office/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = db
    .select({
      year: schema.hrOfficePayroll.year,
      month: schema.hrOfficePayroll.month,
      // Pracownik wiersza — po jego dziale rozstrzyga się, czyja rezerwacja
      // pokrywa to usunięcie.
      employeeId: schema.hrOfficePayroll.employeeId,
    })
    .from(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.id, id))
    .get();
  const locked = writeGuard(
    c,
    "office",
    [portalOfEmployee(existing?.employeeId)],
    existing,
  );
  if (locked) return locked;
  const user = getUser(c);
  const result = db.transaction((tx) => {
    const rows = tx
      .delete(schema.hrOfficePayroll)
      .where(eq(schema.hrOfficePayroll.id, id))
      .returning()
      .all();
    if (rows.length > 0) {
      logHrDeleted(tx, {
        entityType: "hr_office",
        entityId: id,
        user,
        employeeName: hrEmployeeName(tx, rows[0].employeeId),
        period: { year: rows[0].year, month: rows[0].month },
        before: rows[0],
      });
    }
    return rows;
  });
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wpisu" },
      404,
    );
  }
  return c.json({ success: true, data: null, message: "Wpis usunięty" });
});

// ==================== PODSUMOWANIE MIESIĄCA ====================

/**
 * Komplet danych miesiąca: wyliczone wypłaty, wpisy godzin i wpisy biura.
 * Czytają go i kafle (`GET /hr/summary`), i lista kontrolna zamknięcia
 * (`GET /hr/month-status`) — jedno źródło, więc „miesiąc bez braków” znaczy
 * w obu miejscach dokładnie to samo.
 */
async function monthData(year: number, month: number) {
  const [payroll, hoursRows, officeRows] = await Promise.all([
    computeMonth(year, month),
    db
      .select()
      .from(schema.hrHours)
      .where(and(eq(schema.hrHours.year, year), eq(schema.hrHours.month, month))),
    db
      .select()
      .from(schema.hrOfficePayroll)
      .where(
        and(
          eq(schema.hrOfficePayroll.year, year),
          eq(schema.hrOfficePayroll.month, month),
        ),
      ),
  ]);
  return { payroll, hoursRows, officeRows };
}

/**
 * Ile wpisów biura miało poprzednie miesiące — samo `count`, bez wierszy.
 * Puste biuro jest brakiem tylko po miesiącu, w którym biuro się rozliczało,
 * więc lista kontrolna potrzebuje tej jednej liczby (patrz `closingWarnings`).
 */
async function prevOfficeCount(year: number, month: number): Promise<number> {
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.hrOfficePayroll)
    .where(
      and(
        eq(schema.hrOfficePayroll.year, prevYear),
        eq(schema.hrOfficePayroll.month, prevMonth),
      ),
    );
  return Number(row[0]?.n ?? 0);
}

/** Lista kontrolna miesiąca — wstrzykiwana do tras stanu miesiąca. */
async function monthChecklist(year: number, month: number) {
  const [{ payroll, hoursRows, officeRows }, prevOfficeEntries] = await Promise.all([
    monthData(year, month),
    prevOfficeCount(year, month),
  ]);
  return buildMonthChecklist({
    hours: hoursRows,
    payroll,
    officeEntries: officeRows.length,
    prevOfficeEntries,
  });
}

/**
 * Kafle miesiąca — z JUŻ WCZYTANYCH danych, bez własnych zapytań.
 *
 * Osobna funkcja, bo liczą je dwie trasy: `GET /summary` (stara, zostaje dla
 * zgodności) i zbiorczy `GET /month`. Ten drugi ma przeliczyć miesiąc RAZ:
 * wcześniej odświeżenie ekranu Kadr uruchamiało trzy pełne przebiegi
 * `computeMonth` (summary + bieżący payroll + poprzedni payroll) na 147 umowach
 * — także ciche, po każdej serii zapisów inline.
 *
 * `officeRows` przyjmuje wiersze z policzonymi sumami (`withOfficeComputed`),
 * bo wołający i tak je ma; `hoursRows` może być surowe albo wzbogacone —
 * używamy tylko pól wspólnych.
 */
function buildSummary(
  year: number,
  month: number,
  payroll: PayrollComputed[],
  hoursRows: { employeeId: number; workedHours: number | null; uwHours: number | null; l4Hours: number | null; objectUncertain?: boolean | null }[],
  office: { total: number }[],
  /** Wpisy biura poprzedniego miesiąca — patrz `HrMonthChecklist`. */
  prevOfficeEntries: number,
) {
  // Braki liczy `buildMonthChecklist` — kafel i okno zamknięcia miesiąca nie
  // mają prawa pokazywać dwóch różnych liczb tego samego.
  const checklist = buildMonthChecklist({
    hours: hoursRows,
    payroll,
    officeEntries: office.length,
    prevOfficeEntries,
  });

  const employeesWithHours = new Set(hoursRows.map((h) => h.employeeId)).size;
  const totalHours = hoursRows.reduce(
    (s, h) => s + (h.workedHours ?? 0) + (h.uwHours ?? 0) + (h.l4Hours ?? 0),
    0,
  );
  const przelew = payroll.reduce((s, r) => s + r.przelew, 0);
  const gotowka = payroll.reduce((s, r) => s + r.gotowka, 0);
  const { missingMain, pendingBonus } = checklist;
  // Liczba WIERSZY do uzupełnienia, nie suma dwóch liczników: umowa bez kwoty
  // i jednocześnie z dodatkiem do przeliczenia to jeden brak, nie dwa. Kafel
  // „Braki" pokazuje tę liczbę, a filtr tabeli „Braki (jak na kaflu)" ma dać
  // dokładnie tyle wierszy.
  const gaps = payroll.filter(
    (r) =>
      (r.faktGodziny != null && r.faktGodziny > 0 && r.kwotaGlowna == null) ||
      r.bonusPending,
  ).length;

  const officeTotal = office.reduce((s, r) => s + r.total, 0);

  return {
    year,
    month,
    employeesWithHours,
    hoursEntries: hoursRows.length,
    totalHours: round2(totalHours),
    contractsCount: payroll.length,
    przelew: round2(przelew),
    gotowka: round2(gotowka),
    wyplaty: round2(przelew + gotowka),
    missingMain, // wiersze z godzinami, ale bez kwoty od księgowości
    pendingBonus, // dodatki "do przeliczenia"
    gaps, // wiersze z którymkolwiek z powyższych braków (bez podwójnego liczenia)
    officeTotal: round2(officeTotal),
    officeCount: office.length,
    // Lista kontrolna miesiąca (pasek „Postęp miesiąca" i okno zamknięcia) —
    // te same liczby, co w `GET /hr/month-status`.
    checklist,
  };
}

app.get("/summary", async (c) => {
  const ym = yearMonth(c);
  if ("error" in ym) return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  const { year, month } = ym;
  const [{ payroll, hoursRows, officeRows }, prevOfficeEntries] = await Promise.all([
    monthData(year, month),
    prevOfficeCount(year, month),
  ]);
  return c.json({
    success: true,
    data: buildSummary(
      year,
      month,
      payroll,
      hoursRows,
      officeRows.map(withOfficeComputed),
      prevOfficeEntries,
    ),
  });
});

/**
 * Kafle POPRZEDNIEGO miesiąca — same liczby, do których front dorysowuje
 * różnicę pod wartością („+4 120 zł (+3,1%)").
 *
 * Osobna, chuda funkcja zamiast drugiego `buildSummary`: z zeszłego miesiąca
 * potrzebne są sumy, a nie lista kontrolna — „ile braków było w sierpniu" nie
 * ma już czego pilnować, a policzenie jej kosztowałoby drugi przebieg reguł
 * zamknięcia miesiąca.
 */
function buildPrevSummary(
  year: number,
  month: number,
  payroll: PayrollComputed[],
  hoursRows: { employeeId: number; workedHours: number | null; uwHours: number | null; l4Hours: number | null }[],
  office: { total: number }[],
) {
  const totalHours = hoursRows.reduce(
    (s, h) => s + (h.workedHours ?? 0) + (h.uwHours ?? 0) + (h.l4Hours ?? 0),
    0,
  );
  const przelew = payroll.reduce((s, r) => s + r.przelew, 0);
  const gotowka = payroll.reduce((s, r) => s + r.gotowka, 0);
  const officeTotal = office.reduce((s, r) => s + r.total, 0);
  return {
    year,
    month,
    employeesWithHours: new Set(hoursRows.map((h) => h.employeeId)).size,
    hoursEntries: hoursRows.length,
    totalHours: round2(totalHours),
    contractsCount: payroll.length,
    przelew: round2(przelew),
    gotowka: round2(gotowka),
    wyplaty: round2(przelew + gotowka),
    officeTotal: round2(officeTotal),
    officeCount: office.length,
    /**
     * Czy w poprzednim miesiącu JEST czego szukać — osobno dla każdego z trzech
     * rozliczeń, bo wypełnia się je w różnych momentach i przez różne osoby.
     *
     * Bez tego rozbicia lipiec z wpisanymi godzinami, ale bez ani jednej kwoty
     * od księgowości, pokazałby przy kaflu „Przelewy" spadek o 100% — a to nie
     * spadek, tylko miesiąc, którego nikt jeszcze nie rozliczył. Front pisze
     * wtedy wprost „brak danych za lipiec".
     */
    hasHours: hoursRows.length > 0,
    hasPayroll: przelew !== 0 || gotowka !== 0,
    hasOffice: office.length > 0,
    /**
     * Czy księgowość podała za tamten miesiąc CHOĆ JEDNĄ kwotę główną.
     *
     * Wypłaty da się mieć i bez tego (same premie z godzin, wyrównania stawki,
     * dodatki), tylko że są wtedy ułamkiem prawdziwej listy płac — i różnica
     * „+7 939%" mówi nie o wzroście wypłat, a o tym, że tamtego miesiąca nikt
     * jeszcze nie rozliczył. Nie chowamy przez to liczby (byłaby to ta sama
     * nieprawda od drugiej strony), tylko dopisujemy powód do dymka.
     */
    payrollSettled: payroll.some((r) => r.kwotaGlowna != null),
  };
}

/**
 * KOMPLET DANYCH MIESIĄCA W JEDNYM ŻĄDANIU: kafle + wypłaty + godziny + biuro
 * + stan miesiąca + kwoty główne z poprzedniego miesiąca.
 *
 * Ekran Kadr potrzebuje wszystkich sześciu naraz, a wołane osobno kosztowały
 * TRZY przebiegi `computeMonth` (summary liczy wypłaty od nowa, poprzedni
 * miesiąc — kolejny raz). Tutaj bieżący miesiąc liczy się RAZ.
 *
 * Poprzedni miesiąc liczy się drugi (i ostatni) raz, bo kafle porównują się do
 * niego sumami, a „Największe zmiany" potrzebują WYPŁATY per umowa — a tej
 * z samego `hr_payroll.main_amount` nie da się odtworzyć (dochodzą dodatki,
 * premie, wyrównania i kanały). Z tego samego przebiegu wychodzą też
 * `prevAmounts`, więc kwoty główne zeszłego miesiąca czytamy RAZ, nie dwa.
 *
 * Stare trasy (`/summary`, `/payroll`, `/hours`, `/office`, `/month-status`)
 * ZOSTAJĄ — używają ich wydruki, dialogi i testy.
 */
app.get("/month", async (c) => {
  const ym = yearMonth(c);
  if ("error" in ym) return c.json<ApiResponse<null>>({ success: false, error: ym.error }, 400);
  const { year, month } = ym;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const [payroll, hours, office, prevPayroll, prevHours, prevOffice] =
    await Promise.all([
      computeMonth(year, month),
      // `withPrev`: wiersze godzin niosą wartości z miesiąca poprzedniego
      // (kolumna „pop.” w tabeli Godzin) — tak samo jak z `GET /hr/hours`,
      // bo Kadry wczytują miesiąc TĄ trasą i bez tego kolumna byłaby pusta.
      loadHoursRows(year, month, null, true),
      loadOfficeRows(year, month),
      computeMonth(prevYear, prevMonth),
      loadHoursRows(prevYear, prevMonth),
      loadOfficeRows(prevYear, prevMonth),
    ]);
  const summary = buildSummary(year, month, payroll, hours, office, prevOffice.length);
  const prevSummary = buildPrevSummary(
    prevYear,
    prevMonth,
    prevPayroll,
    prevHours,
    prevOffice,
  );
  const statusRow = monthStatusRow(year, month);
  return c.json({
    success: true,
    data: {
      summary,
      payroll,
      hours,
      office,
      // Ten sam kształt, co `GET /hr/month-status` — z listą kontrolną
      // policzoną RAZ, razem z kaflami (to te same liczby).
      monthStatus: {
        year,
        month,
        status: statusRow?.status === "closed" ? ("closed" as const) : ("open" as const),
        closedAt: statusRow?.closedAt ?? null,
        closedBy: statusRow?.closedByLabel ?? null,
        reopenReason: statusRow?.reopenReason ?? null,
        checklist: summary.checklist,
      },
      // Tylko wypełnione kwoty — front i tak odfiltrowywał `null`.
      prevAmounts: prevPayroll
        .filter((r) => r.inputs.mainAmount != null)
        .map((r) => ({
          contractId: r.contractId,
          mainAmount: r.inputs.mainAmount as number,
        })),
      // Kafle poprzedniego miesiąca (różnica pod wartością).
      prevSummary,
      /**
       * Wypłaty poprzedniego miesiąca per umowa — dla sekcji „Największe
       * zmiany". Tylko wiersze, które w ogóle coś niosły: umowa z zerem i bez
       * kwoty nie jest ani „była", ani „jest", a byłaby połową listy.
       */
      prevPayroll: prevPayroll
        .filter((r) => r.wyplata !== 0 || r.inputs.mainAmount != null)
        .map((r) => ({
          contractId: r.contractId,
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          company: r.company,
          wyplata: r.wyplata,
        })),
    },
  });
});

// ==================== DZIENNIK ZMIAN (odczyt) ====================
// Oś czasu modułu (/hr/activity) i historia jednego pracownika
// (/hr/employees/:id/activity) — src/routes/hr-activity.ts.
app.route("/activity", hrActivity);
app.route("/employees", hrEmployeeActivity);

// ==================== STAN MIESIĄCA (zamknięcie) ====================
// Odczyt stanu + zamknięcie i ponowne otwarcie — src/routes/hr-month.ts.
// Listę kontrolną liczy `monthChecklist` stąd, więc okno zamknięcia i kafle
// miesiąca zawsze mówią jedno.
app.route("/month-status", createHrMonthRoutes({ loadChecklist: monthChecklist }));

// ==================== NORMY Z KODEKSU PRACY + ŚWIĘTA ====================
// /hr/holidays oraz /hr/norms/computed i /hr/norms/apply-computed —
// src/routes/hr-norms.ts. Montowane na "/" (własne, pełne ścieżki w środku);
// `GET|PUT /norms` wyżej zostaje nietknięte, bo Hono dopasowuje całe segmenty.
app.route("/", hrNorms);

// ==================== NA ŻYWO + REZERWACJA LIST ====================
// `GET /hr/live` (strumień SSE) — src/routes/hr-live.ts; montowane na "/",
// bo router niesie własną, pełną ścieżkę.
app.route("/", hrLive);
// `/hr/locks/*` — wzięcie, przedłużenie, zwolnienie i prośba o zwolnienie
// listy (src/routes/hr-locks.ts). Egzekwowanie przy zapisie robi `writeGuard`.
app.route("/locks", hrLocks);

export default app;
