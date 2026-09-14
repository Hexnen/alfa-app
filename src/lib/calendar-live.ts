/**
 * Kalendarz „na żywo" — broker sygnałów o zmianach dla otwartych kart przeglądarki.
 *
 * PO CO. Dwie osoby patrzące na ten sam kalendarz nie widziały nawzajem swoich zmian
 * do czasu przeładowania strony (F5) albo zmiany zakresu. Broker rozsyła po każdej
 * mutacji krótki sygnał „kalendarz działu X się zmienił", a front po nim woła swoje
 * `loadEvents()` — NIE przesyłamy tu treści wydarzeń, więc nie ma czego autoryzować
 * poza działem (uprawnienia wierszowe i tak pilnuje GET /calendar/events).
 *
 * ZAKRES: pamięć JEDNEGO procesu. Na Dokploy chodzi dokładnie jeden proces backendu
 * (patrz Dockerfile / MEMORY dokploy-deploy), więc Set subskrybentów wystarcza; przy
 * wielu instancjach trzeba by tu wpiąć Redis/pub-sub, ale to zmiana wyłącznie w tym pliku.
 *
 * KONTRAKT: `publishCalendarChange` woła się PO commicie transakcji (nie w środku) —
 * inaczej subskrybent zdążyłby przeczytać bazę sprzed zapisu. Wyjątek subskrybenta
 * nigdy nie może wywrócić trasy, która publikuje, więc każdy callback jest w try/catch.
 */
import type { Context } from "hono";
import type { CalendarDepartment } from "../db/schema.js";

/**
 * Nagłówek z identyfikatorem KARTY przeglądarki (nie użytkownika) — front generuje go
 * raz na załadowanie modułu (`frontend/src/lib/api.ts`) i dokłada do każdego żądania.
 *
 * PO CO KARTA, A NIE UŻYTKOWNIK. Filtrowanie po `actorUserId` gasiło odświeżanie
 * w DRUGIEJ karcie i na drugim urządzeniu tej samej osoby — a to jest dokładnie ten
 * przypadek, dla którego mechanizm powstał. Pomijamy więc wyłącznie tę jedną kartę,
 * która sama zrobiła zapis i sama po sobie zawołała `loadEvents()`.
 */
export const CLIENT_ID_HEADER = "X-Alfa-Client";

/** Identyfikator karty z nagłówka żądania (obcięty — to tylko klucz porównania). */
export function clientIdOf(c: Context): string | null {
  const raw = c.req.header(CLIENT_ID_HEADER);
  const trimmed = typeof raw === "string" ? raw.trim().slice(0, 64) : "";
  return trimmed || null;
}

/** Rodzaj zmiany — front i tak przeładowuje listę, `kind` służy do logów i komunikatu. */
export type CalendarChangeKind =
  | "created"
  | "updated"
  | "moved"
  | "deleted"
  | "restored"
  | "notes";

export interface CalendarChange {
  /** Dział, którego dotyczy zmiana (`calendar_events.department`). */
  department: CalendarDepartment;
  kind: CalendarChangeKind;
  /** Id wydarzeń objętych zmianą (może być puste — sygnał „przeładuj"). */
  ids: number[];
  /** Kto zmienił (informacyjnie — do logów i ewentualnej etykiety w UI). */
  actorUserId: number | null;
  /**
   * KTÓRA KARTA zmieniła (nagłówek `X-Alfa-Client`). Po tym front pomija sygnał:
   * karta, która sama zapisała, odświeża się od razu po odpowiedzi API. Inne karty
   * tej samej osoby MAJĄ dostać sygnał, więc filtrowanie po użytkowniku byłoby błędem.
   * `null` = zapis spoza przeglądarki (skrypt, integracja) — wtedy nikt nie pomija.
   */
  actorClientId: string | null;
  /**
   * Technicy, którzy byli przypisani do tych wydarzeń PRZED zmianą.
   *
   * PO CO. Panel technika filtruje sygnały po przypisaniu (`calendar_event_assignees`),
   * a przy odpięciu technika wiersz przypisania już nie istnieje — bez tej listy
   * „biuro zdjęło Cię ze zlecenia" nie miałoby jak dojść do tego, kogo dotyczy.
   * Wypełnia ją `rememberEventTechnicians` wołane z mutacji (src/lib/calendar-mutations.ts)
   * TUŻ przed skasowaniem przypisań. Dla kalendarza CRM pole jest bez znaczenia.
   */
  technicianIds: number[];
  /** Znacznik czasu (ms) — id zdarzenia SSE i pomoc przy debugowaniu. */
  ts: number;
}

