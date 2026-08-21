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
const MAX_PHOTO_DATA = 1024 * 1024; // 1 MB (ZDEKODOWANE bajty; front skaluje do ≤800px)
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// Dozwolone typy MIME załącznika faktury — prefiks sprawdzany osobno od
// payloadu, żeby nie puszczać regexu po całym (wielomegabajtowym) stringu.
const INVOICE_DATA_URL_PREFIX_RE =
  /^data:(?:application\/pdf|image\/jpeg|image\/png|image\/webp);base64,/;
const B64_SAMPLE_RE = /^[A-Za-z0-9+/=]+$/;
const INVOICE_FORMAT_ERROR =
  "Nieprawidłowy format załącznika (dozwolone PDF/JPG/PNG/WebP)";

/**
 * Przybliżony rozmiar zdekodowanych bajtów załącznika data-URL/base64
 * (część po przecinku × 3/4; padding pomijalny). Klient porównuje file.size
 * (bajty pliku) — serwer musi liczyć to samo, nie długość stringa base64.
 * UWAGA: rzetelny wynik tylko dla zwalidowanego data-URL (payload bez
 * przecinków) — walidacja formatu musi iść przed limitem rozmiaru.
 */
function dataUrlDecodedBytes(s: string): number {
  const comma = s.indexOf(",");
  const b64len = s.length - (comma >= 0 ? comma + 1 : 0);
  return Math.floor((b64len * 3) / 4);
}

/**
 * Walidacja załącznika faktury (data-URL): dozwolone PDF/JPG/PNG/WebP,
 * payload base64, zdekodowany rozmiar ≤ 10 MB. Świadomie bez jednego wielkiego
 * regexu na całym stringu: prefiks MIME sprawdzany na krótkim wycinku, payload
 * próbkowany (początek + koniec) i sprawdzany na brak kolejnego przecinka —
 * inaczej "<śmieci>,x" oszukiwałby licznik bajtów liczony od przecinka.
 * Zwraca błąd z kodem HTTP albo null, gdy załącznik jest poprawny.
 */
function validateInvoiceFileData(
  s: string
): { error: string; status: 400 | 413 } | null {
  const prefix = INVOICE_DATA_URL_PREFIX_RE.exec(s.slice(0, 64));
  if (!prefix) return { error: INVOICE_FORMAT_ERROR, status: 400 };
  const payloadStart = prefix[0].length;
  const payloadLen = s.length - payloadStart;
  if (payloadLen <= 0) return { error: INVOICE_FORMAT_ERROR, status: 400 };
  if (s.indexOf(",", payloadStart) !== -1) {
    return { error: INVOICE_FORMAT_ERROR, status: 400 };
  }
  const head = s.slice(payloadStart, payloadStart + 4096);
  const tail = payloadLen > 4096 ? s.slice(-4096) : "";
  if (!B64_SAMPLE_RE.test(head) || (tail && !B64_SAMPLE_RE.test(tail))) {
    return { error: INVOICE_FORMAT_ERROR, status: 400 };
  }
  if (Math.floor((payloadLen * 3) / 4) > MAX_INVOICE_DATA) {
    return { error: "Załącznik faktury jest za duży (limit 10 MB)", status: 413 };
  }
  return null;
}

/**
 * Dzisiejsza data wg LOKALNEGO zegara serwera. toISOString() dawałoby UTC —
 * na przełomie doby/roku wczorajszą datę i numer dokumentu ze starego roku.
 */
function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Czy RRRR-MM-DD to realna data kalendarzowa w sensownym zakresie (2000–2100). */
function isValidCalendarDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
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
    // Format przed rozmiarem — licznik bajtów zakłada payload po przecinku.
    if (!IMAGE_DATA_URL_RE.test(body.photoData)) {
      return {
        error: "Nieprawidłowe zdjęcie towaru (wymagany obraz JPEG/PNG/WebP)",
      };
    }
    if (dataUrlDecodedBytes(body.photoData) > MAX_PHOTO_DATA) {
      return { error: "Zdjęcie towaru jest za duże (maks. 1 MB po kompresji)" };
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

/**
 * Konflikt SKU z innym towarem: komunikat 400 albo null, gdy SKU wolne.
 * Używane jako pre-check (ładny komunikat) i ponownie w catchu po złapaniu
 * wyścigu (UNIQUE constraint) — wtedy re-query pokazuje kolidujący wiersz.
 */
async function skuConflict(sku: string, selfId?: number): Promise<string | null> {
  const dup = await db
    .select({
      name: schema.warehouseItems.name,
      isArchived: schema.warehouseItems.isArchived,
    })
    .from(schema.warehouseItems)
    .where(
      selfId === undefined
        ? eq(schema.warehouseItems.sku, sku)
        : and(
            eq(schema.warehouseItems.sku, sku),
            ne(schema.warehouseItems.id, selfId)
          )
    )
    .limit(1);
  if (dup.length === 0) return null;
  return dup[0].isArchived
    ? `Zarchiwizowany towar "${dup[0].name}" ma ten SKU — przywróć go zamiast tworzyć nowy`
    : "Towar o tym SKU już istnieje";
}

/** Czy błąd z SQLite to naruszenie UNIQUE na warehouse_items.sku (wyścig z pre-checkiem). */
function isSkuUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed: warehouse_items.sku")
  );
}

