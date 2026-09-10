/**
 * Parser ogólny — to, co da się wyciągnąć z KAŻDEJ strony produktu bez wiedzy
 * o sklepie: JSON-LD (schema.org i gs1), Open Graph, microdata, `h1`, `<title>`.
 *
 * Uruchamiamy go ZAWSZE, a parser sklepowy tylko go nadpisuje pole po polu.
 * Dzięki temu nowy sklep (albo stub bez kalibracji) od pierwszego dnia daje
 * nazwę, opis i zdjęcie, a nie pustą kartę. Ceny są tu z założenia niepewne:
 * jedna cena bez etykiety trafia do `priceGross` z `priceKind: "unknown"`,
 * bo w panelu i tak decyduje człowiek.
 */
import type { ParsedAttribute, ParserContext, ParserOutput, ShopParser } from "../types.js";
import { absUrl, collapse, imageCandidates, tablePairs, text } from "../dom.js";
import type { Doc, Sel } from "../dom-types.js";
import { htmlToText } from "../html-text.js";
import { normalizeUnit, parsePercentText, parsePriceText } from "../price.js";

export const GENERIC_VERSION = "1";

export const genericParser: ShopParser = {
  id: "generic",
  version: GENERIC_VERSION,
  parse: parseGeneric,
};

export function parseGeneric(ctx: ParserContext): ParserOutput {
  const { doc, url } = ctx;
  const { $ } = doc;
  const warnings: string[] = [];
  const ld = productNodes(doc);

  const name =
    ldText(ld, ["name", "productName", "title"]) ??
    metaContent(doc, "og:title") ??
    firstText(doc, "h1, [itemprop=name]") ??
    titleName(doc);

  const supplierCode = ldText(ld, ["sku", "productID", "identifier"]) ?? attrValue(doc, "sku");
  const manufacturerCode = ldText(ld, ["mpn", "manufacturerCode"]) ?? attrValue(doc, "mpn");
  const ean = validEan(
    ldText(ld, ["gtin13", "gtin", "gtin14", "gtin12", "gtin8", "ean"]) ??
      attrValue(doc, "gtin13") ??
      attrValue(doc, "gtin")
  );
  const manufacturer =
    ldText(ld, ["brand", "manufacturer"]) ??
    metaContent(doc, "product:brand") ??
    attrValue(doc, "brand");
  const category = ldText(ld, ["category"]) ?? breadcrumbCategory(doc, name);

  const description =
    htmlToText(doc, firstNonEmpty(doc, ["[itemprop=description]", "#description", "[class*=description]"])) ||
    ldText(ld, ["description", "productDescription"]) ||
    metaContent(doc, "og:description") ||
    $('meta[name="description"]').attr("content")?.trim() ||
    null;

  // Cena: JSON-LD → Open Graph → microdata. Zawsze bez etykiety netto/brutto.
  const priceRaw =
    ldText(ld, ["price"]) ??
    metaContent(doc, "product:price:amount") ??
    metaContent(doc, "og:price:amount") ??
    attrValue(doc, "price") ??
    firstText(doc, "[itemprop=price]");
  const parsedPrice = parsePriceText(priceRaw);
  const currency =
    ldText(ld, ["priceCurrency"]) ??
    metaContent(doc, "product:price:currency") ??
    metaContent(doc, "og:price:currency") ??
    attrValue(doc, "priceCurrency") ??
    parsedPrice?.currency ??
    null;
  const vatRate = parsePercentText(ldText(ld, ["dutyFeeTaxRate"]));

  const availability = ldText(ld, ["availability"]) ?? attrValue(doc, "availability");
  const stockText = availabilityText(availability);

  const image = pickImage(doc, url, ld);

  const attributes = genericAttributes(doc);

  return {
    fields: {
      name: name ?? null,
      supplierCode: supplierCode ?? null,
      manufacturerCode: manufacturerCode ?? null,
      ean,
      manufacturer: manufacturer ?? null,
      category: category ?? null,
      descriptionText: description,
      priceNet: null,
      priceGross: parsedPrice ? parsedPrice.value : null,
      priceKind: "unknown",
      vatRate,
      ...(currency ? { currency } : {}),
      stock: null,
      stockText,
      unit: normalizeUnit(ldText(ld, ["unitCode"])),
      imageUrl: image,
      ...(attributes.length ? { attributes } : {}),
    },
    warnings,
  };
}

/* ---------------- JSON-LD ---------------- */

type Obj = Record<string, unknown>;

/** Wszystkie obiekty z JSON-LD, płasko (razem z `@graph` i zagnieżdżeniami). */
function flatten(node: unknown, out: Obj[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out, depth + 1);
    return;
  }
  const obj = node as Obj;
  out.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") flatten(v, out, depth + 1);
  }
}

/**
 * Obiekty opisujące produkt lub ofertę. Bierzemy i schema.org, i gs1 (SAMAL
 * publikuje oba), bo dopiero razem dają EAN, cenę i stan.
 */
