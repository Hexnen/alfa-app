/**
 * Test biblioteki parserów stron sklepów (bez bazy i bez sieci):
 *   npx tsx scripts/test-shop-import.ts
 *
 * Referencją są dwie ZAPISANE strony produktów w scripts/fixtures/shop-import:
 * SAMAL (LiquidShop) i Janex (własny silnik B2B). Obie mają na sobie bloki
 * z cudzymi produktami („Produkty producenta”, „Zamienniki”) — połowa asercji
 * poniżej to anty-regresja zakresu: parser MUSI zwrócić dane naszego towaru,
 * a nie sąsiada z listy.
 *
 * Reszta to strony syntetyczne: parser ogólny, heurystyka logowania,
 * windows-1250, absolutyzacja adresów przy `<base href=".">` i stub eltroxa.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildSuggestedItem,
  buildSuggestedSource,
  decodeHtml,
  detectShop,
  parseProductBytes,
  parseProductHtml,
} from "../src/lib/shop-import/index.js";
import { absUrl } from "../src/lib/shop-import/dom.js";
import { parsePriceText, parseStockText, resolveVat } from "../src/lib/shop-import/price.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const FIXTURES = path.join(process.cwd(), "scripts/fixtures/shop-import");
const attrValue = (attrs: { name: string; value: string }[], name: RegExp) =>
  attrs.find((a) => name.test(a.name))?.value ?? null;

/* ------------------------------- price.ts ------------------------------- */

console.log("\n== price.ts");
ok('parsePriceText("48,80 PLN")', parsePriceText("48,80 PLN")?.value === 48.8, parsePriceText("48,80 PLN"));
ok('parsePriceText("48,80 PLN") → waluta PLN', parsePriceText("48,80 PLN")?.currency === "PLN");
ok('parsePriceText("1 234,56 zł") → 1234.56', parsePriceText("1 234,56 zł")?.value === 1234.56, parsePriceText("1 234,56 zł"));
ok('parsePriceText("1.234,56") → 1234.56', parsePriceText("1.234,56")?.value === 1234.56, parsePriceText("1.234,56"));
ok('parsePriceText("(49,20 PLN)") → 49.2', parsePriceText("(49,20 PLN)")?.value === 49.2, parsePriceText("(49,20 PLN)"));
ok('parsePriceText("38.13") → 38.13', parsePriceText("38.13")?.value === 38.13, parsePriceText("38.13"));
ok("parsePriceText bez liczby → null", parsePriceText("Zapytaj o cenę") === null, parsePriceText("Zapytaj o cenę"));
ok(
  'parseStockText("W magazynie: 17 szt.") → 17 szt',
  parseStockText("W magazynie: 17 szt.").stock === 17 && parseStockText("W magazynie: 17 szt.").unit === "szt",
  parseStockText("W magazynie: 17 szt.")
);
ok(
  'parseStockText("Dostępny (17 szt)") → 17',
  parseStockText("Dostępny (17 szt)").stock === 17,
  parseStockText("Dostępny (17 szt)")
);
ok(
  'parseStockText("Dostępny na zamówienie") → brak liczby',
  parseStockText("Dostępny na zamówienie").stock === null && parseStockText("Dostępny na zamówienie").onRequest,
  parseStockText("Dostępny na zamówienie")
);
ok("resolveVat: 48,80/60,02 → 23%", resolveVat(48.8, 60.02, null).vatRate === 23, resolveVat(48.8, 60.02, null));
ok(
  "resolveVat: etykieta sprzeczna z cenami → ostrzeżenie",
  resolveVat(48.8, 60.02, 8).warnings.length === 1,
  resolveVat(48.8, 60.02, 8)
);

/* ------------------------------- dom.ts: adresy ------------------------------- */

