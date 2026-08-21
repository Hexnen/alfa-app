import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, asc, desc, sql, ne } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import type {
  NewWarehouseItem,
  NewWarehouse,
  WarehouseDocument,
} from "../db/schema.js";
import { getUser } from "../middleware/auth.js";

const app = new Hono();

// Typ transakcji drizzle/better-sqlite3 — helpery współdzielone między db i tx.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// better-sqlite3 jest synchroniczny — callback db.transaction MUSI być
// synchroniczny (żadnych await w środku). Błędy walidacji wewnątrz transakcji
// rzucamy jako ApiError; throw wycofuje transakcję, handler mapuje na kod HTTP.
class ApiError extends Error {
  status: 400 | 404 | 409 | 413;
  constructor(status: 400 | 404 | 409 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

const EPS = 1e-9;
const DOC_TYPES = ["PZ", "WZ", "RW", "MM"] as const;
type DocType = (typeof DOC_TYPES)[number];
const WAREHOUSE_TYPES = ["main", "vehicle", "employee", "site", "other"] as const;
const MAX_INVOICE_DATA = 10 * 1024 * 1024; // 10 MB (ZDEKODOWANE bajty załącznika)
const MAX_PHOTO_DATA = 1024 * 1024; // 1 MB (długość stringa data-URL; front skaluje do ≤800px)
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Przybliżony rozmiar zdekodowanych bajtów załącznika data-URL/base64
 * (część po przecinku × 3/4; padding pomijalny). Klient porównuje file.size
 * (bajty pliku) — serwer musi liczyć to samo, nie długość stringa base64.
 */
function dataUrlDecodedBytes(s: string): number {
  const comma = s.indexOf(",");
  const b64len = s.length - (comma >= 0 ? comma + 1 : 0);
  return Math.floor((b64len * 3) / 4);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowISO(): string {
  return new Date().toISOString();
}

/** Format ilości do komunikatów: bez ogona zer (2.5, 10, 0.125). */
function fmtQty(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function jsonError(c: Context, status: 400 | 404 | 409 | 413, error: string) {
  return c.json<ApiResponse<null>>({ success: false, error }, status);
}

// ============================================================
// TOWARY (kartoteka)
// ============================================================

function parseItemBody(body: Record<string, unknown>): {
  data?: Partial<NewWarehouseItem>;
  error?: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nazwa towaru jest wymagana" };

  const unitRaw = typeof body.unit === "string" ? body.unit.trim() : "";
  const sku = typeof body.sku === "string" && body.sku.trim() ? body.sku.trim() : null;

  let minStock: number | null = null;
  if (body.minStock !== undefined && body.minStock !== null && body.minStock !== "") {
    const v = Number(body.minStock);
    if (!Number.isFinite(v) || v < 0)
      return { error: "Stan minimalny musi być liczbą nieujemną" };
    minStock = v;
  }

  let photoData: string | null = null;
  if (typeof body.photoData === "string" && body.photoData) {
    if (body.photoData.length > MAX_PHOTO_DATA) {
      return { error: "Zdjęcie towaru jest za duże (limit 1 MB po kompresji)" };
    }
    if (!IMAGE_DATA_URL_RE.test(body.photoData)) {
      return {
        error: "Nieprawidłowe zdjęcie towaru (wymagany obraz JPEG/PNG/WebP)",
      };
    }
    photoData = body.photoData;
  }

  return {
    data: {
      sku,
      name,
      category:
        typeof body.category === "string" && body.category.trim()
          ? body.category.trim()
          : null,
      unit: unitRaw || "szt",
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description
          : null,
      photoData,
      minStock,
      isAsset: Boolean(body.isAsset),
      barcode:
        typeof body.barcode === "string" && body.barcode.trim()
          ? body.barcode.trim()
          : null,
    },
  };
}

// Lista towarów (domyślnie bez zarchiwizowanych)
app.get("/items", async (c) => {
  const includeArchived = c.req.query("includeArchived") === "1";
  const rows = await db
    .select()
    .from(schema.warehouseItems)
    .where(
      includeArchived ? undefined : eq(schema.warehouseItems.isArchived, false)
    )
    .orderBy(asc(schema.warehouseItems.name));
  return c.json({ success: true, data: rows });
});

// Nowy towar
app.post("/items", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseItemBody(body);
  if (error || !data) return jsonError(c, 400, error ?? "Błędne dane");

  if (data.sku) {
    const dup = await db
      .select({
        id: schema.warehouseItems.id,
        name: schema.warehouseItems.name,
        isArchived: schema.warehouseItems.isArchived,
      })
      .from(schema.warehouseItems)
      .where(eq(schema.warehouseItems.sku, data.sku))
      .limit(1);
    if (dup.length > 0) {
      return jsonError(
        c,
        400,
        dup[0].isArchived
          ? `Zarchiwizowany towar "${dup[0].name}" ma ten SKU — przywróć go zamiast tworzyć nowy`
          : "Towar o tym SKU już istnieje"
      );
    }
  }

  const result = await db
    .insert(schema.warehouseItems)
    .values(data as NewWarehouseItem)
    .returning();

  return c.json({ success: true, data: result[0], message: "Towar dodany" }, 201);
});

// Edycja towaru
app.put("/items/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouseItems)
    .where(eq(schema.warehouseItems.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono towaru");

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseItemBody(body);
  if (error || !data) return jsonError(c, 400, error ?? "Błędne dane");

  if (data.sku) {
    const dup = await db
      .select({
        id: schema.warehouseItems.id,
        name: schema.warehouseItems.name,
        isArchived: schema.warehouseItems.isArchived,
      })
      .from(schema.warehouseItems)
      .where(
        and(
          eq(schema.warehouseItems.sku, data.sku),
          ne(schema.warehouseItems.id, id)
        )
      )
      .limit(1);
    if (dup.length > 0) {
      return jsonError(
        c,
        400,
        dup[0].isArchived
          ? `Zarchiwizowany towar "${dup[0].name}" ma ten SKU — przywróć go zamiast tworzyć nowy`
          : "Towar o tym SKU już istnieje"
      );
    }
  }

  const isArchived =
    body.isArchived === undefined
      ? existing[0].isArchived
      : Boolean(body.isArchived);

  const result = await db
    .update(schema.warehouseItems)
    .set({ ...data, isArchived, updatedAt: nowISO() })
    .where(eq(schema.warehouseItems.id, id))
    .returning();

  return c.json({ success: true, data: result[0], message: "Towar zaktualizowany" });
});

// "Usunięcie" towaru = archiwizacja (fizyczny delete nigdy — historia ruchów)
app.delete("/items/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouseItems)
    .where(eq(schema.warehouseItems.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono towaru");

  const result = await db
    .update(schema.warehouseItems)
    .set({ isArchived: true, updatedAt: nowISO() })
    .where(eq(schema.warehouseItems.id, id))
    .returning();

  return c.json({ success: true, data: result[0], message: "Towar zarchiwizowany" });
});

// ============================================================
// MAGAZYNY
// ============================================================

function parseWarehouseBody(body: Record<string, unknown>): {
  data?: Partial<NewWarehouse>;
  error?: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nazwa magazynu jest wymagana" };

  let type: (typeof WAREHOUSE_TYPES)[number] = "main";
  if (body.type !== undefined && body.type !== null && body.type !== "") {
    if (
      typeof body.type !== "string" ||
      !(WAREHOUSE_TYPES as readonly string[]).includes(body.type)
    ) {
      return {
        error: `Nieprawidłowy typ magazynu (dozwolone: ${WAREHOUSE_TYPES.join(", ")})`,
      };
    }
    type = body.type as (typeof WAREHOUSE_TYPES)[number];
  }

  let parentId: number | null = null;
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== "") {
    const v = Number(body.parentId);
    if (!Number.isInteger(v) || v <= 0)
      return { error: "Nieprawidłowy magazyn nadrzędny" };
    parentId = v;
  }

  return {
    data: {
      name,
      code:
        typeof body.code === "string" && body.code.trim() ? body.code.trim() : null,
      type,
      parentId,
    },
  };
}

/** Walidacja parentId: istnieje i sam nie ma parenta (max 1 poziom). */
async function validateParent(
  parentId: number | null,
  selfId?: number
): Promise<string | null> {
  if (parentId === null) return null;
  if (selfId !== undefined && parentId === selfId)
    return "Magazyn nie może być swoim własnym magazynem nadrzędnym";
  const parent = await db
    .select()
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, parentId))
    .limit(1);
  if (parent.length === 0) return "Nie znaleziono magazynu nadrzędnego";
  if (parent[0].parentId !== null)
    return "Magazyn nadrzędny nie może sam mieć magazynu nadrzędnego (maksymalnie jeden poziom zagnieżdżenia)";
  return null;
}

// Lista magazynów (magazyn główny seedowany przy starcie aplikacji — src/index.ts)
app.get("/warehouses", async (c) => {
  const rows = await db
    .select()
    .from(schema.warehouses)
    .orderBy(asc(schema.warehouses.id));
  return c.json({ success: true, data: rows });
});

// Nowy magazyn
app.post("/warehouses", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseWarehouseBody(body);
  if (error || !data) return jsonError(c, 400, error ?? "Błędne dane");

  const parentError = await validateParent(data.parentId ?? null);
  if (parentError) return jsonError(c, 400, parentError);

  const result = await db
    .insert(schema.warehouses)
    .values(data as NewWarehouse)
    .returning();

  return c.json({ success: true, data: result[0], message: "Magazyn dodany" }, 201);
});

// Edycja magazynu
app.put("/warehouses/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono magazynu");

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseWarehouseBody(body);
  if (error || !data) return jsonError(c, 400, error ?? "Błędne dane");

