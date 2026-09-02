/**
 * Oferty (/api/offers) — dokument handlowy dla klienta, składany z pakietów.
 *
 * Model i słownik pojęć: patrz blok „OFERTY" w src/db/schema.ts.
 * Arytmetyka: src/lib/offer-calc.ts. Rozwijanie pakietów: src/lib/offer-packages.ts.
 * Ten plik to wyłącznie warstwa HTTP, transakcje i uprawnienia.
 *
 * DWIE ZASADY, KTÓRE TRZYMAJĄ TEN MODUŁ:
 *
 * 1. ZAMROŻENIE. Oferty wysłanej do klienta nie wolno po cichu zmienić —
 *    mutacje treści zwracają 409, a zmiany robi się przez nową WERSJĘ
 *    (`POST /:id/version`). Dzięki temu papier u klienta zawsze da się
 *    odtworzyć co do złotówki.
 *
 * 2. KOSZTY SĄ WRAŻLIWE. Dokument w wersji wewnętrznej pokazuje ceny zakupu
 *    i marżę na kliencie. Kto nie ma klucza `technical/oferty-koszty`, nie
 *    dostaje tych pól W ODPOWIEDZI API — nie chodzi o ukrycie ich w UI, bo
 *    JSON i tak leży w narzędziach przeglądarki.
 *
 * Wszystkie kwoty NETTO.
 */
import { Hono, type Context } from "hono";
import { db, schema } from "../db/index.js";
import { eq, and, asc, desc, like, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { ApiResponse } from "../types/index.js";
import {
  OFFER_ITEM_BILLINGS,
  OFFER_ITEM_KINDS,
  OFFER_ITEM_SOURCES,
  OFFER_KINDS,
  OFFER_LEASE_MODES,
  OFFER_PACKAGE_MODES,
  OFFER_QTY_ROUNDINGS,
  OFFER_SECTION_CATEGORIES,
  OFFER_STATUSES,
  type NewOffer,
  type NewOfferPackage,
  type Offer,
  type OfferItem,
  type OfferItemBilling,
  type OfferItemKind,
  type OfferItemSource,
  type OfferKind,
  type OfferLeaseMode,
  type OfferPackageMode,
  type OfferQtyRounding,
  type OfferSection,
  type OfferSectionCategory,
  type OfferStatus,
} from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { canView } from "../lib/auth/permissions.js";
import { getCompanyConfig } from "../lib/company-config.js";
import { effectiveSalePrice, round2 } from "../lib/margin.js";
import { computeOffer, type OfferTotals } from "../lib/offer-calc.js";
import {
  expandPackage,
  parseParamValues,
  type OfferItemDraft,
  type PriceSource,
} from "../lib/offer-packages.js";
import { logActivity, logFieldDiffs } from "../lib/activity-log.js";
import { createDocumentSync } from "./warehouse.js";
import { generateOrderNumber } from "../services/orders.js";

const app = new Hono();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Jak w magazynie: błąd walidacji rzucany ze środka synchronicznej transakcji. */
class ApiError extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonError(c: Context, status: 400 | 403 | 404 | 409, error: string) {
  return c.json<ApiResponse<null>>({ success: false, error }, status);
}

/**
 * Opakowanie handlera: ApiError → właściwy kod HTTP, reszta błędów leci wyżej
 * do globalnego `app.onError`. Dzięki temu walidacja może rzucać ze środka
 * synchronicznej transakcji, a rollback dzieje się sam.
 */
async function guard(
  c: Context,
  fn: () => Response | Promise<Response>
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return jsonError(c, err.status, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Walidacja wejścia (ręczna — zod nie jest w tym repo używany w trasach CRUD)
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optDate(v: unknown, label: string): string | null {
  const s = str(v);
  if (!s) return null;
  if (!ISO_DATE_RE.test(s)) throw new ApiError(400, `${label}: oczekiwano daty RRRR-MM-DD`);
  return s;
}

/** Liczba ≥ 0; pusto = `fallback`. Przecinek dziesiętny dozwolony. */
function num(v: unknown, label: string, fallback: number | null = null): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${label} musi być liczbą nieujemną`);
  return round2(n);
}

/**
 * Liczba o precyzji WIĘKSZEJ niż grosze — ilości i mnożniki pakietu.
 *
 * `num()` zaokrągla do dwóch miejsc, bo służy kwotom. Dla mnożnika pakietu to
 * błąd kosztujący pieniądze: „jeden rejestrator na każde 8 kamer" to 0,125,
 * a po zaokrągleniu do 0,13 osiem kamer wymagałoby już dwóch rejestratorów.
 */
function qtyNum(v: unknown, label: string, fallback: number | null = null): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${label} musi być liczbą nieujemną`);
  return Math.round(n * 1e6) / 1e6;
}

function pct(v: unknown, label: string, fallback = 0): number {
  const n = num(v, label, fallback);
  if (n === null) return fallback;
  if (n > 100) throw new ApiError(400, `${label} nie może przekraczać 100%`);
  return n;
}

function optId(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Nieprawidłowy ${label}`);
  return n;
}

function requireId(raw: string | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Nieprawidłowy ${label}`);
  return n;
}

function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  const s = str(v);
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

// ---------------------------------------------------------------------------
// Numeracja: OF/RRRR/MM/NNN, wersje z sufiksem „-wN"
// ---------------------------------------------------------------------------

/**
 * Kolejny numer oferty w miesiącu. Wzorzec 1:1 z `nextQuoteNumberSync`
 * (src/routes/quotes.ts): alokacja numeru i insert MUSZĄ być w jednej
 * transakcji, inaczej równoległe zapisy kolidują na UNIQUE(number).
 *
 * Numery wersji („…-w2") są przy porównaniu odcinane, żeby wersja oferty
 * nie zajmowała kolejnego numeru w miesiącu.
 */
