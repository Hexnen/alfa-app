import { Hono } from "hono";
import contractorsRoutes from "./contractors.js";
import objectsRoutes from "./objects.js";
import contractsRoutes from "./contracts.js";
import historyRoutes from "./history.js";
import ordersRoutes from "./orders.js";
import { db, schema } from "../db/index.js";
import { sql, eq } from "drizzle-orm";

const api = new Hono();

// Dashboard statistics
api.get("/stats", async (c) => {
  const [contractorsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contractors);

  const [objectsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects);

  const [contractsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contracts);

  const [pendingObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.status, "pending"));

  const [inProgressObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.status, "in_progress"));

  const [activeObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.status, "active"));

  const [salesDeptObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.department, "sales"));

  const [technicalDeptObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.department, "technical"));

  const [accountingDeptObjects] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objects)
    .where(eq(schema.objects.department, "accounting"));

  const [monthlyValueSum] = await db
    .select({ sum: sql<number>`COALESCE(sum(monthly_value), 0)` })
    .from(schema.objects)
    .where(eq(schema.objects.status, "active"));

  const [ordersCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.orders);

  const [newOrders] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.orders)
    .where(eq(schema.orders.status, "new"));

  const [inProgressOrders] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.orders)
    .where(eq(schema.orders.status, "in_progress"));

  const [completedOrders] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.orders)
    .where(eq(schema.orders.status, "completed"));

  return c.json({
    success: true,
    data: {
      contractors: contractorsCount.count,
      objects: objectsCount.count,
      contracts: contractsCount.count,
      orders: ordersCount.count,
      ordersByStatus: {
        new: newOrders.count,
        inProgress: inProgressOrders.count,
        completed: completedOrders.count,
      },
      objectsByStatus: {
        pending: pendingObjects.count,
        inProgress: inProgressObjects.count,
        active: activeObjects.count,
      },
      objectsByDepartment: {
        sales: salesDeptObjects.count,
        technical: technicalDeptObjects.count,
        accounting: accountingDeptObjects.count,
      },
      monthlyRevenue: monthlyValueSum.sum,
    },
  });
});

// Mount routes
api.route("/contractors", contractorsRoutes);
api.route("/objects", objectsRoutes);
api.route("/contracts", contractsRoutes);
api.route("/history", historyRoutes);
api.route("/orders", ordersRoutes);

export default api;
