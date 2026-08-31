/**
 * Rozwijanie pakietu oferty na konkretne pozycje.
 *
 * Pakiet to przepis, nie lista: „CCTV Dahua" z parametrem `cameras = 8` daje
 * 8 kamer, 1 rejestrator (jeden na każde 8, zaokrąglone w górę), 1 dysk,
 * 8 montaży i 1 uruchomienie. Dzięki temu jeden zapisany pakiet obsługuje
 * każdą wielkość instalacji, zamiast mnożyć warianty 4/8/16 w bibliotece.
 *
 * Funkcje są CZYSTE — nie dotykają bazy, więc dają się przetestować wprost
 * (scripts/test-offer-calc.ts). Ceny i koszty podaje wołający przez `priceSource`.
 */
import type {
  OfferItemBilling,
  OfferItemKind,
  OfferItemSource,
  OfferPackage,
  OfferPackageItem,
} from "../db/schema.js";
import { round2 } from "./margin.js";

/** Definicja jednego parametru pakietu (JSON w `offer_packages.params`). */
export interface OfferPackageParam {
  key: string;
  label: string;
  default?: number;
  min?: number;
  max?: number;
}

/** Ceny i koszty źródła pozycji — wstrzykiwane, żeby moduł nie znał bazy. */
export interface PriceSource {
  /** Koszt własny netto; null = nieznany (i to NIE jest zero). */
  cost: (source: OfferItemSource, refId: number | null) => number | null;
  /** Cena sprzedaży netto; null = nieznana. */
  price: (source: OfferItemSource, refId: number | null) => number | null;
  /** Aktualna nazwa i jednostka ze źródła (do migawki na pozycji). */
  label: (
    source: OfferItemSource,
    refId: number | null
  ) => { name: string; unit: string } | null;
}

/** Pozycja gotowa do zapisania w `offer_items` (bez id i powiązań). */
export interface OfferItemDraft {
  source: OfferItemSource;
  warehouseItemId: number | null;
  serviceId: number | null;
  name: string;
  unit: string;
  qty: number;
  kind: OfferItemKind;
  billing: OfferItemBilling;
  unitCost: number | null;
  unitPrice: number;
  discountPct: number;
  isOptional: boolean;
  position: number;
}

/** Bezpieczny parse definicji parametrów pakietu. */
export function parsePackageParams(raw: string): OfferPackageParam[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is OfferPackageParam =>
        !!p && typeof p === "object" && typeof (p as OfferPackageParam).key === "string"
    );
  } catch {
    return [];
  }
}

/** Bezpieczny parse wartości parametrów użytych w sekcji ({"cameras": 8}). */
export function parseParamValues(raw: string): Record<string, number> {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Uzupełnia brakujące parametry wartościami domyślnymi i przycina do widełek.
 * Parametr spoza definicji pakietu jest odrzucany — inaczej literówka w kluczu
 * po cichu nie skalowałaby niczego.
 */
export function normalizeParams(
  defs: OfferPackageParam[],
  values: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of defs) {
    let v = values[def.key];
    if (!Number.isFinite(v)) v = def.default ?? 0;
    if (def.min !== undefined && v < def.min) v = def.min;
    if (def.max !== undefined && v > def.max) v = def.max;
    out[def.key] = v;
  }
  return out;
}

/** Ilość jednej pozycji pakietu po przeskalowaniu parametrem. */
export function qtyFor(
  item: Pick<OfferPackageItem, "qtyBase" | "qtyPerParam" | "paramKey" | "qtyRound">,
  params: Record<string, number>
): number {
  const paramValue =
    item.paramKey && Number.isFinite(params[item.paramKey])
      ? params[item.paramKey]
      : 0;
  const raw = item.qtyBase + item.qtyPerParam * paramValue;
  if (item.qtyRound === "up") {
    // Zaokrąglamy „prawie całość" w dół, żeby błąd zmiennoprzecinkowy
    // (8 × 0.125 = 0.9999999999999999) nie kupował drugiego rejestratora.
    const eps = 1e-9;
    return Math.ceil(raw - eps);
  }
  // ILOŚĆ TO NIE KWOTA — zaokrąglenie do groszy (round2) obcinało tu mnożnik:
  // 0,0625 × 5 dawało 0,31 zamiast 0,3125. Przy pozycjach rozliczanych ułamkiem
  // (metry kabla na kamerę, licencja na kanał) ilość szła w dół, a błąd narastał
  // liniowo z parametrem. Ta sama precyzja co `qtyNum()` w src/routes/offers.ts.
  return Math.round(raw * 1e6) / 1e6;
}

