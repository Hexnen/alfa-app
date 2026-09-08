/**
 * Mutacje kalendarza — walidacja wejścia (parseInput), tworzenie, pełna aktualizacja (z propagacją
 * na serię), przesunięcie, soft delete, przywrócenie + wpisy activity_log. Jedyne miejsce z tą
 * logiką: trasy (src/routes/calendar.ts) i asystent (POST /assistant/apply-changes) wołają te
 * funkcje wewnątrz własnej transakcji. `MutationCtx.summarySuffix` dopisuje „(przez asystenta)”
 * do KAŻDEGO wpisu activity_log wykonanej zmiany — bez duplikowania logiki logowania.
 *
 * better-sqlite3 jest synchroniczny — wszystkie funkcje są synchroniczne i rzucają ApiError.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import {
  CALENDAR_EVENT_TYPES,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_SERIES_FREQS,
  CALENDAR_BILLINGS,
  type CalendarBilling,
  type CalendarEvent as CalendarEventRow,
  type CalendarEventType,
  type CalendarEventStatus,
  type CalendarSeriesFreq,
  type CalendarEventNote as CalendarEventNoteRow,
  type CalendarNoteSource,
  CALENDAR_NOTE_MAX,
} from "../db/schema.js";
import { logActivity, logFieldDiffs, userLabelOf, type ActivityUser, type DbOrTx, type Tx } from "./activity-log.js";
import { onEventCreated, onEventDeleted, onEventRestored, onEventUpdated } from "./calendar-realizations.js";
import { noteEventLinks, noteOfRow, noteWithAttachments, type Note } from "./calendar-queries.js";
import { attachmentOfRow, type StoredAttachment } from "./calendar-attachments.js";
import { expandOccurrences, describeRule, shiftLocal, diffMinutes, type RecurrenceRule } from "./calendar-recurrence.js";
import { ApiError, BILLING_HIDDEN_TYPES, BILLING_LABELS, STATUS_LABELS, TYPE_LABELS } from "./calendar-labels.js";
import { mentionKeys } from "./note-mentions.js";
import { zonedToday } from "./tz.js";

export const CALENDAR_ENTITY = "calendar_event";

/** Kto i „czym” wykonuje zmianę (suffix trafia do summary każdego wpisu activity_log). */
export interface MutationCtx {
  user: ActivityUser & { id: number; role?: string | null };
  summarySuffix?: string | null;
}

/** "2026-09-12T08:00" → "12.09.2026 08:00"; "2026-09-12" → "12.09.2026". */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return s;
  const d = `${m[3]}.${m[2]}.${m[1]}`;
  return m[4] ? `${d} ${m[4]}:${m[5]}` : d;
}

// ---------------------------------------------------------------------------
// Walidacja wejścia
// ---------------------------------------------------------------------------

export interface ParsedInput {
  type: CalendarEventType;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  objectId: number | null;
  orderId: number | null;
  /**
   * Powiązana realizacja. `undefined` = pole NIE zostało przysłane — PUT zachowuje dotychczasowe
   * powiązanie (realizacja powstaje automatycznie po stronie serwera, więc brak pola w body nie
   * może jej odpinać); `null` = jawne odpięcie.
   */
  realizationId: number | null | undefined;
  /**
   * Jawne przełączenie „automatyczna realizacja” (opcjonalne pole `realizationOptout` w body).
   * `undefined` = wylicz z `realizationId`: ręczne odpięcie istniejącej realizacji ustawia opt-out,
   * ręczne podpięcie go zdejmuje.
   */
  realizationOptout: boolean | undefined;
  /** Rozliczenie (null = nie dotyczy); zawsze null dla typów z BILLING_HIDDEN_TYPES. */
  billing: CalendarBilling | null;
  /** Jawnie przypięty protokół (null = protokół realizacji / brak). */
  protocolId: number | null;
  /** Jawnie przypięta wycena (null = wycena realizacji / brak). */
  quoteId: number | null;
  technicianIds: number[];
  recurrence: RecurrenceRule | null;
  /**
   * Tylko dla type = "notatka": notatka, na którą wskazuje kafelek (wymagana). Dla pozostałych
   * typów zawsze null — notatki-kafelka nie da się zrobić z „niczego”.
   */
  noteId: number | null;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  if (m[4] && (+m[4] > 23 || +m[5] > 59)) return false;
  return true;
}

/** Normalizuje datę do formatu kontraktu (all-day: YYYY-MM-DD, inaczej YYYY-MM-DDTHH:MM). */
export function normDate(raw: unknown, allDay: boolean, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ApiError(400, `Pole ${field} jest wymagane`);
  }
  let s = raw.trim();
  if (allDay) {
    s = s.slice(0, 10);
    if (!DATE_RE.test(s) || !isValidCalendarDate(s)) {
      throw new ApiError(400, `Pole ${field}: oczekiwano daty YYYY-MM-DD`);
    }
  } else {
    // Akceptujemy też "YYYY-MM-DDTHH:MM:SS" i "YYYY-MM-DD HH:MM" — ucinamy do minut.
    s = s.replace(" ", "T").slice(0, 16);
    if (DATE_RE.test(s)) s = `${s}T00:00`;
    if (!DATETIME_RE.test(s) || !isValidCalendarDate(s)) {
      throw new ApiError(400, `Pole ${field}: oczekiwano daty YYYY-MM-DDTHH:MM`);
    }
  }
  return s;
}