console.log("\n== dom.ts (adresy)");
const SAMAL_URL = "https://www.samal.pl/kamera-tc-c320n-spec-ak-i3-e-y-c-2-8mm-v2-0-1080p,3,10698,13244";
ok(
  'absUrl: bazą jest adres produktu, nie <base href=".">',
  absUrl(SAMAL_URL, "img/13625/a.jpg") === "https://www.samal.pl/img/13625/a.jpg",
  absUrl(SAMAL_URL, "img/13625/a.jpg")
);
ok('absUrl: "." (czyli <base href=".">) → null', absUrl(SAMAL_URL, ".") === null);
ok(
  "absUrl: lokalna kopia z zapisanej strony (./…_files/) → null",
  absUrl(SAMAL_URL, "./Strona_files/500___FAS.jpg") === null
);
ok(
  'absUrl: "//host/x.jpg" → https',
  absUrl(null, "//www.samal.pl/x.jpg") === "https://www.samal.pl/x.jpg",
  absUrl(null, "//www.samal.pl/x.jpg")
);
ok("absUrl: data: → null", absUrl(SAMAL_URL, "data:image/png;base64,AAA") === null);

/* --------------------------------- SAMAL --------------------------------- */

console.log("\n== samal.pl (próbka TC-C320N)");
const samalBytes = fs.readFileSync(path.join(FIXTURES, "samal-tc-c320n.html"));
const samal = parseProductBytes(samalBytes, { fileName: "samal-tc-c320n.html" });
const samalItem = buildSuggestedItem(samal);
const samalSource = buildSuggestedSource(samal);

ok("SAMAL: sklep samal.pl", samal.shop === "samal.pl", samal.shop);
ok("SAMAL: etykieta sklepu", samal.shopLabel === "SAMAL", samal.shopLabel);
ok("SAMAL: parser dedykowany", samal.diagnostics.parserUsed === "samal", samal.diagnostics);
ok("SAMAL: rozpoznanie po komentarzu „saved from url”", samal.diagnostics.shopDetectedBy === "savedFrom", samal.diagnostics.shopDetectedBy);
ok("SAMAL: url z canonical", samal.url === SAMAL_URL, samal.url);
ok("SAMAL: url bez podwójnego slasha (og:url go ma)", !!samal.url && !samal.url.includes("samal.pl//"), samal.url);
ok("SAMAL: nazwa", !!samal.name && samal.name.startsWith("TC-C320N Spec:AK/I3/E/Y/C/2.8mm/V2.0 Tiandy"), samal.name);
ok("SAMAL: kod dostawcy 127117", samal.supplierCode === "127117", samal.supplierCode);
ok("SAMAL: id produktu 13244", samal.supplierProductId === "13244", samal.supplierProductId);
ok("SAMAL: cena netto 48,80", samal.priceNet === 48.8, samal.priceNet);
ok("SAMAL: cena brutto 60,02", samal.priceGross === 60.02, samal.priceGross);
ok("SAMAL: obie ceny → priceKind both", samal.priceKind === "both", samal.priceKind);
ok("SAMAL: VAT 23", samal.vatRate === 23, samal.vatRate);
ok("SAMAL: waluta PLN", samal.currency === "PLN", samal.currency);
ok("SAMAL: stan 17", samal.stock === 17, samal.stock);
ok("SAMAL: tekst stanu", samal.stockText === "W magazynie: 17 szt.", samal.stockText);
ok("SAMAL: jednostka szt", samal.unit === "szt", samal.unit);
ok("SAMAL: EAN 6976642041715", samal.ean === "6976642041715", samal.ean);
ok("SAMAL: producent Tiandy", samal.manufacturer === "Tiandy", samal.manufacturer);
ok("SAMAL: symbol producenta z nazwy", samal.manufacturerCode === "TC-C320N", samal.manufacturerCode);
ok("SAMAL: kategoria z JSON-LD", samal.category === "Kamery", samal.category);
ok(
  "SAMAL: zdjęcie z og:image (JSON-LD image jest zepsuty)",
  samal.imageUrl === "https://www.samal.pl/img/13625/kamera-tc-c320n-spec-ak-i3-e-y-c-2-8mm-v2-0-1080p.jpg",
  samal.imageUrl
);
ok("SAMAL: opis ma punkt „• Standard: IP”", !!samal.descriptionText?.includes("• Standard: IP"), samal.descriptionText?.slice(0, 200));
ok("SAMAL: opis bez wordowych stylów („Calibri”)", !samal.descriptionText?.includes("Calibri"));
ok(
  "SAMAL: opis bez nagłówka zakładki „Opis produktu”",
  !samal.descriptionText?.startsWith("Opis produktu"),
  samal.descriptionText?.slice(0, 40)
);
ok(
  "SAMAL: anty-regresja zakresu — opis bez sąsiada TC-C321N",
  !samal.descriptionText?.includes("TC-C321N"),
  samal.descriptionText?.slice(0, 120)
);
ok(
  "SAMAL: anty-regresja zakresu — atrybuty tylko naszego towaru (< 40)",
  samal.attributes.length >= 5 && samal.attributes.length < 40,
  samal.attributes.length
);
ok("SAMAL: atrybut „Kod EAN”", attrValue(samal.attributes, /^kod ean$/i) === "6976642041715", samal.attributes);
ok("SAMAL: atrybut „Podatek VAT”", attrValue(samal.attributes, /^podatek vat$/i) === "23%", samal.attributes);
ok("SAMAL: atrybut „Rodzaj obudowy”", attrValue(samal.attributes, /^rodzaj obudowy$/i) === "kopułka (dome)", samal.attributes);
ok("SAMAL: zalogowany", samal.loggedIn === true, { loggedIn: samal.loggedIn, signals: samal.loginSignals });
ok("SAMAL: konto rozpoznane (tylko do UI)", samal.accountLabel === "scybulski@alfagroup.com.pl", samal.accountLabel);
ok("SAMAL: brak ostrzeżeń", samal.diagnostics.warnings.length === 0, samal.diagnostics.warnings);
ok("SAMAL: nic nie zostało nierozpoznane", samal.diagnostics.missing.length === 0, samal.diagnostics.missing);
ok("SAMAL: htmlBytes = rozmiar pliku", samal.diagnostics.htmlBytes === samalBytes.length, samal.diagnostics.htmlBytes);
ok("SAMAL: charset utf-8", samal.diagnostics.charset === "utf-8", samal.diagnostics.charset);

