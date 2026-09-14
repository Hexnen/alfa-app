/**
 * SERWOWANIE ZBUDOWANEGO FRONTU (`frontend/dist`) — cache, ETag i fallback SPA.
 *
 * Mieszka w osobnym module, a nie w `src/index.ts`, wyłącznie po to, żeby dało
 * się to przetestować: `src/index.ts` przy imporcie stawia serwer, migruje bazę
 * i uruchamia poller IMAP, więc nie da się go wciągnąć do skryptu testowego.
 * Tutaj jest sama funkcja `mountStatic(app, dir)` i czysta logika nagłówków.
 *
 * TRZY REGUŁY CACHE:
 *  - `/assets/*` — Vite stempluje te pliki hashem treści, więc lecą „na zawsze"
 *    (`immutable`). Bez tego CRM ciągnął ~3,4 MB przy każdym wejściu, a panel
 *    technika robił to na transferze komórkowym w aucie.
 *  - `index.html`, service worker, manifest — `no-cache`: to one decydują
 *    o WERSJI aplikacji i muszą być rewalidowane, inaczej wdrożenie nie dojdzie
 *    do zainstalowanej PWA.
 *  - obrazy, ikony i fonty SPOZA `/assets/` (favicon, ikony PWA, logo) — doba.
 *    Nazwy nie mają hasha, więc „na zawsze" byłoby nieodwracalne, ale ciągnięcie
 *    logo przy każdym wejściu to czysty transfer za nic.
 *
 * ETAG. Słaby, z rozmiaru i czasu modyfikacji pliku (`W/"<size>-<mtimeMs>"`).
 * Nie trzeba do niego czytać zawartości, a rewalidacja `no-cache`-owanych
 * plików kończy się wtedy na 304 z pustym ciałem zamiast na ponownym przesłaniu
 * całego `index.html` przy każdym odświeżeniu panelu.
 */
import { statSync } from "node:fs";
import { normalize } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/** Rozszerzenia serwowane z cache na dobę, gdy leżą poza `/assets/`. */
const LONG_CACHE_EXT =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot)$/i;

/**
 * Ścieżka, która WYGLĄDA na plik: kropka i 2–5 znaków rozszerzenia na końcu.
 * Trasy SPA tak nie wyglądają (`/technik/zlecenie/12`, `/technical/magazyn`),
 * więc brak takiego pliku na dysku to 404, a nie `index.html`. Wcześniej
 * `/favicon.ico` oddawał 200 z HTML-em: przeglądarka próbowała zrobić z tego
 * ikonę, a service worker — zapisać „obrazek" w cache.
 */
const FILE_LIKE_PATH = /\.[a-z0-9]{2,5}$/i;

/** Pliki, które decydują o wersji aplikacji — zawsze do rewalidacji. */
function isVersionFile(path: string): boolean {
  return (
    path === "/" ||
    path === "/technik-sw.js" ||
    path === "/technik.webmanifest" ||
    path.endsWith(".html")
  );
}

/** Nagłówek `Cache-Control` dla ścieżki albo `null`, gdy nic nie narzucamy. */
export function cacheControlFor(path: string): string | null {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (isVersionFile(path)) return "no-cache";
  if (LONG_CACHE_EXT.test(path)) return "public, max-age=86400";
  return null;
}

/**
 * Ścieżka URL → ścieżka na dysku w katalogu frontu, albo `null`, gdy wyprowadza
 * poza katalog (`..`, „%2e%2e", bajt zerowy). Sam `serveStatic` też się przed
 * tym broni; tutaj liczymy z tej ścieżki ETag, więc musi być tak samo szczelna.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = normalize(decoded);
  if (!normalized.startsWith("/") || normalized.includes("..")) return null;
  return `${root}${normalized}`;
}

/** `W/"<rozmiar>-<mtime>"` dla istniejącego pliku; `null`, gdy pliku nie ma. */
export function weakEtagFor(root: string, urlPath: string): string | null {
  const abs = resolveStaticPath(root, urlPath);
  if (!abs) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  } catch {
    return null;
  }
}

/** Czy klient przysłał ten sam ETag (obsługuje listę i `*`). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === etag || v === etag.replace(/^W\//, ""));
}

/**
 * Wpina statyki i fallback SPA w aplikację. Wołać PO zamontowaniu `/api`
 * i zdrowotnego `/healthz` — łapie wszystko, co zostało.
 */
export function mountStatic(app: Hono, root: string, readIndexHtml: () => string): void {
  // Cache + ETag. Middleware biegnie PRZED `serveStatic`, więc gdy klient ma
  // aktualny plik, kończymy na 304 i pliku w ogóle nie czytamy z dysku.
  app.use("/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const path = c.req.path;
    if (path.startsWith("/api/") || path === "/api" || path === "/healthz") return next();

    const etag = weakEtagFor(root, path === "/" ? "/index.html" : path);
    const cacheControl = cacheControlFor(path);
    if (etag && etagMatches(c.req.header("if-none-match"), etag)) {
      const headers: Record<string, string> = { ETag: etag };
      // 304 musi nieść ten sam `Cache-Control` co 200 — inaczej przeglądarka
      // przy następnym wejściu znów pyta o plik, który właśnie potwierdziła.
      if (cacheControl) headers["Cache-Control"] = cacheControl;
      return c.body(null, 304, headers);
    }

    await next();
    if (!c.res.ok) return;
    if (etag && !c.res.headers.has("ETag")) c.res.headers.set("ETag", etag);
    if (cacheControl && !c.res.headers.has("Cache-Control")) {
      c.res.headers.set("Cache-Control", cacheControl);
    }
  });

  // Statyki frontu (js/css/obrazki/designer, ...).
  app.use("/*", serveStatic({ root }));

  // Fallback SPA: każdy nie-API GET, który nie trafił w plik, dostaje
  // index.html, żeby routing po stronie klienta działał na głębokich linkach.
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api")) {
      return c.json({ success: false, error: "Not Found" }, 404);
    }
    // Brakujący PLIK to 404, a nie aplikacja w HTML-u (patrz FILE_LIKE_PATH).
    if (FILE_LIKE_PATH.test(c.req.path)) {
      return c.json({ success: false, error: "Not Found" }, 404);
    }
    // Fallback omija middleware wyżej (kończy się przed `next()`), więc
    // nagłówek ustawiamy tutaj: `index.html` musi być rewalidowany przy każdym
    // wejściu, inaczej nowa wersja nie dojdzie do zainstalowanej PWA.
    c.header("Cache-Control", "no-cache");
    const etag = weakEtagFor(root, "/index.html");
    if (etag) c.header("ETag", etag);
    return c.html(readIndexHtml());
  });
}
