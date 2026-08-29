import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { asc, eq, or, sql } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { NewSalesperson } from "../db/schema.js";

const app = new Hono();

/**
 * Handlowcy — słownik opiekunów handlowych, prowadzony jak technicy
 * (src/routes/technicians.ts): miękkie archiwum przez `active`, kasowanie tylko
 * dla nieprzypisanych. Lista zwraca od razu liczbę przypisanych kontrahentów
 * i obiektów, żeby zakładka „Handlowcy” nie musiała dociągać ich osobno.
 */
function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewSalesperson>;
  error?: string;
} {
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  if (!lastName) return { error: "Nazwisko jest wymagane" };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && !email.includes("@")) return { error: "Nieprawidłowy adres e-mail" };
  return {
    data: {
      firstName,
      lastName,
      phone: typeof body.phone === "string" ? body.phone.trim() : "",
      email,
      region: typeof body.region === "string" ? body.region.trim() : "",
      notes: typeof body.notes === "string" ? body.notes : "",
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

/** Ilu kontrahentów i ile obiektów wisi na handlowcu (do etykiet i blokady kasowania). */
function assignmentsOf(id: number) {
  const contractors = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors)
    .where(eq(schema.contractors.salespersonId, id))
    .get();
  const objects = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.salespersonId, id))
    .get();
  return { contractors: contractors?.count ?? 0, objects: objects?.count ?? 0 };
}

// Lista handlowców (domyślnie wszyscy; ?active=true tylko bieżący)
app.get("/", async (c) => {
  const onlyActive = c.req.query("active") === "true";

  const rows = await db
    .select({
      salesperson: schema.salespeople,
      // Odwołanie do kolumny nadrzędnej piszemy DOSŁOWNIE (`salespeople.id`): drizzle
      // renderuje \${schema.salespeople.id} w szablonie jako niekwalifikowane "id", które
      // wewnątrz podzapytania trafiłoby w kolumnę `id` tabeli z podzapytania.
      contractorsCount: sql<number>`(
        select count(*) from contractors where contractors.salesperson_id = salespeople.id
      )`,
      objectsCount: sql<number>`(
        select count(*) from objects where objects.salesperson_id = salespeople.id
      )`,
      objectsMonthlyValue: sql<number>`(
        select coalesce(sum(monthly_value), 0) from objects where objects.salesperson_id = salespeople.id
      )`,
    })
    .from(schema.salespeople)
    .orderBy(asc(sql`lower(${schema.salespeople.lastName})`), asc(schema.salespeople.firstName));

  const data = rows
    .filter((r) => !onlyActive || r.salesperson.active)
    .map((r) => ({
      ...r.salesperson,
      contractorsCount: r.contractorsCount ?? 0,
      objectsCount: r.objectsCount ?? 0,
      objectsMonthlyValue: r.objectsMonthlyValue ?? 0,
    }));

  return c.json({ success: true, data });
});

// Nowy handlowiec
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .insert(schema.salespeople)
    .values(data as NewSalesperson)
    .returning();

  return c.json({ success: true, data: result[0], message: "Handlowiec dodany" }, 201);
});

// Edycja handlowca
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.salespeople)
    .where(eq(schema.salespeople.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono handlowca" }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  // Sam przełącznik archiwum (PUT { active: false }) nie musi nieść całego formularza.
  if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
    const result = await db
      .update(schema.salespeople)
      .set({ active: body.active, updatedAt: new Date().toISOString() })
      .where(eq(schema.salespeople.id, id))
      .returning();
    return c.json({
      success: true,
      data: result[0],
      message: body.active ? "Handlowiec przywrócony" : "Handlowiec zarchiwizowany",
    });
  }

  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .update(schema.salespeople)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.salespeople.id, id))
    .returning();

  return c.json({ success: true, data: result[0], message: "Handlowiec zaktualizowany" });
});

/**
 * Kasowanie tylko dla handlowca bez przypisań — inaczej 409 z podpowiedzią, żeby
 * go zarchiwizować. Kartoteka klienta ma pamiętać, kto ją prowadził.
 */
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.salespeople)
    .where(eq(schema.salespeople.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono handlowca" }, 404);
  }

  const used = assignmentsOf(id);
  if (used.contractors > 0 || used.objects > 0) {
    const bits = [
      used.contractors > 0 ? `${used.contractors} kontrahent(ów)` : null,
      used.objects > 0 ? `${used.objects} obiekt(ów)` : null,
    ].filter(Boolean);
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Handlowiec ma przypisane ${bits.join(" i ")} — zarchiwizuj go zamiast kasować albo przepnij przypisania.`,
      },
      409
    );
  }

  await db.delete(schema.salespeople).where(eq(schema.salespeople.id, id));
  return c.json<ApiResponse<null>>({ success: true, message: "Handlowiec usunięty" });
});

export default app;
