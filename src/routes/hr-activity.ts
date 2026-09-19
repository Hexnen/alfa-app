/**
 * Dziennik zmian modułu Kadry — ODCZYT.
 *
 * Montowany w `src/routes/hr.ts` jako `app.route("/activity", hrActivity)`,
 * czyli pod `/hr/activity`. Zapis robi `src/lib/hr-activity.ts`.
 *
 * Uprawnienia: WYŁĄCZNIE klucz `kadry/historia` (poziom `view`), a nie suma
 * kluczy Kadr — wpisy streszczają kwoty wynagrodzeń wszystkich osób. Ten sam
 * warunek trzyma `API_TAB_MAP` (wpis `/hr/activity` przed `/hr`), ale
 * powtarzamy go jawnie w `guard()`: historia pracownika montuje się pod
 * `/hr/employees/:id/activity`, czyli poza tamtym prefiksem.
 *
 * DLACZEGO FILTR PO PRACOWNIKU JEST ZŁOŻONY: `activity_log` nie ma kolumny
 * `employee_id` (i celowo jej nie dokładamy — tabela jest wspólna dla całego
 * CRM-a). Zamiast tego liczymy w SQL zbiory (entity_type, entity_id) należące do
 * osoby: jej umowy (one same i jej wypłaty, bo `hr_payroll` ma entityId = id
 * UMOWY), wpisy godzin i wpisy biura. Wiersze już USUNIĘTE nie wpadną w żaden
 * zbiór — dlatego dokładamy warunek `summary LIKE '%Nazwisko Imię%'`: każde
 * summary kadrowe zaczyna się od nazwiska, więc usunięcia wracają do wyniku.
 */
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { and, desc, eq, gte, inArray, lte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ActivityLogEntry } from "../db/schema.js";
import { canView, isAdmin } from "../lib/auth/permissions.js";
import { getUser } from "../middleware/auth.js";
// Sekcje działowe („Godziny działu”) czytają stąd historię SWOICH wpisów —
// reguły zawężenia w src/lib/hr-scope.ts.
import {
  departmentIdsOfPortal,
  departmentInPortal,
  isDenial,
  portalScope,
  type HrPortalKey,
} from "../lib/hr-scope.js";
import {
  HR_ENTITY_TYPES,
  MONTH_NAMES_PL,
  MONTH_NAMES_PL_GEN,
  type HrEntityType,
} from "../lib/hr-activity.js";

const app = new Hono();

/**
 * JEDEN klucz na cały dziennik. Nie suma podzakładek Kadr: wpisy streszczają
 * kwoty wynagrodzeń wszystkich osób, więc „wgląd w Godziny” nie może dawać
 * wglądu w płace. Ten sam warunek stoi w `API_TAB_MAP` dla prefiksu
 * `/hr/activity`; tutaj powtarzamy go jawnie, bo `hrEmployeeActivity` montuje
 * się pod `/hr/employees/:id/activity` — adres, którego tamten prefiks nie
 * obejmuje (i obejmować nie powinien, bo kartoteka to inny klucz).
 */
const HISTORY_TAB = "kadry/historia";

const PAGE_SIZE = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | undefined, def = PAGE_SIZE): number {
  const n = raw ? Number(raw) : def;
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, MAX_LIMIT);
}

/** Kursor „ostatni oddany wiersz”: `created_at|id`. Śmieć → pierwsza strona. */
function parseCursor(raw: string | undefined): { createdAt: string; id: number } | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("|");
  if (at <= 0) return null;
  const createdAt = raw.slice(0, at);
  const id = Number(raw.slice(at + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(createdAt)) return null;
  return { createdAt, id };
}

/**
 * `LIKE` z JAWNĄ klauzulą `ESCAPE '\'`.
 *
 * `like()` drizzle renderuje samo `col LIKE ?`, a SQLite BEZ `ESCAPE` nie zna
 * żadnego znaku ucieczki — backslash jest wtedy zwykłym znakiem. Zapytanie
 * „TEST100%” po ucieczce stawało się `%TEST100\%%` i szukało dosłownego
 * backslasha, czyli zwracało zero wyników zamiast dopasowania.
 *
 * `escapeLike` przygotowuje wzorzec: `%`, `_` i sam `\` przestają być
 * wieloznacznikami, a fragment użytkownika trafia między `%…%`.
 */