ok("SAMAL → towar: cena zakupu = netto", samalItem.purchasePrice === 48.8, samalItem.purchasePrice);
ok("SAMAL → towar: nasz indeks zostaje pusty", samalItem.sku === null, samalItem.sku);
ok("SAMAL → towar: kod kreskowy z EAN", samalItem.barcode === "6976642041715", samalItem.barcode);
ok("SAMAL → towar: symbol producenta", samalItem.manufacturerCode === "TC-C320N", samalItem.manufacturerCode);
ok(
  "SAMAL → towar: opis dostaje cechy dopisane w liniach",
  !!samalItem.description?.includes("Rodzaj obudowy: kopułka (dome)"),
  samalItem.description?.slice(-200)
);
ok(
  "SAMAL → towar: opis BEZ danych handlowych (VAT, EAN)",
  !samalItem.description?.includes("Podatek VAT") && !samalItem.description?.includes("Kod EAN"),
  samalItem.description?.slice(-200)
);
ok("SAMAL → źródło: sklep i kod", samalSource.shop === "samal.pl" && samalSource.supplierCode === "127117", samalSource);
ok("SAMAL → źródło: ceny i stan", samalSource.lastPriceNet === 48.8 && samalSource.lastPriceGross === 60.02 && samalSource.lastStock === 17, samalSource);
ok("SAMAL → źródło: raw bez accountLabel", !("accountLabel" in (samalSource.raw as Record<string, unknown>)), Object.keys(samalSource.raw));
ok(
  "SAMAL → źródło: raw z pełnym opisem (krótszy niż limit 2000 znaków)",
  samalSource.raw.descriptionText === samal.descriptionText && (samal.descriptionText?.length ?? 0) <= 2000,
  { raw: samalSource.raw.descriptionText?.length, full: samal.descriptionText?.length }
);
// Snapshot do raw_json ma być diagnostyką, nie drugą kopią kartoteki — długi
// opis jest w nim ucinany (pełny i tak siedzi w towarze).
const longDescHtml = `<html><head><link rel="canonical" href="https://sklep-testowy.example/p/3"></head>
<body><h1>Długi opis</h1><div itemprop="description">${"opis ".repeat(700)}</div></body></html>`;
const longRaw = buildSuggestedSource(parseProductHtml(longDescHtml)).raw;
ok(
  "źródło: raw ucina opis do 2000 znaków",
  longRaw.descriptionText?.length === 2000,
  longRaw.descriptionText?.length
);

