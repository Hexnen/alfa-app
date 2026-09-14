/**
 * Panel technika (/api/technik) — jedyne API konta technika i podwykonawcy.
 *
 * KOGO OBSŁUGUJE. Rolę `technik` (widzi tylko ten moduł — `technikRoleGuard`
 * w src/middleware/auth.ts) oraz zwykłe konto z kluczem `technik` nadanym
 * w macierzy admina. Montowany PO `tabPermissionGuard`, więc bramka modułu
 * (view/edit) jest już za nami.
 *
 * CZYJE ZLECENIA. Wyłącznie te, do których zalogowany jest przypisany:
 * `technicians.user_id = :me` (migracja 0101) → `calendar_event_assignees`.
 * Konto bez powiązania nie jest błędem — dostaje `linked: false` i pustą listę,
 * a mutacje 409; tak wygląda świeżo założone konto, zanim admin je podepnie.
 *
 * PUŁAPKA, KTÓREJ TU NIE POWTARZAMY. Ten router ŚWIADOMIE nie używa
 * `departmentsFromQuery`/`assertEventAccess` z src/lib/calendar-scope.ts: te
 * funkcje mają fallback „użytkownik bez żadnego klucza kalendarza = wszystkie
 * działy" (bo zakładają bramkę prefiksu /calendar nad sobą). Technik żadnego
 * klucza kalendarza nie ma, więc ten fallback otworzyłby mu kalendarz handlowy.
 * Zamiast tego: twardo `department = 'technical'` + własność przez przypisanie.
 *
 * CZEGO TU NIE MA. Kwot, rozliczeń, wycen i billingu — `JobJson` jest celowo
 * wąski, bo ekran trafia też do podwykonawców, którzy nie mają prawa widzieć,
 * ile klient płaci ani ile firma zarabia.
 */
import { Hono, type Context } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { CalendarEvent as CalendarEventRow, Protocol, User } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { canEdit } from "../lib/auth/permissions.js";
import { ApiError, PROTOCOL_TYPES, TYPE_LABELS } from "../lib/calendar-labels.js";
import {
  addNote,
  canManageNote,
  getEventRow,
  getNoteRow,
  parseNoteText,
  setEventProgress,
  DATE_RE,
  type MutationCtx,
} from "../lib/calendar-mutations.js";
import {
  attachmentFilePath,
  attachmentsByNote,
  contentDisposition,
  parseNoteForm,
  removeStoredFiles,
  storeUploads,
  type IncomingFile,
  type NoteAttachmentJson,
} from "../lib/calendar-attachments.js";
import { clientIdOf, publishCalendarChange } from "../lib/calendar-live.js";
import { ensureRealizationForEvent } from "../lib/calendar-realizations.js";
import { createProtocolForRealizationSync } from "./protocols.js";
import {
  afterProtocolSigned,
  checkSignaturePng,
  protocolConflictMessage,
  signProtocolSync,
  updateProtocolSync,
  withParsedItems,
} from "../lib/protocols.js";
import type { ProtocolItem } from "../lib/protocol-prefill.js";
import { getTechnikActivities } from "../lib/technik-config.js";
import { deleteSubscription, isPushEnabled, pushConfig, saveSubscription } from "../lib/push.js";
import { distanceForObject, isGeoError } from "../lib/geo.js";
import { getCompanyConfig } from "../lib/company-config.js";
import { CALENDAR_NOTE_MAX } from "../db/schema.js";
import { zonedToday } from "../lib/tz.js";
import { loadWeatherEvents, weatherBriefs, type WeatherBrief } from "../lib/weather.js";

const app = new Hono();

/** Ile dni do przodu pokazuje panel, gdy klient nie poda zakresu. */
const DEFAULT_HORIZON_DAYS = 14;

// ---------------------------------------------------------------------------
// Kto pyta: konto → technik z kartoteki
// ---------------------------------------------------------------------------

interface LinkedTechnician {
  id: number;
  firstName: string;
  lastName: string;
  type: "internal" | "external";
  company: string | null;
  phone: string | null;
}

/**
 * Technik powiązany z kontem — po `technicians.user_id` i TYLKO aktywny.
 * Dezaktywacja technika (odejście podwykonawcy) ma odciąć panel bez kasowania
 * konta i bez ruszania historii jego zleceń.
 */
function linkedTechnician(user: Pick<User, "id">): LinkedTechnician | null {
  const t = db
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      type: schema.technicians.type,
      company: schema.technicians.company,
      phone: schema.technicians.phone,
      active: schema.technicians.active,
    })
    .from(schema.technicians)
    .where(eq(schema.technicians.userId, user.id))
    .get();
  if (!t || !t.active) return null;
  return { id: t.id, firstName: t.firstName, lastName: t.lastName, type: t.type, company: t.company, phone: t.phone };
}

function ctxOf(c: Context): MutationCtx {
  const user = getUser(c);
  return { user, summarySuffix: "(z panelu technika)" };
}

/**
 * Zapis wymaga poziomu `edit` na kluczu `technik`. Dla roli `technik` daje go
 * `levelFor` (konto jednego ekranu), dla zwykłego konta — macierz admina.
 * Strażnik prefiksu robi to samo, ale router ma być bezpieczny również wtedy,
 * gdy ktoś zamontuje go bez middleware (skrypty, testy).
 */
function assertCanWrite(user: User): void {
  if (!canEdit(user, "technik")) {
    throw new ApiError(403, "Brak uprawnień do edycji (tryb tylko do odczytu)");
  }
}

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`[technik] Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

// ---------------------------------------------------------------------------
// Zlecenia technika — zapytania
// ---------------------------------------------------------------------------

/**
 * Warunki „to jest zlecenie TEGO technika": dział techniczny, żywe, nieanulowane,
 * typ z pracami na obiekcie (PROTOCOL_TYPES) i przypisanie do niego.
 * Urlopy, biuro i przygotowanie celowo poza listą — to nie są wyjazdy do klienta.
 */
function mineConditions(technicianId: number) {
  return [
    eq(schema.calendarEvents.department, "technical"),
    isNull(schema.calendarEvents.deletedAt),
    ne(schema.calendarEvents.status, "cancelled"),
    inArray(schema.calendarEvents.type, [...PROTOCOL_TYPES]),
    sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id = ${technicianId})`,
  ];
}

/** Id zleceń technika w zakresie [from, to) — nachodzenie jak w GET /calendar/events. */
function myJobIds(technicianId: number, from: string | null, to: string | null, limit = 500): number[] {
  const conds = mineConditions(technicianId);
  if (from) conds.push(gt(schema.calendarEvents.endAt, from));
  if (to) conds.push(lt(schema.calendarEvents.startAt, to));
  return db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(and(...conds))
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .limit(limit)
    .all()
    .map((r) => r.id);
}

