/**
 * Import raportu z podjazdów do bazy: dedup pliku po sha256, upsert zdarzeń po
 * `event_ref`, kroki zastępowane w całości, dopasowanie obiektu z kartoteki.
 * Konsumenci: POST /api/cma/podjazdy/import i skan IMAP (src/services/cma-mail.ts).
 * Kontrakt: docs/PODJAZDY-RAPORTY.md.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { parsePatrolReport, PatrolParseError, type ParsedPatrolEvent } from "../lib/patrol-report.js";
import type { DbOrTx } from "../lib/activity-log.js";

export { PatrolParseError };

/** Ten sam plik (identyczna treść) był już zaimportowany. */
export class PatrolDuplicateError extends Error {
  existingId: number;
  existingFileName: string;
  constructor(existing: { id: number; fileName: string }) {
    super(`Ten raport był już zaimportowany (${existing.fileName}).`);
    this.name = "PatrolDuplicateError";
    this.existingId = existing.id;
    this.existingFileName = existing.fileName;
  }
}

export interface PatrolImportResult {
  reportId: number;
  eventsTotal: number;
  eventsNew: number;
  eventsUpdated: number;
  /** Ile zdarzeń z pliku to podjazdy (has_patrol). */
  patrols: number;
}

export interface PatrolImportOptions {
  source: "mail" | "upload";
  mailMessageId?: string | null;
  /** Moment otrzymania (domyślnie teraz), ISO. */
  receivedAt?: string;
  /**
   * Pomija dedup po hashu pliku: identyczny plik jest przeliczany ponownie (upsert
   * zdarzeń), a istniejący wiersz `patrol_reports` zostaje użyty ponownie (hash jest
   * UNIQUE) — aktualizujemy tylko jego liczniki. Do przeliczenia po zmianie parsera.
   */
  force?: boolean;
}

/** lowercase, bez diakrytyków, bez wielokrotnych spacji. */
export function normalizeObjectName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ObjectIndex {
  /** znormalizowana nazwa → id obiektu (null = niejednoznaczna) */
  monitored: Map<string, number | null>;
  objects: Map<string, number | null>;
}

function addUnique(map: Map<string, number | null>, key: string, id: number) {
  if (!key) return;
  const prev = map.get(key);
  if (prev === undefined) map.set(key, id);
  else if (prev !== id) map.set(key, null);
}

/**
 * Indeks dopasowania. Najpierw rejestr monitoringu (`monitored_objects`) z jawnym
 * powiązaniem `object_id` — raport przychodzi z tego samego systemu, więc nazwy
 * są identyczne; potem nazwy z kartoteki `objects`. Niejednoznaczne → brak dopasowania.
 */
export function buildObjectIndex(dbx: DbOrTx = db): ObjectIndex {
  const monitored = new Map<string, number | null>();
  const objects = new Map<string, number | null>();
  for (const r of dbx
    .select({ name: schema.monitoredObjects.name, objectId: schema.monitoredObjects.objectId })
    .from(schema.monitoredObjects)
    .all()) {
    if (r.objectId) addUnique(monitored, normalizeObjectName(r.name), r.objectId);
  }
  for (const r of dbx.select({ id: schema.objects.id, name: schema.objects.name }).from(schema.objects).all()) {
    addUnique(objects, normalizeObjectName(r.name), r.id);
  }
  return { monitored, objects };
}

export function matchObject(index: ObjectIndex, name: string): number | null {
  const key = normalizeObjectName(name);
  const m = index.monitored.get(key);
  if (m) return m;
  return index.objects.get(key) ?? null;
}

