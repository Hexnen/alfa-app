import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type {
  CmaMailSettings,
  NewCmaMailSettings,
  NewCmaMailLogEntry,
  CmaReport,
} from "../db/schema.js";
import { CmaParseError } from "../utils/cma-xls.js";
import {
  importCmaReportBuffer,
  getCameraIssuesForReport,
  CmaDuplicateError,
  type CameraIssuesResult,
} from "../utils/cma-import.js";

// Raw SQLite instance for simple synchronous lookups
const sqlite = (db as any).$client as Database.Database;

// ---------------------------------------------------------------------------
// Settings (single row, id = 1)
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<CmaMailSettings> {
  const rows = await db
    .select()
    .from(schema.cmaMailSettings)
    .where(eq(schema.cmaMailSettings.id, 1))
    .limit(1);
  if (rows.length > 0) return rows[0];

  await db
    .insert(schema.cmaMailSettings)
    .values({ id: 1 })
    .onConflictDoNothing();

  const created = await db
    .select()
    .from(schema.cmaMailSettings)
    .where(eq(schema.cmaMailSettings.id, 1))
    .limit(1);
  return created[0];
}

export type MailSettingsPatch = Partial<
  Omit<NewCmaMailSettings, "id" | "updatedAt">
>;

export async function saveSettings(
  patch: MailSettingsPatch
): Promise<CmaMailSettings> {
  await getSettings(); // ensure the row exists

  const values: MailSettingsPatch = { ...patch };
  // Empty/undefined password means: keep the existing one
  if (values.password === undefined || values.password === "") {
    delete values.password;
  }

  await db
    .update(schema.cmaMailSettings)
    .set({ ...values, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.cmaMailSettings.id, 1));

  const settings = await getSettings();

  // Apply new polling configuration
  await startMailPoller();

  return settings;
}

export type SanitizedMailSettings = Omit<CmaMailSettings, "password"> & {
  hasPassword: boolean;
};

export function sanitizeSettings(
  settings: CmaMailSettings
): SanitizedMailSettings {
  const { password, ...rest } = settings;
  return { ...rest, hasPassword: Boolean(password && password.length > 0) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_CONFIG_ERROR =
  "Brak konfiguracji poczty — ustaw adres e-mail i hasło w ustawieniach.";

function describeMailError(error: unknown, context: "imap" | "smtp"): string {
  const err = error as {
    message?: string;
    code?: string;
    hostname?: string;
    authenticationFailed?: boolean;
    responseText?: string;
    responseCode?: number;
    response?: string;
  };
  const label = context === "imap" ? "IMAP" : "SMTP";

  if (
    err?.authenticationFailed ||
    err?.code === "EAUTH" ||
    err?.responseCode === 535
  ) {
    const detail = err.responseText || err.response || err.message;
    return `Błąd logowania ${label}: nieprawidłowy adres e-mail lub hasło${
      detail ? ` (${detail})` : ""
    }.`;
  }
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") {
    return `Błąd połączenia ${label}: nie znaleziono serwera${
      err.hostname ? ` "${err.hostname}"` : ""
    } (DNS).`;
  }
  if (err?.code === "ECONNREFUSED") {
    return `Błąd połączenia ${label}: serwer odrzucił połączenie.`;
  }
  if (
    err?.code === "ETIMEDOUT" ||
    err?.code === "ESOCKET" ||
    /timed?\s?out|timeout/i.test(err?.message ?? "")
  ) {
    return `Błąd połączenia ${label}: przekroczono limit czasu połączenia.`;
  }
  const detail = err?.responseText || err?.message || String(error);
  return `Błąd ${label}: ${detail}`;
}

function createImapClient(settings: CmaMailSettings): ImapFlow {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapSecure,
    auth: { user: settings.email!, pass: settings.password! },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 120000,
  });
}

function createSmtpTransport(settings: CmaMailSettings) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth: { user: settings.email!, pass: settings.password! },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
}

async function closeImapClient(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
}

async function logMail(
  entry: Omit<NewCmaMailLogEntry, "id" | "createdAt">
): Promise<void> {
  try {
    await db.insert(schema.cmaMailLog).values(entry);
  } catch (error) {
    console.error("[cma-mail] Nie udało się zapisać wpisu logu poczty:", error);
  }
}