export function nextOfferNumberSync(tx: Tx, date: string): string {
  const prefix = `OF/${date.slice(0, 4)}/${date.slice(5, 7)}/`;
  const existing = tx
    .select({ number: schema.offers.number })
    .from(schema.offers)
    .where(like(schema.offers.number, `${prefix}%`))
    .all();
  const maxSeq = existing.reduce((max, r) => {
    const tail = r.number.slice(prefix.length).split("-")[0];
    const n = parseInt(tail);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
}

/** Numer kolejnej wersji: OF/2026/08/001 → OF/2026/08/001-w2. */
function versionNumber(baseNumber: string, version: number): string {
  const base = baseNumber.split("-w")[0];
  return `${base}-w${version}`;
}

// ---------------------------------------------------------------------------
// Ceny ze źródeł (magazyn, usługi)
// ---------------------------------------------------------------------------

/**
 * Buduje `PriceSource` z aktualnych kartotek. Ładujemy komplet za jednym razem:
 * katalogi są małe (setki pozycji), a pakiet i tak sięga po wiele indeksów naraz.
 */
function priceSourceSync(
  dbx: DbOrTx,
  markupPct: number
): PriceSource & {
  /** Wiek ceny w kartotece towaru; poza `PriceSource`, bo pakietom niepotrzebny. */
  priceUpdatedAt: (
    source: OfferItemSource,
    refId: number | null
  ) => string | null;
} {
  const items = dbx.select().from(schema.warehouseItems).all();
  const svcs = dbx.select().from(schema.services).all();
  const byItem = new Map(items.map((i) => [i.id, i]));
  const bySvc = new Map(svcs.map((s) => [s.id, s]));

  return {
    cost: (source, id) => {
      if (id === null) return null;
      if (source === "warehouse") return byItem.get(id)?.purchasePrice ?? null;
      if (source === "service") return bySvc.get(id)?.cost ?? null;
      return null;
    },
    price: (source, id) => {
      if (id === null) return null;
      if (source === "warehouse") {
        const it = byItem.get(id);
        return it ? effectiveSalePrice(it, markupPct) : null;
      }
      if (source === "service") return bySvc.get(id)?.price ?? null;
      return null;
    },
    label: (source, id) => {
      if (id === null) return null;
      if (source === "warehouse") {
        const it = byItem.get(id);
        return it ? { name: it.name, unit: it.unit } : null;
      }
      if (source === "service") {
        const s = bySvc.get(id);
        return s ? { name: s.name, unit: s.unit } : null;
      }
      return null;
    },
    priceUpdatedAt: (source, id) => {
      if (id === null) return null;
      if (source === "warehouse") return byItem.get(id)?.priceUpdatedAt ?? null;
      if (source === "service") return bySvc.get(id)?.priceUpdatedAt ?? null;
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Zamrożenie i status wyliczany
// ---------------------------------------------------------------------------

/** Statusy, w których treści oferty nie wolno już zmieniać. */
const FROZEN_STATUSES: OfferStatus[] = ["sent", "accepted", "rejected"];

function assertEditable(offer: Offer) {
  if (FROZEN_STATUSES.includes(offer.status)) {
    throw new ApiError(
      409,
      `Oferta ${offer.number} jest zamknięta (${offer.status}) — utwórz nową wersję zamiast ją zmieniać`
    );
  }
}

/**
 * Status pokazywany na zewnątrz. „expired" WYLICZAMY z `validUntil`, zamiast
 * zapisywać zadaniem w tle: pole i tak trzeba przeczytać, a cron dokładałby
 * ruchomą część, która potrafi nie działać niezauważenie.
 */
function effectiveStatus(offer: Pick<Offer, "status" | "validUntil">, today: string): OfferStatus {
  if (offer.status !== "sent") return offer.status;
  if (offer.validUntil && offer.validUntil < today) return "expired";
  return offer.status;
}

function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Ukrywanie kosztów
// ---------------------------------------------------------------------------

/** Czy użytkownik może oglądać koszty i marżę na ofertach. */
function canSeeCosts(c: Context): boolean {
  const user = getUser(c);
  return !!user && canView(user, "technical/oferty-koszty");
}

const COST_FIELDS = [
  "unitCost",
  "lineCost",
  "oneTimeCost",
  "oneTimeCostMaterial",
  "oneTimeCostLabour",
  "monthlyCost",
  "horizonCost",
  "margin",
  "belowMinMargin",
  // Prowizja i zysk firmy to liczby wewnętrzne — jadą tą samą ścieżką co koszty.
  "salesCommissionPct",
  "salesCommission",
  "companyProfit",
  "companyProfitPct",
] as const;

/**
 * Usuwa pola kosztowe z gotowej odpowiedzi.
 *
 * `API_TAB_MAP` działa na prefiksach tras, więc nie zasłoni pojedynczych pól —
 * robimy to tutaj, na krawędzi. Czyścimy REKURENCYJNIE, bo koszty siedzą
 * i w podsumowaniu oferty, i na każdej pozycji.
 */
function redactCosts<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map((v) => redactCosts(v)) as unknown as T;
  if (payload && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if ((COST_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = redactCosts(v);
    }
    return out as T;
  }
  return payload;
}

/** Zwraca dane, przycinając koszty, gdy użytkownik nie ma do nich prawa. */
function respond<T>(c: Context, data: T, message?: string, status = 200) {
  const payload = canSeeCosts(c) ? data : redactCosts(data);
  return c.json({ success: true, data: payload, ...(message ? { message } : {}) }, status as 200);
}

// ---------------------------------------------------------------------------
// Odczyt oferty z policzonymi sumami
// ---------------------------------------------------------------------------

export interface OfferDetail {
  offer: Offer & { status: OfferStatus; leaseMonthsEffective: number | null };
  sections: OfferSection[];
  items: (OfferItem & {
    lineTotal: number;
    lineCost: number | null;
    /** Stan magazynowy towaru (suma po magazynach) — null dla pozycji nietowarowych. */
    stock: number | null;
    /** Aktualna cena w kartotece, gdy odjechała od migawki na ofercie. */
    priceDrift: number | null;
    /**
     * Kiedy w kartotece (towaru albo usługi) ostatnio zmieniła się cena —
     * sygnał, że pozycja jest wyceniona ze starego cennika, nawet gdy
     * `priceDrift` jest pusty (cena w kartotece też mogła nie być od dawna
     * potwierdzana). null dla pozycji wpisanych ręcznie, bez źródła.
     */
    priceUpdatedAt: string | null;
  })[];
  totals: OfferTotals;
}

function loadOfferSync(dbx: DbOrTx, id: number): OfferDetail {
  const offer = dbx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
  if (!offer) throw new ApiError(404, "Nie znaleziono oferty");

  const sections = dbx
    .select()
    .from(schema.offerSections)
    .where(eq(schema.offerSections.offerId, id))
    .orderBy(asc(schema.offerSections.position), asc(schema.offerSections.id))
    .all();

  const items = dbx
    .select()
    .from(schema.offerItems)
    .where(eq(schema.offerItems.offerId, id))
    .orderBy(asc(schema.offerItems.position), asc(schema.offerItems.id))
    .all();

  const { values } = getCompanyConfig();
  /*
   * Stawka prowizji jest w kartotece handlowca, nie na ofercie — bierzemy ją
   * przy odczycie, żeby zmiana stawki od razu przeliczała otwarte dokumenty
   * (tak samo jak narzut magazynowy przelicza ceny).
   */
  const salesCommissionPct =
    offer.salespersonId === null
      ? null
      : (dbx
          .select({ rate: schema.salespeople.commissionRate })
          .from(schema.salespeople)
          .where(eq(schema.salespeople.id, offer.salespersonId))
          .all()[0]?.rate ?? null);
  const totals = computeOffer(
    offer,
    sections,
    items,
    values.minMarginPct,
    salesCommissionPct
  );

  // Stany magazynowe i rozjazd cen — wyłącznie dla pozycji towarowych.
  const warehouseIds = items
    .map((i) => i.warehouseItemId)
    .filter((v): v is number => v !== null);
  const stockByItem = new Map<number, number>();
  if (warehouseIds.length) {
    const rows = dbx
      .select()
      .from(schema.warehouseStock)
      .where(inArray(schema.warehouseStock.itemId, warehouseIds))
      .all();
    for (const r of rows) {
      stockByItem.set(r.itemId, (stockByItem.get(r.itemId) ?? 0) + r.quantity);
    }
  }
  const source = priceSourceSync(dbx, values.warehouseMarkup);

  return {
    offer: {
      ...offer,
      status: effectiveStatus(offer, todayISO()),
      leaseMonthsEffective:
        offer.leaseMode === "y1" ? 12 : offer.leaseMode === "y2" ? 24 : offer.leaseMonths,
    },
    sections,
    items: items.map((it) => {
      const refId = it.source === "warehouse" ? it.warehouseItemId : it.serviceId;
      const current = source.price(it.source, refId);
      return {
        ...it,
        lineTotal: round2(it.qty * it.unitPrice * (1 - it.discountPct / 100)),
        lineCost: it.unitCost === null ? null : round2(it.qty * it.unitCost),
        stock: it.warehouseItemId !== null ? stockByItem.get(it.warehouseItemId) ?? 0 : null,
        priceDrift:
          current !== null && Math.abs(current - it.unitPrice) > 0.005 ? current : null,
        priceUpdatedAt: source.priceUpdatedAt(it.source, refId),
      };
    }),
    totals,
  };
}

// ---------------------------------------------------------------------------
// PAKIETY — montowane PRZED `/:id`, bo „packages" pasowałoby do parametru
// ---------------------------------------------------------------------------

interface PackageItemInput {
  source: OfferItemSource;
  warehouseItemId: number | null;
  serviceId: number | null;
  name: string;
  unit: string;
  kind: OfferItemKind;
  billing: OfferItemBilling;
  qtyBase: number;
  qtyPerParam: number;
  paramKey: string | null;
  qtyRound: OfferQtyRounding;
  slot: string | null;
  paramMin: number | null;
  paramMax: number | null;
  unitPriceOverride: number | null;
}

function parsePackageItems(raw: unknown): PackageItemInput[] {
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null)
      throw new ApiError(400, `Pozycja ${i + 1}: oczekiwano obiektu`);
    const e = entry as Record<string, unknown>;
    const source = oneOf(e.source, OFFER_ITEM_SOURCES, "manual");
    const warehouseItemId = source === "warehouse" ? optId(e.warehouseItemId, "towar") : null;
    const serviceId = source === "service" ? optId(e.serviceId, "identyfikator usługi") : null;
    if (source === "warehouse" && warehouseItemId === null)
      throw new ApiError(400, `Pozycja ${i + 1}: wskaż towar z magazynu`);
    if (source === "service" && serviceId === null)
      throw new ApiError(400, `Pozycja ${i + 1}: wskaż usługę`);

    const name = str(e.name);
    if (source === "manual" && !name)
      throw new ApiError(400, `Pozycja ${i + 1}: pozycja ręczna musi mieć nazwę`);

    const slot = str(e.slot) || null;
    const paramMin = num(e.paramMin, `Pozycja ${i + 1}: początek zakresu`, null);
    const paramMax = num(e.paramMax, `Pozycja ${i + 1}: koniec zakresu`, null);
    // Zakres poza slotem nie miałby czego rozstrzygać — byłby drugim, cichym
    // mechanizmem warunkowania pozycji obok slotów. Pozycja warunkowa bez
    // alternatyw to slot z jednym wariantem i tak się ją zapisuje.
    if (!slot && (paramMin !== null || paramMax !== null))
      throw new ApiError(
        400,
        `Pozycja ${i + 1}: zakres działa tylko w slocie — nazwij slot albo wyczyść zakres`
      );
    if (paramMin !== null && paramMax !== null && paramMin > paramMax)
      throw new ApiError(
        400,
        `Pozycja ${i + 1}: zakres od ${paramMin} do ${paramMax} jest pusty — ta pozycja nigdy by nie weszła`
      );

    return {
      source,
      warehouseItemId,
      serviceId,
      name,
      unit: str(e.unit) || "szt",
      kind: oneOf(e.kind, OFFER_ITEM_KINDS, "material"),
      billing: oneOf(e.billing, OFFER_ITEM_BILLINGS, "one_time"),
      qtyBase: qtyNum(e.qtyBase, `Pozycja ${i + 1}: ilość stała`, 0) ?? 0,
      qtyPerParam: qtyNum(e.qtyPerParam, `Pozycja ${i + 1}: mnożnik parametru`, 0) ?? 0,
      paramKey: str(e.paramKey) || null,
      qtyRound: oneOf(e.qtyRound, OFFER_QTY_ROUNDINGS, "none"),
      slot,
      paramMin,
      paramMax,
      unitPriceOverride: num(e.unitPriceOverride, `Pozycja ${i + 1}: cena`, null),
    };
  });
  assertSlotRangesSane(parsed);
  return parsed;
}

/**
 * Sprawdza SLOTY pakietu: w jednej grupie wariantów zakresy nie mogą na siebie
 * nachodzić.
 *
 * Przy nakładających się zakresach `pickSlotVariants` bierze pierwszy pasujący
 * wiersz, więc drugi wariant nie wszedłby NIGDY — i to bez śladu. Lepiej nie
 * przyjąć takiego pakietu, niż wydać ofertę z cicho pominiętym rejestratorem.
 *
 * Dziury w pokryciu przepuszczamy: „poniżej czterech kamer nie dajemy
 * rejestratora" to sensowny przepis. Ostrzega o nich edytor pakietu.
 */
function assertSlotRangesSane(items: PackageItemInput[]) {
  const bySlot = new Map<string, { idx: number; it: PackageItemInput }[]>();
  items.forEach((it, idx) => {
    if (!it.slot) return;
    const group = bySlot.get(it.slot) ?? [];
    group.push({ idx, it });
    bySlot.set(it.slot, group);
  });

  for (const [slot, group] of bySlot) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const x = group[a];
        const y = group[b];
        // Przedziały domknięte: rozłączne są tylko wtedy, gdy jeden kończy się
        // PRZED początkiem drugiego. NULL = strona otwarta, czyli ±nieskończoność.
        const disjoint =
          (x.it.paramMax !== null && y.it.paramMin !== null && x.it.paramMax < y.it.paramMin) ||
          (y.it.paramMax !== null && x.it.paramMin !== null && y.it.paramMax < x.it.paramMin);
        if (!disjoint)
          throw new ApiError(
            400,
            `Slot „${slot}": zakresy pozycji ${x.idx + 1} i ${y.idx + 1} nachodzą na siebie — ` +
              "przy tej samej liczbie pasowałyby oba warianty, a wejdzie tylko pierwszy"
          );
      }
    }
  }
}

