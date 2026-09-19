/**
 * Kadry „na żywo” — broker sygnałów o zmianach dla otwartych kart przeglądarki.
 *
 * PO CO. Wypłaty miesiąca wypełnia księgowa, godziny — kierownik ochrony, a
 * rezerwacje list (`hr_edit_locks`) zmieniają się pod ręką jeszcze komuś
 * innemu. Bez sygnału każda z tych osób widziała stan sprzed swojego wejścia
 * na stronę: dwie sumy miesiąca na dwóch ekranach i „przecież wpisałam”.
 * Broker rozsyła po każdej mutacji krótkie „lista X miesiąca Y się zmieniła”,
 * a front po nim woła swoje `loadMonth({silent:true})`.
 *
 * TO SAMO, CO W KALENDARZU. Wzorzec i pętla SSE są wspólne
 * (`src/lib/calendar-live.ts`, `src/lib/sse-stream.ts`) — tu zmienia się
 * wyłącznie kształt ładunku. Nagłówek karty (`X-Alfa-Client`) i `clientIdOf`
 * bierzemy wprost z kalendarza: front generuje identyfikator raz na załadowanie
 * modułu (`frontend/src/lib/api.ts`), więc obie funkcje muszą czytać dokładnie
 * ten sam nagłówek.
 *
 * SYGNAŁ NIE NIESIE DANYCH — mówi „przeładuj”, a odbiorca woła zwykłe GET-y,
 * które pilnują uprawnień jak dotąd. Dlatego strumień nie filtruje niczego poza
 * własną kartą nadawcy: bramka `tabPermissionGuard` na `/hr/*` już rozstrzygnęła,
 * że słuchający ma prawo oglądać Kadry.
 *
 * ZAKRES: pamięć JEDNEGO procesu (jak kalendarz) — na Dokploy chodzi dokładnie
 * jeden backend. Przy wielu instancjach trzeba by tu wpiąć pub/sub, ale to
 * zmiana wyłącznie w tym pliku.
 *
 * KONTRAKT: `publishHrChange` woła się PO commicie transakcji — inaczej
 * odbiorca zdążyłby przeczytać bazę sprzed zapisu.
 */

/**
 * Co się zmieniło. Front mapuje to na jedno z trzech odświeżeń: miesiąc
 * (`loadMonth`), słowniki (`loadDictionaries`) albo sam stan rezerwacji.
 *
 *  - `payroll` / `hours` / `office` — listy miesiąca (mają też rezerwacje),
 *  - `norms` — normy i święta (wymiar czasu pracy; zmieniają wypłaty),
 *  - `month` — zamknięcie / ponowne otwarcie miesiąca,
 *  - `dictionary` — pracownicy, umowy, obiekty, działy,
 *  - `locks` — wzięcie/zwolnienie/prośba o zwolnienie rezerwacji.
 */
export type HrScope =
  | "payroll"
  | "hours"
  | "office"
  | "norms"
  | "month"
  | "dictionary"
  | "locks";

export interface HrChange {
  scope: HrScope;
  /** Okres, którego dotyczy zmiana; `null` = „nie wiadomo, przeładuj bieżący”. */
  year: number | null;
  month: number | null;
  /** Encja (informacyjnie, do logów) — np. `hr_hours`. */
  entityType: string | null;
  entityId: number | null;
  /** Kto zmienił — informacyjnie. NIE służy do pomijania sygnału. */
  actorUserId: number | null;
  /**
   * KTÓRA KARTA zmieniła (`X-Alfa-Client`). Pomijamy sygnał wyłącznie w niej —
   * ona odświeżyła się już po odpowiedzi API. Filtrowanie po użytkowniku
   * wyciszyłoby drugie okno i telefon tej samej osoby, czyli dokładnie te
   * przypadki, dla których mechanizm powstał.
   */
  actorClientId: string | null;
  /** Znacznik czasu (ms) — id ramki SSE i pomoc przy debugowaniu. */
  ts: number;
}

type Subscriber = (change: HrChange) => void;

const subscribers = new Set<Subscriber>();

/**
 * Rejestruje odbiorcę. Zwraca funkcję odsubskrybowania — MUSI zostać zawołana
 * przy zamknięciu strumienia, inaczej martwe połączenia zostają w Secie.
 */
export function subscribeHrChanges(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Ilu odbiorców słucha (diagnostyka i testy). */
export function hrSubscriberCount(): number {
  return subscribers.size;
}

/** Rozsyła sygnał. Nigdy nie rzuca — publikacja nie może zepsuć zapisu. */
export function publishHrChange(input: {
  scope: HrScope;
  year?: number | null;
  month?: number | null;
  entityType?: string | null;
  entityId?: number | null;
  actorUserId?: number | null;
  actorClientId?: string | null;
}): void {
  if (subscribers.size === 0) return;
  const change: HrChange = {
    scope: input.scope,
    year: Number.isInteger(input.year) ? (input.year as number) : null,
    month: Number.isInteger(input.month) ? (input.month as number) : null,
    entityType: input.entityType ?? null,
    entityId: Number.isInteger(input.entityId) ? (input.entityId as number) : null,
    actorUserId: input.actorUserId ?? null,
    actorClientId: input.actorClientId ?? null,
    ts: Date.now(),
  };
  for (const cb of [...subscribers]) {
    try {
      cb(change);
    } catch (error) {
      console.error("[hr-live] błąd subskrybenta:", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Z jakiej trasy wynika jaki zakres
// ---------------------------------------------------------------------------

/**
 * Zakres sygnału ze ścieżki żądania (`/api/hr/hours/12` → `hours`).
 *
 * DLACZEGO ZE ŚCIEŻKI. Publikacja siedzi w JEDNYM miejscu — w middleware
 * `hrLivePublisher` nad całym routerem Kadr — zamiast w trzydziestu handlerach.
 * Dopisanie kolejnego endpointu zapisu nie wymaga wtedy pamiętania o sygnale
 * (a właśnie o takie zapomnienie najłatwiej: brakuje nie błędu, tylko
 * odświeżenia u kogoś innego).
 */
export function hrScopeFromPath(path: string): HrScope {
  const p = path.replace(/^\/api/, "").replace(/^\/hr/, "");
  if (p.startsWith("/hours")) return "hours";
  if (p.startsWith("/payroll")) return "payroll";
  if (p.startsWith("/office")) return "office";
  if (p.startsWith("/norms") || p.startsWith("/holidays")) return "norms";
  if (p.startsWith("/month-status")) return "month";
  return "dictionary";
}

/**
 * Ścieżki zapisu, po których NIC się nie zmienia, więc nie ma czego rozsyłać:
 *  - `/payroll/preview` liczy podgląd wypłaty i nic nie zapisuje (POST, bo ma
 *    ciało; sygnał kazałby wszystkim przeładować miesiąc przy każdym otwarciu
 *    dialogu),
 *  - `/locks/*` rozsyła własny sygnał `locks` — z etykietą właściciela, której
 *    ogólny publisher nie zna.
 */
export function hrLiveSkipsPath(path: string): boolean {
  const p = path.replace(/^\/api/, "").replace(/^\/hr/, "");
  return p.startsWith("/locks") || p === "/payroll/preview";
}
