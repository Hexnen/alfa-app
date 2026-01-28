import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, sql } from "drizzle-orm";
import type { ContractorInput, ApiResponse } from "../types/index.js";

const app = new Hono();

// Get all contractors with optional search
app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  let query = db.select().from(schema.contractors);

  if (search) {
    query = query.where(
      or(
        like(schema.contractors.name, `%${search}%`),
        like(schema.contractors.nip, `%${search}%`),
        like(schema.contractors.city, `%${search}%`)
      )
    ) as typeof query;
  }

  const contractors = await query.limit(pageSize).offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors);
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: contractors,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get contractor by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const contractor = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, id))
    .limit(1);

  if (contractor.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof contractor[0]>>({
    success: true,
    data: contractor[0],
  });
});

// Get contractor with their objects
app.get("/:id/objects", async (c) => {
  const id = parseInt(c.req.param("id"));

  const objects = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.contractorId, id));

  return c.json({
    success: true,
    data: objects,
  });
});

// Create contractor
app.post("/", async (c) => {
  const body = await c.req.json<ContractorInput>();

  // Check if NIP already exists
  const existing = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.nip, body.nip))
    .limit(1);

  if (existing.length > 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor with this NIP already exists" },
      400
    );
  }

  const result = await db
    .insert(schema.contractors)
    .values({
      name: body.name,
      nip: body.nip,
      address: body.address,
      city: body.city,
      postalCode: body.postalCode,
      phone: body.phone,
      email: body.email,
      contactPerson: body.contactPerson,
      notes: body.notes,
    })
    .returning();

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Contractor created successfully",
    },
    201
  );
});

// Update contractor
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ContractorInput>>();

  // Check if contractor exists
  const existing = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      404
    );
  }

  // Check if NIP is being changed and already exists
  if (body.nip && body.nip !== existing[0].nip) {
    const nipExists = await db
      .select()
      .from(schema.contractors)
      .where(eq(schema.contractors.nip, body.nip))
      .limit(1);

    if (nipExists.length > 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Contractor with this NIP already exists" },
        400
      );
    }
  }

  const result = await db
    .update(schema.contractors)
    .set({
      ...body,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.contractors.id, id))
    .returning();

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Contractor updated successfully",
  });
});

// Delete contractor
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Check if contractor has objects
  const objects = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.contractorId, id))
    .limit(1);

  if (objects.length > 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Cannot delete contractor with existing objects",
      },
      400
    );
  }

  await db.delete(schema.contractors).where(eq(schema.contractors.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Contractor deleted successfully",
  });
});

export default app;
