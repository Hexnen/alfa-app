/**
 * Kalendarz — wydarzenia (serwis/montaż/wizja/… oraz spotkania/telefony/zadania
 * działu handlowego), serie cykliczne (konserwacje), przypisania techników
 * i handlowców, historia zmian (activity_log) i publiczny feed ICS po tokenie.
 *
 * DWA DZIAŁY, JEDEN ROUTER. Prefiks `/calendar` w API_TAB_MAP jest tylko grubą
 * bramką (wpuszcza posiadacza dowolnego klucza kalendarza) — właściwa kontrola
 * jest WIERSZOWA, po `calendar_events.department`, i robi ją src/lib/calendar-scope.ts.
 * Każda trasa w tym pliku MUSI ją wołać; pominięta trasa to wyciek między działami
 * (test: scripts/test-sales-calendar-perms.ts).
 *
 * Logika mutacji (walidacja parseInput, create/update/move/delete/restore + activity_log) żyje
 * w src/lib/calendar-mutations.ts — trasy tylko parsują żądanie, otwierają transakcję i mapują
 * ApiError → HTTP. Te same funkcje woła asystent AI (POST /assistant/apply-changes).
 * Serializacja (loadEvents) i zapytania wspólne: src/lib/calendar-queries.ts.
 *
 * Eksporty:
 *  - default: trasy chronione sesją (montowane pod /calendar po requireAuth)
 *  - calendarPublicRoutes: GET /feed.ics?token=... (montowane PRZED requireAuth)
 *  - re-eksporty (ApiError, etykiety, loadEvents, parseInput) dla dotychczasowych importów
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { db, schema } from "../db/index.js";
import { eq, and, desc, asc, isNull, inArray, sql, lt, gt, gte, ne } from "drizzle-orm";
import { type CalendarEventType, type CalendarEventStatus, type CalendarBilling, type CalendarDepartment, type User } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { describeRule } from "../lib/calendar-recurrence.js";
import {
  conflictEventIds,
  findSalespersonForUser,
  loadEvent,
  loadEvents,
  loadNotes,
  searchNotes,
  type CalendarEventJson,
  type Note,
} from "../lib/calendar-queries.js";
import {
  asDepartment,
  assertEventAccess,
  canEditDepartment,
  departmentsFromQuery,
  requestDepartments,
  viewableDepartments,
} from "../lib/calendar-scope.js";
import {
  CALENDAR_ENTITY as ENTITY,
  DATE_RE,
  addNote,
  createEvent,
  deleteEvent,
  deleteNote,
  getEventRow,
  isValidCalendarDate,
  moveEvent,
  parseInput,
  parseScope,
  restoreEvent,
  updateEvent,
  updateNote,
  type ParsedInput,
} from "../lib/calendar-mutations.js";
import { ApiError, BILLING_LABELS, PROTOCOL_TYPES, STATUS_LABELS, TYPE_LABELS } from "../lib/calendar-labels.js";
import {
  clientIdOf,
  publishCalendarChange,
  subscribe as subscribeCalendarChanges,
  type CalendarChange,
  type CalendarChangeKind,
} from "../lib/calendar-live.js";
import {
  attachmentFilePath,
  contentDisposition,
  removeStoredFiles,
  storeUploads,
  type IncomingFile,
} from "../lib/calendar-attachments.js";
import { canManageNote, getNoteRow } from "../lib/calendar-mutations.js";
import { copyCalendarNoteToObject, objectNoteIdsForCalendarNotes } from "../lib/object-notes.js";
import { canEdit } from "../lib/auth/permissions.js";
import { loadWeatherEvents, weatherBriefs, weatherDetail, type WeatherBrief } from "../lib/weather.js";
import calendarFilterSetsRoutes from "./calendar-filter-sets.js";
import calendarDayRouteRoutes from "./calendar-day-route.js";

// Re-eksporty dla dotychczasowych importów (asystent, testy).
export { ApiError, STATUS_LABELS, TYPE_LABELS, loadEvents, parseInput };
export type { CalendarEventJson, Note, ParsedInput };

const app = new Hono();
export const calendarPublicRoutes = new Hono();

// Zapisane zestawy filtrów (per użytkownik) — src/routes/calendar-filter-sets.ts
app.route("/filter-sets", calendarFilterSetsRoutes);

// Planer trasy — punkty i macierz odległości dnia (odczyt) — src/routes/calendar-day-route.ts
app.route("/", calendarDayRouteRoutes);

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

/**
 * Wydarzenie po id z kontrolą dostępu do jego działu. Rzuca ApiError 404/403.
 * Wołane z KAŻDEJ trasy operującej na pojedynczym wydarzeniu.
 */
function eventForAccess(id: number, user: User, mode: "view" | "edit") {
  const ev = getEventRow(db, id);
  if (!ev) throw new ApiError(404, "Wydarzenie nie istnieje");
  assertEventAccess(user, ev, mode);
  return ev;
}

