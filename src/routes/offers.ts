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
import { randomBytes } from "node:crypto";
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
  type NewOfferText,
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
  type OfferText,
  type OfferTextBlock,
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
import { createRateLimiter, clientIp } from "../lib/rate-limit.js";
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

/**
 * Dokleja do świeżej oferty wszystkie aktywne opisy z flagą „domyślny".
 *
 * Treść KOPIUJEMY, tak samo jak przy ręcznym dołożeniu opisu — późniejsza
 * poprawka wzorca nie ma prawa ruszyć dokumentu, który już powstał.
 */
function attachDefaultTextsSync(tx: Tx, offerId: number) {
  const defaults = tx
    .select()
    .from(schema.offerTexts)
    .where(and(eq(schema.offerTexts.active, true), eq(schema.offerTexts.isDefault, true)))
    .orderBy(asc(schema.offerTexts.position), asc(schema.offerTexts.name))
    .all();
  defaults.forEach((t, i) => {
    tx.insert(schema.offerTextBlocks)
      .values({ offerId, textId: t.id, title: t.title, body: t.body, position: i + 1 })
      .run();
  });
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
  // Podgląd aktualizacji cen — koszt „przed" i „po" na pozycji.
  "oldUnitCost",
  "newUnitCost",
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
  offer: Offer & {
    status: OfferStatus;
    leaseMonthsEffective: number | null;
    /** Handlowiec prowadzący, a bez niego autor dokumentu — nazwa na wydruk. */
    preparedBy: string | null;
    /** To samo dla klienta: null zamiast loginu, gdy nie ma nazwy do pokazania. */
    preparedByPublic: string | null;
  };
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
  /** Opisy handlowe wklejone na ten dokument — patrz `offer_text_blocks`. */
  texts: OfferTextBlock[];
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

  const texts = dbx
    .select()
    .from(schema.offerTextBlocks)
    .where(eq(schema.offerTextBlocks.offerId, id))
    .orderBy(asc(schema.offerTextBlocks.position), asc(schema.offerTextBlocks.id))
    .all();

  const { values } = getCompanyConfig();
  /*
   * Stawka prowizji jest w kartotece handlowca, nie na ofercie — bierzemy ją
   * przy odczycie, żeby zmiana stawki od razu przeliczała otwarte dokumenty
   * (tak samo jak narzut magazynowy przelicza ceny).
   */
  const salesperson =
    offer.salespersonId === null
      ? null
      : dbx
          .select()
          .from(schema.salespeople)
          .where(eq(schema.salespeople.id, offer.salespersonId))
          .all()[0] ?? null;
  const salesCommissionPct = salesperson?.commissionRate ?? null;

  /*
   * KTO WYKONAŁ OFERTĘ — nazwa, nie identyfikator, bo idzie na dokument (także
   * ten dla klienta). Pierwszy jest handlowiec prowadzący; gdy oferta nie ma
   * przypisanego handlowca, zostaje autor dokumentu. `created_by` trzyma LOGIN
   * z sesji, więc rozwiązujemy go na nazwę użytkownika — a gdy konta już nie ma,
   * zostawiamy login (lepszy ślad niż kreska), tak samo jak na liście ofert.
   */
  const authorName = offer.createdBy
    ? dbx
        .select({ email: schema.users.email, displayName: schema.users.displayName })
        .from(schema.users)
        .all()
        .find((u) => u.email.toLowerCase() === offer.createdBy!.toLowerCase())
        ?.displayName || null
    : null;
  const authorLabel = authorName || offer.createdBy || null;
  const salespersonName = salesperson
    ? `${salesperson.firstName} ${salesperson.lastName}`.trim()
    : null;
  const preparedBy = salespersonName ?? authorLabel;
  // Wariant na dokument dla KLIENTA: bez zapasowego loginu. Gdy konto autora
  // zniknęło, a handlowca nie ma, lepiej pominąć linię niż pokazać e-mail
  // z sesji — na zewnątrz to nie jest „ślad", tylko wyciek.
  const preparedByPublic = salespersonName ?? authorName;
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
      preparedBy,
      preparedByPublic,
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
    texts,
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
// OPISY — biblioteka powtarzalnych tekstów handlowych (gwarancja, wsparcie,
// warunki płatności). Montowane PRZED `/:id` z tego samego powodu co pakiety.
// ---------------------------------------------------------------------------

/**
 * Głowa opisu. `current` to rekord sprzed zapisu: pole pominięte w body bierze
 * wartość z niego, zamiast wracać do fabrycznej. Bez tego edytor — który nie ma
 * przełącznika archiwum i `active` nie wysyła — po każdym zapisie po cichu
 * przywracałby zarchiwizowany wzorzec do biblioteki.
 */
function parseTextHead(
  body: Record<string, unknown>,
  current?: OfferText
): Partial<NewOfferText> {
  const name = str(body.name);
  if (!name) throw new ApiError(400, "Nazwa opisu jest wymagana");

  return {
    name,
    category: oneOf(body.category, OFFER_SECTION_CATEGORIES, current?.category ?? "inne"),
    // Treść też scalamy z `current`: PUT z samym `name` (zmiana nazwy w
    // bibliotece) nie może wyzerować tytułu i tekstu wzorca.
    title: body.title === undefined ? current?.title ?? "" : str(body.title),
    // Markdown zapisujemy jak przyszedł — składnię rozwija front przy wydruku,
    // backendowi to zwykły tekst.
    body: body.body === undefined ? current?.body ?? "" : str(body.body),
    isDefault:
      body.isDefault === undefined ? current?.isDefault ?? false : Boolean(body.isDefault),
    active: body.active === undefined ? current?.active ?? true : Boolean(body.active),
    position: num(body.position, "Pozycja opisu", current?.position ?? 0) ?? 0,
  };
}

app.get("/texts", async (c) =>
  guard(c, () => {
    const includeInactive = c.req.query("includeInactive") === "1";
    const category = c.req.query("category");
    const filters: SQL[] = [];
    if (!includeInactive) filters.push(eq(schema.offerTexts.active, true));
    if (category && (OFFER_SECTION_CATEGORIES as readonly string[]).includes(category)) {
      filters.push(eq(schema.offerTexts.category, category as OfferSectionCategory));
    }
    const rows = db
      .select()
      .from(schema.offerTexts)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(schema.offerTexts.position), asc(schema.offerTexts.name))
      .all();
    return c.json({ success: true, data: rows });
  })
);

