/**
 * Kalendarz działu technicznego — wydarzenia (serwis/montaż/wizja/...),
 * serie cykliczne (konserwacje), przypisania techników, historia zmian
 * (activity_log) i publiczny feed ICS po tokenie użytkownika.
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
import { randomBytes } from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, desc, asc, isNull, inArray, sql, lt, gt, gte, ne } from "drizzle-orm";
import { type CalendarEventType, type CalendarEventStatus } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { describeRule } from "../lib/calendar-recurrence.js";
import { conflictEventIds, loadEvent, loadEvents, type CalendarEventJson } from "../lib/calendar-queries.js";
import {
  CALENDAR_ENTITY as ENTITY,
  DATE_RE,
  createEvent,
  deleteEvent,
  isValidCalendarDate,
  moveEvent,
  parseInput,
  parseScope,
  restoreEvent,
  updateEvent,
  type ParsedInput,
} from "../lib/calendar-mutations.js";
import { ApiError, STATUS_LABELS, TYPE_LABELS } from "../lib/calendar-labels.js";

// Re-eksporty dla dotychczasowych importów (asystent, testy).
export { ApiError, STATUS_LABELS, TYPE_LABELS, loadEvents, parseInput };
export type { CalendarEventJson, ParsedInput };

const app = new Hono();
export const calendarPublicRoutes = new Hono();

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
    const result = db.transaction((tx) => createEvent(tx, input, { user }));
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
    const affected = db.transaction((tx) => updateEvent(tx, id, input, scope, { user }));
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
    db.transaction((tx) => moveEvent(tx, id, body, { user }));
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
    const deletedIds = db.transaction((tx) => deleteEvent(tx, id, scope, { user }));
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
    db.transaction((tx) => restoreEvent(tx, id, { user }));
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
    // Zapytanie wspólne z asystentem AI (src/lib/calendar-queries.ts) — zachowanie bez zmian.
    const ids = conflictEventIds(db, { technicianIds, startAt, endAt, excludeId });
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