  const parentError = await validateParent(data.parentId ?? null, id);
  if (parentError) return jsonError(c, 400, parentError);

  // Magazyn z podmagazynami nie może dostać parenta (złamałoby limit 1 poziomu)
  if (data.parentId !== null) {
    const children = await db
      .select({ id: schema.warehouses.id })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.parentId, id))
      .limit(1);
    if (children.length > 0) {
      return jsonError(
        c,
        400,
        "Magazyn posiadający podmagazyny nie może mieć magazynu nadrzędnego"
      );
    }
  }

  const isArchived =
    body.isArchived === undefined
      ? existing[0].isArchived
      : Boolean(body.isArchived);

  const result = await db
    .update(schema.warehouses)
    .set({ ...data, isArchived })
    .where(eq(schema.warehouses.id, id))
    .returning();

  return c.json({ success: true, data: result[0], message: "Magazyn zaktualizowany" });
});

// "Usunięcie" magazynu = archiwizacja; zablokowane przy niezerowym stanie
app.delete("/warehouses/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono magazynu");

  const stock = await db
    .select()
    .from(schema.warehouseStock)
    .where(eq(schema.warehouseStock.warehouseId, id));
  if (stock.some((s) => Math.abs(s.quantity) > EPS)) {
    return jsonError(
      c,
      400,
      "Nie można zarchiwizować magazynu z niezerowym stanem"
    );
  }

  const result = await db
    .update(schema.warehouses)
    .set({ isArchived: true })
    .where(eq(schema.warehouses.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Magazyn zarchiwizowany",
  });
});

// ============================================================
// STANY
// ============================================================

// Aktualne stany (tylko niezerowe)
app.get("/stock", async (c) => {
  const rows = await db.select().from(schema.warehouseStock);
  const nonZero = rows.filter((r) => Math.abs(r.quantity) > EPS);
  return c.json({ success: true, data: nonZero });
});

// ============================================================
// DOKUMENTY (PZ / WZ / RW / MM)
// ============================================================

interface DocItemInput {
  itemId: number;
  quantity: number;
  unitPrice: number | null;
}

