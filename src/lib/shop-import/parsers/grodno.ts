/**
 * sklep/b2b Grodno (Certusoft) — STUB.
 *
 * TODO(kalibracja): brak próbki. Dodatkowy problem względem eltroxa: to SPA,
 * więc w zapisanym HTML-u ceny i stanu może w ogóle nie być w drzewie — siedzą
 * w stanie JavaScriptu (`__NUXT__`, `__INITIAL_STATE__`, `<script
 * type="application/json">`). Wykrywamy taki ślad i mówimy o tym wprost,
 * bo inaczej użytkownik zobaczy „nie rozpoznano ceny” i nie będzie wiedział, że
 * winna jest metoda zapisu strony, a nie parser.
 */
import type { ParserContext, ParserOutput, ShopParser } from "../types.js";
import { labelValue } from "../dom.js";
import { parseStockText } from "../price.js";

const SPA_MARKERS = [/__NUXT__/, /__INITIAL_STATE__/, /window\.__/, /type="application\/json"/i];

export const grodnoParser: ShopParser = {
  id: "grodno",
  version: "0-stub",
  parse: parseGrodno,
};

function parseGrodno(ctx: ParserContext): ParserOutput {
  const { doc } = ctx;
  const supplierCode = labelValue(doc, /Kod produktu|Symbol|Indeks|Nr katalogowy/i);
  const stock = parseStockText(labelValue(doc, /Dostępność|W magazynie|Stan magazynowy/i));
  const warnings = [
    "Parser Grodna nie jest skalibrowany (brak próbki strony) — dane pochodzą z parsera ogólnego, sprawdź wszystkie pola",
  ];
  if (SPA_MARKERS.some((re) => re.test(doc.html))) {
    warnings.push(
      "Sklep renderuje dane w JavaScript – zapisana strona może nie zawierać ceny/stanu"
    );
  }

  return {
    fields: {
      ...(supplierCode ? { supplierCode } : {}),
      ...(stock.stock !== null ? { stock: stock.stock } : {}),
      ...(stock.text ? { stockText: stock.text } : {}),
      ...(stock.unit ? { unit: stock.unit } : {}),
    },
    warnings,
  };
}