app.get("/texts/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator opisu");
    const row = db
      .select()
      .from(schema.offerTexts)
      .where(eq(schema.offerTexts.id, id))
      .all()[0];
    if (!row) throw new ApiError(404, "Nie znaleziono opisu");
    return c.json({ success: true, data: row });
  })
);

app.post("/texts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const head = parseTextHead(body);
    const created = db.transaction((tx) => {
      const row = tx
        .insert(schema.offerTexts)
        .values(head as NewOfferText)
        .returning()
        .get();
      logActivity(tx, {
        entityType: "offer_text",
        entityId: row.id,
        user: getUser(c),
        action: "created",
        summary: `Dodano opis ofertowy „${row.name}”`,
      });
      return row;
    });
    return c.json({ success: true, data: created, message: "Opis dodany" }, 201);
  });
});

/** PUT podmienia głowę opisu; pole pominięte w body zostaje bez zmian. */
app.put("/texts/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator opisu");
    const updated = db.transaction((tx) => {
      const before = tx
        .select()
        .from(schema.offerTexts)
        .where(eq(schema.offerTexts.id, id))
        .all()[0];
      if (!before) throw new ApiError(404, "Nie znaleziono opisu");
      const head = parseTextHead(body, before);
      const row = tx
        .update(schema.offerTexts)
        .set({ ...head, updatedAt: new Date().toISOString() })
        .where(eq(schema.offerTexts.id, id))
        .returning()
        .get();
      logFieldDiffs(tx, {
        entityType: "offer_text",
        entityId: id,
        user: getUser(c),
        before,
        after: row,
        fields: [
          "name",
          "category",
          "title",
          // Treść skracamy w podsumowaniu jak opis wydarzenia w kalendarzu —
          // pełne wartości i tak lądują w old_value/new_value.
          {
            key: "body",
            label: "treść",
            format: (v) => (v ? String(v).slice(0, 60) + (String(v).length > 60 ? "…" : "") : "—"),
          },
          "isDefault",
          "active",
        ],
      });
      return row;
    });
    return c.json({ success: true, data: updated, message: "Opis zapisany" });
  });
});

