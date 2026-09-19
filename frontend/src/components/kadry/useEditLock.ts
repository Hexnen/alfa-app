/**
 * REZERWACJA LISTY DO EDYCJI — stan jednej blokady (`payroll`, `hours`, `office`)
 * dla jednego miesiąca.
 *
 * PO CO. Wpisywanie kwot z kartki od księgowości trwa pół godziny i dotyka tych
 * samych komórek, co robota kogoś obok. Konflikt wersji pojedynczego wiersza
 * (409 „ktoś zmienił, odśwież”) tego nie łapie: każdy zapis z osobna jest
 * poprawny, a wynikiem i tak są kwoty po dwóch osobach. Przełącznik
 * „Podgląd → Edycja” bierze więc listę na 15 minut (`/api/hr/locks/*`),
 * a pozostali widzą właściciela i mogą poprosić o zwolnienie.
 *
 * REZERWACJA JEST CZĘŚCIOWA. Kadry mają sekcje działowe („portale”): OFI
 * wypełnia swoje godziny, CMA swoje, a pełne Kadry domykają całość. Dlatego:
 *  - portal rezerwuje WYŁĄCZNIE wiersze swoich działów,
 *  - pełne Kadry biorą całość Z WYŁĄCZENIEM działów zajętych przez portale
 *    (`excluded`) — te wiersze tabela wyszarza, a o każdy wolno poprosić osobno,
 *  - „lista zajęta” (dialog) zostaje tylko wtedy, gdy nie da się edytować nic.
 *
 * CO TEN HOOK TRZYMA:
 *  - stan rezerwacji z serwera (odświeżany sygnałem SSE `locks`, nie odpytywaniem),
 *  - heartbeat co 60 s, gdy jesteśmy w trybie edycji (inaczej rezerwacja
 *    wygasłaby pod ręką piszącego),
 *  - zwolnienie przy wyjściu: zmiana miesiąca, odmontowanie i zamknięcie karty
 *    (`sendBeacon`) — bez tego lista stałaby zajęta do wygaśnięcia,
 *  - `ensure()` dla zapisów z PODGLĄDU (dialog pojedynczego wiersza): bierze
 *    listę na czas zapisu i oddaje ją po chwili bezczynności.
 *
 * Czego NIE robi: nie rysuje niczego. Pasek właściciela, baner prośby i okno
 * konfliktu siedzą w `EditLockBar.tsx`, który dostaje ten stan w propsie.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acquireHrLock,
  fetchHrLocks,
  heartbeatHrLock,
  hrChangeHitsMonth,
  releaseHrLock,
  releaseHrLockBeacon,
  requestHrLockRelease,
  subscribeHrLive,
  type HrLockDto,
  type HrLockScope,
} from "@/lib/hrLive";

/** Co 60 s przedłużamy rezerwację — serwer daje 15 minut od ostatniego ruchu. */
const HEARTBEAT_MS = 60_000;

/**
 * Po tylu ms bezczynności oddajemy listę wziętą „na jeden zapis” z podglądu.
 * Dość, żeby poprawić dwa wiersze pod rząd bez puszczania i brania od nowa,
 * i za mało, by ktoś obok czekał przez pomyłkę.
 */
const TRANSIENT_RELEASE_MS = 30_000;

export interface HrLockConflict {
  label: string;
  expiresAt: string;
  /** Prośba o zwolnienie już poszła — nie proponujemy jej drugi raz. */
  pending: boolean;
  /** Czego dotyczy prośba: `null` = cała lista, tekst = portal działu. */
  portal: string | null;
  /** Nazwa działu do zdania („…wiersze działu OFI edytuje…”). */
  portalLabel: string | null;
}