function optInt(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Pole ${field}: nieprawidłowy identyfikator`);
  return n;
}

/** Opcjonalny bool: pole nieprzysłane / null → undefined (bez zmian). */
function optBool(raw: unknown, field: string): boolean | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
  if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
  throw new ApiError(400, `Pole ${field}: oczekiwano true/false`);
}

function optText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

function parseRecurrence(raw: unknown): RecurrenceRule | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new ApiError(400, "Pole recurrence: nieprawidłowy format");
  const r = raw as Record<string, unknown>;
  if (!CALENDAR_SERIES_FREQS.includes(r.freq as CalendarSeriesFreq)) {
    throw new ApiError(400, `Pole recurrence.freq: dozwolone ${CALENDAR_SERIES_FREQS.join(", ")}`);
  }
  const interval = r.interval == null || r.interval === "" ? 1 : Number(r.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    throw new ApiError(400, "Pole recurrence.interval: liczba całkowita 1–52");
  }
  let until: string | null = null;
  if (r.until != null && r.until !== "") {
    until = String(r.until).slice(0, 10);
    if (!DATE_RE.test(until) || !isValidCalendarDate(until)) {
      throw new ApiError(400, "Pole recurrence.until: oczekiwano daty YYYY-MM-DD");
    }
  }
  let count: number | null = null;
  if (r.count != null && r.count !== "") {
    count = Number(r.count);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      throw new ApiError(400, "Pole recurrence.count: liczba całkowita 1–200");
    }
  }
  if (until && count) throw new ApiError(400, "Pole recurrence: podaj until albo count, nie oba");
  return { freq: r.freq as CalendarSeriesFreq, interval, until, count };
}

/** Walidacja CalendarEventInput (bez sprawdzania istnienia referencji — to w transakcji: assertRefs).
 *  Reużywana 1:1 przez narzędzia asystenta (propose_event, propose_changes). */
export function parseInput(body: unknown): ParsedInput {
  if (!body || typeof body !== "object") throw new ApiError(400, "Nieprawidłowe dane wejściowe");
  const b = body as Record<string, unknown>;

  if (!CALENDAR_EVENT_TYPES.includes(b.type as CalendarEventType)) {
    throw new ApiError(400, `Pole type: dozwolone ${CALENDAR_EVENT_TYPES.join(", ")}`);
  }
  const type = b.type as CalendarEventType;
  const isUrlop = type === "urlop";
  // Kafelek notatki: tytuł, daty, technicy i reszta są WYMUSZANE (patrz niżej) — z ciała
  // liczą się tylko `noteId`, `startAt` i `status`.
  const isNote = type === "notatka";
  const title = typeof b.title === "string" ? b.title.trim() : "";
  // Urlop/notatka: tytuł opcjonalny (generowany w transakcji — z nazwiska technika / treści notatki)
  if (!title && !isUrlop && !isNote) throw new ApiError(400, "Tytuł jest wymagany");
  if (title.length > 300) throw new ApiError(400, "Tytuł jest za długi (max 300 znaków)");

  const noteId = isNote ? optInt(b.noteId, "noteId") : null;
  if (isNote && noteId == null) throw new ApiError(400, "Wydarzenie typu notatka wymaga wskazania notatki (pole noteId)");

  // Urlop: domyślnie cały dzień (chyba że klient jawnie poda allDay=false). Notatka: ZAWSZE cały dzień.
  const allDay = isNote
    ? true
    : isUrlop
      ? !(b.allDay === false || b.allDay === 0 || b.allDay === "0" || b.allDay === "false")
      : b.allDay === true || b.allDay === 1 || b.allDay === "1" || b.allDay === "true";
  const startAt = normDate(b.startAt, allDay, "startAt");
  let endAt = normDate(b.endAt ?? b.startAt, allDay, "endAt");
  // Notatka zajmuje dokładnie jeden dzień — koniec liczymy sami, cokolwiek przyszło w ciele.
  if (isNote) endAt = shiftLocal(startAt, 24 * 60, true);
  if (allDay) {
    // end EXCLUSIVE: 1-dniowy event = start 12.09, end 13.09
    if (endAt === startAt) endAt = shiftLocal(startAt, 24 * 60, true);
    if (endAt < startAt) throw new ApiError(400, "Data końca nie może być wcześniejsza niż początek");
  } else if (endAt <= startAt) {
    throw new ApiError(400, "Koniec musi być późniejszy niż początek");
  }

  let status: CalendarEventStatus = "planned";
  if (b.status != null && b.status !== "") {
    if (!CALENDAR_EVENT_STATUSES.includes(b.status as CalendarEventStatus)) {
      throw new ApiError(400, `Pole status: dozwolone ${CALENDAR_EVENT_STATUSES.join(", ")}`);
    }
    status = b.status as CalendarEventStatus;
  }

  let technicianIds: number[] = [];
  if (b.technicianIds != null && !isNote) {
    if (!Array.isArray(b.technicianIds)) throw new ApiError(400, "Pole technicianIds: oczekiwano tablicy");
    technicianIds = [...new Set(b.technicianIds.map((x) => optInt(x, "technicianIds")!))];
  }
  if (isUrlop && technicianIds.length === 0) throw new ApiError(400, "Urlop wymaga wskazania technika");

  let billing: CalendarBilling | null = null;
  if (b.billing != null && b.billing !== "" && !BILLING_HIDDEN_TYPES.includes(type)) {
    if (!CALENDAR_BILLINGS.includes(b.billing as CalendarBilling)) {
      throw new ApiError(400, `Pole billing: dozwolone ${CALENDAR_BILLINGS.join(", ")} albo null`);
    }
    billing = b.billing as CalendarBilling;
  }

  // Notatka: obiekt/zlecenie kopiujemy ze źródłowego wydarzenia w transakcji, reszta odpada.
  const noRefs = isUrlop || isNote;
  return {
    type,
    title,
    description: isNote ? null : optText(b.description),
    // Urlop nie dotyczy obiektu ani lokalizacji — ignorujemy te pola
    location: noRefs ? null : optText(b.location),
    startAt,
    endAt,
    allDay,
    status,
    objectId: noRefs ? null : optInt(b.objectId, "objectId"),
    orderId: noRefs ? null : optInt(b.orderId, "orderId"),
    realizationId: noRefs ? null : "realizationId" in b ? optInt(b.realizationId, "realizationId") : undefined,
    realizationOptout: isNote ? undefined : optBool(b.realizationOptout, "realizationOptout"),
    billing,
    protocolId: noRefs ? null : optInt(b.protocolId, "protocolId"),
    quoteId: noRefs ? null : optInt(b.quoteId, "quoteId"),
    technicianIds,
    recurrence: isNote ? null : parseRecurrence(b.recurrence),
    noteId,
  };
}

/**
 * Sprawdza istnienie referencji (obiekt, zlecenie, realizacja, technicy). Rzuca ApiError.
 * `excludeEventId` — edytowane wydarzenie (jego własna realizacja nie jest „zajęta”).
 */
export function assertRefs(tx: DbOrTx, input: ParsedInput, excludeEventId: number | null = null) {
  if (input.type === "notatka") {
    if (input.noteId == null) throw new ApiError(400, "Wydarzenie typu notatka wymaga wskazania notatki (pole noteId)");
    // Rzuca 400, gdy notatka nie istnieje / jest skasowana / jej wydarzenie jest kafelkiem notatki.
    loadNoteSource(tx, input.noteId);
  }
  if (input.objectId != null) {
    const o = tx.select({ id: schema.objects.id }).from(schema.objects).where(eq(schema.objects.id, input.objectId)).get();
    if (!o) throw new ApiError(400, `Obiekt #${input.objectId} nie istnieje`);
  }
  if (input.orderId != null) {
    const o = tx.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, input.orderId)).get();
    if (!o) throw new ApiError(400, `Zlecenie #${input.orderId} nie istnieje`);
  }
  if (input.realizationId != null) {
    const r = tx.select({ id: schema.realizations.id }).from(schema.realizations).where(eq(schema.realizations.id, input.realizationId)).get();
    if (!r) throw new ApiError(400, `Realizacja #${input.realizationId} nie istnieje`);
    // Realizacja ↔ wydarzenie 1:1 (unikalny indeks częściowy) — czytelny 400 zamiast 500 z UNIQUE.
    const taken = tx
      .select({ id: schema.calendarEvents.id, title: schema.calendarEvents.title })
      .from(schema.calendarEvents)
      .where(
        excludeEventId != null
          ? and(eq(schema.calendarEvents.realizationId, input.realizationId), ne(schema.calendarEvents.id, excludeEventId))
          : eq(schema.calendarEvents.realizationId, input.realizationId)
      )
      .get();
    if (taken) throw new ApiError(400, `Realizacja #${input.realizationId} jest już podpięta do wydarzenia #${taken.id} („${taken.title}”)`);
  }
  if (input.protocolId != null) {
    const p = tx.select({ id: schema.protocols.id }).from(schema.protocols).where(eq(schema.protocols.id, input.protocolId)).get();
    if (!p) throw new ApiError(400, `Protokół #${input.protocolId} nie istnieje`);
  }
  if (input.quoteId != null) {
    const q = tx.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.id, input.quoteId)).get();
    if (!q) throw new ApiError(400, `Wycena #${input.quoteId} nie istnieje`);
  }
  if (input.technicianIds.length > 0) {
    const found = tx
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .where(inArray(schema.technicians.id, input.technicianIds))
      .all()
      .map((t) => t.id);
    const missing = input.technicianIds.filter((id) => !found.includes(id));
    if (missing.length > 0) throw new ApiError(400, `Technik #${missing.join(", #")} nie istnieje`);
  }
}

