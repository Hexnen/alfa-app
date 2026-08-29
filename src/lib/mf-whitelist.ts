/**
 * Wyszukiwarka firm — Wykaz podatników VAT („biała lista”) Ministerstwa Finansów.
 *
 * API: GET https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=YYYY-MM-DD
 * Nie wymaga klucza ani rejestracji. Zwraca nazwę, adres, REGON, KRS, status VAT
 * i rachunki bankowe podmiotu na wskazany dzień.
 *
 * Zasady (jak w src/lib/geo.ts):
 *  - każde zapytanie idzie najpierw do cache'u w pamięci (TTL 12 h) — MF limituje ruch,
 *  - brak sieci / timeout / błąd HTTP NIGDY nie rzuca wyjątkiem: funkcje zwracają
 *    `{ error }`, a trasa zamienia to na czytelny komunikat zamiast 500,
 *  - błędów NIE cache'ujemy (chwilowy brak sieci nie może zatruć wyniku na 12 h),
 *  - `MF_OFFLINE=1` (albo `setMfFetch` w testach) całkowicie wyłącza sieć.
 */
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { zonedToday } from "./tz.js";

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

export const MF_API_URL = "https://wl-api.mf.gov.pl/api/search/nip";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Ile różnych NIP-ów trzymamy w pamięci (LRU-ish: najstarszy wpis leci pierwszy). */
const CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------

/** Status podmiotu w wykazie VAT. `null` = MF nie podał statusu. */
export type VatStatus = "Czynny" | "Zwolniony" | "Niezarejestrowany" | null;

export interface CompanyData {
  nip: string;
  name: string;
  /** Ulica z numerem — pierwszy człon adresu MF. */
  address: string;
  postalCode: string;
  city: string;
  regon: string;
  krs: string;
  statusVat: VatStatus;
  /** Rachunki firmowe zgłoszone do wykazu (mogą się przydać przy przelewach). */
  accountNumbers: string[];
  /** Pełny adres w postaci zwróconej przez MF — gdy parser nie da rady rozbić. */
  rawAddress: string;
  /** Dzień, na który MF zwrócił dane ("YYYY-MM-DD"). */
  date: string;
}

export interface CompanyLookupResult {
  found: boolean;
  company: CompanyData | null;
  /** true = odpowiedź z cache'u (bez ruchu do MF). */
  cached: boolean;
}

export interface MfError {
  error: string;
}

export type MfOutcome<T> = T | MfError;

export function isMfError<T>(v: MfOutcome<T>): v is MfError {
  return typeof v === "object" && v !== null && "error" in v;
}

// ---------------------------------------------------------------------------
// Wstrzykiwanie fetcha (testy) i tryb offline
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike | null = null;

/** Podmienia fetch (testy). `null` przywraca globalny. */
export function setMfFetch(f: FetchLike | null): void {
  fetchImpl = f;
}

function offline(): boolean {
  return process.env.MF_OFFLINE === "1";
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  value: CompanyLookupResult;
}

const cache = new Map<string, CacheEntry>();

/** Klucz cache'u — NIP + dzień, bo status VAT jest podawany „na datę”. */
function cacheKey(nip: string, date: string): string {
  return `${nip}:${date}`;
}

function cacheGet(key: string): CompanyLookupResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: CompanyLookupResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Czyści cache (testy / ręczne odświeżenie). */
export function clearMfCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Parsowanie adresu
// ---------------------------------------------------------------------------

const POSTAL_RE = /(\d{2}-\d{3})/;

/**
 * MF podaje adres jednym stringiem, np. "UL. TESTOWA 1 LOK. 2, 00-001 WARSZAWA".
 * Rozbijamy na ulicę / kod / miasto; gdy formatu nie da się rozpoznać, cały tekst
 * ląduje w `address`, a kod i miasto zostają puste (lepiej to niż zgadywanie).
 */
export function parseMfAddress(raw: string): {
  address: string;
  postalCode: string;
  city: string;
} {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return { address: "", postalCode: "", city: "" };

  const match = POSTAL_RE.exec(text);
  if (!match) return { address: text, postalCode: "", city: "" };

  const postalCode = match[1];
  const before = text.slice(0, match.index).replace(/[,\s]+$/, "").trim();
  const after = text.slice(match.index + postalCode.length).replace(/^[,\s]+/, "").trim();

  return { address: before, postalCode, city: after };
}

