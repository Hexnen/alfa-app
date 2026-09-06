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
  // Cennik technika: null / brak = korzysta z cennika głównego.
  let priceListId: number | null = null;
  if (body.priceListId !== undefined && body.priceListId !== null && body.priceListId !== "") {
    const n = Number(body.priceListId);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "Nieprawidłowy cennik" };
    }
    priceListId = n;
  }
  // Ten sam człowiek w kartotece kadrowej (null = technik spoza listy płac,
  // np. podwykonawca na własnej działalności). Wolno tylko dodatnie id wiersza.
  let employeeId: number | null = null;
  if (
    body.employeeId !== undefined &&
    body.employeeId !== null &&
    body.employeeId !== ""
  ) {
    const n = Number(body.employeeId);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "Nieprawidłowy pracownik kadr" };
    }
    employeeId = n;
  }
  return {
    data: {
      firstName,
      lastName,
      priceListId,
      employeeId,
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

/** Czy wskazany cennik istnieje (null = cennik główny, zawsze OK). */
async function priceListOk(id: number | null | undefined): Promise<boolean> {
  if (!id) return true;
  const rows = await db
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  return rows.length > 0;
}

/** Czy wskazany pracownik kadr istnieje (null = brak powiązania, zawsze OK). */
async function employeeOk(id: number | null | undefined): Promise<boolean> {
  if (!id) return true;
  const rows = await db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id))
    .limit(1);
  return rows.length > 0;
}

// Lista techników (domyślnie wszyscy; ?active=true tylko aktywni)
app.get("/", async (c) => {
  const onlyActive = c.req.query("active") === "true";

  const rows = await db
    .select({
      technician: schema.technicians,
      // Nazwisko z kadr doklejamy od razu — lista pokazuje, kto jest na liście
      // płac, bez osobnego żądania do modułu Kadry.
      employeeName: schema.hrEmployees.fullName,
    })
    .from(schema.technicians)
    .leftJoin(
      schema.hrEmployees,
      eq(schema.technicians.employeeId, schema.hrEmployees.id),
    )
    .orderBy(asc(schema.technicians.type), asc(schema.technicians.lastName));

  const data = rows
    .filter((r) => !onlyActive || r.technician.active)
    .map((r) => ({ ...r.technician, employeeName: r.employeeName ?? null }));

  return c.json({ success: true, data });
});

// Nowy technik
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!(await priceListOk(data.priceListId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  if (!(await employeeOk(data.employeeId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika w kadrach" },
      404
    );
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

  if (!(await priceListOk(data.priceListId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  if (!(await employeeOk(data.employeeId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pracownika w kadrach" },
      404
    );
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