/**
 * Blokada archiwizacji towaru z niezerowym stanem (wywoływać W transakcji
 * razem z update — bez okna wyścigu z równoległym confirmem dokumentu).
 */
function assertItemStockZeroSync(tx: Tx, itemId: number, unit: string) {
  const rows = tx
    .select({
      warehouseId: schema.warehouseStock.warehouseId,
      quantity: schema.warehouseStock.quantity,
    })
    .from(schema.warehouseStock)
    .where(eq(schema.warehouseStock.itemId, itemId))
    .all();
  const nonZero = rows.filter((r) => Math.abs(r.quantity) > EPS);
  if (nonZero.length > 0) {
    const details = nonZero
      .map(
        (r) =>
          `${fmtQty(r.quantity)} ${unit} w ${warehouseNameSync(tx, r.warehouseId)}`
      )
      .join("; ");
    throw new ApiError(
      400,
      `Nie można zarchiwizować towaru z niezerowym stanem (${details})`
    );
  }
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
    const conflict = await skuConflict(data.sku);
    if (conflict) return jsonError(c, 400, conflict);
  }

  try {
    const result = await db
      .insert(schema.warehouseItems)
      .values(data as NewWarehouseItem)
      .returning();
    return c.json({ success: true, data: result[0], message: "Towar dodany" }, 201);
  } catch (err) {
    // Wyścig z równoległym zapisem tego samego SKU — pre-check przeszedł,
    // INSERT dostał UNIQUE; mapujemy na ten sam 400 co pre-check.
    if (data.sku && isSkuUniqueViolation(err)) {
      return jsonError(
        c,
        400,
        (await skuConflict(data.sku)) ?? "Towar o tym SKU już istnieje"
      );
    }
    throw err;
  }
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
    const conflict = await skuConflict(data.sku, id);
    if (conflict) return jsonError(c, 400, conflict);
  }

  const isArchived =
    body.isArchived === undefined
      ? existing[0].isArchived
      : Boolean(body.isArchived);

  try {
    const result = db.transaction((tx) => {
      const cur = tx
        .select()
        .from(schema.warehouseItems)
        .where(eq(schema.warehouseItems.id, id))
        .get();
      if (!cur) throw new ApiError(404, "Nie znaleziono towaru");
      // Archiwizacja (przejście false→true) tylko przy zerowym stanie —
      // check+update w JEDNEJ transakcji (bez okna wyścigu z confirmem).
      if (isArchived && !cur.isArchived) {
        assertItemStockZeroSync(tx, id, data.unit ?? cur.unit);
      }
      return tx
        .update(schema.warehouseItems)
        .set({ ...data, isArchived, updatedAt: nowISO() })
        .where(eq(schema.warehouseItems.id, id))
        .returning()
        .get();
    });
    return c.json({ success: true, data: result, message: "Towar zaktualizowany" });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    if (data.sku && isSkuUniqueViolation(err)) {
      return jsonError(
        c,
        400,
        (await skuConflict(data.sku, id)) ?? "Towar o tym SKU już istnieje"
      );
    }
    throw err;
  }
});

