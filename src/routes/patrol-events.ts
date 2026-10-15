/**
 * Raporty z podjazdów — API `/api/cma/podjazdy` (klucz uprawnień `cma/podjazdy`).
 * Kontrakt: docs/PODJAZDY-RAPORTY.md (sekcja API). Import: src/utils/patrol-import.ts.
 *
 * Kolejność tras: stałe ścieżki (/reports, /mail-status, /import, /pick/objects)
 * PRZED /:id.
 */
import { Hono, type Context } from "hono";
import Database from "better-sqlite3";
import { asc, eq, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getUser } from "../middleware/auth.js";
import { ApiError } from "../lib/calendar-labels.js";
import { logActivity } from "../lib/activity-log.js";
import { resolveTermFor } from "../lib/intervention-terms.js";
import {
  importPatrolReportBuffer,
  PatrolDuplicateError,
  PatrolParseError,
} from "../utils/patrol-import.js";
import type {
  PatrolEventRow,
  PatrolEventDetail,
  PatrolEventStepDto,
  PatrolRelatedEventDto,
} from "../types/index.js";
import { PATROL_EVENT_KINDS, type PatrolEventKind } from "../db/schema.js";

const sqlite = (db as any).$client as Database.Database;
const app = new Hono();

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function handleError(c: Context, error: unknown, what: string) {
  if (error instanceof ApiError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`Błąd ${what}:`, error);
  return c.json({ success: false, error: `Błąd ${what}` }, 500);
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Nieprawidłowe id");
  return id;
}