async function updateLastCheck(
  status: "ok" | "error",
  errorMessage: string | null
): Promise<void> {
  try {
    await db
      .update(schema.cmaMailSettings)
      .set({
        lastCheckAt: sql`(datetime('now'))`,
        lastCheckStatus: status,
        lastCheckError: errorMessage,
      })
      .where(eq(schema.cmaMailSettings.id, 1));
  } catch (error) {
    console.error(
      "[cma-mail] Nie udało się zaktualizować statusu sprawdzania:",
      error
    );
  }
}

/**
 * Parse a comma-separated list of "HH:MM" send times.
 * Returns normalized (zero-padded) slots, [] for empty input,
 * or null when any entry has an invalid format / out-of-range value.
 */
export function parseSendTimes(
  value: string | null | undefined
): string[] | null {
  const raw = (value ?? "").trim();
  if (!raw) return [];

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];

  const slots: string[] = [];
  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(part);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    const slot = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    if (!slots.includes(slot)) slots.push(slot);
  }
  return slots;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse the settings.folder value as a comma-separated list of IMAP
 * folders. Empty/blank input falls back to ["INBOX"].
 */
export function parseFolderList(value: string | null | undefined): string[] {
  const parts = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)] : ["INBOX"];
}

/**
 * Parse the settings.subjectFilter value as a comma-separated list of
 * phrases. Entries are trimmed, lowercased and de-duplicated; empty
 * entries are dropped. An empty/blank input yields [] (= match all).
 */
export function parseSubjectPhrases(
  value: string | null | undefined
): string[] {
  const parts = (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(parts)];
}

/**
 * Case-insensitive OR match: the subject matches when it contains ANY
 * of the phrases. An empty phrase list matches everything.
 */
export function matchesSubjectFilter(
  subject: string | null | undefined,
  phrases: string[]
): boolean {
  if (phrases.length === 0) return true;
  const subjectLower = (subject ?? "").toLowerCase();
  return phrases.some((phrase) => subjectLower.includes(phrase));
}

type EnvelopeAddress = { name?: string; address?: string };

/**
 * Case-insensitive "contains" match of the sender filter against
 * the envelope from addresses (both address and display name).
 * An empty filter matches everyone.
 */
function matchesFromFilter(
  from: EnvelopeAddress[] | undefined,
  filterLower: string
): boolean {
  if (!filterLower) return true;
  return (from ?? []).some(
    (entry) =>
      (entry.address ?? "").toLowerCase().includes(filterLower) ||
      (entry.name ?? "").toLowerCase().includes(filterLower)
  );
}

// ---------------------------------------------------------------------------
// Report links in message bodies (Safestar "public report" links)
// ---------------------------------------------------------------------------

/** Any http(s) link whose path contains "/public/report/". */
const REPORT_LINK_REGEX =
  /https?:\/\/[^\s"'<>()[\]]*\/public\/report\/[A-Za-z0-9._~-]+/gi;

/**
 * Extract unique report links from the HTML and plain-text parts
 * of a message body.
 */
export function extractReportLinks(
  html: string | null | undefined,
  text: string | null | undefined
): string[] {
  const combined = `${html ?? ""}\n${text ?? ""}`;
  const matches = combined.match(REPORT_LINK_REGEX) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    // Strip trailing punctuation that may cling to a link in plain text
    unique.add(match.replace(/[.,;:!?]+$/, ""));
  }
  return [...unique];
}

/** Thrown when a report link no longer serves the XLS file (expired). */
export class CmaReportLinkExpiredError extends Error {
  constructor(message = "Link do raportu wygasł") {
    super(message);
    this.name = "CmaReportLinkExpiredError";
  }
}

const REPORT_DOWNLOAD_TIMEOUT_MS = 60_000;
const REPORT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(header);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

export interface DownloadedReport {
  buffer: Buffer;
  /** File name from the Content-Disposition header (with fallback applied). */
  fileName: string;
  /** Detected format based on magic bytes. */
  format: "xls" | "xlsx";
}

/**
 * Download a report file from a Safestar public-report link.
 * Validates the response: content-type must not be text/html and the
 * payload must start with XLS (D0 CF 11 E0) or XLSX/ZIP (50 4B) magic
 * bytes — an expired link returns an HTML SPA page with HTTP 200.
 *
 * @throws CmaReportLinkExpiredError for expired links (HTML response)
 * @throws Error for network errors / timeouts / oversized payloads
 */
