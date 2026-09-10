/**
 * Etykiety PL kalendarza + ApiError — wspólne dla tras (src/routes/calendar.ts: summary
 * w activity_log, ICS) i asystenta (src/lib/ai/calendarPrompt.ts, calendarTools.ts).
 * Wydzielone z routes/calendar.ts, żeby lib/ nie importowało z routes/ (calendar.ts re-eksportuje).
 */
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
