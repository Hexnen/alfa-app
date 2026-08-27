import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { and, eq, asc, inArray, ne, sql } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import { PRICE_ITEM_KINDS } from "../db/schema.js";
import type { NewPriceItem, PriceItemKind, PriceListGroup } from "../db/schema.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Cenniki (grupy) — /api/pricelist/lists
// ---------------------------------------------------------------------------

/**
 * Id cennika domyślnego. Niezmiennik „dokładnie jeden is_default=1" jest
 * pilnowany przez trasy, ale gdyby baza była po ręcznej edycji bez domyślnego,
 * wybieramy najstarszy cennik (a jak nie ma żadnego — tworzymy podstawowy),
 * żeby zgodność wsteczna `GET /pricelist` nigdy nie wywróciła się na null.
 */
async function ensureDefaultListId(): Promise<number> {
  const found = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.isDefault, true))
    .limit(1);
  if (found.length > 0) return found[0].id;

  const any = await db
    .select()
    .from(schema.priceLists)
    .orderBy(asc(schema.priceLists.position), asc(schema.priceLists.id))
    .limit(1);
  if (any.length > 0) {
    await db
      .update(schema.priceLists)
      .set({ isDefault: true })
      .where(eq(schema.priceLists.id, any[0].id));
    return any[0].id;
  }

  const created = await db
    .insert(schema.priceLists)
    .values({
      name: "Cennik podstawowy",
      description: "Domyślny cennik usług serwisowych",
      isDefault: true,
      position: 1,
    })
    .returning();
  return created[0].id;
}

function parseListBody(body: Record<string, unknown>): {
  data?: { name: string; description: string; active: boolean; position?: number };
  error?: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nazwa cennika jest wymagana" };
  if (name.length > 80) return { error: "Nazwa cennika może mieć najwyżej 80 znaków" };
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const position = Number.isFinite(Number(body.position))
    ? Number(body.position)
    : undefined;
  return {
    data: {
      name,
      description,
      active: body.active === undefined ? true : Boolean(body.active),
      position,
    },
  };
}

/** Cenniki + licznik pozycji i przypisanych techników. */
async function listsWithCounts(): Promise<
  (PriceListGroup & { itemCount: number; technicianCount: number })[]
> {
  const lists = await db
    .select()
    .from(schema.priceLists)
    .orderBy(asc(schema.priceLists.position), asc(schema.priceLists.id));

  const itemCounts = await db
    .select({
      listId: schema.priceList.priceListId,
      count: sql<number>`count(*)`,
    })
    .from(schema.priceList)
    .groupBy(schema.priceList.priceListId);

  const techCounts = await db
    .select({
      listId: schema.technicians.priceListId,
      count: sql<number>`count(*)`,
    })
    .from(schema.technicians)
    .groupBy(schema.technicians.priceListId);

  const itemMap = new Map(itemCounts.map((r) => [r.listId, Number(r.count)]));
  const techMap = new Map(techCounts.map((r) => [r.listId, Number(r.count)]));

  return lists.map((l) => ({
    ...l,
    itemCount: itemMap.get(l.id) ?? 0,
    technicianCount: techMap.get(l.id) ?? 0,
  }));
}

/** Czy błąd to naruszenie UNIQUE (kolizja nazwy cennika)? */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
      err.message.includes("UNIQUE constraint failed"))
  );
}

// Lista cenników
app.get("/lists", async (c) => {
  await ensureDefaultListId();
  return c.json({ success: true, data: await listsWithCounts() });
});

// Nowy cennik
app.post("/lists", async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  const { data, error } = parseListBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  await ensureDefaultListId();

  if (data.position === undefined) {
    const rows = await db.select().from(schema.priceLists);
    data.position = rows.length + 1;
  }

  try {
    const result = await db
      .insert(schema.priceLists)
      .values({
        name: data.name,
        description: data.description,
        active: data.active,
        position: data.position,
        isDefault: false,
      })
      .returning();

    // Opcjonalne ustawienie od razu jako główny.
    if (body.isDefault) {
      await db
        .update(schema.priceLists)
        .set({ isDefault: false })
        .where(ne(schema.priceLists.id, result[0].id));
      await db
        .update(schema.priceLists)
        .set({ isDefault: true, active: true })
        .where(eq(schema.priceLists.id, result[0].id));
      result[0].isDefault = true;
    }

    return c.json({ success: true, data: result[0], message: "Cennik utworzony" }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Cennik o tej nazwie już istnieje" },
        409
      );
    }
    throw err;
  }
});