export async function downloadReportFromLink(
  url: string
): Promise<DownloadedReport> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REPORT_DOWNLOAD_TIMEOUT_MS
  );

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new Error(
          "Przekroczono limit czasu pobierania raportu (60 s)."
        );
      }
      throw new Error(
        `Błąd sieci podczas pobierania raportu: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Serwer raportów zwrócił błąd HTTP ${response.status}.`
      );
    }

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();

    // Read the body with a hard size limit
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > REPORT_DOWNLOAD_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          throw new Error("Plik raportu przekracza limit 50 MB.");
        }
        chunks.push(Buffer.from(value));
      }
    }
    const buffer = Buffer.concat(chunks);

    const isXls =
      buffer.length >= 4 &&
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    const isXlsx =
      buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;

    // Expired links return HTTP 200 with a small HTML SPA page —
    // detection must rely on content-type + magic bytes, not the status
    if (contentType.includes("text/html") || (!isXls && !isXlsx)) {
      throw new CmaReportLinkExpiredError();
    }

    const format: "xls" | "xlsx" = isXls ? "xls" : "xlsx";
    let fileName = fileNameFromContentDisposition(
      response.headers.get("content-disposition")
    );
    if (!fileName) {
      // Fallback: token from the URL + current date
      const token = /\/public\/report\/([A-Za-z0-9._~-]+)/i.exec(url)?.[1];
      const date = new Date().toISOString().slice(0, 10);
      fileName = `raport_${date}_${token ?? "safestar"}.${format}`;
    }

    return { buffer, fileName, format };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Mailbox check (IMAP import)
// ---------------------------------------------------------------------------

export interface MailCheckSummary {
  checked: number;
  matched: number;
  imported: number;
  skipped: number;
  errors: number;
}

export async function checkMailbox(): Promise<MailCheckSummary> {
  const settings = await getSettings();
  if (!settings.email || !settings.password) {
    throw new Error(NO_CONFIG_ERROR);
  }

  const summary: MailCheckSummary = {
    checked: 0,
    matched: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
  };

  const folders = parseFolderList(settings.folder);
  const folderErrors: string[] = [];

  const client = createImapClient(settings);
  try {
    await client.connect();
  } catch (error) {
    const message = describeMailError(error, "imap");
    await updateLastCheck("error", message);
    await closeImapClient(client);
    throw new Error(message);
  }

  const subjectPhrases = parseSubjectPhrases(settings.subjectFilter);
  const fromFilter = (settings.fromFilter ?? "").trim().toLowerCase();

  // Process every folder from the list; an error in one folder
  // (e.g. non-existent mailbox) must not stop the remaining ones
  for (const folder of folders) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ seen: false }, { uid: true });

        for (const uid of uids || []) {
          summary.checked++;

          const meta = await client.fetchOne(
            String(uid),
            { envelope: true },
            { uid: true }
          );
          if (!meta) continue;
          const subject = meta.envelope?.subject ?? "";

          if (!matchesSubjectFilter(subject, subjectPhrases)) continue;
          if (!matchesFromFilter(meta.envelope?.from, fromFilter)) continue;
          summary.matched++;

          await processImportMessage(client, uid, subject, settings, summary);

          // Mark as seen regardless of the outcome so the message
          // is not re-processed on every poll
          try {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], {
              uid: true,
            });
          } catch (error) {
            console.error(
              `[cma-mail] Nie udało się oznaczyć wiadomości ${uid} jako przeczytanej:`,
              error
            );
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      folderErrors.push(
        `Folder "${folder}": ${describeMailError(error, "imap")}`
      );
    }
  }

  await closeImapClient(client);

  const errorParts = [...folderErrors];
  if (summary.errors > 0) {
    errorParts.push(`Błędy importu: ${summary.errors}`);
  }
  await updateLastCheck(
    errorParts.length > 0 ? "error" : "ok",
    errorParts.length > 0 ? errorParts.join("; ") : null
  );
  return summary;
}

/**
 * Import a single report buffer (from an attachment or a downloaded
 * link) with shared dedup/error handling and log entries.
 * `sourceLabel` is "(załącznik)" or "(link)".
 */
