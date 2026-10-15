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
import {
  importPatrolReportBuffer,
  PatrolDuplicateError,
  PatrolParseError,
} from "../utils/patrol-import.js";

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
export function matchesFromFilter(
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
// Raporty z podjazdów — własne filtry skanu (docs/PODJAZDY-RAPORTY.md,
// „Ustawienia podjazdów — stan”). Czyste funkcje, testowane w
// scripts/test-patrol-mail-settings.ts.
// ---------------------------------------------------------------------------

/** Foldery skanu podjazdów: własna lista albo (puste pole) te same co raporty kamer. */
export function patrolFolderList(
  settings: Pick<CmaMailSettings, "folder" | "patrolFolder">
): string[] {
  return (settings.patrolFolder ?? "").trim()
    ? parseFolderList(settings.patrolFolder)
    : parseFolderList(settings.folder);
}

/** Załącznik raportu z podjazdów: `raport_z_podjazd*.xls(x)` — twardy warunek niezależny od filtrów. */
export function isPatrolAttachmentName(fileName: string | null | undefined): boolean {
  const name = (fileName ?? "").trim();
  return isPatrolReportFileName(name) && /\.xlsx?$/i.test(name);
}

type BodyStructureNode = {
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: BodyStructureNode[];
};

/**
 * Nazwy plików z BODYSTRUCTURE (bez pobierania treści maila) — imapflow
 * dekoduje już RFC 2231 / encoded-words. Nazwa z `filename` (Content-Disposition)
 * albo `name` (Content-Type).
 */
export function attachmentNamesFromStructure(
  node: BodyStructureNode | null | undefined
): string[] {
  const names: string[] = [];
  const walk = (n: BodyStructureNode | null | undefined) => {
    if (!n) return;
    const name = n.dispositionParameters?.filename || n.parameters?.name;
    if (name && !names.includes(name)) names.push(name);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return names;
}

export interface MailScanConfig {
  cameraEnabled: boolean;
  cameraFolders: string[];
  cameraPhrases: string[];
  cameraFrom: string;
  patrolEnabled: boolean;
  patrolFolders: string[];
  patrolPhrases: string[];
  patrolFrom: string;
}

export function buildScanConfig(
  settings: Pick<
    CmaMailSettings,
    | "importEnabled"
    | "folder"
    | "subjectFilter"
    | "fromFilter"
    | "patrolEnabled"
    | "patrolFolder"
    | "patrolSubjectFilter"
    | "patrolFromFilter"
  >
): MailScanConfig {
  return {
    cameraEnabled: Boolean(settings.importEnabled),
    cameraFolders: parseFolderList(settings.folder),
    cameraPhrases: parseSubjectPhrases(settings.subjectFilter),
    cameraFrom: (settings.fromFilter ?? "").trim().toLowerCase(),
    patrolEnabled: Boolean(settings.patrolEnabled),
    patrolFolders: patrolFolderList(settings),
    patrolPhrases: parseSubjectPhrases(settings.patrolSubjectFilter),
    patrolFrom: (settings.patrolFromFilter ?? "").trim().toLowerCase(),
  };
}

export interface ScanMessageInfo {
  folder: string;
  subject: string | null | undefined;
  from: EnvelopeAddress[] | undefined;
  attachmentNames: string[];
}

/** Czy wiadomość spełnia filtry podjazdów (temat, nadawca) i ma załącznik raportu. Bez sprawdzania folderu. */
export function matchesPatrolMessage(
  msg: Omit<ScanMessageInfo, "folder">,
  cfg: Pick<MailScanConfig, "patrolPhrases" | "patrolFrom">
): boolean {
  return (
    msg.attachmentNames.some(isPatrolAttachmentName) &&
    matchesSubjectFilter(msg.subject, cfg.patrolPhrases) &&
    matchesFromFilter(msg.from, cfg.patrolFrom)
  );
}

/**
 * Do którego potoku trafia nieprzeczytana wiadomość: raporty kamer (filtry
 * kamer, bez zmian) i/lub podjazdy (własne filtry + załącznik raport_z_podjazd*).
 * Filtry kamer NIE obejmują już podjazdów.
 */
export function classifyScanMessage(
  msg: ScanMessageInfo,
  cfg: MailScanConfig
): { camera: boolean; patrol: boolean } {
  const camera =
    cfg.cameraEnabled &&
    cfg.cameraFolders.includes(msg.folder) &&
    matchesSubjectFilter(msg.subject, cfg.cameraPhrases) &&
    matchesFromFilter(msg.from, cfg.cameraFrom);
  const patrol =
    cfg.patrolEnabled &&
    cfg.patrolFolders.includes(msg.folder) &&
    matchesPatrolMessage(msg, cfg);
  return { camera, patrol };
}

/** Foldery do otwarcia w jednym skanie (bez duplikatów, tylko włączone potoki). */
export function scanFolders(cfg: MailScanConfig): string[] {
  return [
    ...new Set([
      ...(cfg.cameraEnabled ? cfg.cameraFolders : []),
      ...(cfg.patrolEnabled ? cfg.patrolFolders : []),
    ]),
  ];
}

/** Liczba dni wstecz dla podglądu/pobrania podjazdów: 1–365, domyślnie 30. */
export function clampLookbackDays(value: unknown, fallback = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(365, Math.max(1, Math.round(n)));
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

export interface PatrolScanCounts {
  matched: number;
  imported: number;
  skipped: number;
  errors: number;
}

export interface MailCheckSummary {
  checked: number;
  matched: number;
  imported: number;
  skipped: number;
  errors: number;
  /** Część dotycząca raportów z podjazdów (wliczona też w pola ogólne). */
  patrol: PatrolScanCounts;
}

function emptyPatrolCounts(): PatrolScanCounts {
  return { matched: 0, imported: 0, skipped: 0, errors: 0 };
}

async function updatePatrolLastCheck(
  status: "ok" | "error",
  errorMessage: string | null
): Promise<void> {
  try {
    await db
      .update(schema.cmaMailSettings)
      .set({
        patrolLastCheckAt: sql`(datetime('now'))`,
        patrolLastCheckStatus: status,
        patrolLastCheckError: errorMessage,
      })
      .where(eq(schema.cmaMailSettings.id, 1));
  } catch (error) {
    console.error("[cma-mail] Nie udało się zapisać stanu skanu podjazdów:", error);
  }
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
    patrol: emptyPatrolCounts(),
  };

  const cfg = buildScanConfig(settings);
  const folders = scanFolders(cfg);
  const folderErrors: string[] = [];
  const patrolFolderErrors: string[] = [];

  const client = createImapClient(settings);
  try {
    await client.connect();
  } catch (error) {
    const message = describeMailError(error, "imap");
    await updateLastCheck("error", message);
    await closeImapClient(client);
    if (cfg.patrolEnabled) await updatePatrolLastCheck("error", message);
    throw new Error(message);
  }

  // Process every folder from the list; an error in one folder
  // (e.g. non-existent mailbox) must not stop the remaining ones.
  // Foldery = suma folderów raportów kamer i podjazdów (każdy potok ma swoje filtry).
  for (const folder of folders) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ seen: false }, { uid: true });

        for (const uid of uids || []) {
          summary.checked++;

          const meta = await client.fetchOne(
            String(uid),
            { envelope: true, bodyStructure: true },
            { uid: true }
          );
          if (!meta) continue;
          const subject = meta.envelope?.subject ?? "";

          const scope = classifyScanMessage(
            {
              folder,
              subject,
              from: meta.envelope?.from,
              attachmentNames: attachmentNamesFromStructure(
                meta.bodyStructure as BodyStructureNode | undefined
              ),
            },
            cfg
          );
          // Nic nie pasuje — wiadomość zostaje nieprzeczytana.
          if (!scope.camera && !scope.patrol) continue;
          summary.matched++;
          if (scope.patrol) summary.patrol.matched++;

          await processImportMessage(client, uid, subject, settings, summary, scope);

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
      const message = `Folder "${folder}": ${describeMailError(error, "imap")}`;
      folderErrors.push(message);
      if (cfg.patrolEnabled && cfg.patrolFolders.includes(folder)) {
        patrolFolderErrors.push(message);
      }
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
  if (cfg.patrolEnabled) {
    const patrolParts = [...patrolFolderErrors];
    if (summary.patrol.errors > 0) {
      patrolParts.push(`Błędy importu podjazdów: ${summary.patrol.errors}`);
    }
    await updatePatrolLastCheck(
      patrolParts.length > 0 ? "error" : "ok",
      patrolParts.length > 0 ? patrolParts.join("; ") : null
    );
  }
  return summary;
}

// Wszystkie operacje zmieniające skrzynkę (skan, import wsteczny podjazdów)
// idą po kolei — równoległe sesje IMAP pobierałyby i oznaczały te same maile.
let imapChain: Promise<unknown> = Promise.resolve();

function runImapExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = imapChain.then(fn, fn);
  imapChain = run.catch(() => undefined);
  return run;
}