function eventValues(e: ParsedPatrolEvent) {
  return {
    objectName: e.objectName,
    street: e.street,
    no: e.no,
    postal: e.postal,
    city: e.city,
    groups: e.groups,
    alarmText: e.alarmText,
    classification: e.classification,
    eventType: e.eventType,
    manual: e.manual,
    serviceType: e.serviceType,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    dayPart: e.dayPart,
    hasPatrol: e.hasPatrol,
    crew: e.crew,
    departedAt: e.departedAt,
    arrivedAt: e.arrivedAt,
    leftAt: e.leftAt,
    maxTravelMin: e.maxTravelMin,
    travelMin: e.travelMin,
    delayMin: e.delayMin,
    travelStatus: e.travelStatus,
    delayBucket: e.delayBucket,
    late: e.late,
    operator: e.operator,
    anomalies: JSON.stringify(e.anomalies),
    eventKind: e.eventKind,
    hintCrew: e.hintCrew,
    hintArrivedAt: e.hintArrivedAt,
    hintText: e.hintText,
  };
}

/** Moment otrzymania pliku — pełne ISO z „Z” (UTC), w odróżnieniu od lokalnych czasów zdarzeń. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parsuje i zapisuje raport w jednej transakcji.
 * @throws PatrolParseError — plik nie jest raportem z podjazdów
 * @throws PatrolDuplicateError — identyczny plik już był
 */
export function importPatrolReportBuffer(
  buffer: Buffer,
  fileName: string,
  opts: PatrolImportOptions
): PatrolImportResult {
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const existing = db
    .select({ id: schema.patrolReports.id, fileName: schema.patrolReports.fileName })
    .from(schema.patrolReports)
    .where(eq(schema.patrolReports.fileHash, fileHash))
    .get();
  if (existing && !opts.force) throw new PatrolDuplicateError(existing);

  const parsed = parsePatrolReport(buffer);

  return db.transaction((tx) => {
    const index = buildObjectIndex(tx);
    const report = existing
      ? (tx
          .update(schema.patrolReports)
          .set({ eventsTotal: parsed.events.length })
          .where(eq(schema.patrolReports.id, existing.id))
          .run(),
        { id: existing.id })
      : tx
          .insert(schema.patrolReports)
          .values({
            source: opts.source,
            fileName,
            fileHash,
            mailMessageId: opts.mailMessageId ?? null,
            receivedAt: opts.receivedAt ?? nowIso(),
            eventsTotal: parsed.events.length,
          })
          .returning({ id: schema.patrolReports.id })
          .get();

    let eventsNew = 0;
    let eventsUpdated = 0;
    for (const e of parsed.events) {
      const prev = tx
        .select({ id: schema.patrolEvents.id, objectId: schema.patrolEvents.objectId })
        .from(schema.patrolEvents)
        .where(eq(schema.patrolEvents.eventRef, e.eventRef))
        .get();
      let eventId: number;
      if (prev) {
        // Obiekt przypisany wcześniej (także ręcznie) zostaje — raport go nie zna.
        tx.update(schema.patrolEvents)
          .set({
            ...eventValues(e),
            reportId: report.id,
            objectId: prev.objectId ?? matchObject(index, e.objectName),
            updatedAt: sql`(datetime('now'))`,
          })
          .where(eq(schema.patrolEvents.id, prev.id))
          .run();
        tx.delete(schema.patrolEventSteps).where(eq(schema.patrolEventSteps.eventId, prev.id)).run();
        eventId = prev.id;
        eventsUpdated++;
      } else {
        eventId = tx
          .insert(schema.patrolEvents)
          .values({
            ...eventValues(e),
            eventRef: e.eventRef,
            reportId: report.id,
            objectId: matchObject(index, e.objectName),
          })
          .returning({ id: schema.patrolEvents.id })
          .get().id;
        eventsNew++;
      }
      if (e.steps.length) {
        tx.insert(schema.patrolEventSteps)
          .values(e.steps.map((s) => ({ ...s, eventId })))
          .run();
      }
    }

    // Przy `force` na istniejącym raporcie liczniki z pierwszego importu zostają (historia).
    if (!existing) {
      tx.update(schema.patrolReports)
        .set({ eventsNew, eventsUpdated })
        .where(eq(schema.patrolReports.id, report.id))
        .run();
    }

    return {
      reportId: report.id,
      eventsTotal: parsed.events.length,
      eventsNew,
      eventsUpdated,
      patrols: parsed.events.filter((e) => e.hasPatrol).length,
    };
  });
}