interface DocHeadInput {
  docType: DocType;
  warehouseFromId: number | null;
  warehouseToId: number | null;
  contractorName: string | null;
  invoiceNumber: string | null;
  invoiceFileName: string | null;
  invoiceFileData: string | null;
  issuedAt: string;
  notes: string | null;
}

function parseDocItems(raw: unknown): { items?: DocItemInput[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "Dokument musi mieć co najmniej jedną pozycję" };
  const items: DocItemInput[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null)
      return { error: `Nieprawidłowa pozycja nr ${i + 1}` };
    const e = entry as Record<string, unknown>;
    const itemId = Number(e.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0)
      return { error: `Pozycja nr ${i + 1}: nieprawidłowy towar` };
    const quantity = Number(e.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0)
      return { error: `Pozycja nr ${i + 1}: ilość musi być liczbą większą od zera` };
    let unitPrice: number | null = null;
    if (e.unitPrice !== undefined && e.unitPrice !== null && e.unitPrice !== "") {
      const p = Number(e.unitPrice);
      if (!Number.isFinite(p) || p < 0)
        return { error: `Pozycja nr ${i + 1}: cena jednostkowa musi być liczbą nieujemną` };
      unitPrice = p;
    }
    items.push({ itemId, quantity, unitPrice });
  }
  return { items };
}

function optionalId(v: unknown): { value: number | null; error?: string } {
  if (v === undefined || v === null || v === "") return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return { value: null, error: "bad" };
  return { value: n };
}

/**
 * Parsuje i waliduje nagłówek dokumentu. Zwraca error + opcjonalny status
 * (413 dla za dużego załącznika).
 */
function parseDocHead(body: Record<string, unknown>): {
  data?: DocHeadInput;
  error?: string;
  status?: 400 | 413;
} {
  const docType = typeof body.docType === "string" ? body.docType : "";
  if (!(DOC_TYPES as readonly string[]).includes(docType)) {
    return {
      error: "Nieprawidłowy typ dokumentu (dozwolone: PZ, WZ, RW, MM)",
      status: 400,
    };
  }

  const from = optionalId(body.warehouseFromId);
  if (from.error) return { error: "Nieprawidłowy magazyn źródłowy", status: 400 };
  const to = optionalId(body.warehouseToId);
  if (to.error) return { error: "Nieprawidłowy magazyn docelowy", status: 400 };

  let warehouseFromId = from.value;
  let warehouseToId = to.value;

  // Wymagania magazynów per typ dokumentu
  if (docType === "PZ") {
    if (!warehouseToId)
      return { error: "Dokument PZ wymaga magazynu docelowego", status: 400 };
    warehouseFromId = null;
  } else if (docType === "WZ" || docType === "RW") {
    if (!warehouseFromId)
      return {
        error: `Dokument ${docType} wymaga magazynu źródłowego`,
        status: 400,
      };
    warehouseToId = null;
  } else if (docType === "MM") {
    if (!warehouseFromId || !warehouseToId)
      return {
        error: "Dokument MM wymaga magazynu źródłowego i docelowego",
        status: 400,
      };
    if (warehouseFromId === warehouseToId)
      return {
        error: "Magazyn źródłowy i docelowy dokumentu MM muszą być różne",
        status: 400,
      };
  }

  const invoiceFileData =
    typeof body.invoiceFileData === "string" && body.invoiceFileData
      ? body.invoiceFileData
      : null;
  if (invoiceFileData && dataUrlDecodedBytes(invoiceFileData) > MAX_INVOICE_DATA) {
    return { error: "Załącznik faktury jest za duży (limit 10 MB)", status: 413 };
  }

  let issuedAt = typeof body.issuedAt === "string" ? body.issuedAt.trim() : "";
  if (!issuedAt) issuedAt = todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) {
    return { error: "Data dokumentu musi mieć format RRRR-MM-DD", status: 400 };
  }

  return {
    data: {
      docType: docType as DocType,
      warehouseFromId,
      warehouseToId,
      contractorName:
        typeof body.contractorName === "string" && body.contractorName.trim()
          ? body.contractorName.trim()
          : null,
      invoiceNumber:
        typeof body.invoiceNumber === "string" && body.invoiceNumber.trim()
          ? body.invoiceNumber.trim()
          : null,
      invoiceFileName:
        typeof body.invoiceFileName === "string" && body.invoiceFileName.trim()
          ? body.invoiceFileName.trim()
          : null,
      invoiceFileData,
      issuedAt,
      notes:
        typeof body.notes === "string" && body.notes.trim() ? body.notes : null,
    },
  };
}

/** Sprawdza (synchronicznie, w tx) istnienie magazynów i towarów dokumentu. */
function validateDocRefsSync(tx: Tx, head: DocHeadInput, items: DocItemInput[]) {
  for (const whId of [head.warehouseFromId, head.warehouseToId]) {
    if (whId === null) continue;
    const wh = tx
      .select({ id: schema.warehouses.id })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, whId))
      .get();
    if (!wh) throw new ApiError(400, `Nie znaleziono magazynu o ID ${whId}`);
  }
  for (const it of items) {
    const item = tx
      .select({ id: schema.warehouseItems.id })
      .from(schema.warehouseItems)
      .where(eq(schema.warehouseItems.id, it.itemId))
      .get();
    if (!item) throw new ApiError(400, `Nie znaleziono towaru o ID ${it.itemId}`);
  }
}

/** Ruch magazynowy: wpis do ledgera + upsert cache stanów (jedna transakcja). */
function applyMovementSync(
  tx: Tx,
  m: {
    itemId: number;
    warehouseId: number;
    quantityDelta: number;
    documentId: number;
    documentItemId: number | null;
    createdBy: string | null;
  }
) {
  tx.insert(schema.warehouseMovements)
    .values({
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      quantityDelta: m.quantityDelta,
      documentId: m.documentId,
      documentItemId: m.documentItemId,
      // Jawnie ISO z "Z" (spójnie z confirmedAt) — default SQLite datetime('now')
      // daje UTC bez znacznika strefy, który front parsuje jako czas lokalny.
      createdAt: nowISO(),
      createdBy: m.createdBy,
    })
    .run();
  tx.insert(schema.warehouseStock)
    .values({
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      quantity: m.quantityDelta,
    })
    .onConflictDoUpdate({
      target: [schema.warehouseStock.itemId, schema.warehouseStock.warehouseId],
      set: {
        quantity: sql`${schema.warehouseStock.quantity} + ${m.quantityDelta}`,
      },
    })
    .run();
}

