/**
 * Notatki KARTOTEKI OBIEKTU (tabela `object_notes`) — dziennik przy obiekcie,
 * niezależny od kalendarza, plus jedna wspólna ścieżka kopiowania notatki
 * wydarzenia do obiektu („Zapisz też w obiekcie”).
 *
 * DLACZEGO KOPIA, A NIE WSKAŹNIK. Notatka z wizji lokalnej („brama od podwórza,
 * kod 1234”) jest wiedzą O OBIEKCIE, a nie o dniu, w którym ktoś tam pojechał.
 * Wydarzenie można usunąć, przesunąć albo zamknąć w serii — kartoteka ma to
 * przeżyć, więc kopia jest samodzielnym wierszem z własną treścią. `source_*`
 * trzyma wyłącznie ŚLAD pochodzenia (i klucz idempotencji), nie jest źródłem
 * prawdy dla treści: późniejsza edycja notatki w kalendarzu nie rusza kopii.
 *
 * IDEMPOTENCJA. Partial unique index `object_notes_source_note_uidx` pilnuje,
 * że jedna notatka kalendarza ma najwyżej JEDNĄ żywą kopię — dwa kliknięcia
 * (albo dwie karty) nie zrobią dwóch wpisów. Soft delete kopii zwalnia miejsce,
 * więc po skasowaniu można skopiować ponownie.
 *
 * better-sqlite3 jest synchroniczny — wszystkie funkcje są synchroniczne
 * i rzucają ApiError (mapowany na HTTP w trasach).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  CalendarDepartment,
  CalendarEvent as CalendarEventRow,
  CalendarEventNote as CalendarEventNoteRow,
  CalendarEventType,
  ObjectNote as ObjectNoteRow,
} from "../db/schema.js";
import { logActivity, userLabelOf, type DbOrTx } from "./activity-log.js";
import { noteSummary, parseNoteText, type MutationCtx } from "./calendar-mutations.js";
import { ApiError } from "./calendar-labels.js";

/** entity_type wpisów dziennika — ten sam, po którym karta obiektu scala historię. */
export const OBJECT_NOTE_ENTITY = "object";

/** Źródło notatki skopiowanej z kalendarza (do nagłówka „z kalendarza: …”). */
export interface ObjectNoteSourceJson {
  eventId: number;
  noteId: number | null;
  eventTitle: string;
  eventType: CalendarEventType;
  eventStartAt: string;
  eventDepartment: CalendarDepartment;
}

/** Notatka obiektu (kontrakt z frontem: ObjectNote). */
export interface ObjectNoteJson {
  id: number;
  objectId: number;
  userId: number | null;
  userLabel: string | null;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Niepuste tylko dla kopii z kalendarza; null, gdy wydarzenie zniknęło (FK SET NULL). */
  source: ObjectNoteSourceJson | null;
}

/** Wydarzenia źródłowe dla podanych notatek — jedno zapytanie (bez N+1). */
function sourceEvents(dbx: DbOrTx, eventIds: number[]): Map<number, ObjectNoteSourceJson> {
  const out = new Map<number, ObjectNoteSourceJson>();
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return out;
  const rows = dbx
    .select({
      id: schema.calendarEvents.id,
      title: schema.calendarEvents.title,
      type: schema.calendarEvents.type,
      startAt: schema.calendarEvents.startAt,
      department: schema.calendarEvents.department,
    })
    .from(schema.calendarEvents)
    .where(inArray(schema.calendarEvents.id, ids))
    .all();
  for (const r of rows) {
    out.set(r.id, {
      eventId: r.id,
      noteId: null, // uzupełniane per wiersz notatki
      eventTitle: r.title,
      eventType: r.type,
      eventStartAt: r.startAt,
      eventDepartment: r.department,
    });
  }
  return out;
}

function noteOfRow(r: ObjectNoteRow, src: Map<number, ObjectNoteSourceJson>): ObjectNoteJson {
  const base = r.sourceEventId != null ? src.get(r.sourceEventId) : undefined;
  return {
    id: r.id,
    objectId: r.objectId,
    userId: r.userId,
    userLabel: r.userLabel,
    text: r.text,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    source: base ? { ...base, noteId: r.sourceNoteId } : null,
  };
}

