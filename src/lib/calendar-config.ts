/**
 * Ustawienia kalendarza (tabela app_settings, klucze `calendar.*`) — sterują automatycznym
 * tworzeniem realizacji z wydarzeń (src/lib/calendar-realizations.ts).
 *
 * Precedencja: DB → wartość domyślna (bez zmiennych env — inaczej niż asystent).
 * Wartości czytane przy KAŻDEJ operacji (bez restartu backendu), z fallbackiem na domyślne,
 * gdy wpis w bazie jest uszkodzony. Panel admina: /admin/kalendarz (src/routes/admin-calendar.ts).
 */
import { CALENDAR_EVENT_TYPES, type CalendarEventType } from "../db/schema.js";
import { getSetting } from "./settings.js";

/** Kiedy powstaje realizacja dla wydarzenia objętego typu. */
export const AUTO_REALIZATION_MODES = ["on_create", "on_done", "off"] as const;
export type AutoRealizationMode = (typeof AUTO_REALIZATION_MODES)[number];

export const AUTO_REALIZATION_LABELS: Record<AutoRealizationMode, string> = {
  on_create: "Przy zapisie wydarzenia",
  on_done: "Dopiero po oznaczeniu jako wykonane",
  off: "Nigdy (tylko ręczne podpięcie)",
};

/** Typy, dla których realizacja NIGDY nie powstaje (urlop to nieobecność, nie praca na obiekcie). */
export const REALIZATION_FORBIDDEN_TYPES: readonly CalendarEventType[] = ["urlop"];

/** Typy, które admin może zaznaczyć jako „objęte” (wszystkie poza zabronionymi). */
export const REALIZATION_ALLOWED_TYPES: CalendarEventType[] = CALENDAR_EVENT_TYPES.filter(
  (t) => !REALIZATION_FORBIDDEN_TYPES.includes(t)
);

/** Domyślnie objęte: prace na obiekcie (bez biura i przygotowania). */
export const DEFAULT_REALIZATION_TYPES: CalendarEventType[] = ["serwis", "montaz", "wizja", "demontaz", "konserwacja"];

export interface CalendarSettingsValues {
  /** Kiedy tworzyć realizację: przy zapisie / przy statusie „wykonane” / nigdy. */
  autoRealization: AutoRealizationMode;
  /** Typy wydarzeń objęte automatyczną realizacją. */
  realizationTypes: CalendarEventType[];
  /** Czy edycja wydarzenia aktualizuje powiązaną (niezafakturowaną) realizację. */
  realizationSync: boolean;
  /**
   * Czy dla PŁATNEGO wydarzenia (billing = paid) powstaje wycena — razem z realizacją
   * i protokołem. Zmiana rozliczenia na gwarancyjne/darmowe kasuje pustą wycenę.
   */
  autoQuote: boolean;
}

export type CalendarSettingField = keyof CalendarSettingsValues;
export type Source = "db" | "default";

export const CALENDAR_DEFAULTS: CalendarSettingsValues = {
  autoRealization: "on_create",
  realizationTypes: DEFAULT_REALIZATION_TYPES,
  realizationSync: true,
  autoQuote: true,
};

export interface CalendarFieldDef<T> {
  /** Klucz w app_settings. */
  dbKey: string;
  /** Etykieta PL do summary w activity_log i do panelu admina. */
  label: string;
  type: "enum" | "stringArray" | "boolean";
  /** Walidacja wartości z API (już w typie docelowym); zwraca komunikat błędu albo null. */
  validate: (v: unknown) => string | null;
  /** Tekst z DB → wartość; undefined = nieprawidłowy wpis (lecimy dalej w precedencji). */
  parse: (raw: string) => T | undefined;
  /** Wartość → tekst do DB. */
  serialize: (v: T) => string;
  /** Formatowanie do summary. */
  format: (v: T) => string;
}

const autoRealizationField: CalendarFieldDef<AutoRealizationMode> = {
  dbKey: "calendar.auto_realization",
  label: "Tworzenie realizacji",
  type: "enum",
  validate: (v) =>
    typeof v === "string" && (AUTO_REALIZATION_MODES as readonly string[]).includes(v)
      ? null
      : `Tworzenie realizacji: dozwolone ${AUTO_REALIZATION_MODES.join(", ")}`,
  parse: (raw) => {
    const v = raw.trim().toLowerCase();
    return (AUTO_REALIZATION_MODES as readonly string[]).includes(v) ? (v as AutoRealizationMode) : undefined;
  },
  serialize: (v) => v,
  format: (v) => AUTO_REALIZATION_LABELS[v],
};

