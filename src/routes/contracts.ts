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

  // Wstawienie kontraktu i wpisu do objectHistory w jednej synchronicznej
  // transakcji — obie operacje zatwierdzają się razem (brak kontraktu bez
  // wpisu w historii, nawet przy błędzie/przeplocie między żądaniami).
  const result = db.transaction((tx) => {
    const inserted = tx
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
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: body.objectId,
        action: "contract_created",
        description: `Contract ${body.contractNumber} created`,
        newValue: JSON.stringify(inserted[0]),
      })
      .run();

    return inserted[0];
  });

  return c.json<ApiResponse<typeof result>>(
    {
      success: true,
      data: result,
      message: "Contract created successfully",
    },
    201
  );
});

// Update contract
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<ContractInput>>();

  // Read-modify-write + wpis do historii w jednej synchronicznej transakcji:
  // `existing` czytany jest wewnątrz transakcji, więc równoległe edycje tego
  // samego kontraktu serializują się (bez zgubionych aktualizacji), a oldValue
  // w audycie odzwierciedla stan bezpośrednio przed tą zmianą.
  const outcome = db.transaction((tx) => {
    const existingRows = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.id, id))
      .limit(1)
      .all();
    if (existingRows.length === 0) return { status: 404 as const };
    const existing = existingRows[0];

    const updated = tx
      .update(schema.contracts)
      .set(body)
      .where(eq(schema.contracts.id, id))
      .returning()
      .all();

    tx.insert(schema.objectHistory)
      .values({
        objectId: existing.objectId,
        action: "contract_updated",
        description: `Contract ${existing.contractNumber} updated`,
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated[0]),
      })
      .run();

    return { status: 200 as const, data: updated[0] };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof outcome.data>>({
    success: true,
    data: outcome.data,
    message: "Contract updated successfully",
  });
});

// Delete contract
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Usunięcie kontraktu i wpis do historii razem w jednej transakcji.
  const outcome = db.transaction((tx) => {
    const existingRows = tx
      .select()
      .from(schema.contracts)
      .where(eq(schema.contracts.id, id))
      .limit(1)
      .all();
    if (existingRows.length === 0) return { status: 404 as const };
    const existing = existingRows[0];

    tx.delete(schema.contracts).where(eq(schema.contracts.id, id)).run();

    tx.insert(schema.objectHistory)
      .values({
        objectId: existing.objectId,
        action: "contract_deleted",
        description: `Contract ${existing.contractNumber} deleted`,
        oldValue: JSON.stringify(existing),
      })
      .run();

    return { status: 200 as const };
  });

  if (outcome.status === 404) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Contract not found" },
      404
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Contract deleted successfully",
  });
});

export default app;