/**
 * DELETE = archiwizacja. Bloki na wystawionych ofertach trzymają własną kopię
 * treści, ale `offer_text_blocks.text_id` ma wskazywać, skąd tekst przyszedł —
 * skasowanie wzorca zabrałoby ten ślad razem z całą biblioteką.
 */
app.delete("/texts/:id", async (c) =>
  guard(c, () => {
    const id = requireId(c.req.param("id"), "identyfikator opisu");
    const row = db
      .select()
      .from(schema.offerTexts)
      .where(eq(schema.offerTexts.id, id))
      .all()[0];
    if (!row) throw new ApiError(404, "Nie znaleziono opisu");
    db.transaction((tx) => {
      tx.update(schema.offerTexts)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(schema.offerTexts.id, id))
        .run();
      logActivity(tx, {
        entityType: "offer_text",
        entityId: id,
        user: getUser(c),
        action: "deleted",
        summary: `Zarchiwizowano opis „${row.name}”`,
      });
    });
    return c.json({ success: true, data: null, message: "Opis zarchiwizowany" });
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
      attachDefaultTextsSync(tx, offer.id);
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
          // Nowa wersja to nieuzgodniony szkic — link klienta NIE MOŻE na nią
          // przeskoczyć, więc tokenu nie kopiujemy. Bez tego spread przenosił
          // `shareToken` i UNIQUE na `offers.share_token` wywalał wersjonowanie
          // każdej udostępnionej oferty — indeks był jedyną rzeczą, która
          // trzymała link przy dokumencie, który klient faktycznie widział.
          shareToken: null,
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

      /*
       * Opisy kopiujemy Z RODZICA, a nie z biblioteki: nowa wersja ma odtwarzać
       * dokument 1:1, więc wjeżdżają dokładnie te teksty, które klient widział —
       * nawet gdy wzorce w katalogu zdążyły się zmienić.
       */
      const textBlocks = tx
        .select()
        .from(schema.offerTextBlocks)
        .where(eq(schema.offerTextBlocks.offerId, id))
        .orderBy(asc(schema.offerTextBlocks.position), asc(schema.offerTextBlocks.id))
        .all();
      for (const b of textBlocks) {
        tx.insert(schema.offerTextBlocks)
          .values({
            ...b,
            id: undefined,
            offerId: offer.id,
            createdAt: undefined,
            updatedAt: undefined,
          })
          .run();
      }

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
// OPISY NA OFERCIE — bloki tekstu; treść to KOPIA wzorca, nie odwołanie do niego
// ---------------------------------------------------------------------------

function nextTextBlockPositionSync(tx: Tx, offerId: number): number {
  const rows = tx
    .select({ position: schema.offerTextBlocks.position })
    .from(schema.offerTextBlocks)
    .where(eq(schema.offerTextBlocks.offerId, offerId))
    .all();
  return rows.reduce((max, r) => Math.max(max, r.position), 0) + 1;
}

function loadTextBlockSync(tx: Tx, offerId: number, tid: number) {
  const block = tx
    .select()
    .from(schema.offerTextBlocks)
    .where(
      and(eq(schema.offerTextBlocks.id, tid), eq(schema.offerTextBlocks.offerId, offerId))
    )
    .all()[0];
  if (!block) throw new ApiError(404, "Nie znaleziono opisu w tej ofercie");
  return block;
}

/**
 * Dołożenie opisu. Z `textId` treść przychodzi z biblioteki, bez niego powstaje
 * pusty blok do napisania ręcznie.
 */
app.post("/:id/texts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const b = body as Record<string, unknown>;
    const textId = optId(b.textId, "identyfikator opisu");

    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);

      let tpl: OfferText | null = null;
      if (textId !== null) {
        tpl =
          tx
            .select()
            .from(schema.offerTexts)
            .where(eq(schema.offerTexts.id, textId))
            .all()[0] ?? null;
        if (!tpl) throw new ApiError(404, "Nie znaleziono opisu");
      }

      tx.insert(schema.offerTextBlocks)
        .values({
          offerId,
          textId,
          // Treść wzorca KOPIUJEMY; pola podane wprost w ciele mają
          // pierwszeństwo, bo tekst często dostosowuje się do klienta.
          title: b.title === undefined ? tpl?.title ?? "" : str(b.title),
          body: b.body === undefined ? tpl?.body ?? "" : str(b.body),
          position: nextTextBlockPositionSync(tx, offerId),
        })
        .run();
    });

    return respond(c, loadOfferSync(db, offerId), "Opis dodany", 201);
  });
});

