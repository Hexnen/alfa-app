/**
 * Pogoda dla wydarzeń kalendarza — prognoza Open-Meteo + ostrzeżenia IMGW.
 *
 * Moduł stoi na tych samych zasadach co src/lib/geo.ts, bo dzieli z nim całą warstwę sieci:
 *  - KAŻDE zapytanie idzie najpierw do `geo_cache` (prognoza 60 min, ostrzeżenia 15 min,
 *    reverse-geokodowanie powiatu 90 dni — TTL per klucz przez `geoCacheGet(key, dbx, ttl)`),
 *  - brak sieci / timeout / błąd HTTP NIGDY nie rzuca i nigdy nie kończy się 500 —
 *    wynikiem jest `null` z powodem w `reason` (kalendarz ma działać bez pogody),
 *  - błędów NIE cache'ujemy,
 *  - `GEO_OFFLINE=1` albo `setGeoFetch` (testy) całkowicie wyłączają sieć,
 *  - Nominatim reverse idzie przez tę samą kolejkę 1 req/s i z tym samym User-Agentem
 *    co geokoder; Open-Meteo i IMGW nie mają takiego limitu w ToS, więc omijają kolejkę
 *    (inaczej batch dla widoku miesiąca czekałby sekundę na punkt).
 *
 * Ikona i liczby opisują OKNO wydarzenia, nie dobę: dla wydarzenia z godziną to godziny
 * [start, koniec), dla całodniowego pora pracy w terenie 07–18. Kod zjawiska wybiera
 * `representativeWeather` (opad tylko powyżej progu prawdopodobieństwa, poza opadami kod
 * dominujący) — `daily.weather_code` z Open-Meteo jest najcięższym kodem CAŁEJ doby i sam
 * z siebie kłamie o pogodzie na montażu.
 *
 * Punkt wydarzenia (kolejność): `location` → obiekt → biuro (tylko `biuro`/`przygotowanie`).
 * `urlop` nigdy nie dostaje pogody. Zakres: dzień startu w oknie [dziś-2, dziś+15] —
 * dokładnie tyle, ile zwraca jedno zapytanie Open-Meteo (`past_days=2&forecast_days=16`).
 *
 * Batch NIE robi n zapytań dla n wydarzeń: punkty grupują się po współrzędnych zaokrąglonych
 * do 2 miejsc (~1 km), więc cały dzień w jednym mieście to jedno zapytanie o prognozę.
 * Świeżych geokodowań (miss w cache = sekunda kolejki Nominatim) batch robi najwyżej
 * `MAX_FRESH_GEOCODES`; reszta wraca w `retry` i front dopyta w kolejnej turze.
 *
 * Dopasowanie ostrzeżeń: IMGW podaje wyłącznie listę kodów TERYT powiatów (`teryt: ["1465", …]`),
 * BEZ nazw obszaru — dlatego powiat punktu bierzemy z Nominatim reverse (`zoom=8&extratags=1`)
 * i porównujemy `extratags["teryt:terc"]` obcięte do 4 znaków. Nazwa powiatu jedzie razem z nim
 * tylko do UI (`county`).
 */
