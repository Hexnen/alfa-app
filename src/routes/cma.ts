import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, and, sql, desc, asc, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import Database from "better-sqlite3";
import { CmaParseError } from "../utils/cma-xls.js";
import {
  importCmaReportBuffer,
  getCameraIssuesForReport,
  CmaDuplicateError,
} from "../utils/cma-import.js";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

const app = new Hono();

// Import CMA report from XLS/XLSX file (multipart/form-data, field "file")
app.post("/reports/import", async (c) => {
  let file: File;
  try {
    const body = await c.req.parseBody();
    const uploaded = body["file"];
    if (!uploaded || typeof uploaded === "string") {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Brak pliku. Prześlij plik w polu \"file\"." },
        400
      );
    }
    file = uploaded as File;
  } catch {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowe żądanie - oczekiwano multipart/form-data z polem \"file\"." },
      400
    );
  }

  const fileName = file.name || "raport.xls";
  if (!/\.(xls|xlsx)$/i.test(fileName)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieobsługiwany format pliku. Wymagany plik .xls lub .xlsx." },
      400
    );
  }

  let created;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    created = importCmaReportBuffer(buffer, fileName);
  } catch (error) {
    if (error instanceof CmaDuplicateError) {
      return c.json<ApiResponse<null>>(
        { success: false, error: error.message },
        409
      );
    }
    if (error instanceof CmaParseError) {
      return c.json<ApiResponse<null>>(
        { success: false, error: error.message },
        400
      );
    }
    console.error("Error importing CMA report:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się zapisać raportu w bazie danych." },
      500
    );
  }

  return c.json<ApiResponse<typeof created>>(
    {
      success: true,
      data: created,
      message: `Zaimportowano raport (${created.entryCount} wpisów)`,
    },
    201
  );
});

/**
 * Sortowanie listy raportów CMA. Daty trzymamy jako tekst „YYYY-MM-DD HH:MM:SS",
 * więc porządek leksykalny jest jednocześnie chronologiczny — nie trzeba niczego rzutować.
 * Tytuł i nazwę pliku porównujemy po `lower()`, żeby wielkość liter nie rozbijała alfabetu
 * (ten sam wzorzec, co SORT_COLUMNS w routes/contractors.ts i routes/contracts.ts).
 */
const REPORT_SORT_COLUMNS = {
  title: sql`lower(${schema.cmaReports.title})`,
  fileName: sql`lower(${schema.cmaReports.fileName})`,
  dateFrom: sql`${schema.cmaReports.dateFrom}`,
  dateTo: sql`${schema.cmaReports.dateTo}`,
  entryCount: sql`${schema.cmaReports.entryCount}`,
  importedAt: sql`${schema.cmaReports.importedAt}`,
} as const;

export type CmaReportSortKey = keyof typeof REPORT_SORT_COLUMNS;

function isReportSortKey(v: string): v is CmaReportSortKey {
  return Object.prototype.hasOwnProperty.call(REPORT_SORT_COLUMNS, v);
}

/** Liczba z query stringa; puste/śmieci → undefined (filtr się nie nakłada). */
function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data „YYYY-MM-DD" z query stringa; cokolwiek innego → undefined (filtr się nie nakłada). */
function dateParam(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return undefined;
  return raw.trim();
}