/* --------------------------------- Janex --------------------------------- */

console.log("\n== janexint.com.pl (próbka OUTLET FAS-ASD-AR)");
const janexBytes = fs.readFileSync(path.join(FIXTURES, "janex-outlet-fas-asd-ar.html"));
const janex = parseProductBytes(janexBytes, { fileName: "janex-outlet-fas-asd-ar.html" });
const janexItem = buildSuggestedItem(janex);

ok("Janex: sklep janexint.com.pl", janex.shop === "janexint.com.pl", janex.shop);
ok("Janex: parser dedykowany", janex.diagnostics.parserUsed === "janex", janex.diagnostics.parserUsed);
ok(
  "Janex: url produktu (strona nie ma canonical ani og:)",
  janex.url === "https://janexint.com.pl/pl/produkt/outlet-redukcja-zasysania-z-otworem-10-mm-do-wspolpracy-z-kryza-foliowa-redukcji-zasysania-bosch-outlet-fas-asd-ar-52042.html",
  janex.url
);
ok("Janex: id produktu z ukrytego inputu", janex.supplierProductId === "52042", janex.supplierProductId);
ok("Janex: nazwa", janex.name === "OUTLET! Redukcja zasysania, z otworem 10 mm do współpracy z kryzą foliową redukcji zasysania, BOSCH", janex.name);
ok("Janex: kod dostawcy „OUTLET FAS-ASD-AR”", janex.supplierCode === "OUTLET FAS-ASD-AR", janex.supplierCode);
ok("Janex: symbol producenta bez prefiksu OUTLET", janex.manufacturerCode === "FAS-ASD-AR", janex.manufacturerCode);
ok("Janex: EAN 2010000520420", janex.ean === "2010000520420", janex.ean);
ok("Janex: cena netto 9,60", janex.priceNet === 9.6, janex.priceNet);
ok("Janex: cena brutto 11,81", janex.priceGross === 11.81, janex.priceGross);
ok("Janex: priceKind both", janex.priceKind === "both", janex.priceKind);
ok("Janex: VAT policzony z cen (23%)", janex.vatRate === 23, janex.vatRate);
ok(
  "Janex: ANTY-REGRESJA — żadna cena z zamiennika (40,00 / 49,20)",
  janex.priceNet !== 40 && janex.priceGross !== 40 && janex.priceGross !== 49.2,
  { net: janex.priceNet, gross: janex.priceGross }
);
ok(
  "Janex: ANTY-REGRESJA — kod nie jest kodem zamiennika (FAS-ASD-AR bez OUTLET)",
  janex.supplierCode !== "FAS-ASD-AR",
  janex.supplierCode
);
ok("Janex: cena katalogowa netto do atrybutów", attrValue(janex.attributes, /^cena katalogowa netto$/i) === "31,00 PLN", janex.attributes);
ok("Janex: cena katalogowa brutto do atrybutów", attrValue(janex.attributes, /^cena katalogowa brutto$/i) === "38,13 PLN", janex.attributes);
ok("Janex: rabat do atrybutów", attrValue(janex.attributes, /^twój rabat$/i) === "69.03%", janex.attributes);
ok("Janex: stan 17 (nie „Dostępny na zamówienie” z zamiennika)", janex.stock === 17, { stock: janex.stock, text: janex.stockText });
ok("Janex: jednostka szt", janex.unit === "szt", janex.unit);
ok("Janex: producent BOSCH z tabeli parametrów", janex.manufacturer === "BOSCH", janex.manufacturer);
ok("Janex: parametry techniczne w atrybutach", attrValue(janex.attributes, /^typ produktu$/i) === "czujka zasysająca", janex.attributes);
ok("Janex: kategoria z okruszków", janex.category === "Systemy ASD TITANUS", janex.category);
ok("Janex: opis z zakładki #description", !!janex.descriptionText?.includes("Urządzenia oznaczone jako OUTLET"), janex.descriptionText?.slice(0, 120));
ok("Janex: zalogowany", janex.loggedIn === true, { loggedIn: janex.loggedIn, signals: janex.loginSignals });
ok("Janex: brak ostrzeżeń", janex.diagnostics.warnings.length === 0, janex.diagnostics.warnings);
ok(
  "Janex → towar: opis bez cen katalogowych i rabatu",
  !janexItem.description?.includes("Cena katalogowa") && !janexItem.description?.includes("Twój rabat"),
  janexItem.description?.slice(-200)
);
ok("Janex → towar: cena zakupu = netto 9,60", janexItem.purchasePrice === 9.6, janexItem.purchasePrice);

