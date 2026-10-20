/**
 * KAFLE Z TREŚCI NOTATKI — telefony i linki do map wyciągnięte z wolnego tekstu.
 *
 * Technik (i odbiorca linku `/u/:token`) czyta notatkę na telefonie w aucie.
 * Numer wpisany w środku zdania albo 200-znakowy adres Google Maps to cel
 * dotykowy wielkości kilku pikseli — dlatego pod treścią stają kafle w stylu
 * „Nawiguj”/„Zadzwoń” z `KafleAkcji`.
 *
 * Czysta funkcja bez Reacta i bez sieci (test: `scripts/test-note-actions.ts`).
 * Celowo NIC nie pobieramy: krótkie linki (`maps.app.goo.gl`) otwierają się
 * same w Mapach, więc nie potrzeba do nich publicznego proxy na serwerze.
 * Adresy wyciąga `linkifyText` (ta sama reguła co RichText w CRM), telefony —
 * własny, szerszy wzorzec (stacjonarne „22 123 45 67” też).
 */
import { linkifyText } from "../../lib/linkify";
import { parseCoords } from "../../lib/maps-url";

export interface NotePhone {
  kind: "phone";
  /**
   * Czytelny zapis krajowy: „600 123 456”, „22 123 45 67” — bez „+48”, który
   * na kaflu 390 px zawijał numer; prefiks i tak siedzi w `href`.
   */
  display: string;
  /** `tel:+48600123456`. */
  href: string;
}

export interface NoteMap {
  kind: "map";
  /** Oryginalny link — otwiera to, co wkleił autor (nazwa miejsca, trasa). */
  href: string;
  /** „Google Maps”, „Apple Maps”, „OpenStreetMap”. */
  provider: string;
  /** Współrzędne, gdy siedzą w samym adresie (krótkie linki ich nie niosą). */
  lat: number | null;
  lng: number | null;
  /** Nawigacja do punktu (tylko przy znanych współrzędnych). */
  navHref: string | null;
}

export type NoteAction = NotePhone | NoteMap;

/** Ile kafli maksymalnie pod jedną notatką — więcej to już lista kontaktów, nie notatka. */
export const NOTE_ACTIONS_LIMIT = 6;

/**
 * Polski numer: opcjonalnie `+48` / `0048` / `(+48)`, potem 9 cyfr w zapisach
 * 3-3-3 („600 123 456”, „600-123-456”, „600123456”) albo 2-3-2-2 z kierunkowym
 * (także w nawiasie: „(22) 123 45 67”). Lookbehind/lookahead nie pozwalają
 * wyciąć dziewięciu cyfr ze środka NIP-u, kwoty, daty ani adresu URL.
 */
const PHONE_RE =
  /(?<![\w/,=+-])((?:\(?(?:\+|00)48\)?[\s.-]?)?(?:\(\d{2}\)[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}|\d{2}[\s.-]\d{3}[\s.-]\d{2}[\s.-]\d{2}|\d{3}[\s.-]?\d{3}[\s.-]?\d{3}))(?![\w-]|[.,]\d)/g;

/** Prefiksy komórkowe (pierwsze dwie cyfry) — decydują o grupowaniu 3-3-3 vs 2-3-2-2. */
const MOBILE_PREFIXES = new Set(["45", "50", "51", "53", "57", "60", "66", "69", "72", "73", "78", "79", "88"]);