const escapeLike = (v: string): string => v.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const likeContains = (col: SQL | AnySQLiteColumn, raw: string): SQL =>
  // `'\\'` w źródle TS to JEDEN backslash w SQL — SQLite wymaga tu dokładnie
  // jednego znaku („ESCAPE expression must be a single character”).
  sql`${col} like ${`%${escapeLike(raw)}%`} escape '\\'`;

const isHrEntity = (v: string): v is HrEntityType =>
  (HR_ENTITY_TYPES as string[]).includes(v);

/** Data z query („2026-09-01”) → prefiks porównywalny z `created_at`. */
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

// ---------------------------------------------------------------------------
// Okres (rok-miesiąc) wpisu
// ---------------------------------------------------------------------------

const MONTH_INDEX = new Map([
  ...MONTH_NAMES_PL.map((m, i) => [m, i + 1] as const),
  ...MONTH_NAMES_PL_GEN.map((m, i) => [m, i + 1] as const),
]);

/**
 * „…(wrzesień 2026)” na końcu summary → „2026-09”. Summary składa
 * `src/lib/hr-activity.ts`, więc format jest nasz i parsowanie jest pewne.
 * Dla `hr_payroll` to JEDYNE źródło okresu (entityId wskazuje umowę, nie miesiąc).
 */
function periodFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  // Najpierw dopisek w nawiasie („…(wrzesień 2026)”), potem forma zdaniowa
  // operacji zbiorczych („…z sierpnia 2026 do września 2026”) — bierzemy ten
  // OSTATNI miesiąc, czyli docelowy.
  const m = /\((\p{L}+)\s+(\d{4})\)\s*$/u.exec(summary) ?? /\bdo\s+(\p{L}+)\s+(\d{4})\s*$/u.exec(summary);
  if (!m) return null;
  const month = MONTH_INDEX.get(m[1].toLowerCase());
  if (!month) return null;
  return `${m[2]}-${String(month).padStart(2, "0")}`;
}

const ymd = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Dopięcie pracownika i okresu do wpisów
// ---------------------------------------------------------------------------

export interface HrActivityEntry extends ActivityLogEntry {
  employee: { id: number; fullName: string } | null;
  /** „2026-09” albo null (dane niemiesięczne). */
  period: string | null;
}

function idsOf(entries: ActivityLogEntry[], type: HrEntityType): number[] {
  return [...new Set(entries.filter((e) => e.entityType === type).map((e) => e.entityId))];
}

/**
 * Do każdego wpisu dokłada pracownika i okres — po JEDNYM zapytaniu na typ
 * encji, nie po jednym na wiersz.
 */