app.put("/:id/texts/:tid", async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const tid = requireId(c.req.param("tid"), "identyfikator opisu");
    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const block = loadTextBlockSync(tx, offerId, tid);
      // Patch CZĄSTKOWY: pominięte pole zostaje takie, jakie było — front
      // zapisuje sam nagłówek albo samą treść, zależnie od pola w edytorze.
      tx.update(schema.offerTextBlocks)
        .set({
          title: body.title === undefined ? block.title : str(body.title),
          body: body.body === undefined ? block.body : str(body.body),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.offerTextBlocks.id, tid))
        .run();
    });
    return respond(c, loadOfferSync(db, offerId), "Opis zapisany");
  });
});

app.delete("/:id/texts/:tid", async (c) =>
  guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const tid = requireId(c.req.param("tid"), "identyfikator opisu");
    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      loadTextBlockSync(tx, offerId, tid);
      tx.delete(schema.offerTextBlocks).where(eq(schema.offerTextBlocks.id, tid)).run();
    });
    return respond(c, loadOfferSync(db, offerId), "Opis usunięty");
  })
);

/** Nowa kolejność opisów na dokumencie — `ids` w kolejności docelowej. */
app.post("/:id/texts/reorder", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const raw = (body as Record<string, unknown>).ids;
    if (!Array.isArray(raw))
      throw new ApiError(400, "Podaj listę identyfikatorów opisów w nowej kolejności");
    const ids = raw.map((v: unknown) => requireId(String(v), "identyfikator opisu"));
    if (new Set(ids).size !== ids.length)
      throw new ApiError(400, "Ten sam opis wystąpił w kolejności dwa razy");

    db.transaction((tx) => {
      loadEditableOfferSync(tx, offerId);
      const current = tx
        .select({ id: schema.offerTextBlocks.id })
        .from(schema.offerTextBlocks)
        .where(eq(schema.offerTextBlocks.offerId, offerId))
        .all();
      const known = new Set(current.map((b) => b.id));
      const foreign = ids.filter((id) => !known.has(id));
      if (foreign.length)
        throw new ApiError(
          400,
          `Opis ${foreign.join(", ")} nie należy do tej oferty`
        );
      /*
       * Lista musi być KOMPLETNA. Przy niepełnej przestawilibyśmy część bloków,
       * a reszta zostałaby ze starymi numerami — kolejność na wydruku wyszłaby
       * z przemieszania obu, czyli losowa.
       */
      if (ids.length !== current.length)
        throw new ApiError(
          400,
          `Kolejność musi objąć wszystkie opisy oferty (${current.length}), a przysłano ${ids.length}`
        );

      ids.forEach((id, i) => {
        tx.update(schema.offerTextBlocks)
          .set({ position: i + 1, updatedAt: new Date().toISOString() })
          .where(eq(schema.offerTextBlocks.id, id))
          .run();
      });
    });
    return respond(c, loadOfferSync(db, offerId), "Kolejność opisów zapisana");
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
 * Aktualizacja cen wg AKTUALNYCH kartotek.
 *
 * Pozycje są migawkami (i tak ma zostać), ale szkic sprzed miesiąca potrafi
 * mieć nieaktualne ceny. To jawna, ręczna akcja — nigdy nie dzieje się sama,
 * żeby oferta nie zmieniła kwoty między obejrzeniem a wydrukiem.
 */

/** Jedna pozycja, którą aktualizacja by ruszyła — z ceną „przed" i „po". */
export interface RepriceChange {
  itemId: number;
  sectionTitle: string;
  name: string;
  unit: string;
  qty: number;
  oldUnitPrice: number;
  newUnitPrice: number;
  oldUnitCost: number | null;
  newUnitCost: number | null;
}

/**
 * Co aktualizacja by zmieniła — bez zapisu.
 *
 * Ta sama funkcja karmi podgląd w modalu i właściwy zapis, więc lista pokazana
 * użytkownikowi nie może się rozjechać z tym, co naprawdę wejdzie do bazy.
 */
function repriceChangesSync(dbx: DbOrTx, offerId: number): RepriceChange[] {
  const { values } = getCompanyConfig();
  const src = priceSourceSync(dbx, values.warehouseMarkup);
  const titles = new Map(
    dbx
      .select()
      .from(schema.offerSections)
      .where(eq(schema.offerSections.offerId, offerId))
      .all()
      .map((s) => [s.id, s.title] as const)
  );
  const items = dbx
    .select()
    .from(schema.offerItems)
    .where(eq(schema.offerItems.offerId, offerId))
    .orderBy(asc(schema.offerItems.position), asc(schema.offerItems.id))
    .all();

  const out: RepriceChange[] = [];
  for (const it of items) {
    if (it.source === "manual") continue; // ręcznej pozycji nie ma z czego przeliczyć
    const refId = it.source === "warehouse" ? it.warehouseItemId : it.serviceId;
    const price = src.price(it.source, refId);
    const cost = src.cost(it.source, refId);
    if (price === null) continue; // źródło zniknęło — zostawiamy migawkę
    // Koszt porównujemy z tą samą tolerancją co cenę — oba przechodzą przez
    // round2 i marżę, więc `===` na floatach zgłaszało „zmianę" o 1e-13.
    // Null (brak kosztu w kartotece) to osobny stan, nie zero.
    const costSame =
      cost === null || it.unitCost === null
        ? cost === it.unitCost
        : Math.abs(cost - it.unitCost) < 0.005;
    if (Math.abs(price - it.unitPrice) < 0.005 && costSame) continue;
    out.push({
      itemId: it.id,
      sectionTitle: titles.get(it.sectionId) ?? "",
      name: it.name,
      unit: it.unit,
      qty: it.qty,
      oldUnitPrice: it.unitPrice,
      newUnitPrice: price,
      oldUnitCost: it.unitCost,
      newUnitCost: cost,
    });
  }
  return out;
}

/** Podgląd przed zapisem — lista pozycji „z czego na co". */
app.get("/:id/reprice-preview", async (c) =>
  guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const offer = db.select().from(schema.offers).where(eq(schema.offers.id, offerId)).all()[0];
    if (!offer) throw new ApiError(404, "Nie znaleziono oferty");
    assertEditable(offer);
    return respond(c, repriceChangesSync(db, offerId));
  })
);

