/*
 * SERVICE WORKER PANELU TECHNIKA (/technik)
 *
 * Pisany RĘCZNIE, bez `vite-plugin-pwa`. Powód jest prosty: w tym repo jeden
 * build Vite serwuje DWIE aplikacje — biurowy CRM i panel technika. Wtyczka
 * generuje workera dla całego originu i precache'uje cały manifest builda;
 * tutaj worker ma obsługiwać wyłącznie `/technik` i nie dotykać CRM-a.
 *
 * PLIK LEŻY W ROOCIE (`/technik-sw.js`), a nie w `/technik/`, bo `/technik` to
 * ścieżka React Routera, nie katalog — backend oddaje pod nią `index.html`.
 * Rejestracja prosi o `scope: "/technik"`, czyli WĘŻSZY niż katalog skryptu
 * (`/`), więc nagłówek `Service-Worker-Allowed` NIE jest potrzebny (jest
 * wymagany tylko przy scope SZERSZYM niż położenie pliku).
 *
 * Scope `/technik`, nie `/technik/`: dopasowanie scope to prefiks ŚCIEŻKI, a
 * `/technik` (czyli `start_url` z manifestu) nie zaczyna się od `/technik/`.
 * Z ukośnikiem panel otwarty pod gołym `/technik` nie miałby kontrolera.
 *
 * STRATEGIE
 *   • nawigacja (`request.mode === "navigate"`) — NETWORK FIRST, a przy braku
 *     sieci zcache'owana powłoka `/technik`. Odwrotnie (cache first) technik po
 *     wdrożeniu nowej wersji siedziałby na starym HTML-u do czasu, aż sam
 *     zamknie wszystkie karty.
 *   • `/assets/*` — CACHE FIRST. Vite hashuje nazwy plików, więc treść pod
 *     danym adresem nigdy się nie zmienia; nowy build to nowe adresy.
 *   • `/api/*` — NIGDY. Zlecenia, protokoły i podpisy czyta się z sieci albo
 *     wcale; podany z cache stan „sprzed godziny" jest gorszy niż komunikat
 *     o braku połączenia.
 *
 * WERSJONOWANIE. Nazwa cache niesie wersję panelu wstrzykniętą przy rejestracji
 * (`/technik-sw.js?v=TECHNIK_VERSION`) — zmiana wersji to nowy bajt w URL-u
 * workera, więc przeglądarka widzi „nowy plik", a stare cache lecą w `activate`.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `technik-${VERSION}`;

/** Powłoka aplikacji — pod tym kluczem leży HTML podawany offline. */
const SHELL_URL = "/technik";

// ---------------------------------------------------------------------------
// Cykl życia
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Powłoka pobrana z sieci — bez niej pierwsze wejście offline nie ma czego pokazać.
      await cache.add(new Request(SHELL_URL, { cache: "reload" })).catch(() => {});
      // BEZ `skipWaiting()` tutaj: nowa wersja czeka, aż użytkownik kliknie
      // „Odśwież" w pasku panelu. Podmiana workera pod palcami technika
      // wypełniającego protokół przeładowałaby mu ekran w połowie zdania.
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("technik-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

/** Most do panelu: `{type:"SKIP_WAITING"}` = użytkownik kliknął „Odśwież". */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Przechwytywanie żądań
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API nigdy nie idzie przez cache — ani do odczytu, ani do zapisu.
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigateFirst(req));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req));
  }
});

/** Nawigacja: sieć, a gdy jej nie ma — ostatnia znana powłoka panelu. */
async function navigateFirst(req) {
  try {
    const res = await fetch(req);
    // Zapamiętujemy TYLKO powłokę (jeden wpis), nie każdy odwiedzony adres:
    // wszystkie ścieżki panelu i tak dostają ten sam `index.html`.
    if (res && res.ok && new URL(req.url).pathname.startsWith("/technik")) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(SHELL_URL, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Brak połączenia</title>" +
        '<body style="font:16px system-ui;padding:2rem">' +
        "<h1>Brak połączenia</h1><p>Panel technika wymaga sieci przy pierwszym uruchomieniu.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

/** Zasoby builda: z cache, a gdy ich tam nie ma — z sieci i do cache. */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

// ---------------------------------------------------------------------------
// POWIADOMIENIA PUSH
//
// Ładunek przychodzi z `src/lib/push.ts` jako JSON `{title, body, url, tag}`.
// Gdyby kiedykolwiek przyszedł pusty „tickle" (push service potrafi wysłać
// zdarzenie bez danych), i tak pokazujemy powiadomienie — spec wymaga, żeby
// każde `push` skończyło się `showNotification`, inaczej przeglądarka
// wyświetla własne „ta strona działa w tle".
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Alfa — Panel technika";
  const url = typeof data.url === "string" && data.url.startsWith("/technik") ? data.url : "/technik";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // Jeden `tag` na zlecenie: kolejna zmiana terminu PODMIENIA poprzednie
      // powiadomienie zamiast dokładać kolejne do stosu.
      tag: data.tag || "technik",
      renotify: Boolean(data.tag),
      icon: "/technik-icon-192.png",
      badge: "/technik-icon-192.png",
      // Zlecenie na dziś ma zostać na ekranie, dopóki technik go nie zobaczy.
      requireInteraction: true,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/technik";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Najpierw szukamy OTWARTEJ karty panelu — technik ma jedną instalację na
      // tablecie i druga kopia aplikacji nie jest mu do niczego potrzebna.
      for (const client of clientList) {
        if (new URL(client.url).pathname.startsWith("/technik")) {
          await client.focus();
          // `navigate()` bywa niedostępne (Safari) — wtedy zostaje sama karta,
          // a panel i tak odświeży listę przy powrocie z tła.
          if (typeof client.navigate === "function") {
            await client.navigate(target).catch(() => {});
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