// List reports (paginated, newest imports first)
app.get("/reports", async (c) => {
  const search = c.req.query("search");
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const offset = (page - 1) * pageSize;
  // Zakres dat raportu, nie importu: „obejmuje przedział od–do".
  const dateFrom = dateParam(c.req.query("dateFrom"));
  const dateTo = dateParam(c.req.query("dateTo"));
  // Widełki liczby zdarzeń w raporcie.
  const minEntries = numberParam(c.req.query("minEntries"));
  const maxEntries = numberParam(c.req.query("maxEntries"));
  const sortRaw = c.req.query("sort") || "importedAt";
  const sort: CmaReportSortKey = isReportSortKey(sortRaw) ? sortRaw : "importedAt";
  // Domyślnie NAJNOWSZE importy na górze — dlatego tu (w odróżnieniu od list
  // alfabetycznych) brak parametru znaczy „desc", a nie „asc".
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";

  // Warunki do tablicy i jedno `and(...)`: kolejne `.where()` w drizzle nadpisuje
  // poprzednie, więc szukajka razem z widełkami filtrowałaby tylko po ostatnim.
  const conditions: SQL[] = [];
  if (search) {
    conditions.push(
      or(
        like(schema.cmaReports.fileName, `%${search}%`),
        like(schema.cmaReports.title, `%${search}%`)
      )!
    );
  }
  // Raport ZACHODZI na podany przedział (ten sam wzorzec, co okres umowy w
  // routes/contracts.ts): ten sam dzień w obu polach = „raport obejmujący dzień X",
  // samo drugie pole = „zaczęte do dnia X". Daty raportu niosą też godzinę, więc
  // porównujemy same dni (`substr(...,1,10)`) — inaczej raport z 08:00 wypadałby
  // z filtru ustawionego na jego własny dzień. Brak daty w raporcie (plik bez
  // nagłówka) traktujemy jak okres otwarty, żeby taki raport nie znikał z listy.
  if (dateFrom !== undefined) {
    conditions.push(
      sql`(${schema.cmaReports.dateTo} is null or substr(${schema.cmaReports.dateTo}, 1, 10) >= ${dateFrom})`
    );
  }
  if (dateTo !== undefined) {
    conditions.push(
      sql`(${schema.cmaReports.dateFrom} is null or substr(${schema.cmaReports.dateFrom}, 1, 10) <= ${dateTo})`
    );
  }
  // `entryCount` jest NOT NULL z domyślnym 0, więc widełki nie potrzebują bramki na puste.
  if (minEntries !== undefined) {
    conditions.push(sql`${schema.cmaReports.entryCount} >= ${minEntries}`);
  }
  if (maxEntries !== undefined) {
    conditions.push(sql`${schema.cmaReports.entryCount} <= ${maxEntries}`);
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Raporty bez zakresu dat na koniec listy w OBU kierunkach — inaczej sortowanie
  // rosnąco po dacie zaczynałoby się od pozycji, o których nic nie wiadomo.
  const NULLS_LAST: Partial<Record<CmaReportSortKey, SQL>> = {
    dateFrom: sql`case when ${schema.cmaReports.dateFrom} is null then 1 else 0 end`,
    dateTo: sql`case when ${schema.cmaReports.dateTo} is null then 1 else 0 end`,
  };
  const column = REPORT_SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  // Tie-break po id malejąco: id rośnie z każdym importem, więc przy równym kluczu
  // (np. dwa raporty wgrane w tej samej sekundzie) na górze jest ten nowszy —
  // dokładnie tak, jak lista zachowywała się przed dodaniem sortowania.
  const idTieBreak = desc(schema.cmaReports.id);
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, direction(column), idTieBreak]
    : [direction(column), idTieBreak];

  const results = await db
    .select()
    .from(schema.cmaReports)
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // Licznik MUSI respektować TE SAME filtry — inaczej paginacja pokazuje złe „total".
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.cmaReports)
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

// Get report with statistics
app.get("/reports/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator raportu" },
      400
    );
  }

  const report = await db
    .select()
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, id))
    .limit(1);

  if (report.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono raportu" },
      404
    );
  }

  const totals = sqlite
    .prepare(
      `SELECT
        count(*) AS entryCount,
        count(DISTINCT object_name) AS objectCount,
        count(DISTINCT user_name) AS userCount,
        count(user_name) AS operatorHandled
      FROM cma_report_entries
      WHERE report_id = ?`
    )
    .get(id) as {
    entryCount: number;
    objectCount: number;
    userCount: number;
    operatorHandled: number;
  };

  const byEndType = sqlite
    .prepare(
      `SELECT end_type AS endType, count(*) AS count
      FROM cma_report_entries
      WHERE report_id = ?
      GROUP BY end_type
      ORDER BY count DESC`
    )
    .all(id) as { endType: string | null; count: number }[];

  const byObject = sqlite
    .prepare(
      `SELECT object_name AS objectName, count(*) AS count
      FROM cma_report_entries
      WHERE report_id = ?
      GROUP BY object_name
      ORDER BY count DESC`
    )
    .all(id) as { objectName: string; count: number }[];

  const byUser = sqlite
    .prepare(
      `SELECT user_name AS userName, count(*) AS count
      FROM cma_report_entries
      WHERE report_id = ? AND user_name IS NOT NULL
      GROUP BY user_name
      ORDER BY count DESC`
    )
    .all(id) as { userName: string; count: number }[];

  return c.json({
    success: true,
    data: {
      report: report[0],
      stats: {
        entryCount: totals.entryCount,
        objectCount: totals.objectCount,
        userCount: totals.userCount,
        operatorHandled: totals.operatorHandled,
        byEndType,
        byObject,
        byUser,
      },
    },
  });
});

