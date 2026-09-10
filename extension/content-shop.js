/**
 * Panel „Dodaj do towarów Alfa” wstrzykiwany na strony obsługiwanych sklepów.
 *
 * ZASADY (DLACZEGO tak):
 *  - ZERO `fetch` w tym pliku. Każde żądanie idzie przez service worker
 *    (`background.js`) — fetch z content scriptu podlega CORS strony sklepu,
 *    a poza tym token nie ma czego szukać w kontekście cudzej witryny.
 *  - Shadow DOM `closed` + wszystkie style w środku: sklepy mają agresywne CSS
 *    (reset `* { box-sizing }`, `!important` na przyciskach) i bez izolacji panel
 *    rozjeżdża się na co drugiej stronie. `closed` dodatkowo utrudnia skryptom
 *    sklepu grzebanie w naszym drzewie.
 *  - `z-index: 2147483000` (blisko maksimum, ale nie na styk) — sticky belki
 *    i czaty sklepów potrafią mieć 999999.
 *  - Panel pokazujemy tylko wtedy, gdy naprawdę wygląda to na kartę produktu
 *    albo backend już zna ten adres. Na listingu/koszyku byłby wyłącznie
 *    hałasem, dlatego zostaje mały przypinacz.
 */
(function () {
  "use strict";

  if (window.__alfaShopPanelMounted) return;
  window.__alfaShopPanelMounted = true;

  /** 12 MB — ten sam limit co `bodyLimitFor` dla `POST /plugin/import`. Guard
   * po stronie strony, żeby nie wysyłać megabajtów i dopiero potem dostać 413. */
  const MAX_HTML_BYTES = 12 * 1024 * 1024;
  const NAME_MAX = 40;

  const shopEntry = (typeof self.ALFA_SHOP_FOR === "function" && self.ALFA_SHOP_FOR(location.hostname)) || null;
  /** Konfiguracja wpisana do paczki przez backend (adres, token, wersja, build). */
  const CFG = self.ALFA_CONFIG || {};

  const state = {
    lookup: null,
    error: null,
    queued: 0,
    sending: false,
    expanded: false,
    /** Człowiek zwinął panel („×”) — od tej chwili na tej stronie tylko przypinacz. */
    dismissed: false,
    /** Lokalna detekcja zalogowania w sklepie: "in" | "out" | "unknown". */
    login: "unknown",
    /** To samo, ale policzone przez backend na wysłanym HTML-u — ma priorytet. */
    serverLogin: null,
    /** Lokalny wynik z chwili importu — po zmianie strony werdykt backendu wygasa. */
    loginAtImport: null,
    mounted: false,
  };

  let els = null;

  /* ------------------------------- narzędzia -------------------------------- */

  function fmtDate(value) {
    if (!value) return null;
    const raw = String(value);
    // Backend oddaje ISO albo „YYYY-MM-DD” — bierzemy pierwsze 10 znaków, żeby
    // nie zależeć od strefy czasowej przeglądarki (data ceny to data, nie chwila).
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) return m[3] + "." + m[2] + "." + m[1];
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
  }

  function shorten(text, max) {
    const s = String(text || "").trim();
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const failed = chrome.runtime.lastError;
          if (failed) {
            resolve({ ok: false, status: 0, error: "Wtyczka Alfa nieaktywna — przeładuj stronę" });
            return;
          }
          resolve(resp || { ok: false, status: 0, error: "Brak odpowiedzi wtyczki" });
        });
      } catch (err) {
        resolve({ ok: false, status: 0, error: String((err && err.message) || err) });
      }
    });
  }

  /* --------------------------- heurystyka produktu -------------------------- */

  /**
   * Czy to strona produktu? Nie mamy tu parsera backendu, więc pytamy o ślady,
   * które w sklepach występują niemal zawsze: nagłówek + jakikolwiek znacznik
   * ceny. Plus dwa selektory sklepowe, które znamy z kalibracji parserów
   * (SAMAL: `.product-code-ui`, Janex: `.product-cart-form`).
   */
  function looksLikeProductPage() {
    const h1 = document.querySelector("h1");
    if (!h1 || !(h1.textContent || "").trim()) return false;

    if (document.querySelector('[itemprop="price"], .price, meta[property="product:price:amount"]')) return true;
    if (shopEntry && shopEntry.shop === "samal.pl" && document.querySelector(".product-code-ui")) return true;
    if (shopEntry && shopEntry.shop === "janexint.com.pl" && document.querySelector(".product-cart-form")) return true;

    return hasProductJsonLd();
  }

  function hasProductJsonLd() {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (const node of nodes) {
      const text = node.textContent || "";
      // Tanio i odpornie: sam string wystarczy, JSON-LD w sklepach bywa
      // niepoprawny (przecinki, HTML w środku) i `JSON.parse` się wywala.
      if (/"@type"\s*:\s*"?\[?\s*"?Product/i.test(text)) return true;
    }
    return false;
  }

  /* ---------------------- zalogowanie w sklepie (lokalnie) ------------------ */

  /**
   * Czy człowiek jest zalogowany w sklepie? Bez logowania hurtownie pokazują
   * ceny detaliczne albo żadnych — import takiej strony wpisze do kartoteki
   * złą cenę zakupu. Dlatego ostrzegamy PRZED wysłaniem, a nie po.
   *
   * Punktacja tymi samymi wagami co backend (`src/lib/shop-import/login.ts`):
   * mocny marker zalogowania +3, słaby +2, zaproszenie do logowania −3, brak
   * markera „tylko dla zalogowanych” −1. Trzy odpowiedzi, bo panel ma trzy
   * zachowania: potwierdzenie, ostrzeżenie i milczenie.
   *
   * DLACZEGO nie sam warunek „jest Wyloguj”: sklepy trzymają w DOM-ie ukryte
   * modale logowania (gość i klient mają wtedy te same napisy), a hurtownie
   * pokazują linki do panelu klienta także gościom. Jedno „albo” dawałoby
   * fałszywe alarmy, a te są gorsze niż brak komunikatu.
   */
  function detectShopLogin() {
    const generic = self.ALFA_LOGIN_MARKERS_GENERIC || { login: null, anon: null };
    const loginM = (shopEntry && shopEntry.loginMarkers) || generic.login;
    const anonM = (shopEntry && shopEntry.anonMarkers) || generic.anon;
    if (!loginM || !anonM) return "unknown";

    // Tekst z drzewa jasnego (light DOM) — nasz panel siedzi w shadow roocie,
    // więc jego własne „Zaloguj się i odśwież stronę” tu nie trafia. Gdyby
    // trafiło, panel sam wywoływałby swoje ostrzeżenie.
    const bodyText = collapsedBodyText();

    let score = 0;
    score += 3 * countSelectors(loginM.selectors) + 3 * countTexts(loginM.texts, bodyText);
    score += 2 * countSelectors(loginM.weakSelectors) + 2 * countTexts(loginM.weakTexts, bodyText);
    score -= 3 * (countSelectors(anonM.selectors) + countTexts(anonM.texts, bodyText));
    score -= countMissing(anonM.missing);

    if (score >= 3) return "in";
    if (score <= -1) return "out";
    return "unknown";
  }

  function countSelectors(selectors) {
    let hits = 0;
    for (const sel of selectors || []) {
      try {
        if (document.querySelector(sel)) hits += 1;
      } catch {
        /* zły selektor w markerach nie może wywalić panelu */
      }
    }
    return hits;
  }

  function countTexts(patterns, bodyText) {
    let hits = 0;
    for (const re of patterns || []) {
      if (re.test(bodyText)) hits += 1;
    }
    return hits;
  }

  function countMissing(selectors) {
    let missing = 0;
    for (const sel of selectors || []) {
      try {
        if (!document.querySelector(sel)) missing += 1;
      } catch {
        /* jak wyżej */
      }
    }
    return missing;
  }

  /** Tekst strony bez nadmiarowych spacji — te same regexy co w backendzie. */
  function collapsedBodyText() {
    const body = document.body;
    const raw = body ? body.innerText || body.textContent || "" : "";
    return raw.replace(/\s+/g, " ");
  }

  /**
   * Backend (policzony na wysłanym HTML-u) wygrywa z lokalną heurystyką — ale
   * tylko dopóki strona się nie zmieniła. Gdy człowiek zaloguje się w drugiej
   * karcie i wróci, lokalna detekcja mówi już coś innego niż w chwili importu
   * i wtedy stary werdykt backendu byłby po prostu nieprawdą.
   */
  function effectiveLogin() {
    if (state.serverLogin && state.login === state.loginAtImport) return state.serverLogin;
    return state.login;
  }

  /* ---------------------------- wersja paczki ------------------------------ */

  /**
   * Czy ta paczka jest starsza od tej, którą wydaje teraz backend?
   *
   * DLACZEGO po `build` (skrót plików), a nie po `version`: numer wersji
   * aplikacji zmienia się rzadko, a pliki wtyczki poprawiamy między wersjami —
   * bez skrótu użytkownik siedziałby na paczce z zepsutym selektorem i nic by
   * o tym nie wiedział. Gdy backend nic nie mówi (`pluginBuild` brak, np. stary
   * serwer), MILCZYMY — straszenie bez dowodu jest gorsze niż brak komunikatu.
   */
  function isStalePackage() {
    const serverBuild = state.lookup && state.lookup.pluginBuild;
    if (!serverBuild) return false;
    // Brak `build` w config.js = paczka sprzed wprowadzenia skrótu, czyli stara.
    if (!CFG.build) return true;
    return String(serverBuild) !== String(CFG.build);
  }

  /** Podpis wersji: „v1.4.2 · 3f8ac91b”. Krótko, bo to stopka panelu. */
  function versionLabel() {
    const v = CFG.version ? "v" + CFG.version : "wersja nieznana";
    return CFG.build ? v + " · " + CFG.build : v;
  }

  /* --------------------------------- widok --------------------------------- */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
