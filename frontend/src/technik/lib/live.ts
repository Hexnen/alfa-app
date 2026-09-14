import { useEffect, useRef } from "react";
import { CLIENT_ID } from "@/lib/api";

/**
 * PANEL NA ŻYWO — jeden strumień SSE na cały panel.
 *
 * Technik stoi pod bramą z otwartym ekranem zlecenia, a biuro w tym czasie
 * przesuwa termin albo odwołuje wizytę. Dotąd dowiadywał się o tym dopiero po
 * powrocie fokusu do karty (`lib/refresh.ts`) — czyli często wcale, bo tablet
 * leżał odblokowany na masce. `GET /api/technik/live` dosyła sygnał od razu.
 *
 * JEDNO POŁĄCZENIE, WIELU SŁUCHACZY. `EventSource` otwiera się raz (montowany
 * w `TechnikApp` za bramką konta), a listy, ekran zlecenia i liczniki podpinają
 * się pod wspólny emiter. Kilka `EventSource` na jedną kartę zjadałoby limit
 * połączeń przeglądarki na origin (6 na HTTP/1.1) — i tak już dzielony
 * z zapytaniami panelu.
 *
 * SYGNAŁ NIE NIESIE DANYCH ZLECENIA — jest krótką informacją „to id się
 * zmieniło". Odbiorca po nim woła zwykłe zapytanie panelu, więc uprawnienia
 * i własność zleceń pilnuje backend jak dotąd.
 *
 * WŁASNE ZAPISY POMIJA SERWER: `?client=` to identyfikator TEJ karty
 * (`CLIENT_ID` z lib/api.ts, ten sam, który idzie w nagłówku `X-Alfa-Client`).
 * Karta, która sama coś zapisała, odświeża się po odpowiedzi API — drugi raz
 * nie musi. Inne urządzenia tej samej osoby sygnał dostają.
 */

export type TechnikLiveKind = "updated" | "deleted" | "unassigned" | "notes";

export interface TechnikLiveChange {
  kind: TechnikLiveKind;
  /** Id zleceń objętych zmianą. Puste = „nie wiadomo które, przeładuj listę". */
  ids: number[];
  /** ISO z serwera — do logów; panel i tak reaguje natychmiast. */
  at: string;
}

type Listener = (change: TechnikLiveChange) => void;

const listeners = new Set<Listener>();

/**
 * Nasłuch sygnałów. Zwraca funkcję sprzątającą. Sam w sobie NIE otwiera
 * połączenia — to robi `useTechnikLive` raz, dla całego panelu.
 */
export function subscribeLive(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(change: TechnikLiveChange): void {
  for (const cb of [...listeners]) {
    try {
      cb(change);
    } catch (e) {
      // Wyjątek jednego ekranu nie ma prawa uciszyć pozostałych.
      console.error("[technik-live] błąd odbiorcy sygnału:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Połączenie
// ---------------------------------------------------------------------------

/**
 * Odstępy ponowień po zerwaniu, które przeglądarka uznała za ostateczne
 * (readyState CLOSED — np. 401 po wygaśnięciu sesji albo restart backendu).
 * Ostatni odstęp się powtarza: tablet w terenie potrafi nie mieć zasięgu
 * godzinami i nie ma sensu stukać do serwera co sekundę.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function closeStream(): void {
  clearRetry();
  if (source) {
    source.close();
    source = null;
  }
}

function openStream(): void {
  if (typeof window === "undefined" || typeof window.EventSource === "undefined") return;
  if (source) return;
  clearRetry();
  const es = new EventSource(`/api/technik/live?client=${encodeURIComponent(CLIENT_ID)}`, {
    withCredentials: true,
  });
  source = es;
  es.addEventListener("ready", () => {
    // Serwer się odezwał — następne zerwanie liczymy od najkrótszego odstępu.
    attempt = 0;
  });
  es.addEventListener("technik", (e) => {
    try {
      emit(JSON.parse((e as MessageEvent<string>).data) as TechnikLiveChange);
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
      openStream();
    }, wait);
  });
}

/**
 * Trzyma połączenie przy życiu na czas życia panelu. Wołane RAZ, w `TechnikApp`
 * (za bramką konta i dostępu) — `enabled: false` zamyka strumień, więc wylogowanie
 * albo odebranie dostępu nie zostawia wiszącego `EventSource`.
 */
export function useTechnikLive(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    openStream();
    // Powrót z tła bywa momentem, w którym połączenie od dawna nie żyje (system
    // ubija strumienie uśpionej karty). Jeśli nic nie stoi — otwieramy od razu,
    // bez czekania na backoff.
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
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      closeStream();
    };
  }, [enabled]);
}

// ---------------------------------------------------------------------------
// Haki dla ekranów
// ---------------------------------------------------------------------------

/** Nasłuch sygnałów z zawsze świeżym callbackiem (bez przepinania subskrypcji). */
export function useLiveChanges(handler: Listener): void {
  const cb = useRef(handler);
  useEffect(() => {
    cb.current = handler;
  });
  useEffect(() => subscribeLive((change) => cb.current(change)), []);
}

/**
 * Ile czekamy z przeładowaniem po sygnale. Jedna operacja w biurze (zmiana
 * terminu + ekipy + notatka) potrafi wypuścić kilka sygnałów w ułamku sekundy —
 * bez tego panel strzelałby o nie po zapytaniu każdy.
 */
export const LIVE_DEBOUNCE_MS = 300;

/**
 * Przeładowanie po sygnale, z debouncem. `wants` decyduje, czy dany sygnał
 * w ogóle dotyczy tego ekranu (np. czy id jest na bieżącej liście).
 */
export function useLiveReload(reload: () => void, wants: (change: TechnikLiveChange) => boolean): void {
  const reloadRef = useRef(reload);
  const wantsRef = useRef(wants);
  useEffect(() => {
    reloadRef.current = reload;
    wantsRef.current = wants;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = subscribeLive((change) => {
      if (!wantsRef.current(change)) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        reloadRef.current();
      }, LIVE_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
}

/** Czy sygnał dotyczy tego id (pusta lista = „dotyczy wszystkiego"). */
export function hits(change: TechnikLiveChange, id: number | null): boolean {
  if (id == null) return false;
  return change.ids.length === 0 || change.ids.includes(id);
}

/** Czy sygnał dotyczy któregokolwiek z id (pusta lista = „dotyczy wszystkiego"). */
export function hitsAny(change: TechnikLiveChange, ids: readonly number[]): boolean {
  if (change.ids.length === 0) return true;
  return change.ids.some((id) => ids.includes(id));
}

/** Zmiany, po których zlecenie znika z listy technika — zawsze warte przeładowania. */
export function isRemoval(change: TechnikLiveChange): boolean {
  return change.kind === "deleted" || change.kind === "unassigned";
}
