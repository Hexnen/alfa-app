/**
 * Import towaru z zapisanej strony sklepu dostawcy — wejście do biblioteki.
 *
 * Publiczne API (to samo woła trasa `POST /warehouse/import/parse` i — docelowo —
 * plugin przeglądarki):
 *   decodeHtml → detectShop → parseProductHtml/parseProductBytes →
 *   buildSuggestedItem + buildSuggestedSource.
 *
 * Zasada organizująca całość: parser ogólny (JSON-LD/og/microdata) leci ZAWSZE,
 * a parser sklepowy tylko go nadpisuje pole po polu. Dzięki temu nieznany sklep
 * albo stub bez kalibracji nadal daje nazwę, opis i zdjęcie, a diagnostyka
 * uczciwie mówi, czego nie rozpoznano — bo tę stronę i tak zatwierdza człowiek.
 */
import type {
  ParsedFields,
  ParsedProduct,
  ParserContext,
  ParserOutput,
  PriceKind,
  ShopDetectedBy,
  ShopImportRaw,
  ShopImportSuggestedItem,
  ShopImportSuggestedSource,
} from "./types.js";
import type { Doc } from "./dom-types.js";
import { hostOf, load, normalizeUrl, stripNoise } from "./dom.js";
import { detectLogin } from "./login.js";
import { netFromGross } from "./price.js";
import { parseGeneric } from "./parsers/generic.js";
import { isKnownShop, parserFor, shopLabelFor } from "./parsers/registry.js";

export type {
  ParsedProduct,
  ParseDiagnostics,
  ParsedAttribute,
  ShopKey,
  ParserId,
  ShopImportSuggestedItem,
  ShopImportSuggestedSource,
} from "./types.js";
/** Typy pomocnicze — poza zamrożonym kontraktem, ale przydatne w trasach i UI. */
export type { PriceKind, ShopDetectedBy, ShopImportRaw } from "./types.js";
export { knownShops } from "./parsers/registry.js";

/**
 * Limit wielkości strony. 12 MB to z jednej strony dużo (próbka Janexa ma 1 MB),
 * z drugiej — „Strona sieci Web, kompletna” z galerią potrafi puchnąć. Ten sam
 * limit stoi na trasie (BODY_LIMIT_SHOP_IMPORT w src/routes/index.ts).
 */
export const MAX_HTML_BYTES = 12 * 1024 * 1024;
/** Opis dłuższy niż tyle znaków to już nie opis towaru, tylko cała strona. */
const MAX_DESCRIPTION = 8000;
/** Atrybutów ponad tę liczbę nikt nie przeczyta (i to sygnał złego zakresu). */
const MAX_ATTRIBUTES = 80;
/** Ile opisu wchodzi do snapshotu `raw_json` (reszta i tak jest w kartotece). */
const MAX_RAW_DESCRIPTION = 2000;

/* --------------------------------- dekodowanie --------------------------------- */

/**
 * Bajty pliku → HTML. Sklepy nadal potrafią odesłać windows-1250 (a „Zapisz
 * stronę” zachowuje oryginalne kodowanie), więc bez sniffowania dostalibyśmy
 * „Rozdzielczo��”. Kolejność: BOM → deklaracja `charset` w nagłówku →
 * UTF-8. Nagłówek czytamy jako latin1, bo tam liczą się tylko znaki ASCII.
 */
export function decodeHtml(bytes: Buffer): { html: string; charset: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { html: bytes.subarray(3).toString("utf8"), charset: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { html: decodeWith(bytes.subarray(2), "utf-16le"), charset: "utf-16le" };
  }
  const head = bytes.subarray(0, 8192).toString("latin1");
  const declared = /charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i.exec(head)?.[1];
  const charset = normalizeCharset(declared);
  try {
    return { html: decodeWith(bytes, charset), charset };
  } catch {
    // Nieznana nazwa kodowania (albo ICU bez tej strony kodowej) — lepiej dać
    // UTF-8 z krzaczkami niż wywalić cały import.
    return { html: bytes.toString("utf8"), charset: "utf-8" };
  }
}

