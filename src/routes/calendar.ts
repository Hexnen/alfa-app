/**
 * Kalendarz działu technicznego — wydarzenia (serwis/montaż/wizja/...),
 * serie cykliczne (konserwacje), przypisania techników, historia zmian
 * (activity_log) i publiczny feed ICS po tokenie użytkownika.
 *
 * Eksporty:
 *  - default: trasy chronione sesją (montowane pod /calendar po requireAuth)
 *  - calendarPublicRoutes: GET /feed.ics?token=... (montowane PRZED requireAuth)
 */
import { Hono, type Context } from "hono";
import { randomBytes } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, desc, asc, isNull, inArray, sql, lt, gt, gte, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  CALENDAR_EVENT_TYPES,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_SERIES_FREQS,
  type CalendarEvent as CalendarEventRow,
  type CalendarEventType,
  type CalendarEventStatus,
  type CalendarSeriesFreq,
  type User,
} from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import {
  logActivity,
  logFieldDiffs,
  type DbOrTx,
  type Tx,
} from "../lib/activity-log.js";
import {
  expandOccurrences,
  describeRule,
  shiftLocal,
  diffMinutes,
  type RecurrenceRule,
} from "../lib/calendar-recurrence.js";

const app = new Hono();
export const calendarPublicRoutes = new Hono();

const ENTITY = "calendar_event";

// better-sqlite3 jest synchroniczny — callback db.transaction MUSI być
// synchroniczny. Błędy walidacji w transakcji rzucamy jako ApiError.
class ApiError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Etykiety PL (do summary w activity_log i ICS)
// ---------------------------------------------------------------------------

export const TYPE_LABELS: Record<CalendarEventType, string> = {
  serwis: "Serwis",
  montaz: "Montaż",
  wizja: "Wizja lokalna",
  demontaz: "Demontaż",
  biuro: "Biuro",
  przygotowanie: "Przygotowanie",
  konserwacja: "Konserwacja",
  urlop: "Urlop",
};

export const STATUS_LABELS: Record<CalendarEventStatus, string> = {
  planned: "Zaplanowane",
  confirmed: "Potwierdzone",
  done: "Wykonane",
  cancelled: "Anulowane",
};

/** "2026-09-12T08:00" → "12.09.2026 08:00"; "2026-09-12" → "12.09.2026". */
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return s;
  const d = `${m[3]}.${m[2]}.${m[1]}`;
  return m[4] ? `${d} ${m[4]}:${m[5]}` : d;
}

// ---------------------------------------------------------------------------
// Typy JSON (kontrakt z frontendem, camelCase)
// ---------------------------------------------------------------------------

interface TechnicianRef {
  id: number;
  firstName: string;
  lastName: string;
}

interface SeriesRef {
  id: number;
  freq: CalendarSeriesFreq;
  interval: number;
  until: string | null;
  count: number | null;
}