/**
 * Dopina `objectNoteId` (id żywej kopii notatki w kartotece obiektu) do notatek
 * wychodzących na front — dzięki temu UI pokazuje „w obiekcie ✓" zamiast przycisku.
 * Jedno zapytanie na całą listę. Robi to TRASA, a nie calendar-queries: patrz
 * komentarz przy `Note.objectNoteId` (cykl importów).
 */
function withObjectNoteIds<T extends Note>(notes: T[]): T[] {
  if (notes.length === 0) return notes;
  const map = objectNoteIdsForCalendarNotes(db, notes.map((n) => n.id));
  return notes.map((n) => ({ ...n, objectNoteId: map.get(n.id) ?? null }));
}

/** Jedna notatka — jak wyżej. */
function withObjectNoteId(note: Note): Note {
  return withObjectNoteIds([note])[0];
}

/**
 * Wspólne warunki kopiowania notatki wydarzenia do kartoteki obiektu:
 * wydarzenie MUSI mieć obiekt, a użytkownik MUSI mieć prawo EDYCJI kartoteki
 * obiektów (klucz `objects`) — samo prawo do kalendarza nie wystarcza, bo wpis
 * ląduje w cudzym module i w dzienniku obiektu.
 */
function assertCanCopyToObject(user: User, ev: { objectId: number | null }): void {
  if (ev.objectId == null) throw new ApiError(400, "Wydarzenie nie ma przypisanego obiektu");
  if (!canEdit(user, "objects"))
    throw new ApiError(403, "Brak uprawnień do edycji kartoteki obiektów");
}

/** To samo dla notatki: notatka → jej wydarzenie → dział. */
function eventOfNoteForAccess(noteId: number, user: User, mode: "view" | "edit") {
  const note = getNoteRow(db, noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
  const ev = getEventRow(db, note.eventId);
  if (!ev) throw new ApiError(404, "Wydarzenie nie istnieje");
  assertEventAccess(user, ev, mode);
  return { note, ev };
}

/** Zawęża listę id wydarzeń do działów widocznych dla użytkownika (batche: pogoda, ICS). */
function filterIdsByDepartments(ids: number[], departments: readonly CalendarDepartment[]): number[] {
  if (ids.length === 0 || departments.length === 0) return [];
  return db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(inArray(schema.calendarEvents.id, ids), inArray(schema.calendarEvents.department, [...departments])))
    .all()
    .map((r) => r.id);
}

/**
 * Sygnał „kalendarz się zmienił" dla otwartych kart (src/lib/calendar-live.ts).
 * WOŁAĆ PO commicie transakcji — subskrybent od razu czyta bazę.
 *
 * `actorClientId` bierzemy z nagłówka żądania: pomijana ma być KARTA, która zapisała,
 * a nie wszystkie karty tej osoby (drugie okno i telefon mają się odświeżyć).
 */
function publishChange(
  c: Context,
  kind: CalendarChangeKind,
  department: CalendarDepartment,
  ids: readonly (number | null | undefined)[],
  user: User
): void {
  publishCalendarChange({
    kind,
    department,
    eventIds: ids,
    actorUserId: user.id,
    actorClientId: clientIdOf(c),
  });
}

// ---------------------------------------------------------------------------
// GET /live — strumień SSE z sygnałami o zmianach (Server-Sent Events)
// ---------------------------------------------------------------------------

/** Odstęp „pingów" (komentarz SSE) — trzyma połączenie przy życiu przez proxy. */
const LIVE_HEARTBEAT_MS = 25_000;
/** Ile przeglądarka ma czekać przed ponownym połączeniem po zerwaniu. */
const LIVE_RETRY_MS = 5_000;

/**
 * Strumień zdarzeń dla jednej otwartej karty. EventSource NIE wysyła własnych nagłówków,
 * więc autoryzacja idzie wyłącznie z cookie `alfa_session` (requireAuth w src/routes/index.ts) —
 * to działa, bo front woła API po ścieżce względnej (ten sam origin, w dev proxy Vite).
 *
 * Filtr działowy jest TU: subskrybent dostaje wyłącznie zmiany z działów, które wolno mu
 * oglądać (`departmentsFromQuery` → calendar-scope). Sam sygnał nie niesie danych wydarzenia,
 * ale samo „w dziale handlowym coś się ruszyło" też nie ma prawa wyciekać do technika.
 */
