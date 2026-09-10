/**
 * Geokodowanie (Nominatim) i dystans drogowy (OSRM) — zawsze przez cache `geo_cache`.
 *
 * Zasady, na których stoi cały moduł:
 *  - KAŻDE zapytanie sieciowe idzie najpierw do cache'u (TTL 90 dni); trafienie = zero ruchu,
 *  - brak sieci / timeout / błąd HTTP NIGDY nie rzuca wyjątkiem i nie wiesza requestu —
 *    funkcje zwracają `{ error }`, a wołający decyduje, co z tym zrobić (ostrzeżenie, nie 500),
 *  - błędów NIE cache'ujemy (żeby chwilowy brak sieci nie zatruł wyniku na 90 dni),
 *  - `GEO_OFFLINE=1` (albo `setGeoFetch` w testach) całkowicie wyłącza sieć — testy i CI
 *    działają wyłącznie na wstrzykniętych wpisach cache'u.
 *
 * Nagłówki i limity są takie same, jak w istniejącym froncie (frontend/src/components/LocationPicker.tsx):
 * Nominatim `format=json&accept-language=pl&countrycodes=pl`, plus wymagany przez ToS
 * User-Agent i maks. 1 zapytanie na sekundę (kolejka `throttled`).
 */
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";
import { getCompanyConfig, officeAddressLine, type KmSource } from "./company-config.js";

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

export const GEO_CACHE_TTL_DAYS = 90;
export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
/** Reverse (współrzędne → jednostka administracyjna) — ta sama kolejka i User-Agent. */
export const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
export const OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving";
/** Nearest API — najbliższe punkty SIECI DRÓG dla współrzędnych spoza niej. */
export const OSRM_NEAREST_URL = "https://router.project-osrm.org/nearest/v1/driving";
/** Table API — macierz n×n jednym zapytaniem (planer trasy). */
export const OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving";
/** Twardy limit punktów w jednym `/table` (demo OSRM: `--max-table-size` 100). */
export const MAX_MATRIX_POINTS = 25;
/** Nominatim wymaga identyfikującego User-Agenta (ToS). */
export const GEO_USER_AGENT = "AlfaApp/1.0 (alfa-app; kalkulacja dystansu biuro-obiekt)";
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1000;
/** Mnożnik linii prostej → przybliżenie trasy drogowej. */
export const STRAIGHT_LINE_FACTOR = 1.3;

/**
 * Średnie prędkości do estymacji czasu przejazdu, gdy OSRM nie podał `duration`
 * (fallback na linię prostą albo wpis cache'u sprzed dodania czasu).
 */
export const EST_SPEED_KMH_LOCAL = 35;
export const EST_SPEED_KMH_ROAD = 60;
/** Poniżej tego dystansu liczymy prędkością miejską. */
export const EST_LOCAL_KM = 15;

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lng: number;
  /** Etykieta do UI („Biuro: …”, nazwa obiektu). */
  label: string;
}

export interface GeocodeHit {
  lat: number;
  lng: number;
  display: string;
  /** true = z cache'u (bez ruchu sieciowego). */
  cached: boolean;
}

export interface GeoError {
  error: string;
}

export type GeoOutcome<T> = T | GeoError;

export function isGeoError<T extends object>(v: GeoOutcome<T>): v is GeoError {
  return typeof v === "object" && v !== null && "error" in v;
}

export type DistanceMethod = "route" | "straight";

export interface RouteDistance {
  /** Dystans w jedną stronę, kilometry (1 miejsce po przecinku). */
  km: number;
  /** Czas przejazdu w jedną stronę, pełne minuty. Zawsze liczba — UI nigdy nie zostaje bez wartości. */
  minutes: number;
  method: DistanceMethod;
  /** true = minuty policzone z km (średnia prędkość), a nie wzięte z OSRM `routes[0].duration`. */
  minutesEstimated: boolean;
  cached: boolean;
}

export interface ObjectDistance extends RouteDistance {
  from: GeoPoint;
  to: GeoPoint;
}

// ---------------------------------------------------------------------------
// Cache (geo_cache)
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Klucz cache'u geokodera: `geo:<sha1(znormalizowane zapytanie)>`. */
export function geoCacheKey(query: string): string {
  const norm = query.trim().replace(/\s+/g, " ").toLowerCase();
  return `geo:${createHash("sha1").update(norm).digest("hex")}`;
}