async function importReportForMessage(
  buffer: Buffer,
  fileName: string,
  sourceLabel: string,
  uid: number,
  subject: string,
  settings: CmaMailSettings,
  summary: MailCheckSummary
): Promise<void> {
  try {
    const report = importCmaReportBuffer(buffer, fileName);
    summary.imported++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      fileName,
      reportId: report.id,
      status: "ok",
      detail: `Zaimportowano raport (${report.entryCount} wpisów) ${sourceLabel}.`,
    });

    // Automatic issues e-mail after successful import.
    // A send failure must never break the import flow.
    if (
      settings.sendEnabled &&
      settings.sendMode === "after_import" &&
      (settings.recipients ?? "").trim()
    ) {
      try {
        await sendIssuesEmail(report.id, { auto: true });
      } catch (error) {
        // sendIssuesEmail already wrote an error entry to the log
        console.error(
          `[cma-mail] Automatyczna wysyłka dla raportu ${report.id} nie powiodła się:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  } catch (error) {
    if (error instanceof CmaDuplicateError) {
      summary.skipped++;
      await logMail({
        direction: "import",
        messageUid: uid,
        subject,
        fileName,
        reportId: error.existingId,
        status: "skipped",
        detail: `${error.message} (id=${error.existingId}) ${sourceLabel}.`,
      });
      return;
    }
    summary.errors++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      fileName,
      status: "error",
      detail: `${
        error instanceof CmaParseError
          ? error.message
          : `Nie udało się zaimportować raportu: ${
              error instanceof Error ? error.message : String(error)
            }`
      } ${sourceLabel}`,
    });
  }
}

async function processImportMessage(
  client: ImapFlow,
  uid: number,
  subject: string,
  settings: CmaMailSettings,
  summary: MailCheckSummary
): Promise<void> {
  let attachments: { filename: string; content: Buffer }[];
  let bodyHtml: string | null = null;
  let bodyText: string | null = null;
  try {
    const full = await client.fetchOne(
      String(uid),
      { source: true },
      { uid: true }
    );
    if (!full || !full.source) {
      throw new Error("Nie udało się pobrać treści wiadomości.");
    }
    const mail = await simpleParser(full.source);
    attachments = (mail.attachments ?? [])
      .filter((att) => /\.(xls|xlsx)$/i.test(att.filename ?? ""))
      .map((att) => ({
        filename: att.filename!,
        content: att.content as Buffer,
      }));
    bodyHtml = typeof mail.html === "string" ? mail.html : null;
    bodyText = typeof mail.text === "string" ? mail.text : null;
  } catch (error) {
    summary.errors++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Nie udało się przetworzyć wiadomości.",
    });
    return;
  }

  // Attachments take precedence; report links in the body are used
  // only when the message carries no XLS/XLSX attachment
  if (attachments.length > 0) {
    for (const attachment of attachments) {
      await importReportForMessage(
        attachment.content,
        attachment.filename,
        "(załącznik)",
        uid,
        subject,
        settings,
        summary
      );
    }
    return;
  }

  const links = extractReportLinks(bodyHtml, bodyText);
  if (links.length === 0) {
    summary.skipped++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      status: "skipped",
      detail:
        "Brak załączników XLS/XLSX i linków do raportu w wiadomości.",
    });
    return;
  }

  for (const link of links) {
    let downloaded: DownloadedReport;
    try {
      downloaded = await downloadReportFromLink(link);
    } catch (error) {
      if (error instanceof CmaReportLinkExpiredError) {
        summary.skipped++;
        await logMail({
          direction: "import",
          messageUid: uid,
          subject,
          status: "skipped",
          detail: `Link do raportu wygasł (link): ${link}`,
        });
      } else {
        summary.errors++;
        await logMail({
          direction: "import",
          messageUid: uid,
          subject,
          status: "error",
          detail: `${
            error instanceof Error ? error.message : String(error)
          } (link): ${link}`,
        });
      }
      continue;
    }

    await importReportForMessage(
      downloaded.buffer,
      downloaded.fileName,
      "(link)",
      uid,
      subject,
      settings,
      summary
    );
  }
}

// ---------------------------------------------------------------------------
// Connection tests
// ---------------------------------------------------------------------------

export interface ImapFolderMatch {
  folder: string;
  matched: number;
  /** Set when the folder could not be opened (e.g. it does not exist). */
  error?: string;
}

export interface ImapTestResult {
  folders: string[];
  /** Sum of matches across all configured folders (backward compat). */
  matchedInFolder: number;
  matchedPerFolder: ImapFolderMatch[];
}

export async function testImapConnection(): Promise<ImapTestResult> {
  const settings = await getSettings();
  if (!settings.email || !settings.password) {
    throw new Error(NO_CONFIG_ERROR);
  }

  const client = createImapClient(settings);
  try {
    await client.connect();

    const boxes = await client.list();
    const folders = boxes.map((box) => box.path);

    const subjectPhrases = parseSubjectPhrases(settings.subjectFilter);
    const fromFilter = (settings.fromFilter ?? "").trim().toLowerCase();
    const configuredFolders = parseFolderList(settings.folder);
    const matchedPerFolder: ImapFolderMatch[] = [];

    for (const folder of configuredFolders) {
      try {
        let matched = 0;
        const lock = await client.getMailboxLock(folder);
        try {
          const mailbox = client.mailbox;
          const total =
            mailbox && typeof mailbox !== "boolean" ? mailbox.exists : 0;

          if (total > 0 && subjectPhrases.length === 0 && !fromFilter) {
            // No filters — every message matches
            matched = total;
          } else if (total > 0) {
            // Hybrid matching over the whole folder: narrow candidates
            // with a server-side search when the filter is ASCII-safe
            // (some servers mishandle UTF-8 SEARCH criteria), then
            // verify each candidate client-side against both filters.
            // A single-phrase subject filter can use server-side SEARCH;
            // multiple phrases (OR) are verified client-side only, as
            // IMAP SEARCH criteria combine with AND.
            const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);
            const query: Record<string, unknown> = {};
            if (fromFilter && isAscii(fromFilter)) query.from = fromFilter;
            if (subjectPhrases.length === 1 && isAscii(subjectPhrases[0])) {
              query.subject = subjectPhrases[0];
            }

            let range = "1:*";
            let byUid = false;
            if (Object.keys(query).length > 0) {
              const uids = (await client.search(query, { uid: true })) || [];
              if (uids.length === 0) {
                matched = 0;
                range = "";
              } else {
                range = uids.join(",");
                byUid = true;
              }
            }

            if (range) {
              for await (const message of client.fetch(
                range,
                { envelope: true },
                byUid ? { uid: true } : undefined
              )) {
                const subject = message.envelope?.subject ?? "";
                if (!matchesSubjectFilter(subject, subjectPhrases)) {
                  continue;
                }
                if (!matchesFromFilter(message.envelope?.from, fromFilter)) {
                  continue;
                }
                matched++;
              }
            }
          }
        } finally {
          lock.release();
        }
        matchedPerFolder.push({ folder, matched });
      } catch (error) {
        matchedPerFolder.push({
          folder,
          matched: 0,
          error: describeMailError(error, "imap"),
        });
      }
    }

    const matchedInFolder = matchedPerFolder.reduce(
      (sum, entry) => sum + entry.matched,
      0
    );

    return { folders, matchedInFolder, matchedPerFolder };
  } catch (error) {
    throw new Error(describeMailError(error, "imap"));
  } finally {
    await closeImapClient(client);
  }
}

export async function testSmtpConnection(to?: string): Promise<string> {
  const settings = await getSettings();
  if (!settings.email || !settings.password) {
    throw new Error(NO_CONFIG_ERROR);
  }

  const transporter = createSmtpTransport(settings);
  try {
    await transporter.verify();

    const recipient = to?.trim();
    if (recipient) {
      await transporter.sendMail({
        from: settings.email,
        to: recipient,
        subject: "Wiadomość testowa — Alfa Group / CMA",
        text: "To jest wiadomość testowa wysłana z systemu Alfa Group / CMA. Konfiguracja SMTP działa poprawnie.",
        html: `<p>To jest wiadomość testowa wysłana z systemu <strong>Alfa Group / CMA</strong>.</p><p>Konfiguracja SMTP działa poprawnie.</p>`,
      });
      return `Połączenie SMTP działa. Wysłano wiadomość testową do: ${recipient}.`;
    }

    return "Połączenie SMTP działa poprawnie.";
  } catch (error) {
    throw new Error(describeMailError(error, "smtp"));
  } finally {
    transporter.close();
  }
}

// ---------------------------------------------------------------------------
// Issues e-mail (SMTP send)
// ---------------------------------------------------------------------------

export interface SendIssuesOptions {
  classification?: string;
  to?: string;
  /** true when triggered automatically (after import or by the scheduler) */
  auto?: boolean;
  /** "HH:MM" slot when triggered by the scheduled-send ticker */
  scheduledSlot?: string;
}

export interface SendIssuesResult {
  sent: boolean;
  skipped?: boolean;
  to?: string;
  message: string;
}

export async function sendIssuesEmail(
  reportId: number,
  options: SendIssuesOptions = {}
): Promise<SendIssuesResult> {
  const settings = await getSettings();
  const classification = options.classification?.trim() || "Brak obrazu";
  const auto = options.auto ?? false;
  // Suffix appended to log details for scheduled sends, e.g. " (wysyłka planowa 07:30)"
  const slotSuffix = options.scheduledSlot
    ? ` (wysyłka planowa ${options.scheduledSlot})`
    : "";

  const reports = await db
    .select()
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, reportId))
    .limit(1);
  if (reports.length === 0) {
    throw new Error("Nie znaleziono raportu");
  }
  const report = reports[0];

  if (!settings.email || !settings.password) {
    throw new Error(NO_CONFIG_ERROR);
  }
  const to = options.to?.trim() || (settings.recipients ?? "").trim();
  if (!to) {
    throw new Error(
      "Brak odbiorców — podaj adresy e-mail lub uzupełnij listę odbiorców w ustawieniach."
    );
  }

  const issuesData = getCameraIssuesForReport(reportId, classification);
  const hasIssues = issuesData.issues.length > 0;

  if (!hasIssues && auto) {
    await logMail({
      direction: "send",
      reportId,
      fileName: report.fileName,
      status: "skipped",
      detail: `Brak zdarzeń "${classification}" w raporcie — pominięto automatyczną wysyłkę.${slotSuffix}`,
    });
    return {
      sent: false,
      skipped: true,
      message: `Brak zdarzeń "${classification}" — wysyłkę pominięto.`,
    };
  }

  const range = `${report.dateFrom ?? "?"} – ${report.dateTo ?? "?"}`;
  const subjectPrefix =
    classification === "Brak obrazu"
      ? "Brak obrazu z kamer"
      : `Zdarzenia z kamer (${classification})`;
  const subject = hasIssues
    ? `${subjectPrefix} — ${report.title} (${range})`
    : `Brak zdarzeń "${classification}" — ${report.title} (${range})`;

  const { html, text } = buildIssuesEmailContent(
    report,
    issuesData,
    classification
  );

  const transporter = createSmtpTransport(settings);
  try {
    await transporter.sendMail({
      from: settings.email,
      to,
      subject,
      html,
      text,
    });
    await logMail({
      direction: "send",
      reportId,
      subject,
      fileName: report.fileName,
      status: "ok",
      detail: `Wysłano do: ${to}${slotSuffix}`,
    });
    return { sent: true, to, message: `Wysłano do ${to}` };
  } catch (error) {
    const message = describeMailError(error, "smtp");
    await logMail({
      direction: "send",
      reportId,
      subject,
      fileName: report.fileName,
      status: "error",
      detail: `${message}${slotSuffix}`,
    });
    throw new Error(message);
  } finally {
    transporter.close();
  }
}

function buildIssuesEmailContent(
  report: CmaReport,
  issuesData: CameraIssuesResult,
  classification: string
): { html: string; text: string } {
  const range = `${report.dateFrom ?? "?"} – ${report.dateTo ?? "?"}`;
  const objectCount = issuesData.issues.length;
  const cameraCount = issuesData.issues.reduce(
    (sum, obj) => sum + obj.cameras.length,
    0
  );
  const eventCount = issuesData.issues.reduce(
    (sum, obj) => sum + obj.totalCount,
    0
  );

  const footerHtml = `
    <p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
      Wygenerowano automatycznie – Alfa Group / CMA
    </p>`;

  if (objectCount === 0) {
    const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:760px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px;font-size:18px;color:#0f172a;">${escapeHtml(report.title)}</h2>
  <p style="margin:0 0 16px;color:#64748b;font-size:13px;">Okres raportu: ${escapeHtml(range)}</p>
  <p style="margin:0;font-size:14px;">Brak zdarzeń „${escapeHtml(classification)}” w tym raporcie.</p>
  ${footerHtml}
</div>`;
    const text = [
      report.title,
      `Okres raportu: ${range}`,
      "",
      `Brak zdarzeń "${classification}" w tym raporcie.`,
      "",
      "Wygenerowano automatycznie – Alfa Group / CMA",
    ].join("\n");
    return { html, text };
  }

  const objectsHtml = issuesData.issues
    .map((obj) => {
      const rows = obj.cameras
        .map(
          (camera, index) => `
        <tr style="background:${index % 2 === 0 ? "#ffffff" : "#f8fafc"};">
          <td style="padding:6px 10px;border:1px solid #e2e8f0;font-size:13px;">${escapeHtml(camera.videoChannel ?? "—")}</td>
          <td style="padding:6px 10px;border:1px solid #e2e8f0;font-size:13px;">${escapeHtml(camera.videoDevice ?? "—")}</td>
          <td style="padding:6px 10px;border:1px solid #e2e8f0;font-size:13px;text-align:center;">${camera.count}</td>
          <td style="padding:6px 10px;border:1px solid #e2e8f0;font-size:13px;white-space:nowrap;">${escapeHtml(camera.firstAt ?? "—")}</td>
          <td style="padding:6px 10px;border:1px solid #e2e8f0;font-size:13px;white-space:nowrap;">${escapeHtml(camera.lastAt ?? "—")}</td>
        </tr>`
        )
        .join("");

      return `
  <div style="margin:0 0 20px;">
    <h3 style="margin:0 0 2px;font-size:15px;color:#0f172a;">${escapeHtml(obj.objectName)}</h3>
    <p style="margin:0 0 8px;color:#64748b;font-size:12px;">
      ${obj.address ? escapeHtml(obj.address) + " &middot; " : ""}zdarzenia: <strong>${obj.totalCount}</strong>
    </p>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
      <tr style="background:#f1f5f9;">
        <th style="padding:6px 10px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#475569;">Kanał</th>
        <th style="padding:6px 10px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#475569;">Urządzenie</th>
        <th style="padding:6px 10px;border:1px solid #e2e8f0;font-size:12px;text-align:center;color:#475569;">Wystąpienia</th>
        <th style="padding:6px 10px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#475569;">Pierwsze</th>
        <th style="padding:6px 10px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#475569;">Ostatnie</th>
      </tr>
      ${rows}
    </table>
  </div>`;
    })
    .join("");

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:760px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px;font-size:18px;color:#0f172a;">${escapeHtml(report.title)}</h2>
  <p style="margin:0 0 16px;color:#64748b;font-size:13px;">Okres raportu: ${escapeHtml(range)}</p>
  <p style="margin:0 0 16px;font-size:14px;">
    Zdarzenia „${escapeHtml(classification)}”:
    <strong>${objectCount}</strong> ${objectCount === 1 ? "obiekt" : "obiekty/obiektów"},
    <strong>${cameraCount}</strong> ${cameraCount === 1 ? "kamera" : "kamery/kamer"},
    <strong>${eventCount}</strong> ${eventCount === 1 ? "zdarzenie" : "zdarzenia/zdarzeń"}.
  </p>
  ${objectsHtml}
  ${footerHtml}
</div>`;

  const textParts: string[] = [
    report.title,
    `Okres raportu: ${range}`,
    "",
    `Zdarzenia "${classification}": obiekty: ${objectCount}, kamery: ${cameraCount}, zdarzenia: ${eventCount}`,
    "",
  ];
  for (const obj of issuesData.issues) {
    textParts.push(
      `${obj.objectName}${obj.address ? ` (${obj.address})` : ""} — zdarzenia: ${obj.totalCount}`
    );
    for (const camera of obj.cameras) {
      textParts.push(
        `  - kanał: ${camera.videoChannel ?? "—"} | urządzenie: ${camera.videoDevice ?? "—"} | wystąpienia: ${camera.count} | pierwsze: ${camera.firstAt ?? "—"} | ostatnie: ${camera.lastAt ?? "—"}`
      );
    }
    textParts.push("");
  }
  textParts.push("Wygenerowano automatycznie – Alfa Group / CMA");

  return { html, text: textParts.join("\n") };
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

interface MailPollerState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  schedulerTimer: ReturnType<typeof setInterval> | null;
  schedulerRunning: boolean;
}

// Keep poller state on globalThis so tsx watch hot-reloads
// do not leave orphaned intervals behind
const globalState = globalThis as typeof globalThis & {
  __cmaMailPollerState?: MailPollerState;
};

function getPollerState(): MailPollerState {
  if (!globalState.__cmaMailPollerState) {
    globalState.__cmaMailPollerState = {
      timer: null,
      running: false,
      schedulerTimer: null,
      schedulerRunning: false,
    };
  }
  const state = globalState.__cmaMailPollerState;
  // A state object created before the scheduler existed may lack the fields
  if (state.schedulerTimer === undefined) state.schedulerTimer = null;
  if (state.schedulerRunning === undefined) state.schedulerRunning = false;
  return state;
}

async function runPollTick(): Promise<void> {
  const state = getPollerState();
  if (state.running) return;
  state.running = true;
  try {
    const summary = await checkMailbox();
    console.log(
      `[cma-mail] Sprawdzono skrzynkę: sprawdzone=${summary.checked}, dopasowane=${summary.matched}, zaimportowane=${summary.imported}, pominięte=${summary.skipped}, błędy=${summary.errors}`
    );
  } catch (error) {
    // checkMailbox already stored lastCheckError in settings
    console.error(
      "[cma-mail] Błąd sprawdzania skrzynki:",
      error instanceof Error ? error.message : error
    );
  } finally {
    state.running = false;
  }
}

const SCHEDULER_TICK_MS = 45_000;

/**
 * One tick of the scheduled-send ticker. Re-reads settings each time,
 * so mid-flight changes take effect without a restart. When the current
 * local time (rounded to the minute) matches one of the configured
 * "HH:MM" slots, the newest report is sent — at most once per slot
 * per day, guarded by lastScheduledSendKey.
 */
async function runSchedulerTick(): Promise<void> {
  const state = getPollerState();
  if (state.schedulerRunning) return;
  state.schedulerRunning = true;
  try {
    const settings = await getSettings();
    if (!settings.sendEnabled || settings.sendMode !== "scheduled") return;
    if (!settings.email || !settings.password) return;
    if (!(settings.recipients ?? "").trim()) return;

    const slots = parseSendTimes(settings.sendTimes);
    if (!slots || slots.length === 0) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const slot = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (!slots.includes(slot)) return;

    const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )} ${slot}`;
    if (settings.lastScheduledSendKey === key) return;

    // Store the guard key BEFORE sending, so a send error does not
    // cause a retry on every tick within the same minute/slot
    await db
      .update(schema.cmaMailSettings)
      .set({ lastScheduledSendKey: key })
      .where(eq(schema.cmaMailSettings.id, 1));

    // Newest report: max importedAt, id as tiebreak
    const report = sqlite
      .prepare(
        `SELECT id FROM cma_reports ORDER BY imported_at DESC, id DESC LIMIT 1`
      )
      .get() as { id: number } | undefined;

    if (!report) {
      await logMail({
        direction: "send",
        status: "skipped",
        detail: `Brak raportów do wysyłki (wysyłka planowa ${slot}).`,
      });
      return;
    }

    try {
      await sendIssuesEmail(report.id, { auto: true, scheduledSlot: slot });
      console.log(
        `[cma-mail] Wysyłka planowa ${slot}: raport ${report.id} przetworzony.`
      );
    } catch (error) {
      // sendIssuesEmail already wrote an error entry to the log
      console.error(
        `[cma-mail] Wysyłka planowa ${slot} dla raportu ${report.id} nie powiodła się:`,
        error instanceof Error ? error.message : error
      );
    }
  } catch (error) {
    console.error(
      "[cma-mail] Błąd harmonogramu wysyłki:",
      error instanceof Error ? error.message : error
    );
  } finally {
    state.schedulerRunning = false;
  }
}