function checkTypes(arr: unknown): string | null {
  if (!Array.isArray(arr)) return "Typy objęte realizacją: oczekiwano tablicy";
  if (arr.length > REALIZATION_ALLOWED_TYPES.length) return `Typy objęte realizacją: maks. ${REALIZATION_ALLOWED_TYPES.length} elementów`;
  for (const it of arr) {
    if (typeof it !== "string" || !it.trim()) return "Typy objęte realizacją: elementy muszą być niepustym tekstem";
    if (!REALIZATION_ALLOWED_TYPES.includes(it.trim() as CalendarEventType)) {
      return `Typy objęte realizacją: niedozwolona wartość „${it}” (dozwolone: ${REALIZATION_ALLOWED_TYPES.join(", ")})`;
    }
  }
  return null;
}

const realizationTypesField: CalendarFieldDef<CalendarEventType[]> = {
  dbKey: "calendar.realization_types",
  label: "Typy objęte realizacją",
  type: "stringArray",
  validate: checkTypes,
  parse: (raw) => {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (checkTypes(arr) !== null) return undefined;
      return [...new Set((arr as string[]).map((s) => s.trim() as CalendarEventType))];
    } catch {
      return undefined;
    }
  },
  serialize: (v) => JSON.stringify([...new Set(v)]),
  format: (v) => (v.length ? v.join(", ") : "(brak)"),
};

const realizationSyncField: CalendarFieldDef<boolean> = {
  dbKey: "calendar.realization_sync",
  label: "Synchronizacja realizacji",
  type: "boolean",
  validate: (v) => (typeof v === "boolean" ? null : "Synchronizacja realizacji: oczekiwano true/false"),
  parse: (raw) => {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return undefined;
  },
  serialize: (v) => (v ? "1" : "0"),
  format: (v) => (v ? "tak" : "nie"),
};

const autoQuoteField: CalendarFieldDef<boolean> = {
  dbKey: "calendar.auto_quote",
  label: "Wycena dla płatnych",
  type: "boolean",
  validate: (v) => (typeof v === "boolean" ? null : "Wycena dla płatnych: oczekiwano true/false"),
  parse: (raw) => {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return undefined;
  },
  serialize: (v) => (v ? "1" : "0"),
  format: (v) => (v ? "tak" : "nie"),
};

export const CALENDAR_FIELDS: { [K in CalendarSettingField]: CalendarFieldDef<CalendarSettingsValues[K]> } = {
  autoRealization: autoRealizationField,
  realizationTypes: realizationTypesField,
  realizationSync: realizationSyncField,
  autoQuote: autoQuoteField,
};

export const CALENDAR_FIELD_NAMES = Object.keys(CALENDAR_FIELDS) as CalendarSettingField[];

/** Wartość efektywna jednego pola + źródło (DB → domyślna). */
export function resolveCalendarField<K extends CalendarSettingField>(
  name: K
): { value: CalendarSettingsValues[K]; source: Source } {
  const def = CALENDAR_FIELDS[name] as CalendarFieldDef<CalendarSettingsValues[K]>;
  const fromDb = getSetting(def.dbKey);
  if (fromDb !== null) {
    const v = def.parse(fromDb);
    if (v !== undefined) return { value: v, source: "db" };
  }
  return { value: CALENDAR_DEFAULTS[name], source: "default" };
}

export interface CalendarConfig {
  values: CalendarSettingsValues;
  sources: Record<CalendarSettingField, Source>;
}

/** Wszystkie ustawienia kalendarza (tanie zapytania po PK — wołane przy każdej mutacji). */
export function getCalendarConfig(): CalendarConfig {
  const values = {} as CalendarSettingsValues;
  const sources = {} as Record<CalendarSettingField, Source>;
  for (const name of CALENDAR_FIELD_NAMES) {
    const r = resolveCalendarField(name);
    (values as unknown as Record<string, unknown>)[name] = r.value;
    sources[name] = r.source;
  }
  return { values, sources };
}

/** Czy typ wydarzenia jest objęty automatyczną realizacją (urlop nigdy). */
export function isRealizationType(type: CalendarEventType, values: Pick<CalendarSettingsValues, "realizationTypes">): boolean {
  if (REALIZATION_FORBIDDEN_TYPES.includes(type)) return false;
  return values.realizationTypes.includes(type);
}

/** Słowniki dla panelu admina (meta w GET /admin/calendar/settings). */
export function calendarSettingsMeta() {
  return {
    autoRealizationModes: AUTO_REALIZATION_MODES.map((m) => ({ value: m, label: AUTO_REALIZATION_LABELS[m] })),
    allowedTypes: [...REALIZATION_ALLOWED_TYPES],
    forbiddenTypes: [...REALIZATION_FORBIDDEN_TYPES],
    defaultTypes: [...DEFAULT_REALIZATION_TYPES],
  };
}
