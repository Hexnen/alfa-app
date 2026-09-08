import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, like, or, sql, asc, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";
import {
  createOrderFromInput,
  ORDER_STATUSES,
  parseOrderInput,
  parseOrderPatch,
  parseOrderStatus,
} from "../services/orders.js";
import { isValidationError } from "../lib/validate.js";
import { buildOrderConfirmationMail, buildOrderInternalMail } from "../lib/order-mail.js";

const app = new Hono();

/**
 * Absolutny adres aplikacji dla zasobów i linków wklejanych do maila (logo, CRM).
 *
 * Kolejność: `APP_PUBLIC_URL` (wdrożenie) → `Origin` (żądanie z przeglądarki) →
 * `X-Forwarded-Host` (proxy) → `Host`. Gdy nic nie da się ustalić — pusty string,
 * czyli szablon zostawi ścieżkę względną.
 *
 * `X-Forwarded-Host` MUSI iść przed `Host`: w devie front woła /api przez proxy
 * Vite z `changeOrigin: true`, które przepisuje Host na `localhost:4001` i nie
 * przesyła Origin. Bez tego kroku mail wskazywałby backend zamiast aplikacji.
 */
function resolveBaseUrl(c: { req: { header(name: string): string | undefined } }): string {
  const configured = (process.env.APP_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const origin = (c.req.header("origin") || "").trim();
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");

  // Nagłówki proxy bywają listą („a, b”) — liczy się pierwszy wpis, czyli klient.
  const first = (name: string) => (c.req.header(name) || "").split(",")[0].trim();

  const host = first("x-forwarded-host") || (c.req.header("host") || "").trim();
  if (!host) return "";
  const proto = first("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

/** Body żądania → 400 z komunikatem, gdy JSON jest niepoprawny albo nie jest obiektem. */
async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Sortowanie listy zleceń. `status` układamy CASE-em, bo alfabetyczne sortowanie
 * wartości z bazy ("cancelled", "completed"…) nie ma dla użytkownika sensu — status
 * ma naturalną kolejność obsługi (nowe → w trakcie → zakończone → anulowane).
 *
 * Płatnik i obiekt sortują się po tym, co lista POKAZUJE: aktualna nazwa z kartoteki,
 * a gdy zlecenie nie jest z nią powiązane — migawka wpisana przy przyjęciu zlecenia.
 *
 * Nie ma klucza po kolumnie „Techniczne": to zbiór znaczników (kamery, megafony),
 * a nie jedna wartość — nagłówek zostaje nieklikalny (jak „Usługi" na liście obiektów).
 */
const SORT_COLUMNS = {
  number: sql`lower(${schema.orders.orderNumber})`,
  status: sql`case ${schema.orders.status} when 'new' then 0 when 'in_progress' then 1 when 'completed' then 2 when 'cancelled' then 3 else 4 end`,
  requester: sql`lower(${schema.orders.requesterName})`,
  object: sql`lower(coalesce(${schema.objects.name}, ${schema.orders.objectName}, ''))`,
  payer: sql`lower(coalesce(${schema.contractors.name}, ${schema.orders.payerName}, ''))`,
  created: sql`${schema.orders.createdAt}`,
} as const;

export type OrderSortKey = keyof typeof SORT_COLUMNS;

function isSortKey(v: string): v is OrderSortKey {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, v);
}

/** Data „YYYY-MM-DD" z query stringa; cokolwiek innego → undefined (filtr się nie nakłada). */
function dateParam(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return undefined;
  return raw.trim();
}

// Get all orders with optional search (with joined contractor and object data)
app.get("/", async (c) => {
  const search = c.req.query("search");
  const statusRaw = c.req.query("status");
  // "none" = zlecenia bez płatnika z kartoteki (klient spoza bazy kontrahentów).
  const payerParam = c.req.query("payerContractorId");
  // "1" = tylko montaże kamer, "0" = tylko pozostałe; brak parametru = wszystkie.
  const camera = c.req.query("camera");
  // Zakres daty przyjęcia zlecenia (kolumna „Data" na liście).
  const createdFrom = dateParam(c.req.query("createdFrom"));
  const createdTo = dateParam(c.req.query("createdTo"));
  const sortRaw = c.req.query("sort") || "created";
  const sort: OrderSortKey = isSortKey(sortRaw) ? sortRaw : "created";
  // Domyślnie najnowsze zlecenia na górze — lista dokumentów wpływających.
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const offset = (page - 1) * pageSize;

  // Warunki zbieramy do tablicy i składamy jednym `and(...)`: drugie `.where()`
  // w drizzle NADPISUJE pierwsze, więc `search+status` filtrowało tylko po statusie.
  // Warunki BEZ statusu trzymamy osobno — z nich liczymy kafelki „Nowe / W trakcie /
  // Zakończone", żeby pokazywały rozkład przy bieżących filtrach, a nie w całej bazie
  // (wzorzec liczników zakładek z listy obiektów).
  const baseConditions: SQL[] = [];
  if (search) {
    baseConditions.push(
      or(
        like(schema.orders.orderNumber, `%${search}%`),
        like(schema.orders.requesterName, `%${search}%`),
        // Migawka z formularza ORAZ aktualna nazwa z kartoteki — lista pokazuje tę
        // drugą, więc szukanie po niej musi działać (zlecenie powiązane z kontrahentem
        // wyświetlało „ASILI”, a szukajka znajdowała je tylko po „Płatnik Beta”).
        like(schema.orders.payerName, `%${search}%`),
        like(schema.orders.objectName, `%${search}%`),
        like(schema.contractors.name, `%${search}%`),
        like(schema.objects.name, `%${search}%`)
      )!
    );
  }
  if (payerParam === "none") {
    baseConditions.push(sql`${schema.orders.payerContractorId} is null`);
  } else if (payerParam) {
    const pid = parseInt(payerParam);
    if (Number.isInteger(pid)) baseConditions.push(eq(schema.orders.payerContractorId, pid));
  }
  if (camera === "1") {
    baseConditions.push(sql`${schema.orders.isCameraInstallation} = 1`);
  } else if (camera === "0") {
    baseConditions.push(sql`coalesce(${schema.orders.isCameraInstallation}, 0) = 0`);
  }
  // `created_at` bywa zapisany dwojako: `datetime('now')` z domyślnej wartości kolumny
  // („YYYY-MM-DD HH:MM:SS") i `toISOString()` z aplikacji („YYYY-MM-DDTHH:MM:SS.sssZ").
  // Pierwsze 10 znaków to w obu przypadkach ta sama data, więc porównujemy je wprost,
  // zamiast liczyć na to, że `date()` przełknie każdy z formatów.
  if (createdFrom !== undefined) {
    baseConditions.push(sql`substr(${schema.orders.createdAt}, 1, 10) >= ${createdFrom}`);
  }
  if (createdTo !== undefined) {
    baseConditions.push(sql`substr(${schema.orders.createdAt}, 1, 10) <= ${createdTo}`);
  }
  const baseClause = baseConditions.length > 0 ? and(...baseConditions) : undefined;

  const conditions: SQL[] = [...baseConditions];
  // Nieznany status nie nakłada filtru (jak nieznany klucz sortowania w /objects).
  if (statusRaw && (ORDER_STATUSES as readonly string[]).includes(statusRaw)) {
    conditions.push(eq(schema.orders.status, statusRaw as (typeof ORDER_STATUSES)[number]));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const column = SORT_COLUMNS[sort];
  const direction = dir === "desc" ? desc : asc;
  // Tie-break po numerze zlecenia (jest unikalny), żeby kolejność była powtarzalna
  // między stronami paginacji — przy sortowaniu po dacie kilka zleceń z tego samego
  // dnia potrafi inaczej ułożyć się na każdej stronie.
  const numberTieBreak = asc(sql`lower(${schema.orders.orderNumber})`);
  const orderBy = [direction(column), numberTieBreak];

  const results = await db
    .select({
      order: schema.orders,
      contractor: schema.contractors,
      object: schema.objects,
    })
    .from(schema.orders)
    .leftJoin(schema.contractors, eq(schema.orders.payerContractorId, schema.contractors.id))
    .leftJoin(schema.objects, eq(schema.orders.objectId, schema.objects.id))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  // `total` z TYM SAMYM where I TYMI SAMYMI złączeniami — inaczej paginacja po filtrze
  // pokazuje złą liczbę stron, a szukajka sięgająca kartoteki wywraca się na nieznanej
  // kolumnie. Złączenia są 1:1 (klucze główne), więc nie zmieniają liczby wierszy.
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.contractors, eq(schema.orders.payerContractorId, schema.contractors.id))
    .leftJoin(schema.objects, eq(schema.orders.objectId, schema.objects.id))
    .where(whereClause);
  const total = countResult[0].count;

  // Rozkład statusów przy WSZYSTKICH filtrach poza samym statusem — kafelki nad listą
  // liczyły dotąd wyłącznie wczytaną stronę (10 pozycji), więc „Nowe: 3" znaczyło
  // „3 na tej stronie", a nie „3 w całym wyniku".
  const statusRows = await db
    .select({
      total: sql<number>`count(*)`,
      new: sql<number>`sum(case when ${schema.orders.status} = 'new' then 1 else 0 end)`,
      inProgress: sql<number>`sum(case when ${schema.orders.status} = 'in_progress' then 1 else 0 end)`,
      completed: sql<number>`sum(case when ${schema.orders.status} = 'completed' then 1 else 0 end)`,
      cancelled: sql<number>`sum(case when ${schema.orders.status} = 'cancelled' then 1 else 0 end)`,
    })
    .from(schema.orders)
    .leftJoin(schema.contractors, eq(schema.orders.payerContractorId, schema.contractors.id))
    .leftJoin(schema.objects, eq(schema.orders.objectId, schema.objects.id))
    .where(baseClause);

  // Map results to include current contractor/object names
  const orders = results.map((r) => ({
    ...r.order,
    // Use current contractor data if available, fallback to order snapshot
    payerName: r.contractor?.name || r.order.payerName,
    payerNip: r.contractor?.nip || r.order.payerNip,
    // Use current object data if available, fallback to order snapshot
    objectName: r.object?.name || r.order.objectName,
    objectAddress: r.object?.address || r.order.objectAddress,
    objectCity: r.object?.city || r.order.objectCity,
    // Include full objects for reference
    contractor: r.contractor,
    object: r.object,
  }));

  return c.json({
    success: true,
    data: orders,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    sort,
    dir,
    // Liczby liczone BEZ filtra statusu — kafelki mają pokazywać rozkład zleceń
    // przy bieżącym zawężeniu listy, a `statusTotal` jest ich sumą.
    statusTotal: statusRows[0].total ?? 0,
    statusCounts: {
      new: statusRows[0].new ?? 0,
      in_progress: statusRows[0].inProgress ?? 0,
      completed: statusRows[0].completed ?? 0,
      cancelled: statusRows[0].cancelled ?? 0,
    },
  });
});

// Get order by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const order = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (order.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof order[0]>>({
    success: true,
    data: order[0],
  });
});

