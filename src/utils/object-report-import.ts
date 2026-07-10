import Database from "better-sqlite3";
import { db } from "../db/index.js";
import type { ObjectImport } from "../db/schema.js";
import {
  parseObjectReportCsv,
  ObjectReportParseError,
  type ParsedMonitoredObject,
} from "./object-report-csv.js";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

/** Thrown when the same report file was already imported. */
export class ObjectReportDuplicateError extends Error {
  existingId: number;
  existingImportedAt: string;

  constructor(existing: { id: number; fileName: string; importedAt: string }) {
    super(
      `Ten plik został już zaimportowany ${existing.importedAt} (${existing.fileName}).`
    );
    this.name = "ObjectReportDuplicateError";
    this.existingId = existing.id;
    this.existingImportedAt = existing.importedAt;
  }
}

// Pola porównywane przy imporcie; kolejność = kolejność kolumn raportu.
// Klucz pola -> kolumna w monitored_objects.
const FIELD_COLUMNS: Record<string, string> = {
  account: "account",
  category: "category",
  name: "name",
  identifier1: "identifier1",
  identifier2: "identifier2",
  identifier3: "identifier3",
  extraData1: "extra_data1",
  extraData2: "extra_data2",
  extraData3: "extra_data3",
  extraData4: "extra_data4",
  extraData5: "extra_data5",
  address: "address",
  street: "street",
  houseNumber: "house_number",
  postalCode: "postal_code",
  city: "city",
  latitude: "latitude",
  longitude: "longitude",
  locationDescription: "location_description",
  objectDescription: "object_description",
  phones: "phones",
  devices: "devices",
  defaultCrew: "default_crew",
  allCrews: "all_crews",
  groups: "groups",
  monitoringStart: "monitoring_start",
  monitoringEnd: "monitoring_end",
  objectStatus: "object_status",
  addedAt: "added_at",
  authorizedPersons: "authorized_persons",
  authorizedPhones: "authorized_phones",
  authorizedPasswords: "authorized_passwords",
  duressPasswords: "duress_passwords",
  dayArrivalTime: "day_arrival_time",
  nightArrivalTime: "night_arrival_time",
  relatedObjects: "related_objects",
  serviceTypes: "service_types",
  serviceMonitoringFrom: "service_monitoring_from",
  serviceMonitoringTo: "service_monitoring_to",
};

const FIELDS = Object.keys(FIELD_COLUMNS) as (keyof ParsedMonitoredObject)[];

type ExistingRow = { id: number; active: number } & Record<string, unknown>;

/**
 * Import dziennego raportu obiektów: upsert stanu po externalId + zapis
 * różnic do logu zmian (monitored_object_changes).
 *
 * - nowy obiekt          -> insert + wpis "created"
 * - zmienione pole       -> update + wpis "updated" na każde pole
 * - brak w raporcie      -> active=0 + wpis "removed"
 * - powrót do raportu    -> active=1 + wpis "restored"
 *
 * @throws ObjectReportParseError gdy pliku nie da się przetworzyć
 * @throws ObjectReportDuplicateError gdy plik o tej nazwie już zaimportowano
 */
