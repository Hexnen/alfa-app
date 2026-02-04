import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, sql, desc } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";

const app = new Hono();

// Generate order number (format: ZL-YYYY-XXXXX)
function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ZL-${year}-${random}`;
}

// Get all orders with optional search
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  let query = db.select().from(schema.orders);

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

  const orders = await query.orderBy(desc(schema.orders.createdAt)).limit(pageSize).offset(offset);

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

// Create order
app.post("/", async (c) => {
  const body = await c.req.json<OrderInput>();

  const orderNumber = generateOrderNumber();

  const result = await db
    .insert(schema.orders)
    .values({
      orderNumber,
      requesterName: body.requesterName,
      requesterPhone: body.requesterPhone,
      requesterEmail: body.requesterEmail,
      payerName: body.payerName,
      payerNip: body.payerNip,
      payerContractorId: body.payerContractorId,
      objectName: body.objectName,
      objectAddress: body.objectAddress,
      objectCity: body.objectCity,
      objectLocationUrl: body.objectLocationUrl,
      objectId: body.objectId,
      contactPerson: body.contactPerson,
      contactPhone: body.contactPhone,
      contactEmail: body.contactEmail,
      isCameraInstallation: body.isCameraInstallation,
      cameraCount: body.cameraCount,
      megaphoneCount: body.megaphoneCount,
      vtoolsOfferNumber: body.vtoolsOfferNumber,
      monthlyAmount: body.monthlyAmount,
      rentalAmount: body.rentalAmount,
      invoiceIssuer: body.invoiceIssuer,
      status: body.status || "new",
      serviceStartDate: body.serviceStartDate,
      notes: body.notes,
    })
    .returning();

  return c.json<ApiResponse<typeof result[0]>>(
    {
      success: true,
      data: result[0],
      message: "Order created successfully",
    },
    201
  );
});

// Update order
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<OrderInput>>();

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

  const result = await db
    .update(schema.orders)
    .set({
      ...body,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.orders.id, id))
    .returning();

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
  const { status } = await c.req.json<{ status: string }>();

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

  const result = await db
    .update(schema.orders)
    .set({
      status: status as "new" | "in_progress" | "completed" | "cancelled",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.orders.id, id))
    .returning();

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order status updated successfully",
  });
});

export default app;