/**
 * Sortowanie listy zdarzeń w raporcie. Czasy trzymamy jako tekst „YYYY-MM-DD HH:MM:SS”,
 * więc porządek leksykalny jest jednocześnie chronologiczny. Teksty porównujemy po
 * `lower()`, żeby wielkość liter nie rozbijała alfabetu (ten sam wzorzec, co
 * REPORT_SORT_COLUMNS wyżej i SORT_COLUMNS w routes/contractors.ts).
 */
const ENTRY_SORT_COLUMNS = {
  generatedAt: sql`${schema.cmaReportEntries.generatedAt}`,
  objectName: sql`lower(${schema.cmaReportEntries.objectName})`,
  patrolName: sql`lower(${schema.cmaReportEntries.patrolName})`,
  endType: sql`lower(${schema.cmaReportEntries.endType})`,
  userName: sql`lower(${schema.cmaReportEntries.userName})`,
  videoChannel: sql`lower(${schema.cmaReportEntries.videoChannel})`,
  // Czas obchodu: wpis niesie start i koniec obchodu, z którego pochodzi zdarzenie.
  startedAt: sql`${schema.cmaReportEntries.startedAt}`,
  endedAt: sql`${schema.cmaReportEntries.endedAt}`,
} as const;

export type CmaEntrySortKey = keyof typeof ENTRY_SORT_COLUMNS;

function isEntrySortKey(v: string): v is CmaEntrySortKey {
  return Object.prototype.hasOwnProperty.call(ENTRY_SORT_COLUMNS, v);
}

/**
 * Puste wartości (NULL albo pusty tekst — XLS daje raz jedno, raz drugie) na koniec
 * listy w OBU kierunkach: sortowanie rosnąco po operatorze nie może zaczynać się od
 * kilku tysięcy zdarzeń zamkniętych automatycznie.
 */
function blankLast(column: SQL): SQL {
  return sql`case when ${column} is null or ${column} = '' then 1 else 0 end`;
}

/** Filtr „konkretna wartość albo puste" — puste (NULL/'') pod umownym „__none__". */
function blankOrEqual(column: SQL, value: string): SQL {
  return value === "__none__"
    ? sql`(${column} is null or ${column} = '')`
    : sql`${column} = ${value}`;
}

