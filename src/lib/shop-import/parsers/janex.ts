/**
 * janexint.com.pl (własny silnik B2B na Bootstrapie) — zweryfikowany na próbce
 * scripts/fixtures/shop-import/janex-outlet-fas-asd-ar.html.
 *
 * Trzy rzeczy, które trzeba tu wiedzieć:
 *  1. Strona NIE ma canonical, og: ani JSON-LD. Jedyny pewny adres produktu
 *     siedzi w ukrytym `input[name=product_url]` formularza koszyka, a id
 *     produktu w `input[name=product]`.
 *  2. Zakładka „Zamienniki” (`.products-list` w `#replacements`) to pełna karta
 *     INNEGO produktu — z własnym kodem, ceną (40,00 PLN), stanem i „J.m.”.
 *     Bez usunięcia tego bloku parser zwraca dane zamiennika. Dlatego jest
 *     w `noise`.
 *  3. `.price` stoi PRZED swoją etykietą `.price-label` (netto/brutto), więc
 *     wartość bierzemy z `prev()`, nie z `next()`.
 */
import type { ParsedAttribute, ParserContext, ParserOutput, ShopParser } from "../types.js";
import { absUrl, collapse, findSmallest, labelValue, tablePairs, text } from "../dom.js";
import { htmlToText } from "../html-text.js";
import { normalizeUnit, parsePriceText, parseStockText, resolveVat } from "../price.js";
import { validEan } from "./generic.js";

/** Zakładka „Zamienniki” i listy produktów = cudze dane na naszej stronie. */
const NOISE = [".products-list", "#replacements", ".product-slider", ".products-slider"];

export const janexParser: ShopParser = {
  id: "janex",
  version: "1",
  noise: NOISE,
  parse: parseJanex,
};

function parseJanex(ctx: ParserContext): ParserOutput {
  const { doc } = ctx;
  const { $ } = doc;
  const warnings: string[] = [];
  // Pierwszy `.product-page` to nagłówek karty (kod, EAN, ceny, stan);
  // drugi to zakładki (opis, parametry) — po usunięciu „Zamienników” cały
  // dokument jest już nasz, ale ceny i stan czytamy tylko z nagłówka.
  const head = $(".product-page").first();
  const headScope = head.length ? head : $("body");

  const productUrl =
    absUrl(null, $("input[name=product_url]").first().attr("value") ?? null) ?? ctx.url;
  const supplierProductId = $("input[name=product]").first().attr("value")?.trim() || null;

  const name = text(headScope.find("h1").first()) || text($("h1").first()) || null;
  const supplierCode = labelValue(doc, /Kod/i, headScope);
  const ean = validEan(labelValue(doc, /EAN/i, headScope));

  // Ceny klienta: wartość jest w `.price` PRZED etykietą „Cena netto/brutto”.
  let net: number | null = null;
  let gross: number | null = null;
  let currency: string | null = null;
  headScope.find(".price-label").each((_i, el) => {
    const $el = $(el);
    const label = collapse($el.text());
    const parsed = parsePriceText(text($el.prevAll(".price").first()));
    if (!parsed) return;
    currency = currency ?? parsed.currency;
    if (/netto/i.test(label) && net === null) net = parsed.value;
    else if (/brutto/i.test(label) && gross === null) gross = parsed.value;
  });

  const attributes: ParsedAttribute[] = [];
  // Ceny katalogowe i rabat to informacja handlowa — do atrybutów, nie do cen.
  headScope.find(".catalog-price-label").each((_i, el) => {
    const $el = $(el);
    const label = collapse($el.text());
    const value = text($el.prevAll(".catalog-price").first());
    if (label && value) attributes.push({ name: label, value });
  });
  const discount = labelValue(doc, /Twój rabat/i, headScope);
  if (discount) attributes.push({ name: "Twój rabat", value: discount });

  // Parametry techniczne — tabela `table-grey` (po usunięciu „Zamienników”
  // jest w dokumencie tylko jedna, należąca do naszego towaru).
  const table = $("table.table-grey").first();
  let manufacturer: string | null = null;
  if (table.length) {
    for (const pair of tablePairs(doc, table)) {
      if (/^producent$/i.test(pair.name)) manufacturer = pair.value;
      attributes.push(pair);
    }
  }
  if (!manufacturer) {
    manufacturer = $(".product-logos img[alt]").first().attr("alt")?.trim() || null;
  }

  // Stan: „Dostępny (17 szt)”. Klasa `.product-warehouse` należy do kart na
  // listach (zamienniki), na karcie głównej stan jest gołym tekstem.
  const stockEl =
    findSmallest(doc, headScope, /^(Dostępn|Niedostępn|Brak|W magazynie)/i, 80) ??
    headScope.find(".product-warehouse").first();
  const stockRaw = stockEl ? collapse(stockEl.text()) : "";
  const stock = parseStockText(stockRaw || null);
  if (stock.onRequest) {
    warnings.push("Sklep pokazuje „Dostępny na zamówienie” — stan magazynowy nieznany");
  }

  const unit =
    normalizeUnit(text(headScope.find(".input-group-addon.text-bold").first())) ??
    normalizeUnit(labelValue(doc, /J\.?\s?m\.?/i, headScope)) ??
    stock.unit;

  const description = htmlToText(doc, $("#description").first()) || null;

  return {
    fields: {
      url: productUrl,
      name,
      supplierCode,
      supplierProductId,
      manufacturer,
      // W Janexie kod produktu JEST symbolem producenta (sprzedają katalog
      // BOSCH-a pod jego symbolami); prefiks „OUTLET” to tylko oznaczenie
      // przeceny, więc do dopasowań idzie kod bez niego.
      manufacturerCode: manufacturerCodeFromSupplierCode(supplierCode),
      ean,
      priceNet: net,
      priceGross: gross,
      priceKind: net !== null && gross !== null ? "both" : net !== null ? "net" : gross !== null ? "gross" : "unknown",
      vatRate: resolveVat(net, gross, null).vatRate,
      currency: currency ?? "PLN",
      stock: stock.stock,
      stockText: stock.text,
      unit,
      ...(description ? { descriptionText: description } : {}),
      ...(attributes.length ? { attributes } : {}),
      imageUrl: image(ctx, productUrl),
    },
    warnings,
  };
}

/**
 * Zdjęcie. `img@src` w zapisanej stronie wskazuje na lokalny katalog
 * `./…_files/…` (bezużyteczny), ale galeria owija miniaturę linkiem do pełnego
 * pliku na serwerze sklepu — i to jest jedyny adres, który da się pobrać.
 */
function image(ctx: ParserContext, base: string | null): string | null {
  const { doc } = ctx;
  const big = doc.$(".product-images-big").first();
  if (!big.length) return null;
  const img = big.find("img").first();
  const fromImg =
    absUrl(base, img.attr("data-src") ?? null) ??
    absUrl(base, img.attr("data-lazyload-src") ?? null) ??
    absUrl(base, img.attr("src") ?? null);
  if (fromImg) return fromImg;
  const href = big.find('a[href]').first().attr("href") ?? null;
  const fromHref = absUrl(base, href);
  if (fromHref && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(fromHref)) return fromHref;
  return null;
}

/** „OUTLET FAS-ASD-AR” → „FAS-ASD-AR”. */
export function manufacturerCodeFromSupplierCode(code: string | null): string | null {
  if (!code) return null;
  const stripped = code.replace(/^\s*(OUTLET|PROMOCJA|WYPRZEDAŻ)\s+/i, "").trim();
  return stripped || null;
}