/** Serializacja jednej notatki (dociąga wydarzenie źródłowe, gdy jest). */
export function objectNoteJson(dbx: DbOrTx, r: ObjectNoteRow): ObjectNoteJson {
  return noteOfRow(r, sourceEvents(dbx, r.sourceEventId != null ? [r.sourceEventId] : []));
}

/** Żywe notatki obiektu, najnowsze pierwsze. */
export function listObjectNotes(dbx: DbOrTx, objectId: number, limit = 500): ObjectNoteJson[] {
  const rows = dbx
    .select()
    .from(schema.objectNotes)
    .where(and(eq(schema.objectNotes.objectId, objectId), isNull(schema.objectNotes.deletedAt)))
    .orderBy(desc(schema.objectNotes.createdAt), desc(schema.objectNotes.id))
    .limit(limit)
    .all();
  const src = sourceEvents(
    dbx,
    rows.map((r) => r.sourceEventId).filter((x): x is number => x != null)
  );
  return rows.map((r) => noteOfRow(r, src));
}

export function getObjectNoteRow(dbx: DbOrTx, id: number): ObjectNoteRow | undefined {
  return dbx.select().from(schema.objectNotes).where(eq(schema.objectNotes.id, id)).get();
}

/** Autor notatki albo admin może ją edytować/usuwać (jak w kalendarzu). */
export function canManageObjectNote(
  note: Pick<ObjectNoteRow, "userId">,
  user: { id: number; role?: string | null }
): boolean {
  return note.userId === user.id || user.role === "admin";
}

/** Obiekt musi istnieć — inaczej notatka wisiałaby w próżni (i tak by ją ucięło FK). */
function assertObjectExists(dbx: DbOrTx, objectId: number): void {
  const row = dbx
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(eq(schema.objects.id, objectId))
    .get();
  if (!row) throw new ApiError(404, "Obiekt nie istnieje");
}

export interface AddObjectNoteInput {
  objectId: number;
  text: unknown;
  ctx: MutationCtx;
  /** Ślad pochodzenia — ustawiany wyłącznie przez kopiowanie z kalendarza. */
  source?: { eventId: number; noteId: number } | null;
}

/**
 * Dodaje notatkę do kartoteki obiektu i loguje ją w dzienniku obiektu
 * (activity_log po `object_id` — karta obiektu scala po nim historię).
 */
export function addObjectNote(tx: DbOrTx, input: AddObjectNoteInput): ObjectNoteJson {
  assertObjectExists(tx, input.objectId);
  const text = parseNoteText(input.text);
  const fromCalendar = input.source != null;
  const row = tx
    .insert(schema.objectNotes)
    .values({
      objectId: input.objectId,
      userId: input.ctx.user.id,
      userLabel: userLabelOf(input.ctx.user),
      text,
      sourceEventId: input.source?.eventId ?? null,
      sourceNoteId: input.source?.noteId ?? null,
    })
    .returning()
    .get();
  logActivity(tx, {
    entityType: OBJECT_NOTE_ENTITY,
    entityId: input.objectId,
    objectId: input.objectId,
    user: input.ctx.user,
    summarySuffix: input.ctx.summarySuffix,
    action: "note_added",
    field: "note",
    newValue: row.id,
    summary: `Dodano notatkę obiektu${fromCalendar ? " (z kalendarza)" : ""}: ${noteSummary(text)}`,
  });
  return objectNoteJson(tx, row);
}