/** "UL. TESTOWA 1" → "ul. Testowa 1" — MF zwraca WERSALIKI, w bazie trzymamy ładniej. */
export function titleCasePl(text: string): string {
  if (!text) return "";
  // Skróty adresowe i jednoliterowe człony zostawiamy małymi literami.
  const lower = new Set(["ul", "al", "pl", "os", "lok", "m"]);
  return text
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!part.trim() || part === "-") return part;
      const bare = part.replace(/\./g, "");
      if (lower.has(bare)) return part;
      // Numery i skróty typu "sp." / "z" zostawiamy bez zmian poza pierwszą literą.
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Zapytanie do MF
// ---------------------------------------------------------------------------

/** Kształt odpowiedzi MF, w części której faktycznie używamy. */
interface MfSubject {
  name?: string;
  nip?: string;
  statusVat?: string;
  regon?: string;
  krs?: string;
  workingAddress?: string | null;
  residenceAddress?: string | null;
  accountNumbers?: string[];
}

function normalizeStatus(raw: string | undefined): VatStatus {
  const s = (raw || "").trim().toLowerCase();
  if (s === "czynny") return "Czynny";
  if (s === "zwolniony") return "Zwolniony";
  if (!s) return null;
  return "Niezarejestrowany";
}

function toCompany(subject: MfSubject, nip: string, date: string): CompanyData {
  // Adres siedziby (`workingAddress`) bywa pusty dla JDG — wtedy adres zamieszkania.
  const rawAddress = (subject.workingAddress || subject.residenceAddress || "").trim();
  const parsed = parseMfAddress(rawAddress);
  return {
    nip: normalizeNIP(subject.nip || nip),
    name: (subject.name || "").trim(),
    address: titleCasePl(parsed.address),
    postalCode: parsed.postalCode,
    city: titleCasePl(parsed.city),
    regon: (subject.regon || "").trim(),
    krs: (subject.krs || "").trim(),
    statusVat: normalizeStatus(subject.statusVat),
    accountNumbers: Array.isArray(subject.accountNumbers) ? subject.accountNumbers : [],
    rawAddress,
    date,
  };
}

/**
 * Szuka firmy po NIP w wykazie MF. Nie rzuca — zwraca `{ error }` przy problemach
 * z siecią albo odmowie ze strony MF (np. przekroczony limit zapytań).
 */
export async function lookupCompanyByNip(
  nip: string,
  opts: { date?: string; skipCache?: boolean } = {}
): Promise<MfOutcome<CompanyLookupResult>> {
  const normalized = normalizeNIP(nip);
  if (!validateNIP(normalized)) {
    return { error: "Nieprawidłowy NIP (błędna suma kontrolna)" };
  }

  const date = opts.date || zonedToday();
  const key = cacheKey(normalized, date);

  if (!opts.skipCache) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  if (offline() && !fetchImpl) {
    return { error: "Wyszukiwarka firm wyłączona (MF_OFFLINE=1)" };
  }

  const doFetch = fetchImpl || (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) return { error: "Brak fetch w środowisku uruchomieniowym" };

  const url = `${MF_API_URL}/${normalized}?date=${date}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      // MF opisuje odmowy w ciele (np. WL-112 = przekroczony limit zapytań).
      const body = (await res.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;
      if (res.status === 404) {
        const empty: CompanyLookupResult = { found: false, company: null, cached: false };
        cacheSet(key, empty);
        return empty;
      }
      const detail = body?.message ? `: ${body.message}` : "";
      return { error: `Wykaz MF odrzucił zapytanie (HTTP ${res.status})${detail}` };
    }

    const json = (await res.json()) as { result?: { subject?: MfSubject | null } };
    const subject = json.result?.subject ?? null;

    const result: CompanyLookupResult = subject
      ? { found: true, company: toCompany(subject, normalized, date), cached: false }
      : { found: false, company: null, cached: false };

    cacheSet(key, result);
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "Wykaz MF nie odpowiedział w wyznaczonym czasie" };
    }
    return {
      error: `Nie udało się połączyć z wykazem MF: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}
