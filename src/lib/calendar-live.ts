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
  /** Znacznik czasu (ms) — id zdarzenia SSE i pomoc przy debugowaniu. */
  ts: number;
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
}): void {
  if (subscribers.size === 0) return;
  const change: CalendarChange = {
    department: input.department,
    kind: input.kind,
    ids: [...new Set((input.eventIds ?? []).filter((n): n is number => Number.isInteger(n)))],
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