/**
 * Znacznik „ostatnio widziane” z query (ISO z przeglądarki) → format SQLite
 * `YYYY-MM-DD HH:MM:SS` w UTC, bo tak wygląda `calendar_events.updated_at`.
 * Śmieć albo brak → null (= technik jeszcze nie zaglądał, nic nie liczymy).
 */
function seenSince(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Ile zleceń technika w oknie [from, to) zmieniło się PO `since` — nowe
 * przypisanie, przesunięcie, zmiana opisu — z pominięciem zmian, które zrobił
 * sam technik z panelu (Rozpocznij/Zakończ nie ma go straszyć żółtą plakietką).
 */
function changedJobsCount(technicianId: number, userId: number, from: string, to: string, since: string | null): number {
  if (!since) return 0;
  const conds = mineConditions(technicianId);
  conds.push(gt(schema.calendarEvents.endAt, from), lt(schema.calendarEvents.startAt, to));
  conds.push(gt(schema.calendarEvents.updatedAt, since));
  conds.push(sql`(${schema.calendarEvents.updatedBy} IS NULL OR ${schema.calendarEvents.updatedBy} <> ${userId})`);
  return db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(and(...conds)).all().length;
}

/** Wydarzenie technika po id — cudze i nieistniejące wyglądają tak samo (404). */
function myEvent(technicianId: number, id: number): CalendarEventRow {
  const row = db
    .select()
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.id, id), ...mineConditions(technicianId)))
    .get();
  // 404, a nie 403: inaczej po samym kodzie odpowiedzi dałoby się sprawdzać,
  // które wydarzenia w firmie w ogóle istnieją.
  if (!row) throw new ApiError(404, "Nie znaleziono zlecenia");
  return row;
}

// ---------------------------------------------------------------------------
// JobJson — wąski kształt zlecenia dla tabletu
// ---------------------------------------------------------------------------

export interface JobProtocolBrief {
  id: number;
  number: string;
  signed: boolean;
}

export interface JobJson {
  id: number;
  type: string;
  typeLabel: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  objectId: number | null;
  objectName: string | null;
  address: string | null;
  mapsUrl: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  description: string | null;
  notesCount: number;
  protocol: JobProtocolBrief | null;
  /** Pozostali technicy na tym zleceniu (imię i nazwisko) — z kim jedzie. */
  coTechnicians: string[];
}

/** Protokół wydarzenia: jawnie przypięty albo protokół jego realizacji. */
function protocolRowForEvent(ev: Pick<CalendarEventRow, "protocolId" | "realizationId">): Protocol | null {
  if (ev.protocolId != null) {
    return db.select().from(schema.protocols).where(eq(schema.protocols.id, ev.protocolId)).get() ?? null;
  }
  if (ev.realizationId != null) {
    return (
      db.select().from(schema.protocols).where(eq(schema.protocols.realizationId, ev.realizationId)).get() ?? null
    );
  }
  return null;
}

function protocolBrief(p: Protocol | null): JobProtocolBrief | null {
  return p ? { id: p.id, number: p.number, signed: p.signedAt != null } : null;
}

/**
 * Wydarzenia → JobJson, wsadowo (obiekty, kontrahenci, przypisania, notatki
 * i protokoły po jednym zapytaniu na zbiór, bez N+1).
 */
function toJobs(rows: CalendarEventRow[], technicianId: number): JobJson[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const objectIds = [...new Set(rows.map((r) => r.objectId).filter((v): v is number => v != null))];
  const objects = objectIds.length
    ? db
        .select({
          id: schema.objects.id,
          name: schema.objects.name,
          address: schema.objects.address,
          city: schema.objects.city,
          mapsUrl: schema.objects.mapsUrl,
          contractorId: schema.objects.contractorId,
        })
        .from(schema.objects)
        .where(inArray(schema.objects.id, objectIds))
        .all()
    : [];
  const objectById = new Map(objects.map((o) => [o.id, o]));
  const contractorIds = [...new Set(objects.map((o) => o.contractorId))];
  const contractors = contractorIds.length
    ? db
        .select({
          id: schema.contractors.id,
          contactPerson: schema.contractors.contactPerson,
          phone: schema.contractors.phone,
        })
        .from(schema.contractors)
        .where(inArray(schema.contractors.id, contractorIds))
        .all()
    : [];
  const contractorById = new Map(contractors.map((k) => [k.id, k]));

  // Pozostali technicy na zleceniu.
  const coRows = db
    .select({
      eventId: schema.calendarEventAssignees.eventId,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      technicianId: schema.technicians.id,
    })
    .from(schema.calendarEventAssignees)
    .innerJoin(schema.technicians, eq(schema.calendarEventAssignees.technicianId, schema.technicians.id))
    .where(inArray(schema.calendarEventAssignees.eventId, ids))
    .all();
  const coByEvent = new Map<number, string[]>();
  for (const r of coRows) {
    if (r.technicianId === technicianId) continue;
    const list = coByEvent.get(r.eventId) ?? [];
    list.push(`${r.firstName} ${r.lastName}`.trim());
    coByEvent.set(r.eventId, list);
  }

  const noteRows = db
    .select({ eventId: schema.calendarEventNotes.eventId, id: schema.calendarEventNotes.id })
    .from(schema.calendarEventNotes)
    .where(
      and(
        inArray(schema.calendarEventNotes.eventId, ids),
        isNull(schema.calendarEventNotes.deletedAt)
      )
    )
    .all();
  const notesByEvent = new Map<number, number>();
  for (const n of noteRows) notesByEvent.set(n.eventId, (notesByEvent.get(n.eventId) ?? 0) + 1);

  // Protokoły: jawnie przypięte (protocol_id) + protokoły realizacji.
  const protocolIds = rows.map((r) => r.protocolId).filter((v): v is number => v != null);
  const realizationIds = rows.map((r) => r.realizationId).filter((v): v is number => v != null);
  const protocolRows = [
    ...(protocolIds.length
      ? db.select().from(schema.protocols).where(inArray(schema.protocols.id, protocolIds)).all()
      : []),
    ...(realizationIds.length
      ? db.select().from(schema.protocols).where(inArray(schema.protocols.realizationId, realizationIds)).all()
      : []),
  ];
  const protoById = new Map(protocolRows.map((p) => [p.id, p]));
  const protoByRealization = new Map(protocolRows.map((p) => [p.realizationId, p]));

  return rows.map((ev) => {
    const object = ev.objectId != null ? objectById.get(ev.objectId) ?? null : null;
    const contractor = object ? contractorById.get(object.contractorId) ?? null : null;
    const address = object
      ? [object.address, object.city].filter(Boolean).join(", ") || null
      : ev.location || null;
    const proto =
      (ev.protocolId != null ? protoById.get(ev.protocolId) : null) ??
      (ev.realizationId != null ? protoByRealization.get(ev.realizationId) : null) ??
      null;
    return {
      id: ev.id,
      type: ev.type,
      typeLabel: TYPE_LABELS[ev.type] ?? ev.type,
      title: ev.title,
      startAt: ev.startAt,
      endAt: ev.endAt,
      allDay: ev.allDay,
      status: ev.status,
      startedAt: ev.startedAt,
      finishedAt: ev.finishedAt,
      objectId: ev.objectId,
      objectName: object?.name ?? null,
      address,
      mapsUrl: object?.mapsUrl ?? null,
      contactPerson: contractor?.contactPerson ?? null,
      contactPhone: contractor?.phone ?? null,
      description: ev.description,
      notesCount: notesByEvent.get(ev.id) ?? 0,
      protocol: protocolBrief(proto ?? null),
      coTechnicians: coByEvent.get(ev.id) ?? [],
    };
  });
}