app.get("/live", (c) => {
  const user = getUser(c);
  let departments: CalendarDepartment[];
  try {
    departments = departmentsFromQuery(c, user);
  } catch (error) {
    return handleError(c, error, "subskrypcji zmian kalendarza");
  }
  const allowed = new Set<CalendarDepartment>(departments);
  return streamSSE(c, async (stream) => {
    // UWAGA na kolejność: `streamSSE` ustawia WŁASNE nagłówki (m.in. Cache-Control: no-cache)
    // TUŻ przed wywołaniem tego callbacku, a odpowiedź składa dopiero po powrocie z jego
    // synchronicznej części. Nagłówki dopisane wyżej (przed `streamSSE`) zostałyby więc
    // nadpisane — muszą lecieć TUTAJ i PRZED pierwszym `await`.
    //  - no-transform: żaden pośrednik nie ma prawa przepakować/skompresować strumienia,
    //  - X-Accel-Buffering: wyłącza buforowanie w nginx (Dokploy stawia go przed aplikacją).
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    const queue: CalendarChange[] = [];
    let closed = false;
    /** Budzik pętli — ustawiany na czas czekania, kasowany po obudzeniu. */
    let wake: (() => void) | null = null;
    const bump = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const unsubscribe = subscribeCalendarChanges((change) => {
      if (!allowed.has(change.department)) return;
      queue.push(change);
      bump();
    });
    const close = () => {
      closed = true;
      bump();
    };
    stream.onAbort(close);
    // Node server sygnalizuje zerwanie także przez AbortSignal żądania.
    c.req.raw.signal?.addEventListener("abort", close, { once: true });

    try {
      // Pierwsza ramka od razu — przeglądarka uznaje połączenie za otwarte,
      // a `retry` ustawia odstęp automatycznego wznawiania po zerwaniu.
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ departments, ts: Date.now() }),
        retry: LIVE_RETRY_MS,
      });
      while (!closed && !stream.aborted && !stream.closed) {
        const batch = queue.splice(0, queue.length);
        if (batch.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, LIVE_HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          // Obudzeni bez pracy (timeout albo zamknięcie) → heartbeat; komentarz SSE
          // jest ignorowany przez EventSource, ale przepycha bufory pośredników.
          if (!closed && queue.length === 0) await stream.write(": ping\n\n");
          continue;
        }
        for (const change of batch) {
          await stream.writeSSE({ event: "calendar", data: JSON.stringify(change), id: String(change.ts) });
        }
      }
    } finally {
      unsubscribe();
      c.req.raw.signal?.removeEventListener("abort", close);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /events — lista po zakresie [from, to) + filtry
// ---------------------------------------------------------------------------

app.get("/events", (c) => {
  try {
    const user = getUser(c);
    // Zawsze i bezwarunkowo: tylko działy, które wolno oglądać (pusty `?department=`
    // = wszystkie widoczne). To jedyne miejsce, w którym lista wydarzeń jest cięta.
    const departments = departmentsFromQuery(c, user);
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (from && !DATE_RE.test(from)) throw new ApiError(400, "Parametr from: YYYY-MM-DD");
    if (to && !DATE_RE.test(to)) throw new ApiError(400, "Parametr to: YYYY-MM-DD");

    const types = (c.req.query("type") || "").split(",").map((s) => s.trim()).filter(Boolean) as CalendarEventType[];
    const statuses = (c.req.query("status") || "").split(",").map((s) => s.trim()).filter(Boolean) as CalendarEventStatus[];
    const technicianIds = parseIdList(c.req.query("technicianId"));
    // `salespersonId=me` → handlowiec zalogowanego (po salespeople.user_id). Brak
    // dopasowania NIE jest błędem: „Moje” u kogoś bez konta handlowca = pusty zbiór.
    const rawSalesperson = (c.req.query("salespersonId") || "").trim();
    let salespersonIds: number[] = [];
    if (rawSalesperson === "me") {
      const me = findSalespersonForUser(user, db);
      if (!me) return c.json({ success: true, data: [] });
      salespersonIds = [me.id];
    } else {
      salespersonIds = parseIdList(rawSalesperson);
    }
    const leadId = c.req.query("leadId") ? Number(c.req.query("leadId")) : null;
    const contactId = c.req.query("contactId") ? Number(c.req.query("contactId")) : null;
    const objectId = c.req.query("objectId") ? Number(c.req.query("objectId")) : null;
    const includeDeleted = c.req.query("includeDeleted") === "1" || c.req.query("includeDeleted") === "true";
    // billing=warranty,free,paid,none (none = NULL); protocol=with | without (without = wykonane prace bez protokołu)
    const billings = (c.req.query("billing") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const protocolFilter = c.req.query("protocol") || "";

    const conds = [inArray(schema.calendarEvents.department, [...departments])];
    if (!includeDeleted) conds.push(isNull(schema.calendarEvents.deletedAt));
    // Nachodzenie na zakres: start < to AND end > from (porównanie leksykalne ISO działa
    // także między "YYYY-MM-DD" a "YYYY-MM-DDTHH:MM").
    if (from) conds.push(gt(schema.calendarEvents.endAt, from));
    if (to) conds.push(lt(schema.calendarEvents.startAt, to));
    if (types.length) conds.push(inArray(schema.calendarEvents.type, types));
    if (statuses.length) conds.push(inArray(schema.calendarEvents.status, statuses));
    if (billings.length) {
      const vals = billings.filter((b): b is CalendarBilling => b !== "none") ;
      const withNull = billings.includes("none");
      const parts = [];
      if (vals.length) parts.push(inArray(schema.calendarEvents.billing, vals));
      if (withNull) parts.push(isNull(schema.calendarEvents.billing));
      conds.push(parts.length === 1 ? parts[0] : sql`(${parts[0]} OR ${parts[1]})`);
    }
    if (protocolFilter === "with" || protocolFilter === "without") {
      const hasProto = sql`(${schema.calendarEvents.protocolId} IS NOT NULL OR EXISTS (SELECT 1 FROM protocols p WHERE p.realization_id = ${schema.calendarEvents.realizationId}))`;
      if (protocolFilter === "with") conds.push(hasProto);
      else conds.push(and(sql`NOT ${hasProto}`, eq(schema.calendarEvents.status, "done"), inArray(schema.calendarEvents.type, [...PROTOCOL_TYPES]))!);
    }
    if (objectId != null && Number.isInteger(objectId)) conds.push(eq(schema.calendarEvents.objectId, objectId));
    if (leadId != null && Number.isInteger(leadId)) conds.push(eq(schema.calendarEvents.leadId, leadId));
    if (contactId != null && Number.isInteger(contactId)) conds.push(eq(schema.calendarEvents.contactId, contactId));
    if (technicianIds.length) {
      conds.push(
        sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`
      );
    }
    if (salespersonIds.length) {
      conds.push(
        sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_salespeople WHERE salesperson_id IN (${sql.join(salespersonIds.map((id) => sql`${id}`), sql`, `)}))`
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
  try {
    assertEventAccess(getUser(c), ev, "view");
  } catch (error) {
    return handleError(c, error, "pobierania wydarzenia");
  }
  const history = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, ENTITY), eq(schema.activityLog.entityId, id)))
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(500)
    .all();
  const notes = withObjectNoteIds(loadNotes(db, id));
  return c.json({ success: true, data: { ...ev, notes, notesCount: notes.length, history } });
});

// ---------------------------------------------------------------------------
// Notatki: GET/POST /events/:id/notes, PUT/DELETE /notes/:noteId (autor lub admin)
// ---------------------------------------------------------------------------

app.get("/events/:id/notes", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    eventForAccess(id, getUser(c), "view");
    return c.json({ success: true, data: withObjectNoteIds(loadNotes(db, id)) });
  } catch (error) {
    return handleError(c, error, "pobierania notatek");
  }
});