// Shared in-flight mailbox scan. The manual /check-now route, the poll
// tick and any other caller funnel through checkMailboxShared so at most
// one IMAP scan runs at a time — concurrent scans would open duplicate
// connections, re-download/re-flag the same messages and clobber each
// other's lastCheck status. Callers racing an in-progress scan get its
// result instead of starting a second one.
let inFlightMailboxCheck: Promise<MailCheckSummary> | null = null;

export function checkMailboxShared(): Promise<MailCheckSummary> {
  if (inFlightMailboxCheck) return inFlightMailboxCheck;
  const run = runImapExclusive(checkMailbox).finally(() => {
    inFlightMailboxCheck = null;
  });
  inFlightMailboxCheck = run;
  return run;
}

// ---------------------------------------------------------------------------
// Raporty z podjazdów — podgląd skrzynki (read-only) i import wsteczny
// ---------------------------------------------------------------------------

export interface PatrolMailFilterOverrides {
  /** Foldery po przecinku; '' = jak folder raportów kamer. */
  patrolFolder?: string;
  patrolSubjectFilter?: string | null;
  patrolFromFilter?: string | null;
  days?: number;
}

export type PatrolPreviewStatus = "imported" | "poller" | "fetch";

export interface PatrolPreviewMessage {
  folder: string;
  uid: number;
  subject: string;
  from: string;
  date: string | null;
  attachments: string[];
  seen: boolean;
  /** imported = już w bazie; poller = nieprzeczytany, weźmie go najbliższe sprawdzenie; fetch = tylko „Pobierz teraz”. */
  status: PatrolPreviewStatus;
}

