/**
 * Test źródeł towaru (sklepy dostawców) i importu z zapisanej strony sklepu —
 * przez trasy Hono (app.request) z podstawionym userem i strażnikiem zakładek,
 * na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-warehouse-sources.ts
 *
 * Sedno: `warehouse_item_sources` ma UNIQUE (item_id, shop), bo import strony
 * produktu musi być ODŚWIEŻENIEM źródła, nie zakładaniem duplikatu. Testy
 * pilnują tego z obu stron — że powtórny zapis nie mnoży wierszy i że pełna
 * podmiana zbioru (`sources` w PUT /items) faktycznie usuwa to, czego nie ma
 * na liście, a NIEPRZYSŁANE `sources` nie rusza niczego.
 *
 * Zakres: POST /items ze źródłami, GET /items/:id/sources (bez rawJson, ?raw=1),
 * PUT /items/:id/sources/:shop (upsert + drugi sklep), podmiana zbioru przez
 * PUT /items, DELETE źródła (obce id → 404), sourcesCount/sourceShops w liście,
 * kaskada FK przy fizycznym usunięciu towaru + PRAGMA foreign_key_check,
 * walidacje (domena, kwota „48,80 PLN", stan, loggedIn, 64 KB rawJson, powtórzony
 * sklep), manufacturerCode w kartotece oraz POST /warehouse/import/parse
 * (multipart z fikstury SAMAL, JSON {html}, .txt → 400, matches source/ean).
 *
 * Asercje ZAWARTOŚCI parsowania są pomijane (SKIP), gdy biblioteka parserów jest
 * jeszcze stubem — rozpoznajemy to po `diagnostics.parserVersion === "stub"`.
 *
 * Sprząta po sobie HARD (prefiks __SRCIMP_TEST__) na wejściu i w finally.
 */
import { Hono } from "hono";
import sharp from "sharp";
import { readFileSync, existsSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import type Database from "better-sqlite3";
import { db, schema } from "../src/db/index.js";
import warehouseRoutes from "../src/routes/warehouse.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
let skipped = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}
function skip(label: string, why: string) {
  console.log(`SKIP ${label} (${why})`);
  skipped++;
}

const PREFIX = "__SRCIMP_TEST__";
const FIXTURE = "scripts/fixtures/shop-import/samal-tc-c320n.html";
const sqlite = (db as unknown as { $client: Database.Database }).$client;

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !plain) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

/** Ten sam użytkownik z podmienioną mapą uprawnień (guard czyta role + permissions). */
function withPerms(user: User, permissions: Record<string, "view" | "edit"> | null): User {
  return { ...user, role: "user", permissions: permissions ? JSON.stringify(permissions) : null };
}

function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/warehouse", warehouseRoutes);
  return app;
}
const asEditor = appFor(withPerms(plain, { "technical/magazyn": "edit" }));
const asViewer = appFor(withPerms(plain, { "technical/magazyn": "view" }));
const asStranger = appFor(withPerms(plain, { "technical/manuale": "edit" }));

type Res = { status: number; success?: boolean; data?: any; error?: string };
async function callOn(a: Hono, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await a.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}
const call = (method: string, path: string, body?: unknown) => callOn(asEditor, method, path, body);

/** multipart/form-data z plikiem — tak samo, jak wysyła to przeglądarka. */
async function postFile(
  a: Hono,
  path: string,
  file: { name: string; type: string; data: Buffer },
  extra?: Record<string, string>
): Promise<Res> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(file.data)], file.name, { type: file.type }));
  for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
  const res = await a.request(path, { method: "POST", body: fd });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

function cleanup() {
  // Źródła schodzą kaskadą FK razem z towarem — usuwamy tylko kartoteki.
  db.delete(schema.warehouseItems).where(like(schema.warehouseItems.name, `${PREFIX}%`)).run();
}
cleanup();

const SRC_KEYS = [
  "id",
  "itemId",
  "shop",
  "shopLabel",
  "productUrl",
  "supplierCode",
  "supplierProductId",
  "lastPriceNet",
  "lastPriceGross",
  "vatRate",
  "currency",
  "lastStock",
  "loggedIn",
  "fetchedAt",
  "createdAt",
  "updatedAt",
];