// List report entries (paginated, with filters)
app.get("/reports/:id/entries", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator raportu" },
      400
    );
  }

  const report = await db
    .select()
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, id))
    .limit(1);

  if (report.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono raportu" },
      404
    );
  }

  const search = c.req.query("search");
  const objectName = c.req.query("objectName");
  const endType = c.req.query("endType");
  const userName = c.req.query("userName");
  const videoChannel = c.req.query("videoChannel");
  // „Kto zamknął zdarzenie": operator = wpis ma nazwisko w user_name (to samo
  // kryterium, co licznik `operatorHandled` w GET /reports/:id), auto = nie ma.
  const handledRaw = c.req.query("handled");
  const handled =
    handledRaw === "operator" || handledRaw === "auto" ? handledRaw : undefined;
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(
    500,
    Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50)
  );
  const offset = (page - 1) * pageSize;
  const sortRaw = c.req.query("sort") || "generatedAt";
  const sort: CmaEntrySortKey = isEntrySortKey(sortRaw)
    ? sortRaw
    : "generatedAt";
  // Domyślnie chronologicznie — dokładnie tak, jak lista wyglądała przed dodaniem
  // sortowania (ORDER BY generated_at ASC, id ASC).
  const dir = c.req.query("dir") === "desc" ? "desc" : "asc";

  const conditions: SQL[] = [eq(schema.cmaReportEntries.reportId, id)];

  if (search) {
    conditions.push(
      or(
        like(schema.cmaReportEntries.objectName, `%${search}%`),
        like(schema.cmaReportEntries.address, `%${search}%`),
        like(schema.cmaReportEntries.patrolName, `%${search}%`),
        like(schema.cmaReportEntries.description, `%${search}%`),
        like(schema.cmaReportEntries.videoChannel, `%${search}%`),
        like(schema.cmaReportEntries.userName, `%${search}%`)
      )!
    );
  }

  if (objectName) {
    conditions.push(eq(schema.cmaReportEntries.objectName, objectName));
  }

  if (endType) {
    conditions.push(
      endType === "__none__"
        ? isNull(schema.cmaReportEntries.endType)
        : eq(schema.cmaReportEntries.endType, endType)
    );
  }

  if (userName) {
    conditions.push(
      blankOrEqual(sql`${schema.cmaReportEntries.userName}`, userName)
    );
  }

  // Filtr kanału nakładamy osobno, bo lista kanałów do selecta (`channels` niżej)
  // liczy się z pominięciem właśnie tego warunku — inaczej po wybraniu kanału
  // select zostawałby z jedną pozycją i nie dało się go zmienić.
  const channelCondition = videoChannel
    ? blankOrEqual(sql`${schema.cmaReportEntries.videoChannel}`, videoChannel)
    : undefined;

  if (handled) {
    conditions.push(
      handled === "operator"
        ? sql`(${schema.cmaReportEntries.userName} is not null and ${schema.cmaReportEntries.userName} <> '')`
        : sql`(${schema.cmaReportEntries.userName} is null or ${schema.cmaReportEntries.userName} = '')`
    );
  }

  const whereClause = and(
    ...conditions,
    ...(channelCondition ? [channelCondition] : [])
  );

  const NULLS_LAST: Partial<Record<CmaEntrySortKey, SQL>> = {
    generatedAt: blankLast(sql`${schema.cmaReportEntries.generatedAt}`),
    patrolName: blankLast(sql`${schema.cmaReportEntries.patrolName}`),
    endType: blankLast(sql`${schema.cmaReportEntries.endType}`),
    userName: blankLast(sql`${schema.cmaReportEntries.userName}`),
    videoChannel: blankLast(sql`${schema.cmaReportEntries.videoChannel}`),
    startedAt: blankLast(sql`${schema.cmaReportEntries.startedAt}`),
    endedAt: blankLast(sql`${schema.cmaReportEntries.endedAt}`),
  };
  const column = ENTRY_SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  // Tie-break po id rosnąco: id rośnie w kolejności wierszy z pliku, więc zdarzenia
  // o tym samym kluczu (np. ta sama sekunda) trzymają kolejność z raportu i strony
  // paginacji się nie przeplatają.
  const idTieBreak = asc(schema.cmaReportEntries.id);
  const orderBy = NULLS_LAST[sort]
    ? [NULLS_LAST[sort]!, direction(column), idTieBreak]
    : [direction(column), idTieBreak];

  const results = await db
    .select()
    .from(schema.cmaReportEntries)
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // Licznik MUSI respektować TE SAME filtry — inaczej paginacja pokazuje złe „total".
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.cmaReportEntries)
    .where(whereClause);
  const total = countResult[0].count;

  // Wartości do selecta kanałów: kanałów w raporcie są setki, więc lista zawęża się
  // razem z pozostałymi filtrami (np. po wybraniu obiektu zostają jego kanały).
  const channelRows = await db
    .selectDistinct({ videoChannel: schema.cmaReportEntries.videoChannel })
    .from(schema.cmaReportEntries)
    .where(and(...conditions))
    .orderBy(asc(sql`lower(${schema.cmaReportEntries.videoChannel})`));
  const channels = channelRows
    .map((row) => row.videoChannel)
    .filter((value): value is string => value !== null && value !== "");

  return c.json({
    success: true,
    data: results,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
    channels,
  });
});