function parsePackageHead(body: Record<string, unknown>): Partial<NewOfferPackage> {
  const name = str(body.name);
  if (!name) throw new ApiError(400, "Nazwa pakietu jest wymagana");

  const mode: OfferPackageMode = oneOf(body.mode, OFFER_PACKAGE_MODES, "parametric");

  // Definicja parametrów przechodzi przez JSON.stringify, żeby do bazy nie
  // trafił dowolny tekst podszywający się pod JSON.
  let params = "[]";
  if (mode === "parametric" && Array.isArray(body.params)) {
    const defs = body.params
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => {
        const key = str(p.key);
        if (!key) throw new ApiError(400, "Parametr pakietu musi mieć klucz");
        return {
          key,
          label: str(p.label) || key,
          default: num(p.default, "Wartość domyślna parametru", 0) ?? 0,
          min: num(p.min, "Minimum parametru", 0) ?? 0,
          max: num(p.max, "Maksimum parametru", null) ?? undefined,
        };
      });
    params = JSON.stringify(defs);
  }

  return {
    name,
    category: oneOf(body.category, OFFER_SECTION_CATEGORIES, "inne"),
    manufacturer: str(body.manufacturer) || null,
    description: str(body.description) || null,
    mode,
    params,
    active: body.active === undefined ? true : Boolean(body.active),
    position: Number.isFinite(Number(body.position)) ? Number(body.position) : 0,
  };
}

function writePackageItemsSync(tx: Tx, packageId: number, items: PackageItemInput[]) {
  tx.delete(schema.offerPackageItems)
    .where(eq(schema.offerPackageItems.packageId, packageId))
    .run();
  items.forEach((it, i) => {
    tx.insert(schema.offerPackageItems)
      .values({ ...it, packageId, position: i + 1 })
      .run();
  });
}

/**
 * Parametry, których edytor potrzebuje do podpowiedzi i ostrzeżeń.
 *
 * Osobno od `/warehouse/pricing-config`, bo tamten chroni klucz
 * `technical/magazyn` — handlowiec z samymi Ofertami dostawał 403 i tracił próg
 * marży razem z resztą słowników. Te dwie liczby dotyczą OFERT i mają jechać
 * pod kluczem ofert.
 */
app.get("/config", async (c) =>
  guard(c, () => {
    const { values } = getCompanyConfig();
    return c.json({
      success: true,
      data: {
        minMarginPct: values.minMarginPct,
        /** Domyślny procent roczny dzierżawy — podpowiadany przy jej włączaniu. */
        leaseAnnualRate: values.leaseAnnualRate,
      },
    });
  })
);

/**
 * Oferta spod ADRESU STRONY: „of202608014" → OF/2026/08/014.
 *
 * Numer jest tym, czym oferta posługuje się na zewnątrz (mail, telefon,
 * wydruk), więc to on stoi w URL-u — nie techniczne id. Slug powstaje przez
 * zdjęcie ukośników i myślników, żeby adres dało się przekleić bez kodowania;
 * wersje („-w2") zostają rozróżnialne, bo litera i cyfra zostają w środku.
 *
 * Montowane PRZED `/:id`, inaczej „number" trafiłoby w parametr.
 */
app.get("/number/:slug", async (c) =>
  guard(c, () => {
    const slug = str(c.req.param("slug")).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!slug) throw new ApiError(400, "Pusty adres oferty");
    const row = db
      .select({ id: schema.offers.id })
      .from(schema.offers)
      .where(
        sql`lower(replace(replace(${schema.offers.number}, '/', ''), '-', '')) = ${slug}`
      )
      .all()[0];
    if (!row) throw new ApiError(404, "Nie znaleziono oferty o tym adresie");
    return respond(c, loadOfferSync(db, row.id));
  })
);

// Lista pakietów (z licznikiem pozycji, żeby biblioteka nie wyglądała na pustą).
app.get("/packages", async (c) =>
  guard(c, () => {
    const includeInactive = c.req.query("includeInactive") === "1";
    const category = c.req.query("category");
    const filters: SQL[] = [];
    if (!includeInactive) filters.push(eq(schema.offerPackages.active, true));
    if (category && (OFFER_SECTION_CATEGORIES as readonly string[]).includes(category)) {
      filters.push(eq(schema.offerPackages.category, category as OfferSectionCategory));
    }
    const rows = db
      .select()
      .from(schema.offerPackages)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(schema.offerPackages.position), asc(schema.offerPackages.name))
      .all();
    const items = db.select().from(schema.offerPackageItems).all();
    const counts = new Map<number, number>();
    for (const it of items) counts.set(it.packageId, (counts.get(it.packageId) ?? 0) + 1);
    return c.json({
      success: true,
      data: rows.map((p) => ({ ...p, itemCount: counts.get(p.id) ?? 0 })),
    });
  })
);

app.get("/packages/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator pakietu");
    const pkg = db
      .select()
      .from(schema.offerPackages)
      .where(eq(schema.offerPackages.id, id))
      .all()[0];
    if (!pkg) throw new ApiError(404, "Nie znaleziono pakietu");
    const items = db
      .select()
      .from(schema.offerPackageItems)
      .where(eq(schema.offerPackageItems.packageId, id))
      .orderBy(asc(schema.offerPackageItems.position), asc(schema.offerPackageItems.id))
      .all();
    return c.json({ success: true, data: { ...pkg, items } });
  })
);

app.post("/packages", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const head = parsePackageHead(body);
    const items = parsePackageItems(body.items);
    const created = db.transaction((tx) => {
      const pkg = tx
        .insert(schema.offerPackages)
        .values(head as NewOfferPackage)
        .returning()
        .get();
      writePackageItemsSync(tx, pkg.id, items);
      logActivity(tx, {
        entityType: "offer_package",
        entityId: pkg.id,
        user: getUser(c),
        action: "created",
        summary: `Dodano pakiet ofertowy „${pkg.name}”`,
      });
      return pkg;
    });
    return c.json({ success: true, data: created, message: "Pakiet dodany" }, 201);
  });
});

/** PUT podmienia pakiet W CAŁOŚCI razem z pozycjami (jak szkic dokumentu magazynu). */
app.put("/packages/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator pakietu");
    const head = parsePackageHead(body);
    const items = parsePackageItems(body.items);
    const updated = db.transaction((tx) => {
      const before = tx
        .select()
        .from(schema.offerPackages)
        .where(eq(schema.offerPackages.id, id))
        .all()[0];
      if (!before) throw new ApiError(404, "Nie znaleziono pakietu");
      const pkg = tx
        .update(schema.offerPackages)
        .set({ ...head, updatedAt: new Date().toISOString() })
        .where(eq(schema.offerPackages.id, id))
        .returning()
        .get();
      if (Array.isArray(body.items)) writePackageItemsSync(tx, id, items);
      logFieldDiffs(tx, {
        entityType: "offer_package",
        entityId: id,
        user: getUser(c),
        before,
        after: pkg,
        fields: ["name", "category", "manufacturer", "mode", "active"],
      });
      return pkg;
    });
    return c.json({ success: true, data: updated, message: "Pakiet zapisany" });
  });
});

/** DELETE = dezaktywacja; sekcje ofert wskazują na pakiet i ślad ma zostać. */
app.delete("/packages/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator pakietu");
    const pkg = db
      .select()
      .from(schema.offerPackages)
      .where(eq(schema.offerPackages.id, id))
      .all()[0];
    if (!pkg) throw new ApiError(404, "Nie znaleziono pakietu");
    db.transaction((tx) => {
      tx.update(schema.offerPackages)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(schema.offerPackages.id, id))
        .run();
      logActivity(tx, {
        entityType: "offer_package",
        entityId: id,
        user: getUser(c),
        action: "deleted",
        summary: `Zarchiwizowano pakiet „${pkg.name}”`,
      });
    });
    return c.json({ success: true, data: null, message: "Pakiet zarchiwizowany" });
  })
);

// ---------------------------------------------------------------------------
// OFERTY
// ---------------------------------------------------------------------------

/**
 * Nagłówek oferty z ciała żądania.
 *
 * SEMANTYKA CZĘŚCIOWA: pole POMINIĘTE w ciele zostaje bez zmian (przy edycji)
 * albo dostaje wartość domyślną (przy tworzeniu). Tak działają wszystkie
 * pozostałe `PUT`-y w tym pliku — sekcje i pozycje — i tak samo musi działać
 * ten. Wcześniej `PUT` budował komplet pól z domyślnych, więc żądanie
 * `{"site":"x"}` kasowało kontrahenta, rabat, dzierżawę i uwagi, a datę
 * przestawiało na dziś (numer zostawał z poprzedniego miesiąca) — cicho,
 * ze statusem 200.
 *
 * Jawny `null` nadal CZYŚCI pole; to inna intencja niż pominięcie.
 */
