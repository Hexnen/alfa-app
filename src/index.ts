// TZ procesu (Europe/Warsaw) — MUSI być pierwszym importem (patrz src/lib/tz.ts).
import "./lib/tz.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
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
await ensureMasterAdmin();

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
//
// Wtyczka przeglądarki (extension/, trasy /api/plugin/*) NIE potrzebuje tu
// wpisu: cały jej ruch idzie z service workera MV3, a taki fetch — do hosta
// z `host_permissions` — nie podlega CORS. Gdyby kiedyś zaczął strzelać
// z content scriptu (czyli z originu sklepu), przeglądarka zablokowałaby go
// bez śladu w logach; poprawką jest wrócić do service workera, a nie
// dopisywać tu domeny obcych sklepów.
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
/*
 * Nagłówki bezpieczeństwa dla całej aplikacji (API + SPA + designer).
 *  - X-Frame-Options: DENY + frame-ancestors 'none' — nikt nie osadzi panelu
 *    w ramce na obcej stronie (clickjacking na sesji z cookie SameSite=Lax).
 *  - X-Content-Type-Options / Referrer-Policy — ustawienia domyślne hono.
 *  - CSP jest TYLKO z `frame-ancestors`: designer.html i oferty HTML mają
 *    skrypty inline, a hono domyślnie CSP nie ustawia — nie dopisujemy
 *    `script-src`, bo wyłączyłoby to designer.
 *  - Cross-Origin-Resource-Policy wyłączone: front bywa serwowany z innego
 *    originu (lista CORS wyżej) i wczytuje zdjęcia/obrazy DWG z API przez
 *    <img>, a CORP `same-origin` blokowałoby je po cichu.
 *
 * Wyjątek: GET /api/manuals/attachments/:id. Podgląd manuala osadza PDF-a
 * w <iframe> na własnej stronie, a DENY blokuje to także dla tego samego
 * originu — dla tej JEDNEJ trasy (surowy plik, zero UI i zero akcji do
 * wyklikania, więc clickjacking nie ma czego przejąć) zwalniamy ramkę do
 * SAMEORIGIN / frame-ancestors 'self'. Front zawsze woła API po ścieżce
 * względnej (`/api`, w dev przez proxy Vite), więc to naprawdę ten sam origin.
 */
const strictHeaders = secureHeaders({
  xFrameOptions: "DENY",
  contentSecurityPolicy: { frameAncestors: ["'none'"] },
  crossOriginResourcePolicy: false,
  referrerPolicy: "strict-origin-when-cross-origin",
});
const sameOriginFrameHeaders = secureHeaders({
  xFrameOptions: "SAMEORIGIN",
  contentSecurityPolicy: { frameAncestors: ["'self'"] },
  crossOriginResourcePolicy: false,
  referrerPolicy: "strict-origin-when-cross-origin",
});
const MANUAL_ATTACHMENT_PATH = /^\/api\/manuals\/attachments\/\d+$/;
app.use("*", (c, next) =>
  (c.req.method === "GET" && MANUAL_ATTACHMENT_PATH.test(c.req.path) ? sameOriginFrameHeaders : strictHeaders)(c, next)
);
app.use(
  "*",
  cors({
    origin: corsOrigins,
    // PATCH: panel admina aktualizuje użytkowników przez PATCH /admin/users/:id;
    // bez niego preflight z innego originu (dev na :5173) odrzucał zapis.
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Alfa-Client: identyfikator KARTY przeglądarki (src/lib/calendar-live.ts) — front
    // dokłada go do każdego żądania, więc bez tego wpisu preflight z innego originu
    // (dev na :5173) odrzucałby każdy zapis.
    allowHeaders: ["Content-Type", "Authorization", "X-Alfa-Client"],
    // X-Contract-Missing: licznik pól do uzupełnienia nad podglądem umowy
    // (src/routes/contract-drafts.ts). Bez wystawienia nagłówka front na innym
    // originie (dev na :4000/:5173) w ogóle by go nie zobaczył.
    exposeHeaders: ["X-Contract-Missing"],
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

// Asystent AI: retencja czatów (assistant.retention_days; 0 = wyłączona) przy starcie i co 24 h
// oraz domknięcie tur osieroconych restartem (ostatnia wiadomość czatu = user → „Odpowiedź przerwana").
const { startRetentionScheduler } = await import("./lib/ai/retention.js");
const { repairOrphanedTurns } = await import("./routes/assistant.js");
startRetentionScheduler();
repairOrphanedTurns();

// Usługi obiektów: przeliczenie flag `has_*` z okresów (`object_services`) przy starcie i co 24 h.
const { startObjectServicesSync } = await import("./lib/object-services-sync.js");
startObjectServicesSync();