/** Dziewięć cyfr numeru krajowego (bez +48) albo `null`, gdy to nie numer PL. */
function nationalDigits(raw: string): string | null {
  let d = raw.replace(/[^\d]/g, "");
  const intl = /^\(?(?:\+|00)48/.test(raw.trim());
  if (intl) d = d.replace(/^(?:00)?48/, "");
  if (d.length !== 9) return null;
  // Numer krajowy nie zaczyna się od zera (to byłby stary prefiks międzymiastowy albo śmieć).
  if (d.startsWith("0")) return null;
  return d;
}

/** „600123456” → „600 123 456”, „221234567” → „22 123 45 67”; z „+48 ” gdy autor go podał. */
export function formatPlPhone(digits: string, withCountry: boolean): string {
  const mobile = MOBILE_PREFIXES.has(digits.slice(0, 2));
  const body = mobile
    ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
    : `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}`;
  return withCountry ? `+48 ${body}` : body;
}

export function extractPhones(text: string): NotePhone[] {
  const out: NotePhone[] = [];
  const seen = new Set<string>();
  // Telefony szukamy w tekście BEZ adresów — cyfry w ścieżce linku (`/place/…/600123456`)
  // nie są numerem do klienta.
  const plain = linkifyText(text)
    .map((t) => (t.kind === "url" || t.kind === "email" || t.kind === "internal" ? " " : t.kind === "text" ? t.value : t.display))
    .join("");
  for (const m of plain.matchAll(PHONE_RE)) {
    const raw = m[1];
    const digits = nationalDigits(raw);
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    out.push({ kind: "phone", display: formatPlPhone(digits, false), href: `tel:+48${digits}` });
  }
  return out;
}

/** Dostawca map po hoście; `null` = zwykły link (nie kafel). */
export function mapProviderOf(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  if (host === "maps.app.goo.gl" || (host === "goo.gl" && path.startsWith("/maps"))) return "Google Maps";
  if (/^maps\.google\.[a-z.]+$/.test(host)) return "Google Maps";
  if (/^google\.[a-z.]+$/.test(host) && /^\/maps(\/|$)/.test(path)) return "Google Maps";
  if (host === "maps.apple.com" || host === "maps.apple") return "Apple Maps";
  if (host === "openstreetmap.org" || host === "osm.org") return "OpenStreetMap";
  return null;
}

/** Współrzędne z linku: Google (parser z `lib/maps-url`), Apple `ll=`/`q=`, OSM `mlat/mlon` i `#map=`. */
function coordsOf(href: string): { lat: number; lng: number } | null {
  const google = parseCoords(href);
  if (google) return google;
  try {
    const u = new URL(href);
    const ll = u.searchParams.get("ll") ?? u.searchParams.get("daddr") ?? u.searchParams.get("q");
    if (ll) {
      const c = parseCoords(ll);
      if (c) return c;
    }
    const mlat = Number(u.searchParams.get("mlat"));
    const mlon = Number(u.searchParams.get("mlon"));
    if (u.searchParams.has("mlat") && Number.isFinite(mlat) && Number.isFinite(mlon)) {
      if (Math.abs(mlat) <= 90 && Math.abs(mlon) <= 180) return { lat: mlat, lng: mlon };
    }
    const hash = u.hash.match(/map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (hash) {
      const lat = Number(hash[1]);
      const lng = Number(hash[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  } catch {
    /* zły URL — zostaje sam link */
  }
  return null;
}

/** Nawigacja Google działa i w przeglądarce, i w aplikacji Map na telefonie (jak `MapPreviewCard`). */
export function directionsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Klucz deduplikacji linku: bez schematu, `www.`, `#` i końcowego `/`. */
function mapKey(href: string): string {
  return href
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/#.*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function extractMaps(text: string): NoteMap[] {
  const out: NoteMap[] = [];
  const seen = new Set<string>();
  for (const t of linkifyText(text)) {
    if (t.kind !== "url") continue;
    const provider = mapProviderOf(t.href);
    if (!provider) continue;
    const key = mapKey(t.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = coordsOf(t.href);
    out.push({
      kind: "map",
      href: t.href,
      provider,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      navHref: c ? directionsHref(c.lat, c.lng) : null,
    });
  }
  return out;
}

/**
 * Wszystkie kafle notatki: najpierw mapy (dokąd jechać), potem telefony — w
 * kolejności wystąpienia, bez powtórzeń, maks. `NOTE_ACTIONS_LIMIT`.
 * `exclude` pomija to, co ekran pokazuje już wyżej (np. telefon kontaktowy
 * zlecenia w kaflu „Zadzwoń”).
 */
export function extractNoteActions(
  text: string | null | undefined,
  exclude: { phones?: (string | null | undefined)[]; mapsUrls?: (string | null | undefined)[] } = {},
): NoteAction[] {
  if (!text?.trim()) return [];
  const skipPhones = new Set(
    (exclude.phones ?? []).map((p) => (p ? nationalDigits(p) ?? "" : "")).filter(Boolean),
  );
  const skipMaps = new Set((exclude.mapsUrls ?? []).filter(Boolean).map((u) => mapKey(u as string)));
  const maps = extractMaps(text).filter((m) => !skipMaps.has(mapKey(m.href)));
  const phones = extractPhones(text).filter((p) => !skipPhones.has(p.href.slice("tel:+48".length)));
  return [...maps, ...phones].slice(0, NOTE_ACTIONS_LIMIT);
}
