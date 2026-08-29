import { Hono } from "hono";
import type { Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, like, desc, asc } from "drizzle-orm";
import { ensureDefaultListId } from "./pricelist.js";
import type { ApiResponse } from "../types/index.js";
import { PRICE_ITEM_KINDS } from "../db/schema.js";
import type { CalendarEvent, Quote, Realization } from "../db/schema.js";
import { buildQuotePrefill } from "../lib/quote-prefill.js";
import { resolveObjectId } from "../lib/object-identity.js";
import { buildProtocolPrefill, parseProtocolItems } from "../lib/protocol-prefill.js";
import { matchPriceItem, resolveHourRate, resolveKmRate } from "../lib/price-match.js";
import { getCompanyConfig } from "../lib/company-config.js";
import { logActivity, type ActivityUser } from "../lib/activity-log.js";
import type { PriceItem } from "../db/schema.js";

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

// Typ transakcji drizzle/better-sqlite3 — pozwala współdzielić helpery między db i tx.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Kolejny numer wyceny w miesiącu: W/RRRR/MM/NNN — synchronicznie, w obrębie
 * transakcji. Odpowiednik `nextProtocolNumberSync`: alokacja numeru i insert muszą
 * być atomowe, inaczej równoległe zapisy kolidują na UNIQUE(number).
 */