// "Usunięcie" towaru = archiwizacja (fizyczny delete nigdy — historia ruchów);
// zablokowane przy niezerowym stanie (ilości znikałyby ze wszystkich widoków)
app.delete("/items/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  try {
    const result = db.transaction((tx) => {
      const cur = tx
        .select()
        .from(schema.warehouseItems)
        .where(eq(schema.warehouseItems.id, id))
        .get();
      if (!cur) throw new ApiError(404, "Nie znaleziono towaru");
      if (!cur.isArchived) assertItemStockZeroSync(tx, id, cur.unit);
      return tx
        .update(schema.warehouseItems)
        .set({ isArchived: true, updatedAt: nowISO() })
        .where(eq(schema.warehouseItems.id, id))
        .returning()
        .get();
    });
    return c.json({ success: true, data: result, message: "Towar zarchiwizowany" });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
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

/**
 * Walidacja parentId: istnieje, nie jest zarchiwizowany i sam nie ma parenta
 * (max 1 poziom). Odrzucenie zarchiwizowanego rodzica blokuje też przywrócenie
 * podmagazynu, którego rodzic wciąż jest w archiwum.
 */
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
  if (parent[0].isArchived)
    return `Magazyn nadrzędny "${parent[0].name}" jest zarchiwizowany — przywróć go najpierw`;
  if (parent[0].parentId !== null)
    return "Magazyn nadrzędny nie może sam mieć magazynu nadrzędnego (maksymalnie jeden poziom zagnieżdżenia)";
  return null;
}

/**
 * Blokada archiwizacji magazynu (wywoływać W transakcji razem z update —
 * bez okna wyścigu z równoległym confirmem dokumentu): niezerowy stan
 * lub aktywne podmagazyny → 400.
 */
function assertWarehouseArchivableSync(tx: Tx, warehouseId: number) {
  const stock = tx
    .select({ quantity: schema.warehouseStock.quantity })
    .from(schema.warehouseStock)
    .where(eq(schema.warehouseStock.warehouseId, warehouseId))
    .all();
  if (stock.some((s) => Math.abs(s.quantity) > EPS)) {
    throw new ApiError(400, "Nie można zarchiwizować magazynu z niezerowym stanem");
  }
  const activeChild = tx
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(
      and(
        eq(schema.warehouses.parentId, warehouseId),
        eq(schema.warehouses.isArchived, false)
      )
    )
    .limit(1)
    .get();
  if (activeChild) {
    throw new ApiError(
      400,
      "Magazyn ma aktywne podmagazyny — zarchiwizuj je najpierw"
    );
  }
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

  try {
    const result = db.transaction((tx) => {
      const cur = tx
        .select()
        .from(schema.warehouses)
        .where(eq(schema.warehouses.id, id))
        .get();
      if (!cur) throw new ApiError(404, "Nie znaleziono magazynu");
      // Archiwizacja przez PUT podlega tym samym regułom co DELETE (zerowy
      // stan, brak aktywnych podmagazynów) — check+update w JEDNEJ transakcji.
      if (isArchived && !cur.isArchived) {
        assertWarehouseArchivableSync(tx, id);
      }
      return tx
        .update(schema.warehouses)
        .set({ ...data, isArchived })
        .where(eq(schema.warehouses.id, id))
        .returning()
        .get();
    });
    return c.json({ success: true, data: result, message: "Magazyn zaktualizowany" });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
});

