/**
 * Linki do Google Maps — allowlista hostów i walidacja pola `objects.maps_url`.
 *
 * Dwie drogi, jedna reguła:
 *   • `GET /api/public/resolve-location` (src/routes/public.ts) WYCHODZI z tym
 *     adresem do sieci, żeby rozwinąć krótki link — allowlista jest tam zaporą
 *     przed SSRF (bez niej `redirect: "follow"` prowadził serwer, gdzie chciał);
 *   • `objects.maps_url` trafia do KLIKALNEGO linku w karcie obiektu — bez
 *     allowlisty kartoteka byłaby przekierowaniem z zaufanego UI dokądkolwiek.
 *
 * Dlatego lista jest DOKŁADNA (host równy albo poddomena): wcześniejszy wzorzec
 * `google\.[a-z.]+` przepuszczał `google.evil.com`.
 */
import { parseString, STR, ValidationError } from "./validate.js";

/**
 * Skąd biorą się linki: użytkownik wkleja z aplikacji Google Maps —
 * `maps.app.goo.gl/…`, `goo.gl/maps/…`, `g.co/kgs/…` — które przekierowują na
 * `www.google.com/maps/…` albo `www.google.pl/maps/…`
 * (patrz frontend/src/components/LocationPicker.tsx).
 */
export const ALLOWED_HOST_SUFFIXES = ["google.com", "google.pl", "goo.gl", "g.co"] as const;

export function isAllowedMapsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Adres z allowlisty, http(s), bez loginu/hasła w URL-u. `null` = odrzucony. */
export function parseAllowedMapsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!isAllowedMapsHost(u.hostname)) return null;
  return u;
}

/**
 * Link Google Maps z formularza obiektu.
 *
 * `undefined` = pola nie było w body (PUT: bez zmian), `null` = wyczyszczone
 * (pusty string też), string = przeszedł allowlistę. Wszystko inne → 400 po
 * polsku, bo to pole użytkownika, a nie parametr wewnętrzny.
 */