/** Aktualny stan (itemId × warehouseId) z cache; brak wiersza = 0. */
function stockQtySync(tx: Tx, itemId: number, warehouseId: number): number {
  const row = tx
    .select({ quantity: schema.warehouseStock.quantity })
    .from(schema.warehouseStock)
    .where(
      and(
        eq(schema.warehouseStock.itemId, itemId),
        eq(schema.warehouseStock.warehouseId, warehouseId)
      )
    )
    .get();
  return row ? row.quantity : 0;
}

function itemNameSync(tx: Tx, itemId: number): string {
  const row = tx
    .select({ name: schema.warehouseItems.name })
    .from(schema.warehouseItems)
    .where(eq(schema.warehouseItems.id, itemId))
    .get();
  return row?.name ?? `towar #${itemId}`;
}

function warehouseNameSync(tx: Tx, warehouseId: number): string {
  const row = tx
    .select({ name: schema.warehouses.name })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, warehouseId))
    .get();
  return row?.name ?? `magazyn #${warehouseId}`;
}

/**
 * Delty ruchów dla dokumentu: PZ → +qty w docelowym; WZ/RW → -qty w źródłowym;
 * MM → dwa wpisy na pozycję (-qty źródło, +qty cel). `sign` = -1 daje storno.
 */
function movementDeltas(
  doc: Pick<WarehouseDocument, "docType" | "warehouseFromId" | "warehouseToId">,
  items: { id: number | null; itemId: number; quantity: number }[],
  sign: 1 | -1
): {
  itemId: number;
  warehouseId: number;
  quantityDelta: number;
  documentItemId: number | null;
}[] {
  const out: {
    itemId: number;
    warehouseId: number;
    quantityDelta: number;
    documentItemId: number | null;
  }[] = [];
  for (const it of items) {
    if (doc.docType === "PZ") {
      out.push({
        itemId: it.itemId,
        warehouseId: doc.warehouseToId!,
        quantityDelta: sign * it.quantity,
        documentItemId: it.id,
      });
    } else if (doc.docType === "WZ" || doc.docType === "RW") {
      out.push({
        itemId: it.itemId,
        warehouseId: doc.warehouseFromId!,
        quantityDelta: sign * -it.quantity,
        documentItemId: it.id,
      });
    } else {
      // MM
      out.push({
        itemId: it.itemId,
        warehouseId: doc.warehouseFromId!,
        quantityDelta: sign * -it.quantity,
        documentItemId: it.id,
      });
      out.push({
        itemId: it.itemId,
        warehouseId: doc.warehouseToId!,
        quantityDelta: sign * it.quantity,
        documentItemId: it.id,
      });
    }
  }
  return out;
}

/**
 * Walidacja, że zastosowanie delt nie zrobi ujemnych stanów. Delty agregowane
 * per (magazyn × towar) — kilka pozycji tego samego towaru sumuje się.
 * Przy braku rzuca ApiError(400) z komunikatem budowanym przez `messageFor`.
 */
function assertNoNegativeStockSync(
  tx: Tx,
  deltas: { itemId: number; warehouseId: number; quantityDelta: number }[],
  messageFor: (details: string) => string
) {
  const agg = new Map<string, { itemId: number; warehouseId: number; delta: number }>();
  for (const d of deltas) {
    const key = `${d.warehouseId}:${d.itemId}`;
    const cur = agg.get(key) ?? {
      itemId: d.itemId,
      warehouseId: d.warehouseId,
      delta: 0,
    };
    cur.delta += d.quantityDelta;
    agg.set(key, cur);
  }
  const problems: string[] = [];
  for (const { itemId, warehouseId, delta } of agg.values()) {
    if (delta >= -EPS) continue; // tylko rozchody mogą zejść poniżej zera
    const available = stockQtySync(tx, itemId, warehouseId);
    if (available + delta < -EPS) {
      problems.push(
        `${itemNameSync(tx, itemId)} w ${warehouseNameSync(tx, warehouseId)} (dostępne ${fmtQty(available)}, potrzebne ${fmtQty(-delta)})`
      );
    }
  }
  if (problems.length > 0) {
    throw new ApiError(400, messageFor(problems.join("; ")));
  }
}

/**
 * Kolejny numer dokumentu: UPSERT sekwencji (typ × rok DATY DOKUMENTU)
 * → PZ/2026/001. Rok bierzemy z issuedAt (YYYY-MM-DD), nie z zegara serwera —
 * dokument datowany na grudzień zatwierdzony w styczniu ma numer starego roku.
 */
function nextDocNumberSync(tx: Tx, docType: DocType, issuedAt: string): string {
  const year = Number(issuedAt.slice(0, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) || !Number.isInteger(year)) {
    throw new ApiError(400, "Data dokumentu musi mieć format RRRR-MM-DD");
  }
  const row = tx
    .insert(schema.warehouseDocSequences)
    .values({ docType, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [
        schema.warehouseDocSequences.docType,
        schema.warehouseDocSequences.year,
      ],
      set: {
        lastNumber: sql`${schema.warehouseDocSequences.lastNumber} + 1`,
      },
    })
    .returning({ lastNumber: schema.warehouseDocSequences.lastNumber })
    .get();
  return `${docType}/${year}/${String(row.lastNumber).padStart(3, "0")}`;
}

/**
 * Weryfikacja (w tx), że magazyny i towary dokumentu nie są zarchiwizowane —
 * zatwierdzenie nie może wprowadzać stanów do niewidocznych magazynów/kartotek.
 */
