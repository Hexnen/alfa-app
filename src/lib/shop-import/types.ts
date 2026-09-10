/**
 * Typy importu towaru z zapisanej strony sklepu dostawcy.
 *
 * Osobny plik, bo te same kształty przechodzą przez trzy warstwy: parsery
 * (src/lib/shop-import/**), trasę `POST /warehouse/import/parse` i front
 * (frontend/src/lib/api.ts kopiuje je 1:1 — front nie importuje z backendu).
 * Każda zmiana pola to zmiana kontraktu w tych trzech miejscach naraz.
 */

/** Parser dedykowany sklepu; „generic” = tylko dane z JSON-LD/og/microdata. */
export type ParserId = "samal" | "janex" | "eltrox" | "grodno" | "generic";

/**
 * Klucz sklepu = domena bez `www.` (tak samo trzymamy go w
 * `warehouse_item_sources.shop`). Literały są tylko podpowiedzią dla edytora —
 * nieznany sklep też jest poprawnym kluczem, dlatego `& {}` przy `string`.
 */
export type ShopKey =
  | "samal.pl"
  | "janexint.com.pl"
  | "eltrox.pl"
  | "grodno.pl"
  | (string & {});

/**
 * Co właściwie znaczy cena, którą udało się wyciągnąć. „unknown” to sytuacja
 * „jedna cena bez etykiety” — wtedy trzymamy ją w `priceGross` (bo tak najczęściej
 * pokazują sklepy detaliczne), ale człowiek w panelu musi zdecydować.
 */
export type PriceKind = "net" | "gross" | "both" | "unknown";

/** Skąd wzięliśmy adres produktu (i tym samym domenę sklepu). */
export type ShopDetectedBy =
  | "urlHint"
  | "savedFrom"
  | "canonical"
  | "ogUrl"
  | "jsonLd"
  | "hiddenInput"
  | "linkHost"
  | "none";

export interface ParsedAttribute {
  name: string;
  value: string;
}

export interface ParseDiagnostics {
  /** Nazwy pól, które parser wypełnił (dla panelu „Diagnostyka”). */
  recognized: string[];
  /** Nazwy pól, których nie znalazł — to jest lista do kalibracji parsera. */
  missing: string[];
  /** Ostrzeżenia dla człowieka (brak logowania, cena bez etykiety, obcięcia). */
  warnings: string[];
  shopDetectedBy: ShopDetectedBy;
  parserUsed: ParserId;
  /** Wersja parsera sklepowego — po zmianie selektorów łatwo poznać stare zapisy. */
  parserVersion: string;
  htmlBytes: number;
  charset: string;
}

export interface ParsedProduct {
  shop: ShopKey;
  shopLabel: string;
  url: string | null;
  name: string | null;
  /** Kod u dostawcy (indeks sklepu) — po nim odświeżamy źródło. */
  supplierCode: string | null;
  /** Wewnętrzne id produktu w sklepie (do budowy URL-a / API sklepu). */
  supplierProductId: string | null;
  manufacturer: string | null;
  /** Symbol producenta — wspólny między sklepami, więc to klucz dopasowania. */
  manufacturerCode: string | null;
  ean: string | null;
  priceNet: number | null;
  priceGross: number | null;
  priceKind: PriceKind;
  vatRate: number | null;
  currency: string;
  stock: number | null;
  stockText: string | null;
  unit: string | null;
  category: string | null;
  descriptionText: string | null;
  attributes: ParsedAttribute[];
  imageUrl: string | null;
  loggedIn: boolean;
  loginSignals: string[];
  /** Tylko do UI („zapisano jako: …”) — NIE trafia do raw_json w bazie. */
  accountLabel: string | null;
  diagnostics: ParseDiagnostics;
}

/** Snapshot do `warehouse_item_sources.raw_json` — bez danych konta. */
export type ShopImportRaw = Omit<ParsedProduct, "accountLabel">;

/** Propozycja pól kartoteki towaru (człowiek zatwierdza w panelu). */
export interface ShopImportSuggestedItem {
  name: string | null;
  /** Nasz indeks nadaje człowiek — sklep nigdy go nie zna. */
  sku: null;
  category: string | null;
  manufacturer: string | null;
  manufacturerCode: string | null;
  barcode: string | null;
  unit: string | null;
  purchasePrice: number | null;
  description: string | null;
}

/** Propozycja wiersza źródła (sklep dostawcy) dla towaru. */
export interface ShopImportSuggestedSource {
  shop: string;
  shopLabel: string;
  productUrl: string | null;
  supplierCode: string | null;
  supplierProductId: string | null;
  lastPriceNet: number | null;
  lastPriceGross: number | null;
  vatRate: number | null;
  currency: string;
  lastStock: number | null;
  loggedIn: boolean;
  raw: ShopImportRaw;
}

/* ---------- wnętrze modułu: kontrakt między orkiestratorem a parserami ---------- */

import type { Doc } from "./dom-types.js";

export interface ParserContext {
  doc: Doc;
  /** Najlepiej znany adres produktu — baza do absolutyzacji linków i obrazków. */
  url: string | null;
  /** Domena bez `www.` (klucz sklepu). */
  shop: string;
}

/** Pola, które parser potrafi wypełnić (resztę dokłada orkiestrator). */
export type ParsedFields = Partial<
  Pick<
    ParsedProduct,
    | "url"
    | "name"
    | "supplierCode"
    | "supplierProductId"
    | "manufacturer"
    | "manufacturerCode"
    | "ean"
    | "priceNet"
    | "priceGross"
    | "priceKind"
    | "vatRate"
    | "currency"
    | "stock"
    | "stockText"
    | "unit"
    | "category"
    | "descriptionText"
    | "attributes"
    | "imageUrl"
  >
>;

export interface ParserOutput {
  fields: ParsedFields;
  warnings: string[];
}

export interface ShopParser {
  id: ParserId;
  /**
   * Selektory bloków z cudzymi produktami („produkty podobne”, „zamienniki”).
   * Orkiestrator usuwa je PRZED uruchomieniem generyka — inaczej nawet parser
   * ogólny wziąłby cenę i kod z sąsiedniego towaru.
   */
  noise?: string[];
  /** Bump po każdej zmianie selektorów — widać wtedy, które zapisy są ze starego. */
  version: string;
  parse(ctx: ParserContext): ParserOutput;
}