/** Klucz cache'u trasy: `route:<lat,lng>|<lat,lng>` (5 miejsc = ok. 1 m). */
export function routeCacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }): string {
  const p = (v: { lat: number; lng: number }) => `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;
  return `route:${p(from)}|${p(to)}`;
}

/** Domyślne TTL cache'u w minutach (90 dni) — obowiązuje, gdy wołający nie poda własnego. */
export const GEO_CACHE_TTL_MINUTES = GEO_CACHE_TTL_DAYS * 24 * 60;

/**
 * Odczyt z cache'u z respektowaniem TTL. Uszkodzony JSON traktujemy jak brak wpisu.
 *
 * `ttlMinutes` pozwala współdzielić tę samą tabelę danym o zupełnie innej „świeżości”
 * (prognoza pogody starzeje się w godzinę, ostrzeżenia IMGW w kwadrans) — pominięty
 * oznacza dotychczasowe 90 dni, więc istniejące wywołania zachowują się bez zmian.
 */
export function geoCacheGet<T>(
  key: string,
  dbx: DbOrTx = db,
  ttlMinutes: number = GEO_CACHE_TTL_MINUTES
): T | null {
  const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.round(ttlMinutes) : GEO_CACHE_TTL_MINUTES;
  const row = dbx
    .select({ value: schema.geoCache.value })
    .from(schema.geoCache)
    .where(
      and(
        eq(schema.geoCache.key, key),
        sql`${schema.geoCache.createdAt} > datetime('now', ${`-${minutes} minutes`})`
      )
    )
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** Zapis do cache'u (upsert, odświeża created_at → resetuje TTL). */
export function geoCacheSet(key: string, value: unknown, dbx: DbOrTx = db): void {
  dbx
    .insert(schema.geoCache)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: schema.geoCache.key,
      set: { value: JSON.stringify(value), createdAt: sql`(datetime('now'))` },
    })
    .run();
}

/** Usuwa przeterminowane wpisy. Zwraca liczbę skasowanych. */
export function pruneGeoCache(dbx: DbOrTx = db): number {
  const res = dbx
    .delete(schema.geoCache)
    .where(sql`${schema.geoCache.createdAt} <= datetime('now', ${`-${GEO_CACHE_TTL_DAYS} days`})`)
    .run();
  return Number((res as { changes?: number }).changes ?? 0);
}

// ---------------------------------------------------------------------------
// Sieć — wstrzykiwalna i throttlowana
// ---------------------------------------------------------------------------

type FetchLike = typeof fetch;
const realFetch: FetchLike = (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(input, init);
let fetchImpl: FetchLike = realFetch;

/** Podmiana implementacji fetch (testy: mock „brak sieci”). `null` przywraca globalny fetch. */
export function setGeoFetch(f: FetchLike | null): void {
  fetchImpl = f ?? realFetch;
}

/** Czy wolno w ogóle ruszać sieć (GEO_OFFLINE=1 = tryb w pełni offline: tylko cache). */
export function geoNetworkEnabled(): boolean {
  return process.env.GEO_OFFLINE !== "1";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

/** Kolejkuje wywołania sieciowe z odstępem ≥ 1 s (limit Nominatim). */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * GET z timeoutem; każdy błąd (sieć, timeout, HTTP, JSON) wraca jako `{ error }`.
 *
 * `throttle: false` omija kolejkę 1 req/s — TYLKO dla API bez takiego limitu w ToS
 * (Open-Meteo, IMGW). Wszystko, co idzie do Nominatim albo OSRM, musi zostać w kolejce.
 * Wstrzyknięty `setGeoFetch` i `GEO_OFFLINE=1` obowiązują w obu trybach, więc testy
 * i tryb offline działają tak samo dla pogody jak dla geokodera.
 */
export async function geoGetJson(
  url: string,
  what: string,
  opts: { throttle?: boolean } = {}
): Promise<GeoOutcome<{ json: unknown }>> {
  if (!geoNetworkEnabled()) {
    return { error: `${what}: tryb offline (GEO_OFFLINE=1) — brak wpisu w cache` };
  }
  const call = () =>
    fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": GEO_USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    const res = opts.throttle === false ? await call() : await throttled(call);
    if (!res.ok) return { error: `${what}: odpowiedź ${res.status}` };
    return { json: (await res.json()) as unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|abort/i.test(msg);
    // undici opakowuje prawdziwą przyczynę (ENOTFOUND, ECONNREFUSED, certyfikat…) w `cause`
    // pod ogólnym „fetch failed” — bez niej log z produkcji nic nie mówi.
    const cause = describeFetchCause(err);
    console.warn(`[geo] ${what} ${url.split("?")[0]}: ${msg}${cause ? ` (${cause})` : ""}`);
    if (timedOut) return { error: `${what}: brak odpowiedzi w ${TIMEOUT_MS / 1000} s` };
    return { error: `${what}: brak połączenia${cause ? ` (${cause})` : ""}` };
  }
}

/** Kod/komunikat z `err.cause` (np. `ENOTFOUND nominatim.openstreetmap.org`), gdy jest. */
function describeFetchCause(err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return "";
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    if (!code) return cause.message;
    return cause.message.includes(code) ? cause.message : `${code}: ${cause.message}`;
  }
  return String(cause);
}

const getJson = geoGetJson;

// ---------------------------------------------------------------------------
// Geokodowanie
// ---------------------------------------------------------------------------

interface NominatimRow {
  lat?: string;
  lon?: string;
  display_name?: string;
}

export interface GeocodeOptions {
  dbx?: DbOrTx;
  /** true = tylko cache, nigdy sieć (np. hak po podpisaniu protokołu w trybie „nie czekaj”). */
  cacheOnly?: boolean;
}

/** Skróty typu ulicy, które Nominatim traktuje jak część nazwy i przez to nic nie znajduje. */
const STREET_PREFIX_RE = /(^|[\s,])(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|os\.|osiedle)\s+/gi;
const POSTCODE_RE = /\b\d{2}-\d{3}\b/g;

/**
 * Kolejne warianty zapytania do Nominatim (od najwierniejszego): oryginał → bez skrótu
 * typu ulicy → dodatkowo bez kodu pocztowego. Bez duplikatów i pustych wpisów.
 */
export function geocodeQueryVariants(query: string): string[] {
  const tidy = (v: string) => v.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/^,\s*|,\s*$/g, "").trim();
  const base = tidy(query);
  const noPrefix = tidy(base.replace(STREET_PREFIX_RE, "$1"));
  const noPostcode = tidy(noPrefix.replace(POSTCODE_RE, ""));
  const out: string[] = [];
  for (const v of [base, noPrefix, noPostcode]) if (v && !out.includes(v)) out.push(v);
  return out;
}

/**
 * Adres → współrzędne (Nominatim, PL). Zwraca `{ error }`, gdy brak wyniku albo brak sieci —
 * nigdy nie rzuca. Trafienie w cache jest darmowe i działa bez internetu.
 */
export async function geocode(query: string, opts: GeocodeOptions = {}): Promise<GeoOutcome<GeocodeHit>> {
  const dbx = opts.dbx ?? db;
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) return { error: "Puste zapytanie do geokodera" };

  const key = geoCacheKey(q);
  const hit = geoCacheGet<{ lat: number; lng: number; display: string }>(key, dbx);
  if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
    return { lat: hit.lat, lng: hit.lng, display: hit.display ?? q, cached: true };
  }
  if (opts.cacheOnly) return { error: `Brak współrzędnych dla „${q}” w cache` };

  // Nominatim nie radzi sobie z polskimi skrótami typu ulicy („ul. Koniczynowa 2A” → pusto,
  // „Koniczynowa 2A” → trafienie), więc po pudle próbujemy kolejnych, prostszych wariantów.
  let first: NominatimRow | undefined;
  let lat = NaN;
  let lng = NaN;
  for (const variant of geocodeQueryVariants(q)) {
    const url =
      `${NOMINATIM_SEARCH_URL}?format=json&limit=1&accept-language=pl&countrycodes=pl&q=` +
      encodeURIComponent(variant);
    const res = await getJson(url, "Geokoder");
    if (isGeoError(res)) return res;
    const rows = Array.isArray(res.json) ? (res.json as NominatimRow[]) : [];
    const row = rows[0];
    const rlat = row ? Number(row.lat) : NaN;
    const rlng = row ? Number(row.lon) : NaN;
    if (row && Number.isFinite(rlat) && Number.isFinite(rlng)) {
      first = row;
      lat = rlat;
      lng = rlng;
      break;
    }
  }
  if (!first) return { error: `Nie znaleziono adresu „${q}”` };

  const value = { lat: round6(lat), lng: round6(lng), display: first.display_name || q };
  geoCacheSet(key, value, dbx);
  return { ...value, cached: false };
}

// ---------------------------------------------------------------------------
// Geokodowanie odwrotne (współrzędne → adres)
// ---------------------------------------------------------------------------

/** Klucz cache'u adresu spod pinezki: `rev:<lat,lng>` (5 miejsc = ok. 1 m). */
export function reverseCacheKey(point: { lat: number; lng: number }): string {
  return `rev:${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

/**
 * Współrzędne → krótka linia adresu („ul. Prosta 51, Warszawa”).
 *
 * Po co: link do Map w postaci samych współrzędnych (`/maps/search/52.29,+21.06`
 * — tak wygląda pinezka udostępniona z telefonu) nie niesie ŻADNEJ nazwy, więc
 * karta z mini-mapą miałaby tylko liczby. Reverse daje jej podpis.
 *
 * Jak reszta modułu: przez cache `geo_cache`, przez wspólną kolejkę 1 req/s
 * (ToS Nominatim) i BEZ rzucania — brak sieci albo pusty wynik to `null`.
 */
export async function reverseAddress(
  point: { lat: number; lng: number },
  opts: GeocodeOptions = {}
): Promise<string | null> {
  const dbx = opts.dbx ?? db;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;

  const key = reverseCacheKey(point);
  const hit = geoCacheGet<{ display: string | null }>(key, dbx);
  // `{ display: null }` w cache'u to zapamiętane „tam nic nie ma" — też trafienie.
  if (hit && typeof hit === "object" && "display" in hit) return hit.display ?? null;
  if (opts.cacheOnly) return null;

  const params = new URLSearchParams({
    format: "json",
    lat: point.lat.toFixed(6),
    lon: point.lng.toFixed(6),
    zoom: "18",
    addressdetails: "1",
    "accept-language": "pl",
  });
  const res = await getJson(`${NOMINATIM_REVERSE_URL}?${params.toString()}`, "Geokoder (reverse)");
  if (isGeoError(res)) return null; // błędów nie cache'ujemy (zasada modułu)

  const body = res.json as { display_name?: unknown; address?: Record<string, unknown> } | null;
  const addr = (body?.address ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const road = pick(addr.road) ?? pick(addr.pedestrian) ?? pick(addr.footway) ?? pick(addr.path);
  const house = pick(addr.house_number);
  const city =
    pick(addr.city) ?? pick(addr.town) ?? pick(addr.village) ?? pick(addr.municipality) ?? pick(addr.county);
  const street = road ? (house ? `${road} ${house}` : road) : null;

  const display =
    [street, city].filter(Boolean).join(", ") ||
    // Bez ulicy i miasta (las, pole) zostaje początek pełnej nazwy z Nominatim.
    (typeof body?.display_name === "string"
      ? body.display_name.split(",").map((p) => p.trim()).filter(Boolean).slice(0, 2).join(", ")
      : "") ||
    null;

  geoCacheSet(key, { display }, dbx);
  return display;
}

// ---------------------------------------------------------------------------
// Dystans
// ---------------------------------------------------------------------------

const R_EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Odległość po wielkim kole (km). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Dystans → przewidywany czas jazdy (pełne minuty, minimum 1). Jedyne miejsce z estymacją:
 * krótkie trasy liczymy prędkością miejską, dłuższe drogową.
 */
export function estimateMinutes(km: number): number {
  const speed = km < EST_LOCAL_KM ? EST_SPEED_KMH_LOCAL : EST_SPEED_KMH_ROAD;
  return Math.max(1, Math.round((km / speed) * 60));
}

/** Przybliżenie trasy drogowej linią prostą × 1,3 (używane jako fallback i tryb „straight”). */
export function straightLineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return round1(haversineKm(a, b) * STRAIGHT_LINE_FACTOR);
}

export interface RouteOptions extends GeocodeOptions {
  /** false = pomiń OSRM i policz od razu linią prostą. */
  useRouting?: boolean;
}

/**
 * Dystans drogowy między punktami (OSRM). Gdy OSRM jest niedostępny — fallback na
 * linię prostą ×1,3 z `method: "straight"`. Nigdy nie zwraca błędu: mając współrzędne,
 * zawsze da się podać przybliżenie (to jest ta „czytelna degradacja” zamiast 500).
 */
export async function routeDistanceKm(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  opts: RouteOptions = {}
): Promise<RouteDistance> {
  const dbx = opts.dbx ?? db;
  const straightKm = straightLineKm(from, to);
  const straight = {
    km: straightKm,
    minutes: estimateMinutes(straightKm),
    method: "straight" as const,
    minutesEstimated: true,
    cached: false,
  };
  if (opts.useRouting === false) return straight;

  const key = routeCacheKey(from, to);
  // `minutes` jest opcjonalne: wpisy sprzed dodania czasu przejazdu mają samo { km, method }.
  // Dopełniamy je estymacją, zamiast traktować jak brak trafienia — miss w trybie cacheOnly
  // cofnąłby km z trasy OSRM na linię prostą, a z tych km liczą się kwoty w realizacjach.
  const hit = geoCacheGet<{ km: number; minutes?: number; method: DistanceMethod }>(key, dbx);
  if (hit && Number.isFinite(hit.km)) {
    const method = hit.method === "straight" ? "straight" : "route";
    const fromOsrm = method === "route" && typeof hit.minutes === "number" && Number.isFinite(hit.minutes);
    return {
      km: hit.km,
      minutes: fromOsrm ? Math.max(1, Math.round(hit.minutes as number)) : estimateMinutes(hit.km),
      method,
      minutesEstimated: !fromOsrm,
      cached: true,
    };
  }
  if (opts.cacheOnly) return straight;

  const url = `${OSRM_ROUTE_URL}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const res = await getJson(url, "OSRM");
  if (isGeoError(res)) return straight;

  const body = res.json as { code?: string; routes?: { distance?: number; duration?: number }[] } | null;
  const meters = body?.routes?.[0]?.distance;
  const seconds = body?.routes?.[0]?.duration;
  if (body?.code !== "Ok" || typeof meters !== "number" || !Number.isFinite(meters)) return straight;

  const km = round1(meters / 1000);
  const fromOsrm = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
  const minutes = fromOsrm ? Math.max(1, Math.round((seconds as number) / 60)) : estimateMinutes(km);
  // Do cache'u trafia tylko czas z OSRM — estymacja jest funkcją km, więc jej zapis nic nie daje,
  // a zacierałby informację o pochodzeniu wartości.
  geoCacheSet(key, fromOsrm ? { km, minutes, method: "route" } : { km, method: "route" }, dbx);
  return { km, minutes, method: "route", minutesEstimated: !fromOsrm, cached: false };
}

// ---------------------------------------------------------------------------
// Przyklejanie punktu do drogi (OSRM Nearest) — trasy do pinezek spoza dróg
// ---------------------------------------------------------------------------
//
// PROBLEM, KTÓRY TO ROZWIĄZUJE. Pinezka z Map Google bywa postawiona w lesie,
// na środku osiedla albo na trawniku. OSRM przykleja taki punkt do NAJBLIŻSZEGO
// odcinka sieci drogowej — a najbliższy nie znaczy sensowny: dwie pinezki
// oddalone o 150 m w Lesie Bródnowskim dawały „2,3 km" i „6,3 km" od biura, bo
// druga przykleiła się do bezimiennej leśnej ścieżki, do której samochód musi
// nadrabiać naokoło.
//
// Dlatego pytamy `nearest` o kilku kandydatów, odrzucamy drogi BEZ NAZWY (ścieżki,
// dukty, wewnętrzne dojazdy), gdy jest jakakolwiek nazwana, i sprawdzamy wynik
// zdrowym rozsądkiem: trasa dłuższa niż 3× linia prosta + 1 km to prawie na pewno
// objazd wymuszony złym przyklejeniem — wtedy próbujemy kolejnego kandydata,
// a na końcu wracamy do uczciwego przybliżenia linią prostą.

/** Kandydat z `nearest`: punkt na drodze, jej nazwa i odległość pinezki od niej (metry). */
export interface RoadCandidate {
  lat: number;
  lng: number;
  name: string;
  /** Metry od pinezki do drogi (z OSRM). */
  distance: number;
}

/** Klucz cache'u kandydatów: `near:<lat,lng>` (5 miejsc = ok. 1 m). */
export function nearestCacheKey(point: { lat: number; lng: number }): string {
  return `near:${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

/**
 * Ilu kandydatów pytamy. Pięciu NIE WYSTARCZA: dla pinezki w Lesie Bródnowskim
 * pierwszych pięć trafień to same bezimienne ścieżki (274–289 m) i dopiero
 * dziesiąte jest ulicą (Kondratowicza, 314 m) — czyli dokładnie ten przypadek,
 * przez który dwie sąsiednie pinezki dawały 2,3 km i 6,3 km od biura.
 */
const NEAREST_COUNT = 10;
/**
 * Jak daleko wolno „iść" po nazwaną drogę. Bez tego limitu pinezka na wsi
 * przykleiłaby się do drogi wojewódzkiej o pięć kilometrów dalej tylko dlatego,
 * że ma nazwę.
 */
const NAMED_MAX_DISTANCE_M = 1500;
const MAX_SNAP_ATTEMPTS = 3;
/** Trasa dłuższa niż `straight × 3 + 1 km` = podejrzenie objazdu przez złe przyklejenie. */
const SUSPICIOUS_FACTOR = 3;
const SUSPICIOUS_MARGIN_KM = 1;
/** Od tylu kilometrów od drogi mówimy o tym użytkownikowi („kawałek pieszo"). */
export const SNAP_VISIBLE_KM = 0.1;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Najbliższe punkty sieci drogowej dla pinezki — posortowane rosnąco po
 * odległości, z odfiltrowanymi bezimiennymi drogami (o ile została choć jedna
 * nazwana). Pusta tablica = `nearest` nie odpowiedział; wołający ma wtedy
 * trasować surowy punkt, czyli zachować się jak przed tą zmianą.
 */
export async function nearestRoadCandidates(
  point: { lat: number; lng: number },
  opts: GeocodeOptions = {}
): Promise<RoadCandidate[]> {
  const dbx = opts.dbx ?? db;
  const key = nearestCacheKey(point);
  const hit = geoCacheGet<RoadCandidate[]>(key, dbx);
  if (Array.isArray(hit)) return hit;
  if (opts.cacheOnly) return [];

  const url = `${OSRM_NEAREST_URL}/${point.lng},${point.lat}?number=${NEAREST_COUNT}`;
  const res = await getJson(url, "OSRM nearest");
  if (isGeoError(res)) return [];

  const body = res.json as
    | { code?: string; waypoints?: { location?: [number, number]; name?: string; distance?: number }[] }
    | null;
  if (body?.code !== "Ok" || !Array.isArray(body.waypoints)) return [];

  const all: RoadCandidate[] = [];
  for (const w of body.waypoints) {
    const loc = w.location;
    if (!Array.isArray(loc) || loc.length < 2) continue;
    const lng = Number(loc[0]);
    const lat = Number(loc[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const distance = Number(w.distance);
    all.push({
      lat: round6(lat),
      lng: round6(lng),
      name: typeof w.name === "string" ? w.name : "",
      distance: Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY,
    });
  }

  // Bezimienne odcinki (leśne ścieżki, dojazdy wewnętrzne) tylko wtedy, gdy w
  // rozsądnym zasięgu nie ma NIC nazwanego — to one produkowały absurdalne objazdy.
  const named = all.filter((c) => c.name.trim() !== "" && c.distance <= NAMED_MAX_DISTANCE_M);
  const chosen = (named.length > 0 ? named : all).sort((a, b) => a.distance - b.distance);

  geoCacheSet(key, chosen, dbx);
  return chosen;
}

export interface SnappedDistance extends RouteDistance {
  /**
   * Ile kilometrów dzieli pinezkę od drogi, do której doliczyliśmy trasę
   * (2 miejsca). 0 = trasowaliśmy surowy punkt albo różnica jest pomijalna.
   */
  snapKm: number;
}

/**
 * Trasa do pinezki, która NIE MUSI leżeć na drodze — z przyklejeniem do sensownej
 * drogi i kontrolą zdrowego rozsądku (patrz komentarz nad `nearestRoadCandidates`).
 *
 * Świadomie osobna od `routeDistanceKm`: ta druga liczy dojazdy do obiektów
 * z kartoteki (`/company/travel`, realizacje, planer trasy), gdzie współrzędne
 * pochodzą z geokodera adresu i leżą przy drodze — zmiana tamtego zachowania
 * ruszyłaby kilometry, z których liczą się pieniądze. Cache tras jest wspólny.
 */
export async function routeDistanceSnapped(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  opts: RouteOptions = {}
): Promise<SnappedDistance> {
  const straightKm = straightLineKm(from, to);
  const straight: SnappedDistance = {
    km: straightKm,
    minutes: estimateMinutes(straightKm),
    method: "straight",
    minutesEstimated: true,
    cached: false,
    snapKm: 0,
  };
  if (opts.useRouting === false) return straight;

  const candidates = await nearestRoadCandidates(to, opts);
  if (candidates.length === 0) {
    // `nearest` padł — zachowujemy się dokładnie jak dotąd.
    return { ...(await routeDistanceKm(from, to, opts)), snapKm: 0 };
  }

  const limit = Math.max(straightKm * SUSPICIOUS_FACTOR + SUSPICIOUS_MARGIN_KM, SUSPICIOUS_MARGIN_KM);
  for (const candidate of candidates.slice(0, MAX_SNAP_ATTEMPTS)) {
    const route = await routeDistanceKm(from, candidate, opts);
    // OSRM niedostępny (fallback na linię prostą) — kolejne próby nic nie dadzą.
    if (route.method !== "route") return straight;
    if (route.km <= limit) {
      return { ...route, snapKm: round2(haversineKm(to, candidate)) };
    }
  }

  // Każdy kandydat dawał absurdalny objazd — uczciwsza jest linia prosta ×1,3
  // (front pokaże ją z tyldą) niż kilometry przez pół miasta.
  return straight;
}

// ---------------------------------------------------------------------------
// Macierz odległości (OSRM Table)
// ---------------------------------------------------------------------------

export interface RouteMatrixOptions extends GeocodeOptions {
  /** false = pomiń OSRM i wypełnij całą macierz linią prostą. */
  useRouting?: boolean;
}

export interface RouteMatrixResult {
  /** km[i][j] — z punktu i do j (macierz jest ASYMETRYCZNA). Przekątna = 0. */
  km: number[][];
  minutes: number[][];
  method: DistanceMethod[][];
  /** Liczba par, które zostały przybliżone linią prostą. */
  missing: number;
  /** true = w tym wywołaniu coś przyszło z sieci. */
  fetched: boolean;
  /** true = komplet z cache'u, zero ruchu sieciowego. */
  cached: boolean;
}

/** Odczyt pary z cache'u — ta sama logika co w `routeDistanceKm` (stare wpisy bez `minutes`). */
function cachedPair(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  dbx: DbOrTx
): { km: number; minutes: number; method: DistanceMethod } | null {
  const hit = geoCacheGet<{ km: number; minutes?: number; method: DistanceMethod }>(
    routeCacheKey(from, to),
    dbx
  );
  if (!hit || !Number.isFinite(hit.km)) return null;
  const method = hit.method === "straight" ? "straight" : "route";
  const fromOsrm = method === "route" && typeof hit.minutes === "number" && Number.isFinite(hit.minutes);
  return {
    km: hit.km,
    minutes: fromOsrm ? Math.max(1, Math.round(hit.minutes as number)) : estimateMinutes(hit.km),
    method,
  };
}

/**
 * Macierz odległości i czasów między punktami — JEDNO zapytanie OSRM Table zamiast n² zapytań
 * `routeDistanceKm`. To nie jest optymalizacja dla wygody: `routeDistanceKm` idzie przez
 * `throttled()` (1 req/s, kolejka wspólna z Nominatim), więc 12 punktów = 132 pary = ponad
 * 2 minuty zajętej kolejki dla jednego widoku.
 *
 * Cache jest per para i idzie przez `routeCacheKey`, więc pary są WSPÓLNE z `routeDistanceKm`:
 * dojazd biuro→obiekt policzony wcześniej przez /company/travel jest tutaj darmowy i odwrotnie.
 *
 * Nigdy nie rzuca — pary bez wyniku wracają jako linia prosta ×1,3, dokładnie jak w
 * `routeDistanceKm`. Błędów nie cache'ujemy (zasada modułu).
 */
export async function routeMatrix(
  points: { lat: number; lng: number }[],
  opts: RouteMatrixOptions = {}
): Promise<RouteMatrixResult> {
  const dbx = opts.dbx ?? db;
  const n = points.length;

  const km: number[][] = [];
  const minutes: number[][] = [];
  const method: DistanceMethod[][] = [];
  for (let i = 0; i < n; i++) {
    km.push(new Array<number>(n).fill(0));
    minutes.push(new Array<number>(n).fill(0));
    method.push(new Array<DistanceMethod>(n).fill("route"));
  }

  /** Pary, które wciąż czekają na trasę (indeksy). */
  const gaps: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const hit = cachedPair(points[i], points[j], dbx);
      if (hit) {
        km[i][j] = hit.km;
        minutes[i][j] = hit.minutes;
        method[i][j] = hit.method;
        continue;
      }
      const straightKm = straightLineKm(points[i], points[j]);
      km[i][j] = straightKm;
      minutes[i][j] = estimateMinutes(straightKm);
      method[i][j] = "straight";
      gaps.push([i, j]);
    }
  }

  const done = (missing: number, fetched: boolean): RouteMatrixResult => ({
    km,
    minutes,
    method,
    missing,
    fetched,
    cached: !fetched && missing === 0,
  });

  if (gaps.length === 0) return done(0, false);
  if (opts.cacheOnly || opts.useRouting === false || !geoNetworkEnabled()) return done(gaps.length, false);
  // Bezpiecznik — wołający powinien obciąć wcześniej (demo OSRM: --max-table-size 100).
  if (n > MAX_MATRIX_POINTS) return done(gaps.length, false);

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const res = await getJson(`${OSRM_TABLE_URL}/${coords}?annotations=duration,distance`, "OSRM");
  if (isGeoError(res)) return done(gaps.length, false);

  const body = res.json as
    | { code?: string; distances?: (number | null)[][]; durations?: (number | null)[][] }
    | null;
  const dist = body?.distances;
  const dur = body?.durations;
  if (body?.code !== "Ok" || !Array.isArray(dist) || !Array.isArray(dur)) return done(gaps.length, false);

  // Pytamy o cały kwadrat (OSRM nie przyjmuje podzbioru par) — i dobrze, bo do cache'u
  // trafiają wtedy także pary, o które nikt jeszcze nie pytał.
  const writes: { key: string; value: { km: number; minutes?: number; method: "route" } }[] = [];
  let filled = 0;
  for (const [i, j] of gaps) {
    const meters = dist[i]?.[j];
    const seconds = dur[i]?.[j];
    // `null` = punkt nieosiągalny; ta para zostaje linią prostą.
    if (typeof meters !== "number" || !Number.isFinite(meters)) continue;

    const pairKm = round1(meters / 1000);
    const fromOsrm = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
    km[i][j] = pairKm;
    minutes[i][j] = fromOsrm ? Math.max(1, Math.round((seconds as number) / 60)) : estimateMinutes(pairKm);
    method[i][j] = "route";
    filled++;
    writes.push({
      key: routeCacheKey(points[i], points[j]),
      value: fromOsrm
        ? { km: pairKm, minutes: minutes[i][j], method: "route" }
        : { km: pairKm, method: "route" },
    });
  }

  if (writes.length > 0) {
    // Jedna transakcja zamiast n² osobnych fsyncy (15 punktów = 210 wpisów).
    // Gdy `dbx` jest już transakcją, zagnieżdżenie by się wysypało — piszemy wprost.
    if (dbx === db) {
      db.transaction((tx) => {
        for (const w of writes) geoCacheSet(w.key, w.value, tx);
      });
    } else {
      for (const w of writes) geoCacheSet(w.key, w.value, dbx);
    }
  }

  return done(gaps.length - filled, filled > 0);
}

// ---------------------------------------------------------------------------
// Biuro → obiekt
// ---------------------------------------------------------------------------

/** Punkt startowy: współrzędne z ustawień, a gdy ich nie ma — geokodowanie adresu biura. */
export async function officePoint(opts: GeocodeOptions = {}): Promise<GeoOutcome<GeoPoint>> {
  const { values } = getCompanyConfig();
  const line = officeAddressLine(values);
  if (values.officeLat !== null && values.officeLng !== null) {
    return { lat: values.officeLat, lng: values.officeLng, label: line || "Biuro" };
  }
  if (!line) {
    return { error: "Brak adresu biura — uzupełnij w Administracja → Firma" };
  }
  const hit = await geocode(line, opts);
  if (isGeoError(hit)) return hit;
  return { lat: hit.lat, lng: hit.lng, label: line };
}

/**
 * Punkt obiektu: kolumny `objects.latitude/longitude`, a gdy puste — leniwe geokodowanie
 * `address + city` z zapisem wyniku do obiektu (kolejne kalkulacje są już darmowe).
 */
export async function objectPoint(objectId: number, opts: GeocodeOptions = {}): Promise<GeoOutcome<GeoPoint>> {
  const dbx = opts.dbx ?? db;
  const row = dbx
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      latitude: schema.objects.latitude,
      longitude: schema.objects.longitude,
    })
    .from(schema.objects)
    .where(eq(schema.objects.id, objectId))
    .get();
  if (!row) return { error: "Nie znaleziono obiektu" };

  if (row.latitude !== null && row.longitude !== null) {
    return { lat: row.latitude, lng: row.longitude, label: row.name };
  }

  const line = [(row.address ?? "").trim(), (row.city ?? "").trim()].filter(Boolean).join(", ");
  if (!line) return { error: "Brak adresu obiektu" };

  const hit = await geocode(line, opts);
  if (isGeoError(hit)) return hit;

  // Leniwe uzupełnienie — tylko gdy nadal puste (bez nadpisywania ręcznej korekty).
  dbx
    .update(schema.objects)
    .set({ latitude: hit.lat, longitude: hit.lng, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.objects.id, objectId),
        sql`${schema.objects.latitude} IS NULL`,
        sql`${schema.objects.longitude} IS NULL`
      )
    )
    .run();

  return { lat: hit.lat, lng: hit.lng, label: row.name };
}

export interface DistanceOptions extends GeocodeOptions {
  /** Nadpisanie `company.km_source` (panel admina „Testuj kalkulację”). */
  source?: KmSource;
}

/**
 * Dystans biuro → obiekt (w JEDNĄ stronę — mnożnik „obie strony” nakłada dopiero automat
 * realizacji, żeby to samo `km` dało się pokazać w panelu bez podwajania).
 * Brak adresu/współrzędnych albo tryb ręczny → `{ error }`.
 */
export async function distanceForObject(
  objectId: number,
  opts: DistanceOptions = {}
): Promise<GeoOutcome<ObjectDistance>> {
  const source = opts.source ?? getCompanyConfig().values.kmSource;
  if (source === "manual") {
    return { error: "Kalkulacja km wyłączona (Administracja → Firma: źródło dystansu „ręcznie”)" };
  }

  const from = await officePoint(opts);
  if (isGeoError(from)) return from;
  const to = await objectPoint(objectId, opts);
  if (isGeoError(to)) return to;

  const dist = await routeDistanceKm(from, to, { ...opts, useRouting: source === "route" });
  return { ...dist, from, to };
}