/**
 * Podgląd maila „potwierdzenie przyjęcia zlecenia” — gotowy HTML, temat, wersja
 * tekstowa i adresaci. NIC NIE WYSYŁA: front pokazuje to w dialogu, a ta sama
 * funkcja (src/lib/order-mail.ts) posłuży później wysyłce nodemailerem.
 *
 * Uprawnienia załatwia `tabPermissionGuard` (prefiks "/orders" → zakładka
 * "orders", GET = poziom "view"), więc trasa nie sprawdza ich po raz drugi.
 */
app.get("/:id/mail-preview", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator" }, 400);
  }

  // Dwa szablony: „client” — potwierdzenie DO KLIENTA (tylko wypełnione pola),
  // „internal” — komplet danych DLA ZESPOŁU (puste pola jako „—”).
  const variant = c.req.query("variant") ?? "client";
  if (variant !== "client" && variant !== "internal") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy wariant maila (dozwolone: client, internal)" },
      400
    );
  }

  const rows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Order not found" }, 404);
  }
  const order = rows[0];

  // Logo w mailu musi być absolutne — klient pocztowy nie zna adresu aplikacji.
  // Kolejność: jawna konfiguracja wdrożenia → Origin żądania (dev: :4000, prod:
  // domena appki) → Host z nagłówka. Bez żadnego z nich zostaje ścieżka względna.
  const baseUrl = resolveBaseUrl(c);

  const mail =
    variant === "internal"
      ? buildOrderInternalMail(order, { baseUrl })
      : buildOrderConfirmationMail(order, { baseUrl });

  // Adresat wewnętrznego maila to skrzynka zespołu z konfiguracji wdrożenia.
  // Bez niej zwracamy pusty string — front pokaże, że adres nie jest ustawiony,
  // zamiast podstawić przypadkowo adres klienta.
  // Kopia do osoby kontaktowej na obiekcie tylko wtedy, gdy to KTOŚ INNY niż
  // zlecający — inaczej ta sama osoba dostałaby wiadomość dwa razy.
  const requester = (order.requesterEmail || "").trim();
  const contact = (order.contactEmail || "").trim();
  const to =
    variant === "internal" ? (process.env.ORDER_INTERNAL_MAIL_TO || "").trim() : requester;
  const cc =
    variant === "internal"
      ? null
      : contact && contact.toLowerCase() !== to.toLowerCase()
        ? contact
        : null;

  return c.json<ApiResponse<{ subject: string; html: string; text: string; to: string; cc: string | null }>>({
    success: true,
    data: { ...mail, to, cc },
  });
});

