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
