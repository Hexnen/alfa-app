/**
 * Osoby kontaktowe (/api/contacts).
 *
 * Pełnoprawna encja obok jednego pola `contractors.contact_person` (które zostaje —
 * migracji danych w v1 nie ma). Kontakt wisi przy kontrahencie, szansie albo
 * obiekcie; router wymaga NAZWISKA i co najmniej JEDNEGO powiązania, bo kontakt
 * bez żadnego z nich nigdzie by się nie pokazał.
 *
 * Dwie reguły, których nie da się przenieść na front:
 *  - `isPrimary` jest jedno na kontrahenta — ustawienie flagi zdejmuje ją
 *    pozostałym w tej samej transakcji (w bazie stoi jeszcze unikalny indeks
 *    częściowy, więc rozjazd skończyłby się błędem zapisu),
 *  - usunięcie kontaktu wskazywanego przez `calendar_events.contact_id` daje 409
 *    („ustaw nieaktywny”) — historia spotkań nie może zgubić rozmówcy.
 *
 * Kształt JSON-a jest kontraktem z frontem (frontend/src/lib/api.ts: `Contact`).
 */
import { Hono, type Context } from "hono";
import { and, asc, desc, eq, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getUser } from "../middleware/auth.js";
import { ApiError } from "../lib/calendar-labels.js";
import { logActivity } from "../lib/activity-log.js";
import { loadEvents } from "../lib/calendar-queries.js";
import { contactJson } from "./leads.js";

const app = new Hono();

const ENTITY = "contact";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

function optText(v: unknown, label: string, max = 300): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError(400, `Nieprawidłowe pole: ${label}`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new ApiError(400, `Pole ${label} jest za długie (maks. ${max} znaków)`);
  return t;
}