function parseOfferHead(
  body: Record<string, unknown>,
  current?: Offer
): Partial<NewOffer> {
  const has = (k: string) => body[k] !== undefined;
  /** Wartość pola: z ciała, a gdy pominięte — z rekordu albo z domyślnej. */
  const keep = <T>(k: string, fromBody: () => T, fallback: T): T =>
    has(k) ? fromBody() : fallback;

  const date = keep("date", () => optDate(body.date, "Data oferty") ?? todayISO(), current?.date ?? todayISO());
  const validUntil = keep(
    "validUntil",
    () => optDate(body.validUntil, "Termin ważności"),
    current?.validUntil ?? null
  );
  if (validUntil && validUntil < date)
    throw new ApiError(400, "Termin ważności nie może być wcześniejszy niż data oferty");

  const leaseMode: OfferLeaseMode = keep(
    "leaseMode",
    () => oneOf(body.leaseMode, OFFER_LEASE_MODES, "none"),
    current?.leaseMode ?? "none"
  );
  const leaseMonths = keep(
    "leaseMonths",
    () => optId(body.leaseMonths, "okres dzierżawy"),
    current?.leaseMonths ?? null
  );
  if (leaseMode === "custom" && !leaseMonths)
    throw new ApiError(400, "Dzierżawa „własny okres” wymaga liczby miesięcy");

  /*
   * Procent dzierżawy: gdy włączamy dzierżawę, a nikt nie podał stawki, bierzemy
   * DOMYŚLNĄ z ustawień firmy (`company.lease_annual_rate`, fabrycznie 117%).
   * Bez tego `leaseActive` byłoby fałszywe i tryb dzierżawy nic by nie robił —
   * użytkownik wybrałby „24 miesiące" i nie zobaczył żadnej raty.
   */
  const rateFromBody = keep(
    "leaseAnnualRate",
    () => num(body.leaseAnnualRate, "Procent dzierżawy", null),
    current?.leaseAnnualRate ?? null
  );
  const leaseAnnualRate =
    leaseMode !== "none" && (rateFromBody === null || rateFromBody === 0)
      ? getCompanyConfig().values.leaseAnnualRate
      : rateFromBody;

  return {
    date,
    validUntil,
    kind: keep("kind", () => oneOf(body.kind, OFFER_KINDS, "montaz") as OfferKind, current?.kind ?? "montaz"),
    contractorId: keep("contractorId", () => optId(body.contractorId, "identyfikator kontrahenta"), current?.contractorId ?? null),
    clientName: keep("clientName", () => str(body.clientName), current?.clientName ?? ""),
    clientNip: keep("clientNip", () => str(body.clientNip), current?.clientNip ?? ""),
    objectId: keep("objectId", () => optId(body.objectId, "identyfikator obiektu"), current?.objectId ?? null),
    site: keep("site", () => str(body.site), current?.site ?? ""),
    address: keep("address", () => str(body.address), current?.address ?? ""),
    salespersonId: keep("salespersonId", () => optId(body.salespersonId, "identyfikator handlowca"), current?.salespersonId ?? null),
    companyId: keep("companyId", () => optId(body.companyId, "identyfikator spółki"), current?.companyId ?? null),
    discountPct: keep("discountPct", () => pct(body.discountPct, "Rabat"), current?.discountPct ?? 0),
    // Przewidywany czas kontraktu: liczba miesięcy albo nic. `optId` pilnuje,
    // że to dodatnia liczba całkowita — „0 miesięcy" to nie kontrakt, tylko puste pole.
    contractMonths: keep(
      "contractMonths",
      () => optId(body.contractMonths, "przewidywany czas kontraktu"),
      current?.contractMonths ?? null
    ),
    leaseMode,
    leaseMonths: leaseMode === "custom" ? leaseMonths : null,
    leaseAnnualRate,
    leaseIncludeLabour: keep("leaseIncludeLabour", () => Boolean(body.leaseIncludeLabour), current?.leaseIncludeLabour ?? false),
    notes: keep("notes", () => str(body.notes) || null, current?.notes ?? null),
  };
}

/**
 * Znacznik zakresu spoza katalogu kategorii sekcji: dzierżawa jest parametrem
 * całej oferty, a nie sekcją, więc nie ma swojego wpisu w `OFFER_SECTION_CATEGORIES`.
 */
export const OFFER_SCOPE_LEASE = "dzierzawa";

/**
 * FAKTYCZNY ZAKRES oferty — czego naprawdę dotyczy, wyliczony z jej treści.
 *
 * Kolumna „Zakres" na liście pokazuje `kind` („Montaż i uruchomienie"), co mówi
 * o RODZAJU pracy, ale nie o tym, jakich systemów dotyczy. Ta funkcja dokłada
 * drugą warstwę: kategorie sekcji, które mają choć jedną pozycję, plus dwa
 * strumienie pieniędzy, których nie widać po samych sekcjach.
 *
 * Dlaczego z pozycji, a nie z samych sekcji:
 *   - pusta sekcja to zakładka bez treści, nie zakres oferty;
 *   - „abonament" bierzemy z FAKTYCZNYCH pozycji miesięcznych, bo abonament da
 *     się dorzucić do sekcji CCTV i wtedy kategoria sekcji o nim milczy;
 *   - „dzierżawa" nie jest sekcją w ogóle — to parametr całej oferty.
 *
 * Kolejność jest stała (wg `OFFER_SECTION_CATEGORIES`), żeby dwie podobne
 * oferty czytało się tak samo, a nie w kolejności dodawania sekcji.
 */
function scopeOf(
  offer: Offer,
  sections: OfferSection[],
  items: OfferItem[]
): string[] {
  const withItems = new Set(items.map((i) => i.sectionId));
  const tags = new Set<string>();

  for (const s of sections) {
    if (!withItems.has(s.id)) continue;
    tags.add(s.category);
  }
  if (items.some((i) => i.billing === "monthly")) tags.add("abonament");

  const ordered: string[] = OFFER_SECTION_CATEGORIES.filter((c) => tags.has(c));
  // Dzierżawa na końcu — to sposób rozliczenia, nie system.
  if (offer.leaseMode !== "none" && (offer.leaseAnnualRate ?? 0) > 0) {
    ordered.push(OFFER_SCOPE_LEASE);
  }
  return ordered;
}

/** Lista ofert; filtry: status, kind, rok, handlowiec, szukajka. */
app.get("/", async (c) =>
  guard(c, () => {
    const filters: SQL[] = [];
    const status = c.req.query("status");
    if (status && (OFFER_STATUSES as readonly string[]).includes(status)) {
      filters.push(eq(schema.offers.status, status as OfferStatus));
    }
    const kind = c.req.query("kind");
    if (kind && (OFFER_KINDS as readonly string[]).includes(kind)) {
      filters.push(eq(schema.offers.kind, kind as OfferKind));
    }
    const year = Number(c.req.query("year"));
    if (Number.isInteger(year) && year > 2000) {
      filters.push(like(schema.offers.date, `${year}-%`));
    }
    const salespersonId = Number(c.req.query("salespersonId"));
    if (Number.isInteger(salespersonId) && salespersonId > 0) {
      filters.push(eq(schema.offers.salespersonId, salespersonId));
    }

    let rows = db
      .select()
      .from(schema.offers)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(schema.offers.date), desc(schema.offers.id))
      .all();

    const q = (c.req.query("q") || "").trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        [r.number, r.clientName, r.site, r.address, r.date].some(
          (v) => v != null && String(v).toLowerCase().includes(q)
        )
      );
    }

    // Sumy na liście liczymy z pozycji — jednym zapytaniem po wszystkie pozycje
    // widocznych ofert, żeby nie robić N+1 przy każdym wierszu.
    const ids = rows.map((r) => r.id);
    const allSections = ids.length
      ? db.select().from(schema.offerSections).where(inArray(schema.offerSections.offerId, ids)).all()
      : [];
    const allItems = ids.length
      ? db.select().from(schema.offerItems).where(inArray(schema.offerItems.offerId, ids)).all()
      : [];
    const { values } = getCompanyConfig();
    const today = todayISO();

    /*
     * NAZWY, NIE IDENTYFIKATORY. Lista pokazuje handlowca i autora dokumentu,
     * więc rozwiązujemy je na backendzie: handlowiec to `salesperson_id`,
     * a `created_by` trzyma login z sesji. Front nie może tego dołożyć sam,
     * bo kartoteka handlowców stoi za osobnym uprawnieniem — bez tego
     * handlowiec z dostępem tylko do Ofert widziałby puste kolumny.
     * Dwa małe zapytania zamiast N+1 na wiersz.
     */
    const salesById = new Map(
      db
        .select()
        .from(schema.salespeople)
        .all()
        .map((sp) => [sp.id, `${sp.firstName} ${sp.lastName}`.trim()])
    );
    const userByEmail = new Map(
      db
        .select({ email: schema.users.email, displayName: schema.users.displayName })
        .from(schema.users)
        .all()
        .map((u) => [u.email.toLowerCase(), u.displayName || u.email])
    );

    const data = rows.map((r) => {
      const sections = allSections.filter((s) => s.offerId === r.id);
      const items = allItems.filter((i) => i.offerId === r.id);
      return {
        ...r,
        status: effectiveStatus(r, today),
        scope: scopeOf(r, sections, items),
        salespersonName:
          r.salespersonId === null ? null : salesById.get(r.salespersonId) ?? null,
        // Login zostaje, gdy konto zniknęło z bazy — lepszy ślad niż kreska.
        createdByLabel: r.createdBy
          ? userByEmail.get(r.createdBy.toLowerCase()) ?? r.createdBy
          : null,
        totals: computeOffer(r, sections, items, values.minMarginPct),
      };
    });

    return respond(c, data);
  })
);

app.get("/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    return respond(c, loadOfferSync(db, id));
  })
);

app.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const head = parseOfferHead(body as Record<string, unknown>);
    const user = getUser(c);
    const created = db.transaction((tx) => {
      const offer = tx
        .insert(schema.offers)
        .values({
          ...head,
          number: nextOfferNumberSync(tx, head.date!),
          createdBy: user?.email ?? null,
        } as NewOffer)
        .returning()
        .get();
      logActivity(tx, {
        entityType: "offer",
        entityId: offer.id,
        objectId: offer.objectId,
        user,
        action: "created",
        summary: `Utworzono ofertę ${offer.number}`,
      });
      return offer;
    });
    return c.json({ success: true, data: created, message: "Oferta utworzona" }, 201);
  });
});

app.put("/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    const updated = db.transaction((tx) => {
      const before = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!before) throw new ApiError(404, "Nie znaleziono oferty");
      assertEditable(before);
      // Nagłówek scalamy z ISTNIEJĄCYM rekordem — pominięte pole zostaje.
      const head = parseOfferHead(body, before);
      const offer = tx
        .update(schema.offers)
        .set({ ...head, updatedAt: new Date().toISOString() })
        .where(eq(schema.offers.id, id))
        .returning()
        .get();
      logFieldDiffs(tx, {
        entityType: "offer",
        entityId: id,
        objectId: offer.objectId,
        user: getUser(c),
        before,
        after: offer,
        fields: [
          "date",
          "validUntil",
          "kind",
          "clientName",
          "site",
          "discountPct",
          "leaseMode",
          "leaseAnnualRate",
          "leaseIncludeLabour",
        ],
      });
      return offer;
    });
    return respond(c, loadOfferSync(db, updated.id), "Oferta zapisana");
  });
});

app.delete("/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    db.transaction((tx) => {
      const offer = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
      /*
       * Kasowanie też podlega zamrożeniu — i to najbardziej ze wszystkiego.
       * Usunięcie wysłanej oferty kasuje dokument, który klient ma na papierze,
       * a po akceptacji zostawia w CRM osierocone zlecenie i szkic WZ, którego
       * nikt nie powiąże ze źródłem (magazynier może go zatwierdzić i zdjąć
       * stany pod nieistniejącą ofertę). Kasuje się wyłącznie szkice.
       */
      assertEditable(offer);
      // Sekcje i pozycje lecą kaskadą (ON DELETE CASCADE w schemacie).
      tx.delete(schema.offers).where(eq(schema.offers.id, id)).run();
      logActivity(tx, {
        entityType: "offer",
        entityId: id,
        objectId: offer.objectId,
        user: getUser(c),
        action: "deleted",
        summary: `Usunięto ofertę ${offer.number}`,
      });
    });
    return c.json({ success: true, data: null, message: "Oferta usunięta" });
  })
);

