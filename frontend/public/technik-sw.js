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
 * WERSJONOWANIE. Nazwa cache niesie wersję wstrzykniętą przy rejestracji
 * (`/technik-sw.js?v=TECHNIK_VERSION-APP_VERSION`) — zmiana wersji to nowy bajt
 * w URL-u workera, więc przeglądarka widzi „nowy plik", a stare cache lecą
 * w `activate`. W SW nie ma `import.meta.env`, więc hash builda nie ma jak tu
 * wejść inaczej; `APP_VERSION` rośnie przy każdym wydaniu, także takim, które
 * rusza wyłącznie CRM — a to ono zmienia hashe w `/assets/*`.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `technik-${VERSION}`;
/** Wszystkie cache tego workera — po tym wzorcu poznajemy swoje, także stare. */
const CACHE_PREFIX = /^technik-/;
/** Ile czekamy na sieć przy nawigacji, zanim podamy zapamiętaną powłokę. */
const NAV_TIMEOUT_MS = 3000;

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
      // Kasujemy KAŻDY swój cache poza bieżącym — także ten nazwany samą
      // wersją panelu z poprzedniego schematu. Inaczej po kilku wydaniach na
      // tablecie leżą trzy komplety powłoki i zasobów, a technik dostaje
      // pierwszy z brzegu.
      for (const key of await caches.keys()) {
        if (CACHE_PREFIX.test(key) && key !== CACHE) await caches.delete(key);
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
    event.respondWith(navigateFirst(event));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(event));
  }
});

/** Obietnica, która spełnia się po `ms` — druga strona wyścigu o nawigację. */
function after(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nawigacja: sieć, a gdy jej nie ma ALBO ledwo ją widać — ostatnia znana
 * powłoka panelu.
 *
 * „Network first" bez zegara wygląda przy jednej kresce zasięgu jak zawieszona
 * aplikacja: `fetch` nie odrzuca obietnicy, tylko wisi minutę na białym
 * ekranie. Dlatego sieć ściga się z trzema sekundami — po nich wchodzi powłoka
 * z cache'u (jeśli jest; przy pierwszym uruchomieniu nie ma czego podać
 * i czekamy na sieć). Odpowiedź z sieci i tak dojdzie i odświeży cache.
 */
async function navigateFirst(event) {
  const req = event.request;
  const cached = await caches.match(SHELL_URL);

  const network = fetch(req).then((res) => {
    // Zapamiętujemy TYLKO powłokę (jeden wpis), nie każdy odwiedzony adres:
    // wszystkie ścieżki panelu i tak dostają ten sam `index.html`.
    if (res && res.ok && new URL(req.url).pathname.startsWith("/technik")) {
      const copy = res.clone();
      // `waitUntil`, nie luźna obietnica: bez tego przeglądarka bywa, że
      // ubija workera zaraz po oddaniu odpowiedzi i zapis do cache'u nigdy się
      // nie kończy — offline pokazywał wtedy powłokę sprzed kilku wydań.
      event.waitUntil(
        caches
          .open(CACHE)
          .then((c) => c.put(SHELL_URL, copy))
          .catch(() => {})
      );
    }
    return res;
  });
  // Wyścig rozstrzyga się na kopii; oryginał dostaje własny `catch`, żeby brak
  // sieci nie wypłynął jako nieobsłużone odrzucenie.
  network.catch(() => {});

  if (!cached) {
    try {
      return await network;
    } catch {
      return offlineShell();
    }
  }

  try {
    return await Promise.race([network, after(NAV_TIMEOUT_MS).then(() => cached)]);
  } catch {
    return cached;
  }
}

/** Ostatnia deska ratunku: pierwsze uruchomienie panelu bez sieci. */
function offlineShell() {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Brak połączenia</title>" +
      '<body style="font:16px system-ui;padding:2rem">' +
      "<h1>Brak połączenia</h1><p>Panel technika wymaga sieci przy pierwszym uruchomieniu.</p>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/** Zasoby builda: z cache, a gdy ich tam nie ma — z sieci i do cache. */
async function cacheFirst(event) {
  const req = event.request;
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const copy = res.clone();
    event.waitUntil(
      caches
        .open(CACHE)
        .then((c) => c.put(req, copy))
        .catch(() => {})
    );
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

/**
 * ODNOWIENIE SUBSKRYPCJI PRZEZ PRZEGLĄDARKĘ.
 *
 * Push service potrafi unieważnić endpoint sam z siebie (czyszczenie danych
 * strony, rotacja po stronie Google/Apple, długa nieaktywność) i wysyła wtedy
 * `pushsubscriptionchange`. Bez tej obsługi w bazie zostaje martwy adres,
 * technik ma przełącznik na „włączone” i nie dostaje NICZEGO aż do momentu,
 * w którym sam wejdzie w „Więcej” i przeklika powiadomienia.
 *
 * Nowy klucz bierzemy ze starej subskrypcji (`oldSubscription.options`) — SW
 * nie ma dostępu do konfiguracji panelu, a klucz VAPID jest ten sam.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription || null;
      const key =
        (old && old.options && old.options.applicationServerKey) ||
        (event.newSubscription &&
          event.newSubscription.options &&
          event.newSubscription.options.applicationServerKey) ||
        null;

      let next = event.newSubscription || null;
      if (!next && key) {
        next = await self.registration.pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: key })
          .catch(() => null);
      }

      // Najpierw nowy adres, potem kasowanie starego: gdyby DELETE poszedł
      // pierwszy, a subskrypcja się nie udała, technik zostałby bez powiadomień
      // i bez śladu, że kiedykolwiek je miał.
      if (next) await postSubscription("POST", next.toJSON());
      if (old && old.endpoint && (!next || next.endpoint !== old.endpoint)) {
        await postSubscription("DELETE", { endpoint: old.endpoint });
      }
    })()
  );
});

function postSubscription(method, body) {
  return fetch("/api/technik/push/subscribe", {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).catch(() => {});
}

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
