/**
 * Historia zmian obiektów (object_history) — odczyt.
 *
 * Uprawnienia: /history/object/:id jest w API_TAB_MAP (objects | contractors),
 * bo wpisy niosą stare i nowe wartości pól obiektu (kwoty abonamentu, dane
 * kontrahenta). /history/recent woła Dashboard, który ma każdy zalogowany —
 * dlatego zamiast 403 zwraca PUSTĄ listę użytkownikowi bez wglądu w obiekty
 * (Dashboard ładuje statystyki i historię jednym Promise.all i 403 zabijałoby
 * mu oba).
 */
import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { getUser } from "../middleware/auth.js";
import { maxLevel } from "../lib/auth/permissions.js";

const app = new Hono();

/** Zakładki, z których wolno czytać historię obiektów (jak wpis w API_TAB_MAP). */
const HISTORY_TABS = ["objects", "contractors"];

/** Sufit na `limit`/`pageSize` — bez niego `?limit=100000` zrzucał całą tabelę jednym żądaniem. */
const MAX_PAGE = 500;

function clampInt(raw: string | undefined, def: number, max: number): number {
  const n = raw ? Number(raw) : def;
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, max);
}

// Get history for an object
app.get("/object/:objectId", async (c) => {
  const objectId = parseInt(c.req.param("objectId"));
  const page = clampInt(c.req.query("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(c.req.query("pageSize"), 50, MAX_PAGE);
  const offset = (page - 1) * pageSize;

  const history = await db
    .select()
    .from(schema.objectHistory)
    .where(eq(schema.objectHistory.objectId, objectId))
    .orderBy(desc(schema.objectHistory.createdAt))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objectHistory)
    .where(eq(schema.objectHistory.objectId, objectId));
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: history,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get recent history across all objects
app.get("/recent", async (c) => {
  if (maxLevel(getUser(c), HISTORY_TABS) === "none") {
    return c.json({ success: true, data: [] });
  }
  const limit = clampInt(c.req.query("limit"), 20, MAX_PAGE);

  const history = await db
    .select({
      history: schema.objectHistory,
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.objectHistory)
    .leftJoin(
      schema.objects,
      eq(schema.objectHistory.objectId, schema.objects.id)
    )
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .orderBy(desc(schema.objectHistory.createdAt))
    .limit(limit);

  return c.json({
    success: true,
    data: history.map((h) => ({
      ...h.history,
      object: h.object,
      contractor: h.contractor,
    })),
  });
});

export default app;
