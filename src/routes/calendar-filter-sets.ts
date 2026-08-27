/**
 * Zapisane zestawy filtrów kalendarza — CRUD per użytkownik.
 *
 * Montowane pod /calendar/filter-sets (patrz src/routes/calendar.ts), więc dziedziczy
 * requireAuth + tabPermissionGuard dla "technical/kalendarz".
 *
 * Zestaw = nazwa + JSON filtrów o ZNANYCH kluczach (biała lista poniżej). Nieznane klucze
 * i nieznane wartości w tablicach są po cichu pomijane — dzięki temu starsze/nowsze wersje
 * frontu nie wywracają zapisu. Limit: MAX_SETS zestawów na użytkownika, nazwa unikalna
 * w obrębie użytkownika (UNIQUE(user_id, name)).
 */
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getUser } from "../middleware/auth.js";
import {
  CALENDAR_BILLINGS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_EVENT_TYPES,
  type User,
} from "../db/schema.js";
import { ApiError } from "../lib/calendar-labels.js";

const app = new Hono();

export const MAX_FILTER_SETS = 20;
export const FILTER_SET_NAME_MAX = 60;

/** Widoki kalendarza (muszą zgadzać się z VIEWS w frontend/src/pages/Calendar.tsx). */
const VIEW_NAMES = ["dayGridMonth", "timeGridWeek", "timeGridDay", "listWeek", "board"] as const;
const TRISTATE = ["", "with", "without"] as const;

export interface FilterSetFilters {
  types: string[];
  statuses: string[];
  billings: string[];
  technicianIds: number[];
  protocol: string;
  realization: string;
  view?: string;
  weekends?: boolean;
}

const pickList = (raw: unknown, allowed: readonly string[]): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && allowed.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
};

const pickEnum = (raw: unknown, allowed: readonly string[], fallback: string): string =>
  typeof raw === "string" && allowed.includes(raw) ? raw : fallback;

/**
 * Sanityzacja obiektu filtrów po białej liście. Rzuca 400 tylko gdy `raw` nie jest
 * obiektem — resztę „czyścimy”, nie wywracając żądania.
 */
export function sanitizeFilters(raw: unknown): FilterSetFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "Pole filters musi być obiektem");
  }
  const j = raw as Record<string, unknown>;
  const out: FilterSetFilters = {
    types: pickList(j.types, CALENDAR_EVENT_TYPES),
    statuses: pickList(j.statuses, CALENDAR_EVENT_STATUSES),
    billings: pickList(j.billings, [...CALENDAR_BILLINGS, "none"]),
    technicianIds: Array.isArray(j.technicianIds)
      ? [...new Set(j.technicianIds.filter((x): x is number => Number.isInteger(x) && (x as number) > 0))].slice(0, 200)
      : [],
    protocol: pickEnum(j.protocol, TRISTATE, ""),
    realization: pickEnum(j.realization, TRISTATE, ""),
  };
  if (typeof j.view === "string" && (VIEW_NAMES as readonly string[]).includes(j.view)) out.view = j.view;
  if (typeof j.weekends === "boolean") out.weekends = j.weekends;
  return out;
}

function parseName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ApiError(400, "Nazwa zestawu jest wymagana");
  if ([...name].length > FILTER_SET_NAME_MAX) {
    throw new ApiError(400, `Nazwa zestawu: maksymalnie ${FILTER_SET_NAME_MAX} znaków`);
  }
  return name;
}

interface FilterSetJson {
  id: number;
  name: string;
  filters: FilterSetFilters;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof schema.calendarFilterSets.$inferSelect): FilterSetJson {
  let filters: FilterSetFilters;
  try {
    filters = sanitizeFilters(JSON.parse(row.filters));
  } catch {
    filters = sanitizeFilters({});
  }
  return {
    id: row.id,
    name: row.name,
    filters,
    isDefault: !!row.isDefault,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listSets(userId: number): FilterSetJson[] {
  return db
    .select()
    .from(schema.calendarFilterSets)
    .where(eq(schema.calendarFilterSets.userId, userId))
    .orderBy(asc(schema.calendarFilterSets.sortOrder), asc(schema.calendarFilterSets.id))
    .all()
    .map(serialize);
}

/** Zestaw należący do użytkownika (obcy/nieistniejący → undefined → 404). */
function getOwnedSet(id: number, user: User) {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return db
    .select()
    .from(schema.calendarFilterSets)
    .where(and(eq(schema.calendarFilterSets.id, id), eq(schema.calendarFilterSets.userId, user.id)))
    .get();
}

/** Nazwa zajęta przez INNY zestaw tego użytkownika. */
function nameTaken(userId: number, name: string, exceptId?: number): boolean {
  const conds = [eq(schema.calendarFilterSets.userId, userId), eq(schema.calendarFilterSets.name, name)];
  if (exceptId) conds.push(ne(schema.calendarFilterSets.id, exceptId));
  return !!db.select({ id: schema.calendarFilterSets.id }).from(schema.calendarFilterSets).where(and(...conds)).get();
}

function clearDefaults(userId: number, exceptId: number) {
  db.update(schema.calendarFilterSets)
    .set({ isDefault: false })
    .where(and(eq(schema.calendarFilterSets.userId, userId), ne(schema.calendarFilterSets.id, exceptId)))
    .run();
}

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) return c.json({ success: false, error: error.message }, error.status);
  console.error(`Error in calendar filter-sets ${what}:`, error);
  return c.json({ success: false, error: `Błąd: ${what}` }, 500);
}

