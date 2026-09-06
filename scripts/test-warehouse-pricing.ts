/**
 * Test cen i marży w kartotece magazynu, na prawdziwej bazie (data/alfa.db),
 * przez trasy Hono (app.request):
 *   npx tsx scripts/test-warehouse-pricing.ts
 *
 * Sprawdza: zapis i walidację ceny zakupu / sprzedaży / producenta, cenę
 * sprzedaży liczoną z globalnego narzutu (sale_price = NULL) i jej nadpisanie,
 * reakcję katalogu na zmianę narzutu, marżę i narzut procentowy, uczciwe `null`
 * przy braku ceny zakupu oraz podpowiedź ceny z ostatniego ZATWIERDZONEGO PZ
 * (szkic nie może jej podać).
 *
 * Sprząta po sobie HARD (wszystko z prefiksem __WHP_TEST__), także przy błędzie.
 * Globalny narzut jest przywracany do wartości sprzed testu.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { eq, like, inArray } from "drizzle-orm";
import warehouse from "../src/routes/warehouse.js";
import { getSetting, setSetting, deleteSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__WHP_TEST__";
const MARKUP_KEY = "company.warehouse_markup";

const app = new Hono();
app.route("/warehouse", warehouse);

type Res = { status: number; success?: boolean; data?: any; error?: string };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

/** Narzut sprzed testu — musi wrócić na swoje miejsce, bo to ustawienie produkcyjne. */
const originalMarkup = getSetting(MARKUP_KEY);

/** Towar z listy po nazwie (lista dokleja pola wyliczane). */
async function itemByName(name: string) {
  const r = await call("GET", "/warehouse/items?includeArchived=1");
  return (r.data as any[]).find((i) => i.name === name);
}

function cleanup() {
  const items = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  const itemIds = items.map((i) => i.id);

  const docs = db
    .select()
    .from(schema.warehouseDocuments)
    .where(like(schema.warehouseDocuments.notes, `${PREFIX}%`))
    .all();
  const docIds = docs.map((d) => d.id);

  // Kolejność: ruchy i stany trzymają FK do pozycji i towarów.
  if (docIds.length) {
    db.delete(schema.warehouseMovements)
      .where(inArray(schema.warehouseMovements.documentId, docIds))
      .run();
    db.delete(schema.warehouseDocumentItems)
      .where(inArray(schema.warehouseDocumentItems.documentId, docIds))
      .run();
    db.delete(schema.warehouseDocuments)
      .where(inArray(schema.warehouseDocuments.id, docIds))
      .run();
  }
  if (itemIds.length) {
    db.delete(schema.warehouseMovements)
      .where(inArray(schema.warehouseMovements.itemId, itemIds))
      .run();
    db.delete(schema.warehouseStock)
      .where(inArray(schema.warehouseStock.itemId, itemIds))
      .run();
    db.delete(schema.warehouseItems)
      .where(inArray(schema.warehouseItems.id, itemIds))
      .run();
  }

  if (originalMarkup === null || originalMarkup === undefined) {
    deleteSetting(MARKUP_KEY);
  } else {
    setSetting(MARKUP_KEY, originalMarkup, null);
  }
}

