import { Hono } from "hono";
import contractorsRoutes from "./contractors.js";
import objectsRoutes from "./objects.js";
import contractsRoutes from "./contracts.js";
import historyRoutes from "./history.js";
import ordersRoutes from "./orders.js";
import realizationsRoutes from "./realizations.js";
import companyRoutes from "./company.js";
import companyLookupRoutes from "./company-lookup.js";
import techniciansRoutes from "./technicians.js";
import salespeopleRoutes from "./salespeople.js";
import companiesRoutes from "./companies.js";
import pricelistRoutes from "./pricelist.js";
import cameraModelsRoutes from "./camera-models.js";
import protocolsRoutes from "./protocols.js";
import quotesRoutes from "./quotes.js";
import servicesRoutes from "./services.js";
import offersRoutes, { offersPublicRoutes } from "./offers.js";
import cmaRoutes from "./cma.js";
import monitoringRoutes from "./monitoring.js";
import monitoredObjectsRoutes from "./monitored-objects.js";
import cmaMailRoutes from "./cma-mail.js";
import hrRoutes from "./hr.js";
import warehouseRoutes from "./warehouse.js";
import warehousePluginRoutes from "./warehouse-plugin.js";
import pluginRoutes from "./plugin.js";
import authRoutes from "./auth.js";
import publicRoutes from "./public.js";
import adminRoutes from "./admin.js";
import adminAssistantRoutes from "./admin-assistant.js";
import adminCalendarRoutes from "./admin-calendar.js";
import adminCompanyRoutes from "./admin-company.js";
import assistantRoutes from "./assistant.js";
import calendarRoutes, { calendarPublicRoutes } from "./calendar.js";
import activityRoutes from "./activity.js";
import analyticsRoutes from "./analytics.js";
import { requireAuth, requireAssistantAccess, tabPermissionGuard, getUser } from "../middleware/auth.js";
import { canView } from "../lib/auth/permissions.js";
import { db, schema } from "../db/index.js";
import { sql, eq, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { bodyLimit } from "hono/body-limit";

const api = new Hono();

// ---------------------------------------------------------------------------
// Limit rozmiaru ciała żądania
// ---------------------------------------------------------------------------
const MB = 1024 * 1024;
/** Domyślny sufit dla JSON-ów formularzy i drobnych uploadów. */
const BODY_LIMIT_DEFAULT = 2 * MB;
/** Import raportów XLS (CMA, rejestr obiektów) — przykładowy dzienny raport ma ~1,4 MB. */
const BODY_LIMIT_XLS_IMPORT = 20 * MB;
/** Stan projektu designera (zdjęcia w base64), snapshoty, DWG. */
const BODY_LIMIT_DESIGNER = 30 * MB;
/** Notatki wydarzeń z załącznikami: 15 plików × 5 MB + narzut multipart (src/lib/calendar-attachments.ts). */
const BODY_LIMIT_NOTE_ATTACHMENTS = 80 * MB;
/**
 * Import towaru z zapisanej strony sklepu. „Strona sieci Web, kompletna” z
 * Chrome ma inline'owane CSS-y i base64 obrazków — próbka SAMAL waży ~1,3 MB,
 * ale strony z galerią zdjęć w data-URL dochodzą do kilku MB. 12 MB to sufit,
 * przy którym parser (limit HTML w src/lib/shop-import) odrzuca plik własnym
 * komunikatem, zamiast dostać 413 bez wyjaśnienia.
 */
const BODY_LIMIT_SHOP_IMPORT = 12 * MB;

/**
 * Sufit zależny od trasy: trasy dużych ciał są wyliczone jawnie, reszta dostaje
 * 2 MB. Bez tego zalogowany użytkownik mógł wysłać 20 MB JSON-u do
 * PUT /monitoring/:id/data (zapisywało się w całości do bazy), a każda trasa
 * przyjmowała ciało dowolnej długości. Upload DWG ma własną kontrolę rozmiaru
 * w src/routes/monitoring.ts — tutaj tylko wpuszczamy go do tej klasy.
 */
function bodyLimitFor(path: string, method: string): number {
  if (/^\/monitoring\/\d+\/(data|snapshots|dwg-import)$/.test(path) && method !== "GET") {
    return BODY_LIMIT_DESIGNER;
  }
  if (/^\/monitoring\/snapshots\/\d+$/.test(path) && method === "PUT") return BODY_LIMIT_DESIGNER;
  if (/^\/calendar\/events\/\d+\/notes$/.test(path) && method === "POST") return BODY_LIMIT_NOTE_ATTACHMENTS;
  if (path === "/cma/reports/import" || path === "/monitored-objects/import") {
    return BODY_LIMIT_XLS_IMPORT;
  }
  // Zapisana strona produktu ze sklepu dostawcy (multipart albo JSON z pluginu).
  if (path === "/warehouse/import/parse" && method === "POST") {
    return BODY_LIMIT_SHOP_IMPORT;
  }
  // Wtyczka przeglądarki przysyła `outerHTML` otwartej strony produktu — ten
  // sam materiał co „Zapisz stronę”, więc ten sam sufit (wtyczka pilnuje go
  // też u siebie, żeby nie wysyłać 12 MB w ciemno).
  if (path === "/plugin/import" && method === "POST") {
    return BODY_LIMIT_SHOP_IMPORT;
  }
  return BODY_LIMIT_DEFAULT;
}

api.use("*", async (c, next) => {
  const path = c.req.path.replace(/^\/api/, "");
  const maxSize = bodyLimitFor(path, c.req.method.toUpperCase());
  return bodyLimit({
    maxSize,
    onError: (ctx) =>
      ctx.json(
        { success: false, error: `Żądanie jest za duże (limit ${Math.round(maxSize / MB)} MB).` },
        413
      ),
  })(c, next);
});

// --- AUTH (rejestracja / logowanie / sesja) — publiczne ---
// Musi być zamontowane PRZED api.use("*", requireAuth): w Hono middleware
// zarejestrowane później nie obejmuje tras zarejestrowanych wcześniej.
api.route("/auth", authRoutes);

// --- PUBLIC (bez auth) — zewnętrzny formularz zamówień ZDW ---
// Musi być zamontowane PRZED api.use("*", requireAuth), tak samo jak /auth.
api.route("/public", publicRoutes);

// --- KALENDARZ: publiczny feed ICS (auth po tokenie użytkownika w query) ---
// GET /calendar/feed.ics?token=... — montowane PRZED requireAuth, jak /public.
api.route("/calendar", calendarPublicRoutes);

// --- OFERTY: dokument dla klienta spod linku (auth po tokenie w ścieżce) ---
// GET /public-offer/:token — montowane PRZED requireAuth, jak /public.
api.route("/", offersPublicRoutes);

// --- WTYCZKA MAGAZYNU: API dla rozszerzenia przeglądarki (Bearer users.plugin_token) ---
// Montowane PRZED requireAuth, jak /public: żądania lecą ze service workera
// wtyczki, który NIE dostaje cookie `alfa_session` (SameSite=Lax). Router ma
// własny strażnik (token + canView/canEdit na `technical/magazyn` + limit tempa),
// więc trasy pod /plugin nie są publiczne — mają tylko inne poświadczenie.
api.route("/plugin", pluginRoutes);

// --- Wszystkie pozostałe trasy API — chronione sesją ---
api.use("*", requireAuth);

// --- ADMIN — panel zarządzania użytkownikami + konfiguracja asystenta (własny requireAdmin) ---
// Zamontowane przed strażnikiem zakładek (który i tak nie obejmuje /admin).
// /admin/assistant PRZED /admin — Hono dopasowuje po kolejności rejestracji.
api.route("/admin/assistant", adminAssistantRoutes);
api.route("/admin/calendar", adminCalendarRoutes);
api.route("/admin/company", adminCompanyRoutes);
api.route("/admin", adminRoutes);

// --- ASYSTENT AI (kalendarz) — dostęp wg ustawienia assistant.access (admin lub edytorzy kalendarza);
// nie jest zakładką (poza TABS/API_TAB_MAP). GET /assistant/status jest dla każdego zalogowanego
// (zwraca allowed), reszta /assistant/* za requireAssistantAccess.
// Endpoint /assistant/chats/:id/message streamuje UI Message Stream (SSE), nie {success,data}.
api.use("/assistant/*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path.replace(/^\/api/, "") === "/assistant/status") return next();
  return requireAssistantAccess(c, next);
});
api.route("/assistant", assistantRoutes);

