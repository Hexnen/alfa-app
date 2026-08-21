import { Hono } from "hono";
import contractorsRoutes from "./contractors.js";
import objectsRoutes from "./objects.js";
import contractsRoutes from "./contracts.js";
import historyRoutes from "./history.js";
import ordersRoutes from "./orders.js";
import realizationsRoutes from "./realizations.js";
import techniciansRoutes from "./technicians.js";
import pricelistRoutes from "./pricelist.js";
import cameraModelsRoutes from "./camera-models.js";
import protocolsRoutes from "./protocols.js";
import quotesRoutes from "./quotes.js";
import cmaRoutes from "./cma.js";
import monitoringRoutes from "./monitoring.js";
import monitoredObjectsRoutes from "./monitored-objects.js";
import cmaMailRoutes from "./cma-mail.js";
import hrRoutes from "./hr.js";
import warehouseRoutes from "./warehouse.js";
import authRoutes from "./auth.js";
import publicRoutes from "./public.js";
import adminRoutes from "./admin.js";
import { requireAuth, tabPermissionGuard } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { sql, eq } from "drizzle-orm";

const api = new Hono();

// --- AUTH (rejestracja / logowanie / sesja) — publiczne ---
// Musi być zamontowane PRZED api.use("*", requireAuth): w Hono middleware
// zarejestrowane później nie obejmuje tras zarejestrowanych wcześniej.
api.route("/auth", authRoutes);

// --- PUBLIC (bez auth) — zewnętrzny formularz zamówień ZDW ---
// Musi być zamontowane PRZED api.use("*", requireAuth), tak samo jak /auth.
api.route("/public", publicRoutes);

// --- Wszystkie pozostałe trasy API — chronione sesją ---
api.use("*", requireAuth);

// --- ADMIN — panel zarządzania użytkownikami (własny requireAdmin) ---
// Zamontowane przed strażnikiem zakładek (który i tak nie obejmuje /admin).
api.route("/admin", adminRoutes);

// --- Strażnik uprawnień do zakładek (view/edit) dla tras modułowych ---
api.use("*", tabPermissionGuard);

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
api.route("/realizations", realizationsRoutes);
api.route("/technicians", techniciansRoutes);
api.route("/pricelist", pricelistRoutes);
api.route("/camera-models", cameraModelsRoutes);
api.route("/protocols", protocolsRoutes);
api.route("/quotes", quotesRoutes);
api.route("/cma/mail", cmaMailRoutes);
api.route("/cma", cmaRoutes);
api.route("/monitoring", monitoringRoutes);
api.route("/monitored-objects", monitoredObjectsRoutes);
api.route("/hr", hrRoutes);
api.route("/warehouse", warehouseRoutes);

export default api;