/**
 * Nowa wersja zamkniętej oferty: kopia sekcji i pozycji, status z powrotem na
 * szkic. To jedyny sposób na zmianę tego, co poszło do klienta.
 */
app.post("/:id/version", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    const user = getUser(c);
    const created = db.transaction((tx) => {
      const src = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!src) throw new ApiError(404, "Nie znaleziono oferty");

      // Wersje liczymy od korzenia rodziny, nie od kopiowanej oferty — inaczej
      // dwie wersje zrobione z tej samej „w2" dostałyby ten sam numer „w3".
      const rootId = src.parentId ?? src.id;
      const family = tx
        .select()
        .from(schema.offers)
        .where(eq(schema.offers.parentId, rootId))
        .all();
      const maxVersion = family.reduce((m, o) => Math.max(m, o.version), 1);

      const offer = tx
        .insert(schema.offers)
        .values({
          ...src,
          id: undefined,
          parentId: rootId,
          version: maxVersion + 1,
          number: versionNumber(src.number, maxVersion + 1),
          status: "draft",
          sentAt: null,
          orderId: null,
          warehouseDocId: null,
          createdBy: user?.email ?? null,
          createdAt: undefined,
          updatedAt: undefined,
        } as NewOffer)
        .returning()
        .get();

      const sections = tx
        .select()
        .from(schema.offerSections)
        .where(eq(schema.offerSections.offerId, id))
        .all();
      const items = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.offerId, id))
        .all();

      const sectionMap = new Map<number, number>();
      for (const s of sections) {
        const copy = tx
          .insert(schema.offerSections)
          .values({ ...s, id: undefined, offerId: offer.id })
          .returning()
          .get();
        sectionMap.set(s.id, copy.id);
      }
      for (const it of items) {
        const newSectionId = sectionMap.get(it.sectionId);
        if (!newSectionId) continue;
        tx.insert(schema.offerItems)
          .values({ ...it, id: undefined, offerId: offer.id, sectionId: newSectionId })
          .run();
      }

      logActivity(tx, {
        entityType: "offer",
        entityId: offer.id,
        objectId: offer.objectId,
        user,
        action: "created",
        summary: `Utworzono wersję ${offer.number} na podstawie ${src.number}`,
      });
      return offer;
    });
    return c.json({ success: true, data: created, message: `Utworzono ${created.number}` }, 201);
  })
);

/** Wysłanie: zapisuje datę i ZAMRAŻA dokument. */
app.post("/:id/send", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    const updated = db.transaction((tx) => {
      const offer = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
      if (offer.status !== "draft")
        throw new ApiError(409, `Ofertę można wysłać tylko ze szkicu (jest: ${offer.status})`);

      const items = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.offerId, id))
        .all();
      if (items.length === 0)
        throw new ApiError(400, "Pusta oferta — dodaj przynajmniej jedną pozycję");

      const next = tx
        .update(schema.offers)
        .set({ status: "sent", sentAt: todayISO(), updatedAt: new Date().toISOString() })
        .where(eq(schema.offers.id, id))
        .returning()
        .get();
      logActivity(tx, {
        entityType: "offer",
        entityId: id,
        objectId: offer.objectId,
        user: getUser(c),
        action: "status_changed",
        field: "status",
        oldValue: offer.status,
        newValue: "sent",
        summary: `Oferta ${offer.number} wysłana do klienta`,
      });
      return next;
    });
    return respond(c, loadOfferSync(db, updated.id), "Oferta oznaczona jako wysłana");
  })
);

/** Odrzucenie przez klienta — też zamyka dokument. */
app.post("/:id/reject", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    db.transaction((tx) => {
      const offer = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
      // Odrzucić może tylko klient, a klient widział wyłącznie ofertę WYSŁANĄ.
      // Szkicu nikt nie odrzuca — zamroziłoby to dokument, którego nie było
      // na zewnątrz. Powtórne odrzucenie to tylko drugi wpis w dzienniku.
      if (offer.status !== "sent")
        throw new ApiError(
          409,
          offer.status === "draft"
            ? "Szkic nie był u klienta — nie ma czego odrzucać"
            : `Oferta jest już zamknięta (${offer.status})`
        );
      tx.update(schema.offers)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(eq(schema.offers.id, id))
        .run();
      logActivity(tx, {
        entityType: "offer",
        entityId: id,
        objectId: offer.objectId,
        user: getUser(c),
        action: "status_changed",
        field: "status",
        oldValue: offer.status,
        newValue: "rejected",
        summary: `Oferta ${offer.number} odrzucona przez klienta`,
      });
    });
    return respond(c, loadOfferSync(db, id), "Oferta odrzucona");
  })
);

// ---------------------------------------------------------------------------
// SEKCJE
// ---------------------------------------------------------------------------

function loadEditableOfferSync(tx: Tx, id: number): Offer {
  const offer = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
  if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
  assertEditable(offer);
  return offer;
}

function nextSectionPositionSync(tx: Tx, offerId: number): number {
  const rows = tx
    .select()
    .from(schema.offerSections)
    .where(eq(schema.offerSections.offerId, offerId))
    .all();
  return rows.length + 1;
}

/**
 * Dodanie sekcji. Z `packageId` sekcja powstaje z pakietu i od razu dostaje
 * rozwinięte pozycje; bez niego to pusta grupa do ręcznego wypełnienia.
 */
app.post("/:id/sections", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const b = body as Record<string, unknown>;
    const packageId = optId(b.packageId, "identyfikator pakietu");
    const paramValues = parseParamValues(JSON.stringify(b.params ?? {}));

    const created = db.transaction((tx) => {
      const offer = loadEditableOfferSync(tx, offerId);
      const { values } = getCompanyConfig();

      let pkg = null;
      let drafts: OfferItemDraft[] = [];
      if (packageId !== null) {
        pkg = tx
          .select()
          .from(schema.offerPackages)
          .where(eq(schema.offerPackages.id, packageId))
          .all()[0];
        if (!pkg) throw new ApiError(404, "Nie znaleziono pakietu");
        const pkgItems = tx
          .select()
          .from(schema.offerPackageItems)
          .where(eq(schema.offerPackageItems.packageId, packageId))
          .all();
        const expanded = expandPackage(
          pkg,
          pkgItems,
          paramValues,
          priceSourceSync(tx, values.warehouseMarkup)
        );
        // Pozycja bez znanej ceny wchodziła na ofertę po 0 zł — czyli firma
        // oddawała sprzęt za darmo, bez jednego ostrzeżenia. Cena 0 WPISANA
        // w kartotece jest znana i przechodzi; tu chodzi o brak jakiejkolwiek.
        if (expanded.missingPrices.length)
          throw new ApiError(
            400,
            `Brak ceny w kartotece: ${expanded.missingPrices.join(", ")} — uzupełnij ją przed dodaniem pakietu`
          );
        drafts = expanded.drafts;
      }

      /*
       * WYŁĄCZNOŚĆ WARIANTU pilnowana już przy DODAWANIU, nie dopiero przy
       * edycji. Wcześniej dwie sekcje wrzucone do tej samej grupy przez POST
       * były obie „wybrane" i obie wchodziły do sumy — czyli oferta z dwoma
       * alternatywnymi rejestratorami liczyła oba, i dało się ją tak wysłać.
       * Nowa sekcja w zajętej grupie dołącza jako NIEWYBRANA; wybór jest
       * świadomym kliknięciem w edytorze.
       */
      const variantGroup = str(b.variantGroup) || null;
      const groupHasSelected =
        variantGroup !== null &&
        tx
          .select({ id: schema.offerSections.id })
          .from(schema.offerSections)
          .where(
            and(
              eq(schema.offerSections.offerId, offerId),
              eq(schema.offerSections.variantGroup, variantGroup),
              eq(schema.offerSections.variantSelected, true)
            )
          )
          .all().length > 0;

      const section = tx
        .insert(schema.offerSections)
        .values({
          offerId,
          position: nextSectionPositionSync(tx, offerId),
          category: oneOf(
            b.category,
            OFFER_SECTION_CATEGORIES,
            (pkg?.category ?? "inne") as OfferSectionCategory
          ),
          title: str(b.title) || pkg?.name || "Nowa sekcja",
          packageId,
          params: JSON.stringify(paramValues),
          isOptional: Boolean(b.isOptional),
          variantGroup,
          variantSelected: groupHasSelected
            ? false
            : b.variantSelected === undefined
              ? true
              : Boolean(b.variantSelected),
          notes: str(b.notes) || null,
        })
        .returning()
        .get();

      drafts.forEach((d) => {
        tx.insert(schema.offerItems)
          .values({ ...d, offerId, sectionId: section.id })
          .run();
      });

      logActivity(tx, {
        entityType: "offer",
        entityId: offerId,
        objectId: offer.objectId,
        user: getUser(c),
        action: "updated",
        summary: pkg
          ? `Dodano pakiet „${pkg.name}” (${drafts.length} poz.) do oferty ${offer.number}`
          : `Dodano sekcję „${section.title}” do oferty ${offer.number}`,
      });
      return section;
    });

    return respond(c, loadOfferSync(db, offerId), `Dodano sekcję „${created.title}”`, 201);
  });
});

