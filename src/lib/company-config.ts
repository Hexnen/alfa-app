/**
 * Ustawienia firmy (tabela app_settings, klucze `company.*`) — adres biura, stawki domyślne
 * i konfiguracja automatu uzupełniającego realizacje (src/lib/realization-autofill.ts).
 *
 * Precedencja: DB → wartość domyślna (bez env, tak jak w src/lib/calendar-config.ts).
 * Wartości czytane przy KAŻDEJ operacji (bez restartu backendu), z fallbackiem na domyślne,
 * gdy wpis w bazie jest uszkodzony. Panel admina: /admin/firma (src/routes/admin-company.ts).
 */
import { getSetting } from "./settings.js";

// ---------------------------------------------------------------------------
// Słowniki
// ---------------------------------------------------------------------------

/** Skąd bierzemy dystans biuro → obiekt. */
export const KM_SOURCES = ["route", "straight", "manual"] as const;
export type KmSource = (typeof KM_SOURCES)[number];

export const KM_SOURCE_LABELS: Record<KmSource, string> = {
  route: "Trasa drogowa (OSRM)",
  straight: "Linia prosta × 1,3",
  manual: "Ręcznie (bez kalkulacji)",
};

/** Pola realizacji, które automat może wyliczyć. Kolejność = kolejność w panelu i w dialogu. */
export const AUTOFILL_FIELDS = [
  "actualHours",
  "amountHours",
  "amountMaterial",
  "actualKm",
  "amountKm",
  "hourlyCost",
  "caretaker",
] as const;
export type AutofillField = (typeof AUTOFILL_FIELDS)[number];

export const AUTOFILL_FIELD_LABELS: Record<AutofillField, string> = {
  actualHours: "Faktyczne godziny",
  amountHours: "Kwota za godziny",
  amountMaterial: "Kwota za materiały",
  actualKm: "Faktyczne km",
  amountKm: "Kwota za km",
  hourlyCost: "Koszt godzinowy",
  caretaker: "Opiekun",
};

/** Krótkie „skąd to się bierze” — do opisów w panelu admina. */
export const AUTOFILL_FIELD_HINTS: Record<AutofillField, string> = {
  actualHours: "Suma długości wydarzeń kalendarza; protokół z własnymi godzinami wygrywa.",
  amountHours: "Godziny × stawka RBH z cennika technika (fallback: stawka firmowa).",
  amountMaterial: "Pozycje protokołu wycenione po cenniku (tylko pozycje rodzaju „materiał”) + narzut.",
  actualKm: "Dystans biuro → obiekt (trasa OSRM lub linia prosta), opcjonalnie ×2.",
  amountKm: "Km × stawka za km z cennika (pozycja usługowa KM) lub stawka firmowa.",
  hourlyCost: "Wewnętrzny koszt roboczogodziny z ustawień firmy.",
  caretaker: "Brak źródła w modelu danych (obiekt/umowa nie mają pola opiekuna) — pomijane.",
};

/**
 * Pola, których automat NIE potrafi wyliczyć przy obecnym modelu danych.
 * `caretaker`: ani `objects`, ani `contracts` nie mają pola „opiekun” (jest tylko
 * `contractors.contact_person` = osoba kontaktowa klienta, co znaczy co innego).
 * Zostaje w słowniku, żeby checkbox nie zniknął, gdy pole kiedyś powstanie.
 */
export const AUTOFILL_UNAVAILABLE_FIELDS: readonly AutofillField[] = ["caretaker"];

/** Domyślnie objęte automatem: wszystko, co da się policzyć. */
export const DEFAULT_AUTOFILL_FIELDS: AutofillField[] = AUTOFILL_FIELDS.filter(
  (f) => !AUTOFILL_UNAVAILABLE_FIELDS.includes(f)
);

// ---------------------------------------------------------------------------
// Model ustawień
// ---------------------------------------------------------------------------