// Edycja cennika (nazwa / opis / aktywność / kolejność)
app.put("/lists/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const { data, error } = parseListBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  if (existing[0].isDefault && !data.active) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie można dezaktywować cennika głównego" },
      400
    );
  }

  try {
    const result = await db
      .update(schema.priceLists)
      .set({
        name: data.name,
        description: data.description,
        active: data.active,
        ...(data.position === undefined ? {} : { position: data.position }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.priceLists.id, id))
      .returning();
    return c.json({
      success: true,
      data: result[0],
      message: "Cennik zaktualizowany",
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Cennik o tej nazwie już istnieje" },
        409
      );
    }
    throw err;
  }
});

// Ustawienie cennika jako główny (poprzedni traci flagę)
app.post("/lists/:id/default", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  await db
    .update(schema.priceLists)
    .set({ isDefault: false, updatedAt: new Date().toISOString() })
    .where(ne(schema.priceLists.id, id));
  // Cennik główny musi być aktywny — inaczej nie byłoby z czego prefillować wycen.
  const result = await db
    .update(schema.priceLists)
    .set({ isDefault: true, active: true, updatedAt: new Date().toISOString() })
    .where(eq(schema.priceLists.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Ustawiono jako cennik główny",
  });
});

// Duplikat cennika wraz z pozycjami
app.post("/lists/:id/duplicate", async (c) => {
  const id = parseInt(c.req.param("id"));
  const source = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  if (source.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const rawName =
    typeof body.name === "string"
      ? (body.name as string).trim()
      : "";
  if (rawName.length > 80) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nazwa cennika może mieć najwyżej 80 znaków" },
      400
    );
  }

  const taken = new Set(
    (await db.select({ name: schema.priceLists.name }).from(schema.priceLists)).map(
      (r) => r.name
    )
  );
  let name = rawName || `${source[0].name} (kopia)`;
  if (taken.has(name)) {
    const base = (rawName || `${source[0].name} (kopia)`).slice(0, 70);
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    name = `${base} ${n}`;
  }

  const all = await db.select().from(schema.priceLists);
  const created = await db
    .insert(schema.priceLists)
    .values({
      name,
      description:
        typeof body.description === "string"
          ? (body.description as string).trim()
          : source[0].description,
      active: true,
      isDefault: false,
      position: all.length + 1,
    })
    .returning();

  const items = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.priceListId, id))
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id));

  if (items.length > 0) {
    await db.insert(schema.priceList).values(
      items.map((i) => ({
        priceListId: created[0].id,
        name: i.name,
        unit: i.unit,
        kind: i.kind,
        price: i.price,
        position: i.position,
        active: i.active,
      }))
    );
  }

  return c.json(
    {
      success: true,
      data: { ...created[0], itemCount: items.length, technicianCount: 0 },
      message: `Skopiowano cennik (${items.length} poz.)`,
    },
    201
  );
});

// Usunięcie cennika. Bez ?force=1 odmawia, gdy ma pozycje lub techników;
// z ?force=1 pozycje trafiają do cennika głównego, a technicy wracają na
// „Główny (domyślny)" (price_list_id = NULL).
app.delete("/lists/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }
  if (existing[0].isDefault) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error:
          "Nie można usunąć cennika głównego — najpierw ustaw jako główny inny cennik",
      },
      400
    );
  }

  const items = await db
    .select({ id: schema.priceList.id })
    .from(schema.priceList)
    .where(eq(schema.priceList.priceListId, id));
  const techs = await db
    .select({ id: schema.technicians.id })
    .from(schema.technicians)
    .where(eq(schema.technicians.priceListId, id));

  const force = c.req.query("force") === "1";
  if (!force && (items.length > 0 || techs.length > 0)) {
    const parts: string[] = [];
    if (items.length > 0) parts.push(`${items.length} poz. cennika`);
    if (techs.length > 0) parts.push(`${techs.length} przypisanych techników`);
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: `Cennik „${existing[0].name}" ma ${parts.join(" i ")}. Usuń z przeniesieniem, aby pozycje trafiły do cennika głównego, a technicy wrócili na główny.`,
      },
      409
    );
  }

  if (items.length > 0) {
    const defaultId = await ensureDefaultListId();
    await db
      .update(schema.priceList)
      .set({ priceListId: defaultId, updatedAt: new Date().toISOString() })
      .where(eq(schema.priceList.priceListId, id));
  }
  if (techs.length > 0) {
    await db
      .update(schema.technicians)
      .set({ priceListId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.technicians.priceListId, id));
  }

  await db.delete(schema.priceLists).where(eq(schema.priceLists.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message:
      items.length > 0
        ? `Cennik usunięty — ${items.length} poz. przeniesiono do cennika głównego`
        : "Cennik usunięty",
  });
});