export interface CalendarEventJson {
  id: number;
  type: CalendarEventType;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  department: string;
  objectId: number | null;
  objectName: string | null;
  orderId: number | null;
  realizationId: number | null;
  seriesId: number | null;
  series: SeriesRef | null;
  technicians: TechnicianRef[];
  createdBy: number | null;
  createdByLabel: string | null;
  updatedBy: number | null;
  updatedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Serializacja: wiersze → CalendarEventJson (batch, 4 zapytania)
// ---------------------------------------------------------------------------

const createdUsers = alias(schema.users, "cu");
const updatedUsers = alias(schema.users, "uu");

/** Pobiera i serializuje wydarzenia po id (kolejność wg `ids`). */
function loadEvents(dbx: DbOrTx, ids: number[]): CalendarEventJson[] {
  if (ids.length === 0) return [];
  const rows = dbx
    .select({
      ev: schema.calendarEvents,
      objectName: schema.objects.name,
      createdByEmail: createdUsers.email,
      createdByName: createdUsers.displayName,
      updatedByEmail: updatedUsers.email,
      updatedByName: updatedUsers.displayName,
    })
    .from(schema.calendarEvents)
    .leftJoin(schema.objects, eq(schema.calendarEvents.objectId, schema.objects.id))
    .leftJoin(createdUsers, eq(schema.calendarEvents.createdBy, createdUsers.id))
    .leftJoin(updatedUsers, eq(schema.calendarEvents.updatedBy, updatedUsers.id))
    .where(inArray(schema.calendarEvents.id, ids))
    .all();

  const techRows = dbx
    .select({
      eventId: schema.calendarEventAssignees.eventId,
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
    })
    .from(schema.calendarEventAssignees)
    .innerJoin(
      schema.technicians,
      eq(schema.calendarEventAssignees.technicianId, schema.technicians.id)
    )
    .where(inArray(schema.calendarEventAssignees.eventId, ids))
    .orderBy(asc(schema.technicians.lastName), asc(schema.technicians.firstName))
    .all();
  const techByEvent = new Map<number, TechnicianRef[]>();
  for (const t of techRows) {
    const list = techByEvent.get(t.eventId) ?? [];
    list.push({ id: t.id, firstName: t.firstName, lastName: t.lastName });
    techByEvent.set(t.eventId, list);
  }

  const seriesIds = [...new Set(rows.map((r) => r.ev.seriesId).filter((x): x is number => x != null))];
  const seriesById = new Map<number, SeriesRef>();
  if (seriesIds.length > 0) {
    const sRows = dbx
      .select()
      .from(schema.calendarSeries)
      .where(inArray(schema.calendarSeries.id, seriesIds))
      .all();
    for (const s of sRows) {
      seriesById.set(s.id, {
        id: s.id,
        freq: s.freq,
        interval: s.interval,
        until: s.until,
        count: s.count,
      });
    }
  }

  const label = (email: string | null, name: string | null) =>
    email == null ? null : (name || "").trim() || email;

  const byId = new Map<number, CalendarEventJson>();
  for (const r of rows) {
    const e = r.ev;
    byId.set(e.id, {
      id: e.id,
      type: e.type,
      title: e.title,
      description: e.description,
      location: e.location,
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay,
      status: e.status,
      department: e.department,
      objectId: e.objectId,
      objectName: r.objectName ?? null,
      orderId: e.orderId,
      realizationId: e.realizationId,
      seriesId: e.seriesId,
      series: e.seriesId != null ? (seriesById.get(e.seriesId) ?? null) : null,
      technicians: techByEvent.get(e.id) ?? [],
      createdBy: e.createdBy,
      createdByLabel: label(r.createdByEmail, r.createdByName),
      updatedBy: e.updatedBy,
      updatedByLabel: label(r.updatedByEmail, r.updatedByName),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      deletedAt: e.deletedAt,
    });
  }
  return ids.map((id) => byId.get(id)).filter((x): x is CalendarEventJson => !!x);
}

function loadEvent(dbx: DbOrTx, id: number): CalendarEventJson | null {
  return loadEvents(dbx, [id])[0] ?? null;
}

// ---------------------------------------------------------------------------
// Walidacja wejścia
// ---------------------------------------------------------------------------

interface ParsedInput {
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
  realizationId: number | null;
  technicianIds: number[];
  recurrence: RecurrenceRule | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  if (m[4] && (+m[4] > 23 || +m[5] > 59)) return false;
  return true;
}

/** Normalizuje datę do formatu kontraktu (all-day: YYYY-MM-DD, inaczej YYYY-MM-DDTHH:MM). */
function normDate(raw: unknown, allDay: boolean, field: string): string {
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

/** Walidacja CalendarEventInput (bez sprawdzania istnienia referencji — to w transakcji). */
function parseInput(body: unknown): ParsedInput {
  if (!body || typeof body !== "object") throw new ApiError(400, "Nieprawidłowe dane wejściowe");
  const b = body as Record<string, unknown>;

  if (!CALENDAR_EVENT_TYPES.includes(b.type as CalendarEventType)) {
    throw new ApiError(400, `Pole type: dozwolone ${CALENDAR_EVENT_TYPES.join(", ")}`);
  }
  const type = b.type as CalendarEventType;
  const isUrlop = type === "urlop";
  const title = typeof b.title === "string" ? b.title.trim() : "";
  // Urlop: tytuł opcjonalny (generowany z nazwiska technika w transakcji)
  if (!title && !isUrlop) throw new ApiError(400, "Tytuł jest wymagany");
  if (title.length > 300) throw new ApiError(400, "Tytuł jest za długi (max 300 znaków)");

  // Urlop: domyślnie cały dzień (chyba że klient jawnie poda allDay=false)
  const allDay = isUrlop
    ? !(b.allDay === false || b.allDay === 0 || b.allDay === "0" || b.allDay === "false")
    : b.allDay === true || b.allDay === 1 || b.allDay === "1" || b.allDay === "true";
  const startAt = normDate(b.startAt, allDay, "startAt");
  let endAt = normDate(b.endAt ?? b.startAt, allDay, "endAt");
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
  if (b.technicianIds != null) {
    if (!Array.isArray(b.technicianIds)) throw new ApiError(400, "Pole technicianIds: oczekiwano tablicy");
    technicianIds = [...new Set(b.technicianIds.map((x) => optInt(x, "technicianIds")!))];
  }
  if (isUrlop && technicianIds.length === 0) throw new ApiError(400, "Urlop wymaga wskazania technika");

  return {
    type,
    title,
    description: optText(b.description),
    // Urlop nie dotyczy obiektu ani lokalizacji — ignorujemy te pola
    location: isUrlop ? null : optText(b.location),
    startAt,
    endAt,
    allDay,
    status,
    objectId: isUrlop ? null : optInt(b.objectId, "objectId"),
    orderId: isUrlop ? null : optInt(b.orderId, "orderId"),
    realizationId: isUrlop ? null : optInt(b.realizationId, "realizationId"),
    technicianIds,
    recurrence: parseRecurrence(b.recurrence),
  };
}

/** Sprawdza istnienie referencji (obiekt, zlecenie, realizacja, technicy). Rzuca ApiError. */
function assertRefs(tx: DbOrTx, input: ParsedInput) {
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
function resolveTitle(dbx: DbOrTx, input: ParsedInput): string {
  if (input.title || input.type !== "urlop") return input.title;
  return `Urlop — ${input.technicianIds.map((id) => techName(dbx, id)).join(", ")}`.slice(0, 300);
}

function techName(dbx: DbOrTx, id: number): string {
  const t = dbx
    .select({ firstName: schema.technicians.firstName, lastName: schema.technicians.lastName })
    .from(schema.technicians)
    .where(eq(schema.technicians.id, id))
    .get();
  return t ? `${t.firstName} ${t.lastName}`.trim() : `#${id}`;
}

function objectName(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get();
  return o ? o.name : `#${id}`;
}

function currentAssignees(dbx: DbOrTx, eventId: number): number[] {
  return dbx
    .select({ id: schema.calendarEventAssignees.technicianId })
    .from(schema.calendarEventAssignees)
    .where(eq(schema.calendarEventAssignees.eventId, eventId))
    .all()
    .map((r) => r.id);
}

/** Ustawia zbiór techników wydarzenia; loguje assigned/unassigned per technik. */
function syncAssignees(tx: Tx, ev: CalendarEventRow, technicianIds: number[], user: User) {
  const before = currentAssignees(tx, ev.id);
  const toAdd = technicianIds.filter((id) => !before.includes(id));
  const toRemove = before.filter((id) => !technicianIds.includes(id));
  for (const id of toRemove) {
    tx.delete(schema.calendarEventAssignees)
      .where(and(eq(schema.calendarEventAssignees.eventId, ev.id), eq(schema.calendarEventAssignees.technicianId, id)))
      .run();
    logActivity(tx, {
      entityType: ENTITY, entityId: ev.id, objectId: ev.objectId, user,
      action: "unassigned", field: "technician", oldValue: id, newValue: null,
      summary: `Odpisano technika: ${techName(tx, id)}`,
    });
  }
  for (const id of toAdd) {
    tx.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
    logActivity(tx, {
      entityType: ENTITY, entityId: ev.id, objectId: ev.objectId, user,
      action: "assigned", field: "technician", oldValue: null, newValue: id,
      summary: `Przypisano technika: ${techName(tx, id)}`,
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/** Loguje diff pól (bez dat i bez statusu — te mają własne akcje) + moved + status_changed. */
function logEventDiff(tx: Tx, before: CalendarEventRow, after: CalendarEventRow, user: User) {
  const ctx = { entityType: ENTITY, entityId: after.id, objectId: after.objectId, user };
  // Przesunięcie / zmiana czasu
  if (before.startAt !== after.startAt || before.endAt !== after.endAt || before.allDay !== after.allDay) {
    const fromS = before.allDay ? `${fmtDate(before.startAt)} (cały dzień)` : `${fmtDate(before.startAt)}–${fmtDate(before.endAt)}`;
    const toS = after.allDay ? `${fmtDate(after.startAt)} (cały dzień)` : `${fmtDate(after.startAt)}–${fmtDate(after.endAt)}`;
    if (before.startAt !== after.startAt) {
      // Przesunięcie (drag&drop / zmiana daty) — jeden wpis z pełnym opisem
      logActivity(tx, {
        ...ctx, action: "moved", field: "start_at",
        oldValue: before.startAt, newValue: after.startAt,
        summary: `Przesunięto z ${fromS} na ${toS}`,
      });
    } else {
      // Sam koniec (resize) — osobny wpis z czytelnym opisem
      logActivity(tx, {
        ...ctx, action: "moved", field: "end_at",
        oldValue: before.endAt, newValue: after.endAt,
        summary: `Zmieniono koniec z ${fmtDate(before.endAt)} na ${fmtDate(after.endAt)}`,
      });
    }
    if (before.allDay !== after.allDay) {
      logActivity(tx, { ...ctx, action: "updated", field: "all_day", oldValue: before.allDay, newValue: after.allDay, summary: after.allDay ? "Ustawiono: cały dzień" : "Wyłączono: cały dzień" });
    }
  }
  // Status
  if (before.status !== after.status) {
    logActivity(tx, {
      ...ctx, action: "status_changed", field: "status",
      oldValue: before.status, newValue: after.status,
      summary: `Zmieniono status: ${STATUS_LABELS[before.status]} → ${STATUS_LABELS[after.status]}`,
    });
  }
  // Pozostałe pola
  logFieldDiffs(tx, {
    ...ctx,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
    fields: [
      { key: "title", label: "tytuł" },
      { key: "type", label: "typ", format: (v) => TYPE_LABELS[v as CalendarEventType] ?? String(v) },
      { key: "location", label: "lokalizację" },
      { key: "description", label: "opis", format: (v) => (v ? String(v).slice(0, 60) + (String(v).length > 60 ? "…" : "") : "—") },
      { key: "objectId", label: "obiekt", format: (v) => objectName(tx, (v as number | null) ?? null) },
      { key: "orderId", label: "zlecenie", format: (v) => (v == null ? "—" : `#${v}`) },
      { key: "realizationId", label: "realizację", format: (v) => (v == null ? "—" : `#${v}`) },
    ],
  });
}

function getEventRow(dbx: DbOrTx, id: number): CalendarEventRow | undefined {
  return dbx.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
}

type Scope = "this" | "future" | "all";
function parseScope(raw: string | undefined): Scope {
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

/** Zastosowanie zmian z PUT do jednego wiersza (target lub sibling z deltą dat). */
function applyUpdate(
  tx: Tx,
  row: CalendarEventRow,
  input: ParsedInput,
  dates: { startAt: string; endAt: string; allDay: boolean },
  user: User
): CalendarEventRow {
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
      realizationId: input.realizationId,
      updatedBy: user.id,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.calendarEvents.id, row.id))
    .returning()
    .get();
  logEventDiff(tx, row, after, user);
  syncAssignees(tx, after, input.technicianIds, user);
  return after;
}

/** Daty siblinga po zastosowaniu delty (start/end osobno) i ewentualnej zmiany allDay. */
function shiftedDates(
  sib: CalendarEventRow,
  deltaStart: number,
  deltaEnd: number,
  allDay: boolean
): { startAt: string; endAt: string; allDay: boolean } {
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

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Error in calendar ${what}:`, error);
  return c.json({ success: false, error: `Błąd: ${what}` }, 500);
}

function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

// ---------------------------------------------------------------------------
// GET /events — lista po zakresie [from, to) + filtry
// ---------------------------------------------------------------------------

app.get("/events", (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (from && !DATE_RE.test(from)) throw new ApiError(400, "Parametr from: YYYY-MM-DD");
    if (to && !DATE_RE.test(to)) throw new ApiError(400, "Parametr to: YYYY-MM-DD");

    const types = (c.req.query("type") || "").split(",").map((s) => s.trim()).filter(Boolean) as CalendarEventType[];
    const statuses = (c.req.query("status") || "").split(",").map((s) => s.trim()).filter(Boolean) as CalendarEventStatus[];
    const technicianIds = parseIdList(c.req.query("technicianId"));
    const objectId = c.req.query("objectId") ? Number(c.req.query("objectId")) : null;
    const includeDeleted = c.req.query("includeDeleted") === "1" || c.req.query("includeDeleted") === "true";

    const conds = [];
    if (!includeDeleted) conds.push(isNull(schema.calendarEvents.deletedAt));
    // Nachodzenie na zakres: start < to AND end > from (porównanie leksykalne ISO działa
    // także między "YYYY-MM-DD" a "YYYY-MM-DDTHH:MM").
    if (from) conds.push(gt(schema.calendarEvents.endAt, from));
    if (to) conds.push(lt(schema.calendarEvents.startAt, to));
    if (types.length) conds.push(inArray(schema.calendarEvents.type, types));
    if (statuses.length) conds.push(inArray(schema.calendarEvents.status, statuses));
    if (objectId != null && Number.isInteger(objectId)) conds.push(eq(schema.calendarEvents.objectId, objectId));
    if (technicianIds.length) {
      conds.push(
        sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`
      );
    }

    const ids = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
      .limit(2000)
      .all()
      .map((r) => r.id);

    return c.json({ success: true, data: loadEvents(db, ids) });
  } catch (error) {
    return handleError(c, error, "pobierania wydarzeń");
  }
});

// ---------------------------------------------------------------------------
// GET /events/:id — szczegóły + historia
// ---------------------------------------------------------------------------

app.get("/events/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  const ev = loadEvent(db, id);
  if (!ev) return c.json({ success: false, error: "Wydarzenie nie istnieje" }, 404);
  const history = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, ENTITY), eq(schema.activityLog.entityId, id)))
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(500)
    .all();
  return c.json({ success: true, data: { ...ev, history } });
});