app.put("/:id/sections/:sid", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const sid = requireId(c.req.param("sid"), "identyfikator sekcji");
    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const section = tx
        .select()
        .from(schema.offerSections)
        .where(and(eq(schema.offerSections.id, sid), eq(schema.offerSections.offerId, offerId)))
        .all()[0];
      if (!section) throw new ApiError(404, "Nie znaleziono sekcji");

      const variantGroup =
        body.variantGroup === undefined ? section.variantGroup : str(body.variantGroup) || null;
      /*
       * Wyjście z grupy wariantów zawsze WŁĄCZA sekcję do sum. Bez tego flaga
       * `variantSelected = false` zostawała na sekcji, która nie jest już
       * wariantem, i wtedy `sectionCounts` przestawało ją honorować — kwota
       * oferty rosła o odrzucony wariant w reakcji na „usuń z grupy", cicho.
       * Teraz operacja znaczy jedno: ta sekcja jest zwykłą częścią oferty.
       */
      const leavingGroup = section.variantGroup !== null && variantGroup === null;
      const variantSelected = leavingGroup
        ? true
        : body.variantSelected === undefined
          ? section.variantSelected
          : Boolean(body.variantSelected);

      // W grupie musi zostać dokładnie jeden wybrany — odznaczenie ostatniego
      // wyrzuciłoby pozycje z sum i z opcji naraz, czyli zniknęłyby z dokumentu.
      if (variantGroup && !variantSelected && section.variantSelected) {
        const others = tx
          .select({ id: schema.offerSections.id })
          .from(schema.offerSections)
          .where(
            and(
              eq(schema.offerSections.offerId, offerId),
              eq(schema.offerSections.variantGroup, variantGroup),
              eq(schema.offerSections.variantSelected, true),
              ne(schema.offerSections.id, sid)
            )
          )
          .all();
        if (others.length === 0)
          throw new ApiError(
            400,
            `„${section.title}" to jedyny wybrany wariant w grupie „${variantGroup}" — wskaż inny zamiast odznaczać ten`
          );
      }

      tx.update(schema.offerSections)
        .set({
          title: body.title === undefined ? section.title : str(body.title),
          category: oneOf(body.category, OFFER_SECTION_CATEGORIES, section.category),
          isOptional:
            body.isOptional === undefined ? section.isOptional : Boolean(body.isOptional),
          variantGroup,
          variantSelected,
          notes: body.notes === undefined ? section.notes : str(body.notes) || null,
        })
        .where(eq(schema.offerSections.id, sid))
        .run();

      // W grupie wariantów wybrana może być tylko JEDNA sekcja — inaczej do sum
      // weszłyby obie alternatywy naraz i oferta podwoiłaby rejestrator.
      if (variantGroup && variantSelected) {
        tx.update(schema.offerSections)
          .set({ variantSelected: false })
          .where(
            and(
              eq(schema.offerSections.offerId, offerId),
              eq(schema.offerSections.variantGroup, variantGroup)
            )
          )
          .run();
        tx.update(schema.offerSections)
          .set({ variantSelected: true })
          .where(eq(schema.offerSections.id, sid))
          .run();
      }
    });
    return respond(c, loadOfferSync(db, offerId), "Sekcja zapisana");
  });
});

app.delete("/:id/sections/:sid", async (c) =>
  guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const sid = requireId(c.req.param("sid"), "identyfikator sekcji");
    db.transaction((tx) => {
      const offer = loadEditableOfferSync(tx, offerId);
      const section = tx
        .select()
        .from(schema.offerSections)
        .where(and(eq(schema.offerSections.id, sid), eq(schema.offerSections.offerId, offerId)))
        .all()[0];
      if (!section) throw new ApiError(404, "Nie znaleziono sekcji");
      const count = tx
        .select({ id: schema.offerItems.id })
        .from(schema.offerItems)
        .where(eq(schema.offerItems.sectionId, sid))
        .all().length;
      // Pozycje lecą kaskadą po `section_id`.
      tx.delete(schema.offerSections).where(eq(schema.offerSections.id, sid)).run();

      /*
       * ŚLAD PO KASOWANIU. Dodawanie sekcji zapisywało się w dzienniku, a
       * usuwanie nie — po zniknięciu całej sekcji z oferty nie dało się
       * ustalić ani kiedy, ani kto. To najbardziej nieodwracalna operacja
       * w tym module, więc ma zostawiać wpis jak każda inna.
       */
      logActivity(tx, {
        entityType: "offer",
        entityId: offerId,
        objectId: offer.objectId,
        user: getUser(c),
        action: "updated",
        summary: `Usunięto sekcję „${section.title}" (${count} poz.) z oferty ${offer.number}`,
      });
    });
    return respond(c, loadOfferSync(db, offerId), "Sekcja usunięta");
  })
);

/**
 * PRZELICZENIE SEKCJI dla nowej wartości parametru — „było 8 kamer, jest 20".
 *
 * Sekcja pamięta parametry, którymi rozwinięto pakiet (`offer_sections.params`),
 * ale do tej pory nie dało się ich zmienić: trzeba było usunąć sekcję i dodać
 * pakiet od nowa. Przy SLOTACH to za mało — zmiana liczby kamer ma podmienić
 * rejestrator na inny model, a nie tylko przeskalować ilości.
 *
 * Pozycje sekcji lecą w całości i wracają z pakietu: to jest przeliczenie
 * PRZEPISU, nie łatanie różnic. Ręczne poprawki w tej sekcji przepadają i front
 * pyta o to wprost przed wywołaniem.
 */
app.post("/:id/sections/:sid/reexpand", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const sid = requireId(c.req.param("sid"), "identyfikator sekcji");
    const b = body as Record<string, unknown>;
    const paramValues = parseParamValues(JSON.stringify(b.params ?? {}));

    db.transaction((tx) => {
      const offer = loadEditableOfferSync(tx, offerId);
      const section = tx
        .select()
        .from(schema.offerSections)
        .where(and(eq(schema.offerSections.id, sid), eq(schema.offerSections.offerId, offerId)))
        .all()[0];
      if (!section) throw new ApiError(404, "Nie znaleziono sekcji");
      if (section.packageId === null)
        throw new ApiError(
          400,
          `Sekcja „${section.title}" nie pochodzi z pakietu — nie ma czego przeliczyć`
        );

      const pkg = tx
        .select()
        .from(schema.offerPackages)
        .where(eq(schema.offerPackages.id, section.packageId))
        .all()[0];
      if (!pkg)
        throw new ApiError(404, "Pakiet, z którego powstała sekcja, już nie istnieje");

      const pkgItems = tx
        .select()
        .from(schema.offerPackageItems)
        .where(eq(schema.offerPackageItems.packageId, pkg.id))
        .all();
      const { values } = getCompanyConfig();
      const expanded = expandPackage(
        pkg,
        pkgItems,
        paramValues,
        priceSourceSync(tx, values.warehouseMarkup)
      );
      if (expanded.missingPrices.length)
        throw new ApiError(
          400,
          `Brak ceny w kartotece: ${expanded.missingPrices.join(", ")} — uzupełnij ją przed przeliczeniem`
        );

      tx.delete(schema.offerItems).where(eq(schema.offerItems.sectionId, sid)).run();
      expanded.drafts.forEach((d) => {
        tx.insert(schema.offerItems)
          .values({ ...d, offerId, sectionId: sid })
          .run();
      });
      tx.update(schema.offerSections)
        .set({ params: JSON.stringify(paramValues) })
        .where(eq(schema.offerSections.id, sid))
        .run();

      // W podsumowaniu zmiany liczy się wartość PARAMETRU, nie liczba pozycji —
      // po niej poznaje się, dlaczego kwota sekcji podskoczyła.
      const describe = (raw: string) => {
        const v = parseParamValues(raw);
        const parts = Object.entries(v).map(([k, n]) => `${k}: ${n}`);
        return parts.length ? parts.join(", ") : "bez parametrów";
      };
      logActivity(tx, {
        entityType: "offer",
        entityId: offerId,
        objectId: offer.objectId,
        user: getUser(c),
        action: "updated",
        summary:
          `Przeliczono sekcję „${section.title}" w ofercie ${offer.number} ` +
          `(${describe(section.params)} → ${describe(JSON.stringify(paramValues))}), ` +
          `${expanded.drafts.length} poz.`,
      });
    });

    return respond(c, loadOfferSync(db, offerId), "Sekcja przeliczona");
  });
});

/** Zapis sekcji jako pakiet wielokrotnego użytku (tryb sztywny). */
app.post("/:id/sections/:sid/save-as-package", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const sid = requireId(c.req.param("sid"), "identyfikator sekcji");
    const created = db.transaction((tx) => {
      const section = tx
        .select()
        .from(schema.offerSections)
        .where(and(eq(schema.offerSections.id, sid), eq(schema.offerSections.offerId, offerId)))
        .all()[0];
      if (!section) throw new ApiError(404, "Nie znaleziono sekcji");
      const items = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.sectionId, sid))
        .orderBy(asc(schema.offerItems.position))
        .all();
      if (items.length === 0) throw new ApiError(400, "Pusta sekcja — nie ma czego zapisać");

      const name = str((body as Record<string, unknown>).name) || section.title || "Nowy pakiet";
      const pkg = tx
        .insert(schema.offerPackages)
        .values({
          name,
          category: section.category,
          manufacturer: str((body as Record<string, unknown>).manufacturer) || null,
          description: `Zapisano z oferty (sekcja „${section.title}”)`,
          // Sztywny: przepisujemy konkretne ilości. Parametryzację (np. „na każde
          // 8 kamer”) trzeba dodać świadomie w edytorze pakietu — zgadywanie
          // reguły skalowania z jednej sekcji dawałoby losowe wyniki.
          mode: "fixed",
          params: "[]",
        })
        .returning()
        .get();

      items.forEach((it, i) => {
        tx.insert(schema.offerPackageItems)
          .values({
            packageId: pkg.id,
            position: i + 1,
            source: it.source,
            warehouseItemId: it.warehouseItemId,
            serviceId: it.serviceId,
            name: it.name,
            unit: it.unit,
            kind: it.kind,
            billing: it.billing,
            qtyBase: it.qty,
            qtyPerParam: 0,
            paramKey: null,
            qtyRound: "none",
            // Cena zostaje wolna: pakiet ma brać AKTUALNE ceny z kartotek,
            // inaczej zapisany dziś zestaw sprzedawałby po cenach z zeszłego roku.
            unitPriceOverride: null,
          })
          .run();
      });

      logActivity(tx, {
        entityType: "offer_package",
        entityId: pkg.id,
        user: getUser(c),
        action: "created",
        summary: `Zapisano pakiet „${pkg.name}” z oferty`,
      });
      return pkg;
    });
    return c.json(
      { success: true, data: created, message: `Zapisano pakiet „${created.name}”` },
      201
    );
  });
});

// ---------------------------------------------------------------------------
// POZYCJE
// ---------------------------------------------------------------------------

