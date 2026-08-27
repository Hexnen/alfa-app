/**
 * Lokalne znaczniki „to pole uzupełnił automat" — awaryjny nośnik badge'a „auto"
 * w tabeli realizacji, gdy backend nie zwraca kolumny `autofill`.
 *
 * Znacznik jest wiązany z `updatedAt` realizacji: gdy ktoś ją potem edytuje
 * ręcznie, znacznik przestaje pasować i badge sam znika (bez sprzątania).
 */
import type { Realization } from "@/lib/api";

const KEY = "alfa.realizations.autofill";
/** Ile realizacji pamiętamy (starsze wypadają — to tylko podpowiedź w UI). */
const MAX_ENTRIES = 300;

type Mark = { fields: string[]; updatedAt: string };
type Store = Record<string, Mark>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store) {
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[k];
    }
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* brak localStorage (tryb prywatny) — badge po prostu nie przetrwa odświeżenia */
  }
}

/** Zapamiętuje pola uzupełnione automatem dla wersji realizacji `updatedAt`. */
export function markAutofilled(id: number, fields: string[], updatedAt: string) {
  if (fields.length === 0) return;
  const store = read();
  const prev = store[String(id)];
  const merged =
    prev && prev.updatedAt === updatedAt ? Array.from(new Set([...prev.fields, ...fields])) : fields;
  delete store[String(id)]; // usuń i dopisz na końcu — utrzymuje kolejność „ostatnio użyte"
  store[String(id)] = { fields: merged, updatedAt };
  write(store);
}

/**
 * Nazwy pól ze śladu automatu. Backend zapisuje mapę `{ pole: {source, detail} }`,
 * ale przyjmujemy też samą listę pól — i jedno, i drugie może przyjść jako JSON
 * w tekście (kolumna `autofill`).
 */
function fieldsFromApi(raw: Realization["autofill"]): string[] | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null; // nie-JSON — traktujemy jak brak danych
    }
  }
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? keys : null;
  }
  return null;
}

/** Pola z backendu (`autofill`) albo z lokalnego znacznika pasującego wersją. */
export function autofillFieldsFor(row: Realization): string[] {
  const fromApi = fieldsFromApi(row.autofill);
  if (fromApi) return fromApi;
  const mark = read()[String(row.id)];
  return mark && mark.updatedAt === row.updatedAt ? mark.fields : [];
}