// ---------------------------------------------------------------------------
// POST /events — utworzenie (opcjonalnie serii)
// ---------------------------------------------------------------------------

app.post("/events", async (c) => {
  const user = getUser(c);
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseInput(body);

    const result = db.transaction((tx) => {
      assertRefs(tx, input);

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
            createdBy: user.id,
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
            realizationId: input.realizationId,
            seriesId,
            createdBy: user.id,
            updatedBy: user.id,
          })
          .returning()
          .get();
        for (const tid of input.technicianIds) {
          tx.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: tid }).run();
        }
        logActivity(tx, {
          entityType: ENTITY, entityId: ev.id, objectId: ev.objectId, user,
          action: "created",
          summary: seriesId != null
            ? `Utworzono w ramach serii #${seriesId} (${seriesLabel})`
            : `Utworzono wydarzenie „${ev.title}” (${TYPE_LABELS[ev.type]}, ${fmtDate(ev.startAt)})`,
        });
        ids.push(ev.id);
      }
      return { firstId: ids[0], seriesId, occurrencesCount: ids.length };
    });

    const first = loadEvent(db, result.firstId)!;
    return c.json(
      { success: true, data: { ...first, seriesId: result.seriesId, occurrencesCount: result.occurrencesCount } },
      201
    );
  } catch (error) {
    return handleError(c, error, "tworzenia wydarzenia");
  }
});