app.post("/:id/items", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const sectionId = optId(body.sectionId, "identyfikator sekcji");
    if (sectionId === null) throw new ApiError(400, "Wskaż sekcję, do której trafia pozycja");

    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const section = tx
        .select()
        .from(schema.offerSections)
        .where(
          and(eq(schema.offerSections.id, sectionId), eq(schema.offerSections.offerId, offerId))
        )
        .all()[0];
      if (!section) throw new ApiError(404, "Nie znaleziono sekcji w tej ofercie");

      const source = oneOf(body.source, OFFER_ITEM_SOURCES, "manual");
      const warehouseItemId = source === "warehouse" ? optId(body.warehouseItemId, "towar") : null;
      const serviceId = source === "service" ? optId(body.serviceId, "identyfikator usługi") : null;
      if (source === "warehouse" && warehouseItemId === null)
        throw new ApiError(400, "Wskaż towar z magazynu");
      if (source === "service" && serviceId === null) throw new ApiError(400, "Wskaż usługę");

      const { values } = getCompanyConfig();
      const src = priceSourceSync(tx, values.warehouseMarkup);
      const refId = source === "warehouse" ? warehouseItemId : serviceId;
      const label = src.label(source, refId);

      const name = str(body.name) || label?.name || "";
      if (!name) throw new ApiError(400, "Pozycja musi mieć nazwę");

      const count = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.offerId, offerId))
        .all().length;

      tx.insert(schema.offerItems)
        .values({
          offerId,
          sectionId,
          position: count + 1,
          source,
          warehouseItemId,
          serviceId,
          name,
          unit: str(body.unit) || label?.unit || "szt",
          qty: qtyNum(body.qty, "Ilość", 1) ?? 1,
          kind: oneOf(body.kind, OFFER_ITEM_KINDS, "material"),
          billing: oneOf(body.billing, OFFER_ITEM_BILLINGS, "one_time"),
          // Domyślnie ceny z kartoteki; jawnie podane w body mają pierwszeństwo.
          unitCost:
            body.unitCost === undefined ? src.cost(source, refId) : num(body.unitCost, "Koszt"),
          unitPrice:
            body.unitPrice === undefined
              ? src.price(source, refId) ?? 0
              : num(body.unitPrice, "Cena", 0) ?? 0,
          discountPct: pct(body.discountPct, "Rabat pozycji"),
          isOptional: Boolean(body.isOptional),
        })
        .run();
    });

    return respond(c, loadOfferSync(db, offerId), "Pozycja dodana", 201);
  });
});

app.put("/:id/items/:iid", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const iid = requireId(c.req.param("iid"), "identyfikator pozycji");
    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const item = tx
        .select()
        .from(schema.offerItems)
        .where(and(eq(schema.offerItems.id, iid), eq(schema.offerItems.offerId, offerId)))
        .all()[0];
      if (!item) throw new ApiError(404, "Nie znaleziono pozycji");

      tx.update(schema.offerItems)
        .set({
          name: body.name === undefined ? item.name : str(body.name) || item.name,
          unit: body.unit === undefined ? item.unit : str(body.unit) || item.unit,
          qty: body.qty === undefined ? item.qty : qtyNum(body.qty, "Ilość", item.qty) ?? item.qty,
          kind: oneOf(body.kind, OFFER_ITEM_KINDS, item.kind),
          billing: oneOf(body.billing, OFFER_ITEM_BILLINGS, item.billing),
          // `null` czyści koszt („nieznany”); pominięte pole nic nie zmienia.
          unitCost:
            body.unitCost === undefined
              ? item.unitCost
              : body.unitCost === null
                ? null
                : num(body.unitCost, "Koszt"),
          unitPrice:
            body.unitPrice === undefined
              ? item.unitPrice
              : num(body.unitPrice, "Cena", item.unitPrice) ?? item.unitPrice,
          discountPct:
            body.discountPct === undefined
              ? item.discountPct
              : pct(body.discountPct, "Rabat pozycji"),
          isOptional:
            body.isOptional === undefined ? item.isOptional : Boolean(body.isOptional),
        })
        .where(eq(schema.offerItems.id, iid))
        .run();
    });
    return respond(c, loadOfferSync(db, offerId), "Pozycja zapisana");
  });
});

app.delete("/:id/items/:iid", async (c) =>
  guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const iid = requireId(c.req.param("iid"), "identyfikator pozycji");
    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const item = tx
        .select()
        .from(schema.offerItems)
        .where(and(eq(schema.offerItems.id, iid), eq(schema.offerItems.offerId, offerId)))
        .all()[0];
      if (!item) throw new ApiError(404, "Nie znaleziono pozycji");
      tx.delete(schema.offerItems).where(eq(schema.offerItems.id, iid)).run();
    });
    return respond(c, loadOfferSync(db, offerId), "Pozycja usunięta");
  })
);

/**
 * Przeliczenie cen wg AKTUALNYCH kartotek.
 *
 * Pozycje są migawkami (i tak ma zostać), ale szkic sprzed miesiąca potrafi
 * mieć nieaktualne ceny. To jawna, ręczna akcja — nigdy nie dzieje się sama,
 * żeby oferta nie zmieniła kwoty między obejrzeniem a wydrukiem.
 */
app.post("/:id/reprice", async (c) =>
  guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const changed = db.transaction((tx) => {
      const offer = loadEditableOfferSync(tx, offerId);
      const { values } = getCompanyConfig();
      const src = priceSourceSync(tx, values.warehouseMarkup);
      const items = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.offerId, offerId))
        .all();

      let n = 0;
      for (const it of items) {
        if (it.source === "manual") continue; // ręcznej pozycji nie ma z czego przeliczyć
        const refId = it.source === "warehouse" ? it.warehouseItemId : it.serviceId;
        const price = src.price(it.source, refId);
        const cost = src.cost(it.source, refId);
        if (price === null) continue; // źródło zniknęło — zostawiamy migawkę
        if (Math.abs(price - it.unitPrice) < 0.005 && cost === it.unitCost) continue;
        tx.update(schema.offerItems)
          .set({ unitPrice: price, unitCost: cost })
          .where(eq(schema.offerItems.id, it.id))
          .run();
        n += 1;
      }

      if (n > 0) {
        logActivity(tx, {
          entityType: "offer",
          entityId: offerId,
          objectId: offer.objectId,
          user: getUser(c),
          action: "updated",
          summary: `Przeliczono ceny w ofercie ${offer.number} (${n} poz.)`,
        });
      }
      return n;
    });
    return respond(
      c,
      loadOfferSync(db, offerId),
      changed > 0 ? `Zaktualizowano ceny w ${changed} pozycjach` : "Ceny są aktualne"
    );
  })
);

// ---------------------------------------------------------------------------
// AKCEPTACJA — zlecenie + szkic WZ w JEDNEJ transakcji
// ---------------------------------------------------------------------------

/**
 * Pola, których `orders` wymaga (NOT NULL), a oferta ich nie zna: osoba
 * zlecająca i kontakt na obiekcie. Bierzemy je z ciała żądania, a czego brak —
 * z kartoteki kontrahenta. Gdy i tam pusto, mówimy o tym wprost zamiast wkładać
 * do bazy pustego stringa, który potem nikomu nic nie powie.
 */
interface AcceptContact {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string | null;
}

function resolveContact(
  body: Record<string, unknown>,
  contractor: { contactPerson: string | null; phone: string | null; email: string | null } | null
): AcceptContact {
  const requesterName = str(body.requesterName) || contractor?.contactPerson || "";
  const requesterPhone = str(body.requesterPhone) || contractor?.phone || "";
  const requesterEmail = str(body.requesterEmail) || contractor?.email || "";
  const contactPerson = str(body.contactPerson) || requesterName;
  const contactPhone = str(body.contactPhone) || requesterPhone;

  const missing: string[] = [];
  if (!requesterName) missing.push("osoba zlecająca");
  if (!requesterPhone) missing.push("telefon zlecającego");
  if (!requesterEmail) missing.push("e-mail zlecającego");
  if (!contactPerson) missing.push("kontakt na obiekcie");
  if (!contactPhone) missing.push("telefon kontaktu");
  if (missing.length) {
    throw new ApiError(
      400,
      `Zlecenie wymaga danych, których nie ma w ofercie ani u kontrahenta: ${missing.join(", ")}`
    );
  }

  return {
    requesterName,
    requesterPhone,
    requesterEmail,
    contactPerson,
    contactPhone,
    contactEmail: str(body.contactEmail) || contractor?.email || null,
  };
}

/**
 * Akceptacja oferty:
 *   1. status → accepted,
 *   2. ZLECENIE z migawek oferty (abonament i dzierżawa lądują w polach, które
 *      `orders` ma od dawna: monthly_amount / rental_amount),
 *   3. SZKIC WZ z pozycjami sprzętowymi — do zatwierdzenia ręcznie w Magazynie.
 *
 * Wszystko w jednej transakcji: zaakceptowana oferta bez zlecenia albo zlecenie
 * bez śladu w ofercie to stan, którego nikt później nie posprząta.
 * Szkic WZ NIE zdejmuje stanów — ruchy powstaną dopiero przy zatwierdzeniu.
 */
