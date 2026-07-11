import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFileSync } from "fs";
import api from "./routes/index.js";
import { startMailPoller } from "./services/cma-mail.js";

const app = new Hono();

// Directory with the built frontend (produced by `vite build`, copied in Docker)
const FRONTEND_DIR = "./frontend/dist";

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:4000", "http://localhost:5173", "https://ts150.korat-egret.ts.net:4000"],
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