try {
  cleanup(); // resztki po przerwanym przebiegu

  setSetting(MARKUP_KEY, "25", null);

  // --- Zapis pól cenowych ---------------------------------------------------
  const created = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Kamera`,
    unit: "szt",
    manufacturer: "Dahua",
    purchasePrice: 400,
  });
  ok("tworzenie towaru z ceną zakupu", created.status === 201, created);
  ok("producent zapisany", created.data?.manufacturer === "Dahua", created.data);
  ok("cena zakupu zapisana", created.data?.purchasePrice === 400, created.data);
  ok(
    "bez ceny sprzedaży zostaje NULL (tryb automatu)",
    created.data?.salePrice === null,
    created.data
  );
  const itemId: number = created.data.id;

  // --- Cena z narzutu -------------------------------------------------------
  let row = await itemByName(`${PREFIX} Kamera`);
  ok("cena sprzedaży z narzutu 25%: 400 → 500", row?.effectiveSalePrice === 500, row);
  ok("oznaczona jako automatyczna", row?.salePriceAuto === true, row);
  ok("marża 20% (zysk 100 z ceny 500)", row?.marginPct === 20, row);
  ok("narzut 25% (zysk 100 od kosztu 400)", row?.markupPct === 25, row);
  ok("zysk 100 zł", row?.marginAmount === 100, row);

  // Zmiana narzutu MUSI przeliczyć katalog — ceny nie są zapisywane w bazie.
  setSetting(MARKUP_KEY, "50", null);
  row = await itemByName(`${PREFIX} Kamera`);
  ok("po zmianie narzutu na 50%: 400 → 600", row?.effectiveSalePrice === 600, row);
  ok("marża po zmianie narzutu = 33,33%", row?.marginPct === 33.33, row);
  setSetting(MARKUP_KEY, "25", null);

  // --- Nadpisanie ceny ------------------------------------------------------
  const overridden = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX} Kamera`,
    unit: "szt",
    manufacturer: "Dahua",
    purchasePrice: 400,
    salePrice: 450,
  });
  ok("nadpisanie ceny sprzedaży", overridden.status === 200, overridden);
  row = await itemByName(`${PREFIX} Kamera`);
  ok("własna cena wygrywa z narzutem", row?.effectiveSalePrice === 450, row);
  ok("przestaje być automatyczna", row?.salePriceAuto === false, row);
  ok("marża z własnej ceny = 11,11%", row?.marginPct === 11.11, row);

  // Pusty string = powrót do automatu, a nie zero.
  await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX} Kamera`,
    unit: "szt",
    purchasePrice: 400,
    salePrice: "",
  });
  row = await itemByName(`${PREFIX} Kamera`);
  ok("pusta cena sprzedaży wraca do automatu", row?.effectiveSalePrice === 500, row);
  ok("i znów jest oznaczona jako auto", row?.salePriceAuto === true, row);

  // --- Brak ceny zakupu = brak marży, NIE zero ------------------------------
  const noCost = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Bez ceny`,
    unit: "szt",
  });
  ok("towar bez cen tworzy się poprawnie", noCost.status === 201, noCost);
  const noCostRow = await itemByName(`${PREFIX} Bez ceny`);
  ok(
    "bez ceny zakupu cena sprzedaży jest null",
    noCostRow?.effectiveSalePrice === null,
    noCostRow
  );
  ok("bez ceny zakupu marża jest null, nie 100%", noCostRow?.marginPct === null, noCostRow);

  // Cena zakupu 0 (towar powierzony) też nie może dawać 100% marży.
  const freebie = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Gratis`,
    unit: "szt",
    purchasePrice: 0,
    salePrice: 100,
  });
  ok("cena zakupu 0 jest dozwolona", freebie.status === 201, freebie);
  const freebieRow = await itemByName(`${PREFIX} Gratis`);
  ok("cena zakupu 0 zapisana jako 0, nie NULL", freebieRow?.purchasePrice === 0, freebieRow);
  ok("przy koszcie 0 marża jest null", freebieRow?.marginPct === null, freebieRow);

  // --- Walidacja ------------------------------------------------------------
  const negative = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Ujemna`,
    unit: "szt",
    purchasePrice: -5,
  });
  ok("ujemna cena zakupu odrzucona", negative.status === 400, negative);
  const notANumber = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Tekst`,
    unit: "szt",
    salePrice: "abc",
  });
  ok("cena nieliczbowa odrzucona", notANumber.status === 400, notANumber);
  const comma = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Przecinek`,
    unit: "szt",
    purchasePrice: "12,50",
  });
  ok("cena z przecinkiem dziesiętnym przyjęta", comma.status === 201, comma);
  ok("przecinek zamieniony na 12.5", comma.data?.purchasePrice === 12.5, comma.data);

  // --- Podpowiedź z ostatniego PZ ------------------------------------------
  const mainWh = db
    .select()
    .from(schema.warehouses)
    .where(eq(schema.warehouses.type, "main"))
    .all()[0];
  ok("istnieje magazyn główny (seed przy starcie aplikacji)", !!mainWh, mainWh);

  if (mainWh) {
    const draft = await call("POST", "/warehouse/documents", {
      docType: "PZ",
      warehouseToId: mainWh.id,
      issuedAt: "2026-08-01",
      notes: `${PREFIX} szkic`,
      items: [{ itemId, quantity: 2, unitPrice: 333 }],
    });
    ok("szkic PZ utworzony", draft.status === 201, draft);
    const fromDraft = await call("GET", `/warehouse/items/${itemId}/last-purchase`);
    ok(
      "szkic PZ NIE podpowiada ceny (nikt go nie zatwierdził)",
      fromDraft.data === null,
      fromDraft
    );

    const confirmed = await call("POST", "/warehouse/documents", {
      docType: "PZ",
      warehouseToId: mainWh.id,
      issuedAt: "2026-08-02",
      notes: `${PREFIX} zatwierdzony`,
      confirm: true,
      items: [{ itemId, quantity: 3, unitPrice: 444 }],
    });
    ok("zatwierdzone PZ utworzone", confirmed.status === 201, confirmed);
    const fromConfirmed = await call("GET", `/warehouse/items/${itemId}/last-purchase`);
    ok(
      "podpowiedź bierze cenę z zatwierdzonego PZ",
      fromConfirmed.data?.unitPrice === 444,
      fromConfirmed
    );

    const missing = await call("GET", "/warehouse/items/99999999/last-purchase");
    ok("nieistniejący towar → null, nie błąd", missing.status === 200 && missing.data === null, missing);
  }

  // --- Konfiguracja cenowa --------------------------------------------------
  const cfg = await call("GET", "/warehouse/pricing-config");
  ok("pricing-config zwraca narzut", cfg.data?.warehouseMarkup === 25, cfg);
} finally {
  cleanup();

  const left = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych towarów", left.length === 0, left);

  const leftDocs = db
    .select()
    .from(schema.warehouseDocuments)
    .where(like(schema.warehouseDocuments.notes, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych dokumentów", leftDocs.length === 0, leftDocs);

  const markupNow = getSetting(MARKUP_KEY);
  ok(
    "sprzątanie: globalny narzut przywrócony",
    (markupNow ?? null) === (originalMarkup ?? null),
    { markupNow, originalMarkup }
  );
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