// Technicy przypisani do cennika
app.get("/lists/:id/technicians", async (c) => {
  const id = parseInt(c.req.param("id"));
  const rows = await db
    .select()
    .from(schema.technicians)
    .where(eq(schema.technicians.priceListId, id))
    .orderBy(asc(schema.technicians.lastName), asc(schema.technicians.firstName));
  return c.json({ success: true, data: rows });
});

// Ustawienie zbioru techników korzystających z cennika (kierunek odwrotny do
// `PUT /technicians/:id`): wskazani dostają ten cennik, pozostali są z niego
// zdejmowani (wracają na główny).
app.put("/lists/:id/technicians", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const raw = body.technicianIds;
  if (!Array.isArray(raw)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Pole technicianIds musi być listą id" },
      400
    );
  }
  const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n)))];

  if (ids.length > 0) {
    const found = await db
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .where(inArray(schema.technicians.id, ids));
    if (found.length !== ids.length) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie znaleziono części wskazanych techników" },
        400
      );
    }
  }

  const now = new Date().toISOString();
  // Zdejmij cennik z techników spoza listy…
  await db
    .update(schema.technicians)
    .set({ priceListId: null, updatedAt: now })
    .where(eq(schema.technicians.priceListId, id));
  // …i przypisz wskazanym.
  if (ids.length > 0) {
    await db
      .update(schema.technicians)
      .set({ priceListId: id, updatedAt: now })
      .where(inArray(schema.technicians.id, ids));
  }

  const rows = await db
    .select()
    .from(schema.technicians)
    .where(eq(schema.technicians.priceListId, id))
    .orderBy(asc(schema.technicians.lastName), asc(schema.technicians.firstName));

  return c.json({
    success: true,
    data: rows,
    message: `Przypisano techników: ${rows.length}`,
  });
});

