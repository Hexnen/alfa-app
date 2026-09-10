/**
 * Rdzeń importu towaru z zapisanej strony sklepu — WSPÓLNY dla wszystkich wejść.
 *
 * DLACZEGO OSOBNY PLIK. Ten sam ciąg kroków (parsowanie → propozycja kartoteki
 * → propozycja źródła → dopasowanie do istniejących towarów → zdjęcie) obsługuje
 * dziś trzy różne wejścia:
 *   1. multipart z formularza („Ctrl+S" w przeglądarce, plik .html),
 *   2. JSON `{html, url}` z tej samej trasy,
 *   3. wtyczka przeglądarki (`POST /api/plugin/import`, Bearer, bez sesji).
 * Gdyby rdzeń został w trasie `/warehouse/import/parse`, wtyczka miałaby własną
 * kopię dopasowywania i własne pojęcie „już to mamy" — a to jest dokładnie ta
 * logika, której NIE WOLNO zduplikować: rozjazd oznacza duplikaty w kartotece.
 *
 * Kontrakt odpowiedzi (`ShopImportParseResult`) jest 1:1 z tym, co trasa
 * zwracała wcześniej — front (frontend/src/lib/api.ts) kopiuje te kształty
 * ręcznie, więc zmiana pola to zmiana w trzech miejscach naraz.
 *
 * Serwis NICZEGO NIE ZAPISUJE. Zwraca propozycję, którą człowiek zatwierdza
 * w formularzu towaru; zapis idzie zwykłym POST/PUT `/warehouse/items`.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { normalizeName, nameTokens } from "./price-match.js";
import {
  parseProductBytes,
  parseProductHtml,
  buildSuggestedItem,
  buildSuggestedSource,
  type ParsedProduct,
  type ShopImportSuggestedItem,
  type ShopImportSuggestedSource,
} from "./shop-import/index.js";
import { fetchProductImage } from "./shop-import-image.js";

/** Powód dopasowania — kolejność w tablicy = malejąca pewność. */
export type MatchReason = "source" | "ean" | "manufacturerCode" | "sku" | "name";

export interface ShopImportMatch {
  id: number;
  name: string;
  sku: string | null;
  manufacturer: string | null;
  manufacturerCode: string | null;
  barcode: string | null;
  purchasePrice: number | null;
  salePrice: number | null;
  unit: string;
  isArchived: boolean;
  reason: MatchReason;
  confidence: "exact" | "likely";
}

/** Kształt odpowiedzi `POST /warehouse/import/parse` (i wsadu do kolejki wtyczki). */
export interface ShopImportParseResult {
  parsed: ParsedProduct;
  suggestedItem: ShopImportSuggestedItem;
  suggestedSource: ShopImportSuggestedSource;
  matches: ShopImportMatch[];
  photoData: string | null;
  photoWarning: string | null;
}

/** Wejście: gotowy HTML (plugin/JSON) albo bajty pliku (multipart, może być windows-1250). */
export type ShopImportInput =
  | { kind: "html"; html: string; url?: string }
  | { kind: "bytes"; bytes: Buffer; url?: string; fileName?: string };

/**
 * Wejście jest złe — winien jest ten, kto je przysłał, nie serwer. Każda trasa
 * mapuje ten wyjątek na 400 z `err.message` (komunikaty są dla człowieka).
 */
export class ShopImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopImportInputError";
  }
}

const MAX_MATCHES = 8;
/** 1 MB ZDEKODOWANYCH bajtów zdjęcia (front skaluje do ≤800 px). */
export const MAX_PHOTO_DATA = 1024 * 1024;

export const SHOP_IMPORT_NO_FILE = "Brak pliku. Prześlij zapisaną stronę produktu (.html).";
export const SHOP_IMPORT_BAD_FILE =
  "Nieobsługiwany format pliku. Prześlij zapisaną stronę produktu (.html).";
export const SHOP_IMPORT_NO_HTML = "Brak treści strony (pole „html”).";