import { and, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";
import { localParts } from "./ai/freeSlots.js";
import { shiftLocal } from "./calendar-recurrence.js";
import {
  NOMINATIM_REVERSE_URL,
  geoCacheGet,
  geoCacheSet,
  geoGetJson,
  geocode,
  isGeoError,
  objectPoint,
  officePoint,
  type GeocodeOptions,
} from "./geo.js";

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const IMGW_WARNINGS_URL = "https://danepubliczne.imgw.pl/api/data/warningsmeteo";

/** Ile dni wstecz i w przód obejmuje jedno zapytanie do Open-Meteo (i tym samym okno pogody). */
export const PAST_DAYS = 2;
export const FORECAST_DAYS = 16;

export const WX_TTL_MINUTES = 60;
export const IMGW_TTL_MINUTES = 15;
/** Powiat pod współrzędnymi się nie zmienia — trzymamy go tyle, co zwykły wpis geo. */
export const COUNTY_TTL_MINUTES = 90 * 24 * 60;

/** Ile dni prognozy dziennej wchodzi do `WeatherDetail.daily`. */
export const DETAIL_DAYS = 7;

/** Typy wydarzeń, dla których punktem zastępczym jest biuro. */
const OFFICE_TYPES = new Set(["biuro", "przygotowanie"]);

const DAILY_VARS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max";
const HOURLY_VARS = "temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m";

// ---------------------------------------------------------------------------
// Typy (kontrakt z frontem — kopia w frontend/src/lib/api.ts)
// ---------------------------------------------------------------------------

export interface WeatherWarning {
  /** Nazwa zjawiska, np. „Silny wiatr”. */
  event: string;
  /** Stopień IMGW 1–3. */
  level: 1 | 2 | 3;
  /** Początek obowiązywania, ISO lokalne („YYYY-MM-DDTHH:MM”). */
  from: string;
  to: string;
  /** Treść ostrzeżenia. */
  text: string;
}

export interface WeatherPoint {
  lat: number;
  lng: number;
  /** Skąd wzięliśmy punkt: adres wydarzenia / nazwa obiektu / adres biura. */
  label: string | null;
}

export interface WeatherBrief {
  /** Dzień wydarzenia, YYYY-MM-DD. */
  date: string;
  /** Reprezentatywny kod WMO OKNA wydarzenia (patrz `representativeWeather`). */
  code: number;
  /** Średnia temperatura okna wydarzenia. */
  tempC: number;
  /** Z godziną: min/max okna. Całodniowe: min/max doby. */
  tempMinC: number;
  tempMaxC: number;
  /** Suma opadów w oknie. */
  precipMm: number;
  /** Największe prawdopodobieństwo opadu w oknie. */
  precipProb: number | null;
  /** Największy wiatr w oknie. */
  windKmh: number;
  /** Największy stopień ostrzeżeń IMGW obowiązujących w dniu wydarzenia (0 = brak). */
  warningLevel: 0 | 1 | 2 | 3;
  /** Okno, z którego policzono powyższe („HH:MM”) — tylko dla wydarzeń z godziną. */
  window: { from: string; to: string } | null;
  point: WeatherPoint;
}

export interface WeatherHour {
  /** „YYYY-MM-DDTHH:MM”. */
  time: string;
  tempC: number;
  code: number;
  precipProb: number | null;
  precipMm: number;
  windKmh: number;
}

export interface WeatherDay {
  date: string;
  code: number;
  tempMinC: number;
  tempMaxC: number;
  precipMm: number;
  precipProb: number | null;
  windKmh: number;
}

export interface WeatherDetail extends WeatherBrief {
  /** Godziny dnia wydarzenia (zwykle 24). */
  hourly: WeatherHour[];
  /** Do 7 dni od dnia wydarzenia (albo tyle, ile zwróciło API). */
  daily: WeatherDay[];
  warnings: WeatherWarning[];
  county: string | null;
  links: { windy: string; imgw: string };
  fetchedAt: string;
}

/** Dlaczego nie ma pogody — diagnostyka; endpointy zwracają po prostu `null`. */
export type WeatherReason =
  | "vacation" // urlop — z definicji bez pogody
  | "no_point" // nie da się ustalić współrzędnych
  | "out_of_range" // dzień poza oknem [dziś-2, dziś+15]
  | "offline" // brak sieci / GEO_OFFLINE, a w cache pusto
  | "no_data"; // odpowiedź przyszła, ale bez danych dla tego dnia

/** Wynik wewnętrzny: wartość albo powód jej braku (nigdy wyjątek). */
export type WeatherOutcome<T> = { value: T; reason: null } | { value: null; reason: WeatherReason };

/** Minimum, jakiego moduł potrzebuje od wydarzenia (pasuje i do wiersza DB, i do CalendarEventJson). */
export interface WeatherEventInput {
  id: number;
  type: string;
  location: string | null;
  objectId: number | null;
  startAt: string;
  /** Koniec (EXCLUSIVE) — wyznacza okno, z którego liczymy pogodę. */
  endAt: string | null;
  allDay: boolean;
}

export interface WeatherOptions extends GeocodeOptions {
  /** Podmiana „teraz” w testach. */
  now?: Date;
  /** Nadpisanie budżetu świeżych geokodowań w batchu (`MAX_FRESH_GEOCODES`) — testy. */
  maxFreshGeocodes?: number;
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Klucz punktu prognozy: 2 miejsca po przecinku (~1 km) — i klucz grupowania w batchu. */
export function weatherPointKey(p: { lat: number; lng: number }): string {
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

export function weatherCacheKey(p: { lat: number; lng: number }): string {
  return `wx:${weatherPointKey(p)}`;
}

export function countyCacheKey(p: { lat: number; lng: number }): string {
  return `rev:${weatherPointKey(p)}`;
}

export const WARNINGS_CACHE_KEY = "imgw:warnings";

/** Dzisiejsza data w strefie kalendarza (nie procesu). */
export function today(now = new Date()): string {
  return localParts(now).date;
}

/** Okno, dla którego w ogóle mamy prognozę: [dziś-2, dziś+15]. */
export function weatherWindow(now = new Date()): { from: string; to: string } {
  const d = today(now);
  return {
    from: shiftLocal(d, -PAST_DAYS * 24 * 60, true),
    to: shiftLocal(d, (FORECAST_DAYS - 1) * 24 * 60, true),
  };
}

export function isInWeatherWindow(date: string, now = new Date()): boolean {
  const w = weatherWindow(now);
  return date >= w.from && date <= w.to;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Bezpieczny odczyt i-tej pozycji z tablicy szeregu czasowego Open-Meteo. */
function at(arr: unknown, i: number): number | null {
  return Array.isArray(arr) ? num(arr[i]) : null;
}

// ---------------------------------------------------------------------------
// Punkt wydarzenia
// ---------------------------------------------------------------------------

/**
 * Współrzędne dla wydarzenia: `location` (geokoder, cache) → obiekt → biuro
 * (tylko `biuro`/`przygotowanie`). `urlop` zawsze bez pogody.
 *
 * Etykieta mówi, SKĄD wzięliśmy punkt — bo dla wydarzenia z adresem i obiektem
 * naraz prognoza jest z adresu, a użytkownik musi widzieć, czego dotyczy.
 */
export async function eventWeatherPoint(
  ev: Pick<WeatherEventInput, "type" | "location" | "objectId">,
  opts: WeatherOptions = {}
): Promise<WeatherOutcome<WeatherPoint>> {
  if (ev.type === "urlop") return { value: null, reason: "vacation" };

  const line = (ev.location ?? "").trim();
  if (line) {
    const hit = await geocode(line, opts);
    if (!isGeoError(hit)) return { value: { lat: hit.lat, lng: hit.lng, label: line }, reason: null };
  }

  if (ev.objectId != null) {
    const pt = await objectPoint(ev.objectId, opts);
    if (!isGeoError(pt)) return { value: { lat: pt.lat, lng: pt.lng, label: pt.label }, reason: null };
  }

  if (OFFICE_TYPES.has(ev.type)) {
    const office = await officePoint(opts);
    if (!isGeoError(office)) {
      return { value: { lat: office.lat, lng: office.lng, label: office.label }, reason: null };
    }
  }

  return { value: null, reason: "no_point" };
}

// ---------------------------------------------------------------------------
// Prognoza (Open-Meteo)
// ---------------------------------------------------------------------------

/** Surowa (już odchudzona) odpowiedź Open-Meteo trzymana w cache'u. */
export interface ForecastRaw {
  daily: {
    time: string[];
    weather_code: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    precipitation_sum: (number | null)[];
    precipitation_probability_max: (number | null)[];
    wind_speed_10m_max: (number | null)[];
  };
  hourly: {
    time: string[];
    temperature_2m: (number | null)[];
    weather_code: (number | null)[];
    precipitation_probability: (number | null)[];
    precipitation: (number | null)[];
    wind_speed_10m: (number | null)[];
  };
}

interface CachedForecast {
  fetchedAt: string;
  data: ForecastRaw;
}

function forecastUrl(p: { lat: number; lng: number }): string {
  const params = new URLSearchParams({
    latitude: p.lat.toFixed(4),
    longitude: p.lng.toFixed(4),
    timezone: "Europe/Warsaw",
    daily: DAILY_VARS,
    hourly: HOURLY_VARS,
    forecast_days: String(FORECAST_DAYS),
    past_days: String(PAST_DAYS),
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

/** Wyciąga z odpowiedzi tylko to, czego używamy — i sprawdza, że w ogóle są szeregi czasowe. */
function parseForecast(json: unknown): ForecastRaw | null {
  const body = json as { daily?: Record<string, unknown>; hourly?: Record<string, unknown> } | null;
  const d = body?.daily;
  const h = body?.hourly;
  if (!d || !h || !Array.isArray(d.time) || !Array.isArray(h.time)) return null;
  const col = (src: Record<string, unknown>, name: string): (number | null)[] => {
    const v = src[name];
    return Array.isArray(v) ? v.map((x) => num(x)) : [];
  };
  return {
    daily: {
      time: (d.time as unknown[]).map(String),
      weather_code: col(d, "weather_code"),
      temperature_2m_max: col(d, "temperature_2m_max"),
      temperature_2m_min: col(d, "temperature_2m_min"),
      precipitation_sum: col(d, "precipitation_sum"),
      precipitation_probability_max: col(d, "precipitation_probability_max"),
      wind_speed_10m_max: col(d, "wind_speed_10m_max"),
    },
    hourly: {
      time: (h.time as unknown[]).map(String),
      temperature_2m: col(h, "temperature_2m"),
      weather_code: col(h, "weather_code"),
      precipitation_probability: col(h, "precipitation_probability"),
      precipitation: col(h, "precipitation"),
      wind_speed_10m: col(h, "wind_speed_10m"),
    },
  };
}

/**
 * Prognoza dla punktu — z cache'u (60 min) albo z sieci. Zwraca `null` przy braku sieci
 * i przy odpowiedzi, której nie da się sparsować; błędu nie zapisujemy do cache'u.
 */
export async function fetchForecast(
  point: { lat: number; lng: number },
  opts: WeatherOptions = {}
): Promise<CachedForecast | null> {
  const dbx = opts.dbx ?? db;
  const key = weatherCacheKey(point);
  const hit = geoCacheGet<CachedForecast>(key, dbx, WX_TTL_MINUTES);
  if (hit?.data?.daily?.time?.length) return hit;
  if (opts.cacheOnly) return null;

  const res = await geoGetJson(forecastUrl(point), "Open-Meteo", { throttle: false });
  if (isGeoError(res)) return null;
  const data = parseForecast(res.json);
  if (!data || data.daily.time.length === 0) return null;

  const value: CachedForecast = { fetchedAt: new Date().toISOString(), data };
  geoCacheSet(key, value, dbx);
  return value;
}

// ---------------------------------------------------------------------------
// Ostrzeżenia (IMGW)
// ---------------------------------------------------------------------------

/** Ostrzeżenie w postaci znormalizowanej (tak leży w cache'u). */
export interface StoredWarning extends WeatherWarning {
  /** Kody TERYT powiatów objętych ostrzeżeniem (4 znaki). */
  teryt: string[];
}

/** „2026-09-08 17:00:00” → „2026-09-08T17:00”. Nietypowe formaty przepuszczamy bez zmian. */
function imgwTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}` : s;
}

function warningLevelOf(v: unknown): 1 | 2 | 3 {
  const n = Math.round(Number(v));
  if (n >= 3) return 3;
  if (n === 2) return 2;
  return 1;
}

/**
 * Parser odpowiedzi IMGW. Zweryfikowany na żywym API (2026-09): tablica obiektów
 * `{ id, nazwa_zdarzenia, stopien: "1", obowiazuje_od, obowiazuje_do, tresc, teryt: [...] }`,
 * gdzie `teryt` to kody POWIATÓW (4 cyfry) — nazw obszaru API nie podaje w ogóle.
 * Defensywnie: każde pole może zniknąć, `teryt` bywa pojedynczym stringiem, kody bywają
 * dłuższe (gmina) — obcinamy do 4 znaków. Wpisy bez nazwy i bez dat pomijamy.
 */
export function parseImgwWarnings(json: unknown): StoredWarning[] {
  const rows = Array.isArray(json) ? json : [];
  const out: StoredWarning[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const event = typeof r.nazwa_zdarzenia === "string" ? r.nazwa_zdarzenia.trim() : "";
    const from = imgwTime(r.obowiazuje_od);
    const to = imgwTime(r.obowiazuje_do);
    if (!event || !from || !to) continue;

    const terytRaw = Array.isArray(r.teryt) ? r.teryt : typeof r.teryt === "string" ? [r.teryt] : [];
    const teryt = [
      ...new Set(
        terytRaw
          .map((t) => String(t).replace(/\D/g, ""))
          .filter((t) => t.length >= 4)
          .map((t) => t.slice(0, 4))
      ),
    ];

    out.push({
      event,
      level: warningLevelOf(r.stopien),
      from,
      to,
      text: typeof r.tresc === "string" ? r.tresc.trim() : "",
      teryt,
    });
  }
  return out;
}

/** Ostrzeżenia IMGW dla całego kraju — cache 15 min. `null` = nie udało się pobrać. */
export async function fetchWarnings(opts: WeatherOptions = {}): Promise<StoredWarning[] | null> {
  const dbx = opts.dbx ?? db;
  const hit = geoCacheGet<StoredWarning[]>(WARNINGS_CACHE_KEY, dbx, IMGW_TTL_MINUTES);
  if (Array.isArray(hit)) return hit;
  if (opts.cacheOnly) return null;

  const res = await geoGetJson(IMGW_WARNINGS_URL, "IMGW", { throttle: false });
  if (isGeoError(res)) return null;

  // Pusta lista to poprawny wynik („brak ostrzeżeń w kraju”) i JEST cache'owana —
  // inaczej w spokojny dzień waliliśmy w IMGW przy każdym otwarciu kalendarza.
  const list = parseImgwWarnings(res.json);
  geoCacheSet(WARNINGS_CACHE_KEY, list, dbx);
  return list;
}

/** Ostrzeżenia obowiązujące w danym dniu w danym powiecie (TERYT). */
export function warningsFor(all: StoredWarning[], teryt: string | null, date: string): WeatherWarning[] {
  if (!teryt) return [];
  return all
    .filter((w) => w.teryt.includes(teryt) && w.from.slice(0, 10) <= date && w.to.slice(0, 10) >= date)
    .map(({ event, level, from, to, text }) => ({ event, level, from, to, text }));
}

export function maxWarningLevel(list: WeatherWarning[]): 0 | 1 | 2 | 3 {
  let max: 0 | 1 | 2 | 3 = 0;
  for (const w of list) if (w.level > max) max = w.level;
  return max;
}

// ---------------------------------------------------------------------------
// Powiat (Nominatim reverse)
// ---------------------------------------------------------------------------

export interface CountyInfo {
  /** Nazwa do UI, np. „powiat płoński”. */
  name: string | null;
  /** TERYT powiatu (4 cyfry) — jedyny sposób dopasowania ostrzeżenia IMGW. */
  teryt: string | null;
}

/**
 * Powiat pod współrzędnymi. `zoom=8` daje jednostkę powiatową (miasta na prawach powiatu
 * wracają jako `addresstype: "city"`), `extratags=1` dokłada `teryt:terc` — bez niego
 * dopasowanie do ostrzeżeń IMGW jest niewykonalne, bo IMGW nie podaje nazw obszarów.
 * Idzie przez wspólną kolejkę 1 req/s (ToS Nominatim).
 */
export async function fetchCounty(
  point: { lat: number; lng: number },
  opts: WeatherOptions = {}
): Promise<CountyInfo | null> {
  const dbx = opts.dbx ?? db;
  const key = countyCacheKey(point);
  const hit = geoCacheGet<CountyInfo>(key, dbx, COUNTY_TTL_MINUTES);
  if (hit && typeof hit === "object") return hit;
  if (opts.cacheOnly) return null;

  const params = new URLSearchParams({
    format: "json",
    lat: point.lat.toFixed(5),
    lon: point.lng.toFixed(5),
    zoom: "8",
    addressdetails: "1",
    extratags: "1",
    "accept-language": "pl",
  });
  const res = await geoGetJson(`${NOMINATIM_REVERSE_URL}?${params.toString()}`, "Nominatim reverse");
  if (isGeoError(res)) return null;

  const body = res.json as
    | { name?: unknown; address?: Record<string, unknown>; extratags?: Record<string, unknown> }
    | null;
  if (!body || typeof body !== "object") return null;

  const addr = body.address ?? {};
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = pick(addr.county) ?? pick(addr.city) ?? pick(addr.municipality) ?? pick(body.name);

  const terc = pick(body.extratags?.["teryt:terc"]);
  const digits = terc ? terc.replace(/\D/g, "") : "";
  const teryt = digits.length >= 4 ? digits.slice(0, 4) : null;

  const value: CountyInfo = { name, teryt };
  // Sam brak TERYT (obiekt OSM bez tagu) to poprawny wynik — cache'ujemy, żeby nie
  // dobijać się do Nominatim przy każdym odświeżeniu kalendarza.
  geoCacheSet(key, value, dbx);
  return value;
}

// ---------------------------------------------------------------------------
// Składanie briefu / szczegółów
// ---------------------------------------------------------------------------

// --- Kategorie i ciężar kodów WMO ------------------------------------------

/** Kategoria zjawiska — o niej myśli człowiek patrzący na ikonę („pada czy nie pada”). */
export type WeatherCategory = "clear" | "fog" | "drizzle" | "rain" | "snow" | "thunder";

export function wmoCategory(code: number): WeatherCategory {
  if (code >= 95 && code <= 99) return "thunder";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 45 || code === 48) return "fog";
  return "clear"; // 0–3 i wszystko, czego nie znamy
}

/** Czy kod oznacza opad (i tym samym podlega progowi prawdopodobieństwa). */
export function isPrecipCode(code: number): boolean {
  const c = wmoCategory(code);
  return c === "drizzle" || c === "rain" || c === "snow" || c === "thunder";
}

/**
 * Ciężar kodu: burza > śnieg > deszcz > mżawka > mgła > zachmurzenie > … > bezchmurnie,
 * a w obrębie kategorii rosnąco wg intensywności (dziesiątki = kategoria).
 * Nieznany kod dostaje ciężar zachmurzenia — nigdy nie wygra z realnym zjawiskiem.
 */
const SEVERITY: Record<number, number> = {
  0: 0, 1: 1, 2: 2, 3: 3,
  45: 10, 48: 11,
  51: 20, 56: 21, 53: 22, 57: 23, 55: 24,
  61: 30, 80: 31, 63: 32, 81: 33, 65: 34, 66: 35, 67: 36, 82: 37,
  71: 40, 77: 41, 85: 42, 73: 43, 86: 44, 75: 45,
  95: 50, 96: 51, 99: 52,
};

export const weatherSeverity = (code: number): number => SEVERITY[code] ?? 3;

/** Poniżej tego prawdopodobieństwa opad w prognozie godzinowej nie robi ikony deszczu. */
export const PRECIP_PROB_MIN = 30;

/** Godziny pracy w terenie — okno dla wydarzeń całodniowych. */
export const WORK_HOUR_FROM = 7;
export const WORK_HOUR_TO = 18;

/** Twardy limit długości okna: wielodniowe wydarzenie opisuje pierwsza doba. */
export const MAX_WINDOW_HOURS = 24;

export interface RepresentativeWeather {
  code: number;
  tempC: number;
  tempMinC: number;
  tempMaxC: number;
  precipMm: number;
  precipProb: number | null;
  windKmh: number;
  /** Ile godzin weszło do okna. */
  count: number;
  /** Pierwsza godzina okna i koniec ostatniej („YYYY-MM-DDTHH:MM”). */
  from: string;
  to: string;
}

/**
 * Pogoda reprezentatywna dla OKNA wydarzenia (czysta funkcja — cała logika doboru ikony).
 *
 * Zasady (wyprowadzone z tego, jak ludzie czytają ikonę w kalendarzu):
 *  - opad wygrywa z brakiem opadu, ale tylko jeśli w oknie jest przynajmniej jedna godzina
 *    z prawdopodobieństwem ≥ `minPrecipProb` (brak danych o prawdopodobieństwie = liczy się
 *    zawsze) — inaczej 20-procentowa kropla robiła ikonę deszczu na cały montaż;
 *  - wśród godzin z opadem bierzemy NAJCIĘŻSZY kod (burza > śnieg > deszcz > mżawka),
 *    bo o godzinie burzy trzeba wiedzieć, choćby trwała jedną godzinę;
 *  - bez opadów bierzemy kod DOMINUJĄCY (najczęstszy, remis → cięższy), żeby jedna godzina
 *    zachmurzenia nie robiła „pochmurno” z siedmiu godzin słońca;
 *  - godzina z kodem opadowym poniżej progu głosuje jako zachmurzenie (3) — niebo w takiej
 *    godzinie na pewno nie jest czyste.
 *
 * Wartości liczbowe: temperatura średnia + min/max okna, opady sumarycznie, prawdopodobieństwo
 * i wiatr jako maksimum (najgorszy moment okna).
 */
export function representativeWeather(
  hours: WeatherHour[],
  opts: { minPrecipProb?: number } = {}
): RepresentativeWeather | null {
  if (hours.length === 0) return null;
  const minProb = opts.minPrecipProb ?? PRECIP_PROB_MIN;

  let worst: { code: number; sev: number } | null = null;
  const votes = new Map<number, number>();

  let tempSum = 0;
  let tempMin = Infinity;
  let tempMax = -Infinity;
  let precipMm = 0;
  let precipProb: number | null = null;
  let windKmh = 0;

  for (const h of hours) {
    tempSum += h.tempC;
    if (h.tempC < tempMin) tempMin = h.tempC;
    if (h.tempC > tempMax) tempMax = h.tempC;
    precipMm += h.precipMm;
    if (h.precipProb != null) precipProb = precipProb == null ? h.precipProb : Math.max(precipProb, h.precipProb);
    if (h.windKmh > windKmh) windKmh = h.windKmh;

    const wet = isPrecipCode(h.code) && (h.precipProb == null || h.precipProb >= minProb);
    if (wet) {
      const sev = weatherSeverity(h.code);
      if (!worst || sev > worst.sev) worst = { code: h.code, sev };
    } else {
      const code = isPrecipCode(h.code) ? 3 : h.code;
      votes.set(code, (votes.get(code) ?? 0) + 1);
    }
  }

  let code: number | null = worst?.code ?? null;
  if (code === null) {
    let bestCount = 0;
    for (const [c, n] of votes) {
      const better =
        code === null || n > bestCount || (n === bestCount && weatherSeverity(c) > weatherSeverity(code));
      if (better) {
        code = c;
        bestCount = n;
      }
    }
    code ??= 3; // teoretycznie nieosiągalne (hours niepuste), ale typ musi być liczbą
  }

  const last = hours[hours.length - 1];
  return {
    code,
    tempC: round1(tempSum / hours.length),
    tempMinC: round1(tempMin),
    tempMaxC: round1(tempMax),
    precipMm: round1(precipMm),
    precipProb,
    windKmh: Math.round(windKmh),
    count: hours.length,
    from: hours[0].time,
    to: shiftHour(last.time, 1),
  };
}

// --- Okno wydarzenia --------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const isTimed = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

/** Przesuwa „YYYY-MM-DDTHH:MM” o N godzin (kalendarz cywilny, bez DST). */
function shiftHour(iso: string, hours: number): string {
  try {
    return shiftLocal(iso, hours * 60, false);
  } catch {
    return iso;
  }
}

/** Czy wydarzenie ma realną godzinę (a nie jest całodniowe / bez czasu). */
export function hasClock(ev: Pick<WeatherEventInput, "startAt" | "allDay">): boolean {
  return !ev.allDay && isTimed(ev.startAt);
}

/**
 * Granice okna [from, to) w czasie lokalnym. Z godziną: od pełnej godziny startu do końca
 * wydarzenia (min. 1 h, maks. `MAX_WINDOW_HOURS`). Całodniowe: pora pracy w terenie 07–18,
 * bo `daily.weather_code` Open-Meteo to najcięższy kod CAŁEJ doby i godzina mżawki o 23:00
 * robiła z całego dnia „deszcz”.
 */
export function eventWeatherWindow(
  ev: Pick<WeatherEventInput, "startAt" | "endAt" | "allDay">
): { from: string; to: string } {
  const date = ev.startAt.slice(0, 10);
  if (!hasClock(ev)) {
    return { from: `${date}T${pad2(WORK_HOUR_FROM)}:00`, to: `${date}T${pad2(WORK_HOUR_TO)}:00` };
  }
  const from = `${ev.startAt.slice(0, 13)}:00`;
  const min = shiftHour(from, 1);
  const cap = shiftHour(from, MAX_WINDOW_HOURS);
  const end = ev.endAt && isTimed(ev.endAt) ? ev.endAt.slice(0, 16) : null;
  let to = end && end > from ? end : min;
  if (to < min) to = min;
  if (to > cap) to = cap;
  return { from, to };
}

// --- Szeregi godzinowe ------------------------------------------------------

function hourAt(fc: ForecastRaw, i: number): WeatherHour | null {
  const tempC = at(fc.hourly.temperature_2m, i);
  const code = at(fc.hourly.weather_code, i);
  if (tempC === null || code === null) return null;
  return {
    time: fc.hourly.time[i].slice(0, 16),
    tempC: round1(tempC),
    code,
    precipProb: at(fc.hourly.precipitation_probability, i),
    precipMm: round1(at(fc.hourly.precipitation, i) ?? 0),
    windKmh: Math.round(at(fc.hourly.wind_speed_10m, i) ?? 0),
  };
}

/** Godziny z przedziału [from, to) — porównanie leksykalne na lokalnym ISO. */
function hoursBetween(fc: ForecastRaw, from: string, to: string): WeatherHour[] {
  const out: WeatherHour[] = [];
  for (let i = 0; i < fc.hourly.time.length; i++) {
    const t = fc.hourly.time[i].slice(0, 16);
    if (t < from || t >= to) continue;
    const h = hourAt(fc, i);
    if (h) out.push(h);
  }
  return out;
}

function buildBrief(
  ev: Pick<WeatherEventInput, "startAt" | "endAt" | "allDay">,
  point: WeatherPoint,
  fc: ForecastRaw,
  warnings: WeatherWarning[]
): WeatherBrief | null {
  const date = ev.startAt.slice(0, 10);
  const di = fc.daily.time.indexOf(date);
  if (di < 0) return null;

  const dayMaxC = at(fc.daily.temperature_2m_max, di);
  const dayMinC = at(fc.daily.temperature_2m_min, di);
  const dayCode = at(fc.daily.weather_code, di);
  if (dayMaxC === null || dayMinC === null || dayCode === null) return null;

  // Wydarzenie opisuje pogoda JEGO okna, nie najcięższy kod doby — „deszcz” przy montażu
  // 10–14 dlatego, że pokropi o 23:00, byłby po prostu nieprawdą.
  const win = eventWeatherWindow(ev);
  const rep = representativeWeather(hoursBetween(fc, win.from, win.to));
  const timed = hasClock(ev);

  return {
    date,
    code: rep?.code ?? dayCode,
    tempC: round1(rep?.tempC ?? dayMaxC),
    // Całodniowe zostają przy amplitudzie doby — to jej dotyczy „min–max” na karcie.
    tempMinC: round1(rep && timed ? rep.tempMinC : dayMinC),
    tempMaxC: round1(rep && timed ? rep.tempMaxC : dayMaxC),
    precipMm: rep ? rep.precipMm : round1(at(fc.daily.precipitation_sum, di) ?? 0),
    precipProb: rep ? rep.precipProb : at(fc.daily.precipitation_probability_max, di),
    windKmh: rep ? rep.windKmh : Math.round(at(fc.daily.wind_speed_10m_max, di) ?? 0),
    warningLevel: maxWarningLevel(warnings),
    window: rep && timed ? { from: rep.from.slice(11, 16), to: rep.to.slice(11, 16) } : null,
    point,
  };
}

function buildHourly(fc: ForecastRaw, date: string): WeatherHour[] {
  const out: WeatherHour[] = [];
  for (let i = 0; i < fc.hourly.time.length; i++) {
    if (!fc.hourly.time[i].startsWith(date)) continue;
    const h = hourAt(fc, i);
    if (h) out.push(h);
  }
  return out;
}

function buildDaily(fc: ForecastRaw, date: string, days = DETAIL_DAYS): WeatherDay[] {
  const start = fc.daily.time.indexOf(date);
  if (start < 0) return [];
  const out: WeatherDay[] = [];
  for (let i = start; i < Math.min(start + days, fc.daily.time.length); i++) {
    const code = at(fc.daily.weather_code, i);
    const tempMinC = at(fc.daily.temperature_2m_min, i);
    const tempMaxC = at(fc.daily.temperature_2m_max, i);
    if (code === null || tempMinC === null || tempMaxC === null) continue;
    out.push({
      date: fc.daily.time[i],
      code,
      tempMinC: round1(tempMinC),
      tempMaxC: round1(tempMaxC),
      precipMm: round1(at(fc.daily.precipitation_sum, i) ?? 0),
      precipProb: at(fc.daily.precipitation_probability_max, i),
      windKmh: Math.round(at(fc.daily.wind_speed_10m_max, i) ?? 0),
    });
  }
  return out;
}

export function weatherLinks(p: { lat: number; lng: number }): { windy: string; imgw: string } {
  const lat = p.lat.toFixed(3);
  const lng = p.lng.toFixed(3);
  return {
    windy: `https://www.windy.com/${lat}/${lng}?${lat},${lng},10`,
    imgw: "https://meteo.imgw.pl/dyn/?osmet=true",
  };
}

// ---------------------------------------------------------------------------
// API modułu
// ---------------------------------------------------------------------------

/**
 * Ile ŚWIEŻYCH geokodowań (miss w `geo_cache`, czyli realne wyjście do Nominatim) wolno
 * zrobić w jednym batchu. Kolejka Nominatim to 1 req/s, więc widok miesiąca z 40 nowymi
 * adresami wisiałby 40 sekund w jednym requeście. Trafienia w cache limitu NIE dotyczą —
 * wydarzenia ponad budżet wracają w `retry`, front dopyta w kolejnej turze.
 */
export const MAX_FRESH_GEOCODES = 8;

/** Wynik batcha: mapa briefów + id warte ponowienia (offline / brak danych / limit geokodowań). */
export interface WeatherBatch {
  items: Map<number, WeatherBrief | null>;
  /**
   * Id, dla których `null` NIE jest odpowiedzią ostateczną. `urlop`, dzień poza oknem
   * prognozy i trwały brak punktu tu nie trafiają — te nie mają pogody z definicji.
   */
  retry: number[];
}

/** Czy dla wydarzenia w ogóle jest co geokodować (inaczej brak punktu jest ostateczny). */
function mayGeocode(ev: Pick<WeatherEventInput, "type" | "location" | "objectId">): boolean {
  return Boolean((ev.location ?? "").trim()) || ev.objectId != null || OFFICE_TYPES.has(ev.type);
}

/**
 * Skrót pogodowy dla listy wydarzeń — JEDNO zapytanie o prognozę na punkt (grupowanie po
 * współrzędnych zaokrąglonych do 2 miejsc) i JEDNO o ostrzeżenia IMGW na całą listę.
 * Zwraca mapę id → brief albo `null` plus listę `retry`; nigdy nie rzuca.
 *
 * Punkty ustalamy dwufazowo: najpierw KAŻDE wydarzenie z samego cache'u (zero sieci),
 * a dopiero potem, w ramach budżetu `MAX_FRESH_GEOCODES`, świeże geokodowania. Bez tego
 * jeden batch dla miesiąca stał w kolejce Nominatim po sekundzie na adres.
 */
export async function weatherBriefs(
  events: WeatherEventInput[],
  opts: WeatherOptions = {}
): Promise<WeatherBatch> {
  const now = opts.now ?? new Date();
  const items = new Map<number, WeatherBrief | null>();
  const retry = new Set<number>();

  /** Punkt → wydarzenia (dedup zapytań o prognozę). */
  const groups = new Map<string, { point: WeatherPoint; events: WeatherEventInput[] }>();
  let budget = opts.maxFreshGeocodes ?? MAX_FRESH_GEOCODES;

  for (const ev of events) {
    items.set(ev.id, null);
    if (ev.type === "urlop") continue;
    if (!isInWeatherWindow(ev.startAt.slice(0, 10), now)) continue;

    let pt = await eventWeatherPoint(ev, { ...opts, cacheOnly: true });
    if (!pt.value && !opts.cacheOnly && mayGeocode(ev)) {
      // Miss w cache: albo płacimy sekundę kolejki z budżetu, albo odsyłamy do ponowienia.
      if (budget <= 0) {
        retry.add(ev.id);
        continue;
      }
      budget--;
      pt = await eventWeatherPoint(ev, opts);
    }
    if (!pt.value) continue;

    const key = weatherPointKey(pt.value);
    const g = groups.get(key);
    if (g) g.events.push(ev);
    else groups.set(key, { point: pt.value, events: [ev] });
  }

  if (groups.size === 0) return { items, retry: [...retry] };

  const allWarnings = (await fetchWarnings(opts)) ?? [];

  for (const [, group] of groups) {
    const fc = await fetchForecast(group.point, opts);
    if (!fc) {
      // Brak sieci / niesparsowana odpowiedź — `null` jest tymczasowe, nie ostateczne.
      for (const ev of group.events) retry.add(ev.id);
      continue;
    }
    // Powiat tylko wtedy, gdy są jakiekolwiek ostrzeżenia — inaczej reverse-geokodowanie
    // (kolejka 1 req/s!) kosztowałoby sekundę na punkt w dzień bez ostrzeżeń.
    const county = allWarnings.length > 0 ? await fetchCounty(group.point, opts) : null;

    for (const ev of group.events) {
      const date = ev.startAt.slice(0, 10);
      const warnings = warningsFor(allWarnings, county?.teryt ?? null, date);
      const brief = buildBrief(ev, group.point, fc.data, warnings);
      items.set(ev.id, brief);
      if (!brief) retry.add(ev.id); // prognoza jest, ale bez tego dnia (no_data)
    }
  }

  return { items, retry: [...retry] };
}

/** Pełna prognoza dla jednego wydarzenia (dialog „Szczegółowa prognoza”). */
export async function weatherDetail(
  ev: WeatherEventInput,
  opts: WeatherOptions = {}
): Promise<WeatherOutcome<WeatherDetail>> {
  const now = opts.now ?? new Date();
  if (ev.type === "urlop") return { value: null, reason: "vacation" };

  const date = ev.startAt.slice(0, 10);
  if (!isInWeatherWindow(date, now)) return { value: null, reason: "out_of_range" };

  const pt = await eventWeatherPoint(ev, opts);
  if (!pt.value) return { value: null, reason: pt.reason };

  const fc = await fetchForecast(pt.value, opts);
  if (!fc) return { value: null, reason: "offline" };

  const allWarnings = (await fetchWarnings(opts)) ?? [];
  const county = await fetchCounty(pt.value, opts);
  const warnings = warningsFor(allWarnings, county?.teryt ?? null, date);

  const brief = buildBrief(ev, pt.value, fc.data, warnings);
  if (!brief) return { value: null, reason: "no_data" };

  return {
    value: {
      ...brief,
      hourly: buildHourly(fc.data, date),
      daily: buildDaily(fc.data, date),
      warnings,
      county: county?.name ?? null,
      links: weatherLinks(pt.value),
      fetchedAt: fc.fetchedAt,
    },
    reason: null,
  };
}

/** Wiersze wydarzeń w kształcie, jakiego potrzebuje moduł (bez serializacji całego eventu). */
export function loadWeatherEvents(ids: number[], dbx: DbOrTx = db): WeatherEventInput[] {
  if (ids.length === 0) return [];
  return dbx
    .select({
      id: schema.calendarEvents.id,
      type: schema.calendarEvents.type,
      location: schema.calendarEvents.location,
      objectId: schema.calendarEvents.objectId,
      startAt: schema.calendarEvents.startAt,
      endAt: schema.calendarEvents.endAt,
      allDay: schema.calendarEvents.allDay,
    })
    .from(schema.calendarEvents)
    .where(and(inArray(schema.calendarEvents.id, ids), isNull(schema.calendarEvents.deletedAt)))
    .all();
}
