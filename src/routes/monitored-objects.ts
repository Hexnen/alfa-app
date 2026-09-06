import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, and, sql, desc, asc } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import { ObjectReportParseError } from "../utils/object-report-csv.js";
import {
  importObjectReportBuffer,
  ObjectReportDuplicateError,
} from "../utils/object-report-import.js";
import { fetchObjectCatalog } from "../lib/object-catalog.js";

const app = new Hono();

// Import raportu obiektów z pliku CSV (multipart/form-data, pole "file")
app.post("/import", async (c) => {
  let file: File;
  try {
    const body = await c.req.parseBody();
    const uploaded = body["file"];
    if (!uploaded || typeof uploaded === "string") {
      return c.json<ApiResponse<null>>(
        { success: false, error: 'Brak pliku. Prześlij plik w polu "file".' },
        400
      );
    }
    file = uploaded as File;
  } catch {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          'Nieprawidłowe żądanie - oczekiwano multipart/form-data z polem "file".',
      },
      400
    );
  }

  const fileName = file.name || "raport_obiektow.csv";
  if (!/\.(csv|xls|xlsx)$/i.test(fileName)) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Nieobsługiwany format pliku. Wymagany plik .csv, .xls lub .xlsx.",
      },
      400
    );
  }

  let created;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    created = importObjectReportBuffer(buffer, fileName);
  } catch (error) {
    if (error instanceof ObjectReportDuplicateError) {
      return c.json<ApiResponse<null>>(
        { success: false, error: error.message },
        409
      );
    }
    if (error instanceof ObjectReportParseError) {
      return c.json<ApiResponse<null>>(
        { success: false, error: error.message },
        400
      );
    }
    console.error("Error importing object report:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się zapisać raportu w bazie danych." },
      500
    );
  }

  return c.json<ApiResponse<typeof created>>(
    {
      success: true,
      data: created,
      message: `Zaimportowano raport: ${created.totalCount} obiektów (${created.newCount} nowych, ${created.changedCount} zmienionych, ${created.removedCount} usuniętych)`,
    },
    201
  );
});

// Historia importów (najnowsze najpierw)
app.get("/imports", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  const results = await db
    .select()
    .from(schema.objectImports)
    .orderBy(desc(schema.objectImports.importedAt), desc(schema.objectImports.id))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.objectImports);
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