function enrich(entries: ActivityLogEntry[]): HrActivityEntry[] {
  // entityId → employeeId, osobno dla każdego typu encji.
  const empByEntity = new Map<string, number>();
  const periodByEntity = new Map<string, string>();
  const key = (t: string, id: number) => `${t}:${id}`;

  const contractIds = [...new Set([...idsOf(entries, "hr_contract"), ...idsOf(entries, "hr_payroll")])];
  if (contractIds.length > 0) {
    for (const r of db
      .select({ id: schema.hrContracts.id, employeeId: schema.hrContracts.employeeId })
      .from(schema.hrContracts)
      .where(inArray(schema.hrContracts.id, contractIds))
      .all()) {
      empByEntity.set(key("hr_contract", r.id), r.employeeId);
      empByEntity.set(key("hr_payroll", r.id), r.employeeId);
    }
  }

  const hoursIds = idsOf(entries, "hr_hours");
  if (hoursIds.length > 0) {
    for (const r of db
      .select({
        id: schema.hrHours.id,
        employeeId: schema.hrHours.employeeId,
        year: schema.hrHours.year,
        month: schema.hrHours.month,
      })
      .from(schema.hrHours)
      .where(inArray(schema.hrHours.id, hoursIds))
      .all()) {
      empByEntity.set(key("hr_hours", r.id), r.employeeId);
      periodByEntity.set(key("hr_hours", r.id), ymd(r.year, r.month));
    }
  }

  const officeIds = idsOf(entries, "hr_office");
  if (officeIds.length > 0) {
    for (const r of db
      .select({
        id: schema.hrOfficePayroll.id,
        employeeId: schema.hrOfficePayroll.employeeId,
        year: schema.hrOfficePayroll.year,
        month: schema.hrOfficePayroll.month,
      })
      .from(schema.hrOfficePayroll)
      .where(inArray(schema.hrOfficePayroll.id, officeIds))
      .all()) {
      empByEntity.set(key("hr_office", r.id), r.employeeId);
      periodByEntity.set(key("hr_office", r.id), ymd(r.year, r.month));
    }
  }

  for (const id of idsOf(entries, "hr_employee")) empByEntity.set(key("hr_employee", id), id);

  // Zamknięcie/otwarcie miesiąca: okres siedzi w SAMYM entityId (rok*100 +
  // miesiąc), więc bierzemy go stamtąd, a nie z summary — wpis dotyczy okresu,
  // nie wiersza, i żadne zapytanie nie jest do tego potrzebne.
  for (const id of idsOf(entries, "hr_month")) {
    const year = Math.floor(id / 100);
    const month = id % 100;
    if (month >= 1 && month <= 12) periodByEntity.set(key("hr_month", id), ymd(year, month));
  }

  // Wiersze USUNIĘTE nie mają już encji — nazwisko odzyskujemy z summary
  // („Kowalski Jan — …”), jedynym dodatkowym zapytaniem.
  const fallbackNames = new Set<string>();
  for (const e of entries) {
    if (empByEntity.has(key(e.entityType, e.entityId))) continue;
    const m = e.summary ? /^(.+?)\s—\s/.exec(e.summary) : null;
    if (m) fallbackNames.add(m[1]);
  }
  const byName = new Map<string, number>();
  if (fallbackNames.size > 0) {
    for (const r of db
      .select({ id: schema.hrEmployees.id, fullName: schema.hrEmployees.fullName })
      .from(schema.hrEmployees)
      .where(inArray(schema.hrEmployees.fullName, [...fallbackNames]))
      .all()) {
      byName.set(r.fullName, r.id);
    }
  }

  const employeeIds = new Set<number>([...empByEntity.values(), ...byName.values()]);
  const names = new Map<number, string>();
  if (employeeIds.size > 0) {
    for (const r of db
      .select({ id: schema.hrEmployees.id, fullName: schema.hrEmployees.fullName })
      .from(schema.hrEmployees)
      .where(inArray(schema.hrEmployees.id, [...employeeIds]))
      .all()) {
      names.set(r.id, r.fullName);
    }
  }

  return entries.map((e) => {
    const k = key(e.entityType, e.entityId);
    let empId = empByEntity.get(k) ?? null;
    let fullName = empId != null ? names.get(empId) ?? null : null;
    if (empId == null) {
      const m = e.summary ? /^(.+?)\s—\s/.exec(e.summary) : null;
      if (m) {
        const id = byName.get(m[1]);
        if (id != null) {
          empId = id;
          fullName = m[1];
        }
      }
    }
    return {
      ...e,
      employee: empId != null && fullName != null ? { id: empId, fullName } : null,
      period: periodByEntity.get(k) ?? periodFromSummary(e.summary),
    };
  });
}

// ---------------------------------------------------------------------------
// Filtr po pracowniku
// ---------------------------------------------------------------------------

/**
 * Warunek „wpis dotyczy tego pracownika”: jego encje po id + ratunek po
 * nazwisku w summary (wiersze usunięte, których już nie ma w tabelach).
 */
function employeeCondition(employeeId: number): SQL | undefined {
  const contractIds = db
    .select({ id: schema.hrContracts.id })
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.employeeId, employeeId))
    .all()
    .map((r) => r.id);
  const hoursIds = db
    .select({ id: schema.hrHours.id })
    .from(schema.hrHours)
    .where(eq(schema.hrHours.employeeId, employeeId))
    .all()
    .map((r) => r.id);
  const officeIds = db
    .select({ id: schema.hrOfficePayroll.id })
    .from(schema.hrOfficePayroll)
    .where(eq(schema.hrOfficePayroll.employeeId, employeeId))
    .all()
    .map((r) => r.id);
  const fullName = db
    .select({ v: schema.hrEmployees.fullName })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, employeeId))
    .get()?.v;

  const parts: SQL[] = [
    and(eq(schema.activityLog.entityType, "hr_employee"), eq(schema.activityLog.entityId, employeeId))!,
  ];
  if (contractIds.length > 0) {
    parts.push(
      and(
        inArray(schema.activityLog.entityType, ["hr_contract", "hr_payroll"]),
        inArray(schema.activityLog.entityId, contractIds),
      )!,
    );
  }
  if (hoursIds.length > 0) {
    parts.push(
      and(eq(schema.activityLog.entityType, "hr_hours"), inArray(schema.activityLog.entityId, hoursIds))!,
    );
  }
  if (officeIds.length > 0) {
    parts.push(
      and(eq(schema.activityLog.entityType, "hr_office"), inArray(schema.activityLog.entityId, officeIds))!,
    );
  }
  // Nazwisko wchodzi do wzorca z ucieczką: `_` i `%` w nazwisku (import,
  // literówka) zamieniałyby ten warunek w „dopasuj cokolwiek”.
  if (fullName) parts.push(likeContains(schema.activityLog.summary, fullName));
  return or(...parts);
}