// ---------------------------------------------------------------------------
// PUT /events/:id?scope=this|future|all — pełna aktualizacja
// ---------------------------------------------------------------------------

app.put("/events/:id", async (c) => {
  const user = getUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  const scope = parseScope(c.req.query("scope"));
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseInput(body);

    const affected = db.transaction((tx) => {
      const row = getEventRow(tx, id);
      if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
      if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
      assertRefs(tx, input);

      const updatedIds = [id];
      applyUpdate(tx, row, input, { startAt: input.startAt, endAt: input.endAt, allDay: input.allDay }, user);

      // Delta dat do propagacji na rodzeństwo (zachowują własne daty + ta sama delta)
      const deltaStart = diffMinutes(row.startAt, input.startAt);
      const deltaEnd = diffMinutes(row.endAt, input.endAt);
      for (const sib of seriesSiblings(tx, row, scope)) {
        applyUpdate(tx, sib, input, shiftedDates(sib, deltaStart, deltaEnd, input.allDay), user);
        updatedIds.push(sib.id);
      }
      return updatedIds;
    });

    const ev = loadEvent(db, id)!;
    return c.json({ success: true, data: { ...ev, affectedCount: affected.length, affectedIds: affected } });
  } catch (error) {
    return handleError(c, error, "aktualizacji wydarzenia");
  }
});