function jobsByIds(ids: number[], technicianId: number): JobJson[] {
  if (ids.length === 0) return [];
  const rows = db.select().from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).all();
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return toJobs(rows, technicianId);
}

/**
 * Notatka w kształcie dla panelu. Załączniki są te same, co w kalendarzu
 * (tabela `calendar_note_attachments`), ale `url` MUSI wskazywać na trasę
 * panelu: rola `technik` nie ma wstępu do `/api/calendar/*`, więc adres
 * z `attachmentOfRow` dałby jej 403 na własnym zdjęciu.
 */
interface JobNote {
  id: number;
  text: string;
  userLabel: string | null;
  source: string;
  createdAt: string;
  /** `true` = notatkę napisał ten, kto pyta (front pokazuje mu „Usuń”). */
  mine: boolean;
  attachments: NoteAttachmentJson[];
}

/** Prefiks, pod którym panel serwuje pliki załączników (router pod /api/technik). */
const TECHNIK_ATTACHMENT_URL_PREFIX = "/api/technik/attachments";

/** Ten sam JSON załącznika, ale z adresem trasy panelu zamiast kalendarza. */
function withPanelUrls(list: NoteAttachmentJson[]): NoteAttachmentJson[] {
  return list.map((a) => ({ ...a, url: `${TECHNIK_ATTACHMENT_URL_PREFIX}/${a.id}` }));
}

function jobNotes(eventId: number, userId: number): JobNote[] {
  const rows = db
    .select({
      id: schema.calendarEventNotes.id,
      text: schema.calendarEventNotes.text,
      userId: schema.calendarEventNotes.userId,
      userLabel: schema.calendarEventNotes.userLabel,
      source: schema.calendarEventNotes.source,
      createdAt: schema.calendarEventNotes.createdAt,
    })
    .from(schema.calendarEventNotes)
    .where(and(eq(schema.calendarEventNotes.eventId, eventId), isNull(schema.calendarEventNotes.deletedAt)))
    .orderBy(desc(schema.calendarEventNotes.createdAt), desc(schema.calendarEventNotes.id))
    .limit(200)
    .all();
  // Jedno zapytanie na wszystkie notatki (bez N+1) — tak samo jak w kalendarzu.
  const byNote = attachmentsByNote(db, rows.map((r) => r.id));
  return rows.map(({ userId: author, ...n }) => ({
    ...n,
    mine: author === userId,
    attachments: withPanelUrls(byNote.get(n.id) ?? []),
  }));
}

/** „2026-09-14” + n dni (kalendarzowo, bez stref — daty są lokalne). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sygnał dla otwartych kart CRM — kalendarz techniczny właśnie się zmienił. */
function publish(c: Context, kind: "updated" | "notes", ids: number[]): void {
  publishCalendarChange({
    department: "technical",
    kind,
    eventIds: ids,
    actorUserId: getUser(c).id,
    actorClientId: clientIdOf(c),
  });
}

// ---------------------------------------------------------------------------
// GET /activities — słownik czynności do chipów w protokole
//
// Rola `technik` nie ma wstępu do /api/admin/*, więc nie może przeczytać tego
// samego ustawienia przez panel admina — stąd własna, wąska trasa tylko do
// odczytu. Wystarczy dostęp do modułu (bramka prefiksu jest już za nami);
// powiązanie z kartoteką techników nie jest potrzebne, bo to zwykły słownik.
// ---------------------------------------------------------------------------

app.get("/activities", (c) => c.json({ success: true, data: getTechnikActivities() }));

// ---------------------------------------------------------------------------
// GET /me — kim jestem i ile mam roboty
// ---------------------------------------------------------------------------

