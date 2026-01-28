import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, and, sql } from "drizzle-orm";
import type {
  ObjectInput,
  WorkflowTransition,
  ApiResponse,
  ObjectStatus,
  Department,
} from "../types/index.js";

const app = new Hono();

// Get all objects with filtering
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const department = c.req.query("department");
  const type = c.req.query("type");
  const contractorId = c.req.query("contractorId");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        like(schema.objects.name, `%${search}%`),
        like(schema.objects.address, `%${search}%`),
        like(schema.objects.city, `%${search}%`)
      )
    );
  }

  if (status) {
    conditions.push(eq(schema.objects.status, status as ObjectStatus));
  }

  if (department) {
    conditions.push(eq(schema.objects.department, department as Department));
  }

  if (type) {
    conditions.push(
      eq(schema.objects.type, type as "monitoring" | "physical" | "alarm" | "mixed")
    );
  }

  if (contractorId) {
    conditions.push(eq(schema.objects.contractorId, parseInt(contractorId)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const objects = await db
    .select({
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(whereClause)
    .limit(pageSize)
    .offset(offset);

  const countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects);

  const countResult = whereClause
    ? await countQuery.where(whereClause)
    : await countQuery;
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: objects.map((o) => ({
      ...o.object,
      contractor: o.contractor,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get object by ID with contractor and contracts
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const result = await db
    .select({
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.objects)
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .where(eq(schema.objects.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  const contracts = await db
    .select()
    .from(schema.contracts)
    .where(eq(schema.contracts.objectId, id));

  return c.json({
    success: true,
    data: {
      ...result[0].object,
      contractor: result[0].contractor,
      contracts,
    },
  });
});

// Create object
app.post("/", async (c) => {
  const body = await c.req.json<ObjectInput>();

  // Verify contractor exists
  const contractor = await db
    .select()
    .from(schema.contractors)
    .where(eq(schema.contractors.id, body.contractorId))
    .limit(1);

  if (contractor.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      400
    );
  }

  const result = await db
    .insert(schema.objects)
    .values({
      contractorId: body.contractorId,
      name: body.name,
      address: body.address,
      city: body.city,
      type: body.type,
      installationType: body.installationType,
      status: body.status || "pending",
      department: body.department || "sales",
      monthlyValue: body.monthlyValue,
      notes: body.notes,
    })
    .returning();

  // Create history entry
  await db.insert(schema.objectHistory).values({
    objectId: result[0].id,
    action: "created",
    description: `Object created in ${body.department || "sales"} department`,
    newValue: JSON.stringify(result[0]),
  });

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Object created successfully",
    },
    201
  );
});

// Update object
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ObjectInput>>();

  const existing = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  const result = await db
    .update(schema.objects)
    .set({
      ...body,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.objects.id, id))
    .returning();

  // Create history entry
  await db.insert(schema.objectHistory).values({
    objectId: id,
    action: "updated",
    description: "Object details updated",
    oldValue: JSON.stringify(existing[0]),
    newValue: JSON.stringify(result[0]),
  });

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Object updated successfully",
  });
});

// Workflow transition - change status and department
app.post("/:id/transition", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<WorkflowTransition>();

  const existing = await db
    .select()
    .from(schema.objects)
    .where(eq(schema.objects.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  const oldStatus = existing[0].status;
  const oldDepartment = existing[0].department;

  const result = await db
    .update(schema.objects)
    .set({
      status: body.newStatus,
      department: body.newDepartment,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.objects.id, id))
    .returning();

  // Create history entry for transition
  await db.insert(schema.objectHistory).values({
    objectId: id,
    action: "transition",
    description:
      body.description ||
      `Status: ${oldStatus} → ${body.newStatus}, Department: ${oldDepartment} → ${body.newDepartment}`,
    oldValue: JSON.stringify({ status: oldStatus, department: oldDepartment }),
    newValue: JSON.stringify({
      status: body.newStatus,
      department: body.newDepartment,
    }),
  });

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Object transitioned successfully",
  });
});

// Delete object
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Check if object has contracts
  const contracts = await db
    .select()
    .from(schema.contracts)
    .where(eq(schema.contracts.objectId, id))
    .limit(1);

  if (contracts.length > 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Cannot delete object with existing contracts",
      },
      400
    );
  }

  await db.delete(schema.objects).where(eq(schema.objects.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Object deleted successfully",
  });
});

export default app;