// Kopiowanie pozycji między cennikami
app.post("/copy", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const b = body;
  const fromListId = Number(b.fromListId);
  const toListId = Number(b.toListId);
  if (!Number.isInteger(fromListId) || !Number.isInteger(toListId)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Wymagane fromListId i toListId" },
      400
    );
  }
  if (fromListId === toListId) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Cennik źródłowy i docelowy są takie same" },
      400
    );
  }

  const lists = await db
    .select()
    .from(schema.priceLists)
    .where(inArray(schema.priceLists.id, [fromListId, toListId]));
  if (lists.length !== 2) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika źródłowego lub docelowego" },
      404
    );
  }

  const itemIds = Array.isArray(b.itemIds)
    ? [...new Set(b.itemIds.map((v) => Number(v)).filter((n) => Number.isInteger(n)))]
    : null;

  let items = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.priceListId, fromListId))
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id));
  if (itemIds) items = items.filter((i) => itemIds.includes(i.id));

  if (items.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Brak pozycji do skopiowania" },
      400
    );
  }

  const target = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.priceListId, toListId));
  let next = target.reduce((m, i) => Math.max(m, i.position), 0);

  const inserted = await db
    .insert(schema.priceList)
    .values(
      items.map((i) => ({
        priceListId: toListId,
        name: i.name,
        unit: i.unit,
        kind: i.kind,
        price: i.price,
        position: ++next,
        active: i.active,
      }))
    )
    .returning();

  return c.json(
    {
      success: true,
      data: inserted,
      message: `Skopiowano pozycje: ${inserted.length}`,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// Pozycje cennika — /api/pricelist
// ---------------------------------------------------------------------------

/** Jednostki towarowe — po nich klasyfikujemy pozycję bez podanego rodzaju (jak migracja 0041). */
const MATERIAL_UNITS = new Set([
  "SZT", "SZT.", "SZTUKA", "KPL", "KPL.", "MB", "M", "M2", "M²", "KG",
]);

/** Wstępny rodzaj pozycji dla klientów, które nie przysyłają `kind` (stary front, importy). */
function inferKind(unit: string): PriceItemKind {
  return MATERIAL_UNITS.has(unit.trim().toUpperCase()) ? "material" : "service";
}

function parseBody(body: Record<string, unknown>): {
  data?: Partial<NewPriceItem>;
  error?: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim().toUpperCase() : "";
  if (!name) return { error: "Nazwa usługi jest wymagana" };
  if (!unit) return { error: "Jednostka miary jest wymagana" };

  // `kind` nieprzysłany = pole nietykane (PUT zostawia rodzaj, POST wnioskuje z jednostki).
  let kind: PriceItemKind | undefined;
  if (body.kind !== undefined && body.kind !== null && body.kind !== "") {
    if (typeof body.kind !== "string" || !(PRICE_ITEM_KINDS as readonly string[]).includes(body.kind)) {
      return { error: `Nieprawidłowy rodzaj pozycji (dozwolone: ${PRICE_ITEM_KINDS.join(", ")})` };
    }
    kind = body.kind as PriceItemKind;
  }

  const priceRaw =
    typeof body.price === "string"
      ? parseFloat(body.price.replace(",", "."))
      : Number(body.price);
  const price = Number.isFinite(priceRaw) ? priceRaw : 0;
  const position = Number.isFinite(Number(body.position))
    ? Number(body.position)
    : 0;

  return {
    data: {
      name,
      unit,
      price,
      position,
      active: body.active === undefined ? true : Boolean(body.active),
      ...(kind === undefined ? {} : { kind }),
    },
  };
}

/**
 * Cennik wskazany w body/query. `undefined` = pole nieprzysłane (PUT zostawia
 * pozycję tam, gdzie jest), `null` = wartość nieprawidłowa.
 */
function readListId(body: Record<string, unknown>): number | null | undefined {
  if (body.priceListId === undefined || body.priceListId === null) return undefined;
  const n = Number(body.priceListId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function listExists(id: number): Promise<boolean> {
  const rows = await db
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, id))
    .limit(1);
  return rows.length > 0;
}

// Lista pozycji cennika. Bez ?listId= — pozycje cennika domyślnego
// (zgodność wsteczna ze starym frontem i wycenami).
app.get("/", async (c) => {
  const raw = c.req.query("listId");
  let listId: number;
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy listId" },
        400
      );
    }
    if (!(await listExists(n))) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie znaleziono cennika" },
        404
      );
    }
    listId = n;
  } else {
    listId = await ensureDefaultListId();
  }

  // ?kind=service|material — filtr rodzaju (automat realizacji i formularz wyceny).
  const kindRaw = c.req.query("kind");
  if (kindRaw && !(PRICE_ITEM_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: `Parametr kind: dozwolone ${PRICE_ITEM_KINDS.join(", ")}` },
      400
    );
  }

  const where = kindRaw
    ? and(eq(schema.priceList.priceListId, listId), eq(schema.priceList.kind, kindRaw as PriceItemKind))
    : eq(schema.priceList.priceListId, listId);

  const rows = await db
    .select()
    .from(schema.priceList)
    .where(where)
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id));
  return c.json({ success: true, data: rows });
});

// Nowa pozycja
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const wanted = readListId(body);
  if (wanted === null) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy priceListId" },
      400
    );
  }
  const listId = wanted ?? (await ensureDefaultListId());
  if (wanted !== undefined && !(await listExists(listId))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  if (!data.position) {
    const rows = await db
      .select()
      .from(schema.priceList)
      .where(eq(schema.priceList.priceListId, listId));
    data.position = rows.length + 1;
  }

  const result = await db
    .insert(schema.priceList)
    .values({
      ...data,
      kind: data.kind ?? inferKind(data.unit ?? ""),
      priceListId: listId,
    } as NewPriceItem)
    .returning();

  return c.json(
    { success: true, data: result[0], message: "Pozycja cennika dodana" },
    201
  );
});

// Edycja pozycji (z możliwością przeniesienia do innego cennika)
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pozycji cennika" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const { data, error } = parseBody(body);
  if (error || !data) {
    return c.json<ApiResponse<null>>({ success: false, error }, 400);
  }

  const wanted = readListId(body);
  if (wanted === null) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy priceListId" },
      400
    );
  }
  if (wanted !== undefined && !(await listExists(wanted))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono cennika" },
      404
    );
  }

  const result = await db
    .update(schema.priceList)
    .set({
      ...data,
      ...(wanted === undefined ? {} : { priceListId: wanted }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.priceList.id, id))
    .returning();

  return c.json({
    success: true,
    data: result[0],
    message: "Pozycja cennika zaktualizowana",
  });
});

// Usunięcie pozycji
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.priceList)
    .where(eq(schema.priceList.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono pozycji cennika" },
      404
    );
  }

  await db.delete(schema.priceList).where(eq(schema.priceList.id, id));

  return c.json<ApiResponse<null>>({ success: true, message: "Pozycja usunięta" });
});

export default app;
export { ensureDefaultListId };
