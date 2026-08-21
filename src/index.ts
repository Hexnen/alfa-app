import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFileSync } from "fs";
import { runMigrations } from "./db/migrate.js";

// Apply DB migrations BEFORE importing anything that opens the shared db
// connection or queries tables. Makes the app self-sufficient regardless of
// how the process is started (Dockerfile CMD, `npm start`, Nixpacks, ...).
runMigrations();

// Now safe to load modules that touch the db.
const { default: api } = await import("./routes/index.js");
const { startMailPoller } = await import("./services/cma-mail.js");
const { ensureMasterAdmin } = await import("../scripts/bootstrap-admin.js");

// Ensure the master admin exists (no-op without ADMIN_PASSWORD).
ensureMasterAdmin();

// Seed magazynu: pusta tabela warehouses → utwórz "Magazyn główny".
// Robione przy starcie (nie w GET /warehouses) — odczyt nie może robić zapisów
// i nie ma wyścigu współbieżnych requestów tworzącego duplikaty.
{
  const { sql } = await import("drizzle-orm");
  const { db, schema } = await import("./db/index.js");
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.warehouses);
  if (count === 0) {
    await db
      .insert(schema.warehouses)
      .values({ name: "Magazyn główny", code: "MAG", type: "main" });
    console.log("Seed: utworzono domyślny magazyn główny");
  }
}

const app = new Hono();

// Directory with the built frontend (produced by `vite build`, copied in Docker)
const FRONTEND_DIR = "./frontend/dist";

// Allowed CORS origins. Same-origin requests (frontend served by this app)
// don't need CORS, but extra origins can be added via CORS_ORIGINS
// (comma-separated) without a rebuild — e.g. a separate prod domain.
const corsOrigins = [
  "http://localhost:4000",
  "http://localhost:5173",
  "https://ts150.korat-egret.ts.net:4000",
  ...(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: corsOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Health check (used by Dokploy)
app.get("/healthz", (c) => {
  return c.json({
    name: "Alfa App API",
    version: "1.0.0",
    status: "running",
  });
});

// API routes
app.route("/api", api);

// Static frontend assets (js/css/images/monitoring html, ...)
app.use("/*", serveStatic({ root: FRONTEND_DIR }));

// SPA fallback: any non-API GET that didn't match a file returns index.html
// so client-side routing (react-router) works on deep links / refresh.
app.get("*", (c) => {
  if (c.req.path.startsWith("/api")) {
    return c.json({ success: false, error: "Not Found" }, 404);
  }
  const html = readFileSync(`${FRONTEND_DIR}/index.html`, "utf-8");
  return c.html(html);
});

// Error handling
app.onError((err, c) => {
  console.error("Error:", err);
  return c.json(
    {
      success: false,
      error: err.message || "Internal Server Error",
    },
    500
  );
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
    },
    404
  );
});

const port = parseInt(process.env.PORT || "4001");
const host = process.env.HOST || "0.0.0.0";

console.log(`Server is running on http://${host}:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

// Start the CMA mail poller (no-op when import is disabled
// or credentials are missing; never throws)
void startMailPoller();