/* display:flex z .panel wygrywa z UA-owym [hidden] — bez tej reguły ukrywanie
   panelu (i przypinacza) po prostu nie działa. */
[hidden] { display: none !important; }
.wrap {
  position: fixed;
  right: 16px;
  /* Prawy GÓRNY róg (decyzja użytkownika): dolny zasłaniał paski cookies/czatów sklepów. */
  top: 16px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #0f172a;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.pin {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: #1e3a8a;
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.28);
}
.pin:hover { background: #1d4ed8; }
/* Przypinacz jest jedyną rzeczą widoczną, gdy panel jest zwinięty — kropka to
   cały sygnał „coś wymaga uwagi”, dlatego kontrastowa i na krawędzi. */
.pin { position: relative; }
.pin.stale::after {
  content: "";
  position: absolute;
  top: 1px;
  right: 1px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #f59e0b;
  border: 2px solid #fff;
}
.panel {
  width: 320px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.head { display: flex; align-items: center; gap: 8px; }
.logo {
  width: 22px; height: 22px; border-radius: 6px;
  background: #1e3a8a; color: #fff;
  font-weight: 700; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
}
.title { font-weight: 600; flex: 1 1 auto; }
.shop { color: #64748b; font-size: 11px; }
.close {
  border: none; background: transparent; cursor: pointer;
  color: #94a3b8; font-size: 18px; line-height: 1; padding: 0 2px;
}
.close:hover { color: #475569; }
.status { color: #334155; word-break: break-word; }
.status.found { color: #166534; }
.status.err { color: #b91c1c; }
.note { color: #92400e; font-size: 11px; }
.stale-line { color: #b45309; font-size: 11px; }
.ver { color: #94a3b8; font-size: 10px; text-align: right; letter-spacing: 0.02em; }
.login-ok { color: #166534; font-size: 11px; }
.login-warn {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
}
.btns { display: flex; flex-direction: column; gap: 6px; }
.btn {
  width: 100%;
  border-radius: 10px;
  border: 1px solid transparent;
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
}
.btn.primary { background: #1e3a8a; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #1d4ed8; }
.btn.secondary { background: #f1f5f9; color: #1e293b; border-color: #cbd5e1; font-weight: 500; }
.btn.secondary:hover:not(:disabled) { background: #e2e8f0; }
.btn:disabled { opacity: 0.6; cursor: default; }
.toast {
  max-width: calc(100vw - 32px);
  padding: 9px 12px;
  border-radius: 10px;
  background: #0f172a;
  color: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.3);
  word-break: break-word;
}
.toast.ok { background: #166534; }
.toast.err { background: #b91c1c; }
.toast.warn { background: #b45309; }
@media (max-width: 480px) {
  .wrap { right: 10px; top: 10px; left: 10px; align-items: stretch; }
  .panel { width: auto; }
  .pin { align-self: flex-end; }
}
`;

  function mount() {
    if (state.mounted) return;
    state.mounted = true;

    const host = document.createElement("div");
    host.id = "alfa-magazyn-host";
    // Host bez własnych wymiarów — całe pozycjonowanie jest w środku shadow
    // roota, żeby CSS sklepu (np. `div { margin: 0 auto }`) nie miał do czego
    // się przyczepić.
    host.style.setProperty("all", "initial", "important");
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const toasts = document.createElement("div");
    toasts.style.display = "flex";
    toasts.style.flexDirection = "column";
    toasts.style.gap = "6px";

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = [
      '<div class="head">',
      '  <div class="logo">A</div>',
      '  <div class="title">Alfa — magazyn<div class="shop"></div></div>',
      '  <button class="close" type="button" title="Zwiń">×</button>',
      "</div>",
      '<div class="status">Sprawdzam w Alfa…</div>',
      '<div class="login-ok" hidden>✓ Zalogowany w sklepie</div>',
      '<div class="login-warn" hidden>Nie jesteś zalogowany w sklepie — ceny będą detaliczne albo niewidoczne. Zaloguj się i odśwież stronę.</div>',
      '<div class="note" hidden></div>',
      '<div class="btns">',
      '  <button class="btn primary" type="button" disabled>Dodaj do towarów Alfa</button>',
      '  <button class="btn secondary" type="button" disabled>Dodaj do kolejki</button>',
      "</div>",
      '<div class="stale-line" hidden>Wtyczka nieaktualna — pobierz nową paczkę z Magazynu (Towary → Wtyczka)</div>',
      '<div class="ver"></div>',
    ].join("");

    const pin = document.createElement("button");
    pin.className = "pin";
    pin.type = "button";
    pin.title = "Alfa — magazyn";
    pin.textContent = "A";

    // Kolejność w stosie: panel (albo przypinacz) na górze, toasty POD nimi.
    // DLACZEGO nie odwrotnie: od kiedy stos jest zakotwiczony u GÓRY strony,
    // toast wstawiony przed panelem zepychałby go w dół przy każdym komunikacie
    // (a dłuższy błąd potrafiłby wypchnąć przyciski poza widok).
    wrap.appendChild(panel);
    wrap.appendChild(pin);
    wrap.appendChild(toasts);
    root.appendChild(style);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);

    els = {
      host,
      panel,
      pin,
      toasts,
      shop: panel.querySelector(".shop"),
      status: panel.querySelector(".status"),
      loginOk: panel.querySelector(".login-ok"),
      loginWarn: panel.querySelector(".login-warn"),
      note: panel.querySelector(".note"),
      stale: panel.querySelector(".stale-line"),
      ver: panel.querySelector(".ver"),
      primary: panel.querySelector(".btn.primary"),
      secondary: panel.querySelector(".btn.secondary"),
      close: panel.querySelector(".close"),
    };

    els.close.addEventListener("click", () => {
      state.expanded = false;
      state.dismissed = true;
      render();
    });
    els.pin.addEventListener("click", () => {
      state.expanded = true;
      state.dismissed = false;
      render();
    });
    els.primary.addEventListener("click", () => doImport("open"));
    els.secondary.addEventListener("click", () => doImport("queue"));

    render();
  }

  function shouldShowPanel() {
    if (state.expanded) return true;
    // Zwinięcie musi wygrywać z „found”, inaczej „×” na stronie produktu nic
    // nie robi (panel wracałby przy każdym renderze).
    if (state.dismissed) return false;
    if (state.lookup && state.lookup.found) return true;
    return looksLikeProductPage();
  }

  function render() {
    if (!els) return;
    const showPanel = shouldShowPanel();
    els.panel.hidden = !showPanel;
    els.pin.hidden = showPanel;

    // Detekcję zalogowania liczymy przy KAŻDYM pokazaniu panelu: człowiek może
    // zalogować się w drugiej karcie i wrócić, a sklepy dociągają belkę konta
    // AJAX-em już po `document_idle`.
    if (showPanel) state.login = detectShopLogin();

    const label = (state.lookup && state.lookup.shopLabel) || (shopEntry && shopEntry.label) || location.hostname;
    els.shop.textContent = label;

    // Status
    els.status.classList.remove("found", "err");
    if (state.error) {
      els.status.textContent = state.error;
      els.status.classList.add("err");
    } else if (!state.lookup) {
      els.status.textContent = "Sprawdzam w Alfa…";
    } else if (state.lookup.found && state.lookup.item) {
      const item = state.lookup.item;
      const date = fmtDate(item.priceUpdatedAt || item.fetchedAt);
      els.status.textContent =
        "Masz w Alfa: " + (item.name || "towar") + (date ? " — cena z " + date : " — bez daty ceny");
      els.status.classList.add("found");
    } else {
      els.status.textContent = "Nowy towar dla Alfa";
    }

    // Dopisek o niekalibrowanym parserze — człowiek musi wiedzieć, że pola
    // trzeba sprawdzić ręcznie.
    const calibrated = state.lookup ? state.lookup.calibrated !== false : !shopEntry || shopEntry.calibrated !== false;
    els.note.hidden = calibrated;
    els.note.textContent = calibrated ? "" : "Parser: ogólny (do kalibracji)";

    // Zalogowanie w sklepie: „in” dyskretnie, „out” na żółto z instrukcją,
    // „unknown” w ogóle (fałszywy alarm byłby gorszy niż milczenie).
    const login = effectiveLogin();
    els.loginOk.hidden = login !== "in";
    els.loginWarn.hidden = login !== "out";

    // Przyciski
    const item = state.lookup && state.lookup.found ? state.lookup.item : null;
    els.primary.disabled = state.sending;
    els.secondary.disabled = state.sending;
    els.primary.textContent = state.sending
      ? "Wysyłam…"
      : login === "out"
        ? // Nie blokujemy importu — czasem człowiek świadomie chce cenę detaliczną
          // albo heurystyka się myli. Ale etykieta ma to nazywać po imieniu.
          "Dodaj mimo to"
        : item
          ? "Aktualizuj w Alfa: " + shorten(item.name || "towar", NAME_MAX)
          : "Dodaj do towarów Alfa";
    els.primary.title = item ? "Aktualizuj w Alfa: " + (item.name || "") : "Dodaj do towarów Alfa";
    els.secondary.textContent = state.queued > 0 ? "Dodaj do kolejki (" + state.queued + ")" : "Dodaj do kolejki";

    // Wersja paczki: malutko, w stopce — ma być do odczytania przy zgłaszaniu
    // problemu, a nie rywalizować o uwagę z przyciskami.
    const stale = isStalePackage();
    els.ver.textContent = versionLabel();
    els.stale.hidden = !stale;
    // Import zostaje sprawny mimo starej paczki: kontrakt `/plugin/import` się
    // nie zmienia, a blokowanie pracy z powodu numerka byłoby złośliwością.
    els.pin.classList.toggle("stale", stale);
    els.pin.title = "Alfa — magazyn " + versionLabel() + (stale ? " — nieaktualna paczka" : "");
  }

  function toast(text, kind) {
    if (!els) return;
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = text;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.remove();
    }, kind === "err" || kind === "warn" ? 8000 : 4500);
  }

  /* --------------------------------- akcje --------------------------------- */

  async function doImport(mode) {
    if (state.sending) return; // blokada podwójnego kliknięcia (dubel w kolejce)
    const html = document.documentElement.outerHTML;
    // Bajty, nie znaki — limit po stronie serwera dotyczy ciała żądania.
    const bytes = new Blob([html]).size;
    if (bytes > MAX_HTML_BYTES) {
      toast("Strona za duża — zapisz ją na dysk i zaimportuj plikiem w Magazynie", "err");
      return;
    }

    state.sending = true;
    render();
    const res = await send({ type: "alfa-import", html, url: location.href, title: document.title, mode });
    state.sending = false;

    if (!res || !res.ok) {
      toast((res && res.error) || "Nie udało się wysłać do Alfa", "err");
      render();
      return;
    }

    const data = res.data || {};
    if (typeof data.queued === "number") state.queued = data.queued;
    // Backend policzył zalogowanie na tym samym HTML-u, który dostał, i ma
    // mocniejsze sygnały (cały tekst, login konta) — jego wynik nadpisuje
    // lokalną heurystykę w obie strony.
    if (typeof data.loggedIn === "boolean") {
      state.serverLogin = data.loggedIn ? "in" : "out";
      state.loginAtImport = state.login;
    }
    // Po imporcie towar jest w kolejce, ale kartoteka mogła się nie zmienić —
    // odświeżamy tylko to, co wiemy z odpowiedzi (bez drugiego lookupu).
    if (Array.isArray(data.warnings) && data.warnings.length) {
      toast(data.warnings[0], "err");
    }
    if (mode === "queue") {
      toast("Dodano do kolejki (" + (state.queued || 1) + ")", "ok");
    } else {
      toast("Wysłano — przełączam do Alfa", "ok");
    }
    // Ostrzeżenie na końcu, żeby zostało na wierzchu (toasty rosną w dół).
    if (data.loggedIn === false) {
      toast("Wysłano, ale strona była bez logowania — sprawdź ceny w Alfa", "warn");
    }
    render();
  }

  async function lookup() {
    const res = await send({ type: "alfa-lookup", url: location.href });
    if (res && res.ok) {
      state.lookup = res.data || null;
      if (state.lookup && typeof state.lookup.queued === "number") state.queued = state.lookup.queued;
      state.error = null;
    } else {
      state.lookup = null;
      state.error = (res && res.error) || "Brak połączenia z Alfa";
    }
    render();
  }

  function start() {
    mount();
    lookup();
  }

  // `document_idle` w manifeście nie gwarantuje gotowego `document.body`
  // (Chrome odpala skrypt też przy `readyState === "loading"` na wolnych stronach).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
