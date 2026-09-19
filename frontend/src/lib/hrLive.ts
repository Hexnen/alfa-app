/**
 * KADRY NA ŻYWO — jeden strumień SSE na kartę + klient rezerwacji list.
 *
 * PO CO. Wypłaty i godziny miesiąca wypełnia kilka osób naraz: księgowa wpisuje
 * kwoty, kierownik ochrony godziny, ktoś trzeci zamyka miesiąc. Bez sygnału
 * każde z nich patrzyło na stan sprzed swojego wejścia na stronę i dopisywało
 * do nieaktualnych sum. `GET /api/hr/live` dosyła krótkie „lista X miesiąca Y
 * się zmieniła”, a ekran po nim woła swoje zwykłe zapytania.
 *
 * JEDNO POŁĄCZENIE, WIELU SŁUCHACZY — jak w panelu technika
 * (`frontend/src/technik/lib/live.ts`). Strona Kadr i każdy hook rezerwacji
 * podpinają się pod wspólny emiter; kilka `EventSource` na kartę zjadałoby
 * limit połączeń przeglądarki na origin (6 na HTTP/1.1).
 *
 * WŁASNE ZAPISY POMIJA SERWER: `?client=` to identyfikator TEJ karty
 * (`CLIENT_ID` z lib/api.ts, ten sam, który idzie w nagłówku `X-Alfa-Client`).
 * Karta, która sama zapisała, odświeżyła się już po odpowiedzi API — drugi raz
 * nie musi. Filtrowanie po UŻYTKOWNIKU byłoby błędem: wyciszyłoby drugie okno
 * i telefon tej samej osoby, czyli te przypadki, dla których to powstało.
 *
 * SYGNAŁ NIE NIESIE DANYCH — uprawnienia pilnują zwykłe GET-y, tak jak dotąd.
 */
import { useEffect, useRef } from "react";
import { CLIENT_ID } from "@/lib/api";

/** Zakres zmiany (src/lib/hr-live.ts po stronie backendu). */
export type HrLiveScope =
  | "payroll"
  | "hours"
  | "office"
  | "norms"
  | "month"
  | "dictionary"
  | "locks";

export interface HrLiveChange {
  scope: HrLiveScope;
  /** Okres zmiany; `null` = „nie wiadomo który, odśwież bieżący”. */
  year: number | null;
  month: number | null;
  entityType: string | null;
  entityId: number | null;
  actorUserId: number | null;
  actorClientId: string | null;
  ts: number;
  /**
   * `true` = to nie sygnał z serwera, tylko dociągnięcie stanu po WZNOWIENIU
   * strumienia (restart backendu, uśpiona karta). W przerwie broker niczego nie
   * powtórzy, więc ekran przeładowuje się sam.
   */
  resync?: boolean;
}

type Listener = (change: HrLiveChange) => void;

const listeners = new Set<Listener>();