export function importObjectReportBuffer(
  buffer: Buffer,
  fileName: string
): ObjectImport {
  let parsed;
  try {
    parsed = parseObjectReportCsv(buffer, fileName);
  } catch (error) {
    if (error instanceof ObjectReportParseError) throw error;
    throw new ObjectReportParseError(
      "Nie udało się przetworzyć pliku raportu obiektów."
    );
  }

  const duplicate = sqlite
    .prepare(
      `SELECT id, file_name AS fileName, imported_at AS importedAt
       FROM object_imports WHERE file_name = ? LIMIT 1`
    )
    .get(fileName) as
    | { id: number; fileName: string; importedAt: string }
    | undefined;
  if (duplicate) {
    throw new ObjectReportDuplicateError(duplicate);
  }

  const insertColumns = ["external_id", ...Object.values(FIELD_COLUMNS)];
  const insertObjectStmt = sqlite.prepare(`
    INSERT INTO monitored_objects (
      ${insertColumns.join(", ")}, active, first_import_id, last_import_id
    ) VALUES (${insertColumns.map(() => "?").join(", ")}, 1, ?, ?)
  `);
  const insertChangeStmt = sqlite.prepare(`
    INSERT INTO monitored_object_changes
      (object_id, import_id, change_type, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let importId: number;
  let newCount = 0;
  let changedCount = 0;
  let removedCount = 0;
  let restoredCount = 0;

  sqlite.exec("BEGIN TRANSACTION");
  try {
    const importInsert = sqlite
      .prepare(
        `INSERT INTO object_imports (file_name, total_count) VALUES (?, ?)`
      )
      .run(fileName, parsed.objects.length);
    importId = Number(importInsert.lastInsertRowid);

    const existingRows = sqlite
      .prepare(
        `SELECT id, external_id AS externalId, active,
          ${Object.entries(FIELD_COLUMNS)
            .map(([field, column]) => `${column} AS ${field}`)
            .join(", ")}
        FROM monitored_objects`
      )
      .all() as (ExistingRow & { externalId: number })[];
    const existingByExternalId = new Map(
      existingRows.map((row) => [row.externalId, row])
    );

    const seenIds = new Set<number>();

    for (const record of parsed.objects) {
      seenIds.add(record.externalId);
      const existing = existingByExternalId.get(record.externalId);

      if (!existing) {
        const insert = insertObjectStmt.run(
          record.externalId,
          ...FIELDS.map((field) => record[field]),
          importId,
          importId
        );
        insertChangeStmt.run(
          Number(insert.lastInsertRowid),
          importId,
          "created",
          null,
          null,
          record.name
        );
        newCount++;
        continue;
      }

      const changedFields = FIELDS.filter(
        (field) => (existing[field] ?? null) !== record[field]
      );
      const wasRemoved = existing.active === 0;

      if (changedFields.length === 0 && !wasRemoved) {
        sqlite
          .prepare(`UPDATE monitored_objects SET last_import_id = ? WHERE id = ?`)
          .run(importId, existing.id);
        continue;
      }

      if (wasRemoved) {
        insertChangeStmt.run(existing.id, importId, "restored", null, null, null);
        restoredCount++;
      }
      for (const field of changedFields) {
        insertChangeStmt.run(
          existing.id,
          importId,
          "updated",
          field,
          (existing[field] as string | null) ?? null,
          record[field]
        );
      }
      if (changedFields.length > 0) changedCount++;

      sqlite
        .prepare(
          `UPDATE monitored_objects SET
            ${changedFields.map((field) => `${FIELD_COLUMNS[field]} = ?`).join(", ")}${changedFields.length ? "," : ""}
            active = 1, last_import_id = ?, updated_at = datetime('now')
          WHERE id = ?`
        )
        .run(
          ...changedFields.map((field) => record[field]),
          importId,
          existing.id
        );
    }

    // Obiekty nieobecne w raporcie oznaczamy jako usunięte
    for (const row of existingRows) {
      if (seenIds.has(row.externalId) || row.active === 0) continue;
      sqlite
        .prepare(
          `UPDATE monitored_objects
           SET active = 0, updated_at = datetime('now') WHERE id = ?`
        )
        .run(row.id);
      insertChangeStmt.run(row.id, importId, "removed", null, null, null);
      removedCount++;
    }

    sqlite
      .prepare(
        `UPDATE object_imports SET new_count = ?, changed_count = ?,
         removed_count = ?, restored_count = ? WHERE id = ?`
      )
      .run(newCount, changedCount, removedCount, restoredCount, importId);

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }

  return sqlite
    .prepare(
      `SELECT id, file_name AS fileName, total_count AS totalCount,
        new_count AS newCount, changed_count AS changedCount,
        removed_count AS removedCount, restored_count AS restoredCount,
        imported_at AS importedAt
      FROM object_imports WHERE id = ?`
    )
    .get(importId) as ObjectImport;
}