// "Usunięcie" magazynu = archiwizacja; zablokowane przy niezerowym stanie
// lub aktywnych podmagazynach (check+update w jednej transakcji — bez okna
// wyścigu z równoległym zatwierdzeniem dokumentu)
app.delete("/warehouses/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  try {
    const result = db.transaction((tx) => {
      const cur = tx
        .select()
        .from(schema.warehouses)
        .where(eq(schema.warehouses.id, id))
        .get();
      if (!cur) throw new ApiError(404, "Nie znaleziono magazynu");
      if (!cur.isArchived) assertWarehouseArchivableSync(tx, id);
      return tx
        .update(schema.warehouses)
        .set({ isArchived: true })
        .where(eq(schema.warehouses.id, id))
        .returning()
        .get();
    });
    return c.json({
      success: true,
      data: result,
      message: "Magazyn zarchiwizowany",
    });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
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
  if (invoiceFileData) {
    const invErr = validateInvoiceFileData(invoiceFileData);
    if (invErr) return invErr;
  }

  let issuedAt = typeof body.issuedAt === "string" ? body.issuedAt.trim() : "";
  if (!issuedAt) issuedAt = todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) {
    return { error: "Data dokumentu musi mieć format RRRR-MM-DD", status: 400 };
  }
  if (!isValidCalendarDate(issuedAt)) {
    return { error: "Nieprawidłowa data dokumentu", status: 400 };
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
 * zatwierdzenie ani storno nie mogą księgować stanów do niewidocznych
 * magazynów/kartotek. Domyślne komunikaty dotyczą zatwierdzania; cancel
 * podaje własne przez `messages`.
 */
function assertNotArchivedSync(
  tx: Tx,
  doc: Pick<WarehouseDocument, "warehouseFromId" | "warehouseToId">,
  items: { itemId: number }[],
  messages: {
    warehouse: (name: string) => string;
    item: (name: string) => string;
  } = {
    warehouse: (n) =>
      `Magazyn "${n}" jest zarchiwizowany — przywróć go przed zatwierdzeniem`,
    item: (n) =>
      `Towar "${n}" jest zarchiwizowany — przywróć go przed zatwierdzeniem`,
  }
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
      throw new ApiError(400, messages.warehouse(wh.name));
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
      throw new ApiError(400, messages.item(item.name));
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

  let limit = 500;
  const limitRaw = c.req.query("limit");
  if (limitRaw) {
    const v = parseInt(limitRaw);
    if (!Number.isInteger(v) || v <= 0) {
      return jsonError(c, 400, "Nieprawidłowy parametr limit");
    }
    limit = Math.min(v, 2000);
  }

  const docs = await db
    .select(docColumns)
    .from(schema.warehouseDocuments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.warehouseDocuments.id))
    .limit(limit);

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

// Edycja dokumentu: draft — wszystko (pozycje podmieniane w całości;
// confirm=true dodatkowo zatwierdza w tej samej transakcji);
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

    // Metadane (nie wpływają na stany) — ta sama koercja/trim co parseDocHead,
    // żeby kontrakt draft/confirmed był spójny.
    const trimmedOrNull = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    const patch: Record<string, unknown> = {};
    if (body.contractorName !== undefined)
      patch.contractorName = trimmedOrNull(body.contractorName);
    if (body.invoiceNumber !== undefined)
      patch.invoiceNumber = trimmedOrNull(body.invoiceNumber);
    if (body.invoiceFileName !== undefined)
      patch.invoiceFileName = trimmedOrNull(body.invoiceFileName);
    if (body.notes !== undefined)
      patch.notes =
        typeof body.notes === "string" && body.notes.trim() ? body.notes : null;
    if (body.invoiceFileData !== undefined) {
      const v =
        typeof body.invoiceFileData === "string" && body.invoiceFileData
          ? body.invoiceFileData
          : null;
      if (v) {
        const invErr = validateInvoiceFileData(v);
        if (invErr) return jsonError(c, invErr.status, invErr.error);
      }
      patch.invoiceFileData = v;
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

  // DRAFT — pełna PODMIANA nagłówka (kontrakt jak POST: pole pominięte/null
  // = wyczyść; issuedAt pusty = dzisiejsza data; magazyny wg typu dokumentu).
  // WYJĄTEK: załącznik faktury zachowuje semantykę patcha — pominięte pole
  // (undefined) = zachowaj istniejący, jawny null = usuń, string = podmień.
  const merged: Record<string, unknown> = {
    ...body,
    docType: body.docType ?? doc.docType,
    invoiceFileName:
      body.invoiceFileName !== undefined ? body.invoiceFileName : doc.invoiceFileName,
    invoiceFileData:
      body.invoiceFileData !== undefined ? body.invoiceFileData : doc.invoiceFileData,
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

  // confirm=true → edycja + zatwierdzenie ATOMOWO (jedna transakcja):
  // nieudany confirm (np. brak stanu) wycofuje również zmiany edycji.
  const confirm = body.confirm === true;
  const user = getUser(c);
  const createdBy = user?.email ?? null;

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

      const updatedDoc = tx
        .update(schema.warehouseDocuments)
        .set({ ...head.data!, updatedAt: nowISO() })
        .where(eq(schema.warehouseDocuments.id, id))
        .returning()
        .get();

      if (confirm) {
        return confirmDocumentSync(tx, updatedDoc, createdBy);
      }
      return updatedDoc;
    });
    const { invoiceFileData: _omit, ...rest } = updated;
    return c.json({
      success: true,
      data: rest,
      message:
        updated.status === "confirmed"
          ? `Dokument ${updated.docNumber} zatwierdzony`
          : "Dokument zaktualizowany",
    });
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

      // Storno księguje ruchy tak samo jak confirm — nie może trafiać do
      // zarchiwizowanego magazynu/towaru (stany zniknęłyby z widoków).
      assertNotArchivedSync(tx, doc, items, {
        warehouse: (n) =>
          `Nie można anulować: magazyn "${n}" jest zarchiwizowany — przywróć go przed anulowaniem`,
        item: (n) =>
          `Nie można anulować: towar "${n}" jest zarchiwizowany — przywróć go przed anulowaniem`,
      });

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