export interface PatrolFolderScan {
  folder: string;
  scanned: number;
  matched: number;
  error?: string;
}

export interface PatrolPreviewResult {
  days: number;
  since: string;
  folders: PatrolFolderScan[];
  /** Maile w zakresie dat spełniające filtry tematu/nadawcy i z załącznikiem raportu. */
  matched: number;
  alreadyImported: number;
  /** Maile spełniające filtry tematu/nadawcy, ale bez załącznika raport_z_podjazd*. */
  withoutAttachment: number;
  /** 10 najnowszych dopasowanych. */
  messages: PatrolPreviewMessage[];
}

export interface PatrolFetchResult extends PatrolScanCounts {
  days: number;
  folders: PatrolFolderScan[];
  alreadyImported: number;
}

interface PatrolCandidate {
  folder: string;
  uid: number;
  subject: string;
  from: string;
  date: Date | null;
  attachments: string[];
  seen: boolean;
  messageId: string | null;
  imported: boolean;
  /** Spełnia też filtry raportów kamer — nie zmieniamy mu flagi \Seen. */
  cameraMatch: boolean;
}

/** Ile najnowszych wiadomości z zakresu dat przeglądamy w jednym folderze. */
const PATROL_SCAN_MAX_PER_FOLDER = 1000;

function formatFrom(from: EnvelopeAddress[] | undefined): string {
  return (from ?? [])
    .map((entry) =>
      entry.name && entry.address
        ? `${entry.name} <${entry.address}>`
        : entry.address || entry.name || ""
    )
    .filter(Boolean)
    .join(", ");
}

/** Raport podjazdów już w bazie: ten sam Message-ID albo ta sama nazwa pliku (nazwy mają hash). */
export function loadImportedPatrolKeys(): { messageIds: Set<string>; fileNames: Set<string> } {
  const rows = sqlite
    .prepare(`SELECT file_name AS fileName, mail_message_id AS messageId FROM patrol_reports`)
    .all() as { fileName: string; messageId: string | null }[];
  return {
    messageIds: new Set(rows.map((r) => r.messageId).filter((v): v is string => Boolean(v))),
    fileNames: new Set(rows.map((r) => r.fileName.trim().toLowerCase())),
  };
}

export function isPatrolMessageImported(
  messageId: string | null | undefined,
  attachments: string[],
  keys: { messageIds: Set<string>; fileNames: Set<string> }
): boolean {
  if (messageId && keys.messageIds.has(messageId)) return true;
  const reports = attachments.filter(isPatrolAttachmentName);
  return reports.length > 0 && reports.every((name) => keys.fileNames.has(name.trim().toLowerCase()));
}

