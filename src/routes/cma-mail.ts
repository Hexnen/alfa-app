import { Hono } from "hono";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ApiResponse } from "../types/index.js";
import { getUser } from "../middleware/auth.js";
import { canEdit } from "../lib/auth/permissions.js";
import {
  getSettings,
  saveSettings,
  sanitizeSettings,
  checkMailboxShared,
  testImapConnection,
  testSmtpConnection,
  sendIssuesEmail,
  parseSendTimes,
  previewPatrolMail,
  fetchPatrolMailShared,
  clampLookbackDays,
  type MailSettingsPatch,
  type PatrolMailFilterOverrides,
} from "../services/cma-mail.js";

const app = new Hono();

/** „a, ,b ” → „a, b”; puste → null. Wspólne dla folderów i fraz tematu. */
function normalizeCommaList(value: unknown): string | null {
  const parts = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)].join(", ") : null;
}

function normalizeContains(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Filtry podjazdów z ciała żądania (podgląd na niezapisanych ustawieniach). */
function patrolOverridesFromBody(body: Record<string, unknown>): PatrolMailFilterOverrides {
  const overrides: PatrolMailFilterOverrides = {};
  if (body.patrolFolder !== undefined) overrides.patrolFolder = normalizeCommaList(body.patrolFolder) ?? "";
  if (body.patrolSubjectFilter !== undefined) {
    overrides.patrolSubjectFilter = normalizeCommaList(body.patrolSubjectFilter);
  }
  if (body.patrolFromFilter !== undefined) overrides.patrolFromFilter = normalizeContains(body.patrolFromFilter);
  if (body.days !== undefined && body.days !== null && body.days !== "") {
    overrides.days = clampLookbackDays(body.days);
  }
  return overrides;
}

async function optionalJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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
    key: "imapSecure" | "smtpSecure" | "importEnabled" | "sendEnabled" | "patrolEnabled"
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
    "patrolEnabled",
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

  // Raporty z podjazdów (docs/PODJAZDY-RAPORTY.md): '' w folderze = jak folder raportów kamer.
  if (body.patrolFolder !== undefined) {
    patch.patrolFolder = normalizeCommaList(body.patrolFolder) ?? "";
  }
  if (body.patrolSubjectFilter !== undefined) {
    patch.patrolSubjectFilter = normalizeCommaList(body.patrolSubjectFilter);
  }
  if (body.patrolFromFilter !== undefined) {
    patch.patrolFromFilter = normalizeContains(body.patrolFromFilter);
  }
  if (body.patrolLookbackDays !== undefined && body.patrolLookbackDays !== null && body.patrolLookbackDays !== "") {
    const days = Number(body.patrolLookbackDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Zakres wstecz dla podjazdów musi być liczbą dni od 1 do 365." },
        400
      );
    }
    patch.patrolLookbackDays = days;
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

// Podjazdy: podgląd skrzynki (read-only, bez oznaczania jako przeczytane).
// Ciało opcjonalne: {patrolFolder, patrolSubjectFilter, patrolFromFilter, days} — niezapisane wartości z formularza.
app.post("/patrol-preview", async (c) => {
  const body = await optionalJson(c);
  try {
    const data = await previewPatrolMail(patrolOverridesFromBody(body));
    return c.json({ success: true, data });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Nie udało się sprawdzić skrzynki.",
      },
      400
    );
  }
});

// Podjazdy: import wsteczny z zapisanymi filtrami. Ciało opcjonalne: {days}.
app.post("/patrol-fetch", async (c) => {
  const body = await optionalJson(c);
  const days =
    body.days !== undefined && body.days !== null && body.days !== ""
      ? clampLookbackDays(body.days)
      : undefined;
  try {
    const data = await fetchPatrolMailShared(days);
    return c.json({ success: true, data });
  } catch (error) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Nie udało się pobrać raportów z podjazdów.",
      },
      400
    );
  }
});

// Podjazdy: ostatni raport z poczty + 5 ostatnich wpisów dziennika dla raport_z_podjazd*.
app.get("/patrol-status", async (c) => {
  const lastReport = await db
    .select({
      id: schema.patrolReports.id,
      fileName: schema.patrolReports.fileName,
      source: schema.patrolReports.source,
      receivedAt: schema.patrolReports.receivedAt,
      eventsTotal: schema.patrolReports.eventsTotal,
      createdAt: schema.patrolReports.createdAt,
    })
    .from(schema.patrolReports)
    .where(eq(schema.patrolReports.source, "mail"))
    .orderBy(desc(schema.patrolReports.id))
    .limit(1);
  const recent = await db
    .select({
      id: schema.cmaMailLog.id,
      subject: schema.cmaMailLog.subject,
      fileName: schema.cmaMailLog.fileName,
      status: schema.cmaMailLog.status,
      detail: schema.cmaMailLog.detail,
      createdAt: schema.cmaMailLog.createdAt,
    })
    .from(schema.cmaMailLog)
    .where(like(schema.cmaMailLog.fileName, "raport_z_podjazd%"))
    .orderBy(desc(schema.cmaMailLog.id))
    .limit(5);
  return c.json({ success: true, data: { lastReport: lastReport[0] ?? null, recent } });
});