// Camera issues per object, based on "Klasyfikacja: X" lines in entry descriptions
app.get("/reports/:id/camera-issues", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator raportu" },
      400
    );
  }

  const report = await db
    .select()
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, id))
    .limit(1);

  if (report.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono raportu" },
      404
    );
  }

  const result = getCameraIssuesForReport(id, c.req.query("classification"));

  return c.json({
    success: true,
    data: result,
  });
});

// Trend dashboard across all imported reports.
// Aggregated fully in SQL - entries table holds tens of thousands of rows.
app.get("/trends", async (c) => {
  const NO_IMAGE_PATTERN = "%Klasyfikacja: Brak obrazu%";

  try {
    const reportCountRow = sqlite
      .prepare(`SELECT count(*) AS count FROM cma_reports`)
      .get() as { count: number };

    const entryTotalRow = sqlite
      .prepare(`SELECT count(*) AS count FROM cma_report_entries`)
      .get() as { count: number };

    const rangeRow = sqlite
      .prepare(
        `SELECT
          min(substr(generated_at, 1, 10)) AS fromDate,
          max(substr(generated_at, 1, 10)) AS toDate
        FROM cma_report_entries
        WHERE generated_at IS NOT NULL`
      )
      .get() as { fromDate: string | null; toDate: string | null };

    // Only days that actually have entries - gaps in the data stay gaps,
    // the frontend must not interpolate across them.
    const perDay = sqlite
      .prepare(
        `SELECT
          substr(generated_at, 1, 10) AS date,
          count(*) AS entries,
          sum(CASE WHEN description LIKE ? THEN 1 ELSE 0 END) AS noImage,
          count(DISTINCT CASE WHEN description LIKE ?
            THEN object_name END) AS noImageObjects,
          count(DISTINCT CASE WHEN description LIKE ?
            THEN object_name || '|' || coalesce(video_channel, '') END)
            AS noImageCameras,
          count(user_name) AS operatorHandled
        FROM cma_report_entries
        WHERE generated_at IS NOT NULL
        GROUP BY date
        ORDER BY date ASC`
      )
      .all(NO_IMAGE_PATTERN, NO_IMAGE_PATTERN, NO_IMAGE_PATTERN) as {
      date: string;
      entries: number;
      noImage: number;
      noImageObjects: number;
      noImageCameras: number;
      operatorHandled: number;
    }[];

    const topObjects = sqlite
      .prepare(
        `SELECT
          object_name AS objectName,
          sum(CASE WHEN description LIKE ? THEN 1 ELSE 0 END) AS noImage,
          count(*) AS entries
        FROM cma_report_entries
        GROUP BY object_name
        HAVING noImage > 0
        ORDER BY noImage DESC, entries DESC, objectName ASC
        LIMIT 15`
      )
      .all(NO_IMAGE_PATTERN) as {
      objectName: string;
      noImage: number;
      entries: number;
    }[];

    const topCameras = sqlite
      .prepare(
        `SELECT
          object_name AS objectName,
          video_channel AS videoChannel,
          count(*) AS noImage,
          min(substr(generated_at, 1, 10)) AS firstDate,
          max(substr(generated_at, 1, 10)) AS lastDate
        FROM cma_report_entries
        WHERE description LIKE ?
        GROUP BY object_name, video_channel
        ORDER BY noImage DESC, objectName ASC
        LIMIT 15`
      )
      .all(NO_IMAGE_PATTERN) as {
      objectName: string;
      videoChannel: string | null;
      noImage: number;
      firstDate: string | null;
      lastDate: string | null;
    }[];

    return c.json({
      success: true,
      data: {
        range: { from: rangeRow.fromDate, to: rangeRow.toDate },
        reportCount: reportCountRow.count,
        entryCountTotal: entryTotalRow.count,
        perDay,
        topObjects,
        topCameras,
      },
    });
  } catch (error) {
    console.error("Error building CMA trends:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się przygotować danych trendów." },
      500
    );
  }
});