// ---------------------------------------------------------------------------
// Helpery domenowe (w transakcji)
// ---------------------------------------------------------------------------

/** Dla urlopu bez tytułu generuje „Urlop — Jan Kowalski” (kilku techników: po przecinku). */
export function resolveTitle(dbx: DbOrTx, input: ParsedInput): string {
  if (input.title || input.type !== "urlop") return input.title;
  return `Urlop — ${input.technicianIds.map((id) => techNameById(dbx, id)).join(", ")}`.slice(0, 300);
}

function techNameById(dbx: DbOrTx, id: number): string {
  const t = dbx
    .select({ firstName: schema.technicians.firstName, lastName: schema.technicians.lastName })
    .from(schema.technicians)
    .where(eq(schema.technicians.id, id))
    .get();
  return t ? `${t.firstName} ${t.lastName}`.trim() : `#${id}`;
}

/** Nazwa obiektu do wpisu w dzienniku — odczyt PO ID, nigdy odwrotnie. */
function objectNameById(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  // identity-ok: id → nazwa (migawka na opis zmiany), nie nazwa → id.
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get(); // identity-ok
  return o ? o.name : `#${id}`;
}

function protocolNumberById(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  const p = dbx.select({ number: schema.protocols.number }).from(schema.protocols).where(eq(schema.protocols.id, id)).get();
  return p ? p.number : `#${id}`;
}

function quoteNumberById(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  const q = dbx.select({ number: schema.quotes.number }).from(schema.quotes).where(eq(schema.quotes.id, id)).get();
  return q ? q.number : `#${id}`;
}

export function currentAssignees(dbx: DbOrTx, eventId: number): number[] {
  return dbx
    .select({ id: schema.calendarEventAssignees.technicianId })
    .from(schema.calendarEventAssignees)
    .where(eq(schema.calendarEventAssignees.eventId, eventId))
    .all()
    .map((r) => r.id);
}

