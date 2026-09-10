/**
 * Service worker wtyczki — JEDYNE miejsce z `fetch`.
 *
 * DLACZEGO cały ruch idzie przez service worker, a nie z content scriptu:
 * żądanie z content scriptu leci w kontekście strony sklepu, więc podlega CORS
 * (backend Alfa nie ma i nie chce mieć nagłówków CORS dla samal.pl). Żądanie
 * z service workera MV3 do hosta wymienionego w `host_permissions` CORS-owi nie
 * podlega — dlatego panel tylko wysyła `chrome.runtime.sendMessage`, a fetch
 * robi ten plik. Drugi powód: token jest tu, a nie w drzewie strony sklepu.
 */
importScripts("config.js");

/** Timeout żądań — po 20 s wolimy uczciwy błąd niż wiszący spinner w panelu. */
const REQUEST_TIMEOUT_MS = 20000;
/** Ile czekamy na odpowiedź content scriptu Alfa, zanim przeładujemy kartę. */
const PING_TIMEOUT_MS = 800;

function cfg() {
  return self.ALFA_CONFIG || {};
}

function apiUrl(path) {
  const base = String(cfg().apiBase || "").replace(/\/+$/, "");
  return base + path;
}

/**
 * Ustandaryzowana odpowiedź do content scriptu: `{ok:true,data}` albo
 * `{ok:false,status,error}`. DLACZEGO nie rzucamy wyjątków: `sendMessage` gubi
 * stack, a panel musi umieć pokazać różnicę między 401 (zła paczka), 403 (brak
 * uprawnień), 429 (limit) i brakiem sieci.
 */
async function apiFetch(path, init) {
  const token = cfg().token;
  if (!token) {
    return { ok: false, status: 401, error: "Wtyczka nieautoryzowana — pobierz nową paczkę z Magazynu" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(path), {
      ...(init || {}),
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...((init && init.headers) || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: errorMessage(res.status, body) };
    }
    // API Alfa owija odpowiedzi w { success, data } — rozpakowujemy tutaj,
    // żeby reszta wtyczki widziała gołe pola (queued, openUrl, item…).
    return {
      ok: true,
      data: body && typeof body === "object" && "data" in body ? body.data : body,
    };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || String(err).includes("aborted"));
    return {
      ok: false,
      status: 0,
      error: aborted
        ? "Przekroczono czas oczekiwania na Alfa (20 s)"
        : "Brak połączenia z Alfa — sprawdź, czy aplikacja działa",
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(status, body) {
  const fromBody = body && typeof body.error === "string" ? body.error : "";
  if (status === 401) return "Wtyczka nieautoryzowana — pobierz nową paczkę z Magazynu";
  if (status === 403) return fromBody || "Brak uprawnień do magazynu w Alfa";
  if (status === 429) return fromBody || "Za dużo żądań — odczekaj chwilę";
  if (status === 413) return fromBody || "Strona za duża dla Alfa";
  return fromBody || "Błąd Alfa (" + status + ")";
}

/* ---------------------------------- badge ---------------------------------- */

/** Licznik kolejki na ikonie — jedyna informacja widoczna poza stroną sklepu. */
function setBadge(queued) {
  const n = Number(queued);
  const text = Number.isFinite(n) && n > 0 ? String(n) : "";
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#1e3a8a" });
    chrome.action.setBadgeText({ text });
  } catch {
    /* brak uprawnienia do action w starszym Chrome — badge to tylko ozdoba */
  }
}

function badgeFrom(data) {
  if (data && typeof data.queued === "number") setBadge(data.queued);
}

async function refreshBadge() {
  const res = await apiFetch("/plugin/queue-count", { method: "GET" });
  if (res.ok) badgeFrom(res.data);
  else setBadge(0);
}

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
});
chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});

