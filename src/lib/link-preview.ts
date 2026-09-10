/**
 * Podgląd linku (unfurl) — pobiera z cudzej strony tytuł, opis, favicon i obrazek
 * Open Graph, żeby front mógł pokazać „bogaty" link zamiast gołego adresu.
 *
 * DLACZEGO TO JEST WRAŻLIWE. Endpoint bierze URL OD UŻYTKOWNIKA i wychodzi po
 * niego z serwera — to podręcznikowy SSRF. Serwer stoi w sieci, w której są
 * rzeczy niedostępne z przeglądarki: sama aplikacja (localhost:4001), baza,
 * metadane chmury (169.254.169.254), inne kontenery. Dlatego walidacja jest tu
 * DWUSTOPNIOWA i obowiązuje przy KAŻDYM przeskoku przekierowania:
 *   1. nazwa hosta — `localhost`, `*.local`, literalne adresy IP z zakresów
 *      prywatnych;
 *   2. wynik DNS (`dns.lookup` z `all: true`) — bo `evil.example.com` może
 *      wskazywać na 127.0.0.1. Sprawdzamy WSZYSTKIE zwrócone adresy: host,
 *      który zwraca jeden publiczny i jeden prywatny, jest odrzucany.
 * Przekierowania idą `redirect: "manual"` — inaczej pierwszy stopień walidacji
 * byłby dekoracją, bo `fetch` sam poszedłby za 302 na 127.0.0.1.
 *
 * Reszta ograniczeń: 6 s na całość, 512 KB ciała (czytane strumieniem, potem
 * abort), tylko `text/html` parsujemy, maks. 3 przekierowania, maks. 4 pobrania
 * naraz w całym procesie i jedno naraz per URL.
 *
 * Wynik ląduje w tabeli `link_previews` (TTL: 7 dni dla `ok`, 1 h dla `error`).
 *
 * OSOBNY WĄTEK: linki do Google Maps. Dla nich doklejamy `map` — punkt, zoom i
 * podpis odczytane z samego adresu (`src/lib/maps-url.ts`), z adresu po
 * przekierowaniach (krótkie `maps.app.goo.gl`) albo z geokodera. Front rysuje z
 * tego mini-mapę na kafelkach OSM, więc nie potrzebujemy klucza Google, a punkt
 * — jak reszta podglądu — siedzi w cache'u (`link_previews.map_json`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { parseGoogleMapsUrl } from "./maps-url.js";
import { geocode, isGeoError, reverseAddress } from "./geo.js";

// ---------------------------------------------------------------------------
// Kształt danych
// ---------------------------------------------------------------------------

/**
 * Punkt do mini-mapy — wypełniony TYLKO dla linków Google Maps.
 * Front rysuje go Leafletem na kafelkach OSM (bez klucza Google).
 */
export interface LinkPreviewMap {
  lat: number;
  lng: number;
  /** Zoom z adresu albo `DEFAULT_MAP_ZOOM`; front i tak ogranicza go do 12–17. */
  zoom: number;
  /** Podpis karty: nazwa z `/place/…` → tytuł strony → adres z geokodera. */
  label: string | null;
}

export interface LinkPreview {
  /** Adres znormalizowany — klucz cache'u i to, o co pytał front. */
  url: string;
  /** Adres po przekierowaniach (przy błędzie równy `url`). */
  finalUrl: string;
  host: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
  /** Punkt mini-mapy dla linków Google Maps; `null` dla wszystkiego innego. */
  map: LinkPreviewMap | null;
  status: "ok" | "error";
  error: string | null;
  fetchedAt: string;
}

/** Ile trzymamy udany podgląd, zanim odświeżymy przy następnym pytaniu. */
export const TTL_OK_MS = 7 * 24 * 60 * 60 * 1000;
/** Nieudany krócej — strona mogła po prostu chwilowo nie odpowiadać. */
export const TTL_ERROR_MS = 60 * 60 * 1000;

const TIMEOUT_MS = 6_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PARALLEL = 4;
const DESCRIPTION_MAX = 200;
/** Zoom mini-mapy, gdy adres go nie niesie (kwartał ulic, a nie cała aglomeracja). */
export const DEFAULT_MAP_ZOOM = 15;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Normalizacja adresu
// ---------------------------------------------------------------------------