// ---------------------------------------------------------------------------
// Trasy
// ---------------------------------------------------------------------------

function guard(c: Context): boolean {
  const user = getUser(c);
  return isAdmin(user) || canView(user, HISTORY_TAB);
}

const DENIED = {
  success: false as const,
  error: "Brak dostępu do dziennika zmian Kadr (uprawnienie „Historia”)",
};

/**
 * HISTORIA DLA SEKCJI DZIAŁOWEJ („Godziny działu”).
 *
 * Konto sekcji nie ma klucza „Historia” i mieć go nie powinno: globalny
 * dziennik streszcza kwoty wypłat całej firmy. Ale historia WŁASNEGO wpisu
 * godzin („kto zmienił te 12 h i kiedy”) jest częścią tej samej roboty, co
 * wpisywanie godzin — więc sekcja dostaje ją w dwóch miejscach i tylko tam:
 *  - `GET /hr/activity/entity/hr_hours/:id` dla wpisu ze SWOJEGO działu,
 *  - `GET /hr/activity/employee/:id` dla pracownika ze swojego działu,
 *    zawężone do encji `hr_hours` (bez umów, wypłat i biura).
 *
 * Wynik: `{ portal: null }` = pełny dziennik (klucz „Historia” albo admin),
 * `{ portal: "cma" }` = zawężenie do jednej sekcji, `null` = brak dostępu.
 * Sekcję bierzemy z `?portal=`, bo front jej ekranu i tak ją zna — zgadywanie
 * „pierwszej z uprawnień” myliłoby się u kogoś, kto prowadzi dwie.
 */
function activityScope(c: Context): { portal: HrPortalKey | null } | null {
  if (guard(c)) return { portal: null };
  const scope = portalScope(c.req.query("portal"), getUser(c));
  if (isDenial(scope) || scope.portal == null) return null;
  return { portal: scope.portal };
}

/** Czy wpis godzin o tym id należy do sekcji wołającego. */
function hoursRowInPortal(id: number, portal: HrPortalKey): boolean {
  const row = db
    .select({ departmentId: schema.hrHours.departmentId })
    .from(schema.hrHours)
    .where(eq(schema.hrHours.id, id))
    .get();
  return row != null && departmentInPortal(row.departmentId, portal);
}

/** Wspólny odczyt strony dziennika: warunki + kursor + wzbogacenie. */
function page(conds: SQL[], limit: number, cursor: { createdAt: string; id: number } | null) {
  const all = [
    inArray(schema.activityLog.entityType, HR_ENTITY_TYPES),
    ...conds,
    ...(cursor
      ? [
          or(
            lt(schema.activityLog.createdAt, cursor.createdAt),
            and(eq(schema.activityLog.createdAt, cursor.createdAt), lt(schema.activityLog.id, cursor.id)),
          )!,
        ]
      : []),
  ];
  // O jeden wiersz więcej, niż oddamy — obecność (n+1)-go mówi, że jest kolejna
  // strona, bez drugiego zapytania z COUNT(*) (ten sam wzorzec, co /technik).
  const rows = db
    .select()
    .from(schema.activityLog)
    .where(and(...all))
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(limit + 1)
    .all();
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: enrich(items),
    nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
  };
}

/**
 * GET /hr/activity?limit&cursor&entityType&userId&employeeId&q&from&to
 * Oś czasu całego modułu, malejąco po czasie.
 */