/* -------------------------------- wiadomości ------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  if (msg.type === "alfa-lookup") {
    handleLookup(msg).then(sendResponse);
    return true; // odpowiedź asynchroniczna — bez `true` kanał zamknie się od razu
  }
  if (msg.type === "alfa-import") {
    handleImport(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "alfa-me") {
    handleMe().then(sendResponse);
    return true;
  }
  return undefined;
});

async function handleLookup(msg) {
  const url = String(msg.url || "");
  const res = await apiFetch("/plugin/lookup?url=" + encodeURIComponent(url), { method: "GET" });
  if (res.ok) badgeFrom(res.data);
  return res;
}

async function handleMe() {
  const res = await apiFetch("/plugin/me", { method: "GET" });
  if (res.ok) badgeFrom(res.data);
  return res;
}

async function handleImport(msg) {
  const mode = msg.mode === "open" ? "open" : "queue";
  const payload = {
    html: String(msg.html || ""),
    url: String(msg.url || ""),
    title: typeof msg.title === "string" ? msg.title : undefined,
    mode,
  };
  const res = await apiFetch("/plugin/import", { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) return res;
  badgeFrom(res.data);
  if (mode === "open") {
    // Przełączenie karty to efekt uboczny — błąd nie może zepsuć odpowiedzi,
    // bo wiersz w kolejce już powstał i użytkownik go nie straci.
    try {
      await focusAlfaTab(res.data);
    } catch {
      /* nic — panel i tak powie „Wysłano” */
    }
  }
  return res;
}

/* ------------------------------ karta aplikacji ---------------------------- */

function alfaOrigin() {
  try {
    return new URL(cfg().baseUrl || "").origin;
  } catch {
    return "";
  }
}

/**
 * Znajdź otwartą kartę Alfa i obudź w niej panel importu.
 *
 * DLACZEGO nie zawsze `tabs.create`: użytkownik pracuje w jednej karcie Alfa
 * i chce do niej wrócić, a nie zbierać kopie. Kolejność: karta na
 * /technical/magazyn → dowolna karta Alfa → nowa karta.
 * DLACZEGO ping z timeoutem: karta może być stara (bez content scriptu po
 * przeładowaniu wtyczki) albo mieć zawieszony JS — wtedy wiadomość nigdy nie
 * dojdzie i trzeba po prostu wejść na `openUrl`.
 */
async function focusAlfaTab(data) {
  const origin = alfaOrigin();
  const openUrl = (data && data.openUrl) || origin + "/technical/magazyn";
  const id = data && data.id;
  if (!origin) {
    await chrome.tabs.create({ url: openUrl, active: true });
    return;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: origin + "/*" });
  } catch {
    tabs = [];
  }
  if (!tabs.length) {
    await chrome.tabs.create({ url: openUrl, active: true });
    return;
  }

  const preferred = tabs.find((t) => (t.url || "").includes("/technical/magazyn")) || tabs[0];
  try {
    await chrome.tabs.update(preferred.id, { active: true });
    if (typeof preferred.windowId === "number") {
      await chrome.windows.update(preferred.windowId, { focused: true });
    }
  } catch {
    /* karta mogła zniknąć między query i update */
  }

  const delivered = await pingTab(preferred.id, id);
  if (!delivered) {
    // Fallback: nawigacja na openUrl (?import=<id>) — front sam otworzy panel.
    try {
      await chrome.tabs.update(preferred.id, { url: openUrl, active: true });
    } catch {
      await chrome.tabs.create({ url: openUrl, active: true });
    }
  }
}

function pingTab(tabId, id) {
  const send = new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "alfa-import-open", id }, (resp) => {
        // `lastError` trzeba odczytać, inaczej Chrome loguje nieobsłużony błąd.
        const failed = chrome.runtime.lastError;
        resolve(!failed && !!resp && resp.ok === true);
      });
    } catch {
      resolve(false);
    }
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), PING_TIMEOUT_MS));
  return Promise.race([send, timeout]);
}
