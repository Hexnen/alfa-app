import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, sql } from "drizzle-orm";
import type { ContractInput, ApiResponse, ContractStatus } from "../types/index.js";

const app = new Hono();

// Get all contracts
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const objectId = c.req.query("objectId");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  let query = db
    .select({
      contract: schema.contracts,
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.contracts)
    .leftJoin(schema.objects, eq(schema.contracts.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    );

  if (search) {
    query = query.where(
      like(schema.contracts.contractNumber, `%${search}%`)
    ) as typeof query;
  }

  if (status) {
    query = query.where(
      eq(schema.contracts.status, status as ContractStatus)
    ) as typeof query;
  }

  if (objectId) {
    query = query.where(
      eq(schema.contracts.objectId, parseInt(objectId))
    ) as typeof query;
  }

  const contracts = await query.limit(pageSize).offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contracts);
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: contracts.map((c) => ({
      ...c.contract,
      object: c.object,
      contractor: c.contractor,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get contract by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const result = await db
    .select({
      contract: schema.contracts,
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.contracts)
    .leftJoin(schema.objects, eq(schema.contracts.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(eq(schema.contracts.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  return c.json({
    success: true,
    data: {
      ...result[0].contract,
      object: result[0].object,
      contractor: result[0].contractor,
    },
  });
});

// Create contract
app.post("/", async (c) => {
  const body = await c.req.json<ContractInput>();

  // Verify object exists
  const object = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.id, body.objectId))
    .limit(1);

  if (object.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      400
    );
  }

  const result = await db
    .insert(schema.contracts)
    .values({
      objectId: body.objectId,
      contractNumber: body.contractNumber,
      startDate: body.startDate,
      endDate: body.endDate,
      value: body.value,
      filePath: body.filePath,
      status: body.status || "draft",
    })
    .returning();

  // Create history entry for the object
  await db.insert(schema.objectHistory).values({
    objectId: body.objectId,
    action: "contract_created",
    description: `Contract ${body.contractNumber} created`,
    newValue: JSON.stringify(result[0]),
  });

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Contract created successfully",
    },
    201
  );
});

// Update contract
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ContractInput>>();

  const existing = await db
    .select()
    .from(schema.contracts)
    .where(eq(schema.contracts.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  const result = await db
    .update(schema.contracts)
    .set(body)
    .where(eq(schema.contracts.id, id))
    .returning();

  // Create history entry for the object
  await db.insert(schema.objectHistory).values({
    objectId: existing[0].objectId,
    action: "contract_updated",
    description: `Contract ${existing[0].contractNumber} updated`,
    oldValue: JSON.stringify(existing[0]),
    newValue: JSON.stringify(result[0]),
  });

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Contract updated successfully",
  });
});

// Delete contract
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const existing = await db
    .select()
    .from(schema.contracts)
    .where(eq(schema.contracts.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  await db.delete(schema.contracts).where(eq(schema.contracts.id, id));

  // Create history entry
  await db.insert(schema.objectHistory).values({
    objectId: existing[0].objectId,
    action: "contract_deleted",
    description: `Contract ${existing[0].contractNumber} deleted`,
    oldValue: JSON.stringify(existing[0]),
  });

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Contract deleted successfully",
  });
});

export default app;