function optInt(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Nieprawidłowe pole: ${label}`);
  return n;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Nieprawidłowe dane");
  return raw as Record<string, unknown>;
}

const SORT_COLUMNS = {
  lastName: sql`lower(contacts.last_name), lower(contacts.first_name)`,
  role: sql`lower(coalesce(contacts.role, 'zzzz'))`,
  contractor: sql`lower(coalesce((select ct.name from contractors ct where ct.id = contacts.contractor_id), 'zzzz'))`,
  createdAt: sql`contacts.created_at`,
} as const;

type ContactSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is ContactSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/** Nazwy dokładane do JSON-a — jedno zapytanie na wymiar, nigdy N+1 na wiersz. */
function withNames(rows: (typeof schema.contacts.$inferSelect)[]) {
  const contractorIds = [...new Set(rows.map((r) => r.contractorId).filter((v): v is number => v != null))];
  const leadIds = [...new Set(rows.map((r) => r.leadId).filter((v): v is number => v != null))];
  const objectIds = [...new Set(rows.map((r) => r.objectId).filter((v): v is number => v != null))];
  const contractors = new Map(
    contractorIds.length
      ? db
          .select({ id: schema.contractors.id, name: schema.contractors.name })
          .from(schema.contractors)
          .where(inArray(schema.contractors.id, contractorIds))
          .all()
          .map((r) => [r.id, r.name])
      : []
  );
  const leads = new Map(
    leadIds.length
      ? db
          .select({ id: schema.leads.id, title: schema.leads.title })
          .from(schema.leads)
          .where(inArray(schema.leads.id, leadIds))
          .all()
          .map((r) => [r.id, r.title])
      : []
  );
  const objects = new Map(
    objectIds.length
      ? db
          .select({ id: schema.objects.id, name: schema.objects.name })
          .from(schema.objects)
          .where(inArray(schema.objects.id, objectIds))
          .all()
          .map((r) => [r.id, r.name])
      : []
  );
  return rows.map((r) =>
    contactJson(r, {
      contractorName: r.contractorId != null ? (contractors.get(r.contractorId) ?? null) : null,
      leadTitle: r.leadId != null ? (leads.get(r.leadId) ?? null) : null,
      objectName: r.objectId != null ? (objects.get(r.objectId) ?? null) : null,
    })
  );
}

// ---------------------------------------------------------------------------
// GET /contacts
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  try {
    const conditions: SQL[] = [];
    const q = (c.req.query("q") || "").trim();
    if (q) {
      // identity-ok: szukajka listy — wynik trafia na ekran, nie do złączenia.
      const pattern = `%${q}%`;
      const cond = or(
        like(schema.contacts.lastName, pattern), // identity-ok
        like(schema.contacts.firstName, pattern),
        like(schema.contacts.phone, pattern),
        like(schema.contacts.email, pattern),
        like(schema.contacts.role, pattern)
      );
      if (cond) conditions.push(cond);
    }
    const contractorId = optInt(c.req.query("contractorId"), "contractorId");
    if (contractorId) conditions.push(eq(schema.contacts.contractorId, contractorId));
    const leadId = optInt(c.req.query("leadId"), "leadId");
    if (leadId) conditions.push(eq(schema.contacts.leadId, leadId));
    const objectId = optInt(c.req.query("objectId"), "objectId");
    if (objectId) conditions.push(eq(schema.contacts.objectId, objectId));
    const active = c.req.query("active");
    if (active === "1") conditions.push(eq(schema.contacts.active, true));
    else if (active === "0") conditions.push(eq(schema.contacts.active, false));

    const where = conditions.length ? and(...conditions) : undefined;
    const sortRaw = c.req.query("sort") || "lastName";
    const sort: ContactSortKey = isSortKey(sortRaw) ? sortRaw : "lastName";
    const dir = c.req.query("dir") === "desc" ? desc : asc;
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(c.req.query("pageSize") || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
    );

    const total = Number(
      db.select({ n: sql<number>`count(*)` }).from(schema.contacts).where(where).get()?.n ?? 0
    );
    const rows = db
      .select()
      .from(schema.contacts)
      .where(where)
      .orderBy(dir(SORT_COLUMNS[sort]) as unknown as SQL, asc(schema.contacts.id) as unknown as SQL)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    return c.json({
      success: true,
      data: withNames(rows),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    return handleError(c, error, "listy kontaktów");
  }
});

// ---------------------------------------------------------------------------
// GET /contacts/:id — z wydarzeniami, w których ta osoba jest rozmówcą
// ---------------------------------------------------------------------------

app.get("/:id{[0-9]+}", async (c) => {
  try {
    const id = idParam(c);
    const row = db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
    if (!row) throw new ApiError(404, "Kontakt nie istnieje");
    const eventIds = db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.contactId, id), sql`${schema.calendarEvents.deletedAt} is null`))
      .orderBy(desc(schema.calendarEvents.startAt))
      .limit(50)
      .all()
      .map((r) => r.id);
    const events = eventIds.length ? loadEvents(db, eventIds) : [];
    return c.json({ success: true, data: { ...withNames([row])[0], events } });
  } catch (error) {
    return handleError(c, error, "kontaktu");
  }
});

// ---------------------------------------------------------------------------
// POST / PUT / DELETE
// ---------------------------------------------------------------------------

interface ContactPatch {
  contractorId?: number | null;
  leadId?: number | null;
  objectId?: number | null;
  firstName?: string;
  lastName?: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
  active?: boolean;
}

function parseContact(b: Record<string, unknown>, partial: boolean): ContactPatch {
  const out: ContactPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has("lastName")) {
    const lastName = optText(b.lastName, "lastName", 120);
    if (!lastName) throw new ApiError(400, "Nazwisko jest wymagane");
    out.lastName = lastName;
  }
  if (!partial || has("firstName")) out.firstName = optText(b.firstName, "firstName", 120) ?? "";
  if (has("contractorId")) out.contractorId = optInt(b.contractorId, "contractorId");
  if (has("leadId")) out.leadId = optInt(b.leadId, "leadId");
  if (has("objectId")) out.objectId = optInt(b.objectId, "objectId");
  if (has("role")) out.role = optText(b.role, "role", 120);
  if (has("phone")) out.phone = optText(b.phone, "phone", 60);
  if (has("email")) out.email = optText(b.email, "email", 200);
  if (has("notes")) out.notes = optText(b.notes, "notes", 5000);
  if (has("isPrimary")) out.isPrimary = b.isPrimary === true;
  if (has("active")) out.active = b.active !== false;
  return out;
}

/** Powiązania muszą istnieć — inaczej kontakt wisiałby przy nieistniejącym bycie. */
function assertRefs(refs: { contractorId?: number | null; leadId?: number | null; objectId?: number | null }) {
  if (refs.contractorId != null) {
    const r = db.select({ id: schema.contractors.id }).from(schema.contractors).where(eq(schema.contractors.id, refs.contractorId)).get();
    if (!r) throw new ApiError(400, `Kontrahent #${refs.contractorId} nie istnieje`);
  }
  if (refs.leadId != null) {
    const r = db.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.id, refs.leadId)).get();
    if (!r) throw new ApiError(400, `Szansa #${refs.leadId} nie istnieje`);
  }
  if (refs.objectId != null) {
    const r = db.select({ id: schema.objects.id }).from(schema.objects).where(eq(schema.objects.id, refs.objectId)).get();
    if (!r) throw new ApiError(400, `Obiekt #${refs.objectId} nie istnieje`);
  }
}