function decodeWith(bytes: Buffer, charset: string): string {
  return new TextDecoder(charset, { fatal: false }).decode(bytes);
}

function normalizeCharset(raw: string | undefined): string {
  const t = (raw ?? "utf-8").trim().toLowerCase();
  if (!t || t === "utf8" || t === "utf-8") return "utf-8";
  if (t === "cp1250" || t === "win-1250" || t === "windows1250") return "windows-1250";
  if (t === "cp1252" || t === "windows1252") return "windows-1252";
  if (t === "iso8859-2" || t === "iso-8859-2" || t === "latin2") return "iso-8859-2";
  return t;
}

/* ------------------------------- rozpoznanie sklepu ------------------------------ */

/**
 * Skąd bierzemy adres produktu (a z niego domenę sklepu) — od najpewniejszego:
 *  1. `urlHint` — plugin przeglądarki zna adres wprost,
 *  2. komentarz „saved from url=(NNNN)…”, który wstawia Chrome przy zapisie,
 *  3. `link[rel=canonical]`,
 *  4. `og:url` (w SAMAL-u z podwójnym slashem — naprawia to normalizeUrl),
 *  5. breadcrumb w JSON-LD (ostatni okruszek = adres produktu),
 *  6. ukryty `input[name=product_url]` (Janex — nie ma canonical ani og:),
 *  7. najczęstszy host w linkach strony (ostatnia deska ratunku: znamy sklep,
 *     ale nie adres produktu).
 */
export function detectShop(
  html: string,
  urlHint?: string
): { shop: string; shopLabel: string; url: string | null; detectedBy: ShopDetectedBy } {
  return detectShopFromDoc(load(html), urlHint);
}

function detectShopFromDoc(
  doc: Doc,
  urlHint?: string
): { shop: string; shopLabel: string; url: string | null; detectedBy: ShopDetectedBy } {
  const { $ } = doc;
  const candidates: [ShopDetectedBy, string | null][] = [
    ["urlHint", urlHint ?? null],
    ["savedFrom", /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(doc.html)?.[1] ?? null],
    ["canonical", $("link[rel=canonical]").attr("href") ?? null],
    [
      "ogUrl",
      $('meta[property="og:url"]').attr("content") ?? $('meta[name="og:url"]').attr("content") ?? null,
    ],
    ["jsonLd", breadcrumbUrl(doc)],
    ["hiddenInput", $("input[name=product_url]").first().attr("value") ?? null],
  ];

  for (const [detectedBy, raw] of candidates) {
    const url = normalizeUrl(raw);
    const shop = hostOf(url);
    if (url && shop) return { shop, shopLabel: shopLabelFor(shop), url, detectedBy };
  }

  const shop = dominantHost(doc);
  if (shop) return { shop, shopLabel: shopLabelFor(shop), url: null, detectedBy: "linkHost" };
  return { shop: "", shopLabel: shopLabelFor(""), url: null, detectedBy: "none" };
}

