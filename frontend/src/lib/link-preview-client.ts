/**
 * Pobieranie podglądów linków po stronie przeglądarki — bez Reacta.
 *
 * Kod mieszkał w `components/RichText.tsx`; wyprowadzony tutaj, bo korzystają z
 * niego DWA komponenty (`LinkPreviewCard` i `MapPreviewCard`), a plik z
 * komponentami ma eksportować komponenty (react-refresh).
 *
 * Dwie warstwy cache'u ponad serwerowym: mapa obietnic w module (drugi render
 * tej samej notatki nie robi drugiego zapytania) i `sessionStorage` (powrót na
 * listę po wejściu w szczegóły nie odpala zapytań od nowa).
 */
import { linksApi, type LinkDistances, type LinkPreview } from "@/lib/api";

/**
 * Prefiks z wersją: zmiana kształtu odpowiedzi (np. dojście pola `map`) podbija
 * ją, żeby stare wpisy w otwartych kartach nie zasłaniały nowych danych.
 */
const SESSION_PREFIX = "alfa.linkPreview.v2.";
/** Krócej niż serwerowy TTL — `sessionStorage` ma tylko oszczędzić okrążenie do API. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** Link do Map bez punktu to wynik tymczasowy (jak `status: "error"`) — nie trzymamy go w sesji. */
const MAP_HOST_RE = /(^|\.)(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/i;
function isIncompleteMapPreview(url: string, data: LinkPreview): boolean {
  if (data.map) return false;
  try {
    const u = new URL(url);
    return MAP_HOST_RE.test(u.hostname) && (u.hostname.includes("goo.gl") || u.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

/** Domena adresu, bez „www." — to ona jest podpisem karty. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** Ikona z serwisu Google — używana, gdy strona nie ma własnej albo ta się nie wczytała. */
export function googleFavicon(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** Trwające i zakończone pobrania w obrębie karty przeglądarki. */
const memoryCache = new Map<string, Promise<LinkPreview>>();

export function readSessionPreview(url: string): LinkPreview | null {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: LinkPreview };
    if (!parsed?.data || Date.now() - parsed.at > SESSION_TTL_MS) return null;
    if (isIncompleteMapPreview(url, parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeSession(url: string, data: LinkPreview) {
  if (isIncompleteMapPreview(url, data)) return;
  try {
    sessionStorage.setItem(SESSION_PREFIX + url, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Pełny albo wyłączony storage — podgląd i tak zadziała, tylko bez cache'u.
  }
}

/** Podgląd linku; błąd zapytania też jest wynikiem — kartę pokazujemy zawsze. */
export function loadPreview(url: string): Promise<LinkPreview> {
  const pending = memoryCache.get(url);
  if (pending) return pending;
  const promise = linksApi
    .preview(url)
    .then((res) => {
      const data = res.data as LinkPreview;
      writeSession(url, data);
      return data;
    })
    .catch((err) => {
      // Błąd zapytania (400, brak sieci) też jest wynikiem — pokazujemy gołą domenę.
      memoryCache.delete(url);
      const host = hostOf(url);
      const fallback: LinkPreview = {
        url,
        finalUrl: url,
        host,
        title: null,
        description: null,
        image: null,
        // Ikona z serwisu Google działa nawet wtedy, gdy nasz backend nie
        // odpowiedział — karta bez ikony wygląda jak zepsuta.
        favicon: googleFavicon(host),
        siteName: null,
        map: null,
        status: "error",
        error: err instanceof Error ? err.message : "Nie udało się pobrać podglądu",
        fetchedAt: new Date().toISOString(),
      };
      return fallback;
    });
  memoryCache.set(url, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Dystanse do punktu z karty mapy
// ---------------------------------------------------------------------------

/** Trwające i zakończone zapytania o dystanse (klucz: punkt + obiekt). */
const distanceCache = new Map<string, Promise<LinkDistances | null>>();

function distanceKey(lat: number, lng: number, objectId?: number | null): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}|${objectId ?? ""}`;
}

/**
 * „Od biura / od obiektu" dla pinezki. Brak odpowiedzi (błąd, brak biura) to
 * `null` — dystanse są dodatkiem do karty, więc ich brak nie może niczego zepsuć.
 * Nie trafiają do `sessionStorage`: trasa dolicza się po stronie serwera i przy
 * następnym wejściu bywa dokładniejsza (linia prosta → trasa OSRM).
 */
export function loadDistances(
  lat: number,
  lng: number,
  objectId?: number | null
): Promise<LinkDistances | null> {
  const key = distanceKey(lat, lng, objectId);
  const pending = distanceCache.get(key);
  if (pending) return pending;
  const promise = linksApi
    .distances(lat, lng, objectId)
    .then((res) => (res.data as LinkDistances) ?? null)
    .catch(() => {
      distanceCache.delete(key); // błąd sieci nie ma zamrażać braku danych na całą sesję
      return null;
    });
  distanceCache.set(key, promise);
  return promise;
}