// Create order with optional contractor and object creation (ATOMIC TRANSACTION)
app.post("/", async (c) => {
  // Ten sam walidator, co publiczny formularz ZDW: typy, długości, enumy.
  let body: OrderInput;
  try {
    body = parseOrderInput(await readJson(c));
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  try {
    const result = await createOrderFromInput(body);

    if (!result.ok) {
      return c.json<ApiResponse<null>>(
        { success: false, error: result.error },
        result.status as 400 | 409
      );
    }

    const orderResult = result.order;

    return c.json<ApiResponse<typeof orderResult & { createdContractor: boolean; createdObject: boolean }>>(
      {
        success: true,
        data: {
          ...orderResult,
          createdContractor: result.createdContractor,
          createdObject: result.createdObject,
        },
        message: `Order created successfully${result.createdContractor ? ' (with new contractor)' : ''}${result.createdObject ? ' (with new object)' : ''}`,
      },
      201
    );
  } catch (error) {
    console.error("Error creating order:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Failed to create order. Please try again." },
      500
    );
  }
});

// Update order
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const raw = await readJson(c);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowe dane" }, 400);
  }
  const { expectedUpdatedAt, ...rest } = raw as Record<string, unknown>;

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  // Optimistic concurrency: the client MUST echo the updatedAt it read as
  // expectedUpdatedAt. We only write if the row is unchanged, otherwise 409.
  // A missing token is rejected (428) instead of degrading to eq(id) — that
  // degrade path let two concurrent editors silently overwrite each other
  // (last-writer-wins), which is exactly the race this guard exists to close.
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Missing expectedUpdatedAt — reload the order and retry.",
      },
      428
    );
  }

  // Jawna lista pól + walidacja typów/enumów/FK — spread body do `.set()` pozwalał
  // nadpisać `id`, `orderNumber`, `createdAt` i wpisać dowolny tekst w `status`.
  // Flagi tworzenia (`createContractor`, `createObject`, `contractor*`, `object*`)
  // z formularza edycji są ignorowane — PUT nie zakłada nowych kartotek.
  let fields: ReturnType<typeof parseOrderPatch>;
  try {
    fields = parseOrderPatch(rest);
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  const result = await db
    .update(schema.orders)
    .set({
      ...fields,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.orders.id, id),
        eq(schema.orders.updatedAt, expectedUpdatedAt)
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Order was modified by someone else. Please reload and retry.",
      },
      409
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order updated successfully",
  });
});