// ---------------------------------------------------------------------------
// GET /notes/search?q=&limit=20 — notatki do przypięcia kafelka typu „notatka”.
// Uprawnienia: te same co odczyt kalendarza (trasa pod /calendar → API_TAB_MAP
// `technical/kalendarz`, GET przechodzi przy poziomie `view`).
// ---------------------------------------------------------------------------

const NOTES_SEARCH_MAX = 50;

app.get("/notes/search", (c) => {
  try {
    // Wyszukiwarka wydaje treść notatki i tytuł wydarzenia — zawężamy do widocznych działów.
    const departments = departmentsFromQuery(c, getUser(c));
    const q = (c.req.query("q") || "").trim().slice(0, 200);
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, NOTES_SEARCH_MAX) : 20;
    return c.json({ success: true, data: searchNotes(db, q, limit, departments) });
  } catch (error) {
    return handleError(c, error, "wyszukiwania notatek");
  }
});

/**
 * Ciało POST /events/:id/notes: JSON `{text}` jak dotąd albo `multipart/form-data`
 * z polami `text` (opcjonalne) i `files` (wiele). Pliki trafiają do pamięci — limit
 * ciała pilnuje src/routes/index.ts (bodyLimitFor), limit per plik storeUploads.
 */
async function readNoteBody(
  c: Context
): Promise<{ text: string; files: IncomingFile[]; copyToObject: boolean }> {
  const ct = c.req.header("content-type") ?? "";
  if (!/multipart\/form-data/i.test(ct)) {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; copyToObject?: unknown } | null;
    return { text: String(body?.text ?? ""), files: [], copyToObject: body?.copyToObject === true };
  }
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new ApiError(400, "Nieprawidłowe dane formularza");
  const textField = form.get("text");
  const files: IncomingFile[] = [];
  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File)) continue;
    files.push({ name: entry.name, mime: entry.type, data: Buffer.from(await entry.arrayBuffer()) });
  }
  // Multipart nie zna typów — checkbox przychodzi jako "1"/"true".
  const copyField = form.get("copyToObject");
  const copyToObject = typeof copyField === "string" && (copyField === "1" || copyField.toLowerCase() === "true");
  return { text: typeof textField === "string" ? textField : "", files, copyToObject };
}

app.post("/events/:id/notes", async (c) => {
  const user = getUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const { text, files, copyToObject } = await readNoteBody(c);
    // Wydarzenie i treść sprawdzamy PRZED zapisem plików (żeby nie mielić obrazków
    // dla nieistniejącego wydarzenia); pliki lądują na dysku przed transakcją, a przy
    // błędzie wstawiania są sprzątane.
    const ev = eventForAccess(id, user, "edit");
    if (ev.deletedAt) throw new ApiError(409, "Wydarzenie jest usunięte — najpierw je przywróć");
    // Kafelek notatki tylko wskazuje cudzą notatkę — własnego dziennika nie ma (też w addNote).
    if (ev.type === "notatka") throw new ApiError(400, "Wydarzenie typu notatka nie może mieć własnych notatek");
    if (!text.trim() && files.length === 0) throw new ApiError(400, "Treść notatki jest wymagana");
    // Warunki kopii sprawdzamy PRZED zapisem plików — 400/403 nie ma prawa
    // zostawić obrazków na dysku ani wiersza notatki bez kopii w kartotece.
    if (copyToObject) assertCanCopyToObject(user, ev);
    const attachments = await storeUploads(id, files);
    let note: Note;
    try {
      note = db.transaction((tx) => {
        const added = addNote(tx, { eventId: id, text, ctx: { user }, attachments });
        if (!copyToObject) return added;
        // TA SAMA transakcja: albo notatka i jej kopia w kartotece, albo nic.
        const copy = copyCalendarNoteToObject(tx, { note: { id: added.id, text: added.text }, ev, ctx: { user } });
        return { ...added, objectNoteId: copy.id };
      });
    } catch (error) {
      removeStoredFiles(attachments);
      throw error;
    }
    publishChange(c, "notes", asDepartment(ev.department), [id], user);
    return c.json({ success: true, data: note }, 201);
  } catch (error) {
    return handleError(c, error, "dodawania notatki");
  }
});