/**
 * Adres produktu sprowadzony do postaci porównywalnej: bez schematu, bez „www.”,
 * bez kotwicy i końcowego ukośnika. Ten sam produkt zapisany raz z http, raz
 * z https i raz z `#opis` to jedno źródło, nie trzy.
 */
export function normalizeProductUrl(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split("#")[0].replace(/\/+$/, "");
  return s || null;
}

const lowerOrNull = (s: string | null | undefined): string | null =>
  typeof s === "string" && s.trim() ? s.trim().toLowerCase() : null;

/**
 * „Czy ten towar już mamy?” — pytanie, które trzeba zadać PRZED zapisem, bo
 * kartoteka bez tego zbiera duplikaty tej samej kamery pod trzema nazwami.
 *
 * Kolejność powodów to kolejność pewności: kod u dostawcy/adres strony (to
 * DOKŁADNIE ten produkt) → EAN → symbol producenta → nasze SKU → nazwa.
 * Zarchiwizowane też pokazujemy z flagą `isArchived` — inaczej użytkownik
 * zakłada nowy wiersz obok archiwalnego i psuje historię ruchów.
 */
export async function findItemMatches(
  parsed: ParsedProduct,
  suggested: {
    sku: string | null;
    barcode: string | null;
    manufacturerCode: string | null;
    name: string | null;
  }
): Promise<ShopImportMatch[]> {
  const items = await db
    .select({
      id: schema.warehouseItems.id,
      name: schema.warehouseItems.name,
      sku: schema.warehouseItems.sku,
      manufacturer: schema.warehouseItems.manufacturer,
      manufacturerCode: schema.warehouseItems.manufacturerCode,
      barcode: schema.warehouseItems.barcode,
      purchasePrice: schema.warehouseItems.purchasePrice,
      salePrice: schema.warehouseItems.salePrice,
      unit: schema.warehouseItems.unit,
      isArchived: schema.warehouseItems.isArchived,
    })
    .from(schema.warehouseItems);
  const byId = new Map(items.map((i) => [i.id, i]));

  const out: ShopImportMatch[] = [];
  const used = new Set<number>();
  const push = (id: number, reason: MatchReason, confidence: "exact" | "likely") => {
    if (used.has(id) || out.length >= MAX_MATCHES) return;
    const item = byId.get(id);
    if (!item) return;
    used.add(id);
    out.push({ ...item, reason, confidence });
  };

  // 1. Źródło: ten sam sklep + ten sam kod u dostawcy albo ten sam adres strony.
  if (parsed.shop) {
    const rows = await db
      .select({
        itemId: schema.warehouseItemSources.itemId,
        supplierCode: schema.warehouseItemSources.supplierCode,
        productUrl: schema.warehouseItemSources.productUrl,
      })
      .from(schema.warehouseItemSources)
      .where(eq(schema.warehouseItemSources.shop, parsed.shop));
    const code = lowerOrNull(parsed.supplierCode);
    const url = normalizeProductUrl(parsed.url);
    for (const r of rows) {
      const hit =
        (code !== null && lowerOrNull(r.supplierCode) === code) ||
        (url !== null && normalizeProductUrl(r.productUrl) === url);
      if (hit) push(r.itemId, "source", "exact");
    }
  }

  // 2. EAN — kod kreskowy jest globalny, więc trafienie jest praktycznie pewne.
  const ean = lowerOrNull(suggested.barcode ?? parsed.ean);
  if (ean) {
    for (const i of items) if (lowerOrNull(i.barcode) === ean) push(i.id, "ean", "exact");
  }

  // 3. Symbol producenta — wspólny dla wszystkich sklepów.
  const mpn = lowerOrNull(suggested.manufacturerCode ?? parsed.manufacturerCode);
  if (mpn) {
    for (const i of items)
      if (lowerOrNull(i.manufacturerCode) === mpn) push(i.id, "manufacturerCode", "exact");
  }

  // 4. Nasze SKU. Parser świadomie NIE proponuje SKU (to nasz kod z etykiety,
  //    nie sklepowy), ale w praktyce część kartotek zakładano właśnie kodem
  //    dostawcy — więc szukamy po nim także w kolumnie `sku`.
  const sku = lowerOrNull(suggested.sku ?? parsed.supplierCode);
  if (sku) {
    for (const i of items) if (lowerOrNull(i.sku) === sku) push(i.id, "sku", "exact");
  }

  // 5. Nazwa: najpierw znormalizowana równość, potem zawieranie WSZYSTKICH tokenów
  //    zapytania (te same reguły co dopasowanie cennika — src/lib/price-match.ts).
  const rawName = suggested.name ?? parsed.name;
  if (rawName) {
    const target = normalizeName(rawName);
    if (target) {
      for (const i of items) if (normalizeName(i.name) === target) push(i.id, "name", "exact");
    }
    const tokens = nameTokens(rawName);
    // Krótka nazwa („IP”) pasowałaby do połowy katalogu — nie zgadujemy.
    if (target.length >= 4 && tokens.length >= 2) {
      const q = new Set(tokens);
      for (const i of items) {
        const t = new Set(nameTokens(i.name));
        let covered = true;
        for (const tok of q)
          if (!t.has(tok)) {
            covered = false;
            break;
          }
        if (covered) push(i.id, "name", "likely");
      }
    }
  }

  return out;
}

