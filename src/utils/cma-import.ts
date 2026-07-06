import Database from "better-sqlite3";
import { db, schema } from "../db/index.js";
import type { CmaReport } from "../db/schema.js";
import {
  parseCmaReportXls,
  CmaParseError,
  type ParsedCmaReport,
} from "./cma-xls.js";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

/**
 * Thrown when an imported report duplicates an existing one
 * (same date range or same file name).
 */
export class CmaDuplicateError extends Error {
  existingId: number;
  existingTitle: string;
  existingFileName: string;
  existingDateFrom: string | null;
  existingDateTo: string | null;

  constructor(existing: {
    id: number;
    title: string;
    fileName: string;
    dateFrom: string | null;
    dateTo: string | null;
  }) {
    super(
      `Ten raport już istnieje: ${existing.title} (${existing.dateFrom ?? "?"} – ${existing.dateTo ?? "?"})`
    );
    this.name = "CmaDuplicateError";
    this.existingId = existing.id;
    this.existingTitle = existing.title;
    this.existingFileName = existing.fileName;
    this.existingDateFrom = existing.dateFrom;
    this.existingDateTo = existing.dateTo;
  }
}

/**
 * Parse a CMA report file buffer and insert the report with all its
 * entries in a single transaction.
 *
 * Used by the POST /api/cma/reports/import endpoint and the IMAP
 * mail poller.
 *
 * @throws CmaParseError when the file cannot be parsed / contains no data
 * @throws CmaDuplicateError when a report with the same date range or
 *         the same file name already exists
 * @throws Error when the database insert fails
 */