// ---------------------------------------------------------------------------
// Załączniki notatek: GET /attachments/:attachmentId (?download=1), DELETE (autor notatki lub admin)
// ---------------------------------------------------------------------------

app.get("/attachments/:attachmentId", (c) => {
  const attId = Number(c.req.param("attachmentId"));
  if (!Number.isInteger(attId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  const att = db.select().from(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, attId)).get();
  if (!att) return c.json({ success: false, error: "Załącznik nie istnieje" }, 404);
  // Plik należy do notatki, a notatka do wydarzenia — dostęp idzie za działem wydarzenia.
  try {
    eventOfNoteForAccess(att.noteId, getUser(c), "view");
  } catch (error) {
    return handleError(c, error, "pobierania załącznika");
  }
  const abs = attachmentFilePath(att.storedPath);
  if (!abs) return c.json({ success: false, error: "Plik załącznika nie istnieje na dysku" }, 404);
  const download = c.req.query("download") === "1";
  const size = statSync(abs).size;
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": att.mime,
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDisposition(download ? "attachment" : "inline", att.fileName),
    },
  });
});

app.delete("/attachments/:attachmentId", (c) => {
  const user = getUser(c);
  const attId = Number(c.req.param("attachmentId"));
  if (!Number.isInteger(attId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const removed = db.transaction((tx) => {
      const att = tx.select().from(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, attId)).get();
      if (!att) throw new ApiError(404, "Załącznik nie istnieje");
      const note = getNoteRow(tx, att.noteId);
      if (!note || note.deletedAt) throw new ApiError(404, "Notatka nie istnieje");
      const ev = getEventRow(tx, note.eventId);
      if (!ev) throw new ApiError(404, "Wydarzenie nie istnieje");
      assertEventAccess(user, ev, "edit");
      if (!canManageNote(note, user)) throw new ApiError(403, "Tylko autor notatki lub administrator może usunąć załącznik");
      tx.delete(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, attId)).run();
      return { att, eventId: ev.id, department: asDepartment(ev.department) };
    });
    // Plik znika dopiero po commicie — nieudana transakcja nie zostawia wiersza bez pliku.
    removeStoredFiles([removed.att]);
    publishChange(c, "notes", removed.department, [removed.eventId], user);
    return c.json({ success: true, data: { id: attId, noteId: removed.att.noteId } });
  } catch (error) {
    return handleError(c, error, "usuwania załącznika");
  }
});

// ---------------------------------------------------------------------------
// POST /notes/:noteId/copy-to-object — kopia ISTNIEJĄCEJ notatki do kartoteki
// obiektu wydarzenia. IDEMPOTENTNE: druga próba zwraca 200 z istniejącą kopią
// (bez drugiego wiersza i bez drugiego wpisu w dzienniku obiektu).
//
// MUSI stać przed PUT/DELETE /notes/:noteId tylko wizualnie — metody są różne,
// więc kolejność nie zmienia routingu; trzymamy je razem dla czytelności.
// ---------------------------------------------------------------------------

