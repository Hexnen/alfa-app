import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, asc } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type { NewPriceItem } from "../db/schema.js";

const app = new Hono();

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewPriceItem>;
  error?: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim().toUpperCase() : "";
  if (!name) return { error: "Nazwa usługi jest wymagana" };
  if (!unit) return { error: "Jednostka miary jest wymagana" };

  const priceRaw =
    typeof body.price === "string"
      ? parseFloat(body.price.replace(",", "."))
      : Number(body.price);
  const price = Number.isFinite(priceRaw) ? priceRaw : 0;
  const position = Number.isFinite(Number(body.position))
    ? Number(body.position)
    : 0;

  return {
    data: {
      name,
      unit,
      price,
      position,
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

// Lista pozycji cennika
app.get("/", async (c) => {
  const rows = await db
    .select()
    .from(schema.priceList)
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id));
  return c.json({ success: true, data: rows });
});

// Nowa pozycja
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (!data.position) {
    const rows = await db.select().from(schema.priceList);
    data.position = rows.length + 1;
  }

  const result = await db
    .insert(schema.priceList)
    .values(data as NewPriceItem)
    .returning();

  return c.json(
    { success: true, data: result[0], message: "Pozycja cennika dodana" },
    201
  );
});

// Edycja pozycji
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pozycji cennika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const result = await db
    .update(schema.priceList)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.priceList.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Pozycja cennika zaktualizowana",
  });
});

// Usunięcie pozycji
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pozycji cennika" },
      404
    );
  }

  await db.delete(schema.priceList).where(eq(schema.priceList.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Pozycja usunięta" });
});

export default app;