// Delete order
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  await db.delete(schema.orders).where(eq(schema.orders.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Order deleted successfully",
  });
});

// Update order status
app.patch("/:id/status", async (c) => {
  const id = parseInt(c.req.param("id"));
  const raw = await readJson(c);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowe dane" }, 400);
  }
  const { status: statusRaw, expectedUpdatedAt } = raw as Record<string, unknown>;

  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  // Status tylko ze słownika — kolumna ma enum w schema.ts, ale SQLite go nie egzekwuje.
  let status: ReturnType<typeof parseOrderStatus>;
  try {
    status = parseOrderStatus(statusRaw);
  } catch (err) {
    if (isValidationError(err)) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    throw err;
  }

  // Optimistic concurrency guard (see PUT /:id) — the client MUST send the
  // updatedAt it read; a missing token is rejected (428) instead of degrading
  // to eq(id), so the last-writer-wins path cannot be reached.
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Missing expectedUpdatedAt — reload the order and retry.",
      },
      428
    );
  }

  const result = await db
    .update(schema.orders)
    .set({
      status,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.orders.id, id),
        eq(schema.orders.updatedAt, expectedUpdatedAt)
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Order was modified by someone else. Please reload and retry.",
      },
      409
    );
  }

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order status updated successfully",
  });
});

export default app;