app.post("/notes/:noteId/copy-to-object", (c) => {
  const user = getUser(c);
  const noteId = Number(c.req.param("noteId"));
  if (!Number.isInteger(noteId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    // Edycja kalendarza (dział wydarzenia) ORAZ edycja kartoteki obiektów.
    const { note, ev } = eventOfNoteForAccess(noteId, user, "edit");
    assertCanCopyToObject(user, ev);
    const copy = db.transaction((tx) => copyCalendarNoteToObject(tx, { note, ev, ctx: { user } }));
    // Znacznik „w obiekcie ✓" przy notatce widzą wszyscy — inne karty mają go zobaczyć bez F5.
    publishChange(c, "notes", asDepartment(ev.department), [ev.id], user);
    return c.json({ success: true, data: copy });
  } catch (error) {
    return handleError(c, error, "kopiowania notatki do obiektu");
  }
});

app.put("/notes/:noteId", async (c) => {
  const user = getUser(c);
  const noteId = Number(c.req.param("noteId"));
  if (!Number.isInteger(noteId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const { ev } = eventOfNoteForAccess(noteId, user, "edit");
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const note = db.transaction((tx) => updateNote(tx, noteId, body?.text, { user }));
    publishChange(c, "notes", asDepartment(ev.department), [ev.id], user);
    return c.json({ success: true, data: withObjectNoteId(note) });
  } catch (error) {
    return handleError(c, error, "edycji notatki");
  }
});

app.delete("/notes/:noteId", (c) => {
  const user = getUser(c);
  const noteId = Number(c.req.param("noteId"));
  if (!Number.isInteger(noteId)) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    const { ev } = eventOfNoteForAccess(noteId, user, "edit");
    db.transaction((tx) => deleteNote(tx, noteId, { user }));
    publishChange(c, "notes", asDepartment(ev.department), [ev.id], user);
    return c.json({ success: true, data: { id: noteId } });
  } catch (error) {
    return handleError(c, error, "usuwania notatki");
  }
});

// ---------------------------------------------------------------------------
// POST /events — utworzenie (opcjonalnie serii)
// ---------------------------------------------------------------------------

app.post("/events", async (c) => {
  const user = getUser(c);
  try {
    const body = await c.req.json().catch(() => null);
    const input = parseInput(body);
    if (!canEditDepartment(user, input.department)) {
      throw new ApiError(403, "Brak uprawnień do tworzenia wydarzeń tego działu");
    }
    const result = db.transaction((tx) => createEvent(tx, input, { user }));
    const first = loadEvent(db, result.firstId)!;
    publishChange(c, "created", input.department, [result.firstId], user);
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
    // Prawo edycji liczy się z działu ISTNIEJĄCEGO wiersza; zmianę działu w ciele
    // odrzuca updateEvent (400), więc 403 nie da się obejść podmianą pola.
    const row = eventForAccess(id, user, "edit");
    const body = await c.req.json().catch(() => null);
    const input = parseInput(body);
    const affected = db.transaction((tx) => updateEvent(tx, id, input, scope, { user }));
    const ev = loadEvent(db, id)!;
    publishChange(c, "updated", asDepartment(row.department), affected.length ? affected : [id], user);
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
    const row = eventForAccess(id, user, "edit");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "Nieprawidłowe dane wejściowe");
    db.transaction((tx) => moveEvent(tx, id, body, { user }));
    publishChange(c, "moved", asDepartment(row.department), [id], user);
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
    const row = eventForAccess(id, user, "edit");
    const deletedIds = db.transaction((tx) => deleteEvent(tx, id, scope, { user }));
    publishChange(c, "deleted", asDepartment(row.department), deletedIds.length ? deletedIds : [id], user);
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
    const row = eventForAccess(id, user, "edit");
    db.transaction((tx) => restoreEvent(tx, id, { user }));
    publishChange(c, "restored", asDepartment(row.department), [id], user);
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
    const departments = departmentsFromQuery(c, getUser(c));
    const technicianIds = parseIdList(c.req.query("technicianIds"));
    const salespersonIds = parseIdList(c.req.query("salespersonIds"));
    const startAt = (c.req.query("startAt") || "").trim();
    const endAt = (c.req.query("endAt") || "").trim();
    const excludeId = c.req.query("excludeId") ? Number(c.req.query("excludeId")) : null;
    if ((technicianIds.length === 0 && salespersonIds.length === 0) || !startAt || !endAt) {
      return c.json({ success: true, data: [] });
    }
    // Zapytanie wspólne z asystentem AI (src/lib/calendar-queries.ts) — zachowanie bez zmian.
    // Kolidujące wydarzenie z niewidocznego działu nie ma prawa się pokazać, więc
    // wynik przechodzi jeszcze przez filtr działów.
    const ids = filterIdsByDepartments(conflictEventIds(db, { technicianIds, salespersonIds, startAt, endAt, excludeId }), departments);
    // conflictKind: "urlop" = technik na urlopie (osobny komunikat na froncie), "event" = zwykła kolizja
    const data = loadEvents(db, ids).map((e) => ({ ...e, conflictKind: e.type === "urlop" ? "urlop" : "event" }));
    return c.json({ success: true, data });
  } catch (error) {
    return handleError(c, error, "sprawdzania kolizji");
  }
});

// ---------------------------------------------------------------------------
// Pogoda — GET /weather?ids= (batch) i GET /events/:id/weather (szczegóły)
//
// Uprawnienia: te same co odczyt wydarzeń — trasy są pod /calendar, więc łapie je
// wpis `{ prefix: "/calendar", tabs: ["technical/kalendarz"] }` w API_TAB_MAP
// (src/middleware/auth.ts); GET przechodzi przy poziomie `view`. Bez dodatkowej bramki.
//
// Pogoda NIGDY nie wywraca widoku: brak sieci, brak punktu, dzień poza oknem prognozy
// czy padnięte IMGW wracają jako `null` w HTTP 200. 500 zostaje wyłącznie dla błędu bazy.
// ---------------------------------------------------------------------------

/** Ile wydarzeń wolno spytać jednym batchem (widok miesiąca mieści się z zapasem). */
const WEATHER_MAX_IDS = 200;