// ---------------------------------------------------------------------------
// PATCH /events/:id/move — drag&drop / resize
// ---------------------------------------------------------------------------

app.patch("/events/:id/move", async (c) => {
  const user = getUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "Nieprawidłowe dane wejściowe");

    db.transaction((tx) => {
      const row = getEventRow(tx, id);
      if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
      if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte");

      const allDay = body.allDay == null ? row.allDay : body.allDay === true || body.allDay === 1 || body.allDay === "true";
      const startAt = normDate(body.startAt ?? row.startAt, allDay, "startAt");
      let endAt = normDate(body.endAt ?? (allDay ? startAt : shiftLocal(startAt, Math.max(30, diffMinutes(row.startAt, row.endAt)), false)), allDay, "endAt");
      if (allDay) {
        if (endAt <= startAt) endAt = shiftLocal(startAt, 24 * 60, true);
      } else if (endAt <= startAt) {
        throw new ApiError(400, "Koniec musi być późniejszy niż początek");
      }

      const after = tx
        .update(schema.calendarEvents)
        .set({ startAt, endAt, allDay, updatedBy: user.id, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.calendarEvents.id, id))
        .returning()
        .get();
      logEventDiff(tx, row, after, user);
    });

    return c.json({ success: true, data: loadEvent(db, id) });
  } catch (error) {
    return handleError(c, error, "przesuwania wydarzenia");
  }
});