export function importCmaReportBuffer(
  buffer: Buffer,
  fileName: string
): CmaReport {
  let parsed: ParsedCmaReport;
  try {
    parsed = parseCmaReportXls(buffer, fileName);
  } catch (error) {
    if (error instanceof CmaParseError) throw error;
    throw new CmaParseError("Nie udało się przetworzyć pliku raportu.");
  }

  // Dedup: same date range (null-safe) or same file name
  const duplicate = sqlite
    .prepare(
      `SELECT
        id,
        title,
        file_name AS fileName,
        date_from AS dateFrom,
        date_to AS dateTo
      FROM cma_reports
      WHERE (date_from IS ? AND date_to IS ?) OR file_name = ?
      LIMIT 1`
    )
    .get(parsed.dateFrom, parsed.dateTo, fileName) as
    | {
        id: number;
        title: string;
        fileName: string;
        dateFrom: string | null;
        dateTo: string | null;
      }
    | undefined;
  if (duplicate) {
    throw new CmaDuplicateError(duplicate);
  }

  let reportId: number;
  sqlite.exec("BEGIN TRANSACTION");
  try {
    const insertReportStmt = sqlite.prepare(`
      INSERT INTO cma_reports (file_name, title, date_from, date_to, entry_count, imported_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const reportInsert = insertReportStmt.run(
      fileName,
      parsed.title,
      parsed.dateFrom,
      parsed.dateTo,
      parsed.entries.length
    );
    reportId = Number(reportInsert.lastInsertRowid);

    const insertEntryStmt = sqlite.prepare(`
      INSERT INTO cma_report_entries (
        report_id, object_category, object_name, address,
        identifier1, identifier2, identifier3,
        generated_at, patrol_name, started_at, ended_at,
        end_type, description, video_device, video_channel, user_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const entry of parsed.entries) {
      insertEntryStmt.run(
        reportId,
        entry.objectCategory,
        entry.objectName,
        entry.address,
        entry.identifier1,
        entry.identifier2,
        entry.identifier3,
        entry.generatedAt,
        entry.patrolName,
        entry.startedAt,
        entry.endedAt,
        entry.endType,
        entry.description,
        entry.videoDevice,
        entry.videoChannel,
        entry.userName
      );
    }

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }

  const created = sqlite
    .prepare(
      `SELECT
        id,
        file_name AS fileName,
        title,
        date_from AS dateFrom,
        date_to AS dateTo,
        entry_count AS entryCount,
        imported_at AS importedAt
      FROM cma_reports WHERE id = ?`
    )
    .get(reportId) as CmaReport;

  return created;
}

export interface CameraIssueCamera {
  videoChannel: string | null;
  videoDevice: string | null;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface CameraIssueObject {
  objectName: string;
  address: string | null;
  totalCount: number;
  cameras: CameraIssueCamera[];
}

export interface CameraIssuesResult {
  classifications: { classification: string; count: number }[];
  classification: string;
  issues: CameraIssueObject[];
}

/**
 * Aggregate camera issues for a report based on "Klasyfikacja: X" lines
 * found in entry descriptions. Used by the camera-issues endpoint and
 * by the issues e-mail sender.
 */
export function getCameraIssuesForReport(
  reportId: number,
  classification?: string
): CameraIssuesResult {
  const selectedClassification = classification?.trim() || "Brak obrazu";

  const rows = sqlite
    .prepare(
      `SELECT
        object_name AS objectName,
        address,
        generated_at AS generatedAt,
        description,
        video_device AS videoDevice,
        video_channel AS videoChannel
      FROM cma_report_entries
      WHERE report_id = ? AND description LIKE '%Klasyfikacja:%'`
    )
    .all(reportId) as {
    objectName: string;
    address: string | null;
    generatedAt: string | null;
    description: string | null;
    videoDevice: string | null;
    videoChannel: string | null;
  }[];

  type ObjectAgg = {
    objectName: string;
    address: string | null;
    totalCount: number;
    cameras: Map<string, CameraIssueCamera>;
  };

  const classificationCounts = new Map<string, number>();
  const objects = new Map<string, ObjectAgg>();

  for (const row of rows) {
    const match = /Klasyfikacja:\s*(.+)/.exec(row.description ?? "");
    if (!match) continue;
    const rowClassification = match[1].trim();
    if (!rowClassification) continue;

    classificationCounts.set(
      rowClassification,
      (classificationCounts.get(rowClassification) ?? 0) + 1
    );

    if (rowClassification !== selectedClassification) continue;

    let obj = objects.get(row.objectName);
    if (!obj) {
      obj = {
        objectName: row.objectName,
        address: row.address,
        totalCount: 0,
        cameras: new Map(),
      };
      objects.set(row.objectName, obj);
    }
    obj.totalCount++;

    const cameraKey = row.videoChannel ?? "";
    let camera = obj.cameras.get(cameraKey);
    if (!camera) {
      camera = {
        videoChannel: row.videoChannel,
        videoDevice: row.videoDevice,
        count: 0,
        firstAt: row.generatedAt,
        lastAt: row.generatedAt,
      };
      obj.cameras.set(cameraKey, camera);
    }
    camera.count++;
    if (row.generatedAt) {
      if (!camera.firstAt || row.generatedAt < camera.firstAt) {
        camera.firstAt = row.generatedAt;
      }
      if (!camera.lastAt || row.generatedAt > camera.lastAt) {
        camera.lastAt = row.generatedAt;
      }
    }
  }

  const classifications = [...classificationCounts.entries()]
    .map(([classificationName, count]) => ({
      classification: classificationName,
      count,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.classification.localeCompare(b.classification, "pl")
    );

  const issues = [...objects.values()]
    .map((obj) => ({
      objectName: obj.objectName,
      address: obj.address,
      totalCount: obj.totalCount,
      cameras: [...obj.cameras.values()].sort(
        (a, b) =>
          b.count - a.count ||
          (a.videoChannel ?? "").localeCompare(b.videoChannel ?? "", "pl")
      ),
    }))
    .sort(
      (a, b) =>
        b.totalCount - a.totalCount ||
        a.objectName.localeCompare(b.objectName, "pl")
    );

  return {
    classifications,
    classification: selectedClassification,
    issues,
  };
}