function parseAnomalies(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const ROW_SELECT = `
  SELECT e.id, e.event_ref AS eventRef, e.report_id AS reportId, e.object_id AS objectId,
    e.object_name AS objectName, o.name AS linkedObjectName,
    e.street, e.no, e.postal, e.city, e.groups, e.alarm_text AS alarmText,
    e.classification, e.event_type AS eventType, e.manual, e.service_type AS serviceType,
    e.started_at AS startedAt, e.ended_at AS endedAt, e.day_part AS dayPart,
    e.has_patrol AS hasPatrol, e.crew, e.departed_at AS departedAt, e.arrived_at AS arrivedAt,
    e.left_at AS leftAt, e.max_travel_min AS maxTravelMin, e.travel_min AS travelMin,
    e.delay_min AS delayMin, e.travel_status AS travelStatus, e.delay_bucket AS delayBucket,
    e.late, e.operator, e.anomalies, e.intervention_id AS interventionId,
    e.event_kind AS eventKind, e.hint_crew AS hintCrew, e.hint_arrived_at AS hintArrivedAt,
    e.hint_text AS hintText, e.created_at AS createdAt, e.updated_at AS updatedAt
  FROM patrol_events e
  LEFT JOIN objects o ON o.id = e.object_id`;

function toRow(r: Record<string, unknown>): PatrolEventRow {
  return {
    ...(r as unknown as PatrolEventRow),
    manual: !!r.manual,
    hasPatrol: !!r.hasPatrol,
    late: !!r.late,
    anomalies: parseAnomalies(r.anomalies),
  };
}

const SORTS: Record<string, string> = {
  startedAt: "e.started_at",
  objectName: "lower(e.object_name)",
  crew: "lower(coalesce(e.crew, ''))",
  travelMin: "e.travel_min",
  delayMin: "e.delay_min",
  arrivedAt: "e.arrived_at",
  city: "lower(coalesce(e.city, ''))",
  operator: "lower(coalesce(e.operator, ''))",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_KINDS: PatrolEventKind[] = ["patrol", "patrol_hint"];

/**
 * `kind=` (lista po przecinku) → rodzaje. Brak `kind` → domyślnie patrol,patrol_hint;
 * zgodność wstecz: `withoutPatrol=1` bez `kind` = wszystkie rodzaje. `kind=all` = wszystkie.
 */
function parseKinds(raw: string, withoutPatrol: boolean): PatrolEventKind[] | null {
  if (!raw) return withoutPatrol ? null : DEFAULT_KINDS;
  if (raw === "all") return null;
  const kinds = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  const bad = kinds.filter((k) => !(PATROL_EVENT_KINDS as readonly string[]).includes(k));
  if (bad.length || !kinds.length) {
    throw new ApiError(400, `Nieprawidłowy rodzaj zdarzenia (${PATROL_EVENT_KINDS.join("|")})`);
  }
  return kinds as PatrolEventKind[];
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  try {
    const where: string[] = [];
    const params: unknown[] = [];

    const from = str(c.req.query("from"));
    const to = str(c.req.query("to"));
    if (from) {
      if (!DATE_RE.test(from)) throw new ApiError(400, "Nieprawidłowa data „od” (RRRR-MM-DD)");
      where.push("e.started_at >= ?");
      params.push(from);
    }
    if (to) {
      if (!DATE_RE.test(to)) throw new ApiError(400, "Nieprawidłowa data „do” (RRRR-MM-DD)");
      where.push("e.started_at < ?");
      params.push(`${to}T99`); // cały dzień „do” włącznie
    }
    // Rodzaj (`kind`) — filtr dokładany na końcu, żeby liczniki per kind liczyć bez niego.
    const kinds = parseKinds(str(c.req.query("kind")), c.req.query("withoutPatrol") === "1");

    const objectIdRaw = str(c.req.query("objectId"));
    if (objectIdRaw) {
      const objectId = Number(objectIdRaw);
      if (!Number.isInteger(objectId)) throw new ApiError(400, "Nieprawidłowe objectId");
      where.push("e.object_id = ?");
      params.push(objectId);
    }
    const crew = str(c.req.query("crew"));
    if (crew) {
      where.push("e.crew = ?");
      params.push(crew);
    }
    const status = str(c.req.query("status")) || "all";
    if (status === "late") where.push("e.late = 1");
    else if (status === "ontime") where.push("e.late = 0 AND e.has_patrol = 1");
    else if (status !== "all") throw new ApiError(400, "Nieprawidłowy status (all|late|ontime)");

    const matched = str(c.req.query("matched")) || "all";
    if (matched === "yes") where.push("e.object_id IS NOT NULL");
    else if (matched === "no") where.push("e.object_id IS NULL");
    else if (matched !== "all") throw new ApiError(400, "Nieprawidłowy filtr dopasowania (all|yes|no)");

    const q = str(c.req.query("q")).toLowerCase();
    if (q) {
      where.push(
        `(lower(e.object_name) LIKE ? OR lower(coalesce(e.alarm_text,'')) LIKE ? OR lower(coalesce(e.crew,'')) LIKE ?
          OR lower(coalesce(e.city,'')) LIKE ? OR e.event_ref LIKE ? OR lower(coalesce(o.name,'')) LIKE ?)`
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
    }

    // Liczniki per rodzaj: wszystkie filtry POZA `kind` (chipy pokazują, ile czeka w innych).
    const baseWhereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const baseParams = [...params];
    const kindRows = sqlite
      .prepare(
        `SELECT e.event_kind AS kind, count(*) AS n
         FROM patrol_events e LEFT JOIN objects o ON o.id = e.object_id ${baseWhereSql}
         GROUP BY e.event_kind`
      )
      .all(...baseParams) as { kind: PatrolEventKind; n: number }[];
    const byKind = Object.fromEntries(PATROL_EVENT_KINDS.map((k) => [k, 0])) as Record<PatrolEventKind, number>;
    for (const r of kindRows) if (r.kind in byKind) byKind[r.kind] = r.n;

    if (kinds) {
      where.push(`e.event_kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sortKey = str(c.req.query("sort")) || "startedAt";
    const sortCol = SORTS[sortKey];
    if (!sortCol) throw new ApiError(400, "Nieprawidłowe pole sortowania");
    const dir = str(c.req.query("dir")).toLowerCase() === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize")) || 50));

    const items = (
      sqlite
        .prepare(
          `${ROW_SELECT} ${whereSql} ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, e.id ${dir} LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[]
    ).map(toRow);

    const agg = sqlite
      .prepare(
        `SELECT count(*) AS total, coalesce(sum(e.late), 0) AS late,
           avg(CASE WHEN e.travel_min >= 0 THEN e.travel_min END) AS avgTravel
         FROM patrol_events e LEFT JOIN objects o ON o.id = e.object_id ${whereSql}`
      )
      .get(...params) as { total: number; late: number; avgTravel: number | null };
    const crews = sqlite
      .prepare(
        `SELECT e.crew AS crew, count(*) AS count
         FROM patrol_events e LEFT JOIN objects o ON o.id = e.object_id
         ${whereSql ? `${whereSql} AND` : "WHERE"} e.crew IS NOT NULL
         GROUP BY e.crew ORDER BY count DESC, e.crew`
      )
      .all(...params) as { crew: string; count: number }[];

    return c.json({
      success: true,
      data: {
        items,
        total: agg.total,
        stats: {
          count: agg.total,
          late: agg.late,
          avgTravelMin: agg.avgTravel === null ? null : Math.round(agg.avgTravel * 10) / 10,
          crews,
          byKind,
        },
      },
    });
  } catch (error) {
    return handleError(c, error, "pobierania podjazdów");
  }
});

// ---------------------------------------------------------------------------
// Importy, status poczty, upload
// ---------------------------------------------------------------------------

app.get("/reports", (c) => {
  const items = db
    .select()
    .from(schema.patrolReports)
    .orderBy(sql`${schema.patrolReports.id} desc`)
    .limit(100)
    .all();
  return c.json({ success: true, data: { items } });
});

app.get("/mail-status", (c) => {
  const settings = db
    .select({
      importEnabled: schema.cmaMailSettings.importEnabled,
      lastCheckAt: schema.cmaMailSettings.lastCheckAt,
      lastCheckStatus: schema.cmaMailSettings.lastCheckStatus,
      lastCheckError: schema.cmaMailSettings.lastCheckError,
    })
    .from(schema.cmaMailSettings)
    .where(eq(schema.cmaMailSettings.id, 1))
    .get();
  const recent = sqlite
    .prepare(
      `SELECT id, subject, file_name AS fileName, status, detail, created_at AS createdAt
       FROM cma_mail_log WHERE direction = 'import' AND file_name LIKE 'raport_z_podjazd%'
       ORDER BY id DESC LIMIT 10`
    )
    .all();
  const lastReport =
    db
      .select()
      .from(schema.patrolReports)
      .where(eq(schema.patrolReports.source, "mail"))
      .orderBy(sql`${schema.patrolReports.id} desc`)
      .limit(1)
      .get() ?? null;
  return c.json({
    success: true,
    data: {
      importEnabled: settings?.importEnabled ?? false,
      lastCheckAt: settings?.lastCheckAt ?? null,
      lastCheckStatus: settings?.lastCheckStatus ?? null,
      lastCheckError: settings?.lastCheckError ?? null,
      lastReport,
      recent,
    },
  });
});

app.post("/import", async (c) => {
  let file: File;
  try {
    const body = await c.req.parseBody();
    const uploaded = body["file"];
    if (!uploaded || typeof uploaded === "string") {
      return c.json({ success: false, error: "Brak pliku. Prześlij plik w polu „file”." }, 400);
    }
    file = uploaded as File;
  } catch {
    return c.json({ success: false, error: "Nieprawidłowe żądanie — oczekiwano multipart/form-data z polem „file”." }, 400);
  }
  const fileName = file.name || "raport_z_podjazdow.xlsx";
  if (!/\.(xlsx|xls)$/i.test(fileName)) {
    return c.json({ success: false, error: "Nieobsługiwany format pliku. Wymagany plik .xlsx." }, 400);
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = importPatrolReportBuffer(buffer, fileName, { source: "upload" });
    logActivity(db, {
      entityType: "patrol_report",
      entityId: result.reportId,
      user: getUser(c),
      action: "created",
      summary: `Wgrano raport z podjazdów ${fileName} (${result.eventsTotal} zdarzeń, ${result.patrols} podjazdów)`,
    });
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    if (error instanceof PatrolDuplicateError) {
      return c.json({ success: false, error: error.message, data: { reportId: error.existingId } }, 409);
    }
    if (error instanceof PatrolParseError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    return handleError(c, error, "importu raportu z podjazdów");
  }
});

// Picker obiektów do ręcznego przypisania (własny — uprawnienia są per zakładka).
app.get("/pick/objects", (c) => {
  const q = str(c.req.query("q")).toLowerCase();
  const rows = db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      contractorName: schema.contractors.name,
    })
    .from(schema.objects)
    .leftJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .where(
      q
        ? or(
            sql`lower(${schema.objects.name}) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.objects.address}, '')) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.objects.city}, '')) like ${"%" + q + "%"}`,
            sql`lower(coalesce(${schema.contractors.name}, '')) like ${"%" + q + "%"}`
          )
        : undefined
    )
    .orderBy(asc(sql`lower(${schema.objects.name})`))
    .limit(30)
    .all();
  return c.json({ success: true, data: { items: rows } });
});

// ---------------------------------------------------------------------------
// Szczegóły, przypisanie obiektu, rozliczenie
// ---------------------------------------------------------------------------

function loadDetail(id: number): PatrolEventDetail | null {
  const r = sqlite.prepare(`${ROW_SELECT} WHERE e.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const row = toRow(r);
  const steps = sqlite
    .prepare(
      `SELECT id, at, text, operator, kind, seq FROM patrol_event_steps WHERE event_id = ? ORDER BY seq`
    )
    .all(id) as PatrolEventStepDto[];
  const report = row.reportId
    ? ((sqlite
        .prepare(`SELECT id, file_name AS fileName, received_at AS receivedAt, source FROM patrol_reports WHERE id = ?`)
        .get(row.reportId) as PatrolEventDetail["report"]) ?? null)
    : null;
  return {
    ...row,
    steps,
    report,
    object: row.objectId ? { id: row.objectId, name: row.linkedObjectName ?? "" } : null,
    related: loadRelated(row),
  };
}

const RELATED_WINDOW_MIN = 90;
const RELATED_LIMIT = 30;

/**
 * Inne zdarzenia na tym samym obiekcie ±90 min od startu (burze alarmów: jeden
 * incydent rozbity na wiele zdarzeń). Ten sam `object_id`, a gdy NULL — ta sama
 * `object_name`. Bez samego siebie, max 30, najbliższe czasowo pierwsze.
 */
function loadRelated(row: PatrolEventRow): PatrolRelatedEventDto[] {
  if (!row.startedAt) return [];
  const sameObject = row.objectId !== null ? "e.object_id = ?" : "e.object_id IS NULL AND e.object_name = ?";
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.event_ref AS eventRef, e.started_at AS startedAt, e.ended_at AS endedAt,
         e.event_type AS eventType, e.event_kind AS eventKind, e.has_patrol AS hasPatrol,
         e.alarm_text AS alarmText,
         (SELECT count(*) FROM patrol_event_steps s WHERE s.event_id = e.id) AS stepsCount,
         round((julianday(e.started_at) - julianday(?)) * 1440) AS offsetMin
       FROM patrol_events e
       WHERE ${sameObject} AND e.id <> ? AND e.started_at IS NOT NULL
         AND abs(julianday(e.started_at) - julianday(?)) * 1440 <= ?
       ORDER BY abs(julianday(e.started_at) - julianday(?)), e.started_at, e.id
       LIMIT ?`
    )
    .all(
      row.startedAt,
      row.objectId ?? row.objectName,
      row.id,
      row.startedAt,
      RELATED_WINDOW_MIN,
      row.startedAt,
      RELATED_LIMIT
    ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as PatrolRelatedEventDto),
    hasPatrol: !!r.hasPatrol,
    offsetMin: r.offsetMin === null ? null : Number(r.offsetMin),
  }));
}