/** Ustawia zbiór techników wydarzenia; loguje assigned/unassigned per technik. */
function syncAssignees(tx: Tx, ev: CalendarEventRow, technicianIds: number[], ctx: MutationCtx) {
  const before = currentAssignees(tx, ev.id);
  const toAdd = technicianIds.filter((id) => !before.includes(id));
  const toRemove = before.filter((id) => !technicianIds.includes(id));
  const base = { entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix };
  for (const id of toRemove) {
    tx.delete(schema.calendarEventAssignees)
      .where(and(eq(schema.calendarEventAssignees.eventId, ev.id), eq(schema.calendarEventAssignees.technicianId, id)))
      .run();
    logActivity(tx, { ...base, action: "unassigned", field: "technician", oldValue: id, newValue: null, summary: `Odpisano technika: ${techNameById(tx, id)}` });
  }
  for (const id of toAdd) {
    tx.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
    logActivity(tx, { ...base, action: "assigned", field: "technician", oldValue: null, newValue: id, summary: `Przypisano technika: ${techNameById(tx, id)}` });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/** Loguje diff pól (bez dat i bez statusu — te mają własne akcje) + moved + status_changed. */
function logEventDiff(tx: Tx, before: CalendarEventRow, after: CalendarEventRow, ctx: MutationCtx) {
  const base = { entityType: CALENDAR_ENTITY, entityId: after.id, objectId: after.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix };
  // Przesunięcie / zmiana czasu
  if (before.startAt !== after.startAt || before.endAt !== after.endAt || before.allDay !== after.allDay) {
    const fromS = before.allDay ? `${fmtDate(before.startAt)} (cały dzień)` : `${fmtDate(before.startAt)}–${fmtDate(before.endAt)}`;
    const toS = after.allDay ? `${fmtDate(after.startAt)} (cały dzień)` : `${fmtDate(after.startAt)}–${fmtDate(after.endAt)}`;
    if (before.startAt !== after.startAt) {
      // Przesunięcie (drag&drop / zmiana daty) — jeden wpis z pełnym opisem
      logActivity(tx, { ...base, action: "moved", field: "start_at", oldValue: before.startAt, newValue: after.startAt, summary: `Przesunięto z ${fromS} na ${toS}` });
    } else {
      // Sam koniec (resize) — osobny wpis z czytelnym opisem
      logActivity(tx, { ...base, action: "moved", field: "end_at", oldValue: before.endAt, newValue: after.endAt, summary: `Zmieniono koniec z ${fmtDate(before.endAt)} na ${fmtDate(after.endAt)}` });
    }
    if (before.allDay !== after.allDay) {
      logActivity(tx, { ...base, action: "updated", field: "all_day", oldValue: before.allDay, newValue: after.allDay, summary: after.allDay ? "Ustawiono: cały dzień" : "Wyłączono: cały dzień" });
    }
  }
  // Status
  if (before.status !== after.status) {
    logActivity(tx, {
      ...base, action: "status_changed", field: "status", oldValue: before.status, newValue: after.status,
      summary: `Zmieniono status: ${STATUS_LABELS[before.status]} → ${STATUS_LABELS[after.status]}`,
    });
  }
  // Pozostałe pola
  logFieldDiffs(tx, {
    ...base,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
    fields: [
      { key: "title", label: "tytuł" },
      { key: "type", label: "typ", format: (v) => TYPE_LABELS[v as CalendarEventType] ?? String(v) },
      { key: "location", label: "lokalizację" },
      { key: "description", label: "opis", format: (v) => (v ? String(v).slice(0, 60) + (String(v).length > 60 ? "…" : "") : "—") },
      { key: "objectId", label: "obiekt", format: (v) => objectNameById(tx, (v as number | null) ?? null) },
      { key: "orderId", label: "zlecenie", format: (v) => (v == null ? "—" : `#${v}`) },
      { key: "realizationId", label: "realizację", format: (v) => (v == null ? "—" : `#${v}`) },
      { key: "realizationOptout", label: "automatyczną realizację", format: (v) => (v ? "wyłączona (ręcznie odpięta)" : "włączona") },
      { key: "billing", label: "rozliczenie", format: (v) => (v == null ? "—" : (BILLING_LABELS[v as CalendarBilling] ?? String(v))) },
      { key: "protocolId", label: "protokół", format: (v) => protocolNumberById(tx, (v as number | null) ?? null) },
      { key: "quoteId", label: "wycenę", format: (v) => quoteNumberById(tx, (v as number | null) ?? null) },
    ],
  });
}

export function getEventRow(dbx: DbOrTx, id: number): CalendarEventRow | undefined {
  return dbx.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
}

// ---------------------------------------------------------------------------
// Kafelki typu „notatka” — wydarzenie WSKAZUJĄCE istniejącą notatkę.
//
// Kafelek powstaje wyłącznie (a) ręcznie z gotowej notatki (`note_mention` = NULL) albo
// (b) ze wzmianki daty w treści notatki (`note_mention` = klucz wzmianki, patrz
// src/lib/note-mentions.ts). Zawsze 1 dzień, allDay, bez techników, serii, rozliczenia,
// realizacji, protokołu i wyceny; `object_id`/`order_id` kopiowane ze źródła, żeby filtry
// po obiekcie działały tak samo jak dla wydarzenia, przy którym notatka wisi.
// ---------------------------------------------------------------------------

/** Ile znaków treści notatki wchodzi do tytułu kafelka. */
const NOTE_TITLE_TEXT_MAX = 60;

export interface NoteEventSource {
  note: CalendarEventNoteRow;
  /** Wydarzenie, przy którym wisi notatka (nigdy typu „notatka”). */
  event: CalendarEventRow;
}

/** Notatka + jej wydarzenie źródłowe albo null, gdy któregoś nie ma / jest skasowane. */
export function findNoteSource(dbx: DbOrTx, noteId: number): NoteEventSource | null {
  const note = getNoteRow(dbx, noteId);
  if (!note || note.deletedAt) return null;
  const event = getEventRow(dbx, note.eventId);
  if (!event || event.deletedAt || event.type === "notatka") return null;
  return { note, event };
}

/** Jak `findNoteSource`, ale z czytelnym 400 zamiast null (walidacja wejścia). */
export function loadNoteSource(dbx: DbOrTx, noteId: number): NoteEventSource {
  const note = getNoteRow(dbx, noteId);
  if (!note || note.deletedAt) throw new ApiError(400, `Notatka #${noteId} nie istnieje`);
  const event = getEventRow(dbx, note.eventId);
  if (!event || event.deletedAt) throw new ApiError(400, `Wydarzenie notatki #${noteId} nie istnieje lub jest usunięte`);
  if (event.type === "notatka") throw new ApiError(400, "Wydarzenie typu notatka nie może być źródłem kolejnej notatki");
  return { note, event };
}

/** Tytuł kafelka: „Notatka: <początek treści>”; pusta treść (sam załącznik) → tytuł źródła. */
export function noteEventTitle(note: Pick<CalendarEventNoteRow, "text">, source: Pick<CalendarEventRow, "title">): string {
  const t = note.text.replace(/\s+/g, " ").trim();
  const body = t ? (t.length > NOTE_TITLE_TEXT_MAX ? `${t.slice(0, NOTE_TITLE_TEXT_MAX - 1)}…` : t) : source.title;
  return `Notatka: ${body}`.slice(0, 300);
}

/** Wstawia kafelek notatki (1 dzień) + wpis „created” w activity_log. Zwraca id. */
function insertNoteEvent(
  tx: DbOrTx,
  p: { note: CalendarEventNoteRow; source: CalendarEventRow; startAt: string; mention: string | null; status?: CalendarEventStatus; ctx: MutationCtx }
): number {
  const ev = tx
    .insert(schema.calendarEvents)
    .values({
      type: "notatka",
      title: noteEventTitle(p.note, p.source),
      description: null,
      location: null,
      startAt: p.startAt,
      endAt: shiftLocal(p.startAt, 24 * 60, true),
      allDay: true,
      status: p.status ?? "planned",
      department: "technical",
      objectId: p.source.objectId,
      orderId: p.source.orderId,
      billing: null,
      noteId: p.note.id,
      noteMention: p.mention,
      createdBy: p.ctx.user.id,
      updatedBy: p.ctx.user.id,
    })
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: p.ctx.user, summarySuffix: p.ctx.summarySuffix,
    action: "created",
    summary: p.mention
      ? `Utworzono kafelek notatki ze wzmianki „@${p.mention}” (${fmtDate(ev.startAt)})`
      : `Przypięto notatkę do kalendarza (${fmtDate(ev.startAt)})`,
  });
  return ev.id;
}