/**
 * Zapis aktualizacji. Bez ciała bierze wszystkie pozycje; z `itemIds` — tylko
 * wskazane, bo modal pozwala zaktualizować pojedynczy wiersz (jedna cena
 * podskoczyła, a reszty handlowiec nie chce ruszać przed wysyłką).
 */
app.post("/:id/reprice", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return guard(c, () => {
    const offerId = requireId(c.req.param("id"), "identyfikator oferty");
    const rawIds = (body as Record<string, unknown>).itemIds;
    // Klucz obecny, ale nie lista → błąd, nie „wszystkie pozycje". Literówka
    // w kliencie nie może po cichu przepisać cen w całej ofercie.
    if (rawIds !== undefined && !Array.isArray(rawIds))
      throw new ApiError(400, "itemIds musi być listą identyfikatorów");
    const only =
      Array.isArray(rawIds) && rawIds.length > 0
        ? new Set(rawIds.map((v: unknown) => requireId(String(v), "identyfikator pozycji")))
        : null;

    const changes = db.transaction((tx) => {
      const offer = loadEditableOfferSync(tx, offerId);
      const list = repriceChangesSync(tx, offerId).filter(
        (ch) => only === null || only.has(ch.itemId)
      );

      for (const ch of list) {
        tx.update(schema.offerItems)
          .set({ unitPrice: ch.newUnitPrice, unitCost: ch.newUnitCost })
          .where(eq(schema.offerItems.id, ch.itemId))
          .run();
      }

      if (list.length > 0) {
        // Zmiana ceny to zmiana dokumentu — znacznik jak przy PUT /:id, żeby
        // lista „ostatnio edytowane" i wiek ceny nie kłamały.
        tx.update(schema.offers)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(schema.offers.id, offerId))
          .run();
        logActivity(tx, {
          entityType: "offer",
          entityId: offerId,
          objectId: offer.objectId,
          user: getUser(c),
          action: "updated",
          summary:
            list.length === 1
              ? `Zaktualizowano cenę pozycji „${list[0].name}" w ofercie ${offer.number}`
              : `Zaktualizowano ceny w ofercie ${offer.number} (${list.length} poz.)`,
        });
      }
      return list;
    });
    return respond(
      c,
      loadOfferSync(db, offerId),
      changes.length > 0
        ? `Zaktualizowano ceny w ${changes.length} ${changes.length === 1 ? "pozycji" : "pozycjach"}`
        : "Ceny są aktualne"
    );
  });
});

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
      attachDefaultTextsSync(tx, offer.id);

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

