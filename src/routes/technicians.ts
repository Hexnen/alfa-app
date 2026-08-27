import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, asc } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { NewTechnician } from "../db/schema.js";

const app = new Hono();

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewTechnician>;
  error?: string;
} {
  const firstName =
    typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName =
    typeof body.lastName === "string" ? body.lastName.trim() : "";
  if (!lastName) return { error: "Nazwisko jest wymagane" };
  const type = body.type === "external" ? "external" : "internal";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && !email.includes("@")) {
    return { error: "Nieprawidłowy adres e-mail" };
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const nip =
    typeof body.nip === "string" ? body.nip.replace(/[\s-]/g, "") : "";
  return {
    data: {
      firstName,
      lastName,
      phone: typeof body.phone === "string" ? body.phone : "",
      email,
      company,
      nip,
      type,
      notes: typeof body.notes === "string" ? body.notes : "",
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

// Lista techników (domyślnie wszyscy; ?active=true tylko aktywni)
app.get("/", async (c) => {
  const onlyActive = c.req.query("active") === "true";

  let rows = await db
    .select()
    .from(schema.technicians)
    .orderBy(asc(schema.technicians.type), asc(schema.technicians.lastName));

  if (onlyActive) rows = rows.filter((t) => t.active);

  return c.json({ success: true, data: rows });
});

// Nowy technik
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .insert(schema.technicians)
    .values(data as NewTechnician)
    .returning();

  return c.json(
    { success: true, data: result[0], message: "Technik dodany" },
    201
  );
});

// Edycja technika
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.technicians)
    .where(eq(schema.technicians.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono technika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .update(schema.technicians)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.technicians.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Technik zaktualizowany",
  });
});

// Usunięcie technika
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.technicians)
    .where(eq(schema.technicians.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono technika" },
      404
    );
  }

  await db.delete(schema.technicians).where(eq(schema.technicians.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Technik usunięty" });
});

export default app;