function refIdOf(item: Pick<OfferPackageItem, "source" | "warehouseItemId" | "serviceId">) {
  if (item.source === "warehouse") return item.warehouseItemId ?? null;
  if (item.source === "service") return item.serviceId ?? null;
  return null;
}

/** Wynik rozwinięcia pakietu: pozycje + nazwy tych, których ceny nie da się ustalić. */
export interface ExpandResult {
  drafts: OfferItemDraft[];
  /**
   * Pozycje, dla których ŹRÓDŁO NIE ZNA CENY (towar zniknął z kartoteki albo
   * nie ma ani ceny sprzedaży, ani zakupu). Wołający ma na to zareagować —
   * wcześniej takie pozycje wchodziły na ofertę po 0 zł, czyli firma oddawała
   * sprzęt za darmo, cicho. Cena 0 WPISANA w kartotece to co innego: jest znana
   * i przechodzi normalnie.
   */
  missingPrices: string[];
}

/**
 * Rozwija pakiet na pozycje oferty.
 *
 * Pakiet `fixed` ignoruje parametry i bierze same `qtyBase` — dzięki temu ten
 * sam mechanizm obsługuje sztywne zestawy bez osobnej ścieżki w kodzie.
 * Pozycje o wyliczonej ilości ≤ 0 są pomijane: pakiet z pozycją „jedna na
 * każde 8 kamer" przy zerowym parametrze nie ma czego dodawać.
 */
export function expandPackage(
  pkg: Pick<OfferPackage, "mode" | "params">,
  items: OfferPackageItem[],
  paramValues: Record<string, number>,
  priceSource: PriceSource
): ExpandResult {
  const defs = pkg.mode === "fixed" ? [] : parsePackageParams(pkg.params);
  const params = normalizeParams(defs, paramValues);

  const drafts: OfferItemDraft[] = [];
  const missingPrices: string[] = [];
  const sorted = [...items].sort((a, b) => a.position - b.position || a.id - b.id);

  for (const item of sorted) {
    const qty =
      pkg.mode === "fixed" ? round2(item.qtyBase) : qtyFor(item, params);
    if (qty <= 0) continue;

    const refId = refIdOf(item);
    const label = priceSource.label(item.source, refId);
    // `??` celowo: `unitPriceOverride = 0` to narzucone „za darmo" i przechodzi,
    // a dopiero brak jednej i drugiej ceny znaczy „nie wiem".
    const resolved = item.unitPriceOverride ?? priceSource.price(item.source, refId);
    const price = resolved ?? 0;
    if (resolved === null) {
      missingPrices.push(label?.name || item.name || "(pozycja bez nazwy)");
    }

    drafts.push({
      source: item.source,
      warehouseItemId: item.source === "warehouse" ? refId : null,
      serviceId: item.source === "service" ? refId : null,
      // Nazwa ze źródła jest świeższa niż zapisana w pakiecie; nazwa z pakietu
      // ratuje sytuację, gdy towar zniknął z kartoteki.
      name: label?.name || item.name || "(bez nazwy)",
      unit: label?.unit || item.unit || "szt",
      qty,
      kind: item.kind,
      billing: item.billing,
      unitCost: priceSource.cost(item.source, refId),
      unitPrice: round2(price),
      discountPct: 0,
      isOptional: false,
      position: drafts.length + 1,
    });
  }

  return { drafts, missingPrices };
}