/** Dozwolone wartości kolumn `status` i `direction` (enumy ze schematu cma_mail_log). */
const LOG_STATUSES = ["ok", "skipped", "error"] as const;
const LOG_DIRECTIONS = ["import", "send"] as const;
type LogStatus = (typeof LOG_STATUSES)[number];
type LogDirection = (typeof LOG_DIRECTIONS)[number];

/**
 * Sortowanie historii poczty. `status` i `direction` układamy CASE-em, bo kolejność
 * alfabetyczna wartości z bazy ("error", "ok", "skipped") nic użytkownikowi nie mówi —
 * status ma naturalną kolejność wagi (udało się → pominięto → błąd), a kierunek
 * kolejność przepływu (najpierw import, potem wysyłka). Ten sam wzorzec, co CASE
 * na statusie umowy w routes/contracts.ts.
 */
const LOG_SORT_COLUMNS = {
  createdAt: sql`${schema.cmaMailLog.createdAt}`,
  status: sql`case ${schema.cmaMailLog.status} when 'ok' then 0 when 'skipped' then 1 when 'error' then 2 else 3 end`,
  direction: sql`case ${schema.cmaMailLog.direction} when 'import' then 0 when 'send' then 1 else 2 end`,
  subject: sql`lower(coalesce(${schema.cmaMailLog.subject}, ''))`,
} as const;

export type CmaMailLogSortKey = keyof typeof LOG_SORT_COLUMNS;

function isLogSortKey(v: string): v is CmaMailLogSortKey {
  return Object.prototype.hasOwnProperty.call(LOG_SORT_COLUMNS, v);
}

// Mail operations log (paginated, newest first)
app.get("/log", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const offset = (page - 1) * pageSize;

  const search = c.req.query("search");
  const statusRaw = c.req.query("status");
  const status: LogStatus | undefined =
    statusRaw && (LOG_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as LogStatus)
      : undefined;
  const directionRaw = c.req.query("direction");
  const directionFilter: LogDirection | undefined =
    directionRaw && (LOG_DIRECTIONS as readonly string[]).includes(directionRaw)
      ? (directionRaw as LogDirection)
      : undefined;
  const sortRaw = c.req.query("sort") || "createdAt";
  const sort: CmaMailLogSortKey = isLogSortKey(sortRaw) ? sortRaw : "createdAt";
  // Domyślnie NAJNOWSZE wpisy na górze — brak parametru znaczy tu „desc", a nie „asc".
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";

  // Warunki do tablicy i jedno `and(...)`: kolejne `.where()` w drizzle nadpisuje
  // poprzednie, więc status razem z szukajką filtrowałby wyłącznie po ostatnim.
  const conditions: SQL[] = [];
  if (search) {
    conditions.push(
      or(
        like(schema.cmaMailLog.subject, `%${search}%`),
        like(schema.cmaMailLog.fileName, `%${search}%`)
      )!
    );
  }
  if (status !== undefined) conditions.push(eq(schema.cmaMailLog.status, status));
  if (directionFilter !== undefined) {
    conditions.push(eq(schema.cmaMailLog.direction, directionFilter));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Wpisy bez tematu (np. log wysyłki) na koniec listy w OBU kierunkach — inaczej
  // sortowanie po temacie zaczynałoby się od pustych komórek.
  const NULLS_LAST: Partial<Record<CmaMailLogSortKey, SQL>> = {
    subject: sql`case when ${schema.cmaMailLog.subject} is null or ${schema.cmaMailLog.subject} = '' then 1 else 0 end`,
  };
  const column = LOG_SORT_COLUMNS[sort];
  const orderDir = dir === "desc" ? desc : asc;
  // Tie-break po id malejąco: id rośnie z każdym wpisem, więc przy tej samej sekundzie
  // (log potrafi zapisać kilka wierszy naraz) najnowszy jest na górze — tak jak dotąd.
  const idTieBreak = desc(schema.cmaMailLog.id);
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, orderDir(column), idTieBreak]
    : [orderDir(column), idTieBreak];

  const results = await db
    .select()
    .from(schema.cmaMailLog)
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // Licznik MUSI respektować TE SAME filtry — inaczej paginacja pokazuje złe „total".
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.cmaMailLog)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: results,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
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

  // Wysyłkę z raportu robi też `cma/raporty: edit` (API_TAB_MAP), ale wtedy
  // WYŁĄCZNIE do adresatów z ustawień. Własny adres `to` to decyzja z poziomu
  // ustawień poczty — inaczej raport dałoby się wysłać dokądkolwiek.
  if (to && to.trim() && !canEdit(getUser(c), "cma/ustawienia")) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Własny adres odbiorcy wymaga prawa edycji ustawień CMA" },
      403
    );
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