/** Soft delete wydarzenia + wpis „deleted” (wspólne dla kafelków notatek). */
function softDeleteEventRow(tx: DbOrTx, ev: CalendarEventRow, ctx: MutationCtx, summary: string): void {
  tx.update(schema.calendarEvents)
    .set({ deletedAt: sql`(datetime('now'))`, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, ev.id))
    .run();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix,
    action: "deleted", summary,
  });
}

/** Kafelki wskazujące daną notatkę (żywe albo usunięte). */
function noteEventsOfNote(dbx: DbOrTx, noteId: number, deleted = false): CalendarEventRow[] {
  return dbx
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.type, "notatka"),
        eq(schema.calendarEvents.noteId, noteId),
        deleted ? isNotNull(schema.calendarEvents.deletedAt) : isNull(schema.calendarEvents.deletedAt)
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .all();
}

/** Kafelki wskazujące którąkolwiek notatkę danego wydarzenia (żywe albo usunięte). */
function noteEventsOfEvent(dbx: DbOrTx, eventId: number, deleted = false): CalendarEventRow[] {
  return dbx
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.type, "notatka"),
        deleted ? isNotNull(schema.calendarEvents.deletedAt) : isNull(schema.calendarEvents.deletedAt),
        sql`${schema.calendarEvents.noteId} IN (SELECT id FROM calendar_event_notes WHERE event_id = ${eventId})`
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .all();
}

/**
 * Doprowadza kafelki ze wzmianek do stanu zgodnego z treścią notatki (addNote/updateNote,
 * w tej samej transakcji). Kotwica `today` = dziś w strefie aplikacji (src/lib/tz.ts).
 *
 * Klucz nadal w tekście → kafelek ZOSTAJE bez zmiany daty (użytkownik mógł go przeciągnąć);
 * klucz zniknął → soft delete; nowy klucz → nowy kafelek. Kafelków podpiętych RĘCZNIE
 * (`note_mention IS NULL`) synchronizacja nie dotyka.
 */
export function syncNoteMentionEvents(
  tx: DbOrTx,
  note: CalendarEventNoteRow,
  source: CalendarEventRow,
  ctx: MutationCtx,
  today: string = zonedToday()
): { created: number[]; deleted: number[] } {
  const keys = mentionKeys(note.text, today);
  const created: number[] = [];
  const deleted: number[] = [];
  const kept = new Set<string>();
  for (const ev of noteEventsOfNote(tx, note.id).filter((e) => e.noteMention != null)) {
    const key = ev.noteMention!;
    if (keys.has(key)) {
      kept.add(key);
      continue;
    }
    softDeleteEventRow(tx, ev, ctx, `Usunięto kafelek notatki — wzmianka „@${key}” zniknęła z treści`);
    deleted.push(ev.id);
  }
  for (const [key, date] of keys) {
    if (kept.has(key)) continue;
    created.push(insertNoteEvent(tx, { note, source, startAt: date, mention: key, ctx }));
  }
  return { created, deleted };
}

/** Odświeża tytuły żywych kafelków notatki po zmianie jej treści (bez wpisów w dzienniku). */
function refreshNoteEventTitles(tx: DbOrTx, note: CalendarEventNoteRow, source: CalendarEventRow): void {
  const title = noteEventTitle(note, source);
  for (const ev of noteEventsOfNote(tx, note.id)) {
    if (ev.title === title) continue;
    tx.update(schema.calendarEvents)
      .set({ title, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.calendarEvents.id, ev.id))
      .run();
  }
}

export type Scope = "this" | "future" | "all";
export function parseScope(raw: string | undefined): Scope {
  if (raw === "future" || raw === "all") return raw;
  return "this";
}

/** Rodzeństwo z serii wg scope (bez samego eventu; nie usunięte). */
function seriesSiblings(dbx: DbOrTx, ev: CalendarEventRow, scope: Scope): CalendarEventRow[] {
  if (scope === "this" || ev.seriesId == null) return [];
  const conds = [
    eq(schema.calendarEvents.seriesId, ev.seriesId),
    ne(schema.calendarEvents.id, ev.id),
    isNull(schema.calendarEvents.deletedAt),
  ];
  if (scope === "future") conds.push(gt(schema.calendarEvents.startAt, ev.startAt));
  return dbx.select().from(schema.calendarEvents).where(and(...conds)).orderBy(asc(schema.calendarEvents.startAt)).all();
}

/**
 * Zastosowanie zmian z PUT do jednego wiersza (target lub sibling z deltą dat).
 * `realizationId` NIE propaguje się na rodzeństwo z serii (relacja 1:1 — każde wystąpienie
 * ma własną realizację); sibling zachowuje swoją.
 */
