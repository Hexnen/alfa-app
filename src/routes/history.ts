import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";

const app = new Hono();

// Get history for an object
app.get("/object/:objectId", async (c) => {
  const objectId = parseInt(c.req.param("objectId"));
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "50");
  const offset = (page - 1) * pageSize;

  const history = await db
    .select()
    .from(schema.objectHistory)
    .where(eq(schema.objectHistory.objectId, objectId))
    .orderBy(desc(schema.objectHistory.createdAt))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objectHistory)
    .where(eq(schema.objectHistory.objectId, objectId));
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: history,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get recent history across all objects
app.get("/recent", async (c) => {
  const limit = parseInt(c.req.query("limit") || "20");

  const history = await db
    .select({
      history: schema.objectHistory,
      object: schema.objects,
      contractor: schema.contractors,
    })
    .from(schema.objectHistory)
    .leftJoin(
      schema.objects,
      eq(schema.objectHistory.objectId, schema.objects.id)
    )
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    )
    .orderBy(desc(schema.objectHistory.createdAt))
    .limit(limit);

  return c.json({
    success: true,
    data: history.map((h) => ({
      ...h.history,
      object: h.object,
      contractor: h.contractor,
    })),
  });
});

export default app;