function mergePatrolOverrides(
  settings: CmaMailSettings,
  overrides: PatrolMailFilterOverrides
): CmaMailSettings {
  return {
    ...settings,
    patrolFolder:
      overrides.patrolFolder !== undefined ? overrides.patrolFolder : settings.patrolFolder,
    patrolSubjectFilter:
      overrides.patrolSubjectFilter !== undefined
        ? overrides.patrolSubjectFilter
        : settings.patrolSubjectFilter,
    patrolFromFilter:
      overrides.patrolFromFilter !== undefined
        ? overrides.patrolFromFilter
        : settings.patrolFromFilter,
  };
}

/**
 * Przegląda foldery podjazdów od `since` (przeczytane i nieprzeczytane),
 * samymi nagłówkami + BODYSTRUCTURE — bez pobierania treści i bez zmiany flag.
 */
async function scanPatrolCandidates(
  client: ImapFlow,
  settings: CmaMailSettings,
  since: Date
): Promise<{ folders: PatrolFolderScan[]; candidates: PatrolCandidate[]; withoutAttachment: number }> {
  const cfg = buildScanConfig(settings);
  const keys = loadImportedPatrolKeys();
  const folders: PatrolFolderScan[] = [];
  const candidates: PatrolCandidate[] = [];
  let withoutAttachment = 0;

  for (const folder of cfg.patrolFolders) {
    const scan: PatrolFolderScan = { folder, scanned: 0, matched: 0 };
    try {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const found = ((await client.search({ since }, { uid: true })) || []) as number[];
        const uids = [...found].sort((a, b) => b - a).slice(0, PATROL_SCAN_MAX_PER_FOLDER);
        if (uids.length > 0) {
          for await (const message of client.fetch(
            uids.join(","),
            { envelope: true, bodyStructure: true, flags: true, internalDate: true },
            { uid: true }
          )) {
            scan.scanned++;
            const subject = message.envelope?.subject ?? "";
            const from = message.envelope?.from;
            const attachments = attachmentNamesFromStructure(
              message.bodyStructure as BodyStructureNode | undefined
            );
            const filtersOk =
              matchesSubjectFilter(subject, cfg.patrolPhrases) &&
              matchesFromFilter(from, cfg.patrolFrom);
            if (!filtersOk) continue;
            if (!matchesPatrolMessage({ subject, from, attachmentNames: attachments }, cfg)) {
              withoutAttachment++;
              continue;
            }
            scan.matched++;
            const messageId = message.envelope?.messageId ?? null;
            const rawDate = message.envelope?.date ?? message.internalDate ?? null;
            const date = rawDate ? new Date(rawDate) : null;
            candidates.push({
              folder,
              uid: message.uid,
              subject,
              from: formatFrom(from),
              date: date && !Number.isNaN(date.getTime()) ? date : null,
              attachments: attachments.filter(isPatrolAttachmentName),
              seen: message.flags?.has("\\Seen") ?? false,
              messageId,
              imported: isPatrolMessageImported(messageId, attachments, keys),
              cameraMatch:
                cfg.cameraEnabled &&
                cfg.cameraFolders.includes(folder) &&
                matchesSubjectFilter(subject, cfg.cameraPhrases) &&
                matchesFromFilter(from, cfg.cameraFrom),
            });
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      scan.error = describeMailError(error, "imap");
    }
    folders.push(scan);
  }

  candidates.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  return { folders, candidates, withoutAttachment };
}

function sinceDate(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * „Sprawdź skrzynkę” dla podjazdów: ile maili pasuje do filtrów (także
 * niezapisanych — `overrides`) i 10 ostatnich. Read-only: folder otwierany
 * w trybie EXAMINE, bez pobierania treści i bez oznaczania jako przeczytane.
 */
export async function previewPatrolMail(
  overrides: PatrolMailFilterOverrides = {}
): Promise<PatrolPreviewResult> {
  const saved = await getSettings();
  if (!saved.email || !saved.password) throw new Error(NO_CONFIG_ERROR);
  const settings = mergePatrolOverrides(saved, overrides);
  const days = clampLookbackDays(overrides.days ?? settings.patrolLookbackDays);
  const since = sinceDate(days);

  const client = createImapClient(settings);
  try {
    await client.connect();
    const { folders, candidates, withoutAttachment } = await scanPatrolCandidates(client, settings, since);
    return {
      days,
      since: since.toISOString(),
      folders,
      matched: candidates.length,
      alreadyImported: candidates.filter((c) => c.imported).length,
      withoutAttachment,
      messages: candidates.slice(0, 10).map((c) => ({
        folder: c.folder,
        uid: c.uid,
        subject: c.subject,
        from: c.from,
        date: c.date ? c.date.toISOString() : null,
        attachments: c.attachments,
        seen: c.seen,
        status: c.imported ? "imported" : !c.seen && settings.patrolEnabled ? "poller" : "fetch",
      })),
    };
  } catch (error) {
    throw new Error(describeMailError(error, "imap"));
  } finally {
    await closeImapClient(client);
  }
}

/**
 * „Pobierz teraz”: import wsteczny raportów z podjazdów z ostatnich `days`
 * dni (zapisane filtry podjazdów, przeczytane i nieprzeczytane). Już
 * zaimportowane (Message-ID / nazwa pliku) pomijamy bez pobierania; reszta
 * przez zwykły potok importu (dedup po hashu pliku zostaje). Nieprzeczytane
 * oznaczamy jako przeczytane, chyba że mail pasuje też do filtrów kamer.
 */
async function fetchPatrolMail(daysInput?: number): Promise<PatrolFetchResult> {
  const settings = await getSettings();
  if (!settings.email || !settings.password) throw new Error(NO_CONFIG_ERROR);
  const days = clampLookbackDays(daysInput ?? settings.patrolLookbackDays);
  const since = sinceDate(days);
  const summary: MailCheckSummary = {
    checked: 0,
    matched: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    patrol: emptyPatrolCounts(),
  };

  const client = createImapClient(settings);
  try {
    await client.connect();
  } catch (error) {
    const message = describeMailError(error, "imap");
    await updatePatrolLastCheck("error", message);
    await closeImapClient(client);
    throw new Error(message);
  }

  let folders: PatrolFolderScan[] = [];
  let alreadyImported = 0;
  try {
    const scan = await scanPatrolCandidates(client, settings, since);
    folders = scan.folders;
    // Najstarsze najpierw — kolejne raporty nadpisują zdarzenia nowszymi danymi.
    const todo = scan.candidates.filter((c) => !c.imported).reverse();
    alreadyImported = scan.candidates.length - todo.length;

    for (const folder of [...new Set(todo.map((c) => c.folder))]) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          for (const c of todo.filter((t) => t.folder === folder)) {
            summary.patrol.matched++;
            await processImportMessage(client, c.uid, c.subject, settings, summary, {
              camera: false,
              patrol: true,
            });
            if (!c.seen && !c.cameraMatch) {
              try {
                await client.messageFlagsAdd(String(c.uid), ["\\Seen"], { uid: true });
              } catch (error) {
                console.error(
                  `[cma-mail] Nie udało się oznaczyć wiadomości ${c.uid} jako przeczytanej:`,
                  error
                );
              }
            }
          }
        } finally {
          lock.release();
        }
      } catch (error) {
        const entry = folders.find((f) => f.folder === folder);
        if (entry) entry.error = describeMailError(error, "imap");
      }
    }
  } finally {
    await closeImapClient(client);
  }

  const errorParts = folders.filter((f) => f.error).map((f) => `Folder "${f.folder}": ${f.error}`);
  if (summary.patrol.errors > 0) errorParts.push(`Błędy importu podjazdów: ${summary.patrol.errors}`);
  await updatePatrolLastCheck(
    errorParts.length > 0 ? "error" : "ok",
    errorParts.length > 0 ? errorParts.join("; ") : null
  );

  return { days, folders, alreadyImported, ...summary.patrol };
}