function applyUpdate(
  tx: Tx,
  row: CalendarEventRow,
  input: ParsedInput,
  dates: { startAt: string; endAt: string; allDay: boolean },
  ctx: MutationCtx,
  isTarget = true
): CalendarEventRow {
  // Ręczne „Odepnij” (jawny realizationId: null przy istniejącym powiązaniu) wyłącza automat;
  // ręczne podpięcie realizacji go włącza z powrotem. Jawne pole realizationOptout ma pierwszeństwo.
  const optout = !isTarget
    ? row.realizationOptout
    : input.realizationOptout !== undefined
      ? input.realizationOptout
      : input.realizationId === null && row.realizationId != null
        ? true
        : typeof input.realizationId === "number"
          ? false
          : row.realizationOptout;

  const after = tx
    .update(schema.calendarEvents)
    .set({
      type: input.type,
      title: resolveTitle(tx, input),
      description: input.description,
      location: input.location,
      startAt: dates.startAt,
      endAt: dates.endAt,
      allDay: dates.allDay,
      status: input.status,
      objectId: input.objectId,
      orderId: input.orderId,
      realizationId: isTarget && input.realizationId !== undefined ? input.realizationId : row.realizationId,
      realizationOptout: optout,
      billing: input.billing,
      protocolId: input.protocolId,
      quoteId: input.quoteId,
      updatedBy: ctx.user.id,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.calendarEvents.id, row.id))
    .returning()
    .get();
  logEventDiff(tx, row, after, ctx);
  syncAssignees(tx, after, input.technicianIds, ctx);
  // Realizacje: utworzenie / synchronizacja / odpięcie wg ustawień (calendar-realizations.ts).
  // `row` (stan sprzed) pozwala wykryć przejście statusu na „wykonane” → wstępne podliczenie.
  onEventUpdated(tx, after, ctx, row);
  return after;
}

/** Daty siblinga po zastosowaniu delty (start/end osobno) i ewentualnej zmiany allDay. */
function shiftedDates(sib: CalendarEventRow, deltaStart: number, deltaEnd: number, allDay: boolean): { startAt: string; endAt: string; allDay: boolean } {
  let startAt = shiftLocal(sib.startAt, deltaStart, allDay);
  let endAt = shiftLocal(sib.endAt, deltaEnd, allDay);
  if (allDay) {
    if (endAt <= startAt) endAt = shiftLocal(startAt, 24 * 60, true);
  } else if (endAt <= startAt) {
    // zabezpieczenie: zachowaj dotychczasowe trwanie siblinga
    const dur = Math.max(30, diffMinutes(sib.startAt, sib.endAt));
    endAt = shiftLocal(startAt, dur, false);
  }
  return { startAt, endAt, allDay };
}

// ---------------------------------------------------------------------------
// Operacje (wołane WEWNĄTRZ db.transaction przez trasy / asystenta)
// ---------------------------------------------------------------------------

/** Tworzy wydarzenie (opcjonalnie serię). Zwraca id pierwszego, id serii i liczbę wystąpień. */
export function createEvent(tx: Tx, input: ParsedInput, ctx: MutationCtx): { firstId: number; seriesId: number | null; occurrencesCount: number } {
  assertRefs(tx, input);

  // Kafelek notatki: bez serii, techników i realizacji — wszystko bierze się z notatki źródłowej.
  if (input.type === "notatka") {
    const src = loadNoteSource(tx, input.noteId!);
    const firstId = insertNoteEvent(tx, { note: src.note, source: src.event, startAt: input.startAt, mention: null, status: input.status, ctx });
    return { firstId, seriesId: null, occurrencesCount: 1 };
  }

  let seriesId: number | null = null;
  let occurrences = [{ startAt: input.startAt, endAt: input.endAt }];
  let seriesLabel = "";
  if (input.recurrence) {
    occurrences = expandOccurrences(input.startAt, input.endAt, input.allDay, input.recurrence);
    const series = tx
      .insert(schema.calendarSeries)
      .values({
        freq: input.recurrence.freq,
        interval: input.recurrence.interval ?? 1,
        until: input.recurrence.until ?? null,
        count: input.recurrence.count ?? null,
        createdBy: ctx.user.id,
      })
      .returning()
      .get();
    seriesId = series.id;
    seriesLabel = describeRule(input.recurrence);
  }

  const ids: number[] = [];
  for (const occ of occurrences) {
    const ev = tx
      .insert(schema.calendarEvents)
      .values({
        type: input.type,
        title: resolveTitle(tx, input),
        description: input.description,
        location: input.location,
        startAt: occ.startAt,
        endAt: occ.endAt,
        allDay: input.allDay,
        status: input.status,
        department: "technical",
        objectId: input.objectId,
        orderId: input.orderId,
        realizationId: input.realizationId ?? null,
        realizationOptout: input.realizationOptout ?? false,
        billing: input.billing,
        protocolId: input.protocolId,
        quoteId: input.quoteId,
        seriesId,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      })
      .returning()
      .get();
    for (const tid of input.technicianIds) {
      tx.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: tid }).run();
    }
    logActivity(tx, {
      entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix,
      action: "created",
      summary: seriesId != null
        ? `Utworzono w ramach serii #${seriesId} (${seriesLabel})`
        : `Utworzono wydarzenie „${ev.title}” (${TYPE_LABELS[ev.type]}, ${fmtDate(ev.startAt)})`,
    });
    // Realizacja + protokół dla typów objętych (wg ustawień calendar.*).
    onEventCreated(tx, ev, ctx);
    ids.push(ev.id);
  }
  return { firstId: ids[0], seriesId, occurrencesCount: ids.length };
}

/** Pełna aktualizacja (PUT) z propagacją na serię wg scope. Zwraca id zaktualizowanych wydarzeń. */
export function updateEvent(tx: Tx, id: number, input: ParsedInput, scope: Scope, ctx: MutationCtx): number[] {
  const row = getEventRow(tx, id);
  if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
  // Typ „notatka” to inny byt niż zwykłe wydarzenie — konwersji w żadną stronę nie ma.
  if ((row.type === "notatka") !== (input.type === "notatka")) {
    throw new ApiError(400, "Nie można zmienić typu wydarzenia na „notatka” ani z „notatka” na inny");
  }
  if (row.type === "notatka") {
    updateNoteEvent(tx, row, input, ctx);
    return [id];
  }
  assertRefs(tx, input, id);

  const updatedIds = [id];
  applyUpdate(tx, row, input, { startAt: input.startAt, endAt: input.endAt, allDay: input.allDay }, ctx);

  // Delta dat do propagacji na rodzeństwo (zachowują własne daty + ta sama delta)
  const deltaStart = diffMinutes(row.startAt, input.startAt);
  const deltaEnd = diffMinutes(row.endAt, input.endAt);
  for (const sib of seriesSiblings(tx, row, scope)) {
    applyUpdate(tx, sib, input, shiftedDates(sib, deltaStart, deltaEnd, input.allDay), ctx, false);
    updatedIds.push(sib.id);
  }
  return updatedIds;
}