app.get("/me", (c) => {
  const user = getUser(c);
  const tech = linkedTechnician(user);
  if (!tech) {
    // Konto bez powiązania to normalny stan (admin jeszcze go nie podpiął) —
    // front pokazuje komunikat, a nie ekran błędu.
    return c.json({
      success: true,
      data: {
        linked: false,
        technician: null,
        canEdit: canEdit(user, "technik"),
        counts: { today: 0, inProgress: 0, upcoming: 0, changedToday: 0, changedUpcoming: 0 },
      },
    });
  }
  const today = zonedToday();
  const tomorrow = addDays(today, 1);
  const horizon = addDays(today, DEFAULT_HORIZON_DAYS);
  // „Od kiedy” liczyć zmiany — osobno dla każdej zakładki, bo technik mógł
  // zajrzeć na Dziś, ale Nadchodzących nie otwierać od tygodnia.
  const seenToday = seenSince(c.req.query("seenToday"));
  const seenUpcoming = seenSince(c.req.query("seenUpcoming"));
  const inProgress = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      and(
        ...mineConditions(tech.id),
        isNotNull(schema.calendarEvents.startedAt),
        ne(schema.calendarEvents.status, "done")
      )
    )
    .all().length;
  return c.json({
    success: true,
    data: {
      linked: true,
      technician: tech,
      canEdit: canEdit(user, "technik"),
      counts: {
        today: myJobIds(tech.id, today, tomorrow).length,
        inProgress,
        upcoming: myJobIds(tech.id, today, horizon).length,
        changedToday: changedJobsCount(tech.id, user.id, today, tomorrow, seenToday),
        changedUpcoming: changedJobsCount(tech.id, user.id, today, horizon, seenUpcoming),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/weather?ids= — pogoda dla zleceń technika (batch)
//
// Rola `technik` nie ma dostępu do /api/calendar (technikRoleGuard), więc
// kalendarzowe GET /calendar/weather jest dla panelu nieosiągalne. Liczy to
// DOKŁADNIE ta sama funkcja (`weatherBriefs`) i odpowiedź ma ten sam kształt
// `{ items, retry }` — front panelu może użyć tej samej logiki ponawiania.
//
// KOLEJNOŚĆ REJESTRACJI MA ZNACZENIE: ta trasa musi stać PRZED `/jobs/:id`,
// bo Hono dopasowuje w kolejności rejestracji i `:id` złapałby „weather”
// (Number("weather") = NaN → 400). Dlatego blok siedzi tutaj, a nie na końcu pliku.
//
// Cudze id są odfiltrowane tak samo jak wszędzie w tym routerze — przez
// `mineConditions`, a nie przez samo istnienie wydarzenia; nie ma ich nawet
// w kluczach `items` (po odpowiedzi nie da się zgadywać cudzych wydarzeń).
//
// Pogoda NIGDY nie wywraca listy: brak sieci, brak punktu czy dzień poza oknem
// prognozy to `null` w HTTP 200, a wyjątek — pusta mapa, też w 200.
// ---------------------------------------------------------------------------

/** Ile zleceń wolno spytać jednym batchem (jak w kalendarzu). */
const WEATHER_MAX_IDS = 200;

/** „1,2,3” → unikalne dodatnie liczby całkowite (jak `parseIdList` kalendarza). */
function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

app.get("/jobs/weather", async (c) => {
  const empty = { items: {} as Record<string, WeatherBrief | null>, retry: [] as number[] };
  try {
    const tech = linkedTechnician(getUser(c));
    if (!tech) return c.json({ success: true, data: empty });

    const requested = parseIdList(c.req.query("ids")).slice(0, WEATHER_MAX_IDS);
    if (requested.length === 0) return c.json({ success: true, data: empty });

    const mine = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(and(inArray(schema.calendarEvents.id, requested), ...mineConditions(tech.id)))
      .all()
      .map((r) => r.id);

    const items: Record<string, WeatherBrief | null> = {};
    for (const id of mine) items[String(id)] = null;
    if (mine.length === 0) return c.json({ success: true, data: { items, retry: [] } });

    const batch = await weatherBriefs(loadWeatherEvents(mine), {});
    for (const [id, brief] of batch.items) items[String(id)] = brief;
    // `retry` odróżnia „null, bo nie ma pogody” (poza oknem, brak punktu) od
    // „null, bo się nie udało” (offline, limit geokodowań) — front ponawia tylko te drugie.
    return c.json({ success: true, data: { items, retry: batch.retry } });
  } catch (error) {
    // Świadomie NIE handleError: pogoda ma się degradować do pustki, a nie psuć listę zleceń.
    console.error("[technik] Błąd pogody:", error);
    return c.json({ success: true, data: empty });
  }
});

// ---------------------------------------------------------------------------
// GET /jobs — lista zleceń w zakresie dat
// ---------------------------------------------------------------------------

app.get("/jobs", (c) => {
  try {
    const tech = linkedTechnician(getUser(c));
    if (!tech) return c.json({ success: true, data: [] });
    const from = c.req.query("from") || zonedToday();
    const to = c.req.query("to") || addDays(from, DEFAULT_HORIZON_DAYS);
    if (!DATE_RE.test(from)) throw new ApiError(400, "Parametr from: YYYY-MM-DD");
    if (!DATE_RE.test(to)) throw new ApiError(400, "Parametr to: YYYY-MM-DD");
    return c.json({ success: true, data: jobsByIds(myJobIds(tech.id, from, to), tech.id) });
  } catch (error) {
    return handleError(c, error, "pobierania zleceń");
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:id — szczegóły + notatki + skrót protokołu
// ---------------------------------------------------------------------------

app.get("/jobs/:id", (c) => {
  try {
    const user = getUser(c);
    const tech = linkedTechnician(user);
    if (!tech) throw new ApiError(404, "Nie znaleziono zlecenia");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
    const ev = myEvent(tech.id, id);
    const [job] = toJobs([ev], tech.id);
    return c.json({ success: true, data: { ...job, notes: jobNotes(ev.id, user.id) } });
  } catch (error) {
    return handleError(c, error, "pobierania zlecenia");
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:id/distance — ile kilometrów wpisać w protokół
//
// Ta sama kalkulacja, co automat realizacji (src/lib/realization-autofill.ts):
// `distanceForObject` liczy biuro → obiekt w JEDNĄ stronę i honoruje ustawienie
// `company.km_source` (tryb „ręcznie” = świadome „nie licz”), a mnożnik „w obie
// strony" nakłada dopiero `company.km_round_trip`. Geokoder bywa martwy, więc
// ta trasa NIGDY nie zwraca 500 — brak wyniku to `{ km: null, reason }`.
// ---------------------------------------------------------------------------

app.get("/jobs/:id/distance", async (c) => {
  try {
    const tech = linkedTechnician(getUser(c));
    if (!tech) throw new ApiError(404, "Nie znaleziono zlecenia");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
    const ev = myEvent(tech.id, id);
    if (ev.objectId == null) {
      return c.json({
        success: true,
        data: { km: null, reason: "Zlecenie nie ma przypiętego obiektu — nie ma dokąd liczyć trasy" },
      });
    }

    const roundTrip = getCompanyConfig().values.kmRoundTrip;
    const d = await distanceForObject(ev.objectId);
    if (isGeoError(d)) return c.json({ success: true, data: { km: null, reason: d.error } });

    const roundTripKm = Math.round(d.km * 2 * 10) / 10;
    return c.json({
      success: true,
      data: {
        km: d.km,
        roundTripKm,
        // To, co ma trafić do pola „Kilometry” — front nie powtarza reguły firmy.
        suggestedKm: roundTrip ? roundTripKm : d.km,
        roundTrip,
        // Czas przejazdu w JEDNĄ stronę: OSRM liczy go razem z trasą, więc nie
        // kosztuje osobnego zapytania. `minutesEstimated` = wynik z szacunku
        // (trasa prosta / cache sprzed dodania czasu), nie z routera — front
        // pokazuje wtedy „≈”. Pole jest DODATKOWE; protokół czyta tylko km.
        minutes: d.minutes,
        minutesEstimated: d.minutesEstimated,
        method: d.method,
        from: d.from.label,
        to: d.to.label,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return handleError(c, error, "liczenia dystansu");
    // Sieć/geokoder: brak km to nie awaria zlecenia — technik wpisze ręcznie.
    console.error("[technik] Błąd liczenia dystansu:", error);
    return c.json({ success: true, data: { km: null, reason: "Nie udało się policzyć odległości" } });
  }
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/start — „Rozpocznij" (idempotentne)
// ---------------------------------------------------------------------------

/** Wspólne wejście mutacji: technik + jego wydarzenie (albo ApiError). */
function mutationTarget(c: Context, rawId: string): { tech: LinkedTechnician; ev: CalendarEventRow; ctx: MutationCtx } {
  const user = getUser(c);
  assertCanWrite(user);
  const tech = linkedTechnician(user);
  if (!tech) {
    throw new ApiError(409, "Konto nie jest powiązane z technikiem — zgłoś to administratorowi");
  }
  const id = Number(rawId);
  if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
  return { tech, ev: myEvent(tech.id, id), ctx: ctxOf(c) };
}

/** „HH:MM" z czasu lokalnego serwera — do treści notatki systemowej. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * „o 16:20” dla dzisiaj, „13.09 o 16:20” dla innego dnia. Notatka ma być
 * czytelna także wtedy, gdy technik wpisze godzinę dzień później, z domu.
 */
function whenLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `o ${hhmm(d)}` : `${p(d.getDate())}.${p(d.getMonth() + 1)} o ${hhmm(d)}`;
}

/** Lokalny zapis chwili z panelu: `YYYY-MM-DDTHH:MM` (tak samo jak `start_at`). */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Ile do przodu wolno wskazać — zegar tabletu bywa minutę do przodu. */
const AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** Jak daleko wstecz od terminu zlecenia wolno cofnąć znacznik. */
const AT_PAST_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chwila „Rozpoczęto/Zakończono” z ciała żądania. Brak pola `at` = teraz
 * (zwykły tap „Teraz”), a wpisana godzina jest czytana w STREFIE SERWERA —
 * kalendarz trzyma czas lokalny bez strefy i panel nie może tu wprowadzać
 * drugiej konwencji.
 *
 * Granice są celowo miękkie w jedną stronę: technik uzupełnia zaległości
 * wstecz (wczoraj zapomniał kliknąć), ale nie ma powodu „rozpoczynać” roboty
 * w przyszłości ani cofać się o miesiąc od terminu zlecenia.
 */
function momentFromBody(body: Record<string, unknown>, ev: CalendarEventRow): Date {
  const raw = typeof body.at === "string" ? body.at.trim() : "";
  if (!raw) return new Date();
  if (!AT_RE.test(raw)) throw new ApiError(400, "Pole at: oczekiwano daty i godziny w formacie RRRR-MM-DDTGG:MM");
  const [datePart, timePart] = raw.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mi] = timePart.split(":").map(Number);
  const at = new Date(y, m - 1, d, hh, mi, 0, 0);
  // Kontrola „31.02”: konstruktor przewija taką datę na marzec zamiast błędu.
  if (Number.isNaN(at.getTime()) || at.getMonth() !== m - 1 || at.getDate() !== d || hh > 23 || mi > 59) {
    throw new ApiError(400, "Pole at: nieprawidłowa data lub godzina");
  }
  if (at.getTime() > Date.now() + AT_FUTURE_TOLERANCE_MS) {
    throw new ApiError(400, "Nie można wpisać godziny z przyszłości");
  }
  const plannedStart = new Date(ev.startAt).getTime();
  if (Number.isFinite(plannedStart) && at.getTime() < plannedStart - AT_PAST_LIMIT_MS) {
    throw new ApiError(400, "Godzina jest wcześniejsza niż tydzień przed terminem zlecenia");
  }
  return at;
}

app.post("/jobs/:id/start", async (c) => {
  try {
    const { tech, ev, ctx } = mutationTarget(c, c.req.param("id"));
    // Idempotentnie: drugie kliknięcie (odświeżona karta, słaby zasięg) nie
    // przestawia godziny rozpoczęcia i nie dopisuje drugiej notatki.
    if (ev.startedAt) {
      const [job] = toJobs([ev], tech.id);
      return c.json({ success: true, data: job, message: "Zlecenie jest już rozpoczęte" });
    }
    // „Teraz” (brak `at`) albo godzina wybrana w panelu — zapis zawsze jako ISO UTC.
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const now = momentFromBody(body, ev);
    const startedAt = now.toISOString();
    const after = db.transaction((tx) => {
      const row = setEventProgress(
        tx,
        ev.id,
        {
          startedAt,
          // „Zaplanowane" → „Potwierdzone": ktoś na pewno tam jest. Statusu
          // „wykonane" ani „anulowane" nie ruszamy (praca mogła być wznowiona).
          ...(ev.status === "planned" ? { status: "confirmed" as const } : {}),
        },
        ctx
      );
      addNote(tx, {
        eventId: ev.id,
        text: `Rozpoczęto ${whenLabel(now)}`,
        ctx,
        source: "system",
      });
      return row;
    });
    publish(c, "updated", [ev.id]);
    const [job] = toJobs([after], tech.id);
    return c.json({ success: true, data: job, message: "Zlecenie rozpoczęte" });
  } catch (error) {
    return handleError(c, error, "rozpoczynania zlecenia");
  }
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/finish — „Zakończ" (+ opcjonalna notatka)
// ---------------------------------------------------------------------------

app.post("/jobs/:id/finish", async (c) => {
  try {
    const { tech, ev, ctx } = mutationTarget(c, c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const noteText = typeof body.note === "string" ? body.note.trim() : "";
    const now = momentFromBody(body, ev);
    const finishedAt = now.toISOString();
    // Kolejność zdarzeń musi się zgadzać — inaczej realizacja dostałaby ujemny
    // czas pracy, a protokół godziny „od 16:00 do 09:00”.
    if (ev.startedAt && finishedAt < ev.startedAt) {
      throw new ApiError(400, "Zakończenie nie może być przed rozpoczęciem");
    }
    const after = db.transaction((tx) => {
      const row = setEventProgress(
        tx,
        ev.id,
        {
          status: "done",
          finishedAt,
          // Zakończenie bez rozpoczęcia (technik zapomniał wcisnąć „Rozpocznij")
          // nie może zostawić dziury — za początek bierzemy planowany start.
          ...(ev.startedAt ? {} : { startedAt: ev.startAt }),
        },
        ctx
      );
      addNote(tx, {
        eventId: ev.id,
        text: noteText ? `Zakończono ${whenLabel(now)}. ${noteText}` : `Zakończono ${whenLabel(now)}`,
        ctx,
        source: noteText ? "user" : "system",
      });
      return row;
    });
    publish(c, "updated", [ev.id]);
    const [job] = toJobs([after], tech.id);
    return c.json({ success: true, data: job, message: "Zlecenie zakończone" });
  } catch (error) {
    return handleError(c, error, "kończenia zlecenia");
  }
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/notes — wpis do dziennika zlecenia (tekst i/lub zdjęcia)
//
// Dwa ciała, jedna trasa: JSON `{text}` jak dotąd oraz `multipart/form-data`
// z polami `text` (wtedy opcjonalne) i `files` — tablet wysyła tak zdjęcia
// z aparatu. Pliki idą tą samą drogą co upload z biura (storeUploads: obrazki
// → WebP, max 2560 px, 15 × 5 MB), a limit CIAŁA żądania dokłada
// `bodyLimitFor` w src/routes/index.ts.
// ---------------------------------------------------------------------------

/** `text` + `files` z ciała żądania — multipart albo JSON (wtedy bez plików). */
async function readJobNoteBody(c: Context): Promise<{ text: string; files: IncomingFile[] }> {
  if (!/multipart\/form-data/i.test(c.req.header("content-type") ?? "")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return { text: parseNoteText(body.text), files: [] };
  }
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new ApiError(400, "Nieprawidłowe dane formularza");
  const { text, files } = await parseNoteForm(form);
  // Zdjęcie samo w sobie jest treścią — pusty tekst przechodzi tylko z plikami.
  return { text: parseNoteText(text, files.length > 0), files };
}

app.post("/jobs/:id/notes", async (c) => {
  try {
    const { ev, ctx } = mutationTarget(c, c.req.param("id"));
    const { text, files } = await readJobNoteBody(c);
    // Zlecenie sprawdzone wyżej (mutationTarget), więc obrazki mielimy dopiero
    // teraz; przy błędzie wstawiania wiersza sprzątamy je z dysku.
    const attachments = files.length ? await storeUploads(ev.id, files) : [];
    let note;
    try {
      note = db.transaction((tx) => addNote(tx, { eventId: ev.id, text, ctx, attachments }));
    } catch (error) {
      removeStoredFiles(attachments);
      throw error;
    }
    publish(c, "notes", [ev.id]);
    return c.json(
      {
        success: true,
        data: {
          id: note.id,
          text: note.text,
          userLabel: note.userLabel,
          source: note.source,
          createdAt: note.createdAt,
          mine: true,
          attachments: withPanelUrls(note.attachments),
        },
      },
      201
    );
  } catch (error) {
    return handleError(c, error, "dodawania notatki");
  }
});

// ---------------------------------------------------------------------------
// Załączniki notatek: GET /attachments/:id (inline, ?download=1) i DELETE
//
// Rola `technik` nie ma wstępu do `/api/calendar/*`, więc panel serwuje pliki
// sam. Widoczność liczy się tak jak reszta routera: załącznik → notatka →
// wydarzenie, a wydarzenie musi być zleceniem TEGO technika (myEvent, czyli
// przypisanie w `calendar_event_assignees`). Cudze = 404, nigdy 403 — po kodzie
// odpowiedzi nie da się wtedy zgadywać, co w firmie istnieje.
// ---------------------------------------------------------------------------

/** Załącznik z notatki MOJEGO zlecenia albo 404. */
function myAttachment(c: Context, rawId: string) {
  const user = getUser(c);
  const tech = linkedTechnician(user);
  if (!tech) throw new ApiError(404, "Załącznik nie istnieje");
  const attId = Number(rawId);
  if (!Number.isInteger(attId)) throw new ApiError(400, "Nieprawidłowe id");
  const att = db
    .select()
    .from(schema.calendarNoteAttachments)
    .where(eq(schema.calendarNoteAttachments.id, attId))
    .get();
  if (!att) throw new ApiError(404, "Załącznik nie istnieje");
  const note = getNoteRow(db, att.noteId);
  if (!note || note.deletedAt) throw new ApiError(404, "Załącznik nie istnieje");
  return { user, att, note, ev: myEvent(tech.id, note.eventId) };
}

app.get("/attachments/:attachmentId", (c) => {
  try {
    const { att } = myAttachment(c, c.req.param("attachmentId"));
    const abs = attachmentFilePath(att.storedPath);
    if (!abs) throw new ApiError(404, "Plik załącznika nie istnieje na dysku");
    const download = c.req.query("download") === "1";
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": att.mime,
        "Content-Length": String(statSync(abs).size),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(download ? "attachment" : "inline", att.fileName),
      },
    });
  } catch (error) {
    return handleError(c, error, "pobierania załącznika");
  }
});

app.delete("/attachments/:attachmentId", (c) => {
  try {
    const { user, att, note, ev } = myAttachment(c, c.req.param("attachmentId"));
    assertCanWrite(user);
    // Te same zasady co w kalendarzu: kasuje autor notatki (albo admin, gdy
    // panel ma konto biurowe). Cudzej notatki technik nie ruszy.
    if (!canManageNote(note, user)) {
      throw new ApiError(403, "Tylko autor notatki może usunąć załącznik");
    }
    db.delete(schema.calendarNoteAttachments).where(eq(schema.calendarNoteAttachments.id, att.id)).run();
    // Plik znika dopiero po skasowaniu wiersza — odwrotna kolejność zostawiłaby
    // w bazie załącznik bez pliku, czyli zepsutą miniaturę w notatce.
    removeStoredFiles([att]);
    publish(c, "notes", [ev.id]);
    return c.json({ success: true, data: { id: att.id, noteId: att.noteId } });
  } catch (error) {
    return handleError(c, error, "usuwania załącznika");
  }
});

// ---------------------------------------------------------------------------
// Notatka systemowa ze streszczeniem protokołu
//
// Biuro patrzy na kalendarz, nie na tablet — bez tego wpisu z wydarzenia widać
// tylko, ŻE protokół istnieje. JEDNA notatka na protokół (wskazuje ją
// `protocols.note_id`, migracja 0102), podmieniana przy każdym zapisie
// i przy podpisie, żeby dziennik zlecenia nie puchł od kolejnych kopii.
// ---------------------------------------------------------------------------

/** „14.09.2026 13:41” z ISO serwera — w notatce data ma być do przeczytania, nie do parsowania. */
function plDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** „Kamera IP 4MP, S/N 12345, 2 szt.” — puste części pomijamy. */
function itemLine(it: ProtocolItem): string {
  const name = (it.name ?? "").trim();
  const serial = (it.serial ?? "").trim();
  const qty = String(it.qty ?? "").trim();
  const unit = (it.unit ?? "").trim();
  const parts = [name || "(bez nazwy)"];
  if (serial) parts.push(`S/N ${serial}`);
  if (qty) parts.push(unit ? `${qty} ${unit}` : qty);
  return parts.join(", ");
}

/** Treść notatki: nagłówek ze stanem podpisu, czynności, urządzenia, link. */
function protocolNoteText(protocol: Protocol, href: string): string {
  const parsed = withParsedItems(protocol);
  const head = protocol.signedAt
    ? `Protokół ${protocol.number} — podpisany ${plDateTime(protocol.signedAt)}${
        protocol.signerName ? `, odebrał: ${protocol.signerName}` : ""
      }`
    : `Protokół ${protocol.number} — NIEPODPISANY`;

  const lines: string[] = [head];

  const activities = (protocol.activities ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Puste sekcje pomijamy — „Wykonane czynności: —” to szum w dzienniku.
  if (activities.length) {
    lines.push("Wykonane czynności:");
    for (const a of activities) lines.push(`- ${a}`);
  }

  const items = parsed.items.filter((i) => (i.name ?? "").trim() || (i.serial ?? "").trim());
  if (items.length) {
    lines.push("Zamontowane urządzenia:");
    for (const it of items) lines.push(`- ${itemLine(it)}`);
  }

  lines.push(`Otwórz protokół <${href}>`);

  const text = lines.join("\n");
  // Protokół bywa dłuższy niż limit notatki (4000 znaków) — wtedy przycinamy
  // treść, ale link zostaje: pełna wersja i tak jest w samym protokole.
  if (text.length <= CALENDAR_NOTE_MAX) return text;
  const tail = `\n…\nOtwórz protokół <${href}>`;
  return `${text.slice(0, CALENDAR_NOTE_MAX - tail.length)}${tail}`;
}

/**
 * Adres protokołu w CRM — WZGLĘDNA ścieżka, ta sama co `protocolHref` we
 * froncie. Bez hosta świadomie: notatka żyje w bazie latami, a host z devu
 * (albo z tunelu) byłby w niej martwym linkiem po pierwszym wdrożeniu.
 * Składnia „tekst <ścieżka>” to wzorzec Outlooka, który rozumie już
 * `frontend/src/lib/linkify.ts` — renderuje ją jako link SPA z etykietą.
 */
function protocolHrefOf(protocolId: number): string {
  return `/technical/protokoly?protocol=${protocolId}`;
}

/**
 * Zakłada albo aktualizuje notatkę systemową protokołu. Aktualizacja idzie
 * BEZPOŚREDNIM UPDATE-em, a nie przez `updateNote`: tamta funkcja wymaga, żeby
 * edytował autor albo admin, a notatkę zakłada ten technik, który pierwszy
 * dotknął protokołu — drugi technik z tej samej ekipy dostałby 403. Mija nas
 * też cały automat wzmianek dat (`@piątek`), bo tekst systemowy ich nie ma.
 * Wpisu do `activity_log` przy odświeżeniu świadomie nie robimy: sam zapis
 * protokołu jest już zalogowany, a notatka jest jego lustrem.
 */
function syncProtocolNote(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { eventId: number; protocol: Protocol; ctx: MutationCtx; href: string }
): void {
  const text = protocolNoteText(input.protocol, input.href);
  const existingId = input.protocol.noteId;
  if (existingId) {
    const row = getNoteRow(tx, existingId);
    if (row && !row.deletedAt) {
      if (row.text !== text) {
        tx.update(schema.calendarEventNotes)
          .set({ text, updatedAt: sql`(datetime('now'))` })
          .where(eq(schema.calendarEventNotes.id, existingId))
          .run();
      }
      return;
    }
  }
  const note = addNote(tx, { eventId: input.eventId, text, ctx: input.ctx, source: "system" });
  tx.update(schema.protocols)
    .set({ noteId: note.id })
    .where(eq(schema.protocols.id, input.protocol.id))
    .run();
}

/**
 * Notatka nie może wywrócić zapisu protokołu — technik stoi u klienta i liczy
 * się dokument, a nie jego streszczenie w kalendarzu. Zwraca true, gdy coś
 * zmieniono (wtedy warto wysłać sygnał „notes” do otwartych kart biura).
 */
function syncProtocolNoteSafely(eventId: number, protocol: Protocol, ctx: MutationCtx): boolean {
  try {
    const href = protocolHrefOf(protocol.id);
    db.transaction((tx) => syncProtocolNote(tx, { eventId, protocol, ctx, href }));
    return true;
  } catch (error) {
    console.error("[technik] Nie udało się zsynchronizować notatki protokołu:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /jobs/:id/protocol — załóż protokół dla zlecenia
// ---------------------------------------------------------------------------

app.post("/jobs/:id/protocol", (c) => {
  try {
    const { ev, ctx } = mutationTarget(c, c.req.param("id"));
    const existing = protocolRowForEvent(ev);
    if (existing) {
      return c.json(
        {
          success: false,
          error: "To zlecenie ma już protokół",
          data: { protocol: protocolBrief(existing) },
        },
        409
      );
    }

    const outcome = db.transaction((tx) => {
      const row = getEventRow(tx, ev.id);
      if (!row) return { status: 404 as const };
      if (row.realizationId == null) {
        // `force: true` omija ustawienie „twórz realizacje dopiero po wykonaniu":
        // technik wypełnia protokół U KLIENTA, zanim zlecenie jest zamknięte.
        // Ręczne „Odepnij" (realization_optout) wygrywa nawet z force — wtedy
        // ensure zwraca powód i oddajemy go użytkownikowi.
        const res = ensureRealizationForEvent(tx, row, ctx, { force: true });
        if (!res.created) return { status: 409 as const, reason: res.reason };
        const fresh = getEventRow(tx, ev.id)!;
        const created = fresh.realizationId
          ? tx
              .select()
              .from(schema.protocols)
              .where(eq(schema.protocols.realizationId, fresh.realizationId))
              .get()
          : undefined;
        return created
          ? { status: 201 as const, protocol: created }
          : { status: 409 as const, reason: "nie udało się utworzyć protokołu" };
      }
      const realization = tx
        .select()
        .from(schema.realizations)
        .where(eq(schema.realizations.id, row.realizationId))
        .get();
      if (!realization) return { status: 409 as const, reason: "realizacja zlecenia nie istnieje" };
      const created = createProtocolForRealizationSync(tx, realization);
      if (!created) {
        // ON CONFLICT DO NOTHING → protokół powstał równolegle.
        const raced = tx
          .select()
          .from(schema.protocols)
          .where(eq(schema.protocols.realizationId, realization.id))
          .get();
        return raced
          ? { status: 409 as const, protocol: raced }
          : { status: 409 as const, reason: "nie udało się utworzyć protokołu" };
      }
      return { status: 201 as const, protocol: created };
    });

    if (outcome.status === 404) throw new ApiError(404, "Nie znaleziono zlecenia");
    if (outcome.status === 409) {
      return c.json(
        {
          success: false,
          error:
            "protocol" in outcome && outcome.protocol
              ? "To zlecenie ma już protokół"
              : `Nie można założyć protokołu: ${outcome.reason ?? "nieznany powód"}`,
          data: { protocol: "protocol" in outcome ? protocolBrief(outcome.protocol ?? null) : null },
        },
        409
      );
    }
    // Streszczenie protokołu ląduje w dzienniku zlecenia od razu przy założeniu
    // — biuro widzi w kalendarzu „NIEPODPISANY” i wie, że technik jest w polu.
    syncProtocolNoteSafely(ev.id, outcome.protocol, ctx);
    publish(c, "updated", [ev.id]);
    publish(c, "notes", [ev.id]);
    return c.json(
      {
        success: true,
        data: { protocol: protocolBrief(outcome.protocol) },
        message: `Protokół ${outcome.protocol.number} utworzony`,
      },
      201
    );
  } catch (error) {
    return handleError(c, error, "zakładania protokołu");
  }
});

// ---------------------------------------------------------------------------
// Protokół: GET/PUT /protocols/:id, POST /protocols/:id/sign
// ---------------------------------------------------------------------------

/**
 * Protokół należy do technika, gdy JEGO zlecenie wskazuje go wprost
 * (`protocol_id`) albo przez realizację. Cudzy = 404, tak jak cudze zlecenie.
 */
function myProtocol(technicianId: number, protocolId: number): { protocol: Protocol; event: CalendarEventRow } {
  const protocol = db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get();
  if (!protocol) throw new ApiError(404, "Nie znaleziono protokołu");
  const event = db
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        sql`(${schema.calendarEvents.protocolId} = ${protocolId} OR ${schema.calendarEvents.realizationId} = ${protocol.realizationId})`,
        ...mineConditions(technicianId)
      )
    )
    .get();
  if (!event) throw new ApiError(404, "Nie znaleziono protokołu");
  return { protocol, event };
}

/** Technik z powiązaniem albo ApiError — dla tras protokołu (odczyt). */
function requireTechnician(c: Context): LinkedTechnician {
  const tech = linkedTechnician(getUser(c));
  if (!tech) throw new ApiError(404, "Nie znaleziono protokołu");
  return tech;
}

app.get("/protocols/:id", (c) => {
  try {
    const tech = requireTechnician(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
    const { protocol, event } = myProtocol(tech.id, id);
    return c.json({ success: true, data: { ...withParsedItems(protocol), jobId: event.id } });
  } catch (error) {
    return handleError(c, error, "pobierania protokołu");
  }
});

app.put("/protocols/:id", async (c) => {
  try {
    const user = getUser(c);
    assertCanWrite(user);
    const tech = linkedTechnician(user);
    if (!tech) throw new ApiError(409, "Konto nie jest powiązane z technikiem — zgłoś to administratorowi");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
    const { event } = myProtocol(tech.id, id);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const outcome = db.transaction((tx) => updateProtocolSync(tx, id, body));
    if (outcome.status === 400) return c.json({ success: false, error: outcome.error }, 400);
    if (outcome.status === 404) return c.json({ success: false, error: "Nie znaleziono protokołu" }, 404);
    if (outcome.status === 409) {
      return c.json({ success: false, error: protocolConflictMessage(outcome.signed) }, 409);
    }
    // Notatka systemowa zlecenia idzie za treścią protokołu — biuro czyta
    // czynności i listę urządzeń bez otwierania dokumentu.
    if (syncProtocolNoteSafely(event.id, outcome.data, ctxOf(c))) publish(c, "notes", [event.id]);
    return c.json({
      success: true,
      data: { ...withParsedItems(outcome.data), jobId: event.id },
      message: "Protokół zapisany",
    });
  } catch (error) {
    return handleError(c, error, "zapisywania protokołu");
  }
});

app.post("/protocols/:id/sign", async (c) => {
  try {
    const user = getUser(c);
    assertCanWrite(user);
    const tech = linkedTechnician(user);
    if (!tech) throw new ApiError(409, "Konto nie jest powiązane z technikiem — zgłoś to administratorowi");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new ApiError(400, "Nieprawidłowe id");
    const { event } = myProtocol(tech.id, id);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const signaturePng = typeof body.signaturePng === "string" ? body.signaturePng : "";
    const signerName = typeof body.signerName === "string" ? body.signerName.trim() : "";
    const expectedUpdatedAt =
      typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
    const check = checkSignaturePng(signaturePng);
    if (!check.ok) return c.json({ success: false, error: check.error }, 400);
    if (!signerName) return c.json({ success: false, error: "Podaj imię i nazwisko osoby odbierającej" }, 400);

    const outcome = db.transaction((tx) =>
      signProtocolSync(tx, id, { signaturePng, signerName, expectedUpdatedAt })
    );
    if (outcome.status === 404) return c.json({ success: false, error: "Nie znaleziono protokołu" }, 404);
    if (outcome.status === 409) return c.json({ success: false, error: protocolConflictMessage() }, 409);

    // Notatka zlecenia dostaje stan „podpisany” razem z nazwiskiem odbierającego.
    if (syncProtocolNoteSafely(event.id, outcome.data, ctxOf(c))) publish(c, "notes", [event.id]);

    // Ta sama ścieżka co w biurze: automat realizacji + przeliczenie wyceny.
    const effects = await afterProtocolSigned(outcome.data.realizationId, user);
    // ODPOWIEDŹ BEZ `autofill`/`quote`: obie niosą kwoty i nazwy pozycji wyceny,
    // a ekran technika (także podwykonawcy) nie ma prawa ich pokazać.
    return c.json({
      success: true,
      data: { ...withParsedItems(outcome.data), jobId: event.id },
      message: effects.autofill || effects.quote ? "Protokół podpisany" : effects.message,
    });
  } catch (error) {
    return handleError(c, error, "podpisywania protokołu");
  }
});

// ---------------------------------------------------------------------------
// POWIADOMIENIA PUSH (Web Push / VAPID) — wyłącznie panel technika
//
// Trzy trasy i tyle: konfiguracja publiczna (klucz VAPID do `subscribe()`),
// zapis subskrypcji i wypisanie. Bez kluczy w env `config` oddaje
// `enabled: false`, a front chowa przełącznik zamiast pokazywać zepsutą opcję.
//
// Wystarczy dostęp do modułu (bramka prefiksu jest już za nami) — także
// `view`: włączenie sobie powiadomień to nie edycja cudzych danych, a technik
// „tylko do odczytu" też musi wiedzieć, że dostał zlecenie.
// ---------------------------------------------------------------------------

/** Wyciąga `{endpoint, keys}` z `PushSubscription.toJSON()` przysłanego przez front. */
function parseSubscription(body: Record<string, unknown>): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
  if (!/^https:\/\//i.test(endpoint)) throw new ApiError(400, "endpoint: wymagany adres https push service");
  if (endpoint.length > 2000) throw new ApiError(400, "endpoint: adres jest za długi");
  if (!p256dh || !auth) throw new ApiError(400, "keys: wymagane p256dh i auth");
  return { endpoint, p256dh, auth };
}

app.get("/push/config", (c) => c.json({ success: true, data: pushConfig() }));

app.post("/push/subscribe", async (c) => {
  try {
    const user = getUser(c);
    if (!isPushEnabled()) {
      // Brak kluczy to konfiguracja środowiska, nie błąd klienta — front i tak
      // zapyta najpierw o `config`, ale zapis „w próżnię" byłby mylący.
      return c.json({ success: false, error: "Powiadomienia push nie są skonfigurowane na serwerze" }, 503);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = parseSubscription(body);
    const row = saveSubscription({
      ...parsed,
      userId: user.id,
      userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
    });
    return c.json({ success: true, data: { id: row.id, endpoint: row.endpoint } }, 201);
  } catch (error) {
    return handleError(c, error, "zapisu subskrypcji powiadomień");
  }
});

app.delete("/push/subscribe", async (c) => {
  try {
    const user = getUser(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!endpoint) throw new ApiError(400, "endpoint: wymagany");
    // Cudzej subskrypcji się nie kasuje — `false` znaczy „nie było czego",
    // a nie „nie wolno": endpointu i tak nie da się zgadnąć, więc 404 tylko
    // mnożyłoby przypadki do obsłużenia na froncie.
    const removed = deleteSubscription(user.id, endpoint);
    return c.json({ success: true, data: { removed } });
  } catch (error) {
    return handleError(c, error, "usuwania subskrypcji powiadomień");
  }
});

export default app;