app.post("/:id/accept", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator oferty");
    const user = getUser(c);
    const b = body as Record<string, unknown>;

    const result = db.transaction((tx) => {
      const offer = tx.select().from(schema.offers).where(eq(schema.offers.id, id)).all()[0];
      if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
      // Akceptować można WYŁĄCZNIE ofertę wysłaną. Wcześniej blokada patrzyła
      // tylko na `accepted` i `draft`, więc oferta ODRZUCONA przez klienta dała
      // się zaakceptować i lądowała w rejestrze zleceń.
      if (offer.status !== "sent")
        throw new ApiError(
          409,
          offer.status === "draft"
            ? "Najpierw wyślij ofertę do klienta"
            : `Oferta ${offer.number} jest już zamknięta (${offer.status})`
        );
      // `expired` nie jest zapisywane w bazie, tylko wyliczane — sprawdzamy je
      // osobno, inaczej dałoby się zaakceptować dokument po terminie ważności.
      if (effectiveStatus(offer, todayISO()) === "expired")
        throw new ApiError(
          409,
          `Oferta ${offer.number} straciła ważność ${offer.validUntil} — utwórz nową wersję`
        );

      const sections = tx
        .select()
        .from(schema.offerSections)
        .where(eq(schema.offerSections.offerId, id))
        .all();
      const items = tx
        .select()
        .from(schema.offerItems)
        .where(eq(schema.offerItems.offerId, id))
        .all();
      const { values } = getCompanyConfig();
      const totals = computeOffer(offer, sections, items, values.minMarginPct);

      const contractor = offer.contractorId
        ? tx
            .select()
            .from(schema.contractors)
            .where(eq(schema.contractors.id, offer.contractorId))
            .all()[0] ?? null
        : null;
      const contact = resolveContact(b, contractor);

      /*
       * Płatnik musi być kompletny. `orders.payer_nip` jest NOT NULL, ale pusty
       * string przechodzi przez tę kontrolę — do CRM wchodziło wtedy zlecenie
       * „—" bez NIP-u, którego nie da się zafakturować. Ta sama zasada, którą
       * `resolveContact` stosuje do danych kontaktowych: brak danych zgłaszamy,
       * zamiast wkładać do bazy pustkę.
       */
      const payerName = offer.clientName || contractor?.name || "";
      const payerNip = offer.clientNip || contractor?.nip || "";
      const missingPayer: string[] = [];
      if (!payerName) missingPayer.push("nazwa płatnika");
      if (!payerNip) missingPayer.push("NIP płatnika");
      if (missingPayer.length)
        throw new ApiError(
          400,
          `Zlecenie wymaga danych, których nie ma w ofercie ani u kontrahenta: ${missingPayer.join(", ")}`
        );

      const issuer = offer.companyId
        ? tx
            .select()
            .from(schema.companies)
            .where(eq(schema.companies.id, offer.companyId))
            .all()[0] ?? null
        : null;

      // --- 1. Zlecenie ---
      // Numer bywa losowy (ZL-RRRR-NNNNN), więc kolizja na UNIQUE jest możliwa;
      // ponawiamy z nowym numerem, jak w src/services/orders.ts.
      let order: typeof schema.orders.$inferSelect | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          order = tx
            .insert(schema.orders)
            .values({
              orderNumber: generateOrderNumber(),
              requesterName: contact.requesterName,
              requesterPhone: contact.requesterPhone,
              requesterEmail: contact.requesterEmail,
              payerName: payerName,
              payerNip: payerNip,
              payerContractorId: offer.contractorId,
              objectName: offer.site || "—",
              objectAddress: offer.address || null,
              objectId: offer.objectId,
              contactPerson: contact.contactPerson,
              contactPhone: contact.contactPhone,
              contactEmail: contact.contactEmail,
              monthlyAmount: totals.monthlyPrice || null,
              contractLengthMonths: offer.leaseMonths ?? null,
              rentalAmount: totals.leaseMonthly || null,
              rentalLengthMonths:
                offer.leaseMode === "y1" ? 12 : offer.leaseMode === "y2" ? 24 : offer.leaseMonths,
              invoiceIssuer: issuer?.name ?? null,
              status: "new",
              notes: `Z oferty ${offer.number}`,
            })
            .returning()
            .get();
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") {
            throw err;
          }
        }
      }
      if (!order) throw new ApiError(409, "Nie udało się nadać numeru zlecenia — spróbuj ponownie");

      // --- 2. Szkic WZ ---
      // Tylko sprzęt z magazynu; robocizna i abonament nie mają czego wydawać.
      // Pomijamy pozycje opcjonalne i niewybrane warianty — do klienta jedzie
      // to, co faktycznie kupił.
      const countedSectionIds = new Set(
        sections
          .filter((s) => !s.isOptional && (!s.variantGroup || s.variantSelected))
          .map((s) => s.id)
      );
      const shippable = items.filter(
        (i) =>
          i.source === "warehouse" &&
          i.warehouseItemId !== null &&
          i.kind === "material" &&
          !i.isOptional &&
          countedSectionIds.has(i.sectionId) &&
          i.qty > 0
      );

      /*
       * Towar ZARCHIWIZOWANY przechodzi przez `validateDocRefsSync` (ono
       * sprawdza tylko istnienie), a blokuje dopiero `confirmDocumentSync` —
       * czyli powstawał szkic WZ, którego magazynier nigdy nie zatwierdzi,
       * i zaakceptowana oferta zostawała z martwym dokumentem. Mówimy o tym
       * od razu, bo zarchiwizowanego sprzętu i tak nie da się wydać.
       */
      const archived = shippable
        .map((i) =>
          tx
            .select({ name: schema.warehouseItems.name, isArchived: schema.warehouseItems.isArchived })
            .from(schema.warehouseItems)
            .where(eq(schema.warehouseItems.id, i.warehouseItemId as number))
            .all()[0]
        )
        .filter((r) => r?.isArchived)
        .map((r) => r!.name);
      if (archived.length)
        throw new ApiError(
          409,
          `Nie da się wydać zarchiwizowanego towaru: ${archived.join(", ")} — przywróć go w Magazynie albo usuń z oferty`
        );

      let docId: number | null = null;
      if (shippable.length > 0) {
        const mainWarehouse = tx
          .select()
          .from(schema.warehouses)
          .where(and(eq(schema.warehouses.type, "main"), eq(schema.warehouses.isArchived, false)))
          .all()[0];
        if (!mainWarehouse)
          throw new ApiError(409, "Brak magazynu głównego — nie ma z czego wystawić WZ");

        const doc = createDocumentSync(
          tx,
          {
            docType: "WZ",
            warehouseFromId: mainWarehouse.id,
            warehouseToId: null,
            contractorName: offer.clientName || contractor?.name || null,
            invoiceNumber: null,
            invoiceFileName: null,
            invoiceFileData: null,
            issuedAt: todayISO(),
            notes: `Z oferty ${offer.number}`,
          },
          shippable.map((i) => ({
            itemId: i.warehouseItemId as number,
            quantity: i.qty,
            unitPrice: i.unitPrice,
          })),
          user?.email ?? null,
          // Szkic, nie zatwierdzenie: stany schodzą dopiero, gdy magazynier
          // faktycznie wyda sprzęt.
          false
        );
        docId = doc.id;
      }

      tx.update(schema.offers)
        .set({
          status: "accepted",
          orderId: order.id,
          warehouseDocId: docId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.offers.id, id))
        .run();

      logActivity(tx, {
        entityType: "offer",
        entityId: id,
        objectId: offer.objectId,
        user,
        action: "status_changed",
        field: "status",
        oldValue: offer.status,
        newValue: "accepted",
        summary:
          `Oferta ${offer.number} zaakceptowana → zlecenie ${order.orderNumber}` +
          (docId ? ` + szkic WZ (${shippable.length} poz.)` : " (bez pozycji do wydania)"),
      });

      return { orderId: order.id, orderNumber: order.orderNumber, warehouseDocId: docId };
    });

    return respond(
      c,
      { ...loadOfferSync(db, id), created: result },
      `Utworzono zlecenie ${result.orderNumber}` +
        (result.warehouseDocId ? " i szkic WZ" : "")
    );
  });
});

// ---------------------------------------------------------------------------
// OFERTA Z PROJEKTU CCTV
// ---------------------------------------------------------------------------

/**
 * Oferta z projektu designera monitoringu.
 *
 * Projekt zna liczbę kamer postawionych na mapie (src/routes/monitoring.ts
 * liczy ją tak samo), więc wystarczy podać pakiet — parametr `cameras`
 * uzupełnia się sam. Domyka moduł Projekty, który dotąd generował ładny
 * dokument bez jednej złotówki.
 */
app.post("/from-monitoring/:projectId", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const projectId = requireId(c.req.param("projectId"), "identyfikator projektu");
    const b = body as Record<string, unknown>;
    const packageId = optId(b.packageId, "identyfikator pakietu");
    const user = getUser(c);

    /*
     * Ta trasa CZYTA rejestr projektów CCTV, więc wymaga uprawnienia do niego.
     * `API_TAB_MAP` przypisuje cały prefiks `/offers` do `technical/oferty`,
     * a to za mało: bez tej kontroli dało się enumerować projekty po id
     * (nazwa, adres, liczba kamer wracały w odpowiedzi) mając zamknięte Projekty.
     */
    if (!user || !canView(user, "technical/projekty"))
      throw new ApiError(403, "Brak dostępu do projektów CCTV");

    const created = db.transaction((tx) => {
      const project = tx
        .select()
        .from(schema.monitoringProjects)
        .where(eq(schema.monitoringProjects.id, projectId))
        .all()[0];
      if (!project) throw new ApiError(404, "Nie znaleziono projektu");

      let cameras = 0;
      try {
        const data = JSON.parse(project.data) as { cameras?: unknown };
        cameras = Array.isArray(data.cameras) ? data.cameras.length : 0;
      } catch {
        cameras = 0; // projekt bez zapisanego stanu — oferta powstaje pusta
      }

      const date = todayISO();
      const offer = tx
        .insert(schema.offers)
        .values({
          number: nextOfferNumberSync(tx, date),
          date,
          kind: "montaz",
          site: project.name,
          address: project.address ?? "",
          objectId: optId(b.objectId, "identyfikator obiektu"),
          contractorId: optId(b.contractorId, "identyfikator kontrahenta"),
          notes: `Z projektu CCTV „${project.name}” (${cameras} kamer na planie)`,
          createdBy: user?.email ?? null,
        } as NewOffer)
        .returning()
        .get();

      if (packageId !== null && cameras > 0) {
        const pkg = tx
          .select()
          .from(schema.offerPackages)
          .where(eq(schema.offerPackages.id, packageId))
          .all()[0];
        if (!pkg) throw new ApiError(404, "Nie znaleziono pakietu");
        const pkgItems = tx
          .select()
          .from(schema.offerPackageItems)
          .where(eq(schema.offerPackageItems.packageId, packageId))
          .all();
        const { values } = getCompanyConfig();
        const expanded = expandPackage(
          pkg,
          pkgItems,
          { cameras },
          priceSourceSync(tx, values.warehouseMarkup)
        );
        if (expanded.missingPrices.length)
          throw new ApiError(
            400,
            `Brak ceny w kartotece: ${expanded.missingPrices.join(", ")} — uzupełnij ją przed wyceną projektu`
          );
        const drafts = expanded.drafts;

        const section = tx
          .insert(schema.offerSections)
          .values({
            offerId: offer.id,
            position: 1,
            category: pkg.category,
            title: pkg.name,
            packageId,
            params: JSON.stringify({ cameras }),
          })
          .returning()
          .get();

        drafts.forEach((d) => {
          tx.insert(schema.offerItems)
            .values({ ...d, offerId: offer.id, sectionId: section.id })
            .run();
        });
      }

      logActivity(tx, {
        entityType: "offer",
        entityId: offer.id,
        user,
        action: "created",
        summary: `Utworzono ofertę ${offer.number} z projektu CCTV „${project.name}”`,
      });
      return offer;
    });

    return c.json(
      { success: true, data: created, message: `Utworzono ofertę ${created.number}` },
      201
    );
  });
});

export default app;