try {
  // ------------------------------------------------------------------
  // 1. POST /items ze źródłami (ścieżka „zapisz to, co zaimportowałem")
  // ------------------------------------------------------------------
  const created = await call("POST", "/warehouse/items", {
    name: `${PREFIX}Kamera Tiandy`,
    sku: `${PREFIX}KAM-1`,
    unit: "szt",
    barcode: "6971993220001",
    manufacturer: "Tiandy",
    manufacturerCode: "TC-C320N",
    purchasePrice: "48,80",
    sources: [
      {
        shop: "https://WWW.samal.pl/produkt/tc-c320n",
        shopLabel: "SAMAL",
        productUrl: "https://samal.pl/produkt/tc-c320n",
        supplierCode: "127117",
        supplierProductId: "13244",
        lastPriceNet: "48,80",
        lastPriceGross: 60.02,
        vatRate: 23,
        lastStock: 17,
        loggedIn: true,
        raw: { diagnostics: { parserUsed: "samal" } },
      },
    ],
  });
  ok("POST /items ze źródłami → 201", created.status === 201, created);
  const itemId: number = created.data?.id;
  ok("POST /items zapisuje manufacturerCode", created.data?.manufacturerCode === "TC-C320N", created.data);

  // ------------------------------------------------------------------
  // 2. GET /items/:id/sources
  // ------------------------------------------------------------------
  const s1 = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("GET sources → 200 i jeden wiersz", s1.status === 200 && s1.data?.length === 1, s1);
  const src = s1.data?.[0];
  ok("źródło: „www.” i schemat obcięte do domeny", src?.shop === "samal.pl", src);
  ok("źródło: kwota „48,80” sparsowana", src?.lastPriceNet === 48.8, src);
  ok("źródło: brutto/VAT/stan zapisane", src?.lastPriceGross === 60.02 && src?.vatRate === 23 && src?.lastStock === 17, src);
  ok("źródło: waluta domyślnie PLN", src?.currency === "PLN", src);
  ok("źródło: loggedIn=true przechodzi jako boolean", src?.loggedIn === true, src);
  ok("źródło: fetchedAt ustawione automatem", typeof src?.fetchedAt === "string" && !!src.fetchedAt, src);
  ok("źródło: rawJson NIE wychodzi na front", !("rawJson" in (src ?? {})) && !("raw" in (src ?? {})), Object.keys(src ?? {}));
  ok(
    "źródło: kształt odpowiedzi zgodny z kontraktem",
    SRC_KEYS.every((k) => k in (src ?? {})) && Object.keys(src ?? {}).length === SRC_KEYS.length,
    Object.keys(src ?? {})
  );

  const s1raw = await call("GET", `/warehouse/items/${itemId}/sources?raw=1`);
  ok(
    "GET sources?raw=1 dokłada sparsowane `raw`",
    s1raw.data?.[0]?.raw?.diagnostics?.parserUsed === "samal",
    s1raw.data?.[0]?.raw
  );

  // ------------------------------------------------------------------
  // 3. PUT /items/:id/sources/:shop — upsert, bez duplikatu
  // ------------------------------------------------------------------
  const up1 = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    shopLabel: "SAMAL",
    productUrl: "https://samal.pl/produkt/tc-c320n",
    supplierCode: "127117",
    lastPriceNet: 51.5,
    lastStock: 9,
    loggedIn: true,
  });
  ok("PUT sources/:shop → 200", up1.status === 200, up1);
  ok("PUT sources/:shop nadpisuje ten sam wiersz", up1.data?.id === src?.id, { got: up1.data?.id, was: src?.id });
  ok("PUT sources/:shop podmienia cenę", up1.data?.lastPriceNet === 51.5, up1.data);
  ok(
    "PUT sources/:shop = pełna podmiana pól (nieprzysłane → null)",
    up1.data?.lastPriceGross === null && up1.data?.vatRate === null,
    up1.data
  );
  const afterUp1 = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("po upsercie nadal JEDNO źródło", afterUp1.data?.length === 1, afterUp1.data);

  // Drugi sklep — nowy wiersz, nie nadpisanie pierwszego.
  const up2 = await call("PUT", `/warehouse/items/${itemId}/sources/janexint.com.pl`, {
    shopLabel: "Janex International",
    supplierCode: "OUTLET FAS-ASD-AR",
    lastPriceNet: 9.6,
    lastPriceGross: 11.81,
    vatRate: 23,
  });
  ok("PUT drugiego sklepu → 200", up2.status === 200, up2);
  const two = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("dwa źródła po dodaniu drugiego sklepu", two.data?.length === 2, two.data);
  ok(
    "źródła sortowane po domenie",
    two.data?.[0]?.shop === "janexint.com.pl" && two.data?.[1]?.shop === "samal.pl",
    two.data?.map((r: any) => r.shop)
  );
  ok("drugie źródło: loggedIn domyślnie false", two.data?.[0]?.loggedIn === false, two.data?.[0]);

  // ------------------------------------------------------------------
  // 4. sourcesCount / sourceShops w liście towarów
  // ------------------------------------------------------------------
  const list1 = await call("GET", "/warehouse/items");
  const listed = (list1.data as any[]).find((i) => i.id === itemId);
  ok("lista: sourcesCount = 2", listed?.sourcesCount === 2, listed);
  ok(
    "lista: sourceShops z etykietami sklepów",
    JSON.stringify(listed?.sourceShops) === JSON.stringify(["Janex International", "SAMAL"]),
    listed?.sourceShops
  );
  ok("lista: manufacturerCode w wierszu", listed?.manufacturerCode === "TC-C320N", listed);

  // ------------------------------------------------------------------
  // 5. PUT /items — pełna podmiana zbioru źródeł
  // ------------------------------------------------------------------
  const putSet = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX}Kamera Tiandy`,
    sku: `${PREFIX}KAM-1`,
    unit: "szt",
    manufacturerCode: "TC-C320N",
    sources: [
      { shop: "samal.pl", shopLabel: "SAMAL", lastPriceNet: 47 },
      { shop: "eltrox.pl", shopLabel: "Eltrox", lastPriceNet: 52 },
    ],
  });
  ok("PUT /items z podmianą zbioru → 200", putSet.status === 200, putSet);
  const afterSet = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok(
    "podmiana zbioru: został samal + eltrox, janex usunięty",
    JSON.stringify(afterSet.data?.map((r: any) => r.shop)) === JSON.stringify(["eltrox.pl", "samal.pl"]),
    afterSet.data?.map((r: any) => r.shop)
  );
  const samalAfter = afterSet.data?.find((r: any) => r.shop === "samal.pl");
  ok("podmiana zbioru: samal to UPDATE, nie nowy wiersz", samalAfter?.id === src?.id, {
    got: samalAfter?.id,
    was: src?.id,
  });
  ok("podmiana zbioru: nowa cena samala", samalAfter?.lastPriceNet === 47, samalAfter);

  // PUT bez `sources` nie rusza źródeł (formularz, który ich nie doczytał).
  const putNoSources = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX}Kamera Tiandy 2`,
    sku: `${PREFIX}KAM-1`,
    unit: "szt",
  });
  ok("PUT /items bez `sources` → 200", putNoSources.status === 200, putNoSources);
  const afterNoSources = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("PUT bez `sources` nie rusza źródeł", afterNoSources.data?.length === 2, afterNoSources.data);

  // Pusta tablica = jawne „usuń wszystkie".
  const putEmpty = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX}Kamera Tiandy 2`,
    unit: "szt",
    sources: [],
  });
  ok("PUT /items z `sources: []` → 200", putEmpty.status === 200, putEmpty);
  const afterEmpty = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("`sources: []` usuwa wszystkie źródła", afterEmpty.data?.length === 0, afterEmpty.data);

  // ------------------------------------------------------------------
  // 6. DELETE źródła
  // ------------------------------------------------------------------
  const reAdd = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    shopLabel: "SAMAL",
    lastPriceNet: 48.8,
  });
  const delOk = await call("DELETE", `/warehouse/items/${itemId}/sources/${reAdd.data?.id}`);
  ok("DELETE źródła → 200", delOk.status === 200, delOk);
  const afterDel = await call("GET", `/warehouse/items/${itemId}/sources`);
  ok("DELETE faktycznie usuwa wiersz", afterDel.data?.length === 0, afterDel.data);
  const delAgain = await call("DELETE", `/warehouse/items/${itemId}/sources/${reAdd.data?.id}`);
  ok("DELETE tego samego źródła drugi raz → 404", delAgain.status === 404, delAgain);

  // Źródło CUDZEGO towaru — 404, a nie ciche usunięcie z obcej kartoteki.
  const other = await call("POST", "/warehouse/items", {
    name: `${PREFIX}Obcy towar`,
    unit: "szt",
    sources: [{ shop: "grodno.pl", shopLabel: "Grodno" }],
  });
  const otherSources = await call("GET", `/warehouse/items/${other.data?.id}/sources`);
  const foreignId = otherSources.data?.[0]?.id;
  const delForeign = await call("DELETE", `/warehouse/items/${itemId}/sources/${foreignId}`);
  ok("DELETE obcego źródła (inny towar) → 404", delForeign.status === 404, delForeign);
  const stillThere = await call("GET", `/warehouse/items/${other.data?.id}/sources`);
  ok("obce źródło nietknięte", stillThere.data?.length === 1, stillThere.data);

  // ------------------------------------------------------------------
  // 7. Kaskada FK przy FIZYCZNYM usunięciu towaru
  // ------------------------------------------------------------------
  const cascadeItem = await call("POST", "/warehouse/items", {
    name: `${PREFIX}Do kasacji`,
    unit: "szt",
    sources: [{ shop: "samal.pl" }, { shop: "eltrox.pl" }],
  });
  const cascadeId: number = cascadeItem.data?.id;
  db.delete(schema.warehouseItems).where(eq(schema.warehouseItems.id, cascadeId)).run();
  const orphans = db
    .select()
    .from(schema.warehouseItemSources)
    .where(eq(schema.warehouseItemSources.itemId, cascadeId))
    .all();
  ok("kaskada: fizyczne usunięcie towaru zabiera źródła", orphans.length === 0, orphans);
  const fkCheck = sqlite.pragma("foreign_key_check") as unknown[];
  ok("PRAGMA foreign_key_check bez naruszeń", fkCheck.length === 0, fkCheck);

  // ------------------------------------------------------------------
  // 8. Walidacje
  // ------------------------------------------------------------------
  const badShop = await call("POST", "/warehouse/items", {
    name: `${PREFIX}Zły sklep`,
    unit: "szt",
    sources: [{ shop: "NIE JEST DOMENĄ" }],
  });
  ok("walidacja: zła domena sklepu → 400", badShop.status === 400, badShop);

  const badShopPut = await call("PUT", `/warehouse/items/${itemId}/sources/nie%20domena`, {});
  ok("walidacja: zła domena w adresie PUT → 400", badShopPut.status === 400, badShopPut);

  const badMoney = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    lastPriceNet: "48,80 PLN",
  });
  ok('walidacja: „48,80 PLN" jako cena → 400', badMoney.status === 400, badMoney);

  const badStock = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    lastStock: -1,
  });
  ok("walidacja: ujemny stan → 400", badStock.status === 400, badStock);

  const badLogged = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    loggedIn: "tak",
  });
  ok("walidacja: loggedIn nie-boolean → 400", badLogged.status === 400, badLogged);

  const badCurrency = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    currency: "złoty",
  });
  ok("walidacja: zła waluta → 400", badCurrency.status === 400, badCurrency);

  const bigRaw = await call("PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {
    raw: { blob: "x".repeat(70 * 1024) },
  });
  ok("walidacja: rawJson > 64 KB → 400", bigRaw.status === 400, bigRaw);

  const dupShop = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX}Kamera Tiandy 2`,
    unit: "szt",
    sources: [{ shop: "samal.pl" }, { shop: "www.samal.pl" }],
  });
  ok("walidacja: powtórzony sklep w `sources` → 400", dupShop.status === 400, dupShop);

  const sourcesNotArray = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX}Kamera Tiandy 2`,
    unit: "szt",
    sources: { shop: "samal.pl" },
  });
  ok("walidacja: `sources` nie-tablica → 400", sourcesNotArray.status === 400, sourcesNotArray);

  const missingItem = await call("GET", "/warehouse/items/99999999/sources");
  ok("GET sources nieistniejącego towaru → 404", missingItem.status === 404, missingItem);
  const putMissingItem = await call("PUT", "/warehouse/items/99999999/sources/samal.pl", {});
  ok("PUT sources nieistniejącego towaru → 404", putMissingItem.status === 404, putMissingItem);

  // ------------------------------------------------------------------
  // 9. Uprawnienia (klucz technical/magazyn)
  // ------------------------------------------------------------------
  const viewGet = await callOn(asViewer, "GET", `/warehouse/items/${itemId}/sources`);
  ok('perm „view": GET sources → 200', viewGet.status === 200, viewGet);
  const viewPut = await callOn(asViewer, "PUT", `/warehouse/items/${itemId}/sources/samal.pl`, {});
  ok('perm „view": PUT sources → 403', viewPut.status === 403, viewPut);
  const viewParse = await postFile(asViewer, "/warehouse/import/parse?fetchImage=0", {
    name: "x.html",
    type: "text/html",
    data: Buffer.from("<html></html>"),
  });
  ok('perm „view": POST import/parse → 403', viewParse.status === 403, viewParse);
  const strangerGet = await callOn(asStranger, "GET", `/warehouse/items/${itemId}/sources`);
  ok("perm: brak klucza magazynu → 403", strangerGet.status === 403, strangerGet);

  // ------------------------------------------------------------------
  // 10. POST /warehouse/import/parse
  // ------------------------------------------------------------------
  if (!existsSync(FIXTURE)) {
    ok(`fikstura ${FIXTURE} istnieje`, false, FIXTURE);
  } else {
    const html = readFileSync(FIXTURE);
    const parse = await postFile(asEditor, "/warehouse/import/parse?fetchImage=0", {
      name: "samal-tc-c320n.html",
      type: "text/html",
      data: html,
    });
    ok("POST import/parse (multipart) → 200", parse.status === 200, {
      status: parse.status,
      error: parse.error,
    });
    const d = parse.data ?? {};
    ok(
      "import/parse: kształt odpowiedzi (parsed/suggestedItem/suggestedSource/matches/photoData/photoWarning)",
      ["parsed", "suggestedItem", "suggestedSource", "matches", "photoData", "photoWarning"].every(
        (k) => k in d
      ),
      Object.keys(d)
    );
    ok("import/parse: `?fetchImage=0` nie pobiera zdjęcia", d.photoData === null && d.photoWarning === null, {
      photoData: d.photoData,
      photoWarning: d.photoWarning,
    });
    ok("import/parse: matches jest tablicą", Array.isArray(d.matches), d.matches);
    ok(
      "import/parse: diagnostyka niesie parser i rozmiar HTML",
      typeof d.parsed?.diagnostics?.parserUsed === "string" && d.parsed?.diagnostics?.htmlBytes > 0,
      d.parsed?.diagnostics
    );

    // Czy biblioteka parserów to jeszcze stub agenta A2.
    const isStub = d.parsed?.diagnostics?.parserVersion === "stub";
    const why = "biblioteka parserów A2 to jeszcze stub";

    if (isStub) {
      skip("import/parse: SAMAL — kod dostawcy 127117", why);
      skip("import/parse: SAMAL — cena zakupu 48,80", why);
      skip("import/parse: SAMAL — sklep samal.pl", why);
    } else {
      ok("import/parse: SAMAL — kod dostawcy 127117", d.parsed?.supplierCode === "127117", d.parsed?.supplierCode);
      ok(
        "import/parse: SAMAL — cena zakupu 48,80",
        d.suggestedItem?.purchasePrice === 48.8,
        d.suggestedItem?.purchasePrice
      );
      ok("import/parse: SAMAL — sklep samal.pl", d.parsed?.shop === "samal.pl", d.parsed?.shop);
    }

    // JSON {html, url} — droga pluginu przeglądarki.
    const parseJson = await call("POST", "/warehouse/import/parse?fetchImage=0", {
      html: html.toString("utf8"),
      url: "https://samal.pl/produkt/tc-c320n-test",
    });
    ok("POST import/parse (JSON {html}) → 200", parseJson.status === 200, {
      status: parseJson.status,
      error: parseJson.error,
    });
    ok(
      "import/parse (JSON): `url` z ciała trafia do parsed.url",
      typeof parseJson.data?.parsed?.url === "string" && parseJson.data.parsed.url.includes("tc-c320n"),
      parseJson.data?.parsed?.url
    );

    // matches: „source" — sklep + adres strony wzięte Z ODPOWIEDZI parsera,
    // dzięki czemu test działa i na stubie, i na prawdziwym parserze.
    const pShop = parseJson.data?.parsed?.shop;
    const pUrl = parseJson.data?.parsed?.url;
    if (typeof pShop === "string" && pShop && typeof pUrl === "string" && pUrl) {
      const matchItem = await call("POST", "/warehouse/items", {
        name: `${PREFIX}Dopasowanie po źródle`,
        unit: "szt",
        sources: [{ shop: pShop, productUrl: pUrl, supplierCode: parseJson.data?.parsed?.supplierCode }],
      });
      const again = await call("POST", "/warehouse/import/parse?fetchImage=0", {
        html: html.toString("utf8"),
        url: pUrl,
      });
      const m = (again.data?.matches as any[]) ?? [];
      const bySource = m.find((x) => x.id === matchItem.data?.id && x.reason === "source");
      ok("import/parse: matches zawiera dopasowanie po źródle", !!bySource, m);
      ok("import/parse: match po źródle ma confidence „exact”", bySource?.confidence === "exact", bySource);
      ok(
        "import/parse: match niesie dane do boxu „towar już istnieje”",
        !!bySource && ["id", "name", "sku", "isArchived", "reason", "confidence"].every((k) => k in bySource),
        bySource && Object.keys(bySource)
      );
    } else {
      skip("import/parse: matches po źródle", "parser nie zwrócił sklepu ani adresu");
    }

    // matches: „ean" — wymaga, żeby parser wyciągnął EAN ze strony.
    const pEan = parseJson.data?.parsed?.ean;
    if (typeof pEan === "string" && pEan) {
      const eanItem = await call("POST", "/warehouse/items", {
        name: `${PREFIX}Dopasowanie po EAN`,
        unit: "szt",
        barcode: pEan,
      });
      const againEan = await call("POST", "/warehouse/import/parse?fetchImage=0", {
        html: html.toString("utf8"),
      });
      const m2 = (againEan.data?.matches as any[]) ?? [];
      ok(
        "import/parse: matches zawiera dopasowanie po EAN",
        m2.some((x) => x.id === eanItem.data?.id && x.reason === "ean"),
        m2
      );
    } else {
      skip("import/parse: matches po EAN", why);
    }
  }

  // Zły typ pliku i brak pliku.
  const txt = await postFile(asEditor, "/warehouse/import/parse?fetchImage=0", {
    name: "produkt.txt",
    type: "text/plain",
    data: Buffer.from("to nie jest strona"),
  });
  ok("import/parse: plik .txt → 400", txt.status === 400, txt);
  const noFile = await asEditor.request("/warehouse/import/parse?fetchImage=0", {
    method: "POST",
    body: new FormData(),
  });
  ok("import/parse: brak pliku → 400", noFile.status === 400, await noFile.json().catch(() => null));
  const emptyJson = await call("POST", "/warehouse/import/parse?fetchImage=0", { url: "https://samal.pl" });
  ok("import/parse: JSON bez `html` → 400", emptyJson.status === 400, emptyJson);

  // ------------------------------------------------------------------
  // Miniatura zdjęcia jako surowe bajty (GET /items/:id/photo/raw)
  //
  // Ta trasa istnieje dla `<img src>` w liście towarów, więc testujemy
  // dokładnie to, na czym przeglądarce zależy: typ zawartości, ETag i 304.
  // ------------------------------------------------------------------
  const png = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
  const photoItem = await call("POST", "/warehouse/items", {
    name: `${PREFIX}Towar ze zdjęciem`,
    unit: "szt",
    photoData: `data:image/png;base64,${png.toString("base64")}`,
  });
  const photoId: number = photoItem.data?.id;
  ok("POST /items ze zdjęciem → 201", photoItem.status === 201, photoItem);

  const thumb = await asEditor.request(`/warehouse/items/${photoId}/photo/raw?size=thumb`);
  const thumbBody = Buffer.from(await thumb.arrayBuffer());
  ok(
    "photo/raw?size=thumb → 200 z obrazem",
    thumb.status === 200 &&
      (thumb.headers.get("content-type") ?? "").startsWith("image/") &&
      thumbBody.length > 0,
    { status: thumb.status, type: thumb.headers.get("content-type"), bytes: thumbBody.length }
  );
  // 96×96 po `fit: "cover"` — miniatura ma być miniaturą, nie oryginałem.
  const thumbMeta = await sharp(thumbBody).metadata();
  ok(
    "photo/raw?size=thumb daje 96×96 JPEG",
    thumbMeta.width === 96 && thumbMeta.height === 96 && thumbMeta.format === "jpeg",
    thumbMeta
  );
  const etag = thumb.headers.get("etag");
  ok("photo/raw ustawia ETag i prywatny cache", !!etag && (thumb.headers.get("cache-control") ?? "").includes("private"), {
    etag,
    cache: thumb.headers.get("cache-control"),
  });

  const notModified = await asEditor.request(`/warehouse/items/${photoId}/photo/raw?size=thumb`, {
    headers: { "If-None-Match": etag ?? "" },
  });
  ok(
    "photo/raw z If-None-Match → 304 bez treści",
    notModified.status === 304 && notModified.headers.get("etag") === etag,
    { status: notModified.status, etag: notModified.headers.get("etag") }
  );

  const full = await asEditor.request(`/warehouse/items/${photoId}/photo/raw?size=full`);
  ok(
    "photo/raw?size=full oddaje oryginalne bajty i typ",
    full.status === 200 &&
      full.headers.get("content-type") === "image/png" &&
      Buffer.from(await full.arrayBuffer()).length === png.length,
    { status: full.status, type: full.headers.get("content-type") }
  );
  ok("photo/raw: pełne zdjęcie ma inny ETag niż miniatura", full.headers.get("etag") !== etag, {
    full: full.headers.get("etag"),
    thumb: etag,
  });

  const noPhoto = await asEditor.request(`/warehouse/items/${itemId}/photo/raw`);
  ok("photo/raw: towar bez zdjęcia → 404", noPhoto.status === 404, noPhoto.status);
  const noItem = await asEditor.request("/warehouse/items/999999999/photo/raw");
  ok("photo/raw: nieznany towar → 404", noItem.status === 404, noItem.status);
  const viewerThumb = await asViewer.request(`/warehouse/items/${photoId}/photo/raw?size=thumb`);
  ok("photo/raw: uprawnienie „view” wystarcza do odczytu", viewerThumb.status === 200, viewerThumb.status);
  const strangerThumb = await asStranger.request(`/warehouse/items/${photoId}/photo/raw?size=thumb`);
  ok("photo/raw: bez uprawnienia do magazynu → 403", strangerThumb.status === 403, strangerThumb.status);
} finally {
  cleanup();
  const left = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych towarów", left.length === 0, left);
  const leftSources = db
    .select()
    .from(schema.warehouseItemSources)
    .where(like(schema.warehouseItemSources.shopLabel, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak osieroconych źródeł", leftSources.length === 0, leftSources);
}

console.log(
  failures === 0
    ? `\nWszystkie testy OK${skipped ? ` (${skipped} pominięto)` : ""}`
    : `\n${failures} test(ów) nie przeszło${skipped ? ` (${skipped} pominięto)` : ""}`
);
process.exit(failures === 0 ? 0 : 1);