// ---------------------------------------------------------------------------
// LINK DLA KLIENTA
//
// POST/DELETE /:id/share (chronione) wystawiają i cofają token, a
// `offersPublicRoutes` serwuje dokument spod `/api/public-offer/:token` BEZ
// żadnej autoryzacji. Wzorzec 1:1 z feedem ICS kalendarza.
// ---------------------------------------------------------------------------

/*
 * ADRES LINKU SKŁADA PRZEGLĄDARKA, NIE SERWER — zwracamy sam token.
 *
 * `new URL(c.req.url).origin` daje adres, pod którym API zostało WEWNĘTRZNIE
 * wywołane, a nie ten, którego używa człowiek. W dev vite proxuje `/api` na
 * `localhost:4001` z `changeOrigin: true` (nadpisuje nagłówek Host), więc
 * serwer wystawiłby klientowi `http://localhost:4001/oferta/...` — link
 * działający wyłącznie na maszynie dewelopera. Za reverse proxy (Dokploy,
 * Tailscale) jest tak samo: origin żądania to adres wewnętrzny.
 *
 * Nagłówkom `X-Forwarded-*` nie ufamy, bo da się je podrobić, a to jest adres,
 * który idzie do klienta. Jedyne miejsce, które ZNA prawdziwy adres, to karta
 * przeglądarki handlowca — tam składamy `${window.location.origin}/oferta/<token>`.
 */

/**
 * Wystawia (albo zwraca istniejący) token linku.
 *
 * ŚWIADOMIE BEZ `assertEditable`: sens linku polega na udostępnianiu oferty
 * WYSŁANEJ, a ta jest zamrożona. Token nie jest treścią dokumentu — zamrożenie
 * chroni kwoty i pozycje, nie sposób dostarczenia.
 */