app.get("/:id", (c) => {
  try {
    const detail = loadDetail(idParam(c));
    if (!detail) throw new ApiError(404, "Zdarzenie nie istnieje");
    return c.json({ success: true, data: detail });
  } catch (error) {
    return handleError(c, error, "pobierania podjazdu");
  }
});

app.patch("/:id", async (c) => {
  try {
    const id = idParam(c);
    const before = db.select().from(schema.patrolEvents).where(eq(schema.patrolEvents.id, id)).get();
    if (!before) throw new ApiError(404, "Zdarzenie nie istnieje");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError(400, "Nieprawidłowe dane");
    }
    if (!("objectId" in body)) throw new ApiError(400, "Brak pola objectId");
    let objectId: number | null = null;
    if (body.objectId !== null && body.objectId !== "") {
      objectId = Number(body.objectId);
      if (!Number.isInteger(objectId) || objectId <= 0) throw new ApiError(400, "Nieprawidłowe objectId");
      const obj = db.select({ id: schema.objects.id }).from(schema.objects).where(eq(schema.objects.id, objectId)).get();
      if (!obj) throw new ApiError(400, "Nie ma takiego obiektu");
    }
    if (before.interventionId && objectId !== before.objectId) {
      throw new ApiError(409, "Podjazd ma już rozliczenie — zmiana obiektu niemożliwa");
    }
    db.update(schema.patrolEvents)
      .set({ objectId, updatedAt: sql`(datetime('now'))` })
      .where(eq(schema.patrolEvents.id, id))
      .run();
    return c.json({ success: true, data: loadDetail(id) });
  } catch (error) {
    return handleError(c, error, "przypisywania obiektu");
  }
});