app.get("/weather", async (c) => {
  try {
    const requested = parseIdList(c.req.query("ids")).slice(0, WEATHER_MAX_IDS);
    const items: Record<string, WeatherBrief | null> = {};
    for (const id of requested) items[String(id)] = null;
    // Klucze zostają dla wszystkich pytanych id (front nie ponawia), ale pogodę
    // liczymy wyłącznie dla wydarzeń z widocznych działów.
    const ids = filterIdsByDepartments(requested, requestDepartments(getUser(c)));
    if (ids.length === 0) return c.json({ success: true, data: { items, retry: [] } });

    const events = loadWeatherEvents(ids, db);
    const batch = await weatherBriefs(events, {});
    for (const [id, brief] of batch.items) items[String(id)] = brief;
    // `retry` odróżnia „null, bo nie ma pogody” (urlop, poza oknem, brak punktu) od
    // „null, bo się nie udało” (offline, brak danych, limit świeżych geokodowań) —
    // front tylko tych drugich nie zapisuje jako zapytanych i ponawia je później.
    return c.json({ success: true, data: { items, retry: batch.retry } });
  } catch (error) {
    // Świadomie NIE handleError: pogoda ma się degradować do pustki, a nie psuć kalendarz.
    console.error("Error in calendar weather batch:", error);
    return c.json({ success: true, data: { items: {}, retry: [] } });
  }
});

app.get("/events/:id/weather", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, error: "Nieprawidłowe id" }, 400);
  try {
    eventForAccess(id, getUser(c), "view");
  } catch (error) {
    return handleError(c, error, "pobierania pogody");
  }
  const [ev] = loadWeatherEvents([id], db);
  if (!ev) return c.json({ success: false, error: "Wydarzenie nie istnieje" }, 404);
  try {
    const res = await weatherDetail(ev, {});
    return c.json({ success: true, data: res.value });
  } catch (error) {
    console.error("Error in calendar weather detail:", error);
    return c.json({ success: true, data: null });
  }
});

// ---------------------------------------------------------------------------
// GET /availability?from&to[&department=handlowy] — przedziały urlopów w zakresie
// [from, to): domyślnie per technik (kształt niezmieniony), a dla działu
// handlowego per handlowiec (`salespersonId` zamiast `technicianId`).
// ---------------------------------------------------------------------------

interface LeaveJson {
  eventId: number;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
}

