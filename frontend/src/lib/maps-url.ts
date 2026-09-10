/**
 * LINKI GOOGLE MAPS — jeden parser dla całego frontu.
 *
 * Kod żył dotąd w dwóch kopiach: `components/LocationPicker.tsx:56-127`
 * (`toMapsUrl`, `parseCoords`, `isDirectInput`) i okrojony w
 * `pages/AdminCompany.tsx:63` (`parseMapsUrl` łapał wyłącznie `?q=lat,lng`, więc
 * link „/@lat,lng” z tej samej mapy już nie działał). Formularz obiektu i
 * formularz zlecenia potrzebują dokładnie tego samego rozpoznawania, dlatego
 * parser jest tutaj, a tamte pliki importują — zachowanie 1:1 z LocationPickerem.
 *
 * Podział ról: TU rozpoznajemy współrzędne, które SIEDZĄ w tekście; krótkie linki
 * (`maps.app.goo.gl`, `goo.gl/maps`, `g.co`) współrzędnych nie niosą i musi je
 * rozwinąć serwer (`GET /api/public/resolve-location`, allowlista hostów przeciw
 * SSRF — src/routes/public.ts:358). Przeglądarka nie pójdzie za tym przekierowaniem
 * (CORS), stąd `resolveMapsLink` z fallbackiem po sieć.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Hosty, które backend przepuszcza w `mapsUrl` i w `resolve-location`
 * (`ALLOWED_HOST_SUFFIXES` w src/routes/public.ts:358). Trzymamy kopię, żeby UI
 * mogło ostrzec PRZED zapisem zamiast czekać na 400 z serwera.
 */
const ALLOWED_HOST_SUFFIXES = ["google.com", "google.pl", "goo.gl", "g.co"] as const;

/** Build the canonical Google Maps URL we persist in objectLocationUrl. */
export function toMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/**
 * Parse coordinates from either a Google Maps URL or a bare "lat, lng" string.
 * Handles @lat,lng · ?q=lat,lng / q=lat,lng · !3dlat!4dlng · /place/.../@lat,lng.
 */