app.get("/", (c) => {
  if (!guard(c)) return c.json(DENIED, 403);
  const limit = parseLimit(c.req.query("limit"));
  const cursor = parseCursor(c.req.query("cursor"));
  const conds: SQL[] = [];

  const entityType = (c.req.query("entityType") || "").trim();
  if (entityType) {
    if (!isHrEntity(entityType)) {
      return c.json({ success: false, error: "Nieznany typ wpisu" }, 400);
    }
    conds.push(eq(schema.activityLog.entityType, entityType));
  }

  const rawUser = c.req.query("userId");
  if (rawUser) {
    const userId = Number(rawUser);
    if (!Number.isInteger(userId) || userId <= 0) {
      return c.json({ success: false, error: "Nieprawidłowy użytkownik" }, 400);
    }
    conds.push(eq(schema.activityLog.userId, userId));
  }

  const rawEmployee = c.req.query("employeeId");
  if (rawEmployee) {
    const employeeId = Number(rawEmployee);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return c.json({ success: false, error: "Nieprawidłowy pracownik" }, 400);
    }
    const cond = employeeCondition(employeeId);
    if (cond) conds.push(cond);
  }

  const q = (c.req.query("q") || "").trim().slice(0, 100);
  // Szukamy po summary — to jedyne pole, które niesie pełne zdanie (nazwisko,
  // pole, wartości, miesiąc). `%` i `_` z zapytania uciekamy, żeby wpisane
  // ręcznie „%” nie zamieniało filtra w „pokaż wszystko”.
  if (q) conds.push(likeContains(schema.activityLog.summary, q));

  const from = (c.req.query("from") || "").trim();
  if (from) {
    if (!isDate(from)) return c.json({ success: false, error: "Nieprawidłowa data „od”" }, 400);
    conds.push(gte(schema.activityLog.createdAt, `${from} 00:00:00`));
  }
  const to = (c.req.query("to") || "").trim();
  if (to) {
    if (!isDate(to)) return c.json({ success: false, error: "Nieprawidłowa data „do”" }, 400);
    conds.push(lte(schema.activityLog.createdAt, `${to} 23:59:59`));
  }

  return c.json({ success: true, data: page(conds, limit, cursor) });
});

/**
 * GET /hr/activity/users — autorzy obecni w dzienniku (do selecta filtra).
 * Bierzemy etykietę z ostatniego wpisu danego konta: `user_label` to snapshot,
 * więc po zmianie nazwiska w profilu chcemy najświeższą wersję.
 */
app.get("/users", (c) => {
  if (!guard(c)) return c.json(DENIED, 403);
  const rows = db
    .select({
      userId: schema.activityLog.userId,
      userLabel: schema.activityLog.userLabel,
      id: schema.activityLog.id,
    })
    .from(schema.activityLog)
    .where(inArray(schema.activityLog.entityType, HR_ENTITY_TYPES))
    .orderBy(desc(schema.activityLog.id))
    .all();
  const seen = new Map<number, string>();
  for (const r of rows) {
    if (r.userId == null || seen.has(r.userId)) continue;
    seen.set(r.userId, r.userLabel || `#${r.userId}`);
  }
  const data = [...seen.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "pl"));
  return c.json({ success: true, data });
});

/**
 * GET /hr/activity/entity/:entityType/:entityId?limit&period
 * Historia JEDNEGO wpisu — pod ikonę „Historia zmian” w wierszu tabeli i sekcję
 * w dialogu edycji. `period` („2026-09”) zawęża do jednego miesiąca; potrzebne
 * dla `hr_payroll`, gdzie entityId to umowa, a wpisy są per miesiąc.
 */