/* -------------------------------- generyk -------------------------------- */

console.log("\n== parser ogólny (strona syntetyczna)");
const genericHtml = `<!DOCTYPE html>
<html lang="pl"><head>
<base href=".">
<meta property="og:url" content="https://sklep-testowy.example//produkt/abc">
<meta property="og:title" content="Kabel testowy 5 m">
<meta property="og:image" content="img/kabel.jpg">
<title>Kabel testowy 5 m | Sklep Testowy</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Kabel testowy 5 m","sku":"KT-5","mpn":"MPN-KT5",
 "gtin13":"5901234123457","brand":{"@type":"Brand","name":"TestBrand"},"category":"Kable",
 "description":"Opis kabla testowego.",
 "offers":{"@type":"Offer","priceCurrency":"PLN","price":"123.45","availability":"https://schema.org/InStock"}}
</script>
</head><body><h1>Kabel testowy 5 m</h1>
<div class="product-specification"><table><tr><th>Długość</th><td>5 m</td></tr></table></div>
</body></html>`;
const gen = parseProductHtml(genericHtml);
ok("generyk: sklep z og:url", gen.shop === "sklep-testowy.example", gen.shop);
ok("generyk: rozpoznanie po og:url", gen.diagnostics.shopDetectedBy === "ogUrl", gen.diagnostics.shopDetectedBy);
ok("generyk: og:url z podwójnym slashem naprawiony", gen.url === "https://sklep-testowy.example/produkt/abc", gen.url);
ok("generyk: parser ogólny", gen.diagnostics.parserUsed === "generic", gen.diagnostics.parserUsed);
ok("generyk: etykieta nieznanego sklepu = domena", gen.shopLabel === "sklep-testowy.example", gen.shopLabel);
ok("generyk: nazwa z JSON-LD", gen.name === "Kabel testowy 5 m", gen.name);
ok("generyk: kod dostawcy z sku", gen.supplierCode === "KT-5", gen.supplierCode);
ok("generyk: symbol producenta z mpn", gen.manufacturerCode === "MPN-KT5", gen.manufacturerCode);
ok("generyk: EAN z gtin13", gen.ean === "5901234123457", gen.ean);
ok("generyk: producent z brand", gen.manufacturer === "TestBrand", gen.manufacturer);
ok("generyk: kategoria", gen.category === "Kable", gen.category);
ok("generyk: jedna cena bez etykiety → brutto + priceKind unknown", gen.priceGross === 123.45 && gen.priceNet === null && gen.priceKind === "unknown", {
  net: gen.priceNet,
  gross: gen.priceGross,
  kind: gen.priceKind,
});
ok("generyk: waluta z JSON-LD", gen.currency === "PLN", gen.currency);
ok("generyk: dostępność opisowo", gen.stockText === "Dostępny", gen.stockText);
ok(
  'generyk: zdjęcie absolutyzowane po adresie produktu (mimo <base href=".">)',
  gen.imageUrl === "https://sklep-testowy.example/produkt/img/kabel.jpg",
  gen.imageUrl
);
ok("generyk: atrybuty z tabeli specyfikacji", attrValue(gen.attributes, /^długość$/i) === "5 m", gen.attributes);
ok(
  "generyk: ostrzeżenie o braku dedykowanego parsera",
  gen.diagnostics.warnings.some((w) => /Brak dedykowanego parsera/i.test(w)),
  gen.diagnostics.warnings
);
ok(
  "generyk: ostrzeżenie o cenie bez etykiety",
  gen.diagnostics.warnings.some((w) => /bez etykiety netto\/brutto/i.test(w)),
  gen.diagnostics.warnings
);
ok(
  "generyk: cena zakupu NIE jest podpowiadana przy priceKind unknown",
  buildSuggestedItem(gen).purchasePrice === null,
  buildSuggestedItem(gen).purchasePrice
);
ok("generyk: nierozpoznane pola wypisane w diagnostyce", gen.diagnostics.missing.includes("stock") && gen.diagnostics.recognized.includes("name"), gen.diagnostics);