export interface HrEditLock {
  scope: HrLockScope;
  year: number;
  month: number;
  /** Portal, w imieniu którego rezerwujemy (`null` = pełne Kadry). */
  portal: string | null;
  /** MOJA rezerwacja (albo `null`) — jedyny warunek, przy którym wolno pisać. */
  lock: HrLockDto | null;
  mine: boolean;
  /** Cudza rezerwacja blokująca mnie — do pigułki „Edytuje: Jan K. do 14:32”. */
  holder: { label: string; expiresAt: string } | null;
  /** Prośba o zwolnienie skierowana DO NAS (gdy `mine`). */
  request: HrLockDto["request"];
  /** Działy wyłączone z mojej rezerwacji (trzyma je ktoś inny). */
  excluded: HrLockDto[];
  /**
   * Rezerwacja obejmująca wiersz danego działu, jeśli trzyma go KTOŚ INNY —
   * tabela wyszarza po tym wiersze i tłumaczy w dymku dlaczego.
   */
  lockedBy: (portal: string | null | undefined) => HrLockDto | null;
  /** Czekamy, aż właściciel zwolni listę (po wysłanej prośbie). */
  waiting: boolean;
  /**
   * Licznik „dostaliśmy listę po czekaniu". Rośnie, gdy rezerwacja przyszła
   * SAMA (właściciel zwolnił, a my czekaliśmy) — ekran po tym włącza tryb
   * edycji. Zwykłe `enable()` go NIE rusza: tam tryb ustawia klikający.
   */
  granted: number;
  busy: boolean;
  /** Ostatni błąd rezerwacji (np. brak sieci) — pokazuje pasek. */
  error: string | null;
  /** Otwarte okno „Poprosić o zwolnienie?”. */
  conflict: HrLockConflict | null;
  /**
   * „Podgląd → Edycja”: bierze listę. `false` = nie udało się (jest konflikt).
   * `silent` pomija okno konfliktu — używa go wejście na stronę z zapamiętaną
   * preferencją „Edycja”: nikt nie klikał, więc nie ma komu odpowiadać na
   * pytanie „poprosić o zwolnienie?”.
   */
  enable: (silent?: boolean) => Promise<boolean>;
  /** „Edycja → Podgląd”: oddaje listę. */
  disable: () => Promise<void>;
  /**
   * Przed pojedynczym zapisem z podglądu — bierze listę na czas zapisu.
   * `silent` (zapisy automatyczne, np. przeniesienie z poprzedniego miesiąca)
   * pomija okno konfliktu: nikt tego zapisu nie zlecił świadomie.
   */
  ensure: (silent?: boolean) => Promise<boolean>;
  /** „Jeszcze 15 minut” z banera prośby. */
  extend: () => Promise<void>;
  /** Otwiera okno prośby o zwolnienie konkretnego działu (klik w zajęty wiersz). */
  askFor: (portal: string | null | undefined) => void;
  /** Wysyła prośbę o zwolnienie (z okna konfliktu). */
  askRelease: (message?: string) => Promise<void>;
  /** Zamyka okno konfliktu bez wysyłania prośby. */
  dismissConflict: () => void;
  /** Rezygnacja z czekania na zwolnienie. */
  cancelWaiting: () => void;
}