export interface CompanySettingsValues {
  /** Ulica i numer biura (punkt startowy kalkulacji km). */
  officeAddress: string;
  officeCity: string;
  officePostcode: string;
  /** Współrzędne biura; null = wyliczane geokoderem z adresu przy każdej kalkulacji. */
  officeLat: number | null;
  officeLng: number | null;
  /** Stawka netto za roboczogodzinę (zł/RBH) — fallback, gdy cennik nie ma pozycji RBH. */
  rateHour: number;
  /** Wewnętrzny koszt roboczogodziny (zł/h) → realizations.hourlyCost. */
  hourlyCost: number;
  /** Stawka za kilometr (zł/km) — fallback, gdy cennik nie ma pozycji usługowej KM. */
  rateKm: number;
  /** Czy liczyć dystans w obie strony (×2). */
  kmRoundTrip: boolean;
  /** Źródło dystansu: trasa OSRM / linia prosta ×1,3 / ręcznie (bez kalkulacji). */
  kmSource: KmSource;
  /** Narzut procentowy na materiały z protokołu (0 = bez narzutu). */
  materialMarkup: number;
  /** Główny włącznik automatu (dotyczy też haka po podpisaniu protokołu). */
  autofillEnabled: boolean;
  /** Pola objęte automatem. */
  autofillFields: AutofillField[];
  /**
   * Czy realizacja ma się wstępnie podliczać już po oznaczeniu wydarzenia jako „wykonane”
   * (bez czekania na podpis protokołu). Podrzędne wobec `autofillEnabled`.
   */
  autofillOnEventDone: boolean;
}

export type CompanySettingField = keyof CompanySettingsValues;
export type Source = "db" | "default";

export const COMPANY_DEFAULTS: CompanySettingsValues = {
  officeAddress: "",
  officeCity: "",
  officePostcode: "",
  officeLat: null,
  officeLng: null,
  rateHour: 0,
  hourlyCost: 0,
  rateKm: 0,
  kmRoundTrip: true,
  kmSource: "route",
  materialMarkup: 0,
  autofillEnabled: true,
  autofillFields: DEFAULT_AUTOFILL_FIELDS,
  autofillOnEventDone: true,
};

export type CompanyFieldType =
  | "string"
  | "number"
  | "latitude"
  | "longitude"
  | "boolean"
  | "enum"
  | "stringArray";

export interface CompanyFieldDef<T> {
  /** Klucz w app_settings. */
  dbKey: string;
  /** Etykieta PL do summary w activity_log i do panelu admina. */
  label: string;
  type: CompanyFieldType;
  /** Walidacja wartości z API (już w typie docelowym); zwraca komunikat błędu albo null. */
  validate: (v: unknown) => string | null;
  /** Normalizacja surowej wartości z JSON-a (np. „12,5” → 12.5) przed walidacją. */
  coerce?: (v: unknown) => unknown;
  /** Tekst z DB → wartość; undefined = nieprawidłowy wpis (lecimy dalej w precedencji). */
  parse: (raw: string) => T | undefined;
  /** Wartość → tekst do DB. */
  serialize: (v: T) => string;
  /** Formatowanie do summary. */
  format: (v: T) => string;
}

// --- helpery pól -----------------------------------------------------------

const toNumber = (v: unknown): unknown => {
  if (typeof v === "string") {
    const t = v.trim().replace(/\s/g, "").replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : v;
  }
  return v;
};

function stringField(dbKey: string, label: string, maxLen = 200): CompanyFieldDef<string> {
  return {
    dbKey,
    label,
    type: "string",
    validate: (v) => {
      if (typeof v !== "string") return `${label}: oczekiwano tekstu`;
      if (v.length > maxLen) return `${label}: maks. ${maxLen} znaków`;
      return null;
    },
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    parse: (raw) => raw,
    serialize: (v) => v,
    format: (v) => v || "(brak)",
  };
}

