import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, like, or, sql, desc } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";
import { createOrderFromInput } from "../services/orders.js";

const app = new Hono();

// Get all orders with optional search (with joined contractor and object data)
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  let query = db
    .select({
      order: schema.orders,
      contractor: schema.contractors,
      object: schema.objects,
    })
    .from(schema.orders)
    .leftJoin(schema.contractors, eq(schema.orders.payerContractorId, schema.contractors.id))
    .leftJoin(schema.objects, eq(schema.orders.objectId, schema.objects.id));

  if (search) {
    query = query.where(
      or(
        like(schema.orders.orderNumber, `%${search}%`),
        like(schema.orders.requesterName, `%${search}%`),
        like(schema.orders.payerName, `%${search}%`),
        like(schema.orders.objectName, `%${search}%`)
      )
    ) as typeof query;
  }

  if (status) {
    query = query.where(eq(schema.orders.status, status as "new" | "in_progress" | "completed" | "cancelled")) as typeof query;
  }

  const results = await query.orderBy(desc(schema.orders.createdAt)).limit(pageSize).offset(offset);

  let countQuery = db.select({ count: sql<number>`count(*)` }).from(schema.orders);
  if (search) {
    countQuery = countQuery.where(
      or(
        like(schema.orders.orderNumber, `%${search}%`),
        like(schema.orders.requesterName, `%${search}%`),
        like(schema.orders.payerName, `%${search}%`),
        like(schema.orders.objectName, `%${search}%`)
      )
    ) as typeof countQuery;
  }
  if (status) {
    countQuery = countQuery.where(eq(schema.orders.status, status as "new" | "in_progress" | "completed" | "cancelled")) as typeof countQuery;
  }
  const countResult = await countQuery;
  const total = countResult[0].count;

  // Map results to include current contractor/object names
  const orders = results.map((r) => ({
    ...r.order,
    // Use current contractor data if available, fallback to order snapshot
    payerName: r.contractor?.name || r.order.payerName,
    payerNip: r.contractor?.nip || r.order.payerNip,
    // Use current object data if available, fallback to order snapshot
    objectName: r.object?.name || r.order.objectName,
    objectAddress: r.object?.address || r.order.objectAddress,
    objectCity: r.object?.city || r.order.objectCity,
    // Include full objects for reference
    contractor: r.contractor,
    object: r.object,
  }));

  return c.json({
    success: true,
    data: orders,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get order by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const order = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (order.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof order[0]>>({
    success: true,
    data: order[0],
  });
});

// Create order with optional contractor and object creation (ATOMIC TRANSACTION)
app.post("/", async (c) => {
  const body = await c.req.json<OrderInput>();

  try {
    const result = await createOrderFromInput(body);

    if (!result.ok) {
      return c.json<ApiResponse<null>>(
        { success: false, error: result.error },
        result.status as 400 | 409
      );
    }

    const orderResult = result.order;

    return c.json<ApiResponse<typeof orderResult & { createdContractor: boolean; createdObject: boolean }>>(
      {
        success: true,
        data: {
          ...orderResult,
          createdContractor: result.createdContractor,
          createdObject: result.createdObject,
        },
        message: `Order created successfully${result.createdContractor ? ' (with new contractor)' : ''}${result.createdObject ? ' (with new object)' : ''}`,
      },
      201
    );
  } catch (error) {
    console.error("Error creating order:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Failed to create order. Please try again." },
      500
    );
  }
});

// Update order
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<
    Partial<OrderInput> & { expectedUpdatedAt?: string }
  >();

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  // Optimistic concurrency: the client MUST echo the updatedAt it read as
  // expectedUpdatedAt. We only write if the row is unchanged, otherwise 409.
  // A missing token is rejected (428) instead of degrading to eq(id) — that
  // degrade path let two concurrent editors silently overwrite each other
  // (last-writer-wins), which is exactly the race this guard exists to close.
  const { expectedUpdatedAt, ...fields } = body;

  if (!expectedUpdatedAt) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Missing expectedUpdatedAt — reload the order and retry.",
      },
      428
    );
  }

  const result = await db
    .update(schema.orders)
    .set({
      ...fields,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.orders.id, id),
        eq(schema.orders.updatedAt, expectedUpdatedAt)
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Order was modified by someone else. Please reload and retry.",
      },
      409
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order updated successfully",
  });
});

// Delete order
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  await db.delete(schema.orders).where(eq(schema.orders.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Order deleted successfully",
  });
});

// Update order status
app.patch("/:id/status", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { status, expectedUpdatedAt } = await c.req.json<{
    status: string;
    expectedUpdatedAt?: string;
  }>();

  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  // Optimistic concurrency guard (see PUT /:id) — the client MUST send the
  // updatedAt it read; a missing token is rejected (428) instead of degrading
  // to eq(id), so the last-writer-wins path cannot be reached.
  if (!expectedUpdatedAt) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Missing expectedUpdatedAt — reload the order and retry.",
      },
      428
    );
  }

  const result = await db
    .update(schema.orders)
    .set({
      status: status as "new" | "in_progress" | "completed" | "cancelled",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.orders.id, id),
        eq(schema.orders.updatedAt, expectedUpdatedAt)
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Order was modified by someone else. Please reload and retry.",
      },
      409
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order status updated successfully",
  });
});

export default app;