/** Ostatni okruszek BreadcrumbList to adres produktu (SAMAL: `//host/…`). */
function breadcrumbUrl(doc: Doc): string | null {
  let found: string | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (typeof type === "string" && /breadcrumblist/i.test(type)) {
      const list = obj["itemListElement"];
      if (Array.isArray(list) && list.length) {
        const last = list[list.length - 1] as Record<string, unknown> | undefined;
        const item = last?.["item"];
        const id =
          typeof item === "string"
            ? item
            : ((item as Record<string, unknown> | undefined)?.["@id"] as string | undefined);
        if (typeof id === "string") found = id;
      }
      return;
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  for (const block of doc.jsonLd) visit(block, 0);
  return found;
}

/** Hosty, które są na każdej stronie i o sklepie nic nie mówią. */
const FOREIGN_HOSTS =
  /(google|gstatic|googleapis|facebook|fbcdn|youtube|twitter|cloudflare|jsdelivr|bootstrapcdn|fontawesome|schema\.org|w3\.org|gemius|hotjar|smartsupp|comarch)/i;

function dominantHost(doc: Doc): string | null {
  const counts = new Map<string, number>();
  doc
    .$('link[href^="http"], form[action^="http"], a[href^="http"]')
    .each((_i, el) => {
      const $el = doc.$(el);
      const host = hostOf(normalizeUrl($el.attr("href") ?? $el.attr("action") ?? null));
      if (!host || FOREIGN_HOSTS.test(host)) return;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    });
  let best: string | null = null;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

/* ---------------------------------- parsowanie ---------------------------------- */

export function parseProductHtml(
  html: string,
  opts?: { url?: string; charset?: string }
): ParsedProduct {
  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > MAX_HTML_BYTES) {
    throw new Error(
      `Zapisana strona jest za duża (${Math.round(htmlBytes / 1024 / 1024)} MB, limit ${MAX_HTML_BYTES / 1024 / 1024} MB)`
    );
  }

  const doc = load(html);
  const detected = detectShopFromDoc(doc, opts?.url);
  const parser = parserFor(detected.shop);
  // Bloki „produkty podobne”/„zamienniki” WYCINAMY przed parsowaniem — inaczej
  // nawet generyk weźmie cenę i kod z sąsiedniego towaru.
  stripNoise(doc, parser.noise ?? []);

  const ctx: ParserContext = { doc, url: detected.url, shop: detected.shop };
  const generic = parseGeneric(ctx);
  const shopOut: ParserOutput =
    parser.id === "generic" ? { fields: {}, warnings: [] } : parser.parse(ctx);
  const fields = mergeFields(generic.fields, shopOut.fields);

  const warnings = [...shopOut.warnings, ...generic.warnings];

  // Opis i atrybuty przycinamy TU, a nie w parserach — limit jest wspólny.
  let descriptionText = fields.descriptionText ?? null;
  if (descriptionText && descriptionText.length > MAX_DESCRIPTION) {
    descriptionText = `${descriptionText.slice(0, MAX_DESCRIPTION)}…`;
    warnings.push(`Opis był dłuższy niż ${MAX_DESCRIPTION} znaków — obcięto`);
  }
  let attributes = fields.attributes ?? [];
  if (attributes.length > MAX_ATTRIBUTES) {
    attributes = attributes.slice(0, MAX_ATTRIBUTES);
    warnings.push(`Znaleziono więcej niż ${MAX_ATTRIBUTES} cech — pokazujemy pierwsze`);
  }

  const priceNet = fields.priceNet ?? null;
  const priceGross = fields.priceGross ?? null;
  const login = detectLogin(doc, { hasPrice: priceNet !== null || priceGross !== null });

  if (!login.loggedIn) {
    warnings.push(
      "Strona zapisana bez logowania – ceny mogą być detaliczne albo niewidoczne"
    );
  }
  if (priceNet === null && priceGross === null) {
    warnings.push("Nie znaleziono ceny na stronie");
  } else if ((fields.priceKind ?? "unknown") === "unknown") {
    warnings.push(
      "Cena bez etykiety netto/brutto — zapisano ją jako brutto, wskaż w panelu, czym jest"
    );
  }
  if (!detected.shop) {
    warnings.push(
      "Nie rozpoznano sklepu (strona nie zawiera swojego adresu) — podaj adres produktu ręcznie"
    );
  } else if (!isKnownShop(detected.shop)) {
    warnings.push(
      `Brak dedykowanego parsera dla ${detected.shop} — użyto parsera ogólnego, dane mogą być niepełne`
    );
  }
  if (!fields.name) {
    warnings.push("Nie rozpoznano nazwy produktu — czy to na pewno strona produktu?");
  }

  const parsed: ParsedProduct = {
    shop: detected.shop,
    shopLabel: detected.shopLabel,
    url: fields.url ?? detected.url,
    name: fields.name ?? null,
    supplierCode: fields.supplierCode ?? null,
    supplierProductId: fields.supplierProductId ?? null,
    manufacturer: fields.manufacturer ?? null,
    manufacturerCode: fields.manufacturerCode ?? null,
    ean: fields.ean ?? null,
    priceNet,
    priceGross,
    priceKind: fields.priceKind ?? "unknown",
    vatRate: fields.vatRate ?? null,
    currency: fields.currency ?? "PLN",
    stock: fields.stock ?? null,
    stockText: fields.stockText ?? null,
    unit: fields.unit ?? null,
    category: fields.category ?? null,
    descriptionText,
    attributes,
    imageUrl: fields.imageUrl ?? null,
    loggedIn: login.loggedIn,
    loginSignals: login.signals,
    accountLabel: login.accountLabel,
    diagnostics: {
      recognized: [],
      missing: [],
      warnings,
      shopDetectedBy: detected.detectedBy,
      parserUsed: parser.id,
      parserVersion: parser.version,
      htmlBytes,
      charset: opts?.charset ?? "utf-8",
    },
  };

  const { recognized, missing } = auditFields(parsed);
  parsed.diagnostics.recognized = recognized;
  parsed.diagnostics.missing = missing;
  return parsed;
}

export function parseProductBytes(
  bytes: Buffer,
  opts?: { url?: string; fileName?: string }
): ParsedProduct {
  const { html, charset } = decodeHtml(bytes);
  const parsed = parseProductHtml(html, { url: opts?.url, charset });
  // Rozmiar liczymy z pliku, nie z odkodowanego stringa — przy windows-1250
  // to dwie różne liczby, a w diagnostyce chcemy tę, którą widział użytkownik.
  parsed.diagnostics.htmlBytes = bytes.length;
  return parsed;
}

/**
 * Scalanie: parser sklepowy wygrywa pole po polu. Ceny są wyjątkiem —
 * bierzemy CAŁY blok cenowy z jednego źródła (netto, brutto, rodzaj, VAT,
 * waluta), bo mieszanie netto ze sklepu z brutto z JSON-LD dałoby VAT z sufitu.
 */
function mergeFields(generic: ParsedFields, shop: ParsedFields): ParsedFields {
  const shopHasPrice = shop.priceNet != null || shop.priceGross != null;
  const price = shopHasPrice ? shop : generic;
  return {
    url: shop.url ?? generic.url ?? null,
    name: shop.name ?? generic.name ?? null,
    supplierCode: shop.supplierCode ?? generic.supplierCode ?? null,
    supplierProductId: shop.supplierProductId ?? generic.supplierProductId ?? null,
    manufacturer: shop.manufacturer ?? generic.manufacturer ?? null,
    manufacturerCode: shop.manufacturerCode ?? generic.manufacturerCode ?? null,
    ean: shop.ean ?? generic.ean ?? null,
    priceNet: price.priceNet ?? null,
    priceGross: price.priceGross ?? null,
    priceKind: (price.priceKind ?? "unknown") as PriceKind,
    vatRate: price.vatRate ?? shop.vatRate ?? generic.vatRate ?? null,
    currency: price.currency ?? shop.currency ?? generic.currency ?? "PLN",
    stock: shop.stock ?? generic.stock ?? null,
    stockText: shop.stockText ?? generic.stockText ?? null,
    unit: shop.unit ?? generic.unit ?? null,
    category: shop.category ?? generic.category ?? null,
    descriptionText: shop.descriptionText ?? generic.descriptionText ?? null,
    attributes: shop.attributes?.length ? shop.attributes : generic.attributes ?? [],
    imageUrl: shop.imageUrl ?? generic.imageUrl ?? null,
  };
}

/**
 * Rachunek sumienia parsera: co się udało, czego nie. To jest lista do
 * kalibracji nowego sklepu (i treść przycisku „Kopiuj raport” w panelu), dlatego
 * nazwy są techniczne — mają jednoznacznie wskazywać pole.
 */
const AUDITED: (keyof ParsedProduct)[] = [
  "url",
  "name",
  "supplierCode",
  "supplierProductId",
  "manufacturer",
  "manufacturerCode",
  "ean",
  "priceNet",
  "priceGross",
  "vatRate",
  "stock",
  "unit",
  "category",
  "descriptionText",
  "attributes",
  "imageUrl",
];

function auditFields(parsed: ParsedProduct): { recognized: string[]; missing: string[] } {
  const recognized: string[] = [];
  const missing: string[] = [];
  for (const key of AUDITED) {
    const v = parsed[key];
    const has = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
    (has ? recognized : missing).push(key);
  }
  return { recognized, missing };
}

/* ------------------------------- propozycje do UI ------------------------------- */

/**
 * Atrybuty, które są informacją handlową, nie cechą towaru — do opisu ich nie
 * dopisujemy (VAT i EAN mają w kartotece swoje pola, a cena katalogowa i rabat
 * zmieniają się z dnia na dzień). W `attributes` zostają, żeby człowiek widział,
 * co sklep pokazywał w momencie zapisu.
 */
const NON_DESCRIPTIVE_ATTR = /^(podatek vat|vat|kod ean|ean|cena katalogowa|twój rabat|twoj rabat|cena netto|cena brutto)/i;

export function buildSuggestedItem(parsed: ParsedProduct): ShopImportSuggestedItem {
  const lines = parsed.attributes
    .filter((a) => !NON_DESCRIPTIVE_ATTR.test(a.name))
    .map((a) => `${a.name}: ${a.value}`);
  const description = [parsed.descriptionText ?? "", lines.length ? lines.join("\n") : ""]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return {
    name: parsed.name,
    // Nasz indeks nadaje człowiek — sklep zna tylko swój kod dostawcy.
    sku: null,
    category: parsed.category,
    manufacturer: parsed.manufacturer,
    manufacturerCode: parsed.manufacturerCode,
    barcode: parsed.ean,
    unit: parsed.unit,
    purchasePrice: purchasePriceFrom(parsed),
    description: description || null,
  };
}

/**
 * Cena zakupu to zawsze NETTO. Gdy sklep dał tylko brutto i znamy VAT — liczymy.
 * Gdy nie wiemy, czym jest znaleziona cena (`priceKind: "unknown"`), nie
 * podpowiadamy NICZEGO: zła cena zakupu psuje marżę w całym systemie, a w panelu
 * człowiek i tak wskazuje netto/brutto ręcznie.
 */
function purchasePriceFrom(parsed: ParsedProduct): number | null {
  if (parsed.priceKind === "unknown") return null;
  if (parsed.priceNet !== null) return parsed.priceNet;
  if (parsed.priceGross !== null && parsed.vatRate !== null) {
    return netFromGross(parsed.priceGross, parsed.vatRate);
  }
  return null;
}

export function buildSuggestedSource(parsed: ParsedProduct): ShopImportSuggestedSource {
  // `accountLabel` (e-mail konta) NIE trafia do bazy — to dana osobowa, która
  // do odświeżania ceny nie jest potrzebna. Opis skracamy, bo `raw_json` ma być
  // snapshotem do diagnostyki, a nie drugą kopią kartoteki.
  const { accountLabel: _accountLabel, ...rest } = parsed;
  const raw: ShopImportRaw = {
    ...rest,
    descriptionText:
      rest.descriptionText && rest.descriptionText.length > MAX_RAW_DESCRIPTION
        ? rest.descriptionText.slice(0, MAX_RAW_DESCRIPTION)
        : rest.descriptionText,
  };

  return {
    shop: parsed.shop,
    shopLabel: parsed.shopLabel,
    productUrl: parsed.url,
    supplierCode: parsed.supplierCode,
    supplierProductId: parsed.supplierProductId,
    lastPriceNet: parsed.priceNet,
    lastPriceGross: parsed.priceGross,
    vatRate: parsed.vatRate,
    currency: parsed.currency,
    lastStock: parsed.stock,
    loggedIn: parsed.loggedIn,
    raw,
  };
}