/**
 * Start (or restart) the IMAP polling interval and the scheduled-send
 * ticker based on current settings.
 * Safe to call multiple times - previous intervals are always cleared first.
 * Never throws.
 */
export async function startMailPoller(): Promise<void> {
  const state = getPollerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.schedulerTimer) {
    clearInterval(state.schedulerTimer);
    state.schedulerTimer = null;
  }

  let settings: CmaMailSettings;
  try {
    settings = await getSettings();
  } catch (error) {
    console.error(
      "[cma-mail] Nie udało się odczytać ustawień poczty — poller nieaktywny:",
      error
    );
    return;
  }

  // IMAP import poller
  if (settings.importEnabled && settings.email && settings.password) {
    const minutes =
      Number.isFinite(settings.pollMinutes) && settings.pollMinutes > 0
        ? settings.pollMinutes
        : 15;
    state.timer = setInterval(() => {
      void runPollTick();
    }, minutes * 60_000);
    // Do not keep the process alive because of the poller alone
    state.timer.unref?.();
    console.log(`[cma-mail] Poller poczty uruchomiony (co ${minutes} min).`);
  } else {
    console.log(
      "[cma-mail] Poller poczty nieaktywny (import wyłączony lub brak danych logowania)."
    );
  }

  // Scheduled-send ticker (~45 s); conditions are re-checked on every tick
  if (settings.sendEnabled && settings.sendMode === "scheduled") {
    state.schedulerTimer = setInterval(() => {
      void runSchedulerTick();
    }, SCHEDULER_TICK_MS);
    state.schedulerTimer.unref?.();
    console.log(
      "[cma-mail] Harmonogram wysyłki uruchomiony (tick co 45 s)."
    );
  }
}
