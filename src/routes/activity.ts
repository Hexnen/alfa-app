/**
 * Globalny dziennik aktywności (activity_log) — odczyt.
 * Montowane pod /activity. Uprawnienia:
 *  - /activity/object/:id → wpis w API_TAB_MAP (zakładka `objects`): wpisy
 *    streszczają zmiany obiektu i jego wydarzenia, więc widzi je ten, kto
 *    widzi obiekty;
 *  - /activity/recent → własna bramka niżej: dowolny kalendarz, a w odpowiedzi
 *    wyłącznie wpisy wydarzeń z działów, które użytkownik ogląda.
 * Wpisy dotyczące kalendarza dostają dołączony skrót wydarzenia (`event`).
 */
import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { and, eq, desc, inArray } from "drizzle-orm";
import type { ActivityLogEntry } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { viewableDepartments } from "../lib/calendar-scope.js";

const app = new Hono();

interface EventBrief {
  id: number;
  title: string;
  type: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  deletedAt: string | null;
  /** Dział wydarzenia — feed odsiewa po nim wpisy spoza wglądu użytkownika. */
  department: string;
}

/** Dołącza `event` do wpisów entity_type=calendar_event (jednym zapytaniem). */
function attachEvents(entries: ActivityLogEntry[]) {
  const ids = [...new Set(entries.filter((e) => e.entityType === "calendar_event").map((e) => e.entityId))];
  const byId = new Map<number, EventBrief>();
  if (ids.length > 0) {
    const rows = db
      .select({
        id: schema.calendarEvents.id,
        title: schema.calendarEvents.title,
        type: schema.calendarEvents.type,
        startAt: schema.calendarEvents.startAt,
        endAt: schema.calendarEvents.endAt,
        allDay: schema.calendarEvents.allDay,
        status: schema.calendarEvents.status,
        deletedAt: schema.calendarEvents.deletedAt,
        department: schema.calendarEvents.department,
      })
      .from(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.id, ids))
      .all();
    for (const r of rows) byId.set(r.id, r);
  }
  return entries.map((e) => ({
    ...e,
    event: e.entityType === "calendar_event" ? (byId.get(e.entityId) ?? null) : null,
  }));
}

function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = raw ? Number(raw) : def;
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, max);
}

// GET /activity/object/:objectId?limit=100 — historia obiektu (desc)
app.get("/object/:objectId", (c) => {
  const objectId = Number(c.req.param("objectId"));
  if (!Number.isInteger(objectId)) return c.json({ success: false, error: "Nieprawidłowe id obiektu" }, 400);
  const limit = parseLimit(c.req.query("limit"), 100, 1000);
  const entries = db
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.objectId, objectId))
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(limit)
    .all();
  return c.json({ success: true, data: attachEvents(entries) });
});

// GET /activity/recent?limit=50&department=technical — ostatnie wpisy kalendarza
// (panel "Aktywność" w kalendarzu technicznym i handlowym).
//
// WYŁĄCZNIE wpisy `calendar_event` z działów, które użytkownik ogląda
// (src/lib/calendar-scope.ts). Do activity_log logują też Kadry (`hr_payroll`,
// `hr_contract` ze starymi/nowymi kwotami), Oferty, Zlecenia itd. — wcześniej
// feed oddawał je każdemu z kluczem kalendarza, a `?entityType=` pozwalał je
// wręcz wybrać (docs/AUDYT-UPRAWNIEN-B.md #8). Filtr idzie w SQL, żeby limit
// liczył się po odsianiu, a nie przed.
app.get("/recent", (c) => {
  const user = getUser(c);
  const viewable = viewableDepartments(user);
  if (viewable.length === 0) {
    return c.json({ success: false, error: "Brak dostępu do tej sekcji" }, 403);
  }
  const limit = parseLimit(c.req.query("limit"), 50, 500);
  const requested = c.req.query("department");
  const departments = requested
    ? viewable.filter((d) => d === requested)
    : viewable;
  if (departments.length === 0) {
    return c.json({ success: false, error: "Brak dostępu do kalendarza tego działu" }, 403);
  }
  const entries = db
    .select()
    .from(schema.activityLog)
    .where(
      and(
        eq(schema.activityLog.entityType, "calendar_event"),
        inArray(
          schema.activityLog.entityId,
          db
            .select({ id: schema.calendarEvents.id })
            .from(schema.calendarEvents)
            .where(inArray(schema.calendarEvents.department, departments))
        )
      )
    )
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(limit)
    .all();
  return c.json({ success: true, data: attachEvents(entries) });
});

export default app;
