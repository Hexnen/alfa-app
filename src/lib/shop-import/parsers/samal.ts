/**
 * samal.pl (silnik LiquidShop, klasy `-ui`/`-lq`) — zweryfikowany na próbce
 * scripts/fixtures/shop-import/samal-tc-c320n.html.
 *
 * Główna pułapka tej strony: kontener `[data-product-id]` obejmuje TAKŻE blok
 * „Produkty producenta” (`.related-ui`) z cudzymi kodami i cenami. Dlatego
 * `noise` (usuwane przed jakimkolwiek parsowaniem) jest tu częścią kontraktu,
 * a nie kosmetyką — bez niego `.product-code-ui` zwraca 51 elementów, z czego
 * 50 należy do innych towarów.
 */
import type { ParsedAttribute, ParserContext, ParserOutput, ShopParser } from "../types.js";
import { collapse, labelValue, normalizeUrl, text } from "../dom.js";
import { htmlToText } from "../html-text.js";
import { normalizeUnit, parsePercentText, parsePriceText, parseStockText, resolveVat } from "../price.js";
import { validEan } from "./generic.js";

/** Bloki z cudzymi produktami — muszą zniknąć przed parsowaniem. */
const NOISE = [
  ".related-ui",
  ".suggested-products-ui",
  ".minibox-product-ui",
  ".last-seen-products-ui",
];

/** Atrybuty, które w SAMAL-u są danymi handlowymi, a nie cechą towaru. */
const EAN_ATTR = /^kod ean$/i;
const VAT_ATTR = /^podatek vat$/i;

export const samalParser: ShopParser = {
  id: "samal",
  version: "1",
  noise: NOISE,
  parse: parseSamal,
};

function parseSamal(ctx: ParserContext): ParserOutput {
  const { doc, url } = ctx;
  const { $ } = doc;
  const warnings: string[] = [];
  // Po usunięciu `.related-ui` cała karta produktu to jeden kontener z id towaru.
  const scope = $("[data-product-id]").first();
  const inScope = scope.length ? scope : $("body");

  const name = text(inScope.find("h1.page-title-ui").first()) || text($("h1").first()) || null;

  const supplierCode =
    text(inScope.find(".product-code-ui .blk").first()) ||
    labelValue(doc, /Kod produktu/i, inScope) ||
    null;
  const supplierProductId = scope.attr("data-product-id") ?? null;

  // Atrybuty: pary `.name-ui` / `.value-ui`. Z nich lecą też EAN i VAT.
  const attributes: ParsedAttribute[] = [];
  let eanFromAttrs: string | null = null;
  let vatFromAttrs: number | null = null;
  inScope.find(".product-attributes-ui li").each((_i, el) => {
    const $el = $(el);
    const attrName = collapse($el.find(".name-ui").text()).replace(/\s*:\s*$/, "");
    const attrValue = collapse($el.find(".value-ui").text());
    if (!attrName || !attrValue) return;
    if (EAN_ATTR.test(attrName)) eanFromAttrs = validEan(attrValue);
    if (VAT_ATTR.test(attrName)) vatFromAttrs = parsePercentText(attrValue);
    attributes.push({ name: attrName, value: attrValue });
  });

  // Ceny: pierwszy blok „dodaj do koszyka” to blok naszego towaru.
  const priceBox = inScope.find(".add-to-cart-border-container-ui").first();
  const priceScope = priceBox.length ? priceBox : inScope;
  const net = parsePriceText(text(priceScope.find(".netto-price-ui").first()));
  const gross = parsePriceText(text(priceScope.find(".brutto-price-ui").first()));
  const vat = resolveVat(net?.value ?? null, gross?.value ?? null, vatFromAttrs);
  warnings.push(...vat.warnings);

  // Stan: „W magazynie: 17 szt.”; awaryjnie limit ilości w formularzu koszyka.
  const stockRaw = text(inScope.find(".stock-ui").first());
  const stock = parseStockText(stockRaw || null);
  let stockValue = stock.stock;
  if (stockValue === null) {
    const dataMax = priceScope.find("input[name=quantity]").first().attr("data-max");
    const n = dataMax ? Number(dataMax) : NaN;
    if (Number.isFinite(n)) stockValue = Math.round(n);
  }

  const manufacturer =
    inScope.find('a[href*="producent="] img[alt]').first().attr("alt")?.trim() ||
    text(inScope.find('a[href*="producent="]').first()) ||
    null;

  const description = descriptionText(ctx);

  return {
    fields: {
      // canonical, bo og:url w SAMAL-u ma podwójny slash po hoście.
      url: normalizeUrl($('link[rel=canonical]').attr("href") ?? null) ?? url,
      name,
      supplierCode,
      supplierProductId,
      manufacturer,
      manufacturerCode: manufacturerCodeFromName(name),
      ean: eanFromAttrs,
      priceNet: net?.value ?? null,
      priceGross: gross?.value ?? null,
      priceKind: net && gross ? "both" : net ? "net" : gross ? "gross" : "unknown",
      vatRate: vat.vatRate,
      currency: net?.currency ?? gross?.currency ?? "PLN",
      stock: stockValue,
      stockText: stock.text,
      unit: stock.unit ?? normalizeUnit("szt"),
      ...(description ? { descriptionText: description } : {}),
      ...(attributes.length ? { attributes } : {}),
      // JSON-LD `image` w SAMAL-u jest sklejony z adresem strony (nie istnieje),
      // więc bierzemy WYŁĄCZNIE og:image.
      imageUrl: normalizeUrl($('meta[property="og:image"]').attr("content") ?? null),
    },
    warnings,
  };
}

/** Opis bez nagłówka „Opis produktu” (to etykieta zakładki, nie treść). */
function descriptionText(ctx: ParserContext): string | null {
  const { doc } = ctx;
  const box = doc.$(".product-description-ui").first();
  if (!box.length) return null;
  const clone = box.clone();
  clone.children("h2, h3").each((_i, el) => {
    const $el = doc.$(el);
    if (/^opis produktu$/i.test(collapse($el.text()))) $el.remove();
  });
  return htmlToText(doc, clone) || null;
}

/**
 * Symbol producenta z nazwy. SAMAL nazywa towary „SYMBOL Spec:… Producent opis”,
 * więc pierwszy człon to realny symbol katalogowy („TC-C320N”) — a to jest
 * jedyny kod wspólny z innymi sklepami, czyli klucz dopasowania towaru.
 * Wymagamy litery ORAZ cyfry, żeby nie wziąć zwykłego słowa za symbol.
 */
export function manufacturerCodeFromName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0] ?? "";
  if (first.length < 4 || first.length > 30) return null;
  if (!/[A-Za-z]/.test(first) || !/\d/.test(first)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9./+-]*$/.test(first)) return null;
  return first;
}
