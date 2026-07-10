import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ApiResponse } from "../types/index.js";
import {
  getSettings,
  saveSettings,
  sanitizeSettings,
  checkMailboxShared,
  testImapConnection,
  testSmtpConnection,
  sendIssuesEmail,
  parseSendTimes,
  type MailSettingsPatch,
} from "../services/cma-mail.js";

const app = new Hono();

// Normalize a comma-separated recipients value: trim entries, drop empties
function normalizeRecipients(value: unknown): string | null {
  const parts = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : String(value ?? "").split(",");
  const cleaned = parts.map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(", ") : null;
}

// Get mail settings (creates the default row on first call)
app.get("/settings", async (c) => {
  const settings = await getSettings();
  return c.json({ success: true, data: sanitizeSettings(settings) });
});

// Update mail settings (partial). Empty/absent password keeps the old one.
app.put("/settings", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowe dane żądania (oczekiwano JSON)." },
      400
    );
  }

  const patch: MailSettingsPatch = {};

  const stringField = (
    key: "imapHost" | "smtpHost"
  ): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const intField = (
    key: "imapPort" | "smtpPort" | "pollMinutes"
  ): number | undefined | "invalid" => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return "invalid";
    return parsed;
  };

  const boolField = (
    key: "imapSecure" | "smtpSecure" | "importEnabled" | "sendEnabled"
  ): boolean | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    return Boolean(value);
  };

  const imapHost = stringField("imapHost");
  if (imapHost !== undefined) patch.imapHost = imapHost;
  const smtpHost = stringField("smtpHost");
  if (smtpHost !== undefined) patch.smtpHost = smtpHost;
  // Folder: comma-separated list of IMAP folders — trim entries,
  // drop empties, normalize the separator to ", "
  if (body.folder !== undefined && body.folder !== null) {
    const folders = String(body.folder)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (folders.length > 0) patch.folder = folders.join(", ");
  }

  for (const key of ["imapPort", "smtpPort", "pollMinutes"] as const) {
    const value = intField(key);
    if (value === "invalid") {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: `Pole "${key}" musi być dodatnią liczbą całkowitą.`,
        },
        400
      );
    }
    if (value !== undefined) patch[key] = value;
  }

  for (const key of [
    "imapSecure",
    "smtpSecure",
    "importEnabled",
    "sendEnabled",
  ] as const) {
    const value = boolField(key);
    if (value !== undefined) patch[key] = value;
  }

  if (body.sendMode !== undefined && body.sendMode !== null) {
    const sendMode = String(body.sendMode);
    if (sendMode !== "after_import" && sendMode !== "scheduled") {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error:
            'Nieprawidłowy tryb wysyłki (dozwolone: "after_import" lub "scheduled").',
        },
        400
      );
    }
    patch.sendMode = sendMode;
  }

  if (body.sendTimes !== undefined) {
    const slots = parseSendTimes(
      body.sendTimes === null ? "" : String(body.sendTimes)
    );
    if (slots === null) {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: "Nieprawidłowy format godzin wysyłki (użyj HH:MM po przecinku)",
        },
        400
      );
    }
    patch.sendTimes = slots.length > 0 ? slots.join(", ") : null;
  }

  if (body.email !== undefined) {
    const email = String(body.email ?? "").trim();
    patch.email = email.length > 0 ? email : null;
  }

  // Subject filter: comma-separated list of phrases (OR) — trim entries,
  // drop empties, normalize the separator to ", "
  if (body.subjectFilter !== undefined) {
    const phrases = String(body.subjectFilter ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    patch.subjectFilter = phrases.length > 0 ? phrases.join(", ") : null;
  }

  if (body.fromFilter !== undefined) {
    const fromFilter = String(body.fromFilter ?? "").trim();
    patch.fromFilter = fromFilter.length > 0 ? fromFilter : null;
  }

  if (body.recipients !== undefined) {
    patch.recipients = normalizeRecipients(body.recipients);
  }

  if (typeof body.password === "string" && body.password.length > 0) {
    patch.password = body.password;
  }

  const settings = await saveSettings(patch);
  return c.json({
    success: true,
    data: sanitizeSettings(settings),
    message: "Zapisano ustawienia poczty",
  });
});

// Test IMAP connection with current settings
app.post("/test-imap", async (c) => {
  try {
    const data = await testImapConnection();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Nie udało się połączyć z serwerem IMAP.",
      },
      400
    );
  }
});

// Test SMTP connection; optional body { to } sends a test message
app.post("/test-smtp", async (c) => {
  let to: string | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.to === "string") to = body.to;
  } catch {
    // body is optional
  }

  try {
    const message = await testSmtpConnection(to);
    return c.json<ApiResponse<null>>({ success: true, message });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Nie udało się połączyć z serwerem SMTP.",
      },
      400
    );
  }
});

// Run a mailbox check immediately
app.post("/check-now", async (c) => {
  try {
    // Single-flight: reuses an in-progress scan instead of opening a
    // second concurrent IMAP session and clobbering last-check status.
    const summary = await checkMailboxShared();
    return c.json({ success: true, data: summary });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Nie udało się sprawdzić skrzynki pocztowej.",
      },
      400
    );
  }
});

// Mail operations log (paginated, newest first)
app.get("/log", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  const results = await db
    .select()
    .from(schema.cmaMailLog)
    .orderBy(desc(schema.cmaMailLog.createdAt), desc(schema.cmaMailLog.id))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.cmaMailLog);
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: results,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Send camera-issues e-mail for the newest report (max dateTo, tiebreak id)
app.post("/send-latest", async (c) => {
  const reports = await db
    .select({
      id: schema.cmaReports.id,
      title: schema.cmaReports.title,
      dateFrom: schema.cmaReports.dateFrom,
      dateTo: schema.cmaReports.dateTo,
    })
    .from(schema.cmaReports)
    .orderBy(desc(schema.cmaReports.dateTo), desc(schema.cmaReports.id))
    .limit(1);

  if (reports.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Brak raportów do wysyłki" },
      400
    );
  }
  const report = reports[0];

  try {
    const result = await sendIssuesEmail(report.id, {
      classification: "Brak obrazu",
    });
    const range = `${report.dateFrom ?? "?"} – ${report.dateTo ?? "?"}`;
    return c.json<ApiResponse<null>>({
      success: true,
      message: `Wysłano zestawienie braków z raportu ${report.title} (${range}) do ${result.to}`,
    });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Nie udało się wysłać wiadomości.",
      },
      400
    );
  }
});

// Send camera-issues e-mail for a report
app.post("/send-issues/:reportId", async (c) => {
  const reportId = parseInt(c.req.param("reportId"));
  if (Number.isNaN(reportId)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator raportu" },
      400
    );
  }

  const existing = await db
    .select({ id: schema.cmaReports.id })
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, reportId))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono raportu" },
      404
    );
  }

  let classification: string | undefined;
  let to: string | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.classification === "string") {
      classification = body.classification;
    }
    if (body && typeof body.to === "string") to = body.to;
  } catch {
    // body is optional
  }

  try {
    const result = await sendIssuesEmail(reportId, { classification, to });
    return c.json<ApiResponse<null>>({ success: true, message: result.message });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Nie udało się wysłać wiadomości.",
      },
      400
    );
  }
});

export default app;