/**
 * PUT na kafelku notatki: wolno zmienić WYŁĄCZNIE dzień i status. Notatka źródłowa,
 * obiekt i zlecenie zostają, tytuł odświeżamy z aktualnej treści notatki.
 */
function updateNoteEvent(tx: Tx, row: CalendarEventRow, input: ParsedInput, ctx: MutationCtx): CalendarEventRow {
  const src = row.noteId != null ? findNoteSource(tx, row.noteId) : null;
  const after = tx
    .update(schema.calendarEvents)
    .set({
      title: src ? noteEventTitle(src.note, src.event) : row.title,
      startAt: input.startAt,
      endAt: shiftLocal(input.startAt, 24 * 60, true),
      allDay: true,
      status: input.status,
      updatedBy: ctx.user.id,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.calendarEvents.id, row.id))
    .returning()
    .get();
  logEventDiff(tx, row, after, ctx);
  return after;
}

/** Przesunięcie / zmiana czasu (drag&drop, resize) — tylko daty i allDay. */
export function moveEvent(tx: Tx, id: number, body: Record<string, unknown>, ctx: MutationCtx): CalendarEventRow {
  const row = getEventRow(tx, id);
  if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte");

  // Kafelek notatki zostaje całodniowy i jednodniowy — drag zmienia wyłącznie dzień.
  const isNote = row.type === "notatka";
  const allDay = isNote ? true : body.allDay == null ? row.allDay : body.allDay === true || body.allDay === 1 || body.allDay === "true";
  const startAt = normDate(body.startAt ?? row.startAt, allDay, "startAt");
  let endAt = isNote
    ? shiftLocal(startAt, 24 * 60, true)
    : normDate(body.endAt ?? (allDay ? startAt : shiftLocal(startAt, Math.max(30, diffMinutes(row.startAt, row.endAt)), false)), allDay, "endAt");
  if (allDay) {
    if (endAt <= startAt) endAt = shiftLocal(startAt, 24 * 60, true);
  } else if (endAt <= startAt) {
    throw new ApiError(400, "Koniec musi być późniejszy niż początek");
  }

  const after = tx
    .update(schema.calendarEvents)
    .set({ startAt, endAt, allDay, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, id))
    .returning()
    .get();
  logEventDiff(tx, row, after, ctx);
  onEventUpdated(tx, after, ctx, row);
  return after;
}

/** Soft delete (z propagacją na serię wg scope). Zwraca id usuniętych. */
export function deleteEvent(tx: Tx, id: number, scope: Scope, ctx: MutationCtx): number[] {
  const row = getEventRow(tx, id);
  if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest już usunięte");
  const targets = [row, ...seriesSiblings(tx, row, scope)];
  for (const t of targets) {
    tx.update(schema.calendarEvents)
      .set({ deletedAt: sql`(datetime('now'))`, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.calendarEvents.id, t.id))
      .run();
    logActivity(tx, {
      entityType: CALENDAR_ENTITY, entityId: t.id, objectId: t.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix, action: "deleted",
      summary: `Usunięto wydarzenie „${t.title}” (${fmtDate(t.startAt)})${scope !== "this" ? ` — zakres: ${scope === "all" ? "cała seria" : "to i kolejne"}` : ""}`,
    });
    // Realizacja „nietknięta” znika razem z wydarzeniem; z kwotami/podpisem zostaje z adnotacją.
    onEventDeleted(tx, t, ctx);
    // Kafelki notatek tego wydarzenia nie mają już czego pokazywać — znikają razem z nim
    // (restoreEvent je przywraca). Same kafelki notatek żadnych notatek nie mają.
    if (t.type !== "notatka") {
      for (const tile of noteEventsOfEvent(tx, t.id)) {
        softDeleteEventRow(tx, tile, ctx, `Usunięto kafelek notatki — wydarzenie źródłowe „${t.title}” zostało usunięte`);
      }
    }
  }
  return targets.map((t) => t.id);
}

/** Przywrócenie usuniętego wydarzenia. */
export function restoreEvent(tx: Tx, id: number, ctx: MutationCtx): CalendarEventRow {
  const row = getEventRow(tx, id);
  if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (!row.deletedAt) throw new ApiError(409, "Wydarzenie nie jest usunięte");
  const after = tx
    .update(schema.calendarEvents)
    .set({ deletedAt: null, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, id))
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: id, objectId: row.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix, action: "restored",
    summary: `Przywrócono wydarzenie „${row.title}” (${fmtDate(row.startAt)})`,
  });
  onEventRestored(tx, after, ctx);
  // Kafelki notatek wracają razem z wydarzeniem — ale tylko te, które POWINNY istnieć:
  // notatka nadal żyje, a kafelek jest ręczny albo jego wzmianka wciąż jest w treści
  // (kafelek po skasowanej wzmiance i tak zniknąłby przy najbliższej synchronizacji).
  if (after.type !== "notatka") {
    const today = zonedToday();
    // Jeden kafelek na wzmiankę: klucze zajęte przez żywe kafelki (i te już przywrócone).
    const taken = new Set<string>();
    for (const tile of noteEventsOfEvent(tx, id)) if (tile.noteMention) taken.add(`${tile.noteId}:${tile.noteMention}`);
    for (const tile of noteEventsOfEvent(tx, id, true)) {
      if (tile.noteId == null) continue;
      const note = getNoteRow(tx, tile.noteId);
      if (!note || note.deletedAt) continue;
      if (tile.noteMention != null) {
        const key = `${tile.noteId}:${tile.noteMention}`;
        if (taken.has(key) || !mentionKeys(note.text, today).has(tile.noteMention)) continue;
        taken.add(key);
      }
      tx.update(schema.calendarEvents)
        .set({ deletedAt: null, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.calendarEvents.id, tile.id))
        .run();
      logActivity(tx, {
        entityType: CALENDAR_ENTITY, entityId: tile.id, objectId: tile.objectId, user: ctx.user, summarySuffix: ctx.summarySuffix,
        action: "restored", summary: `Przywrócono kafelek notatki (${fmtDate(tile.startAt)})`,
      });
    }
  }
  return after;
}