function assertNotArchivedSync(
  tx: Tx,
  doc: Pick<WarehouseDocument, "warehouseFromId" | "warehouseToId">,
  items: { itemId: number }[]
) {
  for (const whId of [doc.warehouseFromId, doc.warehouseToId]) {
    if (whId === null) continue;
    const wh = tx
      .select({
        name: schema.warehouses.name,
        isArchived: schema.warehouses.isArchived,
      })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, whId))
      .get();
    if (!wh) throw new ApiError(400, `Nie znaleziono magazynu o ID ${whId}`);
    if (wh.isArchived) {
      throw new ApiError(
        400,
        `Magazyn "${wh.name}" jest zarchiwizowany — przywróć go przed zatwierdzeniem`
      );
    }
  }
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.itemId)) continue;
    seen.add(it.itemId);
    const item = tx
      .select({
        name: schema.warehouseItems.name,
        isArchived: schema.warehouseItems.isArchived,
      })
      .from(schema.warehouseItems)
      .where(eq(schema.warehouseItems.id, it.itemId))
      .get();
    if (!item)
      throw new ApiError(400, `Nie znaleziono towaru o ID ${it.itemId}`);
    if (item.isArchived) {
      throw new ApiError(
        400,
        `Towar "${item.name}" jest zarchiwizowany — przywróć go przed zatwierdzeniem`
      );
    }
  }
}

/**
 * Zatwierdzenie dokumentu (w tx): walidacja stanów → numer → ruchy w ledgerze
 * → aktualizacja cache stanów → status confirmed. Rzuca ApiError przy braku
 * stanu. Przejście statusu jest strzeżone (WHERE status='draft') — 0 wierszy
 * oznacza równoległą zmianę i wycofuje całą transakcję z 409.
 */
function confirmDocumentSync(
  tx: Tx,
  doc: WarehouseDocument,
  createdBy: string | null
): WarehouseDocument {
  const items = tx
    .select()
    .from(schema.warehouseDocumentItems)
    .where(eq(schema.warehouseDocumentItems.documentId, doc.id))
    .orderBy(asc(schema.warehouseDocumentItems.positionNo))
    .all();
  if (items.length === 0) {
    throw new ApiError(400, "Dokument musi mieć co najmniej jedną pozycję");
  }

  assertNotArchivedSync(tx, doc, items);

  const deltas = movementDeltas(doc, items, 1);
  assertNoNegativeStockSync(tx, deltas, (details) => `Za mało na stanie: ${details}`);

  const docNumber = nextDocNumberSync(tx, doc.docType as DocType, doc.issuedAt);

  for (const d of deltas) {
    applyMovementSync(tx, {
      itemId: d.itemId,
      warehouseId: d.warehouseId,
      quantityDelta: d.quantityDelta,
      documentId: doc.id,
      documentItemId: d.documentItemId,
      createdBy,
    });
  }

  const confirmed = tx
    .update(schema.warehouseDocuments)
    .set({
      status: "confirmed",
      docNumber,
      confirmedAt: nowISO(),
      updatedAt: nowISO(),
    })
    .where(
      and(
        eq(schema.warehouseDocuments.id, doc.id),
        eq(schema.warehouseDocuments.status, "draft")
      )
    )
    .returning()
    .get();
  if (!confirmed) {
    throw new ApiError(
      409,
      "Dokument został w międzyczasie zmieniony — odśwież widok"
    );
  }
  return confirmed;
}

// Kolumny dokumentu bez invoiceFileData (nie ładujemy base64 na listach)
const docColumns = {
  id: schema.warehouseDocuments.id,
  docType: schema.warehouseDocuments.docType,
  docNumber: schema.warehouseDocuments.docNumber,
  status: schema.warehouseDocuments.status,
  warehouseFromId: schema.warehouseDocuments.warehouseFromId,
  warehouseToId: schema.warehouseDocuments.warehouseToId,
  contractorName: schema.warehouseDocuments.contractorName,
  invoiceNumber: schema.warehouseDocuments.invoiceNumber,
  invoiceFileName: schema.warehouseDocuments.invoiceFileName,
  hasInvoiceFile: sql<number>`${schema.warehouseDocuments.invoiceFileData} IS NOT NULL`,
  issuedAt: schema.warehouseDocuments.issuedAt,
  confirmedAt: schema.warehouseDocuments.confirmedAt,
  notes: schema.warehouseDocuments.notes,
  createdBy: schema.warehouseDocuments.createdBy,
  createdAt: schema.warehouseDocuments.createdAt,
  updatedAt: schema.warehouseDocuments.updatedAt,
};

// Lista dokumentów (bez pozycji i bez załącznika; z liczbą pozycji i nazwami magazynów)
app.get("/documents", async (c) => {
  const type = c.req.query("type");
  const status = c.req.query("status");

  const conditions = [];
  if (type) {
    if (!(DOC_TYPES as readonly string[]).includes(type)) {
      return jsonError(c, 400, "Nieprawidłowy typ dokumentu");
    }
    conditions.push(
      eq(schema.warehouseDocuments.docType, type as DocType)
    );
  }
  if (status) {
    if (!["draft", "confirmed", "cancelled"].includes(status)) {
      return jsonError(c, 400, "Nieprawidłowy status dokumentu");
    }
    conditions.push(
      eq(
        schema.warehouseDocuments.status,
        status as "draft" | "confirmed" | "cancelled"
      )
    );
  }

  const docs = await db
    .select(docColumns)
    .from(schema.warehouseDocuments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.warehouseDocuments.id));

  const counts = await db
    .select({
      documentId: schema.warehouseDocumentItems.documentId,
      count: sql<number>`count(*)`,
    })
    .from(schema.warehouseDocumentItems)
    .groupBy(schema.warehouseDocumentItems.documentId);
  const countMap = new Map(counts.map((r) => [r.documentId, r.count]));

  const whs = await db
    .select({ id: schema.warehouses.id, name: schema.warehouses.name })
    .from(schema.warehouses);
  const whMap = new Map(whs.map((w) => [w.id, w.name]));

  const data = docs.map((d) => ({
    ...d,
    hasInvoiceFile: Boolean(d.hasInvoiceFile),
    itemCount: countMap.get(d.id) ?? 0,
    warehouseFromName:
      d.warehouseFromId !== null ? whMap.get(d.warehouseFromId) ?? null : null,
    warehouseToName:
      d.warehouseToId !== null ? whMap.get(d.warehouseToId) ?? null : null,
  }));

  return c.json({ success: true, data });
});