/* ------------------------------ logowanie ------------------------------ */

console.log("\n== heurystyka logowania");
const loggedHtml = `<html><head><link rel="canonical" href="https://sklep-testowy.example/p/1"></head>
<body><a href="/konto/wyloguj">Wyloguj</a>
<div>Cena netto</div><div>Cena brutto</div>
<h1>Towar B2B</h1></body></html>`;
const logged = parseProductHtml(loggedHtml);
ok("logowanie: „Wyloguj” + netto/brutto → zalogowany", logged.loggedIn === true, logged.loginSignals);
const guest = parseProductHtml(loggedHtml.replace(/wyloguj/gi, "zaloguj"));
ok("logowanie: po podmianie na „Zaloguj” → NIE zalogowany", guest.loggedIn === false, {
  loggedIn: guest.loggedIn,
  signals: guest.loginSignals,
});
ok(
  "logowanie: ostrzeżenie o stronie zapisanej bez logowania",
  guest.diagnostics.warnings.some((w) => /bez logowania/i.test(w)),
  guest.diagnostics.warnings
);

/* ------------------------------- kodowanie ------------------------------- */

console.log("\n== decodeHtml (windows-1250)");
// „Rozdzielczość” w cp1250: ś = 0x9C, ć = 0xE6 (w UTF-8 te bajty to krzaki).
const cp1250Word = Buffer.from([0x52, 0x6f, 0x7a, 0x64, 0x7a, 0x69, 0x65, 0x6c, 0x63, 0x7a, 0x6f, 0x9c, 0xe6]);
const cp1250Bytes = Buffer.concat([
  Buffer.from(
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1250">' +
      '<link rel="canonical" href="https://sklep-testowy.example/p/2"><title>x</title></head><body><h1>',
    "latin1"
  ),
  cp1250Word,
  Buffer.from("</h1></body></html>", "latin1"),
]);
const decoded = decodeHtml(cp1250Bytes);
ok("decodeHtml: charset windows-1250 z deklaracji", decoded.charset === "windows-1250", decoded.charset);
ok("decodeHtml: polskie znaki odzyskane", decoded.html.includes("Rozdzielczość"), decoded.html.slice(-80));
const cp1250Parsed = parseProductBytes(cp1250Bytes);
ok("parseProductBytes: nazwa z windows-1250", cp1250Parsed.name === "Rozdzielczość", cp1250Parsed.name);
ok("parseProductBytes: charset w diagnostyce", cp1250Parsed.diagnostics.charset === "windows-1250", cp1250Parsed.diagnostics.charset);
ok("decodeHtml: bez deklaracji → utf-8", decodeHtml(Buffer.from("<html><h1>ąćż</h1></html>", "utf8")).html.includes("ąćż"));

/* -------------------------------- detectShop -------------------------------- */

