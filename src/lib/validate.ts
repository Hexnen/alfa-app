/**
 * Wspólne walidatory wejścia dla tras CRM (zlecenia, obiekty, kontrahenci, umowy,
 * wyceny) — używane zarówno przez publiczny formularz ZDW, jak i wewnętrzne API.
 *
 * ZASADA: każdy helper przyjmuje `unknown`, a nie ufa typom z interfejsów
 * `*Input` — te opisują, co klient POWINIEN wysłać, a nie to, co wysłał.
 * Bughunt pokazał, że `monthlyAmount: "abc"` lądowało jako TEXT w kolumnie REAL,
 * `cameraCount: {}` wywalało 500, a spread body do `.set()` pozwalał nadpisać
 * `id`/`createdAt` i wpisać dowolny string w kolumnę z enumem.
 *
 * Błąd walidacji leci jako `ValidationError` — trasa łapie go jednym `catch`
 * (`validationResponse`) i odpowiada 400 z polskim komunikatem.
 *
 * Konwencja wartości:
 *   - `undefined` w wyniku = klient pola NIE przysłał (PUT: „bez zmian"),
 *   - `null` = klient jawnie wyczyścił pole (`null` albo pusty string),
 *   - dla `required` oba powyższe kończą się błędem.
 */
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

export class ValidationError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface NumberOptions {
  /** Nazwa pola do komunikatu. */
  label: string;
  /** Dolna granica (domyślnie 0 — kwoty i liczniki nie bywają ujemne). */
  min?: number;
  max?: number;
  /** Tylko liczby całkowite (liczniki, długości umów, id). */
  integer?: boolean;
  /** Pole obowiązkowe — `undefined`/`null`/"" → błąd. */
  required?: boolean;
}

/**
 * Liczba z formularza. Przyjmuje `number` albo string („12,5" → 12.5 — polskie
 * formularze piszą przecinek); tablica/obiekt/boolean → błąd. `Infinity`/NaN → błąd.
 */
export function parseNumber(raw: unknown, opts: NumberOptions): number | null | undefined {
  const { label, min = 0, max, integer = false, required = false } = opts;
  if (raw === undefined) {
    if (required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return undefined;
  }
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return null;
  }
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/\s+/g, "").replace(",", ".");
    // Number("") = 0 i Number("0x10") = 16 — obie pułapki odcinamy wzorcem.
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new ValidationError(`Pole „${label}” musi być liczbą`);
    }
    n = Number(trimmed);
  } else {
    throw new ValidationError(`Pole „${label}” musi być liczbą`);
  }
  if (!Number.isFinite(n)) throw new ValidationError(`Pole „${label}” musi być liczbą`);
  if (integer && !Number.isInteger(n)) {
    throw new ValidationError(`Pole „${label}” musi być liczbą całkowitą`);
  }
  if (n < min) throw new ValidationError(`Pole „${label}” nie może być mniejsze niż ${min}`);
  if (max !== undefined && n > max) {
    throw new ValidationError(`Pole „${label}” nie może być większe niż ${max}`);
  }
  return n;
}

export interface StringOptions {
  label: string;
  /** Maksymalna długość (po przycięciu białych znaków). */
  max?: number;
  required?: boolean;
  /** Nie przycinaj białych znaków (np. treść notatki). */
  keepWhitespace?: boolean;
}

/** Limity długości — jedno miejsce, żeby formularz publiczny i wewnętrzny miały te same. */
export const STR = {
  NAME: 200,
  SHORT: 100,
  ADDRESS: 300,
  EMAIL: 254,
  PHONE: 40,
  URL: 2000,
  NOTES: 5000,
} as const;

/**
 * String z formularza. Liczba/boolean/tablica/obiekt → błąd (a nie `String(x)`),
 * bo `notes: {}` zapisane jako "[object Object]" to śmieć w bazie.
 */
export function parseString(raw: unknown, opts: StringOptions): string | null | undefined {
  const { label, max, required = false, keepWhitespace = false } = opts;
  if (raw === undefined) {
    if (required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return undefined;
  }
  if (raw === null) {
    if (required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return null;
  }
  if (typeof raw !== "string") throw new ValidationError(`Pole „${label}” musi być tekstem`);
  const value = keepWhitespace ? raw : raw.trim();
  if (value === "") {
    if (required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return null;
  }
  if (max !== undefined && value.length > max) {
    throw new ValidationError(`Pole „${label}” jest zbyt długie (maks. ${max} znaków)`);
  }
  return value;
}

/** Wymagany, niepusty string — skrót dla pól NOT NULL. */
export function requireString(raw: unknown, label: string, max: number = STR.NAME): string {
  return parseString(raw, { label, max, required: true }) as string;
}

/**
 * Wartość ze słownika. Nieznana wartość → 400, a nie cichy zapis w kolumnie z
 * `enum` (SQLite go nie egzekwuje — drizzle tylko typuje).
 */
export function parseEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
  opts: { required?: boolean } = {}
): T | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) throw new ValidationError(`Pole „${label}” jest wymagane`);
    return undefined;
  }
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `Pole „${label}” ma niedozwoloną wartość — dozwolone: ${allowed.join(", ")}`
    );
  }
  return raw as T;
}

/** Boolean; przyjmuje też "true"/"false"/1/0 — formularze bywają różne. */
export function parseBool(raw: unknown, label: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === "1" || raw === "true") return true;
  if (raw === 0 || raw === "0" || raw === "false") return false;
  throw new ValidationError(`Pole „${label}” musi mieć wartość tak/nie`);
}