// Szczegóły dokumentu z pozycjami (bez załącznika — tylko flaga hasInvoiceFile)
app.get("/documents/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const docs = await db
    .select(docColumns)
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (docs.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  const doc = docs[0];

  const items = await db
    .select({
      id: schema.warehouseDocumentItems.id,
      documentId: schema.warehouseDocumentItems.documentId,
      itemId: schema.warehouseDocumentItems.itemId,
      quantity: schema.warehouseDocumentItems.quantity,
      unitPrice: schema.warehouseDocumentItems.unitPrice,
      positionNo: schema.warehouseDocumentItems.positionNo,
      itemName: schema.warehouseItems.name,
      itemUnit: schema.warehouseItems.unit,
    })
    .from(schema.warehouseDocumentItems)
    .leftJoin(
      schema.warehouseItems,
      eq(schema.warehouseDocumentItems.itemId, schema.warehouseItems.id)
    )
    .where(eq(schema.warehouseDocumentItems.documentId, id))
    .orderBy(asc(schema.warehouseDocumentItems.positionNo));

  const whs = await db
    .select({ id: schema.warehouses.id, name: schema.warehouses.name })
    .from(schema.warehouses);
  const whMap = new Map(whs.map((w) => [w.id, w.name]));

  return c.json({
    success: true,
    data: {
      ...doc,
      hasInvoiceFile: Boolean(doc.hasInvoiceFile),
      warehouseFromName:
        doc.warehouseFromId !== null
          ? whMap.get(doc.warehouseFromId) ?? null
          : null,
      warehouseToName:
        doc.warehouseToId !== null ? whMap.get(doc.warehouseToId) ?? null : null,
      items,
    },
  });
});