// --- Strażnik uprawnień do zakładek (view/edit) dla tras modułowych ---
api.use("*", tabPermissionGuard);

// --- KALENDARZ (technical/kalendarz) + globalny dziennik aktywności ---
// /activity nie jest w API_TAB_MAP — historia obiektu czytelna dla każdego zalogowanego.
api.route("/calendar", calendarRoutes);
api.route("/activity", activityRoutes);

// --- WYSZUKIWARKA FIRM (wykaz VAT MF) — poza API_TAB_MAP: korzystają z niej
// formularze kontrahentów, techników i zleceń, a dane pochodzą z publicznego
// rejestru, więc wystarczy zalogowana sesja (limit zapytań w samej trasie).
api.route("/company-lookup", companyLookupRoutes);

/*
 * Dashboard statistics. Dashboard ma każdy zalogowany, ale liczby pochodzą
 * z modułów, do których nie każdy ma wgląd: liczniki obiektów i miesięczny
 * przychód to zakładka `objects`, kontrahenci — `contractors`, umowy —
 * `contracts`, zlecenia — `orders`. Sekcje bez uprawnienia wracają jako `null`
 * (kształt odpowiedzi jest STAŁY — front czyta `stats.objectsByStatus.pending`
 * bez sprawdzania, więc brak klucza wywaliłby stronę; `null || 0` renderuje
 * zero). Użytkownik z pustymi uprawnieniami dostaje same `null`e, bez kwot.
 */