app.get("/entity/:entityType/:entityId", (c) => {
  const scope = activityScope(c);
  if (!scope) return c.json(DENIED, 403);
  const entityType = c.req.param("entityType");
  const entityId = Number(c.req.param("entityId"));
  if (!isHrEntity(entityType)) {
    return c.json({ success: false, error: "Nieznany typ wpisu" }, 400);
  }
  if (!Number.isInteger(entityId) || entityId <= 0) {
    return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  }
  // Sekcja widzi historię wyłącznie WŁASNEGO wpisu godzin. Wpis z cudzego
  // działu i każdy inny typ encji (umowa, wypłata, biuro) to dla niej 403 —
  // ten sam komunikat co brak klucza, żeby odpowiedź nie mówiła, co istnieje.
  if (scope.portal != null) {
    if (entityType !== "hr_hours" || !hoursRowInPortal(entityId, scope.portal)) {
      return c.json(DENIED, 403);
    }
  }
  const limit = parseLimit(c.req.query("limit"), 100);
  const conds = [
    eq(schema.activityLog.entityType, entityType),
    eq(schema.activityLog.entityId, entityId),
  ];
  const cursor = parseCursor(c.req.query("cursor"));
  const period = (c.req.query("period") || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return c.json({ success: true, data: page(conds, limit, cursor) });
  }
  // Filtr okresu działa JUŻ PO wzbogaceniu (okres bierze się z encji albo
  // z summary, więc nie da się go wyrazić warunkiem SQL) — dlatego czytamy
  // KOLEJNE strony, aż uzbieramy `limit` pasujących wpisów albo skończy się
  // dziennik. Wcześniej filtr działał na jednej stronie i oddawał
  // `nextCursor: null`, przez co historia wypłaty starsza niż `limit` wpisów
  // umowy była nieosiągalna.
  const items: HrActivityEntry[] = [];
  let scan = cursor;
  let nextCursor: string | null = null;
  // Twardy limit przebiegów: dziennik umowy z wieloletnią historią nie ma
  // zablokować procesu na jednym żądaniu. Kursor wraca do klienta, więc
  // „Pokaż więcej" domknie resztę.
  for (let i = 0; i < 20; i++) {
    const chunk = page(conds, limit, scan);
    items.push(...chunk.items.filter((e) => e.period === period));
    nextCursor = chunk.nextCursor;
    if (!nextCursor || items.length >= limit) break;
    scan = parseCursor(nextCursor);
  }
  return c.json({ success: true, data: { items, nextCursor } });
});

/**
 * GET /hr/activity/employee/:id?portal=&limit&cursor
 * Historia jednego pracownika WIDZIANA Z SEKCJI — tylko jego wpisy godzin
 * z działów tej sekcji. Osobny adres od `/hr/employees/:id/activity`, bo tamten
 * należy do kartoteki (klucz `kadry/historia`) i pokazuje też umowy, wypłaty
 * i biuro — czyli dokładnie to, czego sekcja widzieć nie ma.
 *
 * Konto z pełnym dziennikiem dostaje tutaj to samo, co pod starym adresem.
 */
app.get("/employee/:id", (c) => {
  const scope = activityScope(c);
  if (!scope) return c.json(DENIED, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: "Nieprawidłowe id pracownika" }, 400);
  }
  const limit = parseLimit(c.req.query("limit"), 100);
  const cursor = parseCursor(c.req.query("cursor"));
  if (scope.portal == null) {
    const cond = employeeCondition(id);
    return c.json({ success: true, data: page(cond ? [cond] : [], limit, cursor) });
  }
  // Wpisy godzin TEJ osoby z działów sekcji. Wiersze już usunięte wypadają
  // z tego zbioru — inaczej niż w pełnej historii pracownika nie dokładamy
  // ratunkowego `summary LIKE '%Nazwisko%'`, bo po skasowanym wierszu nie da
  // się już sprawdzić, do którego działu należał.
  const portalDepts = departmentIdsOfPortal(scope.portal);
  const hoursIds =
    portalDepts.length === 0
      ? []
      : db
          .select({ id: schema.hrHours.id })
          .from(schema.hrHours)
          .where(
            and(
              eq(schema.hrHours.employeeId, id),
              inArray(schema.hrHours.departmentId, portalDepts),
            ),
          )
          .all()
          .map((r) => r.id);
  if (hoursIds.length === 0) {
    return c.json({ success: true, data: { items: [], nextCursor: null } });
  }
  return c.json({
    success: true,
    data: page(
      [
        and(
          eq(schema.activityLog.entityType, "hr_hours"),
          inArray(schema.activityLog.entityId, hoursIds),
        )!,
      ],
      limit,
      cursor,
    ),
  });
});

export default app;

// ---------------------------------------------------------------------------
// Historia jednego pracownika — montowana pod /hr/employees/:id/activity,
// żeby adres był bliżej kartoteki niż dziennika (patrz src/routes/hr.ts).
// ---------------------------------------------------------------------------

export const hrEmployeeActivity = new Hono();

hrEmployeeActivity.get("/:id/activity", (c) => {
  if (!guard(c)) return c.json(DENIED, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: "Nieprawidłowe id pracownika" }, 400);
  }
  const limit = parseLimit(c.req.query("limit"), 100);
  const cond = employeeCondition(id);
  return c.json({
    success: true,
    data: page(cond ? [cond] : [], limit, parseCursor(c.req.query("cursor"))),
  });
});