console.log("\n== detectShop");
const samalHtml = samalBytes.toString("utf8");
const detected = detectShop(samalHtml);
ok("detectShop: SAMAL po komentarzu „saved from url”", detected.shop === "samal.pl" && detected.detectedBy === "savedFrom", detected);
const hinted = detectShop(samalHtml, "https://inny-sklep.example/produkt/1");
ok("detectShop: urlHint (plugin) wygrywa ze stroną", hinted.shop === "inny-sklep.example" && hinted.detectedBy === "urlHint", hinted);
const noUrl = detectShop("<html><body><h1>Nic</h1></body></html>");
ok("detectShop: brak adresu → brak sklepu", noUrl.shop === "" && noUrl.detectedBy === "none", noUrl);

/* --------------------------------- stuby --------------------------------- */

console.log("\n== stuby sklepów bez próbki");
const eltroxHtml = `<html><head><link rel="canonical" href="https://eltrox.pl/produkt/kamera-x">
<title>Kamera X - Eltrox</title></head><body>
<h1>Kamera X</h1><p>Kod produktu: EL-123</p><p>Dostępność: 5 szt.</p>
<a href="/wyloguj">Wyloguj</a><div>Cena netto</div><div>Cena brutto</div>
</body></html>`;
const eltrox = parseProductHtml(eltroxHtml);
ok("eltrox: sklep eltrox.pl z canonical", eltrox.shop === "eltrox.pl" && eltrox.diagnostics.shopDetectedBy === "canonical", eltrox.diagnostics);
ok("eltrox: etykieta sklepu", eltrox.shopLabel === "Eltrox", eltrox.shopLabel);
ok("eltrox: użyty stub sklepu", eltrox.diagnostics.parserUsed === "eltrox", eltrox.diagnostics.parserUsed);
ok("eltrox: stub oznaczony wersją 0", eltrox.diagnostics.parserVersion === "0-stub", eltrox.diagnostics.parserVersion);
ok("eltrox: nazwa z h1", eltrox.name === "Kamera X", eltrox.name);
ok("eltrox: kod produktu z etykiety", eltrox.supplierCode === "EL-123", eltrox.supplierCode);
ok("eltrox: dostępność z etykiety", eltrox.stock === 5 && eltrox.unit === "szt", { stock: eltrox.stock, unit: eltrox.unit });
ok(
  "eltrox: ostrzeżenie o nieskalibrowanym parserze",
  eltrox.diagnostics.warnings.some((w) => /nie jest skalibrowany/i.test(w)),
  eltrox.diagnostics.warnings
);

const grodnoHtml = `<html><head><link rel="canonical" href="https://sklep.grodno.pl/produkt/przewod-1">
<title>Przewód - Grodno</title></head><body><h1>Przewód YDY</h1>
<script>window.__NUXT__ = {data:[{product:{price:12.3}}]};</script>
</body></html>`;
const grodno = parseProductHtml(grodnoHtml);
ok("grodno: subdomena trafia do parsera Grodna", grodno.diagnostics.parserUsed === "grodno" && grodno.shopLabel === "Grodno", {
  parser: grodno.diagnostics.parserUsed,
  label: grodno.shopLabel,
  shop: grodno.shop,
});
ok(
  "grodno: ostrzeżenie o danych renderowanych w JavaScript",
  grodno.diagnostics.warnings.some((w) => /JavaScript/.test(w)),
  grodno.diagnostics.warnings
);

/* --------------------------------- limity --------------------------------- */

console.log("\n== limity");
let tooBigThrew = false;
try {
  parseProductHtml(`<html><body>${"x".repeat(12 * 1024 * 1024 + 10)}</body></html>`);
} catch (e) {
  tooBigThrew = /za duża/i.test((e as Error).message);
}
ok("limit: HTML > 12 MB odrzucony wyjątkiem", tooBigThrew);

const notProduct = parseProductHtml('<html><head><link rel="canonical" href="https://sklep-testowy.example/o-nas"></head><body><p>O nas</p></body></html>');
ok("strona bez produktu: brak nazwy", notProduct.name === null, notProduct.name);
ok(
  "strona bez produktu: ostrzeżenie „czy to strona produktu?”",
  notProduct.diagnostics.warnings.some((w) => /strona produktu/i.test(w)),
  notProduct.diagnostics.warnings
);

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures ? 1 : 0);