// Ostatnie zmiany (wszystkie obiekty, z nazwą obiektu)
app.get("/changes", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "50");
  const offset = (page - 1) * pageSize;
  const importIdParam = c.req.query("importId");
  const importId = importIdParam ? parseInt(importIdParam) : undefined;

  const condition =
    importId && !Number.isNaN(importId)
      ? eq(schema.monitoredObjectChanges.importId, importId)
      : undefined;

  let query = db
    .select({
      change: schema.monitoredObjectChanges,
      objectName: schema.monitoredObjects.name,
      objectExternalId: schema.monitoredObjects.externalId,
    })
    .from(schema.monitoredObjectChanges)
    .innerJoin(
      schema.monitoredObjects,
      eq(schema.monitoredObjectChanges.objectId, schema.monitoredObjects.id)
    );
  if (condition) {
    query = query.where(condition) as typeof query;
  }

  const rows = await query
    .orderBy(
      desc(schema.monitoredObjectChanges.id)
    )
    .limit(pageSize)
    .offset(offset);

  let countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.monitoredObjectChanges);
  if (condition) {
    countQuery = countQuery.where(condition) as typeof countQuery;
  }
  const countResult = await countQuery;
  const total = countResult[0].count;

  return c.json({
    success: true,
    data: rows.map((row) => ({
      ...row.change,
      objectName: row.objectName,
      objectExternalId: row.objectExternalId,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

/**
 * Kartoteka obiektów w formie listy wyboru do mapowania. Osobny endpoint pod
 * `/monitored-objects`, a nie `GET /objects`, bo rejestr CMA mapuje operator
 * monitoringu — ma mieć listę nazw, ale nie cały moduł Kontrahenci/Obiekty.
 * MUSI stać PRZED `GET /:id`, inaczej trasa parametryczna przechwyci tę nazwę.
 * Zapytanie wspólne z `/hr/object-catalog` — patrz src/lib/object-catalog.ts.
 */
app.get("/object-catalog", async (c) => {
  return c.json({ success: true, data: await fetchObjectCatalog() });
});

// Lista obiektów (paginacja, szukanie, filtr aktywności)
app.get("/", async (c) => {
  const search = c.req.query("search");
  const active = c.req.query("active"); // "1" | "0" | brak = wszystkie
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "25");
  const offset = (page - 1) * pageSize;

  const conditions = [];
  if (search) {
    conditions.push(
      or(
        like(schema.monitoredObjects.name, `%${search}%`),
        like(schema.monitoredObjects.city, `%${search}%`),
        like(schema.monitoredObjects.address, `%${search}%`),
        like(schema.monitoredObjects.groups, `%${search}%`),
        like(schema.monitoredObjects.serviceTypes, `%${search}%`),
        sql`CAST(${schema.monitoredObjects.externalId} AS TEXT) LIKE ${`%${search}%`}`
      )
    );
  }
  if (active === "1" || active === "0") {
    conditions.push(eq(schema.monitoredObjects.active, active === "1"));
  }
  const condition = conditions.length ? and(...conditions) : undefined;

  // Do każdej pozycji doklejamy obiekt z kartoteki wskazany ręcznym
  // mapowaniem (`object_id`) razem z miastem i kontrahentem — ekran mapowania
  // pokazuje 416 wierszy naraz i nie ma jak dociągać kartoteki pozycja po
  // pozycji. LEFT JOIN, bo mapowanie jest opcjonalne (domyślnie brak).
  let query = db
    .select({
      row: schema.monitoredObjects,
      objectName: schema.objects.name,
      objectCity: schema.objects.city,
      contractorName: schema.contractors.name,
    })
    .from(schema.monitoredObjects)
    .leftJoin(schema.objects, eq(schema.monitoredObjects.objectId, schema.objects.id))
    .leftJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id)
    );
  if (condition) {
    query = query.where(condition) as typeof query;
  }

  const rows = await query
    .orderBy(asc(schema.monitoredObjects.name))
    .limit(pageSize)
    .offset(offset);
  const results = rows.map((r) => ({
    ...r.row,
    // Mapowanie może wskazywać na obiekt skasowany w międzyczasie (FK jest
    // "set null", więc taki stan długo nie potrwa) — stąd null zamiast obiektu
    // z pustymi polami.
    object:
      r.row.objectId != null && r.objectName != null
        ? {
            id: r.row.objectId,
            name: r.objectName,
            city: r.objectCity,
            contractorName: r.contractorName ?? "",
          }
        : null,
  }));

  let countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.monitoredObjects);
  if (condition) {
    countQuery = countQuery.where(condition) as typeof countQuery;
  }
  const countResult = await countQuery;
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

// Szczegóły obiektu + jego log zmian
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator obiektu" },
      400
    );
  }

  const [object] = await db
    .select()
    .from(schema.monitoredObjects)
    .where(eq(schema.monitoredObjects.id, id))
    .limit(1);
  if (!object) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404
    );
  }

  const changes = await db
    .select({
      change: schema.monitoredObjectChanges,
      importFileName: schema.objectImports.fileName,
      importedAt: schema.objectImports.importedAt,
    })
    .from(schema.monitoredObjectChanges)
    .leftJoin(
      schema.objectImports,
      eq(schema.monitoredObjectChanges.importId, schema.objectImports.id)
    )
    .where(eq(schema.monitoredObjectChanges.objectId, id))
    .orderBy(desc(schema.monitoredObjectChanges.id));

  return c.json<ApiResponse<unknown>>({
    success: true,
    data: {
      object,
      changes: changes.map((row) => ({
        ...row.change,
        importFileName: row.importFileName,
        importedAt: row.importedAt,
      })),
    },
  });
});

/**
 * Ręczne mapowanie pozycji rejestru monitoringu na obiekt z kartoteki.
 * `{ objectId: null }` = zdejmij mapowanie.
 *
 * Rejestr CMA powstał niezależnie od kartoteki i nie pokrywa się z nią ani po
 * nazwie, ani po adresie (0 dopasowań), więc powiązanie musi ustawić człowiek.
 * Osobny endpoint zamiast pola w zapisie pozycji, żeby zapis reszty danych
 * (import raportu, edycja) nie czyścił przypadkiem powiązania.
 */
app.put("/:id/mapping", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy identyfikator obiektu" },
      400
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowe żądanie" },
      400
    );
  }

  const raw = body.objectId;
  let objectId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy obiekt" },
        400
      );
    }
    objectId = n;
  }

  if (objectId !== null) {
    const [obj] = await db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(eq(schema.objects.id, objectId))
      .limit(1);
    if (!obj) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie znaleziono obiektu w kartotece" },
        404
      );
    }
  }

  const result = await db
    .update(schema.monitoredObjects)
    // Ten rejestr trzyma czas w formacie SQLite (`datetime('now')`) — tak go
    // zapisuje import raportu, więc mapowanie nie może wstawić tu ISO z "T".
    .set({ objectId, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.monitoredObjects.id, id))
    .returning();
  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono obiektu" },
      404
    );
  }

  return c.json({
    success: true,
    data: result[0],
    message: objectId === null ? "Mapowanie usunięte" : "Mapowanie zapisane",
  });
});

export default app;