// ---------------------------------------------------------------------------
// Notatki (dziennik wydarzenia) — osobna tabela calendar_event_notes, soft delete,
// każda operacja loguje note_added / note_updated / note_deleted do activity_log.
// ---------------------------------------------------------------------------

/** Skrót notatki do summary activity_log (pierwsze 120 znaków, bez nowych linii). */
function noteSummary(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Walidacja treści notatki (trim, 1–CALENDAR_NOTE_MAX znaków). Rzuca ApiError.
 * `allowEmpty` — notatka z samymi załącznikami może mieć pustą treść.
 */
export function parseNoteText(raw: unknown, allowEmpty = false): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s && !allowEmpty) throw new ApiError(400, "Treść notatki jest wymagana");
  if (s.length > CALENDAR_NOTE_MAX) throw new ApiError(400, `Notatka jest za długa (max ${CALENDAR_NOTE_MAX} znaków)`);
  return s;
}

export function getNoteRow(dbx: DbOrTx, id: number): CalendarEventNoteRow | undefined {
  return dbx.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.id, id)).get();
}

/** Autor notatki albo admin może ją edytować/usuwać. */
export function canManageNote(note: Pick<CalendarEventNoteRow, "userId">, user: { id: number; role?: string | null }): boolean {
  return note.userId === user.id || user.role === "admin";
}

export interface AddNoteInput {
  eventId: number;
  text: string;
  ctx: MutationCtx;
  /** Domyślnie "user"; asystent → "assistant" (etykieta „Asystent (kto zatwierdził)”). */
  source?: CalendarNoteSource;
  /** Pliki już zapisane na dysku (src/lib/calendar-attachments.ts storeUploads) — tu tylko wiersze. */
  attachments?: StoredAttachment[];
}

/** Dodaje notatkę do wydarzenia (event musi istnieć i nie być usunięty). */
export function addNote(tx: DbOrTx, input: AddNoteInput): Note {
  const ev = getEventRow(tx, input.eventId);
  if (!ev) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (ev.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
  // Kafelek notatki tylko WSKAZUJE cudzą notatkę — własnego dziennika nie ma (brak rekurencji).
  if (ev.type === "notatka") throw new ApiError(400, "Wydarzenie typu notatka nie może mieć własnych notatek");
  const attachments = input.attachments ?? [];
  const text = parseNoteText(input.text, attachments.length > 0);
  const source = input.source ?? "user";
  const who = userLabelOf(input.ctx.user);
  const userLabel = source === "assistant" ? `Asystent${who ? ` (${who})` : ""}` : source === "system" ? "System" : who;
  const row = tx
    .insert(schema.calendarEventNotes)
    .values({ eventId: ev.id, userId: input.ctx.user.id, userLabel, source, text })
    .returning()
    .get();
  const attRows = attachments.length
    ? tx.insert(schema.calendarNoteAttachments).values(attachments.map((a) => ({ ...a, noteId: row.id }))).returning().all()
    : [];
  const attInfo = attachments.length ? `${text ? " " : ""}(załączniki: ${attachments.length})` : "";
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: input.ctx.user, summarySuffix: input.ctx.summarySuffix,
    action: "note_added", field: "note", newValue: row.id, summary: `Dodano notatkę: ${noteSummary(text)}${attInfo}`,
  });
  // Wzmianki dat w treści (@piątek, @15.09) → kafelki w kalendarzu, w tej samej transakcji.
  syncNoteMentionEvents(tx, row, ev, input.ctx);
  return noteOfRow(row, attRows.map(attachmentOfRow), noteEventLinks(tx, [row.id]).get(row.id));
}

/** Edycja treści notatki (autor lub admin). */
export function updateNote(tx: DbOrTx, noteId: number, rawText: unknown, ctx: MutationCtx): Note {
  const note = getNoteRow(tx, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  if (!canManageNote(note, ctx.user)) throw new ApiError(403, "Tylko autor notatki lub administrator może ją edytować");
  const current = noteWithAttachments(tx, note);
  const text = parseNoteText(rawText, current.attachments.length > 0);
  if (text === note.text) return current;
  const ev = getEventRow(tx, note.eventId);
  const after = tx
    .update(schema.calendarEventNotes)
    .set({ text, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEventNotes.id, noteId))
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: note.eventId, objectId: ev?.objectId ?? null, user: ctx.user, summarySuffix: ctx.summarySuffix,
    action: "note_updated", field: "note", oldValue: noteSummary(note.text), newValue: noteSummary(text), summary: `Zmieniono notatkę: ${noteSummary(text)}`,
  });
  // Wzmianki: nowe → kafelki, usunięte → soft delete; pozostałe kafelki dostają nowy tytuł.
  if (ev && ev.type !== "notatka" && !ev.deletedAt) {
    syncNoteMentionEvents(tx, after, ev, ctx);
    refreshNoteEventTitles(tx, after, ev);
  }
  return noteOfRow(after, current.attachments, noteEventLinks(tx, [after.id]).get(after.id));
}

/** Soft delete notatki (autor lub admin). */
export function deleteNote(tx: DbOrTx, noteId: number, ctx: MutationCtx): void {
  const note = getNoteRow(tx, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  if (!canManageNote(note, ctx.user)) throw new ApiError(403, "Tylko autor notatki lub administrator może ją usunąć");
  const ev = getEventRow(tx, note.eventId);
  tx.update(schema.calendarEventNotes)
    .set({ deletedAt: sql`(datetime('now'))`, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEventNotes.id, noteId))
    .run();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: note.eventId, objectId: ev?.objectId ?? null, user: ctx.user, summarySuffix: ctx.summarySuffix,
    action: "note_deleted", field: "note", oldValue: noteSummary(note.text), summary: `Usunięto notatkę: ${noteSummary(note.text)}`,
  });
  // Kafelki wskazujące tę notatkę nie mają już czego pokazywać — także te podpięte ręcznie.
  for (const tile of noteEventsOfNote(tx, noteId)) {
    softDeleteEventRow(tx, tile, ctx, `Usunięto kafelek notatki — notatka „${noteSummary(note.text, 60)}” została usunięta`);
  }
}