/** Nasłuch sygnałów. Zwraca funkcję sprzątającą. Sam nie otwiera połączenia. */
export function subscribeHrLive(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(change: HrLiveChange): void {
  for (const cb of [...listeners]) {
    try {
      cb(change);
    } catch (e) {
      // Wyjątek jednego odbiorcy nie ma prawa uciszyć pozostałych.
      console.error("[hr-live] błąd odbiorcy sygnału:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Połączenie
// ---------------------------------------------------------------------------

/** Odstępy ponowień po zerwaniu uznanym przez przeglądarkę za ostateczne. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
/** Ilu odbiorców trzyma połączenie (strona Kadr + hooki rezerwacji). */
let holders = 0;
/** Czy strumień był już gotowy — drugie „ready” to wznowienie, nie start. */
let everReady = false;

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function closeStream(): void {
  clearRetry();
  everReady = false;
  if (source) {
    source.close();
    source = null;
  }
}

function openStream(): void {
  if (typeof window === "undefined" || typeof window.EventSource === "undefined") return;
  if (source) return;
  clearRetry();
  const es = new EventSource(`/api/hr/live?client=${encodeURIComponent(CLIENT_ID)}`, {
    withCredentials: true,
  });
  source = es;
  es.addEventListener("ready", () => {
    attempt = 0;
    if (everReady) {
      // Wznowienie: sygnały z przerwy przepadły (broker w pamięci, bez
      // powtórki) — jedno zbiorcze „przeładuj wszystko”.
      emit({
        scope: "dictionary",
        year: null,
        month: null,
        entityType: null,
        entityId: null,
        actorUserId: null,
        actorClientId: null,
        ts: Date.now(),
        resync: true,
      });
    }
    everReady = true;
  });
  es.addEventListener("hr", (e) => {
    try {
      emit(JSON.parse((e as MessageEvent<string>).data) as HrLiveChange);
    } catch {
      /* uszkodzona ramka — ignoruj, następna i tak przyjdzie */
    }
  });
  es.addEventListener("error", () => {
    // `CONNECTING` = przeglądarka sama wznawia wg `retry:` z serwera; nie
    // wchodzimy jej w drogę. `CLOSED` = poddała się i trzeba otworzyć od nowa.
    if (es.readyState !== EventSource.CLOSED) return;
    if (source === es) source = null;
    es.close();
    if (retryTimer !== null) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (holders > 0) openStream();
    }, wait);
  });
}

/** Ile czekamy z przeładowaniem po sygnale (seria zapisów = jedno odświeżenie). */
export const HR_LIVE_DEBOUNCE_MS = 300;

/**
 * Trzyma połączenie na czas życia ekranu i podaje sygnały do `onChange`
 * (zawsze świeżego, bez przepinania subskrypcji).
 *
 * Powrót z tła otwiera strumień od razu: system potrafi ubić połączenie
 * uśpionej karty, a `EventSource` wznawia dopiero po chwili.
 */
export function useHrLive(onChange: (change: HrLiveChange) => void): void {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  useEffect(() => {
    holders += 1;
    openStream();
    const off = subscribeHrLive((change) => cb.current(change));
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!source) {
        attempt = 0;
        openStream();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      holders -= 1;
      if (holders <= 0) {
        holders = 0;
        closeStream();
      }
    };
  }, []);
}

/** Czy sygnał dotyczy tego miesiąca (pusty okres = „dotyczy wszystkiego”). */
export function hrChangeHitsMonth(
  change: HrLiveChange,
  year: number,
  month: number,
): boolean {
  if (change.year == null || change.month == null) return true;
  return change.year === year && change.month === month;
}

// ---------------------------------------------------------------------------
// Rezerwacja list do edycji (/api/hr/locks/*)
// ---------------------------------------------------------------------------

/** Listy, które da się zarezerwować (src/lib/hr-locks.ts). */
export type HrLockScope = "payroll" | "hours" | "office";

export interface HrLockDto {
  scope: HrLockScope;
  year: number;
  month: number;
  /**
   * `null` = rezerwacja CAŁEJ listy (pełne Kadry); tekst = portal działowy
   * (`hr_departments.portal`), który trzyma wyłącznie wiersze swoich działów.
   */
  portal: string | null;
  /** Nazwa działu portalu („OFI”) — do zdań w interfejsie. */
  portalLabel: string | null;
  userId: number;
  userLabel: string;
  acquiredAt: string;
  expiresAt: string;
  /** Czy trzyma ją zalogowany użytkownik (wtedy front wchodzi w edycję). */
  mine: boolean;
  request: { userId: number | null; label: string; at: string; message: string | null } | null;
}

/** Wszystkie żywe rezerwacje każdej listy miesiąca (z moimi włącznie). */
export type HrLocksByScope = Record<HrLockScope, HrLockDto[]>;

export interface HrLockCall {
  ok: boolean;
  status: number;
  lock: HrLockDto | null;
  error: string | null;
  /** Czy prośba o zwolnienie już poszła (409 z acquire). */
  pending: boolean;
  /**
   * Działy WYŁĄCZONE z udanej rezerwacji całości — trzyma je ktoś inny.
   * Ich wiersze front wyszarza i pozwala poprosić o każdy z osobna.
   */
  excluded: HrLockDto[];
}

/**
 * Wołanie tras rezerwacji SUROWYM `fetch`, a nie przez `request()` z lib/api.
 *
 * `request()` zamienia każdą odpowiedź `success: false` w wyjątek z samym
 * komunikatem, a tutaj najważniejsze jest CIAŁO błędu: 409 niesie właściciela
 * listy i termin rezerwacji, z których front składa pytanie „poprosić
 * o zwolnienie?”. Przepisywanie tego na treść komunikatu byłoby parsowaniem
 * zdania po polsku.
 */
async function lockCall(action: string, body: unknown): Promise<HrLockCall> {
  try {
    const res = await fetch(`/api/hr/locks/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Alfa-Client": CLIENT_ID },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { lock?: HrLockDto | null; pending?: boolean; excluded?: HrLockDto[] };
    };
    return {
      ok: res.ok && json.success === true,
      status: res.status,
      lock: json.data?.lock ?? null,
      error: json.error ?? null,
      pending: json.data?.pending === true,
      excluded: json.data?.excluded ?? [],
    };
  } catch {
    // Brak sieci: rezerwacji nie ma jak wziąć, ale ekran ma dalej działać
    // w podglądzie — dlatego wynik, a nie wyjątek.
    return {
      ok: false,
      status: 0,
      lock: null,
      error: "Brak połączenia z serwerem",
      pending: false,
      excluded: [],
    };
  }
}

/** `portal`: `null` (albo brak) = pełne Kadry, tekst = sekcja działowa. */
export const acquireHrLock = (
  scope: HrLockScope,
  year: number,
  month: number,
  portal: string | null = null,
) => lockCall("acquire", { scope, year, month, portal });

export const heartbeatHrLock = (
  scope: HrLockScope,
  year: number,
  month: number,
  portal: string | null = null,
) => lockCall("heartbeat", { scope, year, month, portal });

export const releaseHrLock = (
  scope: HrLockScope,
  year: number,
  month: number,
  portal: string | null = null,
) => lockCall("release", { scope, year, month, portal });

export const requestHrLockRelease = (
  scope: HrLockScope,
  year: number,
  month: number,
  portal: string | null = null,
  message?: string,
) => lockCall("request-release", { scope, year, month, portal, message });

/**
 * Zwolnienie przy ZAMYKANIU karty. `fetch` z takiego momentu bywa anulowany
 * razem z dokumentem — `sendBeacon` oddaje żądanie przeglądarce i ta wysyła je
 * już po zamknięciu strony. Ciało leci jako `text/plain`: `sendBeacon` nie
 * ustawia nagłówków, a Hono i tak parsuje JSON-a po treści.
 *
 * Gdy beacon jest niedostępny (starsze webview), zostaje zwykły `fetch`
 * z `keepalive` — a w najgorszym razie rezerwacja wygaśnie sama po 15 minutach.
 */
export function releaseHrLockBeacon(
  scope: HrLockScope,
  year: number,
  month: number,
  portal: string | null = null,
): void {
  const body = JSON.stringify({ scope, year, month, portal });
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/hr/locks/release", new Blob([body], { type: "text/plain" }));
      return;
    }
  } catch {
    /* zablokowany beacon — spróbujemy zwykłym fetchem */
  }
  void fetch("/api/hr/locks/release", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Alfa-Client": CLIENT_ID },
    body,
    keepalive: true,
  }).catch(() => {});
}

/** Stan rezerwacji trzech list miesiąca (`GET /api/hr/locks`). */
export async function fetchHrLocks(year: number, month: number): Promise<HrLocksByScope> {
  const empty: HrLocksByScope = { payroll: [], hours: [], office: [] };
  try {
    const res = await fetch(`/api/hr/locks?year=${year}&month=${month}`, {
      headers: { "X-Alfa-Client": CLIENT_ID },
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { locks?: Partial<HrLocksByScope> };
    };
    return { ...empty, ...(json.data?.locks ?? {}) };
  } catch {
    return empty;
  }
}

/** Godzina „do 14:32” z ISO — tak samo, jak liczy ją backend w komunikatach. */
export function lockUntil(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}
