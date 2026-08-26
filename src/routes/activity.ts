/**
 * Globalny dziennik aktywności (activity_log) — odczyt.
 * Montowane pod /activity, dostępne dla każdego zalogowanego (poza API_TAB_MAP).
 * Wpisy dotyczące kalendarza dostają dołączony skrót wydarzenia (`event`).
 */
import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, inArray } from "drizzle-orm";
import type { ActivityLogEntry } from "../db/schema.js";
import { isAdmin, maxLevel } from "../lib/auth/permissions.js";
import { getUser } from "../middleware/auth.js";

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

// GET /activity/recent?limit=50 — ostatnie wpisy globalnie (panel "Aktywność")
app.get("/recent", (c) => {
  // Globalny feed zawiera tytuły/terminy eventów — wymaga wglądu w kalendarz.
  const user = getUser(c);
  if (!isAdmin(user) && maxLevel(user, ["technical/kalendarz"]) === "none") {
    return c.json({ success: false, error: "Brak dostępu do tej sekcji" }, 403);
  }
  const limit = parseLimit(c.req.query("limit"), 50, 500);
  const entityType = c.req.query("entityType") || null;
  const entries = db
    .select()
    .from(schema.activityLog)
    .where(entityType ? eq(schema.activityLog.entityType, entityType) : undefined)
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
    .limit(limit)
    .all();
  return c.json({ success: true, data: attachEvents(entries) });
});

export default app;
