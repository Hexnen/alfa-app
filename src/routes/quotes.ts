import { Hono } from "hono";
import type { Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, like, desc, asc } from "drizzle-orm";
import { ensureDefaultListId } from "./pricelist.js";
import type { ApiResponse } from "../types/index.js";
import { PRICE_ITEM_KINDS } from "../db/schema.js";
import type { Quote } from "../db/schema.js";

const app = new Hono();

export interface QuoteItem {
  name: string;
  qty: string; // ilość (tekst — może być puste)
  unit: string;
  price: string; // cena netto
}

/** Kolejny numer wyceny w miesiącu: W/RRRR/MM/NNN */
async function nextQuoteNumber(date: string): Promise<string> {
  const prefix = `W/${date.slice(0, 4)}/${date.slice(5, 7)}/`;
  const existing = await db
    .select({ number: schema.quotes.number })
    .from(schema.quotes)
    .where(like(schema.quotes.number, `${prefix}%`));
  const maxSeq = existing.reduce((max, r) => {
    const n = parseInt(r.number.slice(prefix.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

const num = (v: unknown) => {
  const n =
    typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function withComputed(q: Quote) {
  let items: QuoteItem[] = [];
  try {
    items = JSON.parse(q.items);
  } catch {
    items = [];
  }
  const total =
    Math.round(items.reduce((a, i) => a + num(i.qty) * num(i.price), 0) * 100) /
    100;
  return { ...q, items, total };
}

function parseItems(body: Record<string, unknown>): QuoteItem[] | undefined {
  if (!Array.isArray(body.items)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return body.items
    .filter(
      (i): i is Record<string, unknown> => typeof i === "object" && i !== null
    )
    .map((i) => ({
      name: str(i.name),
      qty: str(i.qty),
      unit: str(i.unit),
      price: str(i.price),
    }));
}

/**
 * Cennik, z którego prefillujemy nową wycenę. Wycena nie ma w modelu technika,
 * więc kontekst przychodzi z zewnątrz — kolejność źródeł:
 * 1. jawny `priceListId` (body lub `?priceListId=`) — wybór cennika w UI,
 * 2. `technicianId` (body lub query) → cennik przypisany temu technikowi,
 * 3. cennik główny (`is_default = 1`).
 * Nieistniejące id po cichu spada do cennika głównego — prefill to wygoda,
 * nie ma sensu blokować tworzenia wyceny.
 */
async function resolvePrefillListId(
  c: Context,
  body: Record<string, unknown>
): Promise<number> {
  const pick = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  const explicit = pick(body.priceListId) ?? pick(c.req.query("priceListId"));
  if (explicit) {
    const found = await db
      .select({ id: schema.priceLists.id })
      .from(schema.priceLists)
      .where(eq(schema.priceLists.id, explicit))
      .limit(1);
    if (found.length > 0) return found[0].id;
  }

  const technicianId = pick(body.technicianId) ?? pick(c.req.query("technicianId"));
  if (technicianId) {
    const tech = await db
      .select({ priceListId: schema.technicians.priceListId })
      .from(schema.technicians)
      .where(eq(schema.technicians.id, technicianId))
      .limit(1);
    if (tech.length > 0 && tech[0].priceListId) {
      const found = await db
        .select({ id: schema.priceLists.id })
        .from(schema.priceLists)
        .where(eq(schema.priceLists.id, tech[0].priceListId))
        .limit(1);
      if (found.length > 0) return found[0].id;
    }
  }

  return ensureDefaultListId();
}

// Lista wycen (opcjonalny filtr rok/miesiąc po dacie)
app.get("/", async (c) => {
  const year = c.req.query("year");
  const month = c.req.query("month");

  let query = db.select().from(schema.quotes);
  if (year && month) {
    query = query.where(
      like(
        schema.quotes.date,
        `${year}-${String(parseInt(month)).padStart(2, "0")}-%`
      )
    ) as typeof query;
  } else if (year) {
    query = query.where(like(schema.quotes.date, `${year}-%`)) as typeof query;
  }

  const rows = await query.orderBy(desc(schema.quotes.date), desc(schema.quotes.id));
  return c.json({ success: true, data: rows.map(withComputed) });
});

// Nowa wycena — pozycje startowe z aktywnego cennika
app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const date =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);

  // Opcjonalny `?kind=service|material` zawęża prefill do jednego rodzaju pozycji;
  // bez parametru zachowanie jest jak dotąd — wszystkie aktywne pozycje cennika.
  const kindRaw = c.req.query("kind");
  if (kindRaw && !(PRICE_ITEM_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: `Parametr kind: dozwolone ${PRICE_ITEM_KINDS.join(", ")}` },
      400
    );
  }

  let items = parseItems(body);
  if (!items || items.length === 0) {
    const listId = await resolvePrefillListId(c, body);
    const priceRows = await db
      .select()
      .from(schema.priceList)
      .where(eq(schema.priceList.priceListId, listId))
      .orderBy(asc(schema.priceList.position), asc(schema.priceList.id));
    items = priceRows
      .filter((p) => p.active && (!kindRaw || p.kind === kindRaw))
      .map((p) => ({
        name: p.name,
        qty: "",
        unit: p.unit,
        price: String(p.price),
      }));
  }

  // nextQuoteNumber() reads max(seq) and the insert happens at a later await
  // boundary, so two concurrent creates can compute the same number and collide
  // on the quotes.number UNIQUE constraint. Recompute + retry on a UNIQUE
  // violation instead of surfacing a raw 500 and losing the quote.
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await db
        .insert(schema.quotes)
        .values({
          number: await nextQuoteNumber(date),
          date,
          site: typeof body.site === "string" ? body.site : "",
          address: typeof body.address === "string" ? body.address : "",
          items: JSON.stringify(items),
        })
        .returning();
      break;
    } catch (err) {
      if (
        attempt < 5 &&
        err instanceof Error &&
        (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        continue;
      }
      throw err;
    }
  }

  return c.json(
    { success: true, data: withComputed(result[0]), message: "Wycena utworzona" },
    201
  );
});

// Edycja wyceny
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wyceny" },
      404
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const date = typeof body.date === "string" ? body.date : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowa data" },
      400
    );
  }
  const items = parseItems(body);

  // Optimistic concurrency: when the client echoes the updatedAt it read, only
  // update if the row has not changed since, otherwise 409 so it reloads. Two
  // users editing the same quote no longer silently clobber each other.
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string"
      ? body.expectedUpdatedAt
      : undefined;

  const result = await db
    .update(schema.quotes)
    .set({
      date: date || existing[0].date,
      site: typeof body.site === "string" ? body.site : existing[0].site,
      address:
        typeof body.address === "string" ? body.address : existing[0].address,
      ...(items !== undefined ? { items: JSON.stringify(items) } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      expectedUpdatedAt
        ? and(
            eq(schema.quotes.id, id),
            eq(schema.quotes.updatedAt, expectedUpdatedAt)
          )
        : eq(schema.quotes.id, id)
    )
    .returning();

  if (result.length === 0) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Wycena została zmieniona przez innego użytkownika. Odśwież i spróbuj ponownie.",
      },
      409
    );
  }

  return c.json({
    success: true,
    data: withComputed(result[0]),
    message: "Wycena zapisana",
  });
});

// Usunięcie wyceny
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie znaleziono wyceny" },
      404
    );
  }

  await db.delete(schema.quotes).where(eq(schema.quotes.id, id));
  return c.json<ApiResponse<null>>({ success: true, message: "Wycena usunięta" });
});

export default app;
