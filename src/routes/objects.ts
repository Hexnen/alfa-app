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

  // Kontrola kontrahenta, wstawienie obiektu i wpis historii w jednej
  // synchronicznej transakcji — obiekt i jego wpis "created" powstają atomowo,
  // więc nie ma obiektu bez historii ani przeplotu między dwoma zapisami.
  const result = db.transaction((tx) => {
    const contractor = tx
      .select()
      .from(schema.contractors)
      .where(eq(schema.contractors.id, body.contractorId))
      .get();

    if (!contractor) return null;

    const inserted = tx
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
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: inserted[0].id,
        action: "created",
        description: `Object created in ${body.department || "sales"} department`,
        newValue: JSON.stringify(inserted[0]),
      })
      .run();

    return inserted;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contractor not found" },
      400
    );
  }

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

  // Odczyt, zapis i wpis historii w jednej synchronicznej transakcji —
  // serializuje równoległe edycje (drugi PUT widzi zapis pierwszego) i buduje
  // oldValue z tego samego odczytu, więc audyt nie kłamie o przejściu.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.objects)
      .where(eq(schema.objects.id, id))
      .get();

    if (!existing) return null;

    const updated = tx
      .update(schema.objects)
      .set({
        ...body,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.objects.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: id,
        action: "updated",
        description: "Object details updated",
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated[0]),
      })
      .run();

    return updated;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

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

  // Odczyt, zapis i wpis historii w jednej synchronicznej transakcji —
  // oldStatus/oldDepartment pochodzą z tego samego odczytu co zapis, więc
  // równoległe przejścia się serializują, a audyt jest spójny.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.objects)
      .where(eq(schema.objects.id, id))
      .get();

    if (!existing) return null;

    const oldStatus = existing.status;
    const oldDepartment = existing.department;

    const updated = tx
      .update(schema.objects)
      .set({
        status: body.newStatus,
        department: body.newDepartment,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.objects.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
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
      })
      .run();

    return updated;
  });

  if (!result) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Object transitioned successfully",
  });
});

// Delete object
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Kontrola istnienia umów i usunięcie obiektu w jednej synchronicznej
  // transakcji — inaczej równoległy POST /contracts mógłby wstawić umowę między
  // sprawdzeniem a usunięciem, a kaskada (contracts.objectId onDelete:cascade)
  // po cichu skasowałaby świeżo dodaną umowę mimo guardu. Atomowo: albo delete
  // jest zablokowany, albo umowa nie mogła powstać.
  const blocked = db.transaction((tx) => {
    const child = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.objectId, id))
      .limit(1)
      .all();

    if (child.length > 0) return true;

    tx.delete(schema.objects).where(eq(schema.objects.id, id)).run();
    return false;
  });

  if (blocked) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Cannot delete object with existing contracts",
      },
      400
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Object deleted successfully",
  });
});

export default app;