/** Data `YYYY-MM-DD`, która istnieje w kalendarzu (2026-02-30 → błąd). */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseDate(
  raw: unknown,
  label: string,
  opts: { required?: boolean } = {}
): string | null | undefined {
  const s = parseString(raw, { label, max: 10, required: opts.required });
  if (s === undefined || s === null) return s;
  if (!isValidDate(s)) throw new ValidationError(`Pole „${label}” musi być datą w formacie RRRR-MM-DD`);
  return s;
}

/** Podstawowy format e-maila: coś@coś.coś, bez spacji. */
export function isValidEmail(value: string): boolean {
  return value.length <= STR.EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function parseEmail(
  raw: unknown,
  label: string,
  opts: { required?: boolean } = {}
): string | null | undefined {
  const s = parseString(raw, { label, max: STR.EMAIL, required: opts.required });
  if (s === undefined || s === null) return s;
  if (!isValidEmail(s)) throw new ValidationError(`Pole „${label}” musi być adresem e-mail`);
  return s;
}

/**
 * Telefon: cyfry, spacje, +, -, nawiasy, kropki; co najmniej 3 cyfry. Formularze
 * przysyłają „+48 600 700 800", „(12) 345-67-89", „600700800" — wszystko przechodzi.
 */
export function isValidPhone(value: string): boolean {
  if (value.length > STR.PHONE) return false;
  if (!/^[+\d\s().-]+$/.test(value)) return false;
  return (value.match(/\d/g) ?? []).length >= 3;
}

export function parsePhone(
  raw: unknown,
  label: string,
  opts: { required?: boolean } = {}
): string | null | undefined {
  const s = parseString(raw, { label, max: STR.PHONE, required: opts.required });
  if (s === undefined || s === null) return s;
  if (!isValidPhone(s)) throw new ValidationError(`Pole „${label}” musi być numerem telefonu`);
  return s;
}

/** Adres http(s) — bez `javascript:` ani ścieżek względnych w kolumnie z linkiem. */
export function parseHttpUrl(raw: unknown, label: string): string | null | undefined {
  const s = parseString(raw, { label, max: STR.URL });
  if (s === undefined || s === null) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new ValidationError(`Pole „${label}” musi być adresem http(s)`);
  }
  return s;
}

/** Dodatnia liczba całkowita — identyfikator wiersza. */
export function parseId(
  raw: unknown,
  label: string,
  opts: { required?: boolean } = {}
): number | null | undefined {
  return parseNumber(raw, { label, min: 1, integer: true, required: opts.required });
}

/** Tabele, do których trasy CRM sprawdzają klucze obce. */
const FK_TABLES = {
  contractors: schema.contractors,
  objects: schema.objects,
  salespeople: schema.salespeople,
  companies: schema.companies,
  orders: schema.orders,
} as const;
export type FkTable = keyof typeof FK_TABLES;

const FK_LABELS: Record<FkTable, string> = {
  contractors: "Kontrahent",
  objects: "Obiekt",
  salespeople: "Handlowiec",
  companies: "Spółka",
  orders: "Zlecenie",
};

/** Czy wiersz o tym id istnieje (synchronicznie — wolno wołać w transakcji). */
export function rowExists(table: FkTable, id: number): boolean {
  const t = FK_TABLES[table];
  return db.select({ id: t.id }).from(t).where(eq(t.id, id)).get() !== undefined;
}

/**
 * Klucz obcy z body: `undefined` = nie ruszaj, `null` = odpnij (jeśli `nullable`),
 * liczba = musi istnieć → inaczej 400 „Kontrahent #99 nie istnieje". Sprawdzamy
 * jawnie, a nie łapiemy błąd FK z SQLite: w bazie część kluczy powstała przez
 * ALTER TABLE i nie wszędzie jest egzekwowana tak, jak mówi schema.ts.
 */
export function parseFk(
  raw: unknown,
  table: FkTable,
  label: string,
  opts: { required?: boolean; nullable?: boolean } = {}
): number | null | undefined {
  const id = parseId(raw, label, { required: opts.required });
  if (id === undefined) return undefined;
  if (id === null) {
    if (opts.nullable === false || opts.required) {
      throw new ValidationError(`Pole „${label}” jest wymagane`);
    }
    return null;
  }
  if (!rowExists(table, id)) {
    throw new ValidationError(`${FK_LABELS[table]} #${id} nie istnieje`);
  }
  return id;
}

/**
 * Body żądania jako zwykły obiekt. Tablica, string, `null` i niepoprawny JSON →
 * 400, a nie 500 z `Cannot read properties of null`.
 */
export function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("Nieprawidłowe dane formularza");
  }
  return raw as Record<string, unknown>;
}

/**
 * Pola, których klient nigdy nie ustawia: identyfikator i znaczniki czasu nadaje
 * baza. Ich obecność w PUT to próba mass assignment (albo błąd klienta) → 400.
 */
export function rejectReadonlyFields(body: Record<string, unknown>, extra: string[] = []): void {
  for (const key of ["id", "createdAt", "updatedAt", ...extra]) {
    if (key in body) {
      throw new ValidationError(`Pole „${key}” nie może być zmieniane`);
    }
  }
}

/** Usuwa z obiektu klucze o wartości `undefined` — żeby `.set()` ich nie zobaczył. */
export function compact<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** `true`, gdy błąd jest błędem walidacji (do `catch` w trasach). */
export function isValidationError(err: unknown): err is ValidationError {
  return err instanceof ValidationError;
}