app.post("/:id/share", (c) => {
  const id = Number(c.req.param("id"));
  const offer = db.select().from(schema.offers).where(eq(schema.offers.id, id)).get();
  if (!offer) return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono oferty" }, 404);

  // Robocza oferta zmienia się pod ręką — klient ma dostać dokument wysłany.
  if (offer.status === "draft") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Ofertę roboczą trzeba najpierw wysłać — dopiero wtedy da się ją udostępnić" },
      409
    );
  }
  // Odrzuconej też nie: publiczny widok nie ma dla niej żadnego oznaczenia
  // (baner ma tylko wygasła), więc klient dostałby dokument wyglądający na
  // aktualny. `sent`, `accepted` i wygasła (status `sent` po terminie) przechodzą.
  if (offer.status === "rejected") {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie można udostępnić odrzuconej oferty" },
      409
    );
  }

  const token = offer.shareToken ?? randomBytes(24).toString("hex");
  if (!offer.shareToken) {
    db.update(schema.offers).set({ shareToken: token }).where(eq(schema.offers.id, id)).run();
    logActivity(db, {
      entityType: "offer",
      entityId: id,
      user: getUser(c),
      action: "updated",
      summary: `Udostępniono ofertę ${offer.number} linkiem dla klienta`,
    });
  }
  return c.json({ success: true, data: { token } });
});

/** Cofa dostęp — stary link natychmiast przestaje działać. */
app.delete("/:id/share", (c) => {
  const id = Number(c.req.param("id"));
  const offer = db.select().from(schema.offers).where(eq(schema.offers.id, id)).get();
  if (!offer) return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono oferty" }, 404);

  if (offer.shareToken) {
    db.update(schema.offers).set({ shareToken: null }).where(eq(schema.offers.id, id)).run();
    logActivity(db, {
      entityType: "offer",
      entityId: id,
      user: getUser(c),
      action: "updated",
      summary: `Wyłączono link dla klienta do oferty ${offer.number}`,
    });
  }
  return c.json({ success: true, data: null, message: "Link został wyłączony" });
});

/**
 * Oferta widziana przez klienta — JAWNA BIAŁA LISTA pól.
 *
 * Nie da się tu użyć `redactCosts`: to CZARNA lista, która przepuszcza
 * `contractMonths`, `horizonRevenue`, `stock`, `priceDrift`, `createdBy`,
 * `salespersonId`, `orderId`, `notes` i całą resztę pól wewnętrznych. Na trasie
 * bez autoryzacji jedyne bezpieczne podejście to wypisanie tego, co MA wyjść.
 */
export interface PublicOfferDetail {
  offer: {
    number: string;
    version: number;
    date: string;
    validUntil: string | null;
    kind: OfferKind;
    clientName: string;
    clientNip: string;
    site: string;
    address: string;
    discountPct: number;
    leaseMode: OfferLeaseMode;
    leaseMonthsEffective: number | null;
    /** Kto wykonał ofertę — handlowiec prowadzący, a bez niego autor dokumentu. */
    preparedBy: string | null;
  };
  company: {
    name: string;
    fullName: string | null;
    nip: string | null;
    regon: string | null;
    krs: string | null;
    address: string | null;
    postalCode: string | null;
    city: string | null;
  } | null;
  sections: { id: number; title: string; position: number; isOptional: boolean }[];
  items: {
    sectionId: number;
    position: number;
    name: string;
    unit: string;
    qty: number;
    unitPrice: number;
    discountPct: number;
    isOptional: boolean;
    billing: OfferItemBilling;
    lineTotal: number;
  }[];
  texts: { title: string; body: string }[];
  totals: {
    oneTimePayable: number;
    equipmentValue: number;
    leaseMonthly: number;
    leaseMonthlyNet: number;
    monthlyPrice: number;
    monthlyPriceNet: number;
    monthlyTotal: number;
    optionsOneTime: number;
    optionsMonthly: number;
  };
  isExpired: boolean;
}

export const offersPublicRoutes = new Hono();

/*
 * Limit TYLKO per IP — bez sufitu globalnego, inaczej niż przy formularzu ZDW.
 * Tam globalny limit chroni zewnętrzne API (wykaz VAT) przed lawiną; tu nie ma
 * czego chronić: token ma 192 bity, więc zgadywanie jest beznadziejne, a
 * odczyt z SQLite jest tani. Sufit globalny był za to dźwignią DoS — jedna
 * maszyna wysyłająca 600 żądań zamykała dokument WSZYSTKIM klientom na 5 minut.
 * Adres bierze `clientIp()` z ostatniego członu XFF (dokładanego przez nasze
 * proxy), więc rotowanie fałszywych członów z przodu nie rozmnaża kluczy.
 */