/**
 * Sprowadza to, co wpisał użytkownik, do postaci kanonicznej: przycina spacje,
 * dokleja `https://` przed `www.`, usuwa fragment (`#...` nigdy nie dociera do
 * serwera, więc dwa adresy różniące się tylko nim to ten sam podgląd).
 * Zwraca `null`, jeśli to nie jest adres http(s).
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  u.hash = "";
  return u.toString();
}

/** Hostname bez nawiasów IPv6 (`[::1]` → `::1`), małymi literami. */
export function bareHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// ---------------------------------------------------------------------------
// Adresy, do których serwerowi nie wolno wyjść
// ---------------------------------------------------------------------------

/** Czy adres IPv4 (jako tekst) leży w zakresie prywatnym/specjalnym. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const n = parts.map((p) => Number(p));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = n;
  if (a === 0) return true; // 0.0.0.0/8 — „ten host"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // pętla zwrotna
  if (a === 169 && b === 254) return true; // link-local + metadane chmury
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24 (dokumentacja)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a >= 224) return true; // multicast 224/4 + zarezerwowane 240/4
  return false;
}

/** Czy adres IPv6 (jako tekst) jest lokalny, link-local, multicast albo mapuje v4. */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // odcinamy identyfikator strefy (fe80::1%eth0)
  if (addr === "::1" || addr === "::") return true;
  // ::ffff:127.0.0.1 i ::127.0.0.1 — v4 w przebraniu; oceniamy częścią v4.
  const mapped = addr.match(/^(?:::ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 — unique local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 — link-local
  if (/^ff/.test(addr)) return true; // ff00::/8 — multicast
  return false;
}

/** Wspólne wejście dla obu rodzin adresów. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Pierwszy stopień walidacji — bez sieci, po samej nazwie hosta.
 * Zwraca komunikat błędu albo `null`, gdy host przechodzi.
 */
export function checkHostname(hostname: string): string | null {
  const host = bareHostname(hostname);
  if (!host) return "Adres bez nazwy hosta";
  if (host === "localhost" || host.endsWith(".localhost")) return "Adres lokalny jest niedozwolony";
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return "Adres lokalny jest niedozwolony";
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) return "Adres z sieci prywatnej jest niedozwolony";
    return null;
  }
  // Nazwa bez kropki (`intranet`, `db`) to nazwa z sieci wewnętrznej.
  if (!host.includes(".")) return "Adres lokalny jest niedozwolony";
  return null;
}

/**
 * Pełna walidacja adresu: schemat, nazwa hosta i (dla nazw) rozwiązanie DNS.
 * Rzuca `LinkPreviewError` — świadomie, żeby wywołujący nie mógł jej zignorować.
 */
export class LinkPreviewError extends Error {}

export async function assertFetchableUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LinkPreviewError("Nieprawidłowy adres URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new LinkPreviewError("Dozwolone są tylko adresy http i https");
  }
  const nameProblem = checkHostname(u.hostname);
  if (nameProblem) throw new LinkPreviewError(nameProblem);

  const host = bareHostname(u.hostname);
  if (isIP(host)) return; // literalny adres publiczny — DNS nie ma czego rozwiązywać

  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new LinkPreviewError("Nie udało się rozwiązać nazwy hosta");
  }
  if (addresses.length === 0) throw new LinkPreviewError("Nie udało się rozwiązać nazwy hosta");
  // WSZYSTKIE adresy muszą być publiczne — jeden prywatny wystarczy, żeby
  // atakujący trafił tam losowaniem systemowego resolvera.
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new LinkPreviewError("Adres wskazuje na sieć prywatną");
    }
  }
}

// ---------------------------------------------------------------------------
// Parsowanie HTML — bez zależności, sam skan `<head>`
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  rdquo: "”",
  ldquo: "“",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  deg: "°",
  szlig: "ß",
};

/** Dekoduje encje HTML (nazwane z listy wyżej + numeryczne dziesiętne i szesnastkowe). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,30});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Wartość atrybutu z pojedynczego znacznika (obsługuje ", ' i wartość bez cudzysłowów). */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** Adres absolutny względem strony; `null`, jeśli to nie wychodzi na http(s). */
function absolutize(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, " ").trim();
  return v.length ? v : null;
}