/**
 * Czy wolno wyjść do sklepu po zdjęcie produktu.
 *
 * `ALFA_SHOP_IMPORT_NO_FETCH=1` wyłącza to globalnie — testy chodzą na fiksturze
 * z prawdziwym adresem `og:image`, a bez tej furtki każdy przebieg strzelałby
 * do internetu (wolno, niestabilnie, a przy braku sieci daje ostrzeżenie
 * w danych i psuje asercje na `photoWarning`).
 */
function shouldFetchImage(opt: boolean | undefined): boolean {
  if (process.env.ALFA_SHOP_IMPORT_NO_FETCH === "1") return false;
  return opt !== false;
}

/**
 * Parsowanie wejścia → gotowa propozycja importu.
 *
 * `fetchImage: false` (albo `ALFA_SHOP_IMPORT_NO_FETCH=1`) pomija JEDYNE
 * żądanie wychodzące w całym torze — reszta liczy się lokalnie.
 */
export async function parseShopPageInput(
  input: ShopImportInput,
  opts?: { fetchImage?: boolean }
): Promise<ShopImportParseResult> {
  let parsed: ParsedProduct;
  try {
    if (input.kind === "bytes") {
      if (input.bytes.length === 0) throw new ShopImportInputError(SHOP_IMPORT_NO_FILE);
      parsed = parseProductBytes(input.bytes, { url: input.url, fileName: input.fileName });
    } else {
      if (!input.html || !input.html.trim()) throw new ShopImportInputError(SHOP_IMPORT_NO_HTML);
      parsed = parseProductHtml(input.html, { url: input.url });
    }
  } catch (err) {
    if (err instanceof ShopImportInputError) throw err;
    // Parser rzuca komunikatami dla człowieka (za duży HTML, nie-HTML) —
    // to 400, nie 500: winne jest wejście, nie serwer.
    throw new ShopImportInputError(
      err instanceof Error && err.message ? err.message : "Nie udało się odczytać strony produktu."
    );
  }

  const suggestedItem = buildSuggestedItem(parsed);
  const suggestedSource = buildSuggestedSource(parsed);
  const matches = await findItemMatches(parsed, {
    sku: suggestedItem.sku,
    barcode: suggestedItem.barcode,
    manufacturerCode: suggestedItem.manufacturerCode,
    name: suggestedItem.name,
  });

  // Zdjęcie: osobne żądanie HTTP do sklepu, więc wolno je pominąć.
  let photoData: string | null = null;
  let photoWarning: string | null = null;
  if (shouldFetchImage(opts?.fetchImage)) {
    if (!parsed.imageUrl) {
      photoWarning = "Strona nie zawiera adresu zdjęcia produktu";
    } else {
      const img = await fetchProductImage(parsed.imageUrl, MAX_PHOTO_DATA);
      photoData = img.photoData;
      photoWarning = img.warning;
    }
  }

  return { parsed, suggestedItem, suggestedSource, matches, photoData, photoWarning };
}