app.post("/", async (c) => {
  try {
    const user = getUser(c);
    const b = await body(c);
    const patch = parseContact(b, false);
    if (patch.contractorId == null && patch.leadId == null && patch.objectId == null) {
      throw new ApiError(400, "Kontakt musi być powiązany z kontrahentem, szansą albo obiektem");
    }
    assertRefs(patch);

    const id = db.transaction((tx) => {
      if (patch.isPrimary && patch.contractorId != null) clearPrimary(tx, patch.contractorId, null);
      const row = tx
        .insert(schema.contacts)
        .values({
          contractorId: patch.contractorId ?? null,
          leadId: patch.leadId ?? null,
          objectId: patch.objectId ?? null,
          firstName: patch.firstName ?? "",
          lastName: patch.lastName!,
          role: patch.role ?? null,
          phone: patch.phone ?? null,
          email: patch.email ?? null,
          isPrimary: patch.isPrimary ?? false,
          notes: patch.notes ?? null,
          active: patch.active ?? true,
          createdBy: user?.id ?? null,
        })
        .returning({ id: schema.contacts.id })
        .get();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: row.id,
        user,
        action: "created",
        summary: `Dodano osobę kontaktową ${patch.firstName ?? ""} ${patch.lastName}`.replace(/\s+/g, " ").trim(),
      });
      return row.id;
    });

    const row = db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get()!;
    return c.json({ success: true, data: withNames([row])[0] }, 201);
  } catch (error) {
    return handleError(c, error, "zapisu kontaktu");
  }
});

/** Zdejmuje flagę „główny” pozostałym kontaktom kontrahenta (`except` zostaje). */
function clearPrimary(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], contractorId: number, except: number | null) {
  tx.update(schema.contacts)
    .set({ isPrimary: false, updatedAt: sql`(datetime('now'))` })
    .where(
      except == null
        ? eq(schema.contacts.contractorId, contractorId)
        : and(eq(schema.contacts.contractorId, contractorId), ne(schema.contacts.id, except))
    )
    .run();
}

app.put("/:id{[0-9]+}", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const before = db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
    if (!before) throw new ApiError(404, "Kontakt nie istnieje");
    const b = await body(c);
    const patch = parseContact(b, true);
    assertRefs(patch);

    const contractorId = patch.contractorId !== undefined ? patch.contractorId : before.contractorId;
    const leadId = patch.leadId !== undefined ? patch.leadId : before.leadId;
    const objectId = patch.objectId !== undefined ? patch.objectId : before.objectId;
    if (contractorId == null && leadId == null && objectId == null) {
      throw new ApiError(400, "Kontakt musi być powiązany z kontrahentem, szansą albo obiektem");
    }
    const isPrimary = patch.isPrimary !== undefined ? patch.isPrimary : before.isPrimary;

    db.transaction((tx) => {
      // Kolejność ma znaczenie: najpierw gasimy flagę pozostałym, potem zapalamy
      // tę — inaczej unikalny indeks częściowy odrzuciłby zapis w połowie.
      if (isPrimary && contractorId != null) clearPrimary(tx, contractorId, id);
      tx.update(schema.contacts)
        .set({ ...patch, isPrimary, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.contacts.id, id))
        .run();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: id,
        user,
        action: "updated",
        summary: `Zmieniono osobę kontaktową ${before.firstName} ${before.lastName}`.replace(/\s+/g, " ").trim(),
      });
    });

    const row = db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get()!;
    return c.json({ success: true, data: withNames([row])[0] });
  } catch (error) {
    return handleError(c, error, "zapisu kontaktu");
  }
});

app.delete("/:id{[0-9]+}", async (c) => {
  try {
    const user = getUser(c);
    const id = idParam(c);
    const row = db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
    if (!row) throw new ApiError(404, "Kontakt nie istnieje");

    const used = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.contactId, id))
      .get();
    if (Number(used?.n ?? 0) > 0) {
      throw new ApiError(
        409,
        "Kontakt jest przypisany do wydarzeń kalendarza — zamiast usuwać, ustaw go jako nieaktywny"
      );
    }

    db.transaction((tx) => {
      tx.delete(schema.contacts).where(eq(schema.contacts.id, id)).run();
      logActivity(tx, {
        entityType: ENTITY,
        entityId: id,
        user,
        action: "deleted",
        summary: `Usunięto osobę kontaktową ${row.firstName} ${row.lastName}`.replace(/\s+/g, " ").trim(),
      });
    });
    return c.json({ success: true, data: null });
  } catch (error) {
    return handleError(c, error, "usuwania kontaktu");
  }
});

export default app;