// GET /filter-sets — lista zestawów zalogowanego użytkownika
app.get("/", (c) => {
  try {
    return c.json({ success: true, data: listSets(getUser(c).id) });
  } catch (error) {
    return handleError(c, error, "wczytywanie zestawów filtrów");
  }
});

// POST /filter-sets — nowy zestaw { name, filters, isDefault? }
app.post("/", async (c) => {
  try {
    const user = getUser(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ApiError(400, "Nieprawidłowe dane");
    const name = parseName(body.name);
    const filters = sanitizeFilters(body.filters);
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.calendarFilterSets)
      .where(eq(schema.calendarFilterSets.userId, user.id))
      .get();
    if ((count?.n ?? 0) >= MAX_FILTER_SETS) {
      throw new ApiError(400, `Limit ${MAX_FILTER_SETS} zestawów filtrów — usuń któryś, by dodać nowy`);
    }
    if (nameTaken(user.id, name)) throw new ApiError(409, "Zestaw o tej nazwie już istnieje");
    const maxSort = db
      .select({ m: sql<number>`coalesce(max(sort_order), -1)` })
      .from(schema.calendarFilterSets)
      .where(eq(schema.calendarFilterSets.userId, user.id))
      .get();
    const isDefault = body.isDefault === true;
    const row = db
      .insert(schema.calendarFilterSets)
      .values({
        userId: user.id,
        name,
        filters: JSON.stringify(filters),
        isDefault,
        sortOrder: (maxSort?.m ?? -1) + 1,
      })
      .returning()
      .get();
    if (isDefault) clearDefaults(user.id, row.id);
    return c.json({ success: true, data: serialize(row) }, 201);
  } catch (error) {
    return handleError(c, error, "zapisywanie zestawu filtrów");
  }
});

// PUT /filter-sets/:id — zmiana nazwy / nadpisanie filtrów / kolejność
app.put("/:id", async (c) => {
  try {
    const user = getUser(c);
    const set = getOwnedSet(Number(c.req.param("id")), user);
    if (!set) throw new ApiError(404, "Nie znaleziono zestawu filtrów");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new ApiError(400, "Nieprawidłowe dane");

    const patch: Partial<typeof schema.calendarFilterSets.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = parseName(body.name);
      if (name !== set.name && nameTaken(user.id, name, set.id)) {
        throw new ApiError(409, "Zestaw o tej nazwie już istnieje");
      }
      patch.name = name;
    }
    if (body.filters !== undefined) patch.filters = JSON.stringify(sanitizeFilters(body.filters));
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) throw new ApiError(400, "Pole sortOrder musi być liczbą całkowitą");
      patch.sortOrder = body.sortOrder as number;
    }
    if (body.isDefault !== undefined) {
      if (typeof body.isDefault !== "boolean") throw new ApiError(400, "Pole isDefault musi być true/false");
      patch.isDefault = body.isDefault;
    }
    if (!Object.keys(patch).length) return c.json({ success: true, data: serialize(set) });

    const row = db
      .update(schema.calendarFilterSets)
      .set({ ...patch, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.calendarFilterSets.id, set.id))
      .returning()
      .get();
    if (patch.isDefault === true) clearDefaults(user.id, row.id);
    return c.json({ success: true, data: serialize(row) });
  } catch (error) {
    return handleError(c, error, "zapisywanie zestawu filtrów");
  }
});

// POST /filter-sets/:id/default — ustaw domyślny (odznacza pozostałe)
app.post("/:id/default", (c) => {
  try {
    const user = getUser(c);
    const set = getOwnedSet(Number(c.req.param("id")), user);
    if (!set) throw new ApiError(404, "Nie znaleziono zestawu filtrów");
    db.update(schema.calendarFilterSets)
      .set({ isDefault: true, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.calendarFilterSets.id, set.id))
      .run();
    clearDefaults(user.id, set.id);
    return c.json({ success: true, data: listSets(user.id) });
  } catch (error) {
    return handleError(c, error, "ustawianie domyślnego zestawu");
  }
});

// DELETE /filter-sets/:id
app.delete("/:id", (c) => {
  try {
    const user = getUser(c);
    const set = getOwnedSet(Number(c.req.param("id")), user);
    if (!set) throw new ApiError(404, "Nie znaleziono zestawu filtrów");
    db.delete(schema.calendarFilterSets).where(eq(schema.calendarFilterSets.id, set.id)).run();
    return c.json({ success: true, data: { id: set.id } });
  } catch (error) {
    return handleError(c, error, "usuwanie zestawu filtrów");
  }
});

export default app;