export interface HtmlMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
}

/**
 * Wyciąga metadane z HTML-a. Skan ogranicza się do `<head>` (jeśli jest) —
 * dalej zaczyna się treść strony, w której `<title>` w SVG albo `og:` w
 * komentarzu tylko myli.
 */
export function parseHtmlMeta(html: string, finalUrl: string): HtmlMeta {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html.slice(0, 200_000);

  const metas: { key: string; content: string }[] = [];
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop") ?? "").toLowerCase();
    const content = attr(tag, "content");
    if (key && content) metas.push({ key, content });
  }
  const meta = (key: string): string | null => metas.find((x) => x.key === key)?.content ?? null;

  const titleTag = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const rawTitle = titleTag ? decodeEntities(titleTag[1]) : null;

  const title = clean(meta("og:title") ?? meta("twitter:title") ?? rawTitle);

  const rawDescription = clean(meta("og:description") ?? meta("twitter:description") ?? meta("description"));
  const description =
    rawDescription && rawDescription.length > DESCRIPTION_MAX
      ? `${rawDescription.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
      : rawDescription;

  const image = absolutize(clean(meta("og:image") ?? meta("og:image:url") ?? meta("twitter:image")), finalUrl);

  let host = "";
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    host = "";
  }
  const siteName = clean(meta("og:site_name")) ?? (host || null);

  // Ikona: bierzemy pierwszą sensowną deklarację, z preferencją dla zwykłego
  // `icon`/`shortcut icon` przed `apple-touch-icon` (ta bywa wielka).
  let iconHref: string | null = null;
  let appleHref: string | null = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel.includes("icon")) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    if (rel.includes("apple-touch-icon")) {
      appleHref ??= href;
    } else if (rel.split(/\s+/).some((r) => r === "icon" || r === "shortcut")) {
      iconHref ??= href;
    }
  }
  const favicon = absolutize(iconHref ?? appleHref, finalUrl) ?? fallbackFavicon(host);

  return { title, description, image, siteName, favicon };
}

/** Ikona z serwisu Google — używana, gdy strona nie deklaruje własnej albo w ogóle nie odpowiada. */
export function fallbackFavicon(host: string): string | null {
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

// ---------------------------------------------------------------------------
// Kodowanie znaków
// ---------------------------------------------------------------------------

/**
 * Nazwa kodowania z nagłówka `Content-Type` albo z `<meta charset>` w pierwszym
 * kilobajcie ciała. Polskie strony bywają w windows-1250 albo iso-8859-2 —
 * bez tego z „Zaświadczenia" robi się „Za?wiadczenia".
 */
export function detectCharset(contentTypeHeader: string | null, head: string): string {
  const fromHeader = contentTypeHeader?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const fromMetaCharset = head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/i)?.[1];
  if (fromMetaCharset) return fromMetaCharset.toLowerCase();
  const fromHttpEquiv = head.match(/<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*>/i)?.[0];
  const inEquiv = fromHttpEquiv?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  if (inEquiv) return inEquiv.toLowerCase();
  return "utf-8";
}

/** Dekoduje bajty ciała wg wykrytego kodowania; przy nieznanym wraca do utf-8. */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null): string {
  // Do wykrycia `<meta charset>` wystarczy początek — a że to ASCII, latin1 nie zaszkodzi.
  const probe = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = detectCharset(contentTypeHeader, probe);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Pobranie
// ---------------------------------------------------------------------------

/** Czyta ciało odpowiedzi strumieniem i przerywa po `MAX_BYTES`. */
async function readLimited(res: Response): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) break;
    }
  } finally {
    // Zamknięcie po przerwaniu w połowie — inaczej połączenie wisi.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.subarray(0, out.length - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/**
 * Pobiera i parsuje stronę. Bez cache'u, bez kolejki i bez mini-mapy — to robią
 * `getLinkPreview` i `fetchPreview`. `fetch` bierzemy z `globalThis` przy każdym
 * wywołaniu, żeby test mógł go podmienić.
 */
async function fetchPreviewRaw(normalized: string): Promise<LinkPreview> {
  const startHost = bareHostname(new URL(normalized).hostname);
  const base: LinkPreview = {
    url: normalized,
    finalUrl: normalized,
    host: startHost,
    title: null,
    description: null,
    image: null,
    favicon: fallbackFavicon(startHost),
    siteName: null,
    map: null,
    status: "error",
    error: null,
    fetchedAt: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = normalized;
    let res: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Walidacja PRZY KAŻDYM przeskoku — 302 na 127.0.0.1 to najprostszy
      // sposób obejścia sprawdzenia zrobionego tylko raz, na wejściu.
      await assertFetchableUrl(current);
      const response: Response = await globalThis.fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl,en;q=0.8",
        },
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (location) {
        await response.body?.cancel().catch(() => {});
        if (hop === MAX_REDIRECTS) throw new LinkPreviewError("Za dużo przekierowań");
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new LinkPreviewError("Nieprawidłowe przekierowanie");
        }
        current = next;
        continue;
      }
      res = response;
      break;
    }

    if (!res) throw new LinkPreviewError("Za dużo przekierowań");
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new LinkPreviewError(`Strona odpowiedziała ${res.status}`);
    }

    const finalUrl = res.url && /^https?:/i.test(res.url) ? res.url : current;
    const finalHost = bareHostname(new URL(finalUrl).hostname);
    const contentType = res.headers.get("content-type");
    const isHtml = /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? "");

    if (!isHtml) {
      // Nie-HTML (PDF, obrazek, plik) — nie ma czego parsować. Zwracamy tyle,
      // ile wiemy: domenę i typ. Front pokaże klikalny link z tą domeną.
      await res.body?.cancel().catch(() => {});
      return {
        ...base,
        finalUrl,
        host: finalHost,
        siteName: finalHost,
        description: clean((contentType ?? "").split(";")[0]) ?? null,
        favicon: fallbackFavicon(finalHost),
        status: "ok",
        error: null,
      };
    }

    const bytes = await readLimited(res);
    const html = decodeBody(bytes, contentType);
    const metaData = parseHtmlMeta(html, finalUrl);

    return {
      ...base,
      finalUrl,
      host: finalHost,
      title: metaData.title,
      description: metaData.description,
      image: metaData.image,
      favicon: metaData.favicon ?? fallbackFavicon(finalHost),
      siteName: metaData.siteName ?? finalHost,
      status: "ok",
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof LinkPreviewError
        ? err.message
        : err instanceof Error && err.name === "AbortError"
          ? "Przekroczono czas oczekiwania"
          : "Nie udało się pobrać strony";
    return { ...base, status: "error", error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Mini-mapa dla linków Google Maps
// ---------------------------------------------------------------------------

/** Ogon tytułu strony Google („Pałac Kultury - Google Maps") — w karcie nic nie wnosi. */
const GOOGLE_TITLE_SUFFIX_RE = /\s*[-–—|]\s*(?:Google\s+Maps|Mapy\s+Google|Google\s+Mapy)\s*$/i;

/** Tytuł generycznej strony Map — jako podpis punktu nie mówi nic. */
const GOOGLE_TITLE_GENERIC_RE = /^(?:google(?:\s+maps|\s+mapy)?|mapy\s+google|maps)$/i;

function stripGoogleTitle(title: string | null): string | null {
  if (!title) return null;
  const v = title.replace(GOOGLE_TITLE_SUFFIX_RE, "").replace(/\s+/g, " ").trim();
  if (!v.length || GOOGLE_TITLE_GENERIC_RE.test(v)) return null;
  return v;
}

/**
 * Adres z Nominatim bywa litanią („Rynek Główny, Stare Miasto, Kraków,
 * województwo małopolskie, 31-042, Polska") — w podpisie karty zostawiamy
 * początek, bo dalej idą jednostki administracyjne.
 */
function shortAddress(display: string | null): string | null {
  if (!display) return null;
  const parts = display.split(",").map((p) => p.trim()).filter(Boolean);
  const head = parts.slice(0, 2).join(", ");
  return head.length ? head : null;
}

/** Czy adres (wejściowy albo końcowy) to w ogóle link do Map Google. */
export function isMapsLink(url: string): boolean {
  return parseGoogleMapsUrl(url) !== null;
}

/**
 * Punkt mini-mapy dla linku do Map. Kolejność jest celowa i idzie od
 * najtańszego źródła do najdroższego:
 *   1. sam adres wejściowy (zero ruchu),
 *   2. adres PO PRZEKIEROWANIACH — `maps.app.goo.gl/x` niesie punkt dopiero po
 *      rozwinięciu, a rozwinięcie i tak już się wydarzyło w `fetchPreviewRaw`
 *      (`redirect: "manual"` + `assertFetchableUrl` na każdym przeskoku), więc
 *      tutaj tylko czytamy `finalUrl`,
 *   3. geokoder (Nominatim przez `src/lib/geo.ts` — z cache'em `geo_cache` i
 *      kolejką 1 req/s), gdy w adresie jest tylko fraza albo nazwa miejsca.
 *
 * Nigdy nie rzuca: brak sieci, pusty wynik geokodera albo adres spoza Polski
 * (geokoder ma `countrycodes=pl`) kończą się `null`, czyli zwykłą kartą linku.
 */
async function resolveMap(
  inputUrl: string,
  finalUrl: string,
  title: string | null
): Promise<LinkPreviewMap | null> {
  const fromInput = parseGoogleMapsUrl(inputUrl);
  const fromFinal = finalUrl !== inputUrl ? parseGoogleMapsUrl(finalUrl) : null;
  if (!fromInput && !fromFinal) return null;

  // Adres końcowy jest bogatszy (krótki link → pełny `/place/…/@lat,lng`), ale
  // etykieta i fraza z adresu wklejonego przez człowieka mają pierwszeństwo.
  const link = { ...(fromFinal ?? {}), ...(fromInput ?? {}) };
  if (fromFinal?.lat !== undefined && fromInput?.lat === undefined) {
    link.lat = fromFinal.lat;
    link.lng = fromFinal.lng;
    link.zoom = fromInput?.zoom ?? fromFinal.zoom;
  }
  link.label ??= fromFinal?.label;
  link.query ??= fromFinal?.query;

  let lat = link.lat;
  let lng = link.lng;
  let geocoded: string | null = null;

  if (lat === undefined || lng === undefined) {
    const query = link.query ?? link.label;
    if (!query) return null;
    try {
      const hit = await geocode(query);
      if (isGeoError(hit)) return null;
      lat = hit.lat;
      lng = hit.lng;
      geocoded = hit.display;
    } catch (err) {
      // Geokoder to dodatek — jego awaria nie ma prawa zabrać podglądu linku.
      console.warn("[link-preview] geokodowanie mapy:", err);
      return null;
    }
  }

  // Fraza wpisana przez człowieka („Rynek Główny Kraków") jest lepszym podpisem
  // niż pełny adres z geokodera, dlatego stoi przed nim.
  let label = link.label ?? stripGoogleTitle(title) ?? link.query ?? shortAddress(geocoded);

  if (!label) {
    // Pinezka udostępniona z telefonu to same współrzędne (`/maps/search/52.29,+21.06`)
    // i generyczny tytuł „Google Maps" — bez reverse karta miałaby tylko liczby.
    try {
      label = await reverseAddress({ lat, lng });
    } catch (err) {
      console.warn("[link-preview] reverse adresu mapy:", err);
      label = null;
    }
  }

  return { lat, lng, zoom: link.zoom ?? DEFAULT_MAP_ZOOM, label: label ?? null };
}

/**
 * Podgląd strony + (dla linków Google Maps) punkt mini-mapy.
 *
 * Dla Map świadomie kasujemy `og:image`: Google podaje tam wielki obrazek
 * podglądu mapy, który w karcie dublowałby to, co i tak rysujemy Leafletem.
 * Tytuł i favicon zostają — są podpisem karty i jej ikoną.
 */
export async function fetchPreview(normalized: string): Promise<LinkPreview> {
  const preview = await fetchPreviewRaw(normalized);
  if (!isMapsLink(preview.url) && !isMapsLink(preview.finalUrl)) return preview;
  const map = await resolveMap(preview.url, preview.finalUrl, preview.title);
  return { ...preview, image: null, map };
}

// ---------------------------------------------------------------------------
// Kolejka: 4 pobrania naraz w procesie, jedno naraz per URL
// ---------------------------------------------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Trwające pobrania — drugie pytanie o ten sam adres dostaje tę samą obietnicę. */
const inFlight = new Map<string, Promise<LinkPreview>>();

// ---------------------------------------------------------------------------
// Cache w bazie
// ---------------------------------------------------------------------------

/** `map_json` z bazy → punkt. Uszkodzony albo niepełny JSON = brak mapy, nie wyjątek. */
function parseMapJson(raw: string | null): LinkPreviewMap | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LinkPreviewMap> | null;
    if (!v || typeof v.lat !== "number" || typeof v.lng !== "number") return null;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return null;
    return {
      lat: v.lat,
      lng: v.lng,
      zoom: typeof v.zoom === "number" && Number.isFinite(v.zoom) ? v.zoom : DEFAULT_MAP_ZOOM,
      label: typeof v.label === "string" && v.label.trim() ? v.label : null,
    };
  } catch {
    return null;
  }
}

function rowToPreview(row: typeof schema.linkPreviews.$inferSelect): LinkPreview {
  return {
    url: row.url,
    finalUrl: row.finalUrl ?? row.url,
    host: row.host,
    title: row.title,
    description: row.description,
    image: row.image,
    favicon: row.favicon,
    siteName: row.siteName,
    map: parseMapJson(row.mapJson),
    status: row.status === "error" ? "error" : "ok",
    error: row.error,
    fetchedAt: row.fetchedAt,
  };
}

function readCache(url: string): LinkPreview | null {
  const row = db.select().from(schema.linkPreviews).where(eq(schema.linkPreviews.url, url)).get();
  if (!row) return null;
  const preview = rowToPreview(row);
  const age = Date.now() - Date.parse(preview.fetchedAt.includes("T") ? preview.fetchedAt : `${preview.fetchedAt}Z`);
  // Link do Map BEZ punktu trzymamy tak krótko jak błąd (1 h), mimo `status: "ok"`.
  // Dwa powody, oba praktyczne: (1) wiersze zapisane, zanim mini-mapa powstała,
  // mają `map_json` NULL i przez 7 dni blokowałyby kartę mimo działającego już
  // parsera; (2) brak punktu dla mapy zwykle znaczy „nie udało się TERAZ"
  // (geokoder nie odpowiedział, przekierowanie zwróciło stronę zgody), a nie
  // „tego miejsca nie ma". Ponowne pytanie kosztuje jedno pobranie, a nie tydzień
  // pustej karty.
  const mapMiss = preview.status === "ok" && !preview.map && isMapsLink(preview.url);
  const ttl = preview.status === "ok" && !mapMiss ? TTL_OK_MS : TTL_ERROR_MS;
  if (!Number.isFinite(age) || age < 0 || age > ttl) return null;
  return preview;
}

function writeCache(preview: LinkPreview): void {
  const values = {
    url: preview.url,
    finalUrl: preview.finalUrl,
    host: preview.host,
    title: preview.title,
    description: preview.description,
    image: preview.image,
    favicon: preview.favicon,
    siteName: preview.siteName,
    mapJson: preview.map ? JSON.stringify(preview.map) : null,
    status: preview.status,
    error: preview.error,
    fetchedAt: preview.fetchedAt,
  };
  db.insert(schema.linkPreviews)
    .values(values)
    .onConflictDoUpdate({ target: schema.linkPreviews.url, set: values })
    .run();
}

/**
 * Podgląd linku: z cache'u, jeśli świeży; inaczej pobranie (jedno naraz per URL,
 * maks. 4 naraz w procesie) i zapis wyniku — także błędu, żeby martwy adres nie
 * był odpytywany przy każdym renderze notatki.
 */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) throw new LinkPreviewError("Nieprawidłowy adres URL");

  const cached = readCache(normalized);
  if (cached) return cached;

  const pending = inFlight.get(normalized);
  if (pending) return pending;

  const promise = withSlot(async () => {
    // Cache mógł się wypełnić, gdy staliśmy w kolejce.
    const fresh = readCache(normalized);
    if (fresh) return fresh;
    const preview = await fetchPreview(normalized);
    try {
      writeCache(preview);
    } catch {
      // Cache to optymalizacja — nieudany zapis nie ma psuć odpowiedzi.
    }
    return preview;
  }).finally(() => {
    inFlight.delete(normalized);
  });

  inFlight.set(normalized, promise);
  return promise;
}
