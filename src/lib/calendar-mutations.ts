/**
 * Mutacje kalendarza — walidacja wejścia (parseInput), tworzenie, pełna aktualizacja (z propagacją
 * na serię), przesunięcie, soft delete, przywrócenie + wpisy activity_log. Jedyne miejsce z tą
 * logiką: trasy (src/routes/calendar.ts) i asystent (POST /assistant/apply-changes) wołają te
 * funkcje wewnątrz własnej transakcji. `MutationCtx.summarySuffix` dopisuje „(przez asystenta)”
 * do KAŻDEGO wpisu activity_log wykonanej zmiany — bez duplikowania logiki logowania.
 *
 * better-sqlite3 jest synchroniczny — wszystkie funkcje są synchroniczne i rzucają ApiError.
 */
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import {
  CALENDAR_EVENT_TYPES,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_SERIES_FREQS,
  type CalendarEvent as CalendarEventRow,
  type CalendarEventType,
  type CalendarEventStatus,
  type CalendarSeriesFreq,
  type CalendarEventNote as CalendarEventNoteRow,
  type CalendarNoteSource,
  CALENDAR_NOTE_MAX,
} from "../db/schema.js";
import { logActivity, logFieldDiffs, userLabelOf, type ActivityUser, type DbOrTx, type Tx } from "./activity-log.js";
import { noteOfRow, type Note } from "./calendar-queries.js";
import { expandOccurrences, describeRule, shiftLocal, diffMinutes, type RecurrenceRule } from "./calendar-recurrence.js";
import { ApiError, STATUS_LABELS, TYPE_LABELS } from "./calendar-labels.js";

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
  realizationId: number | null;
  technicianIds: number[];
  recurrence: RecurrenceRule | null;
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
export function assertRefs(tx: DbOrTx, input: ParsedInput) {
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

function objectNameById(dbx: DbOrTx, id: number | null): string {
  if (id == null) return "—";
  const o = dbx.select({ name: schema.objects.name }).from(schema.objects).where(eq(schema.objects.id, id)).get();
  return o ? o.name : `#${id}`;
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
    ],
  });
}

export function getEventRow(dbx: DbOrTx, id: number): CalendarEventRow | undefined {
  return dbx.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
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

/** Zastosowanie zmian z PUT do jednego wiersza (target lub sibling z deltą dat). */
function applyUpdate(
  tx: Tx,
  row: CalendarEventRow,
  input: ParsedInput,
  dates: { startAt: string; endAt: string; allDay: boolean },
  ctx: MutationCtx
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
      updatedBy: ctx.user.id,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(schema.calendarEvents.id, row.id))
    .returning()
    .get();
  logEventDiff(tx, row, after, ctx);
  syncAssignees(tx, after, input.technicianIds, ctx);
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
        realizationId: input.realizationId,
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
    ids.push(ev.id);
  }
  return { firstId: ids[0], seriesId, occurrencesCount: ids.length };
}

/** Pełna aktualizacja (PUT) z propagacją na serię wg scope. Zwraca id zaktualizowanych wydarzeń. */
export function updateEvent(tx: Tx, id: number, input: ParsedInput, scope: Scope, ctx: MutationCtx): number[] {
  const row = getEventRow(tx, id);
  if (!row) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (row.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
  assertRefs(tx, input);

  const updatedIds = [id];
  applyUpdate(tx, row, input, { startAt: input.startAt, endAt: input.endAt, allDay: input.allDay }, ctx);

  // Delta dat do propagacji na rodzeństwo (zachowują własne daty + ta sama delta)
  const deltaStart = diffMinutes(row.startAt, input.startAt);
  const deltaEnd = diffMinutes(row.endAt, input.endAt);
  for (const sib of seriesSiblings(tx, row, scope)) {
    applyUpdate(tx, sib, input, shiftedDates(sib, deltaStart, deltaEnd, input.allDay), ctx);
    updatedIds.push(sib.id);
  }
  return updatedIds;
}

/** Przesunięcie / zmiana czasu (drag&drop, resize) — tylko daty i allDay. */
export function moveEvent(tx: Tx, id: number, body: Record<string, unknown>, ctx: MutationCtx): CalendarEventRow {
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
    .set({ startAt, endAt, allDay, updatedBy: ctx.user.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, id))
    .returning()
    .get();
  logEventDiff(tx, row, after, ctx);
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

/** Walidacja treści notatki (trim, 1–CALENDAR_NOTE_MAX znaków). Rzuca ApiError. */
export function parseNoteText(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new ApiError(400, "Treść notatki jest wymagana");
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
}

/** Dodaje notatkę do wydarzenia (event musi istnieć i nie być usunięty). */
export function addNote(tx: DbOrTx, input: AddNoteInput): Note {
  const ev = getEventRow(tx, input.eventId);
  if (!ev) throw new ApiError(404, "Wydarzenie nie istnieje");
  if (ev.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
  const text = parseNoteText(input.text);
  const source = input.source ?? "user";
  const who = userLabelOf(input.ctx.user);
  const userLabel = source === "assistant" ? `Asystent${who ? ` (${who})` : ""}` : source === "system" ? "System" : who;
  const row = tx
    .insert(schema.calendarEventNotes)
    .values({ eventId: ev.id, userId: input.ctx.user.id, userLabel, source, text })
    .returning()
    .get();
  logActivity(tx, {
    entityType: CALENDAR_ENTITY, entityId: ev.id, objectId: ev.objectId, user: input.ctx.user, summarySuffix: input.ctx.summarySuffix,
    action: "note_added", field: "note", newValue: row.id, summary: `Dodano notatkę: ${noteSummary(text)}`,
  });
  return noteOfRow(row);
}

/** Edycja treści notatki (autor lub admin). */
export function updateNote(tx: DbOrTx, noteId: number, rawText: unknown, ctx: MutationCtx): Note {
  const note = getNoteRow(tx, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  if (!canManageNote(note, ctx.user)) throw new ApiError(403, "Tylko autor notatki lub administrator może ją edytować");
  const text = parseNoteText(rawText);
  if (text === note.text) return noteOfRow(note);
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
  return noteOfRow(after);
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
}