export function parseMapsUrlInput(raw: unknown, label = "Link Google Maps"): string | null | undefined {
  const s = parseString(raw, { label, max: STR.URL });
  if (s === undefined || s === null) return s;
  if (!parseAllowedMapsUrl(s)) {
    throw new ValidationError(
      `Pole „${label}” musi być linkiem do Google Maps (google.com, google.pl, goo.gl, g.co)`
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// Odczyt PUNKTU z linku do Map Google
// ---------------------------------------------------------------------------
//
// Po co: link wklejony w notatce dostaje na froncie kartę z mini-mapą (Leaflet +
// OSM, bez klucza Google) zamiast zwykłego podglądu strony. Żeby ją narysować,
// trzeba ze SAMEGO ADRESU wyciągnąć współrzędne — Google nie oddaje ich w
// metadanych strony.
//
// To jest CZYSTY parser: niczego nie pobiera i nic z jego wyniku nie trafia do
// `fetch` (podgląd wychodzi wyłącznie pod znormalizowany adres użytkownika,
// przez `assertFetchableUrl`). Dlatego może być łagodniejszy dla hosta niż
// `ALLOWED_HOST_SUFFIXES` wyżej i przyjmować dowolną krajową domenę Google
// (`google.de`, `google.co.uk`) — wzorzec i tak wymaga, żeby `google.<tld>`
// kończyło nazwę, więc `google.evil.com` odpada.

/** Punkt/etykieta odczytane z adresu. Brak współrzędnych = trzeba je dopiero zdobyć. */
export interface GoogleMapsLink {
  lat?: number;
  lng?: number;
  /** Zoom z `,17z` albo `?z=` — bez niego front bierze własny domyślny. */
  zoom?: number;
  /** Nazwa miejsca z `/place/<Nazwa>` — gotowy podpis karty. */
  label?: string;
  /** Fraza z `/search/<tekst>` albo `?q=<tekst>` — do geokodowania. */
  query?: string;
  /** Krótki link (goo.gl / maps.app.goo.gl / g.co): punkt zna dopiero przekierowanie. */
  short?: boolean;
}

/** Hosty krótkich linków — współrzędnych nie niosą, trzeba iść za przekierowaniem. */
const SHORT_HOST_SUFFIXES = ["goo.gl", "g.co"] as const;

/** `google.pl`, `www.google.com`, `maps.google.de`, `google.co.uk` — ale nie `google.evil.com`. */
const GOOGLE_HOST_RE = /^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

export function isGoogleShortHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return SHORT_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export function isGoogleHost(hostname: string): boolean {
  return GOOGLE_HOST_RE.test(hostname.toLowerCase());
}

const LAT_MAX = 90;
const LNG_MAX = 180;

function validPoint(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -LAT_MAX &&
    lat <= LAT_MAX &&
    lng >= -LNG_MAX &&
    lng <= LNG_MAX
  );
}

/** `52.2297,21.0122` (także z `+` albo spacją po przecinku) → punkt. */
function pointFromPair(text: string): { lat: number; lng: number } | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*\+?\s*(-?\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return validPoint(lat, lng) ? { lat, lng } : null;
}

/** Zoom z Map bywa ułamkowy (`17.5z`) — do UI wystarczy liczba całkowita 1–21. */
function normalizeZoom(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const z = Math.round(Number(raw));
  if (!Number.isFinite(z) || z < 1 || z > 21) return undefined;
  return z;
}

/**
 * Segment ścieżki → czytelna nazwa: `Pa%C5%82ac+Kultury` → „Pałac Kultury".
 * `+` jest w Mapach spacją, a nie plusem (Google koduje prawdziwy plus jako `%2B`).
 */
function prettySegment(segment: string): string | undefined {
  if (!segment) return undefined;
  let text = segment.replace(/\+/g, " ");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Niedokończona sekwencja `%` — zostaje wersja surowa, lepsza niż wyjątek.
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length ? text : undefined;
}

/** Pierwsza niepusta wartość spośród parametrów zapytania. */
function firstParam(params: URLSearchParams, names: string[]): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Adres Map Google → punkt, zoom i etykieta. `null`, gdy to nie jest link do Map
 * (inny host, `google.com/search?q=…`) albo gdy nie da się z niego wyczytać NIC
 * użytecznego (np. same współrzędne poza zakresem: `@999,21`).
 *
 * Obsługiwane warianty (kolejność = pierwszeństwo przy odczycie współrzędnych):
 *   `/maps/place/<Nazwa>/@lat,lng,17z` · `/maps/@lat,lng,15z` ·
 *   `/maps/search/<tekst>/@lat,lng` · `/maps/dir/…/@lat,lng` ·
 *   `…!3d<lat>!4d<lng>` (pinezka miejsca w bloku `data=`) ·
 *   `/maps/place|search|dir/<lat>,<lng>` · `?q=lat,lng` · `?ll=lat,lng` ·
 *   `?q=<tekst>` / `?query=<tekst>` (do geokodowania) ·
 *   `/maps/place/<tekst>` bez `@` (sama etykieta) ·
 *   `goo.gl/maps/*`, `maps.app.goo.gl/*`, `g.co/kgs/*` (`short: true`).
 */
export function parseGoogleMapsUrl(raw: string): GoogleMapsLink | null {
  let u: URL;
  try {
    u = new URL((raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase();
  if (isGoogleShortHost(host)) return { short: true };
  if (!isGoogleHost(host)) return null;

  // Link do MAP, a nie do wyszukiwarki: `/maps…` albo stary `maps.google.*/?q=`.
  const isMapsPath = /^\/maps(\/|$|\?)/.test(u.pathname) || u.pathname === "/maps";
  const isMapsHost = host === "maps.google.com" || /^maps\.google\./.test(host);
  if (!isMapsPath && !isMapsHost) return null;

  const out: GoogleMapsLink = {};
  const segments = u.pathname.split("/").filter(Boolean); // ["maps","place","…"]
  const whole = `${u.pathname}${u.search}`;

  // 1. `@lat,lng[,17z]` — widok mapy; jedyny wariant, który niesie też zoom.
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(whole);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (validPoint(lat, lng)) {
      out.lat = lat;
      out.lng = lng;
      out.zoom = normalizeZoom(at[3]);
    }
  }

  // 2. `!3d<lat>!4d<lng>` — dokładna pinezka miejsca w bloku `data=`.
  if (out.lat === undefined) {
    const bang = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(whole);
    if (bang) {
      const lat = Number(bang[1]);
      const lng = Number(bang[2]);
      if (validPoint(lat, lng)) {
        out.lat = lat;
        out.lng = lng;
      }
    }
  }

  // 3. Segment po `/place/`, `/search/`, `/dir/` — punkt albo nazwa/fraza.
  const kindIdx = segments.findIndex((s) => s === "place" || s === "search" || s === "dir");
  if (kindIdx >= 0) {
    const kind = segments[kindIdx];
    for (const segment of segments.slice(kindIdx + 1)) {
      if (segment.startsWith("@") || segment.startsWith("data=")) break;
      const pretty = prettySegment(segment);
      if (!pretty) continue;
      const point = pointFromPair(pretty);
      if (point) {
        if (out.lat === undefined) {
          out.lat = point.lat;
          out.lng = point.lng;
        }
        // Współrzędne w ścieżce nie są nazwą miejsca — etykiety z nich nie robimy.
        break;
      }
      // `/dir/` zaczyna się od PUNKTU STARTOWEGO — geokodowanie go zawiozłoby
      // mapę pod zły adres, więc z trasy bierzemy tylko współrzędne (albo cel
      // z parametru `destination` niżej).
      if (kind === "place") out.label ??= pretty;
      else if (kind === "search") out.query ??= pretty;
      break;
    }
  }

  // 4. Parametry zapytania: `q`/`ll`/`center`/`destination` z punktem albo z frazą.
  // `URLSearchParams` samo rozkodowało `%xx` i `+`, więc tu tylko porządkujemy spacje.
  const paramValue = firstParam(u.searchParams, ["q", "ll", "center", "destination", "daddr", "query"]);
  if (paramValue) {
    const point = pointFromPair(paramValue);
    if (point) {
      if (out.lat === undefined) {
        out.lat = point.lat;
        out.lng = point.lng;
      }
    } else {
      const text = paramValue.replace(/\s+/g, " ").trim();
      if (text) out.query ??= text;
    }
  }

  out.zoom ??= normalizeZoom(firstParam(u.searchParams, ["z", "zoom"]));

  // Pusty wynik (np. `@999,21` — współrzędne poza zakresem i nic poza nimi) to
  // dla wołającego to samo, co „nie link do Map".
  if (out.lat === undefined && !out.label && !out.query) return null;
  return out;
}
