/**
 * Wspólne zapytania kalendarza (kolizje, technicy, serializacja wydarzeń) — używane przez trasy
 * (src/routes/calendar.ts), mutacje (calendar-mutations.ts)
 * i narzędzia asystenta AI (src/lib/ai/calendarTools.ts). Zachowanie 1:1 z
 * dotychczasowym GET /calendar/conflicts.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db, schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";
import type { CalendarBilling, CalendarEventNote, CalendarEventStatus, CalendarEventType, CalendarNoteSource, CalendarSeriesFreq } from "../db/schema.js";

/**
 * Id wydarzeń kolidujących z zakresem [startAt, endAt) dla podanych techników
 * (bez usuniętych i anulowanych; opcjonalnie z pominięciem edytowanego eventu).
 * Porównanie leksykalne ISO działa też między "YYYY-MM-DD" a "YYYY-MM-DDTHH:MM".
 */
export function conflictEventIds(
  dbx: DbOrTx,
  params: { technicianIds: number[]; startAt: string; endAt: string; excludeId?: number | null }
): number[] {
  const { technicianIds, startAt, endAt, excludeId } = params;
  if (technicianIds.length === 0 || !startAt || !endAt) return [];
  const conds = [
    isNull(schema.calendarEvents.deletedAt),
    ne(schema.calendarEvents.status, "cancelled"),
    lt(schema.calendarEvents.startAt, endAt),
    gt(schema.calendarEvents.endAt, startAt),
    sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`,
  ];
  if (excludeId != null && Number.isInteger(excludeId)) conds.push(ne(schema.calendarEvents.id, excludeId));
  return dbx
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(...conds))
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(200)
    .all()
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Technicy — wspólne dla promptu asystenta (calendarPrompt/calendarTools) i tras
// ---------------------------------------------------------------------------

export interface TechnicianBrief {
  id: number;
  name: string;
  active: boolean;
}

/** "Jan Kowalski" z wiersza technika (trim — puste nazwisko nie zostawia spacji). */
export function techName(t: { firstName: string; lastName: string }): string {
  return `${t.firstName} ${t.lastName}`.trim();
}

const foldName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Technik odpowiadający zalogowanemu użytkownikowi (asystent: „ja/mnie/jestem” = ten technik).
 * Dopasowanie po `users.displayName` ↔ „imię nazwisko” technika (bez rozróżniania wielkości liter,
 * także „nazwisko imię”). Gdy displayName to samo imię — jedyny AKTYWNY technik o tym imieniu.
 * Brak / niejednoznaczne → null.
 */
export function findTechnicianForUser(user: { displayName?: string | null }, dbx: DbOrTx = db): TechnicianBrief | null {
  const raw = foldName(user.displayName || "");
  if (!raw) return null;
  const techs = dbx
    .select({ id: schema.technicians.id, firstName: schema.technicians.firstName, lastName: schema.technicians.lastName, active: schema.technicians.active })
    .from(schema.technicians)
    .all();
  const brief = (t: (typeof techs)[number]): TechnicianBrief => ({ id: t.id, name: techName(t), active: t.active });
  const full = techs.filter((t) => {
    const f = foldName(t.firstName);
    const l = foldName(t.lastName);
    return raw === foldName(`${f} ${l}`) || (l !== "" && raw === foldName(`${l} ${f}`));
  });
  if (full.length === 1) return brief(full[0]);
  if (full.length > 1) {
    const active = full.filter((t) => t.active);
    return active.length === 1 ? brief(active[0]) : null;
  }
  if (raw.includes(" ")) return null;
  const byFirst = techs.filter((t) => t.active && foldName(t.firstName) === raw);
  return byFirst.length === 1 ? brief(byFirst[0]) : null;
}

/**
 * Wszyscy technicy (aktywni najpierw, potem po nazwisku) w kształcie dla promptu
 * i narzędzi asystenta. Nazwa historyczna: lista zawiera też nieaktywnych (flaga `active`),
 * bo model musi umieć powiedzieć „ten technik jest nieaktywny” zamiast „nie znam”.
 */
export function listActiveTechnicians(dbx: DbOrTx = db): TechnicianBrief[] {
  return dbx
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      active: schema.technicians.active,
    })
    .from(schema.technicians)
    .orderBy(desc(schema.technicians.active), asc(schema.technicians.lastName), asc(schema.technicians.firstName))
    .all()
    .map((t) => ({ id: t.id, name: techName(t), active: t.active }));
}

// ---------------------------------------------------------------------------
// Serializacja wydarzeń: wiersze → CalendarEventJson (batch, 4 zapytania).
// Wspólne dla tras kalendarza, narzędzi asystenta i mutacji (calendar-mutations.ts).
// ---------------------------------------------------------------------------

export interface TechnicianRef {
  id: number;
  firstName: string;
  lastName: string;
}

export interface SeriesRef {
  id: number;
  freq: CalendarSeriesFreq;
  interval: number;
  until: string | null;
  count: number | null;
}

/** Skrót protokołu wydarzenia (jawnie przypięty `protocolId` albo protokół realizacji). */
export interface ProtocolRef {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
  workDate: string;
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
  /** Rozliczenie: warranty | free | paid | null (nie dotyczy). */
  billing: CalendarBilling | null;
  /** Jawnie przypięty protokół (NULL → protokół realizacji, jeśli jest). */
  protocolId: number | null;
  /** Wyliczone: protokół z `protocolId`, a gdy brak — protokół realizacji (`realizationId`). */
  protocol: ProtocolRef | null;
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
  /** Liczba nieusuniętych notatek (dziennik wydarzenia). */
  notesCount: number;
}

/** Notatka wydarzenia (kontrakt z frontem: CalendarNote). */
export interface Note {
  id: number;
  eventId: number;
  userId: number | null;
  userLabel: string | null;
  source: CalendarNoteSource;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export function noteOfRow(r: CalendarEventNote): Note {
  return { id: r.id, eventId: r.eventId, userId: r.userId, userLabel: r.userLabel, source: r.source, text: r.text, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

/** Nieusunięte notatki wydarzenia, od najstarszej (dziennik). */
export function loadNotes(dbx: DbOrTx, eventId: number, limit = 500): Note[] {
  return dbx
    .select()
    .from(schema.calendarEventNotes)
    .where(and(eq(schema.calendarEventNotes.eventId, eventId), isNull(schema.calendarEventNotes.deletedAt)))
    .orderBy(asc(schema.calendarEventNotes.createdAt), asc(schema.calendarEventNotes.id))
    .limit(limit)
    .all()
    .map(noteOfRow);
}

/** Liczba nieusuniętych notatek per wydarzenie — jedno zapytanie zbiorcze. */
export function notesCountByEvent(dbx: DbOrTx, ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = dbx
    .select({ eventId: schema.calendarEventNotes.eventId, n: sql<number>`count(*)` })
    .from(schema.calendarEventNotes)
    .where(and(inArray(schema.calendarEventNotes.eventId, ids), isNull(schema.calendarEventNotes.deletedAt)))
    .groupBy(schema.calendarEventNotes.eventId)
    .all();
  for (const r of rows) out.set(r.eventId, Number(r.n));
  return out;
}

const createdUsers = alias(schema.users, "cu");
const updatedUsers = alias(schema.users, "uu");

/** Pobiera i serializuje wydarzenia po id (kolejność wg `ids`; usunięte też — filtr robi wołający). */
export function loadEvents(dbx: DbOrTx, ids: number[]): CalendarEventJson[] {
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
    .innerJoin(schema.technicians, eq(schema.calendarEventAssignees.technicianId, schema.technicians.id))
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
    const sRows = dbx.select().from(schema.calendarSeries).where(inArray(schema.calendarSeries.id, seriesIds)).all();
    for (const s of sRows) {
      seriesById.set(s.id, { id: s.id, freq: s.freq, interval: s.interval, until: s.until, count: s.count });
    }
  }

  // Protokoły: jawne (protocol_id) + z realizacji (realization_id → protocols.realization_id), jedno zapytanie.
  const protoIds = [...new Set(rows.map((r) => r.ev.protocolId).filter((x): x is number => x != null))];
  const realIds = [...new Set(rows.map((r) => r.ev.realizationId).filter((x): x is number => x != null))];
  const protoById = new Map<number, ProtocolRef>();
  const protoByReal = new Map<number, ProtocolRef>();
  if (protoIds.length > 0 || realIds.length > 0) {
    const pConds = [];
    if (protoIds.length) pConds.push(inArray(schema.protocols.id, protoIds));
    if (realIds.length) pConds.push(inArray(schema.protocols.realizationId, realIds));
    const pRows = dbx
      .select({ id: schema.protocols.id, realizationId: schema.protocols.realizationId, number: schema.protocols.number, status: schema.protocols.status, signedAt: schema.protocols.signedAt, workDate: schema.protocols.workDate })
      .from(schema.protocols)
      .where(pConds.length === 1 ? pConds[0] : sql`${pConds[0]} OR ${pConds[1]}`)
      .all();
    for (const p of pRows) {
      const ref: ProtocolRef = { id: p.id, number: p.number, status: p.status, signedAt: p.signedAt, workDate: p.workDate };
      protoById.set(p.id, ref);
      protoByReal.set(p.realizationId, ref);
    }
  }

  const notesCount = notesCountByEvent(dbx, ids);
  const label = (email: string | null, name: string | null) => (email == null ? null : (name || "").trim() || email);

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
      billing: e.billing,
      protocolId: e.protocolId,
      protocol: (e.protocolId != null ? protoById.get(e.protocolId) : null) ?? (e.realizationId != null ? protoByReal.get(e.realizationId) : null) ?? null,
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
      notesCount: notesCount.get(e.id) ?? 0,
    });
  }
  return ids.map((id) => byId.get(id)).filter((x): x is CalendarEventJson => !!x);
}

export function loadEvent(dbx: DbOrTx, id: number): CalendarEventJson | null {
  return loadEvents(dbx, [id])[0] ?? null;
}