/**
 * PAMIĘĆ „KTO BYŁ PRZYPISANY" — krótkotrwała, wyłącznie na potrzeby publikacji.
 *
 * Mutacja kasuje wiersz z `calendar_event_assignees`, a sygnał leci dopiero PO
 * commicie transakcji — w tej chwili z bazy nie da się już odczytać, kogo zmiana
 * dotyczyła. Mutacja odkłada więc listę tutaj, a `publishCalendarChange` dokleja ją
 * do ładunku. Wpisy przeterminowane (`REMEMBER_TTL_MS`) są sprzątane przy każdym
 * zapisie: gdyby transakcja się wycofała, najgorsze, co się stanie, to jeden zbędny
 * sygnał „odświeź listę" u technika.
 */
const REMEMBER_TTL_MS = 60_000;
const rememberedTechnicians = new Map<number, { ids: number[]; ts: number }>();

/** Zapamiętuje przypisania wydarzenia sprzed zmiany (wołane Z WNĘTRZA transakcji). */
export function rememberEventTechnicians(eventId: number, technicianIds: readonly number[]): void {
  if (!Number.isInteger(eventId)) return;
  const now = Date.now();
  for (const [id, entry] of rememberedTechnicians) {
    if (now - entry.ts > REMEMBER_TTL_MS) rememberedTechnicians.delete(id);
  }
  const prev = rememberedTechnicians.get(eventId);
  const ids = new Set<number>(prev && now - prev.ts <= REMEMBER_TTL_MS ? prev.ids : []);
  for (const t of technicianIds) if (Number.isInteger(t)) ids.add(t);
  rememberedTechnicians.set(eventId, { ids: [...ids], ts: now });
}

/** Zdejmuje i zwraca zapamiętane przypisania dla listy wydarzeń. */
function takeRememberedTechnicians(eventIds: readonly number[]): number[] {
  const out = new Set<number>();
  const now = Date.now();
  for (const id of eventIds) {
    const entry = rememberedTechnicians.get(id);
    if (!entry) continue;
    rememberedTechnicians.delete(id);
    if (now - entry.ts > REMEMBER_TTL_MS) continue;
    for (const t of entry.ids) out.add(t);
  }
  return [...out];
}

type Subscriber = (change: CalendarChange) => void;

const subscribers = new Set<Subscriber>();

/**
 * Rejestruje odbiorcę zmian. Zwraca funkcję odsubskrybowania — MUSI być zawołana
 * przy zamknięciu połączenia, inaczej zamknięte strumienie zostają w Secie na zawsze.
 */
export function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Ilu odbiorców słucha (diagnostyka i testy). */
export function subscriberCount(): number {
  return subscribers.size;
}

/** Rozsyła sygnał o zmianie. Nigdy nie rzuca — publikacja nie może zepsuć zapisu. */
export function publishCalendarChange(input: {
  department: CalendarDepartment;
  kind: CalendarChangeKind;
  eventIds?: readonly (number | null | undefined)[];
  actorUserId?: number | null;
  actorClientId?: string | null;
  /** Dodatkowi technicy „sprzed zmiany" (poza tym, co odłożyło `rememberEventTechnicians`). */
  technicianIds?: readonly (number | null | undefined)[];
}): void {
  const ids = [...new Set((input.eventIds ?? []).filter((n): n is number => Number.isInteger(n)))];
  // Pamięć zdejmujemy ZAWSZE, także bez subskrybentów — inaczej wpisy z cichych
  // mutacji czekałyby do wygaśnięcia i doklejały się do kolejnego sygnału.
  const remembered = takeRememberedTechnicians(ids);
  if (subscribers.size === 0) return;
  const change: CalendarChange = {
    department: input.department,
    kind: input.kind,
    ids,
    technicianIds: [
      ...new Set([
        ...remembered,
        ...(input.technicianIds ?? []).filter((n): n is number => Number.isInteger(n)),
      ]),
    ],
    actorUserId: input.actorUserId ?? null,
    actorClientId: input.actorClientId ?? null,
    ts: Date.now(),
  };
  for (const cb of [...subscribers]) {
    try {
      cb(change);
    } catch (error) {
      console.error("[calendar-live] błąd subskrybenta:", error);
    }
  }
}
