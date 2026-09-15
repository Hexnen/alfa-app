/**
 * Etykiety PL kalendarza + ApiError — wspólne dla tras (src/routes/calendar.ts: summary
 * w activity_log, ICS) i asystenta (src/lib/ai/calendarPrompt.ts, calendarTools.ts).
 * Wydzielone z routes/calendar.ts, żeby lib/ nie importowało z routes/ (calendar.ts re-eksportuje).
 */
import { CALENDAR_EVENT_TYPES } from "../db/schema.js";
import type { CalendarBilling, CalendarEventStatus, CalendarEventType } from "../db/schema.js";

/**
 * Błąd walidacji/biznesowy rzucany wewnątrz synchronicznej transakcji better-sqlite3
 * (handler mapuje status → HTTP). Narzędzie propose_event asystenta odróżnia nią błędy walidacji.
 */
// 500 jest na liście, bo nie każdy błąd „nie z winy klienta" da się opisać
// domyślnym komunikatem handlerów: render umowy z szablonu Word potrafi paść
// na samym dokumencie i wtedy użytkownik ma dostać konkretne polskie zdanie,
// a nie generyczne „Błąd zapisu" (src/lib/contract-templates/render.ts).
export class ApiError extends Error {
  status: 400 | 403 | 404 | 409 | 500;
  constructor(status: 400 | 403 | 404 | 409 | 500, message: string) {
    super(message);
    this.status = status;
  }
}

export const TYPE_LABELS: Record<CalendarEventType, string> = {
  serwis: "Serwis",
  montaz: "Montaż",
  wizja: "Wizja",
  demontaz: "Demontaż",
  biuro: "Biuro",
  przygotowanie: "Przygotowanie",
  konserwacja: "Konserwacja",
  nagranie: "Nagranie",
  urlop: "Urlop",
  notatka: "Notatka",
  // Dział handlowy
  spotkanie: "Spotkanie",
  telefon: "Telefon",
  email: "E-mail",
  zadanie: "Zadanie",
  prezentacja: "Prezentacja",
  termin: "Termin",
};

export const STATUS_LABELS: Record<CalendarEventStatus, string> = {
  planned: "Zaplanowane",
  confirmed: "Potwierdzone",
  done: "Wykonane",
  cancelled: "Anulowane",
};

export const BILLING_LABELS: Record<CalendarBilling, string> = {
  warranty: "Gwarancyjny",
  free: "Darmowy",
  paid: "Płatny",
};

/** Typy, dla których rozliczenie nie ma sensu (pole ukryte, zawsze NULL). */
export const BILLING_HIDDEN_TYPES: readonly CalendarEventType[] = ["urlop", "biuro", "przygotowanie", "notatka"];

/** Typy „prac na obiekcie” — wykonane wydarzenie bez protokołu dostaje badge „Brak protokołu”. */
export const PROTOCOL_TYPES: readonly CalendarEventType[] = ["serwis", "montaz", "demontaz", "konserwacja", "wizja"];

// ---------------------------------------------------------------------------
// PANEL TECHNIKA — co jest „zleceniem” na tablecie
//
// Panel pokazywał wyłącznie PROTOCOL_TYPES, więc wyjazd typu „nagranie”, dzień
// w biurze czy przygotowanie materiału dla technika po prostu nie istniały:
// biuro miało je w kalendarzu, a tablet pustą listę. Widoczność idzie teraz po
// PRZYPISANIU (`calendar_event_assignees`), a nie po typie — skoro biuro
// wpisało technika do wydarzenia, to jest to jego dzień.
//
// Jedyny wyjątek to `notatka`: kafelek WSKAZUJĄCY notatkę innego wydarzenia,
// z definicji bez techników (src/db/schema.ts), więc na liście byłby wyłącznie
// skutkiem pomyłki w danych.
// ---------------------------------------------------------------------------

/** Typy, których panel technika NIE pokazuje nigdy. */
export const TECHNIK_HIDDEN_TYPES: readonly CalendarEventType[] = ["notatka"];

/** Wszystko, co panel pokazuje jako „zlecenie” (lista, szczegóły, mapa, liczniki, live). */
export const TECHNIK_JOB_TYPES: readonly CalendarEventType[] = CALENDAR_EVENT_TYPES.filter(
  (t) => !TECHNIK_HIDDEN_TYPES.includes(t)
);

/**
 * Typy, których technik nie „rozpoczyna” ani nie „kończy”. Urlop to
 * NIEOBECNOŚĆ, a nie praca: ma być widoczny w grafiku (dzień jest zajęty), ale
 * „Rozpoczęto urlop o 08:12” nie znaczy nic ani dla technika, ani dla
 * realizacji, której urlop nigdy nie dostaje (REALIZATION_FORBIDDEN_TYPES
 * w src/lib/calendar-config.ts).
 */
export const TECHNIK_NO_PROGRESS_TYPES: readonly CalendarEventType[] = ["urlop"];

/** Czy dla tego typu mają sens „Rozpocznij”/„Zakończ”/„Wznów” w panelu. */
export function technikCanProgress(type: CalendarEventType): boolean {
  return !TECHNIK_NO_PROGRESS_TYPES.includes(type) && !TECHNIK_HIDDEN_TYPES.includes(type);
}

/**
 * Typy, o których panel dostaje POWIADOMIENIE push — to samo, co widzi na
 * liście, minus urlop: „Nowe zlecenie” o własnym urlopie budziłoby telefon bez
 * powodu, a zmianę terminu i tak widać w grafiku.
 */
export const TECHNIK_PUSH_TYPES: readonly CalendarEventType[] = TECHNIK_JOB_TYPES.filter((t) =>
  technikCanProgress(t)
);