export function nextQuoteNumberSync(tx: Tx, date: string): string {
  const prefix = `W/${date.slice(0, 4)}/${date.slice(5, 7)}/`;
  const existing = tx
    .select({ number: schema.quotes.number })
    .from(schema.quotes)
    .where(like(schema.quotes.number, `${prefix}%`))
    .all();
  const maxSeq = existing.reduce((max, r) => {
    const n = parseInt(r.number.slice(prefix.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

/**
 * Tworzy wycenę (szkic) dla PŁATNEJ realizacji i zwraca ją. Pozycje, adres i datę
 * daje `buildQuotePrefill` (wydarzenie → obiekt → kontrahent → cennik technika).
 * Idempotentne po `realization_id` — powtórne wywołanie dla tej samej realizacji
 * zwraca `undefined` (sprawdzamy to zapytaniem, bo indeks `quotes_realization_id_uidx`
 * jest częściowy, a takiego celu SQLite nie przyjmuje w klauzuli ON CONFLICT).
 *
 * `event` przekazuje wołający, który tworzy realizację z wydarzenia: `calendar_events
 * .realization_id` jest wtedy jeszcze puste, więc wydarzenia nie dałoby się odszukać.
 */
export function createQuoteForRealizationSync(
  tx: Tx,
  r: Realization,
  event?: CalendarEvent | null
) {
  const existing = tx
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(eq(schema.quotes.realizationId, r.id))
    .get();
  if (existing) return undefined;

  const { values } = buildQuotePrefill(tx, r, { event });
  // Tożsamość wyceny dziedziczy się po realizacji (a gdy ta nie ma jeszcze FK —
  // po wydarzeniu, które ją tworzy). `site` obok jest tylko migawką nazwy na dokument.
  const objectId = resolveObjectId(tx, r, { events: event ? [event] : undefined })?.id ?? null;
  return tx
    .insert(schema.quotes)
    .values({
      number: nextQuoteNumberSync(tx, values.date),
      date: values.date,
      objectId,
      site: values.site,
      address: values.address,
      items: JSON.stringify(values.items),
      realizationId: r.id,
    })
    .returning()
    .get();
}

/**
 * Wycena „nietknięta” — żadna pozycja nie ma wpisanej ilości, więc automat może ją
 * usunąć (zmiana rozliczenia z płatnego, anulowanie wydarzenia). Wycena z choćby
 * jedną ilością to praca człowieka: zostaje.
 */
export function isQuoteUntouched(q: Pick<Quote, "items">): boolean {
  let items: QuoteItem[] = [];
  try {
    items = JSON.parse(q.items);
  } catch {
    return true;
  }
  return !items.some((i) => num(i.qty) > 0);
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
 * Obiekt wyceny z body — WYŁĄCZNIE po `objectId`, nigdy po nazwie z `site`.
 * `site` jest migawką nazwy na dokument i nie ma prawa decydować o tożsamości
 * (patrz src/lib/object-identity.ts).
 *
 * `undefined` w wyniku = body w ogóle nie ruszało obiektu (zostaw jak było).
 * Nieistniejące id odrzucamy zamiast zapisywać po cichu NULL — wycena bez obiektu
 * jest prawidłowym stanem, ale wycena „przypisana do obiektu, którego nie ma" nie.
 */
function objectIdFromBody(
  body: Record<string, unknown>
): { objectId?: number | null } | { error: string } {
  if (!("objectId" in body)) return {};
  const raw = body.objectId;
  if (raw === null || raw === "") return { objectId: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: "Nieprawidłowy identyfikator obiektu" };
  const found = db.select({ id: schema.objects.id }).from(schema.objects).where(eq(schema.objects.id, id)).get();
  if (!found) return { error: `Obiekt #${id} nie istnieje` };
  return { objectId: id };
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

  let rows = await query.orderBy(desc(schema.quotes.date), desc(schema.quotes.id));

  // ?q= — szukajka (numer / obiekt / adres / data), ?limit= — np. lista w dialogu kalendarza
  const q = (c.req.query("q") || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      [r.number, r.site, r.address, r.date].some((v) => v != null && String(v).toLowerCase().includes(q))
    );
  }
  const limit = Number(c.req.query("limit"));
  if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit);

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

  // Obiekt od razu przy tworzeniu — inaczej wycena wolnostojąca nigdy nie dostanie
  // tożsamości i zostanie z samą nazwą w `site`.
  const objectPick = objectIdFromBody(body);
  if ("error" in objectPick) {
    return c.json<ApiResponse<null>>({ success: false, error: objectPick.error }, 400);
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
          objectId: objectPick.objectId ?? null,
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

  // Tożsamość obiektu. Wycena PRZYPIĘTA do realizacji dziedziczy ją po realizacji —
  // to jedno źródło prawdy, a rozjazd wycena ↔ realizacja jest dokładnie tym błędem,
  // którego pilnuje scripts/test-object-identity.ts. Klient nie może go wprowadzić
  // ręcznie; wolnostojąca wycena dostaje obiekt z body (po id, nigdy po nazwie).
  let objectId: number | null | undefined;
  if (existing[0].realizationId != null) {
    const r = db
      .select({ id: schema.realizations.id, objectId: schema.realizations.objectId })
      .from(schema.realizations)
      .where(eq(schema.realizations.id, existing[0].realizationId))
      .get();
    objectId = r ? resolveObjectId(db, r)?.id ?? null : existing[0].objectId;
  } else {
    const objectPick = objectIdFromBody(body);
    if ("error" in objectPick) {
      return c.json<ApiResponse<null>>({ success: false, error: objectPick.error }, 400);
    }
    objectId = objectPick.objectId;
  }

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
      ...(objectId !== undefined ? { objectId } : {}),
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

  // Najpierw zdejmujemy jawne przypięcia w kalendarzu — FK `calendar_events.quote_id`
  // powstał przez ALTER TABLE, więc nie wszędzie ma ON DELETE SET NULL.
  await db
    .update(schema.calendarEvents)
    .set({ quoteId: null })
    .where(eq(schema.calendarEvents.quoteId, id));
  await db.delete(schema.quotes).where(eq(schema.quotes.id, id));
  return c.json<ApiResponse<null>>({ success: true, message: "Wycena usunięta" });
});

export default app;

// ---------------------------------------------------------------------------
// Wycena z protokołu
// ---------------------------------------------------------------------------

/**
 * Pozycje wyceny wyliczone z PROTOKOŁU (a nie ze zrzutu całego cennika):
 *   - materiały: pozycje protokołu z podaną ilością, wycenione po cenniku technika
 *     (+ narzut `company.material_markup`); pozycja bez odpowiednika w cenniku wchodzi
 *     z pustą ceną i ostrzeżeniem — lepiej, żeby człowiek ją zobaczył, niż zniknęła,
 *   - robocizna: godziny z protokołu × stawka RBH (schodkowa „pierwsza/kolejna”, gdy
 *     cennik ją rozbija), a gdy cennik nie ma pozycji RBH — `company.rate_hour`,
 *   - dojazd: km z protokołu × stawka KM z cennika albo `company.rate_km`.
 *
 * Nic nie zapisuje. Zwraca też ostrzeżenia — trafiają do activity_log i do odpowiedzi API.
 */
export function quoteItemsFromProtocol(
  dbx: typeof db | Tx,
  realization: Realization,
  protocol: { number: string; items: string; actualHours: number; actualKm: number }
): { items: QuoteItem[]; warnings: string[] } {
  const { values } = getCompanyConfig();
  const warnings: string[] = [];
  const items: QuoteItem[] = [];

  const { context } = buildProtocolPrefill(dbx, realization);
  const priceList = context.priceList;
  const priceItems: PriceItem[] = priceList
    ? dbx
        .select()
        .from(schema.priceList)
        .where(and(eq(schema.priceList.priceListId, priceList.id), eq(schema.priceList.active, true)))
        .orderBy(asc(schema.priceList.position), asc(schema.priceList.id))
        .all()
    : [];
  const materials = priceItems.filter((i) => i.kind === "material");
  const money = (n: number) => String(Math.round(n * 100) / 100);
  const qty = (n: number) => String(Math.round(n * 100) / 100);

  // --- materiały z protokołu -------------------------------------------------
  for (const it of parseProtocolItems(protocol.items)) {
    const amount = num(it.qty);
    if (!(amount > 0) || !it.name.trim()) continue;
    const match = matchPriceItem(it.name, materials);
    if (!match) {
      warnings.push(
        `Materiał „${it.name}” — brak pozycji rodzaju „materiał”${
          priceList ? ` w cenniku „${priceList.name}”` : ""
        }; cena do uzupełnienia.`
      );
      items.push({ name: it.name, qty: qty(amount), unit: it.unit, price: "" });
      continue;
    }
    const price = match.price * (1 + values.materialMarkup / 100);
    items.push({ name: match.name, qty: qty(amount), unit: match.unit || it.unit, price: money(price) });
  }

  // --- robocizna -------------------------------------------------------------
  if (protocol.actualHours > 0) {
    const rate = resolveHourRate(priceItems, values);
    if (!rate) {
      warnings.push(
        "Brak stawki RBH: cennik nie ma pozycji usługowej z jednostką RBH, a `Stawka za roboczogodzinę` w ustawieniach firmy jest zerowa."
      );
    } else if (rate.mode === "tiered") {
      items.push({ name: rate.firstName, qty: "1", unit: "RBH", price: money(rate.first) });
      const rest = Math.round(Math.max(0, protocol.actualHours - 1) * 100) / 100;
      if (rest > 0) {
        items.push({ name: rate.nextName, qty: qty(rest), unit: "RBH", price: money(rate.next) });
      }
    } else {
      items.push({
        name: rate.mode === "flat" ? rate.itemName : "Robocizna",
        qty: qty(protocol.actualHours),
        unit: "RBH",
        price: money(rate.rate),
      });
    }
  }

  // --- dojazd ----------------------------------------------------------------
  if (protocol.actualKm > 0) {
    const kmRate = resolveKmRate(priceItems, values);
    if (!kmRate) {
      warnings.push("Brak stawki za km: cennik nie ma pozycji usługowej KM, a `Stawka za kilometr` jest zerowa.");
    } else {
      items.push({
        name: kmRate.itemName ?? "Dojazd",
        qty: qty(protocol.actualKm),
        unit: "km",
        price: money(kmRate.rate),
      });
    }
  }

  return { items, warnings };
}

export type QuoteRefreshStatus = "updated" | "no_quote" | "no_protocol" | "touched" | "empty";

export interface QuoteRefreshOutcome {
  status: QuoteRefreshStatus;
  quoteId?: number;
  number?: string;
  items?: QuoteItem[];
  warnings: string[];
}

/**
 * Przelicza wycenę realizacji z jej protokołu — wołane po podpisaniu protokołu.
 *
 * Wycena, w której ktoś wpisał choć jedną ilość, jest pracą człowieka i zostaje nietknięta
 * (`isQuoteUntouched` — ta sama zasada, co przy usuwaniu wyceny przez automat kalendarza).
 * Wyceny nie tworzymy: jeśli realizacja jej nie ma (praca gwarancyjna/darmowa albo wyłączone
 * `calendar.auto_quote`), nie ma czego odświeżać.
 */
export function refreshQuoteFromProtocolSync(
  tx: Tx,
  realizationId: number,
  user: ActivityUser
): QuoteRefreshOutcome {
  const quote = tx
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.realizationId, realizationId))
    .get();
  if (!quote) return { status: "no_quote", warnings: [] };
  if (!isQuoteUntouched(quote)) {
    return { status: "touched", quoteId: quote.id, number: quote.number, warnings: [] };
  }

  const protocol = tx
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationId))
    .get();
  if (!protocol) return { status: "no_protocol", quoteId: quote.id, number: quote.number, warnings: [] };

  const realization = tx
    .select()
    .from(schema.realizations)
    .where(eq(schema.realizations.id, realizationId))
    .get();
  if (!realization) return { status: "no_protocol", quoteId: quote.id, number: quote.number, warnings: [] };

  const { items, warnings } = quoteItemsFromProtocol(tx, realization, protocol);
  if (items.length === 0) {
    return { status: "empty", quoteId: quote.id, number: quote.number, warnings };
  }

  tx.update(schema.quotes)
    .set({ items: JSON.stringify(items), updatedAt: new Date().toISOString() })
    .where(eq(schema.quotes.id, quote.id))
    .run();

  logActivity(tx, {
    entityType: "quote",
    entityId: quote.id,
    user,
    action: "updated",
    field: "items",
    oldValue: null,
    newValue: JSON.stringify(items.map((i) => i.name)),
    summary: `Wyceniono z protokołu ${protocol.number}: ${items.length} ${
      items.length === 1 ? "pozycja" : "pozycji"
    }${warnings.length > 0 ? ` (${warnings.length} do sprawdzenia)` : ""}`,
    summarySuffix: "(przez automat)",
  });

  return { status: "updated", quoteId: quote.id, number: quote.number, items, warnings };
}