// ---------------------------------------------------------------------------
// DELETE /events/:id?scope=... — soft delete; POST /events/:id/restore
// ---------------------------------------------------------------------------

app.delete("/events/:id", (c) => {
  const user = getUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  const scope = parseScope(c.req.query("scope"));
  try {
    const deletedIds = db.transaction((tx) => {
      const row = getEventRow(tx, id);
      if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
      if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest już usunięte");
      const targets = [row, ...seriesSiblings(tx, row, scope)];
      for (const t of targets) {
        tx.update(schema.calendarEvents)
          .set({ deletedAt: sql`(datetime('now'))`, updatedBy: user.id, updatedAt: sql`(datetime('now'))` })
          .where(eq(schema.calendarEvents.id, t.id))
          .run();
        logActivity(tx, {
          entityType: ENTITY, entityId: t.id, objectId: t.objectId, user, action: "deleted",
          summary: `Usunięto wydarzenie „${t.title}” (${fmtDate(t.startAt)})${scope !== "this" ? ` — zakres: ${scope === "all" ? "cała seria" : "to i kolejne"}` : ""}`,
        });
      }
      return targets.map((t) => t.id);
    });
    return c.json({ success: true, data: { id, deletedIds, deletedCount: deletedIds.length } });
  } catch (error) {
    return handleError(c, error, "usuwania wydarzenia");
  }
});

app.post("/events/:id/restore", (c) => {
  const user = getUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    db.transaction((tx) => {
      const row = getEventRow(tx, id);
      if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
      if (!row.deletedAt) throw new ApiError(409, "Wydarzenie nie jest usunięte");
      tx.update(schema.calendarEvents)
        .set({ deletedAt: null, updatedBy: user.id, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.calendarEvents.id, id))
        .run();
      logActivity(tx, {
        entityType: ENTITY, entityId: id, objectId: row.objectId, user, action: "restored",
        summary: `Przywrócono wydarzenie „${row.title}” (${fmtDate(row.startAt)})`,
      });
    });
    return c.json({ success: true, data: loadEvent(db, id) });
  } catch (error) {
    return handleError(c, error, "przywracania wydarzenia");
  }
});

// ---------------------------------------------------------------------------
// GET /conflicts — kolizje techników w zakresie
// ---------------------------------------------------------------------------