export function useEditLock(opts: {
  scope: HrLockScope;
  year: number;
  month: number;
  /** Czy użytkownik ma w ogóle prawo edycji (bez tego tylko podgląd stanu). */
  enabled: boolean;
  /**
   * Portal, w imieniu którego rezerwujemy. `null`/brak = pełne Kadry (całość).
   * Sekcje działowe podadzą tu swój `hr_departments.portal`.
   */
  portal?: string | null;
  /** Dostaliśmy listę po czekaniu — ekran ma się przełączyć w tryb edycji. */
  onGranted?: () => void;
}): HrEditLock {
  const { scope, year, month, enabled, onGranted } = opts;
  const portal = opts.portal ?? null;
  /** Wszystkie żywe rezerwacje tej listy — z moją i cudzymi działowymi. */
  const [locks, setLocks] = useState<HrLockDto[]>([]);
  const [conflict, setConflict] = useState<HrLockConflict | null>(null);
  const [waiting, setWaiting] = useState(false);
  /** Ile razy lista przyszła sama po czekaniu (patrz `granted` w wyniku). */
  const [granted, setGranted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Czy TA karta trzyma rezerwację — decyduje o zwolnieniu przy wyjściu. */
  const heldRef = useRef(false);
  /** Czy jesteśmy w trybie edycji (heartbeat leci tylko wtedy). */
  const editingRef = useRef(false);
  /** Odliczanie oddania listy wziętej na jeden zapis z podglądu. */
  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grantedRef = useRef(onGranted);
  useEffect(() => {
    grantedRef.current = onGranted;
  });

  const clearTransient = () => {
    if (transientTimer.current !== null) {
      clearTimeout(transientTimer.current);
      transientTimer.current = null;
    }
  };

  const applyLocks = useCallback(
    (rows: HrLockDto[]) => {
      setLocks(rows);
      const mine = rows.find((l) => l.mine && l.portal === portal) ?? null;
      heldRef.current = mine != null;
      if (!mine) editingRef.current = false;
    },
    [portal],
  );

  const refresh = useCallback(async () => {
    const all = await fetchHrLocks(year, month);
    applyLocks(all[scope] ?? []);
  }, [scope, year, month, applyLocks]);

  // --- co wynika ze stanu ----------------------------------------------------

  const lock = useMemo(
    () => locks.find((l) => l.mine && l.portal === portal) ?? null,
    [locks, portal],
  );
  const mine = lock != null;
  /** Rezerwacja, która mnie blokuje: cudza całość albo cudzy mój portal. */
  const blocking = useMemo(
    () =>
      locks.find((l) => !l.mine && l.portal === null) ??
      locks.find((l) => !l.mine && l.portal === portal) ??
      null,
    [locks, portal],
  );
  /** Cudze rezerwacje działowe — wyłączone z mojej całości. */
  const excluded = useMemo(
    () => locks.filter((l) => !l.mine && l.portal !== null && l.portal !== portal),
    [locks, portal],
  );

  const lockedBy = useCallback(
    (rowPortal: string | null | undefined) => {
      // Wiersz bez działu należy do całości: blokuje go tylko cudza całość.
      const p = rowPortal ?? null;
      return (
        locks.find((l) => !l.mine && l.portal === p && p !== null) ??
        locks.find((l) => !l.mine && l.portal === null) ??
        null
      );
    },
    [locks],
  );

  // --- wzięcie listy ---------------------------------------------------------

  const conflictOf = (l: HrLockDto, pending: boolean): HrLockConflict => ({
    label: l.userLabel,
    expiresAt: l.expiresAt,
    pending,
    portal: l.portal,
    portalLabel: l.portalLabel,
  });

  /** Wspólny środek `enable`/`ensure`: `silent` nie otwiera okna konfliktu. */
  const take = useCallback(
    async (silent: boolean): Promise<boolean> => {
      if (!enabled) return false;
      setBusy(true);
      try {
        const res = await acquireHrLock(scope, year, month, portal);
        if (res.ok) {
          // Po udanym wzięciu i tak czytamy pełny stan: `excluded` z odpowiedzi
          // mówi o działach, ale pasek i wyszarzenia biorą się z listy rezerwacji.
          await refresh();
          setConflict(null);
          setWaiting(false);
          setError(null);
          return true;
        }
        if (res.status === 409 && res.lock) {
          await refresh();
          if (!silent) setConflict(conflictOf(res.lock, res.pending));
          return false;
        }
        setError(res.error ?? "Nie udało się zarezerwować listy");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [enabled, scope, year, month, portal, refresh],
  );

  const enable = useCallback(
    async (silent = false) => {
      clearTransient();
      const ok = await take(silent);
      editingRef.current = ok;
      return ok;
    },
    [take],
  );

  const disable = useCallback(async () => {
    clearTransient();
    editingRef.current = false;
    setWaiting(false);
    if (!heldRef.current) return;
    heldRef.current = false;
    await releaseHrLock(scope, year, month, portal);
    await refresh();
  }, [scope, year, month, portal, refresh]);

  /**
   * Zapis z PODGLĄDU (dialog wiersza, wklejka kwot, przeniesienie z poprzedniego
   * miesiąca). Bierze listę, jeśli jej nie mamy, i oddaje ją po chwili — w trybie
   * edycji nie oddaje niczego, bo tam rezerwacja jest świadoma i trwa.
   */
  const ensure = useCallback(
    async (silent = false) => {
      if (!enabled) return false;
      const ok = mine ? true : await take(silent);
      if (!ok) return false;
      if (!editingRef.current) {
        clearTransient();
        transientTimer.current = setTimeout(() => {
          transientTimer.current = null;
          if (editingRef.current || !heldRef.current) return;
          heldRef.current = false;
          void releaseHrLock(scope, year, month, portal).then(() => refresh());
        }, TRANSIENT_RELEASE_MS);
      }
      return true;
    },
    [enabled, mine, take, scope, year, month, portal, refresh],
  );

  const extend = useCallback(async () => {
    const res = await heartbeatHrLock(scope, year, month, portal);
    if (!res.ok) setError(res.error);
    await refresh();
  }, [scope, year, month, portal, refresh]);

  /** Klik w zajęty wiersz (albo w pigułkę) — pytanie o zwolnienie TEGO działu. */
  const askFor = useCallback(
    (rowPortal: string | null | undefined) => {
      const blocker = lockedBy(rowPortal) ?? blocking;
      if (!blocker) return;
      setConflict(conflictOf(blocker, blocker.request != null));
    },
    [lockedBy, blocking],
  );

  const askRelease = useCallback(
    async (message?: string) => {
      const target = conflict?.portal ?? blocking?.portal ?? null;
      setBusy(true);
      try {
        const res = await requestHrLockRelease(scope, year, month, target, message);
        setConflict(null);
        await refresh();
        if (res.ok && res.lock === null) {
          // Właściciel zdążył zwolnić listę — bierzemy ją od razu.
          const got = await take(true);
          if (got) {
            setGranted((n) => n + 1);
            grantedRef.current?.();
          }
          return;
        }
        // Od tej chwili czekamy: zwolnienie przyjdzie sygnałem `locks`.
        // Czekamy tylko na to, co blokuje NAS (cudzy dział wyszarza wiersze,
        // ale nie zatrzymuje edycji reszty listy).
        if (target === null || target === portal) setWaiting(true);
        if (!res.ok && res.status !== 429) {
          setError(res.error ?? "Nie udało się wysłać prośby");
        }
      } finally {
        setBusy(false);
      }
    },
    [conflict?.portal, blocking?.portal, scope, year, month, portal, refresh, take],
  );

  // --- stan z serwera --------------------------------------------------------

  // Pierwsze wczytanie stanu + zmiana miesiąca. Samo wejście na stronę NIE
  // bierze listy: zapamiętaną preferencję „Edycja” odtwarza ekran, wołając
  // `enable(true)` — po cichu, bo nikt nie klikał i nie ma komu odpowiadać na
  // pytanie „poprosić o zwolnienie?”.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const all = await fetchHrLocks(year, month);
      if (alive) applyLocks(all[scope] ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [scope, year, month, applyLocks]);

  // Sygnał `locks` — ktoś wziął albo zwolnił listę, ktoś poprosił o zwolnienie.
  useEffect(() => {
    return subscribeHrLive((change) => {
      if (change.scope !== "locks" && !change.resync) return;
      if (!hrChangeHitsMonth(change, year, month)) return;
      void refresh();
    });
  }, [year, month, refresh]);

  // Czekanie na zwolnienie: gdy to, co nas blokowało, znika — bierzemy listę
  // i mówimy o tym ekranowi (przełącznik sam wchodzi w tryb edycji).
  useEffect(() => {
    if (!waiting || mine || blocking !== null) return;
    let alive = true;
    void (async () => {
      const ok = await take(true);
      if (!alive) return;
      if (ok) {
        editingRef.current = true;
        setWaiting(false);
        setGranted((n) => n + 1);
        grantedRef.current?.();
      }
    })();
    return () => {
      alive = false;
    };
  }, [waiting, mine, blocking, take]);

  // Heartbeat tylko w trybie edycji — rezerwacja ma przeżyć wpisywanie kwot,
  // ale nie ma prawa trwać wiecznie po zostawieniu karty w podglądzie.
  useEffect(() => {
    if (!mine) return;
    const timer = setInterval(() => {
      if (!editingRef.current || !heldRef.current) return;
      void heartbeatHrLock(scope, year, month, portal).then((res) => {
        if (!res.ok) void refresh();
        else setLocks((prev) => prev.map((l) => (l.mine && l.portal === portal && res.lock ? res.lock : l)));
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [mine, scope, year, month, portal, refresh]);

  // Wyjście: zmiana miesiąca, odmontowanie i zamknięcie karty. Bez tego lista
  // zostaje zajęta do wygaśnięcia, a ktoś obok patrzy na „edytuje Jan” przy
  // pustym biurku.
  useEffect(() => {
    const onPageHide = () => {
      if (heldRef.current) releaseHrLockBeacon(scope, year, month, portal);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      clearTransient();
      if (heldRef.current) {
        heldRef.current = false;
        editingRef.current = false;
        void releaseHrLock(scope, year, month, portal);
      }
    };
  }, [scope, year, month, portal]);

  return {
    scope,
    year,
    month,
    portal,
    lock,
    mine,
    holder: blocking ? { label: blocking.userLabel, expiresAt: blocking.expiresAt } : null,
    request: lock?.request ?? null,
    excluded,
    lockedBy,
    waiting,
    granted,
    busy,
    error,
    conflict,
    enable,
    disable,
    ensure,
    extend,
    askFor,
    askRelease,
    dismissConflict: () => setConflict(null),
    cancelWaiting: () => setWaiting(false),
  };
}