// Załącznik faktury dokumentu
app.get("/documents/:id/invoice", async (c) => {
  const id = parseInt(c.req.param("id"));
  const docs = await db
    .select({
      fileName: schema.warehouseDocuments.invoiceFileName,
      data: schema.warehouseDocuments.invoiceFileData,
    })
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (docs.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  if (!docs[0].data) return jsonError(c, 404, "Dokument nie ma załącznika faktury");
  return c.json({
    success: true,
    data: { fileName: docs[0].fileName, data: docs[0].data },
  });
});

// Nowy dokument (draft; confirm=true tworzy i zatwierdza w jednej transakcji)
app.post("/documents", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  const head = parseDocHead(body);
  if (head.error || !head.data) {
    return jsonError(c, head.status ?? 400, head.error ?? "Błędne dane");
  }
  const parsedItems = parseDocItems(body.items);
  if (parsedItems.error || !parsedItems.items) {
    return jsonError(c, 400, parsedItems.error ?? "Błędne pozycje");
  }
  const confirm = Boolean(body.confirm);
  const user = getUser(c);
  const createdBy = user?.email ?? null;

  try {
    const created = db.transaction((tx) => {
      validateDocRefsSync(tx, head.data!, parsedItems.items!);

      const doc = tx
        .insert(schema.warehouseDocuments)
        .values({
          ...head.data!,
          status: "draft",
          createdBy,
        })
        .returning()
        .get();

      parsedItems.items!.forEach((it, i) => {
        tx.insert(schema.warehouseDocumentItems)
          .values({
            documentId: doc.id,
            itemId: it.itemId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            positionNo: i + 1,
          })
          .run();
      });

      if (confirm) {
        return confirmDocumentSync(tx, doc, createdBy);
      }
      return doc;
    });

    const { invoiceFileData: _omit, ...rest } = created;
    return c.json(
      {
        success: true,
        data: rest,
        message: confirm
          ? `Dokument ${created.docNumber} zatwierdzony`
          : "Dokument roboczy utworzony",
      },
      201
    );
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
});

// Pola metadanych edytowalne również po zatwierdzeniu (nie wpływają na stany)
const META_FIELDS = [
  "contractorName",
  "invoiceNumber",
  "invoiceFileName",
  "invoiceFileData",
  "notes",
] as const;

// Edycja dokumentu: draft — wszystko (pozycje podmieniane w całości);
// confirmed — tylko metadane; cancelled — nic.
app.put("/documents/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  const doc = existing[0];

  const body = await c.req.json<Record<string, unknown>>();

  if (doc.status === "cancelled") {
    return jsonError(c, 400, "Anulowanego dokumentu nie można edytować");
  }

  if (doc.status === "confirmed") {
    // Pola wpływające na stany nie mogą się zmienić (obecność z tą samą
    // wartością jest OK — front może odsyłać cały obiekt).
    const restrictedChanged =
      (body.docType !== undefined && body.docType !== doc.docType) ||
      (body.warehouseFromId !== undefined &&
        (optionalId(body.warehouseFromId).value ?? null) !== doc.warehouseFromId) ||
      (body.warehouseToId !== undefined &&
        (optionalId(body.warehouseToId).value ?? null) !== doc.warehouseToId) ||
      (body.issuedAt !== undefined && body.issuedAt !== doc.issuedAt);

    let itemsChanged = false;
    if (body.items !== undefined) {
      const parsed = parseDocItems(body.items);
      if (parsed.error || !parsed.items) {
        itemsChanged = true;
      } else {
        const current = await db
          .select()
          .from(schema.warehouseDocumentItems)
          .where(eq(schema.warehouseDocumentItems.documentId, id))
          .orderBy(asc(schema.warehouseDocumentItems.positionNo));
        itemsChanged =
          current.length !== parsed.items.length ||
          parsed.items.some(
            (it, i) =>
              current[i].itemId !== it.itemId ||
              Math.abs(current[i].quantity - it.quantity) > EPS ||
              (current[i].unitPrice ?? null) !== (it.unitPrice ?? null)
          );
      }
    }

    if (restrictedChanged || itemsChanged) {
      return jsonError(c, 400, "Zatwierdzony dokument można tylko anulować");
    }

    const patch: Record<string, unknown> = {};
    for (const f of META_FIELDS) {
      if (body[f] !== undefined) {
        const v = body[f];
        patch[f] = typeof v === "string" && v !== "" ? v : null;
      }
    }
    if (
      typeof patch.invoiceFileData === "string" &&
      dataUrlDecodedBytes(patch.invoiceFileData) > MAX_INVOICE_DATA
    ) {
      return jsonError(c, 413, "Załącznik faktury jest za duży (limit 10 MB)");
    }

    // Update strzeżony statusem — dokument mógł zostać równolegle anulowany.
    const result = await db
      .update(schema.warehouseDocuments)
      .set({ ...patch, updatedAt: nowISO() })
      .where(
        and(
          eq(schema.warehouseDocuments.id, id),
          eq(schema.warehouseDocuments.status, "confirmed")
        )
      )
      .returning();
    if (result.length === 0) {
      return jsonError(
        c,
        409,
        "Dokument został w międzyczasie zmieniony — odśwież widok"
      );
    }
    const { invoiceFileData: _omit, ...rest } = result[0];
    return c.json({ success: true, data: rest, message: "Dokument zaktualizowany" });
  }

  // DRAFT — pełna edycja; brakujące pola nagłówka uzupełniamy z istniejącego
  const merged: Record<string, unknown> = {
    docType: body.docType ?? doc.docType,
    warehouseFromId:
      body.warehouseFromId !== undefined ? body.warehouseFromId : doc.warehouseFromId,
    warehouseToId:
      body.warehouseToId !== undefined ? body.warehouseToId : doc.warehouseToId,
    contractorName:
      body.contractorName !== undefined ? body.contractorName : doc.contractorName,
    invoiceNumber:
      body.invoiceNumber !== undefined ? body.invoiceNumber : doc.invoiceNumber,
    invoiceFileName:
      body.invoiceFileName !== undefined ? body.invoiceFileName : doc.invoiceFileName,
    invoiceFileData:
      body.invoiceFileData !== undefined ? body.invoiceFileData : doc.invoiceFileData,
    issuedAt: body.issuedAt !== undefined ? body.issuedAt : doc.issuedAt,
    notes: body.notes !== undefined ? body.notes : doc.notes,
  };
  const head = parseDocHead(merged);
  if (head.error || !head.data) {
    return jsonError(c, head.status ?? 400, head.error ?? "Błędne dane");
  }

  let newItems: DocItemInput[] | null = null;
  if (body.items !== undefined) {
    const parsed = parseDocItems(body.items);
    if (parsed.error || !parsed.items) {
      return jsonError(c, 400, parsed.error ?? "Błędne pozycje");
    }
    newItems = parsed.items;
  }

  try {
    const updated = db.transaction((tx) => {
      // Re-check statusu W transakcji — między odczytem (i await na json())
      // a transakcją dokument mógł zostać zatwierdzony/usunięty równolegle;
      // podmiana pozycji na zatwierdzonym rozjechałaby ruchy ledgera.
      const cur = tx
        .select({ status: schema.warehouseDocuments.status })
        .from(schema.warehouseDocuments)
        .where(eq(schema.warehouseDocuments.id, id))
        .get();
      if (!cur || cur.status !== "draft") {
        throw new ApiError(
          409,
          "Dokument został w międzyczasie zmieniony — odśwież widok"
        );
      }

      validateDocRefsSync(tx, head.data!, newItems ?? []);

      if (newItems) {
        tx.delete(schema.warehouseDocumentItems)
          .where(eq(schema.warehouseDocumentItems.documentId, id))
          .run();
        newItems.forEach((it, i) => {
          tx.insert(schema.warehouseDocumentItems)
            .values({
              documentId: id,
              itemId: it.itemId,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              positionNo: i + 1,
            })
            .run();
        });
      }

      return tx
        .update(schema.warehouseDocuments)
        .set({ ...head.data!, updatedAt: nowISO() })
        .where(eq(schema.warehouseDocuments.id, id))
        .returning()
        .get();
    });
    const { invoiceFileData: _omit, ...rest } = updated;
    return c.json({ success: true, data: rest, message: "Dokument zaktualizowany" });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
});

// Zatwierdzenie dokumentu (tylko draft)
app.post("/documents/:id/confirm", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select({ status: schema.warehouseDocuments.status })
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  if (existing[0].status !== "draft") {
    return jsonError(c, 400, "Zatwierdzić można tylko dokument roboczy");
  }

  const user = getUser(c);
  try {
    const confirmed = db.transaction((tx) => {
      // Re-read W transakcji — status sprzed niej mógł się równolegle zmienić
      // (drugi confirm / delete); praca na świeżym nagłówku, przejście statusu
      // dodatkowo strzeżone w confirmDocumentSync (WHERE status='draft').
      const doc = tx
        .select()
        .from(schema.warehouseDocuments)
        .where(eq(schema.warehouseDocuments.id, id))
        .get();
      if (!doc || doc.status !== "draft") {
        throw new ApiError(
          409,
          "Dokument został w międzyczasie zmieniony — odśwież widok"
        );
      }
      return confirmDocumentSync(tx, doc, user?.email ?? null);
    });
    const { invoiceFileData: _omit, ...rest } = confirmed;
    return c.json({
      success: true,
      data: rest,
      message: `Dokument ${confirmed.docNumber} zatwierdzony`,
    });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
});

// Anulowanie dokumentu (tylko confirmed) — storno: ruchy odwrotne w ledgerze
app.post("/documents/:id/cancel", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select({ status: schema.warehouseDocuments.status })
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  if (existing[0].status !== "confirmed") {
    return jsonError(c, 400, "Anulować można tylko zatwierdzony dokument");
  }

  const user = getUser(c);
  const createdBy = user?.email ?? null;

  try {
    const cancelled = db.transaction((tx) => {
      // Re-read W transakcji — równoległy cancel mógł już zdjąć stany;
      // storno liczone na świeżym nagłówku, przejście statusu strzeżone niżej.
      const doc = tx
        .select()
        .from(schema.warehouseDocuments)
        .where(eq(schema.warehouseDocuments.id, id))
        .get();
      if (!doc || doc.status !== "confirmed") {
        throw new ApiError(
          409,
          "Dokument został w międzyczasie zmieniony — odśwież widok"
        );
      }

      const items = tx
        .select()
        .from(schema.warehouseDocumentItems)
        .where(eq(schema.warehouseDocumentItems.documentId, id))
        .orderBy(asc(schema.warehouseDocumentItems.positionNo))
        .all();

      // Storno = delty z odwróconym znakiem; najpierw walidacja że nie zejdziemy
      // poniżej zera (np. anulowanie PZ, gdy towar już wydano dalej).
      const deltas = movementDeltas(doc, items, -1);
      assertNoNegativeStockSync(
        tx,
        deltas,
        (details) =>
          `Nie można anulować: towar z tego dokumentu został już rozchodowany (${details})`
      );

      for (const d of deltas) {
        applyMovementSync(tx, {
          itemId: d.itemId,
          warehouseId: d.warehouseId,
          quantityDelta: d.quantityDelta,
          documentId: doc.id,
          documentItemId: d.documentItemId,
          createdBy,
        });
      }

      const updated = tx
        .update(schema.warehouseDocuments)
        .set({ status: "cancelled", updatedAt: nowISO() })
        .where(
          and(
            eq(schema.warehouseDocuments.id, id),
            eq(schema.warehouseDocuments.status, "confirmed")
          )
        )
        .returning()
        .get();
      if (!updated) {
        throw new ApiError(
          409,
          "Dokument został w międzyczasie zmieniony — odśwież widok"
        );
      }
      return updated;
    });
    const { invoiceFileData: _omit, ...rest } = cancelled;
    return c.json({
      success: true,
      data: rest,
      message: `Dokument ${cancelled.docNumber ?? ""} anulowany`.replace("  ", " "),
    });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
});

// Usunięcie dokumentu — tylko draft, fizyczny delete (cascade na pozycje)
app.delete("/documents/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, id))
    .limit(1);
  if (existing.length === 0) return jsonError(c, 404, "Nie znaleziono dokumentu");
  if (existing[0].status !== "draft") {
    return jsonError(c, 400, "Usunąć można tylko dokument roboczy");
  }

  // Delete strzeżony statusem — równoległy confirm między odczytem a delete
  // zrobiłby z tego kasowanie zatwierdzonego dokumentu (i FK error na ruchach).
  const deleted = await db
    .delete(schema.warehouseDocuments)
    .where(
      and(
        eq(schema.warehouseDocuments.id, id),
        eq(schema.warehouseDocuments.status, "draft")
      )
    )
    .returning({ id: schema.warehouseDocuments.id });
  if (deleted.length === 0) {
    return jsonError(
      c,
      409,
      "Dokument został w międzyczasie zmieniony — odśwież widok"
    );
  }

  return c.json<ApiResponse<null>>({ success: true, message: "Dokument usunięty" });
});