app.get("/conflicts", (c) => {
  try {
    const technicianIds = parseIdList(c.req.query("technicianIds"));
    const startAt = (c.req.query("startAt") || "").trim();
    const endAt = (c.req.query("endAt") || "").trim();
    const excludeId = c.req.query("excludeId") ? Number(c.req.query("excludeId")) : null;
    if (technicianIds.length === 0 || !startAt || !endAt) {
      return c.json({ success: true, data: [] });
    }
    const conds = [
      isNull(schema.calendarEvents.deletedAt),
      ne(schema.calendarEvents.status, "cancelled"),
      lt(schema.calendarEvents.startAt, endAt),
      gt(schema.calendarEvents.endAt, startAt),
      sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`,
    ];
    if (excludeId != null && Number.isInteger(excludeId)) conds.push(ne(schema.calendarEvents.id, excludeId));
    const ids = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(and(...conds))
      .orderBy(asc(schema.calendarEvents.startAt))
      .limit(200)
      .all()
      .map((r) => r.id);
    // conflictKind: "urlop" = technik na urlopie (osobny komunikat na froncie), "event" = zwykła kolizja
    const data = loadEvents(db, ids).map((e) => ({ ...e, conflictKind: e.type === "urlop" ? "urlop" : "event" }));
    return c.json({ success: true, data });
  } catch (error) {
    return handleError(c, error, "sprawdzania kolizji");
  }
});

// ---------------------------------------------------------------------------
// GET /availability?from&to — przedziały urlopów per technik w zakresie [from, to)
// ---------------------------------------------------------------------------

app.get("/availability", (c) => {
  try {
    const from = (c.req.query("from") || "").trim();
    const to = (c.req.query("to") || "").trim();
    if (!from || !to) throw new ApiError(400, "Parametry from i to są wymagane");
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
      throw new ApiError(400, "Parametry from/to: oczekiwano daty YYYY-MM-DD lub YYYY-MM-DDTHH:MM");
    }
    const rows = db
      .select({
        eventId: schema.calendarEvents.id,
        title: schema.calendarEvents.title,
        startAt: schema.calendarEvents.startAt,
        endAt: schema.calendarEvents.endAt,
        allDay: schema.calendarEvents.allDay,
        status: schema.calendarEvents.status,
        technicianId: schema.technicians.id,
        firstName: schema.technicians.firstName,
        lastName: schema.technicians.lastName,
      })
      .from(schema.calendarEvents)
      .innerJoin(schema.calendarEventAssignees, eq(schema.calendarEventAssignees.eventId, schema.calendarEvents.id))
      .innerJoin(schema.technicians, eq(schema.technicians.id, schema.calendarEventAssignees.technicianId))
      .where(
        and(
          eq(schema.calendarEvents.type, "urlop"),
          isNull(schema.calendarEvents.deletedAt),
          ne(schema.calendarEvents.status, "cancelled"),
          lt(schema.calendarEvents.startAt, to),
          gt(schema.calendarEvents.endAt, from)
        )
      )
      .orderBy(asc(schema.technicians.lastName), asc(schema.technicians.firstName), asc(schema.calendarEvents.startAt))
      .limit(2000)
      .all();

    const byTech = new Map<number, {
      technicianId: number; firstName: string; lastName: string;
      leaves: { eventId: number; title: string; startAt: string; endAt: string; allDay: boolean; status: CalendarEventStatus }[];
    }>();
    for (const r of rows) {
      let entry = byTech.get(r.technicianId);
      if (!entry) {
        entry = { technicianId: r.technicianId, firstName: r.firstName, lastName: r.lastName, leaves: [] };
        byTech.set(r.technicianId, entry);
      }
      entry.leaves.push({ eventId: r.eventId, title: r.title, startAt: r.startAt, endAt: r.endAt, allDay: r.allDay, status: r.status });
    }
    return c.json({ success: true, data: [...byTech.values()] });
  } catch (error) {
    return handleError(c, error, "pobierania dostępności");
  }
});

// ---------------------------------------------------------------------------
// GET /objects/:objectId/events — wydarzenia obiektu (karta obiektu)
// ---------------------------------------------------------------------------

app.get("/objects/:objectId/events", (c) => {
  const objectId = Number(c.req.param("objectId"));
  if (!Number.isInteger(objectId)) return c.json({ success: false, error: "Nieprawidłowe id obiektu" }, 400);
  const ids = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.objectId, objectId), isNull(schema.calendarEvents.deletedAt)))
    .orderBy(desc(schema.calendarEvents.startAt), desc(schema.calendarEvents.id))
    .limit(1000)
    .all()
    .map((r) => r.id);
  return c.json({ success: true, data: loadEvents(db, ids) });
});

// ---------------------------------------------------------------------------
// Feed ICS: POST /feed-token (chronione) + GET /feed.ics?token= (publiczne)
// ---------------------------------------------------------------------------

function feedUrl(c: { req: { url: string } }, token: string): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/api/calendar/feed.ics?token=${token}`;
}

app.post("/feed-token", (c) => {
  const user = getUser(c);
  const token = randomBytes(24).toString("hex");
  db.update(schema.users).set({ calendarToken: token }).where(eq(schema.users.id, user.id)).run();
  return c.json({ success: true, data: { token, url: feedUrl(c, token) } });
});

app.get("/feed-token", (c) => {
  const user = getUser(c);
  const row = db.select({ token: schema.users.calendarToken }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  const token = row?.token ?? null;
  return c.json({ success: true, data: token ? { token, url: feedUrl(c, token) } : null });
});

/** Escapowanie tekstu wg RFC 5545 (przecinki, średniki, backslash, nowe linie). */
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Składanie linii ICS z foldingiem (max 75 oktetów; kontynuacja = spacja). */
function icsLine(name: string, value: string): string {
  const raw = `${name}:${value}`;
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= 75) return raw;
  const out: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  const limit = () => (out.length === 0 ? 75 : 74);
  for (const ch of raw) {
    const b = Buffer.byteLength(ch, "utf8");
    if (chunkBytes + b > limit()) {
      out.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += b;
  }
  if (chunk) out.push(chunk);
  return out.map((l, i) => (i === 0 ? l : " " + l)).join("\r\n");
}

/** "2026-09-12T08:00" → "20260912T080000" (czas lokalny, floating); "2026-09-12" → "20260912". */
function icsDate(s: string, allDay: boolean): string {
  const d = s.slice(0, 10).replace(/-/g, "");
  if (allDay) return d;
  const t = (s.slice(11, 16) || "00:00").replace(":", "");
  return `${d}T${t}00`;
}

function icsStamp(iso: string): string {
  // created_at/updated_at z SQLite: "YYYY-MM-DD HH:MM:SS" (UTC)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
}

export function buildIcs(events: CalendarEventJson[], host: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alfa App//Kalendarz techniczny//PL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsLine("X-WR-CALNAME", "Alfa — kalendarz techniczny"),
    "X-WR-TIMEZONE:Europe/Warsaw",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(icsLine("UID", `alfa-calendar-${e.id}@${host}`));
    lines.push(icsLine("DTSTAMP", icsStamp(e.updatedAt)));
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startAt, true)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(e.endAt, true)}`);
    } else {
      lines.push(`DTSTART:${icsDate(e.startAt, false)}`);
      lines.push(`DTEND:${icsDate(e.endAt, false)}`);
    }
    const techNames = e.technicians.map((t) => `${t.firstName} ${t.lastName}`.trim()).join(", ");
    const summary = e.type === "urlop"
      ? `Urlop: ${techNames || e.title.replace(/^Urlop\s*[—-]\s*/i, "")}`
      : `[${TYPE_LABELS[e.type]}] ${e.title}${e.objectName ? ` — ${e.objectName}` : ""}`;
    lines.push(icsLine("SUMMARY", icsEscape(summary)));
    const descParts: string[] = [];
    if (e.description) descParts.push(e.description);
    if (e.technicians.length) descParts.push(`Technicy: ${e.technicians.map((t) => `${t.firstName} ${t.lastName}`.trim()).join(", ")}`);
    descParts.push(`Status: ${STATUS_LABELS[e.status]}`);
    if (e.series) descParts.push(`Seria #${e.series.id}: ${describeRule(e.series)}`);
    lines.push(icsLine("DESCRIPTION", icsEscape(descParts.join("\n"))));
    if (e.location) lines.push(icsLine("LOCATION", icsEscape(e.location)));
    lines.push(`STATUS:${e.status === "planned" ? "TENTATIVE" : "CONFIRMED"}`);
    lines.push(icsLine("CATEGORIES", icsEscape(TYPE_LABELS[e.type])));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

calendarPublicRoutes.get("/feed.ics", (c) => {
  const token = (c.req.query("token") || "").trim();
  if (!token || token.length < 16) return c.text("Brak tokenu", 401);
  const user = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.calendarToken, token))
    .get();
  if (!user) return c.text("Nieprawidłowy token", 401);

  // Przyszłe + ostatnie 90 dni, nie-cancelled, nie usunięte.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const ids = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        gte(schema.calendarEvents.endAt, since)
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(5000)
    .all()
    .map((r) => r.id);
  const events = loadEvents(db, ids);
  const host = new URL(c.req.url).host || "alfa";
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Content-Disposition", 'inline; filename="alfa-kalendarz.ics"');
  c.header("Cache-Control", "no-cache");
  return c.body(buildIcs(events, host));
});

export default app;
