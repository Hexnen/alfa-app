/**
 * Dziennik zmian modułu Kadry — ZAPIS.
 *
 * Nadbudowa nad generycznym `src/lib/activity-log.ts`: ten plik wie, jakie pola
 * ma każda encja kadrowa, jak nazwać je po polsku i jak sformatować wartość
 * (kwoty „3 200,00 zł”, godziny „168 h”, kanały wypłaty, rodzaje umów, nazwy
 * obiektów i działów po id). Router (`src/routes/hr.ts`) woła wyłącznie
 * `logHrCreated` / `logHrUpdated` / `logHrDeleted` — w TEJ SAMEJ transakcji, co
 * zmiana, więc wpis i dane nie mogą się rozjechać.
 *
 * Konwencja z KONTRAKT.md:
 *  - entityType: hr_employee | hr_contract | hr_hours | hr_payroll | hr_office |
 *    hr_object | hr_department | hr_norm,
 *  - entityId: id wiersza, a dla `hr_payroll` — id UMOWY (wiersz `hr_payroll`
 *    powstaje i znika przy upsercie, umowa jest stała),
 *  - kolumna `field` zostaje CZYSTA (sam klucz pola, bez prefiksu okresu);
 *    okres miesięczny idzie do `summary` jako „(wrzesień 2026)”, a odczyt
 *    (src/routes/hr-activity.ts) wyciąga go z powrotem.
 */
import { schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { ActivityAction } from "../db/schema.js";
import { logActivity, type ActivityUser, type DbOrTx } from "./activity-log.js";

export type HrEntityType =
  | "hr_employee"
  | "hr_contract"
  | "hr_hours"
  | "hr_payroll"
  | "hr_office"
  | "hr_object"
  | "hr_department"
  | "hr_norm"
  // Zamknięcie / ponowne otwarcie miesiąca rozliczeniowego. entityId = rok*100
  // + miesiąc (202609), bo wpis dotyczy OKRESU, a nie wiersza tabeli — id
  // wiersza `hr_month_status` powstaje dopiero przy pierwszym zamknięciu.
  | "hr_month"
  // Dzień ustawowo wolny (`hr_holidays`, migracja 0108). Nie należy do żadnego
  // miesiąca rozliczeniowego — zmienia wymiar czasu pracy, więc `period`
  // zostaje pusty, a datę niesie samo zdanie.
  | "hr_holiday";

export const HR_ENTITY_TYPES: HrEntityType[] = [
  "hr_employee",
  "hr_contract",
  "hr_hours",
  "hr_payroll",
  "hr_office",
  "hr_object",
  "hr_department",
  "hr_norm",
  "hr_month",
  "hr_holiday",
];

/** Etykiety encji w dopełniaczu — do „Dodano/Usunięto …”. */
const CREATED_LABEL: Record<HrEntityType, string> = {
  hr_employee: "Dodano pracownika",
  hr_contract: "Dodano umowę",
  hr_hours: "Dodano wpis godzin",
  hr_payroll: "Wpisano dane płacowe",
  hr_office: "Dodano wpis biura",
  hr_object: "Dodano obiekt",
  hr_department: "Dodano dział",
  hr_norm: "Zapisano normę godzin",
  // Encja bezużyteczna w wariancie „utworzono/usunięto” — zamknięcie i otwarcie
  // logujemy przez `logHrEvent` z własnym zdaniem; etykiety są tu dla kompletu.
  hr_month: "Zamknięto miesiąc",
  hr_holiday: "Dodano święto",
};

const DELETED_LABEL: Record<HrEntityType, string> = {
  hr_employee: "Usunięto pracownika",
  hr_contract: "Usunięto umowę",
  hr_hours: "Usunięto wpis godzin",
  hr_payroll: "Usunięto dane płacowe",
  hr_office: "Usunięto wpis biura",
  hr_object: "Usunięto obiekt",
  hr_department: "Usunięto dział",
  hr_norm: "Usunięto normę godzin",
  hr_month: "Otwarto miesiąc",
  hr_holiday: "Usunięto święto",
};

/** Nazwa encji do filtra na froncie (liczba mnoga). */
export const HR_ENTITY_LABELS: Record<HrEntityType, string> = {
  hr_employee: "Pracownicy",
  hr_contract: "Umowy",
  hr_hours: "Godziny",
  hr_payroll: "Wypłaty",
  hr_office: "Biuro",
  hr_object: "Obiekty",
  hr_department: "Działy",
  hr_norm: "Normy",
  hr_month: "Miesiąc",
  hr_holiday: "Święta",
};

/** Dopełniacz — „przeniesiono z sierpnia 2026”. */
export const MONTH_NAMES_PL_GEN = [
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

export const MONTH_NAMES_PL = [
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

export interface HrPeriod {
  year: number;
  month: number;
}

export const periodLabel = (p: HrPeriod): string =>
  `${MONTH_NAMES_PL[p.month - 1] ?? p.month} ${p.year}`;

// ---------------------------------------------------------------------------
// Formatowanie wartości
// ---------------------------------------------------------------------------

const BLANK = "(puste)";

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Liczba w zapisie polskim, bez sztucznych zer na końcu („7,5”, „3 200,00”). */
function num(v: unknown, decimals: number): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("pl-PL", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Kwota: „3 200,00 zł”. */
export const fmtMoney = (v: unknown): string => (isEmpty(v) ? BLANK : `${num(v, 2)} zł`);

/** Godziny: „168 h”, „7,5 h” (bez zer na końcu). */
export const fmtHours = (v: unknown): string => {
  if (isEmpty(v)) return BLANK;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${n.toLocaleString("pl-PL", { maximumFractionDigits: 2 })} h`;
};

const fmtBool = (v: unknown): string => {
  if (v === null || v === undefined) return BLANK;
  return v === true || v === 1 || v === "1" || v === "true" ? "tak" : "nie";
};

const fmtText = (v: unknown): string => (isEmpty(v) ? BLANK : String(v));

const fmtInt = (v: unknown): string => (isEmpty(v) ? BLANK : num(v, 0));

/** Data „YYYY-MM-DD” po polsku: „24.12.2026”. Bez `Date` — to przepisanie tekstu. */
const fmtDatePl = (v: unknown): string => {
  if (isEmpty(v)) return BLANK;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
};

const dict =
  (map: Record<string, string>) =>
  (v: unknown): string => {
    if (isEmpty(v)) return BLANK;
    return map[String(v)] ?? String(v);
  };

const fmtKind = dict({ ochrona: "Ochrona", biuro: "Biuro" });
const fmtContractType = dict({ praca: "Umowa o pracę", zlecenie: "Umowa zlecenie" });
const fmtChannel = dict({ przelew: "Przelew", gotowka: "Gotówka" });
const fmtBonusType = dict({
  brak: "Brak",
  gotowka: "Gotówka",
  delegacja_przelew: "Delegacja — przelew",
  delegacja_gotowka: "Delegacja — gotówka",
});

/**
 * Nazwa wiersza po id — czytana przez ten sam uchwyt (db albo tx), co zapis,
 * więc wewnątrz transakcji widzi jej własne zmiany.
 */
function intId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Nazwisko pracownika po id (null, gdy wiersza już nie ma). */
export function hrEmployeeName(dbx: DbOrTx, id: unknown): string | null {
  const n = intId(id);
  if (n == null) return null;
  return (
    dbx
      .select({ v: schema.hrEmployees.fullName })
      .from(schema.hrEmployees)
      .where(eq(schema.hrEmployees.id, n))
      .get()?.v ?? null
  );
}

function hrObjectName(dbx: DbOrTx, id: number): string | null {
  return (
    dbx
      .select({ v: schema.hrObjects.name })
      .from(schema.hrObjects)
      .where(eq(schema.hrObjects.id, id))
      .get()?.v ?? null
  );
}

function hrDepartmentName(dbx: DbOrTx, id: number): string | null {
  return (
    dbx
      .select({ v: schema.hrDepartments.name })
      .from(schema.hrDepartments)
      .where(eq(schema.hrDepartments.id, id))
      .get()?.v ?? null
  );
}

function catalogObjectName(dbx: DbOrTx, id: number): string | null {
  return (
    dbx
      .select({ v: schema.objects.name })
      .from(schema.objects)
      .where(eq(schema.objects.id, id))
      .get()?.v ?? null
  );
}

const fmtHrObject = (v: unknown, dbx: DbOrTx): string => {
  const n = intId(v);
  return n == null ? "bez obiektu" : hrObjectName(dbx, n) ?? `#${n}`;
};

const fmtHrDepartment = (v: unknown, dbx: DbOrTx): string => {
  const n = intId(v);
  return n == null ? "bez działu" : hrDepartmentName(dbx, n) ?? `#${n}`;
};

const fmtCatalogObject = (v: unknown, dbx: DbOrTx): string => {
  const n = intId(v);
  return n == null ? "brak (niezmapowany)" : catalogObjectName(dbx, n) ?? `#${n}`;
};

// ---------------------------------------------------------------------------
// Definicje pól per encja
// ---------------------------------------------------------------------------

export interface HrFieldDef {
  /** Klucz w rekordzie (camelCase, jak w drizzle). */
  key: string;
  /** Nazwa zapisywana w kolumnie `field` (snake_case, jak w bazie). */
  field: string;
  /** Etykieta PL do summary i do osi czasu na froncie. */
  label: string;
  format: (v: unknown, dbx: DbOrTx) => string;
  /** Pokazywać w podsumowaniu „utworzono”, gdy wartość niepusta (domyślnie tak). */
  inCreated?: boolean;
}

const f = (
  key: string,
  field: string,
  label: string,
  format: (v: unknown, dbx: DbOrTx) => string = fmtText,
  inCreated = true,
): HrFieldDef => ({ key, field, label, format, inCreated });

export const HR_FIELDS: Record<HrEntityType, HrFieldDef[]> = {
  hr_employee: [
    f("fullName", "full_name", "nazwisko i imię"),
    f("code", "code", "kod"),
    f("kind", "kind", "rodzaj rozliczenia", fmtKind),
    f("departmentId", "department_id", "dział", fmtHrDepartment),
    f("active", "active", "aktywny", fmtBool),
    f("notes", "notes", "uwagi"),
  ],
  hr_contract: [
    f("company", "company", "spółka"),
    f("contractType", "contract_type", "rodzaj umowy", fmtContractType),
    f("chor", "chor", "ubezpieczenie chorobowe", fmtBool, false),
    f("zua", "zua", "ZUA"),
    f("zza", "zza", "ZZA"),
    f("zwua", "zwua", "ZWUA"),
    f("objectName", "object_name", "obiekt (opis)"),
    f("mainChannel", "main_channel", "kanał wypłaty głównej", fmtChannel),
    f("bonusType", "bonus_type", "rodzaj dodatku", fmtBonusType),
    // Okres obowiązywania (migracja 0112) — puste = bezterminowo, więc
    // „(puste) → 31.12.2026” czyta się wprost jako nadanie terminu.
    f("validFrom", "valid_from", "obowiązuje od", fmtDatePl),
    f("validTo", "valid_to", "obowiązuje do", fmtDatePl),
    f("active", "active", "aktywna", fmtBool, false),
    f("notes", "notes", "uwagi"),
  ],
  hr_hours: [
    f("objectId", "object_id", "obiekt", fmtHrObject),
    f("departmentId", "department_id", "dział", fmtHrDepartment),
    f("nightHours", "night_hours", "godziny nocne", fmtHours),
    f("workedHours", "worked_hours", "godziny wypracowane", fmtHours),
    f("uwHours", "uw_hours", "urlop (godz.)", fmtHours),
    f("l4Hours", "l4_hours", "L4 (godz.)", fmtHours),
    f("maxHours", "max_hours", "godziny maks.", fmtHours),
    f("deductions", "deductions", "potrącenia", fmtMoney),
    f("bonuses", "bonuses", "dodatki", fmtMoney),
    f("objectUncertain", "object_uncertain", "przypisanie do potwierdzenia", fmtBool, false),
    f("notes", "notes", "uwagi"),
  ],
  hr_payroll: [
    // Kwoty Kadr są NETTO („na rękę”) — księgowość podaje do kadr wyłącznie
    // kwoty do wypłaty, bazy brutto aplikacja nie zna (patrz nagłówek
    // src/lib/object-personnel-cost.ts). Dziennik nazywa je tak samo jak
    // kolumny tabel, żeby „kwota główna: 3200 → 3400” nie było dwuznaczne.
    f("mainAmount", "main_amount", "kwota główna netto", fmtMoney),
    f("bonusRate", "bonus_rate", "stawka dodatku netto", fmtMoney),
    f("bonusRatePending", "bonus_rate_pending", "dodatek do przeliczenia", fmtBool, false),
    f("rateAdjustment", "rate_adjustment", "korekta stawki netto", fmtMoney),
    f("maxHoursOverride", "max_hours_override", "godziny maks. (nadpisanie)", fmtHours),
    f("actualHoursOverride", "actual_hours_override", "godziny faktyczne (nadpisanie)", fmtHours),
    f("bonusAmountOverride", "bonus_amount_override", "kwota dodatku netto (nadpisanie)", fmtMoney),
    f("notes", "notes", "uwagi"),
  ],
  hr_office: [
    f("company", "company", "spółka"),
    f("etatHours", "etat_hours", "godziny etatu", fmtHours),
    f("uwL4", "uw_l4", "UW/L4", fmtHours),
    f("deductions", "deductions", "potrącenia netto", fmtMoney),
    f("bonuses", "bonuses", "dodatki netto", fmtMoney),
    f("hoursForAccounting", "hours_for_accounting", "godziny do księgowej", fmtHours),
    f("rate", "rate", "stawka netto", fmtMoney),
    f("amount", "amount", "kwota netto", fmtMoney),
    f("rorBase", "ror_base", "podstawa ROR netto", fmtMoney),
    f("cashOverride", "cash_override", "gotówka netto (nadpisanie)", fmtMoney),
    f("notes", "notes", "uwagi"),
  ],
  hr_object: [
    f("name", "name", "nazwa"),
    f("objectId", "object_id", "obiekt z kartoteki", fmtCatalogObject),
    f("active", "active", "aktywny", fmtBool, false),
  ],
  hr_department: [
    f("name", "name", "nazwa"),
    f("isCmaPool", "is_cma_pool", "pula centrum monitorowania", fmtBool, false),
    // Flaga decyduje o tym, gdzie wolno rozliczyć obiekt — zmiana bez śladu
    // w dzienniku potrafiłaby unieważnić przypisania całego miesiąca.
    f("hasObjects", "has_objects", "dział obiektowy", fmtBool, false),
    f("color", "color", "kolor", undefined, false),
    // Sekcja sidebara, która wypełnia godziny tego działu sama („Godziny
    // działu”, src/lib/hr-scope.ts). Zmiana przenosi wiersze między sekcjami,
    // więc musi zostawiać ślad — inaczej „czemu CMA przestało widzieć swoje
    // godziny” nie ma jak się rozstrzygnąć.
    f("portal", "portal", "portal (sekcja)", undefined, false),
    f("sortOrder", "sort_order", "kolejność", fmtInt, false),
    f("active", "active", "aktywny", fmtBool, false),
  ],
  hr_norm: [
    f("workNorm", "work_norm", "norma pracy", fmtHours),
    f("contractNorm", "contract_norm", "norma zlecenia", fmtHours),
  ],
  // Święto jest wpisem „jest albo go nie ma” — edycji nie ma wcale, więc pola
  // służą wyłącznie podsumowaniu dodania i usunięcia.
  hr_holiday: [
    f("date", "date", "data", fmtDatePl),
    f("name", "name", "nazwa"),
    f(
      "source",
      "source",
      "pochodzenie",
      dict({ statutory: "ustawowe", custom: "własne" }),
      false,
    ),
  ],
  // Miesiąc nie jest formularzem: zmienia się jedno pole (stan), a przy
  // ponownym otwarciu dochodzi powód wpisany ręcznie w oknie.
  hr_month: [
    f("status", "status", "stan miesiąca", dict({ open: "otwarty", closed: "zamknięty" })),
    f("reopenReason", "reopen_reason", "powód ponownego otwarcia"),
  ],
};

/** Etykiety pól spłaszczone do jednej mapy — używa ich front (oś czasu). */
export const HR_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  HR_ENTITY_TYPES.flatMap((t) => HR_FIELDS[t].map((d) => [d.field, d.label])),
);

// ---------------------------------------------------------------------------
// Składanie summary
// ---------------------------------------------------------------------------

export interface HrLogContext {
  user: ActivityUser;
  /** Nazwisko i imię pracownika — summary zaczyna się od niego, gdy jest. */
  employeeName?: string | null;
  /** Okres danych miesięcznych — dopisek „(wrzesień 2026)”. */
  period?: HrPeriod | null;
}

const withEmployee = (ctx: HrLogContext, rest: string): string =>
  ctx.employeeName ? `${ctx.employeeName} — ${rest}` : rest;

const withPeriod = (ctx: HrLogContext, s: string): string =>
  ctx.period ? `${s} (${periodLabel(ctx.period)})` : s;

type Row = Record<string, unknown>;

/** Lista „etykieta: wartość” dla pól niepustych — treść podsumowania utworzenia. */
function filledFields(entityType: HrEntityType, row: Row, dbx: DbOrTx): string[] {
  return HR_FIELDS[entityType]
    .filter((d) => d.inCreated !== false && !isEmpty(row[d.key]))
    .map((d) => `${d.label}: ${d.format(row[d.key], dbx)}`);
}

/**
 * „Nagłówek” wiersza: to, po czym człowiek pozna, o który wpis chodzi, nawet
 * gdy wiersza już nie ma w bazie (usunięcia). Nazwisko dokłada `withEmployee`.
 */
function headline(entityType: HrEntityType, row: Row, dbx: DbOrTx): string {
  switch (entityType) {
    case "hr_employee":
      return fmtText(row.fullName);
    case "hr_contract":
      return [fmtText(row.company), fmtContractType(row.contractType)].join(", ");
    case "hr_hours": {
      const where =
        row.objectId != null
          ? fmtHrObject(row.objectId, dbx)
          : row.departmentId != null
            ? fmtHrDepartment(row.departmentId, dbx)
            : "bez przypisania";
      return [where, fmtHours(row.workedHours)].join(", ");
    }
    case "hr_office":
      return [fmtText(row.company), `kwota netto: ${fmtMoney(row.amount)}`].join(", ");
    case "hr_payroll":
      return `kwota główna netto: ${fmtMoney(row.mainAmount)}`;
    case "hr_object":
      return fmtText(row.name);
    case "hr_department":
      return fmtText(row.name);
    case "hr_norm":
      return `praca ${fmtHours(row.workNorm)}, zlecenie ${fmtHours(row.contractNorm)}`;
    case "hr_holiday":
      return `${fmtDatePl(row.date)} ${fmtText(row.name)}`;
    case "hr_month":
      // Okres jest już w `period` („(wrzesień 2026)”), więc nagłówek mówi tylko
      // o stanie — inaczej miesiąc pojawiałby się w zdaniu dwa razy.
      return fmtText(row.status);
  }
}

// ---------------------------------------------------------------------------
// Logowanie
// ---------------------------------------------------------------------------

export interface HrLogInput extends HrLogContext {
  entityType: HrEntityType;
  entityId: number;
}

/** Utworzenie wiersza — jeden wpis `created` z podsumowaniem wpisanych pól. */
export function logHrCreated(
  dbx: DbOrTx,
  input: HrLogInput & { after: Row },
): number {
  const { entityType, entityId, after } = input;
  const details = filledFields(entityType, after, dbx);
  // Nagłówek (nazwa/spółka/obiekt) już mówi najwięcej — resztę dopisujemy tylko
  // dla encji, które bez listy pól byłyby pustym „dodano wiersz”.
  const body =
    entityType === "hr_payroll" || entityType === "hr_norm"
      ? details.join(", ") || "bez danych"
      : headline(entityType, after, dbx);
  return logActivity(dbx, {
    entityType,
    entityId,
    user: input.user,
    action: "created",
    summary: withPeriod(input, withEmployee(input, `${CREATED_LABEL[entityType]}: ${body}`)),
  });
}

/**
 * Edycja — po JEDNYM wpisie `updated` na zmienione pole (stara i nowa wartość),
 * wszystkie z tym samym `created_at`, więc front skleja je w jedną operację.
 * Zwraca listę nazw zmienionych kolumn.
 */
export function logHrUpdated(
  dbx: DbOrTx,
  input: HrLogInput & { before: Row; after: Row },
): string[] {
  const { entityType, entityId, before, after } = input;
  const changed: string[] = [];
  for (const d of HR_FIELDS[entityType]) {
    // Pole nieobecne w `after` = zapis go nie dotyczył (PUT częściowy).
    if (!(d.key in after)) continue;
    const oldRaw = before[d.key];
    const newRaw = after[d.key];
    if (normalize(oldRaw) === normalize(newRaw)) continue;
    logActivity(dbx, {
      entityType,
      entityId,
      user: input.user,
      action: "updated",
      field: d.field,
      oldValue: normalize(oldRaw),
      newValue: normalize(newRaw),
      summary: withPeriod(
        input,
        withEmployee(input, `${d.label}: ${d.format(oldRaw, dbx)} → ${d.format(newRaw, dbx)}`),
      ),
    });
    changed.push(d.field);
  }
  return changed;
}

/**
 * Usunięcie wiersza — jeden wpis `deleted` z opisem tego, co zniknęło.
 *
 * `cascade` dopisuje, co poszło RAZEM z wierszem (FK `ON DELETE CASCADE`):
 * kasowanie pracownika zabiera jego godziny, wiersze biura i wypłaty jego umów,
 * a samo zdanie „Usunięto pracownika: Kowalski Jan” nie mówi o tym ani słowa —
 * po fakcie nie da się z dziennika odtworzyć, ile rozliczonych miesięcy zniknęło.
 */
export function logHrDeleted(
  dbx: DbOrTx,
  input: HrLogInput & { before: Row; cascade?: string | null },
): number {
  const { entityType, entityId, before } = input;
  const head = `${DELETED_LABEL[entityType]}: ${headline(entityType, before, dbx)}`;
  return logActivity(dbx, {
    entityType,
    entityId,
    user: input.user,
    action: "deleted",
    summary: withPeriod(
      input,
      withEmployee(input, input.cascade ? `${head} — razem z: ${input.cascade}` : head),
    ),
  });
}

/**
 * Wpis „ręczny” — dla operacji, które nie są CRUD-em jednego wiersza
 * (mapowanie pozycji na kartotekę, zbiorczy carry-over).
 */
export function logHrEvent(
  dbx: DbOrTx,
  input: HrLogInput & {
    action: ActivityAction;
    summary: string;
    field?: string | null;
    oldValue?: string | number | boolean | null;
    newValue?: string | number | boolean | null;
  },
): number {
  return logActivity(dbx, {
    entityType: input.entityType,
    entityId: input.entityId,
    user: input.user,
    action: input.action,
    field: input.field ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    summary: withPeriod(input, withEmployee(input, input.summary)),
  });
}

/** Wartość do kolumn old/new: null dla pustych, „1”/„0” dla boolean. */
function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = String(v);
  return s === "" ? null : s;
}