// ============================================================
// RUCHY (ledger)
// ============================================================

app.get("/movements", async (c) => {
  const itemIdRaw = c.req.query("itemId");
  const warehouseIdRaw = c.req.query("warehouseId");
  const limitRaw = c.req.query("limit");

  const conditions = [];
  if (itemIdRaw) {
    const itemId = parseInt(itemIdRaw);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return jsonError(c, 400, "Nieprawidłowy parametr itemId");
    }
    conditions.push(eq(schema.warehouseMovements.itemId, itemId));
  }
  if (warehouseIdRaw) {
    const warehouseId = parseInt(warehouseIdRaw);
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      return jsonError(c, 400, "Nieprawidłowy parametr warehouseId");
    }
    conditions.push(eq(schema.warehouseMovements.warehouseId, warehouseId));
  }
  let limit = 200;
  if (limitRaw) {
    const v = parseInt(limitRaw);
    if (!Number.isInteger(v) || v <= 0) {
      return jsonError(c, 400, "Nieprawidłowy parametr limit");
    }
    limit = Math.min(v, 1000);
  }

  const rows = await db
    .select({
      id: schema.warehouseMovements.id,
      itemId: schema.warehouseMovements.itemId,
      warehouseId: schema.warehouseMovements.warehouseId,
      quantityDelta: schema.warehouseMovements.quantityDelta,
      documentId: schema.warehouseMovements.documentId,
      documentItemId: schema.warehouseMovements.documentItemId,
      createdAt: schema.warehouseMovements.createdAt,
      createdBy: schema.warehouseMovements.createdBy,
      itemName: schema.warehouseItems.name,
      itemUnit: schema.warehouseItems.unit,
      warehouseName: schema.warehouses.name,
      docNumber: schema.warehouseDocuments.docNumber,
      docType: schema.warehouseDocuments.docType,
    })
    .from(schema.warehouseMovements)
    .leftJoin(
      schema.warehouseItems,
      eq(schema.warehouseMovements.itemId, schema.warehouseItems.id)
    )
    .leftJoin(
      schema.warehouses,
      eq(schema.warehouseMovements.warehouseId, schema.warehouses.id)
    )
    .leftJoin(
      schema.warehouseDocuments,
      eq(schema.warehouseMovements.documentId, schema.warehouseDocuments.id)
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.warehouseMovements.id))
    .limit(limit);

  return c.json({ success: true, data: rows });
});

export default app;