app.get("/availability", (c) => {
  try {
    const user = getUser(c);
    const departments = departmentsFromQuery(c, user);
    const from = (c.req.query("from") || "").trim();
    const to = (c.req.query("to") || "").trim();
    if (!from || !to) throw new ApiError(400, "Parametry from i to są wymagane");
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
      throw new ApiError(400, "Parametry from/to: oczekiwano daty YYYY-MM-DD lub YYYY-MM-DDTHH:MM");
    }

    // Dział handlowy: urlopy handlowców. Osobna gałąź, a nie parametryzacja jednego
    // zapytania — kształt wiersza jest inny (salespersonId) i front go rozróżnia.
    if (c.req.query("department") === "handlowy") {
      if (!departments.includes("handlowy")) throw new ApiError(403, "Brak dostępu do kalendarza działu handlowy");
      const salesRows = db
        .select({
          eventId: schema.calendarEvents.id,
          title: schema.calendarEvents.title,
          startAt: schema.calendarEvents.startAt,
          endAt: schema.calendarEvents.endAt,
          allDay: schema.calendarEvents.allDay,
          status: schema.calendarEvents.status,
          salespersonId: schema.salespeople.id,
          firstName: schema.salespeople.firstName,
          lastName: schema.salespeople.lastName,
        })
        .from(schema.calendarEvents)
        .innerJoin(schema.calendarEventSalespeople, eq(schema.calendarEventSalespeople.eventId, schema.calendarEvents.id))
        .innerJoin(schema.salespeople, eq(schema.salespeople.id, schema.calendarEventSalespeople.salespersonId))
        .where(
          and(
            eq(schema.calendarEvents.type, "urlop"),
            eq(schema.calendarEvents.department, "handlowy"),
            isNull(schema.calendarEvents.deletedAt),
            ne(schema.calendarEvents.status, "cancelled"),
            lt(schema.calendarEvents.startAt, to),
            gt(schema.calendarEvents.endAt, from)
          )
        )
        .orderBy(asc(schema.salespeople.lastName), asc(schema.salespeople.firstName), asc(schema.calendarEvents.startAt))
        .limit(2000)
        .all();
      const bySales = new Map<number, { salespersonId: number; firstName: string; lastName: string; leaves: LeaveJson[] }>();
      for (const r of salesRows) {
        let entry = bySales.get(r.salespersonId);
        if (!entry) {
          entry = { salespersonId: r.salespersonId, firstName: r.firstName, lastName: r.lastName, leaves: [] };
          bySales.set(r.salespersonId, entry);
        }
        entry.leaves.push({ eventId: r.eventId, title: r.title, startAt: r.startAt, endAt: r.endAt, allDay: r.allDay, status: r.status });
      }
      return c.json({ success: true, data: [...bySales.values()] });
    }

    if (!departments.includes("technical")) throw new ApiError(403, "Brak dostępu do kalendarza działu technical");
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
          eq(schema.calendarEvents.department, "technical"),
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
  try {
    const departments = departmentsFromQuery(c, getUser(c));
    const ids = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(
        and(
          eq(schema.calendarEvents.objectId, objectId),
          isNull(schema.calendarEvents.deletedAt),
          inArray(schema.calendarEvents.department, [...departments])
        )
      )
      .orderBy(desc(schema.calendarEvents.startAt), desc(schema.calendarEvents.id))
      .limit(1000)
      .all()
      .map((r) => r.id);
    return c.json({ success: true, data: loadEvents(db, ids) });
  } catch (error) {
    return handleError(c, error, "pobierania wydarzeń obiektu");
  }
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

/**
 * Nazwa kalendarza w kliencie (Google/Outlook/telefon) — po działach, które
 * w ogóle wchodzą do feedu. Sztywne „kalendarz techniczny” podpisywało tak
 * również subskrypcję handlowca, który wydarzeń technicznych w ogóle nie
 * dostaje.
 */
export function icsCalendarName(departments: readonly CalendarDepartment[]): string {
  const hasTech = departments.includes("technical");
  const hasSales = departments.includes("handlowy");
  if (hasTech && hasSales) return "Alfa — kalendarz";
  if (hasSales) return "Alfa — kalendarz handlowy";
  return "Alfa — kalendarz techniczny";
}

export function buildIcs(
  events: CalendarEventJson[],
  host: string,
  departments: readonly CalendarDepartment[] = ["technical"]
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alfa App//Kalendarz//PL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsLine("X-WR-CALNAME", icsCalendarName(departments)),
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
    // Wydarzenie handlowe nie ma techników, tylko handlowców — do nagłówka urlopu
    // i opisu bierzemy tych, którzy w danym dziale w ogóle istnieją.
    const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();
    const techNames = e.technicians.map(nameOf).join(", ");
    const salesNames = e.salespeople.map(nameOf).join(", ");
    const summary = e.type === "urlop"
      ? `Urlop: ${techNames || salesNames || e.title.replace(/^Urlop\s*[—-]\s*/i, "")}`
      : `[${TYPE_LABELS[e.type]}] ${e.title}${e.objectName ? ` — ${e.objectName}` : ""}`;
    lines.push(icsLine("SUMMARY", icsEscape(summary)));
    const descParts: string[] = [];
    if (e.description) descParts.push(e.description);
    if (e.technicians.length) descParts.push(`Technicy: ${techNames}`);
    if (e.salespeople.length) descParts.push(`Handlowcy: ${salesNames}`);
    if (e.leadTitle) descParts.push(`Szansa: ${e.leadTitle}`);
    if (e.contactName) descParts.push(`Kontakt: ${e.contactName}`);
    descParts.push(`Status: ${STATUS_LABELS[e.status]}`);
    if (e.billing) descParts.push(`Rozliczenie: ${BILLING_LABELS[e.billing]}`);
    if (e.protocol) descParts.push(`Protokół: ${e.protocol.number}${e.protocol.status === "final" || e.protocol.signedAt ? " (podpisany)" : " (szkic)"}`);
    else if (e.status === "done" && PROTOCOL_TYPES.includes(e.type)) descParts.push("Protokół: brak");
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
  // Feed jest PUBLICZNY (poza requireAuth) — uprawnienia bierzemy z konta, do którego
  // należy token, dokładnie tak, jakby jego właściciel pytał o listę wydarzeń.
  const user = db
    .select({ id: schema.users.id, role: schema.users.role, permissions: schema.users.permissions })
    .from(schema.users)
    .where(eq(schema.users.calendarToken, token))
    .get();
  if (!user) return c.text("Nieprawidłowy token", 401);
  const departments = viewableDepartments(user);
  if (departments.length === 0) return c.text("Brak dostępu do kalendarza", 403);

  // Przyszłe + ostatnie 90 dni, nie-cancelled, nie usunięte.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const salesperson = findSalespersonForUser(user, db);
  // Kalendarz handlowy jest wspólny do OGLĄDANIA w aplikacji, ale do prywatnego
  // kalendarza (telefon, Outlook) wchodzą wyłącznie wydarzenia właściciela tokenu:
  // przypisany jako handlowiec albo autor wpisu. Techniczne — bez zmian, całe.
  const salesScope = salesperson
    ? sql`(${schema.calendarEvents.createdBy} = ${user.id} OR ${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_salespeople WHERE salesperson_id = ${salesperson.id}))`
    : sql`${schema.calendarEvents.createdBy} = ${user.id}`;
  const scopeByDepartment = departments.includes("handlowy")
    ? departments.includes("technical")
      ? sql`(${schema.calendarEvents.department} = 'technical' OR (${schema.calendarEvents.department} = 'handlowy' AND ${salesScope}))`
      : sql`(${schema.calendarEvents.department} = 'handlowy' AND ${salesScope})`
    : sql`${schema.calendarEvents.department} = 'technical'`;
  const ids = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        gte(schema.calendarEvents.endAt, since),
        scopeByDepartment
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
  return c.body(buildIcs(events, host, departments));
});

export default app;