function productNodes(doc: Doc): Obj[] {
  const all: Obj[] = [];
  for (const block of doc.jsonLd) flatten(block, all);
  return all.filter((o) => {
    const t = o["@type"];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => typeof x === "string" && /product|offer/i.test(x));
  });
}

/** Wartość pola z JSON-LD: pierwszy niepusty tekst, w kolejności podanych kluczy. */
function ldText(nodes: Obj[], keys: string[]): string | null {
  for (const key of keys) {
    for (const node of nodes) {
      if (!(key in node)) continue;
      const v = asText(node[key]);
      if (v) return v;
    }
  }
  return null;
}

/**
 * JSON-LD w tych sklepach ma trzy różne kształty wartości: goły string,
 * `{"@value": …}` (gs1) i `{"name": …}` (schema.org Organization), plus tablice.
 */
function asText(v: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = asText(x, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if (v && typeof v === "object") {
    const o = v as Obj;
    for (const key of ["@value", "name", "brandName", "value", "@id", "url"]) {
      if (key in o) {
        const t = asText(o[key], depth + 1);
        if (t) return t;
      }
    }
  }
  return null;
}

/* ---------------- HTML ---------------- */

function metaContent(doc: Doc, prop: string): string | null {
  const { $ } = doc;
  const v =
    $(`meta[property="${prop}"]`).attr("content") ?? $(`meta[name="${prop}"]`).attr("content");
  const t = v ? collapse(v) : "";
  return t || null;
}

function attrValue(doc: Doc, itemprop: string): string | null {
  const el = doc.$(`[itemprop=${itemprop}]`).first();
  if (!el.length) return null;
  const v = el.attr("content") ?? el.attr("value") ?? collapse(el.text());
  return v ? collapse(v) : null;
}

function firstText(doc: Doc, selector: string): string | null {
  const t = text(doc.$(selector).first());
  return t || null;
}

function firstNonEmpty(doc: Doc, selectors: string[]): Sel | null {
  for (const sel of selectors) {
    const el = doc.$(sel).first();
    if (el.length && collapse(el.text()).length > 40) return el;
  }
  return null;
}

/** `<title>` bez ogona z nazwą sklepu („… - Kamery - SAMAL”, „… | Janex”). */
function titleName(doc: Doc): string | null {
  const t = collapse(doc.$("title").first().text());
  if (!t) return null;
  const cut = t.split(/\s+[|–]\s+/)[0];
  return cut.trim() || null;
}

function breadcrumbCategory(doc: Doc, name: string | null): string | null {
  const { $ } = doc;
  const crumbs: string[] = [];
  $('ol.breadcrumb, ul.breadcrumb, [class*="breadcrumb"]')
    .first()
    .children("li, span, a")
    .each((_i, el) => {
      const t = collapse($(el).text());
      if (t) crumbs.push(t);
    });
  // Ostatni okruszek to zwykle sama nazwa produktu — kategoria jest przed nią.
  const cleaned = crumbs.filter((c) => !name || collapse(c) !== collapse(name));
  const last = cleaned[cleaned.length - 1];
  if (!last || last.length > 80) return null;
  if (cleaned.length < 2) return null;
  return last;
}

function availabilityText(availability: string | null): string | null {
  if (!availability) return null;
  if (/InStock|in_stock|available/i.test(availability)) return "Dostępny";
  if (/OutOfStock|SoldOut|unavailable/i.test(availability)) return "Niedostępny";
  if (/PreOrder|BackOrder/i.test(availability)) return "Na zamówienie";
  return null;
}

function pickImage(doc: Doc, base: string | null, ld: Obj[]): string | null {
  const fromMeta = imageCandidates(doc, base);
  if (fromMeta.length) return fromMeta[0];
  const ldImage = ldText(ld, ["image", "referencedFileURL", "contentUrl"]);
  return absUrl(base, ldImage);
}

/**
 * Atrybuty z tabel i list definicyjnych, ale tylko w kontenerach, które same
 * mówią, że są specyfikacją — inaczej wciągnęlibyśmy tabelę kosztów dostawy.
 */
function genericAttributes(doc: Doc): ParsedAttribute[] {
  const { $ } = doc;
  const seen = new Set<string>();
  const out: ParsedAttribute[] = [];
  $(
    '[class*="attr"], [class*="spec"], [class*="param"], [class*="cech"], [id*="attr"], [id*="spec"], [id*="param"], [id*="cech"]'
  ).each((_i, el) => {
    for (const pair of tablePairs(doc, $(el))) {
      const key = `${pair.name.toLowerCase()}=${pair.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
    }
  });
  return out;
}

/** EAN ma 8, 12, 13 albo 14 cyfr — cokolwiek innego to nie EAN. */
export function validEan(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14) {
    return digits;
  }
  return null;
}