/** Edycja treści notatki obiektu (autor lub admin — kontrola w trasie i tutaj). */
export function updateObjectNote(
  tx: DbOrTx,
  noteId: number,
  rawText: unknown,
  ctx: MutationCtx
): ObjectNoteJson {
  const note = getObjectNoteRow(tx, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  if (!canManageObjectNote(note, ctx.user))
    throw new ApiError(403, "Tylko autor notatki lub administrator może ją edytować");
  const text = parseNoteText(rawText);
  if (text === note.text) return objectNoteJson(tx, note);
  const after = tx
    .update(schema.objectNotes)
    .set({ text, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.objectNotes.id, noteId))
    .returning()
    .get();
  logActivity(tx, {
    entityType: OBJECT_NOTE_ENTITY,
    entityId: note.objectId,
    objectId: note.objectId,
    user: ctx.user,
    summarySuffix: ctx.summarySuffix,
    action: "note_updated",
    field: "note",
    oldValue: noteSummary(note.text),
    newValue: noteSummary(text),
    summary: `Zmieniono notatkę obiektu: ${noteSummary(text)}`,
  });
  return objectNoteJson(tx, after);
}

/**
 * Soft delete notatki obiektu (autor lub admin). Kopia z kalendarza znika razem
 * z rezerwacją w partial unique index — notatkę wolno skopiować ponownie.
 */
export function deleteObjectNote(tx: DbOrTx, noteId: number, ctx: MutationCtx): void {
  const note = getObjectNoteRow(tx, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  if (!canManageObjectNote(note, ctx.user))
    throw new ApiError(403, "Tylko autor notatki lub administrator może ją usunąć");
  tx.update(schema.objectNotes)
    .set({ deletedAt: sql`(datetime('now'))`, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.objectNotes.id, noteId))
    .run();
  logActivity(tx, {
    entityType: OBJECT_NOTE_ENTITY,
    entityId: note.objectId,
    objectId: note.objectId,
    user: ctx.user,
    summarySuffix: ctx.summarySuffix,
    action: "note_deleted",
    field: "note",
    oldValue: noteSummary(note.text),
    summary: `Usunięto notatkę obiektu: ${noteSummary(note.text)}`,
  });
}

/**
 * Kopiuje notatkę wydarzenia do kartoteki jego obiektu. IDEMPOTENTNA — gdy żywa
 * kopia już istnieje, zwraca ją bez drugiego wpisu w dzienniku.
 *
 * Wspólna dla obu ścieżek: `copyToObject` przy dodawaniu notatki i osobnego
 * POST /calendar/notes/:noteId/copy-to-object. Uprawnienia do klucza `objects`
 * sprawdza WOŁAJĄCY (trasa) — tu pilnujemy tylko spójności danych.
 */
export function copyCalendarNoteToObject(
  tx: DbOrTx,
  p: { note: Pick<CalendarEventNoteRow, "id" | "text">; ev: Pick<CalendarEventRow, "id" | "objectId">; ctx: MutationCtx }
): ObjectNoteJson {
  if (p.ev.objectId == null) throw new ApiError(400, "Wydarzenie nie ma przypisanego obiektu");
  const existing = tx
    .select()
    .from(schema.objectNotes)
    .where(and(eq(schema.objectNotes.sourceNoteId, p.note.id), isNull(schema.objectNotes.deletedAt)))
    .get();
  if (existing) return objectNoteJson(tx, existing);
  // Notatka z samymi załącznikami nie ma czego przenieść do kartoteki — pliki
  // zostają przy wydarzeniu, a pusty wiersz w kartotece byłby tylko szumem.
  if (!p.note.text.trim())
    throw new ApiError(400, "Do obiektu można skopiować tylko notatkę z treścią");
  return addObjectNote(tx, {
    objectId: p.ev.objectId,
    text: p.note.text,
    ctx: p.ctx,
    source: { eventId: p.ev.id, noteId: p.note.id },
  });
}

/**
 * Id ŻYWYCH kopii dla podanych notatek kalendarza — jedno zapytanie.
 * Front pokazuje po tym „w obiekcie ✓” zamiast przycisku kopiowania.
 */
export function objectNoteIdsForCalendarNotes(dbx: DbOrTx, noteIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) return out;
  const rows = dbx
    .select({ id: schema.objectNotes.id, sourceNoteId: schema.objectNotes.sourceNoteId })
    .from(schema.objectNotes)
    .where(and(inArray(schema.objectNotes.sourceNoteId, ids), isNull(schema.objectNotes.deletedAt)))
    .all();
  for (const r of rows) if (r.sourceNoteId != null) out.set(r.sourceNoteId, r.id);
  return out;
}