app.post("/:id/intervention", (c) => {
  try {
    const id = idParam(c);
    const ev = db.select().from(schema.patrolEvents).where(eq(schema.patrolEvents.id, id)).get();
    if (!ev) throw new ApiError(404, "Zdarzenie nie istnieje");
    if (!ev.hasPatrol) throw new ApiError(400, "To zdarzenie nie było podjazdem");
    if (ev.interventionId) {
      const exists = db
        .select({ id: schema.interventions.id })
        .from(schema.interventions)
        .where(eq(schema.interventions.id, ev.interventionId))
        .get();
      if (exists) throw new ApiError(409, "Rozliczenie tego podjazdu już istnieje");
    }
    if (!ev.objectId) throw new ApiError(400, "Najpierw przypisz obiekt z kartoteki");
    const when = ev.arrivedAt ?? ev.startedAt;
    if (!when) throw new ApiError(400, "Zdarzenie nie ma daty — nie da się go rozliczyć");
    const happenedAt = when.slice(0, 16);
    const term = resolveTermFor(ev.objectId, happenedAt.slice(0, 10));
    if (!term) {
      throw new ApiError(400, "Obiekt nie ma warunków grupy interwencyjnej obowiązujących w tym dniu");
    }
    const notes = [
      ev.crew ? `Patrol: ${ev.crew}` : null,
      `Zdarzenie monitoringu nr ${ev.eventRef}`,
      ev.travelMin !== null ? `Czas dojazdu: ${ev.travelMin} min${ev.maxTravelMin !== null ? ` (limit ${ev.maxTravelMin} min)` : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const user = getUser(c);
    const created = db.transaction((tx) => {
      const row = tx
        .insert(schema.interventions)
        .values({
          objectId: ev.objectId!,
          termId: term.id,
          companyId: term.companyId,
          happenedAt,
          reason: ev.alarmText ? ev.alarmText.slice(0, 500) : null,
          reportedBy: ev.operator ? ev.operator.slice(0, 200) : null,
          standbyHours: null,
          notes,
        })
        .returning()
        .get();
      tx.update(schema.patrolEvents)
        .set({ interventionId: row.id, updatedAt: sql`(datetime('now'))` })
        .where(eq(schema.patrolEvents.id, id))
        .run();
      logActivity(tx, {
        entityType: "intervention",
        entityId: row.id,
        objectId: row.objectId,
        user,
        action: "created",
        summary: `Zarejestrowano interwencję z raportu podjazdów (${row.happenedAt.replace("T", ", godz. ")})`,
      });
      return row;
    });
    return c.json({ success: true, data: { interventionId: created.id, event: loadDetail(id) } }, 201);
  } catch (error) {
    return handleError(c, error, "tworzenia rozliczenia");
  }
});

export default app;