let inFlightPatrolFetch: Promise<PatrolFetchResult> | null = null;

/** Import wsteczny podjazdów — jeden naraz, w kolejce ze zwykłym skanem skrzynki. */
export function fetchPatrolMailShared(days?: number): Promise<PatrolFetchResult> {
  if (inFlightPatrolFetch) return inFlightPatrolFetch;
  const run = runImapExclusive(() => fetchPatrolMail(days)).finally(() => {
    inFlightPatrolFetch = null;
  });
  inFlightPatrolFetch = run;
  return run;
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

/** Załącznik `raport_z_podjazdow_*.xlsx` — raport z podjazdów, nie raport kamer. */
export function isPatrolReportFileName(fileName: string): boolean {
  return /^raport_z_podjazd/i.test(fileName.trim());
}

/**
 * Import raportu z podjazdów z załącznika. `cma_mail_log.report_id` wskazuje
 * na `cma_reports`, więc id raportu podjazdów trafia tylko do `detail`.
 */
async function importPatrolForMessage(
  buffer: Buffer,
  fileName: string,
  messageId: string | null,
  uid: number,
  subject: string,
  summary: MailCheckSummary
): Promise<void> {
  try {
    const r = importPatrolReportBuffer(buffer, fileName, { source: "mail", mailMessageId: messageId });
    summary.imported++;
    summary.patrol.imported++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      fileName,
      status: "ok",
      detail: `Zaimportowano raport z podjazdów #${r.reportId}: ${r.eventsTotal} zdarzeń (${r.patrols} podjazdów; nowe ${r.eventsNew}, zaktualizowane ${r.eventsUpdated}).`,
    });
  } catch (error) {
    if (error instanceof PatrolDuplicateError) {
      summary.skipped++;
      summary.patrol.skipped++;
      await logMail({
        direction: "import",
        messageUid: uid,
        subject,
        fileName,
        status: "skipped",
        detail: `${error.message} (raport podjazdów #${error.existingId}).`,
      });
      return;
    }
    summary.errors++;
    summary.patrol.errors++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      fileName,
      status: "error",
      detail:
        error instanceof PatrolParseError
          ? `Raport z podjazdów: ${error.message}`
          : `Nie udało się zaimportować raportu z podjazdów: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function processImportMessage(
  client: ImapFlow,
  uid: number,
  subject: string,
  settings: CmaMailSettings,
  summary: MailCheckSummary,
  /** Które potoki obsługują ten mail (classifyScanMessage) — filtry kamer nie obejmują podjazdów. */
  scope: { camera: boolean; patrol: boolean }
): Promise<void> {
  let attachments: { filename: string; content: Buffer }[];
  // Raporty z podjazdów (docs/PODJAZDY-RAPORTY.md) — osobny parser, rozpoznawane po nazwie.
  let patrolAttachments: { filename: string; content: Buffer }[] = [];
  let messageId: string | null = null;
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
    const spreadsheets = (mail.attachments ?? [])
      .filter((att) => /\.(xls|xlsx)$/i.test(att.filename ?? ""))
      .map((att) => ({
        filename: att.filename!,
        content: att.content as Buffer,
      }));
    patrolAttachments = spreadsheets.filter((att) => isPatrolReportFileName(att.filename));
    attachments = spreadsheets.filter((att) => !isPatrolReportFileName(att.filename));
    messageId = mail.messageId ?? null;
    bodyHtml = typeof mail.html === "string" ? mail.html : null;
    bodyText = typeof mail.text === "string" ? mail.text : null;
  } catch (error) {
    summary.errors++;
    if (scope.patrol) summary.patrol.errors++;
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

  if (scope.patrol) {
    for (const attachment of patrolAttachments) {
      await importPatrolForMessage(attachment.content, attachment.filename, messageId, uid, subject, summary);
    }
  } else if (patrolAttachments.length > 0) {
    // Mail złapany filtrami kamer, ale nie filtrami podjazdów — nie importujemy go jako podjazdów.
    summary.skipped++;
    await logMail({
      direction: "import",
      messageUid: uid,
      subject,
      fileName: patrolAttachments.map((a) => a.filename).join(", "),
      status: "skipped",
      detail:
        "Raport z podjazdów pominięty: wiadomość nie pasuje do ustawień podjazdów (folder/temat/nadawca) albo ich import jest wyłączony.",
    });
  }

  if (!scope.camera) return;

  // Attachments take precedence; report links in the body are used
  // only when the message carries no XLS/XLSX attachment
  if (attachments.length === 0 && patrolAttachments.length > 0) return;
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
    // Funnel through the shared single-flight guard so a poll tick and a
    // manual /check-now cannot run overlapping IMAP scans.
    const summary = await checkMailboxShared();
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

  // Clear again AFTER the await, immediately before re-assigning. Two
  // interleaving saves both cleared to null before awaiting getSettings;
  // without this second clear the first-resumed call's interval would be
  // overwritten (leaked) by the second. Clearing here — with no await
  // before the setInterval assignments below — makes clear+set atomic on
  // the event loop.
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.schedulerTimer) {
    clearInterval(state.schedulerTimer);
    state.schedulerTimer = null;
  }

  // IMAP import poller — raporty kamer i/lub podjazdy (każdy potok ma swój włącznik)
  if ((settings.importEnabled || settings.patrolEnabled) && settings.email && settings.password) {
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