// Current camera outages ("Brak obrazu") from the newest report,
// compared with the previous report (new / still / resolved cameras).
app.get("/camera-outages/current", async (c) => {
  try {
    // Newest report by dateTo (tiebreak: id), previous = next in the same order
    const reports = sqlite
      .prepare(
        `SELECT
          id,
          title,
          date_from AS dateFrom,
          date_to AS dateTo
        FROM cma_reports
        ORDER BY date_to DESC, id DESC
        LIMIT 2`
      )
      .all() as {
      id: number;
      title: string;
      dateFrom: string | null;
      dateTo: string | null;
    }[];

    if (reports.length === 0) {
      return c.json({ success: true, data: null });
    }

    const latestReport = reports[0];
    const previousReport = reports[1] ?? null;

    // Hundreds of rows per report - the JS delta is cheap.
    const latestIssues = getCameraIssuesForReport(latestReport.id).issues;
    const previousIssues = previousReport
      ? getCameraIssuesForReport(previousReport.id).issues
      : [];

    // Approximated camera inventory: distinct video channels seen for the
    // object across ALL imported reports (the UI marks this as an estimate).
    const knownRows = sqlite
      .prepare(
        `SELECT
          object_name AS objectName,
          count(DISTINCT video_channel) AS total
        FROM cma_report_entries
        WHERE video_channel IS NOT NULL
        GROUP BY object_name`
      )
      .all() as { objectName: string; total: number }[];
    const knownCameras = new Map(
      knownRows.map((row) => [row.objectName, row.total])
    );

    const cameraKey = (videoChannel: string | null) => videoChannel ?? "";

    const previousByObject = new Map(
      previousIssues.map((obj) => [
        obj.objectName,
        {
          address: obj.address,
          channels: new Map(
            obj.cameras.map((cam) => [cameraKey(cam.videoChannel), cam])
          ),
        },
      ])
    );

    interface OutageCamera {
      videoChannel: string | null;
      status: "new" | "still";
      occurrences: number;
      firstAt: string | null;
      lastAt: string | null;
    }

    interface OutageObject {
      objectName: string;
      address: string | null;
      camerasOutCount: number;
      totalKnownCameras: number;
      allOut: boolean;
      cameras: OutageCamera[];
      resolved: { videoChannel: string | null }[];
    }

    const objects: OutageObject[] = [];
    const latestObjectNames = new Set(latestIssues.map((o) => o.objectName));

    for (const obj of latestIssues) {
      const prev = previousByObject.get(obj.objectName);

      const cameras: OutageCamera[] = obj.cameras
        .map((cam) => ({
          videoChannel: cam.videoChannel,
          // Without a previous report there is nothing to compare against -
          // every outage counts as "still" (no "new" markers).
          status: (previousReport && !prev?.channels.has(cameraKey(cam.videoChannel))
            ? "new"
            : "still") as "new" | "still",
          occurrences: cam.count,
          firstAt: cam.firstAt,
          lastAt: cam.lastAt,
        }))
        .sort(
          (a, b) =>
            (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) ||
            b.occurrences - a.occurrences ||
            (a.videoChannel ?? "").localeCompare(b.videoChannel ?? "", "pl")
        );

      const latestChannels = new Set(
        obj.cameras.map((cam) => cameraKey(cam.videoChannel))
      );
      const resolved = prev
        ? [...prev.channels.values()]
            .filter((cam) => !latestChannels.has(cameraKey(cam.videoChannel)))
            .map((cam) => ({ videoChannel: cam.videoChannel }))
            .sort((a, b) =>
              (a.videoChannel ?? "").localeCompare(b.videoChannel ?? "", "pl")
            )
        : [];

      const totalKnownCameras = knownCameras.get(obj.objectName) ?? 0;
      objects.push({
        objectName: obj.objectName,
        address: obj.address,
        camerasOutCount: cameras.length,
        totalKnownCameras,
        allOut: totalKnownCameras > 0 && cameras.length >= totalKnownCameras,
        cameras,
        resolved,
      });
    }

    // Objects that had outages only in the previous report - everything
    // recovered, keep them in the list with zero active outages.
    for (const obj of previousIssues) {
      if (latestObjectNames.has(obj.objectName)) continue;
      objects.push({
        objectName: obj.objectName,
        address: obj.address,
        camerasOutCount: 0,
        totalKnownCameras: knownCameras.get(obj.objectName) ?? 0,
        allOut: false,
        cameras: [],
        resolved: obj.cameras
          .map((cam) => ({ videoChannel: cam.videoChannel }))
          .sort((a, b) =>
            (a.videoChannel ?? "").localeCompare(b.videoChannel ?? "", "pl")
          ),
      });
    }

    objects.sort(
      (a, b) =>
        Number(b.allOut) - Number(a.allOut) ||
        b.camerasOutCount - a.camerasOutCount ||
        a.objectName.localeCompare(b.objectName, "pl")
    );

    const summary = {
      objectsWithOutages: objects.filter((o) => o.camerasOutCount > 0).length,
      camerasOut: objects.reduce((sum, o) => sum + o.camerasOutCount, 0),
      newCameras: previousReport
        ? objects.reduce(
            (sum, o) =>
              sum + o.cameras.filter((cam) => cam.status === "new").length,
            0
          )
        : 0,
      resolvedCameras: previousReport
        ? objects.reduce((sum, o) => sum + o.resolved.length, 0)
        : 0,
      allOutObjects: objects.filter((o) => o.allOut).length,
    };

    return c.json({
      success: true,
      data: {
        latestReport,
        previousReport,
        summary,
        objects,
      },
    });
  } catch (error) {
    console.error("Error building CMA camera outages:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się przygotować zestawienia braków kamer." },
      500
    );
  }
});

// Delete report with its entries
app.delete("/reports/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator raportu" },
      400
    );
  }

  const existing = await db
    .select()
    .from(schema.cmaReports)
    .where(eq(schema.cmaReports.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono raportu" },
      404
    );
  }

  // Entries are removed by ON DELETE CASCADE (foreign_keys = ON),
  // but delete them explicitly as well to be independent of pragma state
  try {
    sqlite.exec("BEGIN TRANSACTION");
    try {
      sqlite
        .prepare("DELETE FROM cma_report_entries WHERE report_id = ?")
        .run(id);
      sqlite.prepare("DELETE FROM cma_reports WHERE id = ?").run(id);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error deleting CMA report:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się usunąć raportu." },
      500
    );
  }

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Raport został usunięty",
  });
});

export default app;