const publicOfferPerIp = createRateLimiter({ limit: 60, windowMs: 5 * 60_000 });

offersPublicRoutes.get("/public-offer/:token", (c) => {
  const token = (c.req.param("token") || "").trim();

  // Krótki token nie ma prawa istnieć — odrzucamy bez ruszania bazy. Ten sam
  // 404 co przy nietrafionym tokenie: front obsługuje neutralnie tylko 404,
  // a rozróżnianie „za krótki" od „zły" nic nikomu nie daje.
  if (token.length < 16) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono oferty" }, 404);
  }

  if (!publicOfferPerIp.check(clientIp(c))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań — spróbuj ponownie za kilka minut" },
      429
    );
  }

  const row = db
    .select({ id: schema.offers.id })
    .from(schema.offers)
    .where(eq(schema.offers.shareToken, token))
    .get();
  // 404, nie 401 — nie potwierdzamy, że taka oferta w ogóle istnieje.
  if (!row) return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono oferty" }, 404);

  const detail = loadOfferSync(db, row.id);
  const { offer, totals } = detail;
  if (offer.status === "draft") {
    return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono oferty" }, 404);
  }

  const company = offer.companyId
    ? db.select().from(schema.companies).where(eq(schema.companies.id, offer.companyId)).get()
    : undefined;

  /*
   * Warianty rozstrzygamy PO STRONIE SERWERA. Gdyby filtrował tylko front,
   * odrzucona alternatywa („Dahua zamiast Hikvision") leżałaby w JSON-ie
   * w narzędziach przeglądarki — a to informacja handlowa, nie kosmetyka.
   */
  const sections = detail.sections.filter((s) => !s.variantGroup || s.variantSelected);
  const visibleIds = new Set(sections.map((s) => s.id));

  const data: PublicOfferDetail = {
    offer: {
      number: offer.number,
      version: offer.version,
      date: offer.date,
      validUntil: offer.validUntil,
      kind: offer.kind,
      clientName: offer.clientName,
      clientNip: offer.clientNip,
      site: offer.site,
      address: offer.address,
      discountPct: offer.discountPct,
      leaseMode: offer.leaseMode,
      leaseMonthsEffective: offer.leaseMonthsEffective,
      preparedBy: offer.preparedByPublic,
    },
    company: company
      ? {
          name: company.name,
          fullName: company.fullName,
          nip: company.nip,
          regon: company.regon,
          krs: company.krs,
          address: company.address,
          postalCode: company.postalCode,
          city: company.city,
        }
      : null,
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      position: s.position,
      isOptional: s.isOptional,
    })),
    items: detail.items
      .filter((i) => visibleIds.has(i.sectionId))
      .map((i) => ({
        sectionId: i.sectionId,
        position: i.position,
        name: i.name,
        unit: i.unit,
        qty: i.qty,
        unitPrice: i.unitPrice,
        discountPct: i.discountPct,
        isOptional: i.isOptional,
        billing: i.billing,
        lineTotal: i.lineTotal,
      })),
    texts: detail.texts.map((t) => ({ title: t.title, body: t.body })),
    totals: {
      oneTimePayable: totals.oneTimePayable,
      equipmentValue: totals.equipmentValue,
      leaseMonthly: totals.leaseMonthly,
      leaseMonthlyNet: totals.leaseMonthlyNet,
      monthlyPrice: totals.monthlyPrice,
      monthlyPriceNet: totals.monthlyPriceNet,
      monthlyTotal: totals.monthlyTotal,
      optionsOneTime: totals.optionsOneTime,
      optionsMonthly: totals.optionsMonthly,
    },
    isExpired: offer.status === "expired",
  };

  return c.json<ApiResponse<PublicOfferDetail>>({ success: true, data });
});

export default app;
