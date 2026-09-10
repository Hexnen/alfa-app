/**
 * eltrox.pl — STUB.
 *
 * TODO(kalibracja): brak próbki. Sklep stoi za Cloudflare i wymaga logowania,
 * więc nie mamy zapisanej strony produktu do sprawdzenia selektorów. Do czasu,
 * gdy użytkownik przyśle taką stronę, robimy dwie rzeczy:
 *  - zostawiamy pracę parserowi ogólnemu (orkiestrator scala go pod spodem, więc
 *    nazwa/opis/zdjęcie z JSON-LD i og: działają już teraz),
 *  - dokładamy tylko to, co da się zrobić bez wiedzy o layoucie: kod produktu
 *    i dostępność z etykiet tekstowych,
 * i UCZCIWIE ostrzegamy w diagnostyce, że parser nie jest skalibrowany —
 * dzięki temu człowiek wie, że musi sprawdzić każde pole.
 */
import type { ParserContext, ParserOutput, ShopParser } from "../types.js";
import { labelValue } from "../dom.js";
import { parseStockText } from "../price.js";

export const eltroxParser: ShopParser = {
  id: "eltrox",
  version: "0-stub",
  parse: parseEltrox,
};

function parseEltrox(ctx: ParserContext): ParserOutput {
  const { doc } = ctx;
  const supplierCode = labelValue(doc, /Kod produktu|Symbol|Indeks|Nr katalogowy/i);
  const stock = parseStockText(labelValue(doc, /Dostępność|W magazynie|Stan magazynowy/i));

  return {
    fields: {
      ...(supplierCode ? { supplierCode } : {}),
      ...(stock.stock !== null ? { stock: stock.stock } : {}),
      ...(stock.text ? { stockText: stock.text } : {}),
      ...(stock.unit ? { unit: stock.unit } : {}),
    },
    warnings: [
      "Parser eltrox.pl nie jest skalibrowany (brak próbki strony) — dane pochodzą z parsera ogólnego, sprawdź wszystkie pola",
    ],
  };
}