export function parseCoords(raw: string): LatLng | null {
  if (!raw) return null;
  const value = raw.trim();

  const inRange = (lat: number, lng: number) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  // !3d<lat>!4d<lng>
  const bang = value.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) {
    const lat = parseFloat(bang[1]);
    const lng = parseFloat(bang[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // @<lat>,<lng>  (covers /place/.../@lat,lng too)
  const at = value.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lng = parseFloat(at[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // /maps/search/<lat>,+<lng>  ·  /place/<lat>,<lng>  ·  /dir/<lat>,<lng>
  const path = value.match(
    /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?),\+?\s*(-?\d+(?:\.\d+)?)/
  );
  if (path) {
    const lat = parseFloat(path[1]);
    const lng = parseFloat(path[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // q=<lat>,<lng>  (?q= or &q=)
  const q = value.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (q) {
    const lat = parseFloat(q[1]);
    const lng = parseFloat(q[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // Bare "lat, lng"
  const bare = value.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lng = parseFloat(bare[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  return null;
}

/**
 * True when the raw text is something we can place directly — coordinates or an
 * http(s) link (Google Maps) — rather than a free-text address to geocode.
 */
export function isDirectInput(raw: string): boolean {
  return parseCoords(raw) != null || /^https?:\/\//i.test(raw.trim());
}

/**
 * Czy to link, który backend przyjmie jako `objects.mapsUrl`. Sam wygląd URL-a
 * nie wystarczy — pole trzyma WYŁĄCZNIE domeny Google (walidacja serwera), więc
 * formularz musi umieć powiedzieć „to nie jest link do Map” od razu.
 */
export function isGoogleMapsUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Skąd wzięły się współrzędne — UI mówi „odczytano z linku” vs „rozwinięto krótki link”. */
export type MapsLinkSource = "parsed" | "resolved";

export interface ResolvedMapsLink extends LatLng {
  source: MapsLinkSource;
}

/**
 * Współrzędne z tego, co człowiek wkleił: najpierw parser (link długi albo
 * „szer, dł” — bez wychodzenia w sieć), a gdy w tekście ich nie ma, prośba do
 * serwera o rozwinięcie krótkiego linku.
 *
 * Rzuca `Error` z POLSKIM komunikatem gotowym do pokazania pod polem — te same
 * zdania, co dotąd w `LocationPicker.applyPaste` (l.463-505).
 */
export async function resolveMapsLink(value: string): Promise<ResolvedMapsLink> {
  const raw = value.trim();

  // Ścieżka szybka: współrzędne siedzą wprost w tekście (@lat,lng, q=, „lat, lng”).
  const coords = parseCoords(raw);
  if (coords) return { ...coords, source: "parsed" };

  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      "Nie rozpoznano współrzędnych. Wklej link Google Maps lub „szer, dł”."
    );
  }

  // Krótkie linki (maps.app.goo.gl / goo.gl / g.co) nie niosą współrzędnych —
  // przeglądarka nie pójdzie za przekierowaniem (CORS), robi to serwer.
  let json: { success?: boolean; error?: string; data?: LatLng } | null = null;
  let ok = false;
  try {
    const res = await fetch(
      `/api/public/resolve-location?url=${encodeURIComponent(raw)}`
    );
    ok = res.ok;
    json = await res.json();
  } catch {
    throw new Error("Nie udało się połączyć, aby rozpoznać link.");
  }
  if (ok && json?.success && json.data) {
    return { lat: json.data.lat, lng: json.data.lng, source: "resolved" };
  }
  throw new Error(json?.error ?? "Nie udało się odczytać pinezki z tego linku.");
}

// ---------------------------------------------------------------------------
// REVERSE GEOCODE — pinezka → normalny polski adres
// ---------------------------------------------------------------------------
//
// Kod przyszedł z `components/LocationPicker.tsx:67-119` (`polishStreet`,
// `reverseGeocode`) i stoi tutaj z tego samego powodu, co parser linków:
// formularz obiektu podpowiada adres z odczytanej pinezki, a mapa w formularzu
// zlecenia robi dokładnie to samo — druga kopia rozjechałaby się przy pierwszej
// poprawce (np. dopisaniu kolejnego typu ulicy).

/** Linia ulicy po polsku: „ul.” dopisujemy tylko, gdy nazwa sama nie ma typu. */
export function polishStreet(road: string, house: string): string {
  const name = road.trim();
  if (!name) return "";
  const hasType =
    /^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|rondo|os\.|osiedle|bulwar|skwer|park|droga|szosa|trakt|wybrzeże)\b/i.test(
      name
    );
  const withType = hasType ? name : "ul. " + name;
  return house ? `${withType} ${house}` : withType;
}

export interface ReverseGeocodeHit {
  /** Sama ulica z numerem („ul. Prosta 51”) — do pola „Adres” w kartotece. */
  street: string;
  /** Miasto osobno, bo CRM trzyma je w oddzielnej kolumnie. */
  city: string;
  /** Pełna linia „ulica, miasto, województwo” — podgląd i mapa w zleceniu. */
  display: string;
}

/**
 * Pinezka → adres z Nominatim. `null`, gdy sieć/usługa zawiodły — podpowiedź
 * adresu jest wygodą, a nie warunkiem zapisu obiektu, więc błąd jest cichy.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<ReverseGeocodeHit | null> {
  const url =
    "https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&accept-language=pl&lat=" +
    lat +
    "&lon=" +
    lng;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const a = data?.address ?? {};
    const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway || "";
    const house = a.house_number || "";
    const city =
      a.city || a.town || a.village || a.municipality || a.hamlet || a.county || "";
    // Nominatim zwraca „województwo mazowieckie" — zostawiamy samo „mazowieckie".
    const voivodeship = (a.state || "").replace(/^województwo\s+/i, "");

    const street =
      polishStreet(road, house) ||
      (typeof data?.display_name === "string"
        ? data.display_name.split(",")[0].trim()
        : "");

    return { street, city, display: [street, city, voivodeship].filter(Boolean).join(", ") };
  } catch {
    return null;
  }
}