function numberField(
  dbKey: string,
  label: string,
  opts: { min: number; max: number; unit?: string }
): CompanyFieldDef<number> {
  return {
    dbKey,
    label,
    type: "number",
    validate: (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${label}: oczekiwano liczby`;
      if (v < opts.min || v > opts.max) return `${label}: dozwolony zakres ${opts.min}–${opts.max}`;
      return null;
    },
    coerce: toNumber,
    parse: (raw) => {
      const n = Number(raw.trim().replace(",", "."));
      return Number.isFinite(n) && n >= opts.min && n <= opts.max ? n : undefined;
    },
    serialize: (v) => String(v),
    format: (v) => `${v}${opts.unit ? ` ${opts.unit}` : ""}`,
  };
}

function coordField(
  dbKey: string,
  label: string,
  type: "latitude" | "longitude",
  limit: number
): CompanyFieldDef<number | null> {
  return {
    dbKey,
    label,
    type,
    validate: (v) => {
      if (v === null) return null;
      if (typeof v !== "number" || !Number.isFinite(v)) return `${label}: oczekiwano liczby albo null`;
      if (v < -limit || v > limit) return `${label}: dozwolony zakres ${-limit}–${limit}`;
      return null;
    },
    coerce: toNumber,
    parse: (raw) => {
      const t = raw.trim();
      if (t === "" || t.toLowerCase() === "null") return null;
      const n = Number(t.replace(",", "."));
      return Number.isFinite(n) && n >= -limit && n <= limit ? n : undefined;
    },
    serialize: (v) => (v === null ? "" : String(v)),
    format: (v) => (v === null ? "(brak)" : v.toFixed(6)),
  };
}

function booleanField(dbKey: string, label: string): CompanyFieldDef<boolean> {
  return {
    dbKey,
    label,
    type: "boolean",
    validate: (v) => (typeof v === "boolean" ? null : `${label}: oczekiwano true/false`),
    parse: (raw) => {
      const v = raw.trim().toLowerCase();
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return undefined;
    },
    serialize: (v) => (v ? "1" : "0"),
    format: (v) => (v ? "tak" : "nie"),
  };
}

const kmSourceField: CompanyFieldDef<KmSource> = {
  dbKey: "company.km_source",
  label: "Źródło dystansu",
  type: "enum",
  validate: (v) =>
    typeof v === "string" && (KM_SOURCES as readonly string[]).includes(v)
      ? null
      : `Źródło dystansu: dozwolone ${KM_SOURCES.join(", ")}`,
  parse: (raw) => {
    const v = raw.trim().toLowerCase();
    return (KM_SOURCES as readonly string[]).includes(v) ? (v as KmSource) : undefined;
  },
  serialize: (v) => v,
  format: (v) => KM_SOURCE_LABELS[v],
};

function checkAutofillFields(arr: unknown): string | null {
  if (!Array.isArray(arr)) return "Pola automatu: oczekiwano tablicy";
  if (arr.length > AUTOFILL_FIELDS.length) return `Pola automatu: maks. ${AUTOFILL_FIELDS.length} elementów`;
  for (const it of arr) {
    if (typeof it !== "string" || !it.trim()) return "Pola automatu: elementy muszą być niepustym tekstem";
    if (!(AUTOFILL_FIELDS as readonly string[]).includes(it.trim())) {
      return `Pola automatu: niedozwolona wartość „${it}” (dozwolone: ${AUTOFILL_FIELDS.join(", ")})`;
    }
  }
  return null;
}

const autofillFieldsField: CompanyFieldDef<AutofillField[]> = {
  dbKey: "company.autofill_fields",
  label: "Pola automatu",
  type: "stringArray",
  validate: checkAutofillFields,
  parse: (raw) => {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (checkAutofillFields(arr) !== null) return undefined;
      return [...new Set((arr as string[]).map((s) => s.trim() as AutofillField))];
    } catch {
      return undefined;
    }
  },
  serialize: (v) => JSON.stringify([...new Set(v)]),
  format: (v) => (v.length ? v.map((f) => AUTOFILL_FIELD_LABELS[f]).join(", ") : "(brak)"),
};

export const COMPANY_FIELDS: { [K in CompanySettingField]: CompanyFieldDef<CompanySettingsValues[K]> } = {
  officeAddress: stringField("company.office_address", "Adres biura"),
  officeCity: stringField("company.office_city", "Miejscowość biura", 80),
  officePostcode: stringField("company.office_postcode", "Kod pocztowy biura", 12),
  officeLat: coordField("company.office_lat", "Szerokość geograficzna biura", "latitude", 90),
  officeLng: coordField("company.office_lng", "Długość geograficzna biura", "longitude", 180),
  rateHour: numberField("company.rate_hour", "Stawka za roboczogodzinę", { min: 0, max: 100000, unit: "zł/RBH" }),
  hourlyCost: numberField("company.hourly_cost", "Koszt roboczogodziny", { min: 0, max: 100000, unit: "zł/h" }),
  rateKm: numberField("company.rate_km", "Stawka za kilometr", { min: 0, max: 1000, unit: "zł/km" }),
  kmRoundTrip: booleanField("company.km_round_trip", "Dystans w obie strony"),
  kmSource: kmSourceField,
  materialMarkup: numberField("company.material_markup", "Narzut na materiały", { min: -100, max: 1000, unit: "%" }),
  autofillEnabled: booleanField("company.autofill_enabled", "Automat uzupełniania"),
  autofillFields: autofillFieldsField,
  autofillOnEventDone: booleanField(
    "company.autofill_on_event_done",
    "Podliczanie po oznaczeniu wydarzenia jako wykonane"
  ),
};

export const COMPANY_FIELD_NAMES = Object.keys(COMPANY_FIELDS) as CompanySettingField[];

/** Wartość efektywna jednego pola + źródło (DB → domyślna). */
export function resolveCompanyField<K extends CompanySettingField>(
  name: K
): { value: CompanySettingsValues[K]; source: Source } {
  const def = COMPANY_FIELDS[name] as CompanyFieldDef<CompanySettingsValues[K]>;
  const fromDb = getSetting(def.dbKey);
  if (fromDb !== null) {
    const v = def.parse(fromDb);
    if (v !== undefined) return { value: v, source: "db" };
  }
  return { value: COMPANY_DEFAULTS[name], source: "default" };
}

export interface CompanyConfig {
  values: CompanySettingsValues;
  sources: Record<CompanySettingField, Source>;
}

/** Wszystkie ustawienia firmy (tanie zapytania po PK — wołane przy każdej kalkulacji). */
export function getCompanyConfig(): CompanyConfig {
  const values = {} as CompanySettingsValues;
  const sources = {} as Record<CompanySettingField, Source>;
  for (const name of COMPANY_FIELD_NAMES) {
    const r = resolveCompanyField(name);
    (values as unknown as Record<string, unknown>)[name] = r.value;
    sources[name] = r.source;
  }
  return { values, sources };
}

/** Czy pole jest objęte automatem wg ustawień (i czy w ogóle da się je policzyć). */
export function isAutofillField(field: AutofillField, values: Pick<CompanySettingsValues, "autofillFields">): boolean {
  if (AUTOFILL_UNAVAILABLE_FIELDS.includes(field)) return false;
  return values.autofillFields.includes(field);
}

/** Pełny adres biura jednym stringiem (zapytanie do geokodera / etykieta punktu). */
export function officeAddressLine(values: Pick<CompanySettingsValues, "officeAddress" | "officeCity" | "officePostcode">): string {
  const tail = [values.officePostcode, values.officeCity].map((s) => s.trim()).filter(Boolean).join(" ");
  return [values.officeAddress.trim(), tail].filter(Boolean).join(", ");
}

/** Słowniki dla panelu admina (meta w GET /admin/company/settings). */
export function companySettingsMeta() {
  return {
    kmSources: KM_SOURCES.map((m) => ({ value: m, label: KM_SOURCE_LABELS[m] })),
    autofillFields: AUTOFILL_FIELDS.map((f) => ({
      value: f,
      label: AUTOFILL_FIELD_LABELS[f],
      hint: AUTOFILL_FIELD_HINTS[f],
      available: !AUTOFILL_UNAVAILABLE_FIELDS.includes(f),
    })),
    defaultAutofillFields: [...DEFAULT_AUTOFILL_FIELDS],
    unavailableAutofillFields: [...AUTOFILL_UNAVAILABLE_FIELDS],
    fieldTypes: Object.fromEntries(
      COMPANY_FIELD_NAMES.map((n) => [n, COMPANY_FIELDS[n].type])
    ) as Record<CompanySettingField, CompanyFieldType>,
    fieldLabels: Object.fromEntries(
      COMPANY_FIELD_NAMES.map((n) => [n, COMPANY_FIELDS[n].label])
    ) as Record<CompanySettingField, string>,
  };
}