async function count(table: SQLiteTable, where?: SQL): Promise<number> {
  const [r] = await db.select({ count: sql<number>`count(*)` }).from(table).where(where);
  return r.count;
}

api.get("/stats", async (c) => {
  const user = getUser(c);
  const sees = (tab: string) => canView(user, tab);
  const seesObjects = sees("objects");
  const seesOrders = sees("orders");

  const contractors = sees("contractors") ? await count(schema.contractors) : null;
  const contracts = sees("contracts") ? await count(schema.contracts) : null;

  let objects: number | null = null;
  let objectsByStatus: Record<"pending" | "inProgress" | "active", number | null> = {
    pending: null,
    inProgress: null,
    active: null,
  };
  let objectsByDepartment: Record<"sales" | "technical" | "accounting", number | null> = {
    sales: null,
    technical: null,
    accounting: null,
  };
  let monthlyRevenue: number | null = null;
  if (seesObjects) {
    const o = schema.objects;
    objects = await count(o);
    objectsByStatus = {
      pending: await count(o, eq(o.status, "pending")),
      inProgress: await count(o, eq(o.status, "in_progress")),
      active: await count(o, eq(o.status, "active")),
    };
    objectsByDepartment = {
      sales: await count(o, eq(o.department, "sales")),
      technical: await count(o, eq(o.department, "technical")),
      accounting: await count(o, eq(o.department, "accounting")),
    };
    // Przychód miesięczny = abonament + dzierżawa sprzętu (obie kwoty płatne co miesiąc).
    const [monthlyValueSum] = await db
      .select({
        sum: sql<number>`COALESCE(sum(COALESCE(monthly_value, 0) + COALESCE(monthly_rental, 0)), 0)`,
      })
      .from(o)
      .where(eq(o.status, "active"));
    monthlyRevenue = monthlyValueSum.sum;
  }

  let orders: number | null = null;
  let ordersByStatus: Record<"new" | "inProgress" | "completed", number | null> = {
    new: null,
    inProgress: null,
    completed: null,
  };
  if (seesOrders) {
    const o = schema.orders;
    orders = await count(o);
    ordersByStatus = {
      new: await count(o, eq(o.status, "new")),
      inProgress: await count(o, eq(o.status, "in_progress")),
      completed: await count(o, eq(o.status, "completed")),
    };
  }

  return c.json({
    success: true,
    data: {
      contractors,
      objects,
      contracts,
      orders,
      ordersByStatus,
      objectsByStatus,
      objectsByDepartment,
      monthlyRevenue,
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
// Dane firmy tylko do odczytu dla zalogowanych (znacznik biura na mapach).
api.route("/company", companyRoutes);
api.route("/technicians", techniciansRoutes);
api.route("/salespeople", salespeopleRoutes);
api.route("/companies", companiesRoutes);
api.route("/pricelist", pricelistRoutes);
api.route("/camera-models", cameraModelsRoutes);
api.route("/protocols", protocolsRoutes);
api.route("/quotes", quotesRoutes);
api.route("/services", servicesRoutes);
api.route("/offers", offersRoutes);
api.route("/cma/mail", cmaMailRoutes);
api.route("/cma", cmaRoutes);
api.route("/monitoring", monitoringRoutes);
api.route("/monitored-objects", monitoredObjectsRoutes);
api.route("/hr", hrRoutes);
// Kolejka importów z wtyczki + token + paczka ZIP. PRZED `warehouseRoutes`,
// bo Hono dopasowuje po kolejności rejestracji (uprawnienia obie części
// dziedziczą z prefiksu /warehouse w API_TAB_MAP).
api.route("/warehouse", warehousePluginRoutes);
api.route("/warehouse", warehouseRoutes);
// Analityka finansowa — montowana TUTAJ, czyli poniżej api.use("*", tabPermissionGuard).
// W bloku nad strażnikiem (obok /calendar czy /company-lookup) wystawiłaby przychody,
// koszty i wynagrodzenia handlowców każdemu zalogowanemu użytkownikowi.
api.route("/analytics", analyticsRoutes);

export default api;
