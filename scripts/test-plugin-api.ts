/**
 * Testy wtyczki magazynu: API tokenowe (/api/plugin/*), kolejka importów
 * i paczka ZIP — przez trasy Hono (app.request), na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-plugin-api.ts
 *
 * Sedno, którego pilnują te testy:
 *  · token wtyczki NIE jest obejściem uprawnień (brak „technical/magazyn" → 403,
 *    sam „view" → odczyt tak, import nie) i nie jest sesją (zły token → 401);
 *  · `lookup` odpowiada „czy już to mamy" po ZNORMALIZOWANYM adresie, więc
 *    http/https, „www.", kotwica i końcowy ukośnik to jeden produkt;
 *  · `import` zawsze ląduje w kolejce (także w trybie „open"), dedupuje po
 *    adresie, wycina `accountLabel` i nie trzyma zdjęcia dwa razy;
 *  · wiersz kolejki odesłany do formularza ma DOKŁADNIE te same klucze co
 *    odpowiedź `POST /warehouse/import/parse` (plus `inboxId`, `matchItemId`) —
 *    to jest warunek tego, żeby formularz towaru miał jedną ścieżkę wypełniania;
 *  · paczka ZIP niesie podstawiony host (bez portu), wersję x.y.z i DZIAŁAJĄCY
 *    token, a rotacja/unieważnienie ubija stare paczki natychmiast.
 *
 * Zdjęcia świadomie nie pobieramy (`ALFA_SHOP_IMPORT_NO_FETCH=1`): fikstura ma
 * prawdziwy adres `og:image`, więc bez tego każdy przebieg strzelałby do sklepu.
 *
 * Sprząta po sobie HARD (prefiks __PLUGIN_TEST__) na wejściu i w finally —
 * także konta testowe, które sam zakłada.
 */
// MUSI stać przed pierwszym wywołaniem serwisu importu (czytany przy każdym parse).
process.env.ALFA_SHOP_IMPORT_NO_FETCH = "1";

import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import PizZip from "pizzip";
import { db, schema } from "../src/db/index.js";
import type { User } from "../src/db/schema.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import pluginRoutes from "../src/routes/plugin.js";
import warehousePluginRoutes from "../src/routes/warehouse-plugin.js";
import warehouseRoutes from "../src/routes/warehouse.js";
import { knownShops } from "../src/lib/shop-import/index.js";

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

const PREFIX = "__PLUGIN_TEST__";
const FIXTURE = "scripts/fixtures/shop-import/samal-tc-c320n.html";
/** Katalog na sztuczną paczkę wtyczki (agent paczki może jeszcze jej nie mieć). */
const TMP_DIR = join(
  process.env.SCRATCHPAD_DIR ?? "/tmp",
  `alfa-plugin-test-${process.pid}`,
  "extension"
);

function cleanup() {
  // Wiersze kolejki schodzą kaskadą razem z kontem (FK ON DELETE CASCADE).
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
  db.delete(schema.warehouseItems).where(like(schema.warehouseItems.name, `${PREFIX}%`)).run();
}
cleanup();

/**
 * Kolejka importów może mieć wiersze CUDZE (np. z pracy na bazie dev), a ten
 * skrypt biega na KOPII bazy — dlatego sprzątanie sprawdzamy względem stanu
 * wejściowego, a nie „tabela pusta".
 */
const inboxBaseline =
  db.select({ count: sql<number>`count(*)` }).from(schema.warehouseImportInbox).get()?.count ?? 0;

/** Konto testowe z jawnym tokenem wtyczki (hash hasła nieużywany — nie logujemy się). */
function makeUser(
  suffix: string,
  permissions: Record<string, "view" | "edit"> | null,
  withToken = true
): { user: User; token: string } {
  const token = randomBytes(32).toString("hex");
  const user = db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.test`,
      passwordHash: "x:x",
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions ?? {}),
      ...(withToken ? { pluginToken: token, pluginTokenCreatedAt: sql`(datetime('now'))` } : {}),
    })
    .returning()
    .get();
  return { user, token };
}

/** Aplikacja tokenowa — bez sesji, dokładnie jak montaż przed `requireAuth`. */
const pluginApp = new Hono();
pluginApp.route("/plugin", pluginRoutes);

/** Aplikacja sesyjna — z podstawionym userem i prawdziwym strażnikiem zakładek. */
function sessionApp(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/warehouse", warehousePluginRoutes);
  app.route("/warehouse", warehouseRoutes);
  return app;
}

type Res = { status: number; success?: boolean; data?: any; error?: string };

async function callToken(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<Res> {
  const res = await pluginApp.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

async function callSession(app: Hono, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

const editor = makeUser("edit", { "technical/magazyn": "edit" });
const viewer = makeUser("view", { "technical/magazyn": "view" });
const stranger = makeUser("none", { "technical/manuale": "edit" });
const rated = makeUser("rate", { "technical/magazyn": "edit" });
const other = makeUser("other", { "technical/magazyn": "edit" });
const asEditor = sessionApp(editor.user);
const asOther = sessionApp(other.user);

const html = existsSync(FIXTURE) ? readFileSync(FIXTURE, "utf8") : "";
const PRODUCT_URL = "https://samal.pl/produkt/__plugin-test__/tc-c320n";

try {
  if (!html) ok(`fikstura ${FIXTURE} istnieje`, false, FIXTURE);

  // ==================================================================
  // 1. UWIERZYTELNIENIE I UPRAWNIENIA
  // ==================================================================
  ok("auth: brak nagłówka → 401", (await callToken(null, "GET", "/plugin/me")).status === 401);
  ok(
    "auth: token za krótki → 401",
    (await callToken("krotki", "GET", "/plugin/me")).status === 401
  );
  ok(
    "auth: nieistniejący token o poprawnej długości → 401",
    (await callToken(randomBytes(32).toString("hex"), "GET", "/plugin/me")).status === 401
  );

  const me = await callToken(editor.token, "GET", "/plugin/me");
  ok("GET /plugin/me → 200", me.status === 200, me);
  ok(
    "me: kształt {user,canEdit,appVersion,baseUrl,queued}",
    ["user", "canEdit", "appVersion", "baseUrl", "queued"].every((k) => k in (me.data ?? {})) &&
      me.data?.user?.id === editor.user.id &&
      me.data?.canEdit === true,
    me.data
  );
  ok(
    "me: appVersion w formacie x.y.z",
    /^\d+\.\d+\.\d+/.test(String(me.data?.appVersion)),
    me.data?.appVersion
  );

  const meViewer = await callToken(viewer.token, "GET", "/plugin/me");
  ok("me (view): canEdit=false", meViewer.status === 200 && meViewer.data?.canEdit === false, meViewer);
  ok(
    "auth: bez klucza magazynu → 403",
    (await callToken(stranger.token, "GET", "/plugin/me")).status === 403
  );
  const viewImport = await callToken(viewer.token, "POST", "/plugin/import", {
    html: "<html><h1>x</h1></html>",
    url: PRODUCT_URL,
    mode: "queue",
  });
  ok("auth: „view” nie może importować → 403", viewImport.status === 403, viewImport);

  // Limit tempa: 60 odczytów na minutę na użytkownika (osobne konto, żeby nie
  // zjeść budżetu pozostałym testom).
  let rateHits = 0;
  let rateStatus = 200;
  for (let i = 0; i < 62 && rateStatus !== 429; i++) {
    rateStatus = (await callToken(rated.token, "GET", "/plugin/queue-count")).status;
    rateHits++;
  }
  ok("limit tempa: 429 po ~60 odczytach w minucie", rateStatus === 429 && rateHits > 55, {
    rateHits,
    rateStatus,
  });

  // ==================================================================
  // 2. LOOKUP („czy mamy ten towar")
  // ==================================================================
  const item = await callSession(asEditor, "POST", "/warehouse/items", {
    name: `${PREFIX}Kamera z wtyczki`,
    unit: "szt",
    purchasePrice: "48,80",
    sources: [{ shop: "samal.pl", productUrl: `${PRODUCT_URL}/`, supplierCode: "127117" }],
  });
  ok("przygotowanie: towar ze źródłem samal.pl", item.status === 201 || item.status === 200, item);
  const itemId = item.data?.id as number;

  const lookupHit = await callToken(
    editor.token,
    "GET",
    `/plugin/lookup?url=${encodeURIComponent(PRODUCT_URL)}`
  );
  ok("lookup: 200", lookupHit.status === 200, lookupHit);
  ok(
    "lookup: kształt {shop,shopLabel,parser,supported,calibrated,found,item,queued}",
    ["shop", "shopLabel", "parser", "supported", "calibrated", "found", "item", "queued"].every(
      (k) => k in (lookupHit.data ?? {})
    ),
    Object.keys(lookupHit.data ?? {})
  );
  ok(
    "lookup: SAMAL ma parser dedykowany i skalibrowany",
    lookupHit.data?.parser === "samal" &&
      lookupHit.data?.supported === true &&
      lookupHit.data?.calibrated === true,
    lookupHit.data
  );
  ok(
    "lookup: znajduje towar po adresie (bez końcowego ukośnika)",
    lookupHit.data?.found === true && lookupHit.data?.item?.id === itemId,
    lookupHit.data?.item
  );
  ok(
    "lookup: item niesie {id,name,sku,purchasePrice,priceUpdatedAt,lastPriceNet,fetchedAt,isArchived}",
    [
      "id",
      "name",
      "sku",
      "purchasePrice",
      "priceUpdatedAt",
      "lastPriceNet",
      "fetchedAt",
      "isArchived",
    ].every((k) => k in (lookupHit.data?.item ?? {})),
    lookupHit.data?.item
  );

  for (const [label, variant] of [
    ["http:// zamiast https://", PRODUCT_URL.replace("https://", "http://")],
    ["„www.” z przodu", PRODUCT_URL.replace("https://", "https://www.")],
    ["kotwica #opis", `${PRODUCT_URL}#opis`],
    ["podwójny ukośnik na końcu", `${PRODUCT_URL}//`],
  ] as const) {
    const r = await callToken(editor.token, "GET", `/plugin/lookup?url=${encodeURIComponent(variant)}`);
    ok(`lookup: normalizacja adresu — ${label}`, r.data?.found === true && r.data?.item?.id === itemId, r.data);
  }

  const lookupMiss = await callToken(
    editor.token,
    "GET",
    `/plugin/lookup?url=${encodeURIComponent("https://samal.pl/produkt/__plugin-test__/inny")}`
  );
  ok(
    "lookup: inny produkt tego sklepu → found=false",
    lookupMiss.data?.found === false && lookupMiss.data?.item === null,
    lookupMiss.data
  );

  const lookupUnknown = await callToken(
    editor.token,
    "GET",
    `/plugin/lookup?url=${encodeURIComponent("https://sklep-nieznany.example/p/1")}`
  );
  ok(
    "lookup: nieznany host → parser ogólny, supported=false",
    lookupUnknown.data?.parser === "generic" &&
      lookupUnknown.data?.supported === false &&
      lookupUnknown.data?.calibrated === false &&
      lookupUnknown.data?.found === false,
    lookupUnknown.data
  );
  ok(
    "lookup: brak ?url → 400",
    (await callToken(editor.token, "GET", "/plugin/lookup")).status === 400
  );

  // ==================================================================
  // 3. IMPORT Z WTYCZKI
  // ==================================================================
  ok(
    "import: pusty html → 400",
    (await callToken(editor.token, "POST", "/plugin/import", { html: "", url: PRODUCT_URL, mode: "queue" }))
      .status === 400
  );
  ok(
    "import: nieznany tryb → 400",
    (
      await callToken(editor.token, "POST", "/plugin/import", {
        html: "<html></html>",
        url: PRODUCT_URL,
        mode: "sideways",
      })
    ).status === 400
  );

  let importedId = 0;
  if (html) {
    const imp = await callToken(editor.token, "POST", "/plugin/import", {
      html,
      url: PRODUCT_URL,
      title: `${PREFIX}Karta produktu`,
      mode: "open",
    });
    ok("POST /plugin/import (mode=open) → 200", imp.status === 200, imp);
    ok(
      "import: kształt {id,shop,shopLabel,name,priceNet,parser,calibrated,matches,openUrl,queued,warnings}",
      [
        "id",
        "shop",
        "shopLabel",
        "name",
        "priceNet",
        "parser",
        "calibrated",
        "matches",
        "openUrl",
        "queued",
        "warnings",
      ].every((k) => k in (imp.data ?? {})),
      Object.keys(imp.data ?? {})
    );
    importedId = imp.data?.id as number;
    ok(
      "import: openUrl wskazuje zakładkę magazynu z parametrem ?import=",
      typeof imp.data?.openUrl === "string" &&
        imp.data.openUrl.endsWith(`/technical/magazyn?import=${importedId}`) &&
        /^https?:\/\//.test(imp.data.openUrl),
      imp.data?.openUrl
    );
    ok("import: queued ≥ 1", (imp.data?.queued ?? 0) >= 1, imp.data?.queued);
    ok(
      "import: parser SAMAL i cena 48,80 (ten sam serwis co import z pliku)",
      imp.data?.parser === "samal" && imp.data?.priceNet === 48.8,
      { parser: imp.data?.parser, priceNet: imp.data?.priceNet }
    );
    ok(
      "import: matches w postaci {itemId,name,reason,confidence}",
      Array.isArray(imp.data?.matches) &&
        imp.data.matches.length > 0 &&
        ["itemId", "name", "reason", "confidence"].every((k) => k in imp.data.matches[0]),
      imp.data?.matches
    );
    // Kod dostawcy z fikstury (127117) może mieć w prawdziwej kartotece własny
    // towar, więc sprawdzamy PRZYNALEŻNOŚĆ do zbioru dopasowań po źródle,
    // a nie kolejność.
    const sourceMatches = (imp.data?.matches as any[]).filter((m) => m.reason === "source");
    ok(
      "import: dopasowanie po źródle obejmuje towar z tym adresem",
      sourceMatches.some((m) => m.itemId === itemId),
      sourceMatches
    );

    const row = db
      .select()
      .from(schema.warehouseImportInbox)
      .where(eq(schema.warehouseImportInbox.id, importedId))
      .get();
    ok("import: wiersz kolejki w statusie queued, tryb open", row?.status === "queued" && row?.mode === "open", row && { status: row.status, mode: row.mode });
    ok(
      "import: match_item_id z PIERWSZEGO dopasowania po źródle",
      row?.matchItemId === sourceMatches[0]?.itemId,
      { matchItemId: row?.matchItemId, first: sourceMatches[0]?.itemId }
    );
    ok(
      "import: expires_at ~ +7 dni",
      !!row &&
        (() => {
          const days = (Date.parse(`${row.expiresAt.replace(" ", "T")}Z`) - Date.now()) / 86_400_000;
          return days > 6.9 && days < 7.1;
        })(),
      row?.expiresAt
    );

    const storedJson = JSON.parse(row?.parsedJson ?? "{}");
    ok(
      "import: parsed_json bez zdjęcia (te dane mają własne kolumny)",
      !("photoData" in storedJson) && !("photoWarning" in storedJson),
      Object.keys(storedJson)
    );
    // `accountLabel` (e-mail konta w sklepie) nie ma prawa wjechać do bazy.
    const parseForRef = await callSession(asEditor, "POST", "/warehouse/import/parse?fetchImage=0", {
      html,
      url: PRODUCT_URL,
    });
    if (parseForRef.data?.parsed?.accountLabel) {
      ok(
        "import: accountLabel wycięty z parsed_json (a parser go widział)",
        storedJson.parsed?.accountLabel === null,
        storedJson.parsed?.accountLabel
      );
    } else {
      ok(
        "import: accountLabel w parsed_json jest null",
        storedJson.parsed?.accountLabel === null,
        storedJson.parsed?.accountLabel
      );
      skip("import: accountLabel realnie wycięty", "fikstura nie zawiera e-maila konta");
    }

    // Dedup: ten sam adres w innym zapisie (z kotwicą) nadpisuje wiersz.
    const before = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.warehouseImportInbox)
      .get()?.count ?? 0;
    const dedup = await callToken(editor.token, "POST", "/plugin/import", {
      html,
      url: `${PRODUCT_URL}#opis`,
      mode: "queue",
    });
    const after = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.warehouseImportInbox)
      .get()?.count ?? 0;
    ok(
      "import: dedup po znormalizowanym adresie (ten sam wiersz, nowy tryb)",
      dedup.status === 200 && dedup.data?.id === importedId && after === before,
      { id: dedup.data?.id, importedId, before, after }
    );
    const afterDedup = db
      .select()
      .from(schema.warehouseImportInbox)
      .where(eq(schema.warehouseImportInbox.id, importedId))
      .get();
    ok("import: nadpisanie przestawia tryb na queue", afterDedup?.mode === "queue", afterDedup?.mode);

    // Kolejka innego użytkownika jest osobna.
    const otherImp = await callToken(other.token, "POST", "/plugin/import", {
      html,
      url: PRODUCT_URL,
      mode: "queue",
    });
    ok("import: drugi użytkownik dostaje własny wiersz", otherImp.data?.id !== importedId, {
      other: otherImp.data?.id,
      mine: importedId,
    });

    // ==================================================================
    // 4. KOLEJKA W PANELU (sesja)
    // ==================================================================
    const inbox = await callSession(asEditor, "GET", "/warehouse/import/inbox");
    ok("GET /warehouse/import/inbox → 200 i tablica", inbox.status === 200 && Array.isArray(inbox.data), inbox);
    const entry = (inbox.data as any[]).find((e) => e.id === importedId);
    ok(
      "inbox: wpis ma klucze PluginInboxEntry",
      !!entry &&
        [
          "id",
          "status",
          "mode",
          "shop",
          "shopLabel",
          "name",
          "pageTitle",
          "productUrl",
          "priceNet",
          "matchCount",
          "matchItemId",
          "hasPhoto",
          "createdAt",
          "expiresAt",
        ].every((k) => k in entry),
      entry && Object.keys(entry)
    );
    ok(
      "inbox: widzę tylko swoje wiersze",
      (inbox.data as any[]).every((e) => e.id !== otherImp.data?.id),
      inbox.data
    );
    const count = await callSession(asEditor, "GET", "/warehouse/import/inbox/count");
    ok("inbox/count: {queued} (trasa NIE wpada w /:id)", count.status === 200 && typeof count.data?.queued === "number", count);

    const detail = await callSession(asEditor, "GET", `/warehouse/import/inbox/${importedId}`);
    ok("GET inbox/:id → 200", detail.status === 200, detail);
    const parseKeys = Object.keys(parseForRef.data ?? {}).sort();
    const detailKeys = Object.keys(detail.data ?? {})
      .filter((k) => k !== "inboxId" && k !== "matchItemId")
      .sort();
    ok(
      "inbox/:id: klucze identyczne z /import/parse (+inboxId, matchItemId)",
      JSON.stringify(parseKeys) === JSON.stringify(detailKeys) &&
        detail.data?.inboxId === importedId,
      { parseKeys, detailKeys }
    );
    ok(
      "inbox/:id: klucze `parsed` identyczne z /import/parse",
      JSON.stringify(Object.keys(parseForRef.data?.parsed ?? {}).sort()) ===
        JSON.stringify(Object.keys(detail.data?.parsed ?? {}).sort()),
      Object.keys(detail.data?.parsed ?? {})
    );
    ok(
      "inbox/:id: odczyt przestawia status na opened",
      db
        .select({ status: schema.warehouseImportInbox.status })
        .from(schema.warehouseImportInbox)
        .where(eq(schema.warehouseImportInbox.id, importedId))
        .get()?.status === "opened",
      "status"
    );
    ok(
      "inbox/:id: cudzy wiersz → 404",
      (await callSession(asOther, "GET", `/warehouse/import/inbox/${importedId}`)).status === 404
    );
    ok(
      "inbox/:id: nieistniejący wiersz → 404",
      (await callSession(asEditor, "GET", "/warehouse/import/inbox/999999999")).status === 404
    );

    const done = await callSession(asEditor, "POST", `/warehouse/import/inbox/${importedId}/done`);
    ok("inbox/:id/done: status done", done.status === 200 && done.data?.status === "done", done);
    ok(
      "inbox: wiersz `done` wypada z listy",
      !((await callSession(asEditor, "GET", "/warehouse/import/inbox")).data as any[]).some(
        (e) => e.id === importedId
      )
    );
    ok(
      "inbox/:id/discard: cudzy wiersz → 404",
      (await callSession(asOther, "POST", `/warehouse/import/inbox/${importedId}/discard`)).status === 404
    );

    // Odrzucenie na drugim wierszu (własnym, świeżym).
    const second = await callToken(editor.token, "POST", "/plugin/import", {
      html,
      url: `${PRODUCT_URL}-2`,
      mode: "queue",
    });
    const disc = await callSession(asEditor, "POST", `/warehouse/import/inbox/${second.data?.id}/discard`);
    ok("inbox/:id/discard: status discarded", disc.status === 200 && disc.data?.status === "discarded", disc);

    // Wygasanie: wiersz po terminie nie istnieje dla panelu i znika przy imporcie.
    const third = await callToken(editor.token, "POST", "/plugin/import", {
      html,
      url: `${PRODUCT_URL}-3`,
      mode: "queue",
    });
    const thirdId = third.data?.id as number;
    db.update(schema.warehouseImportInbox)
      .set({ expiresAt: sql`(datetime('now','-1 day'))` })
      .where(eq(schema.warehouseImportInbox.id, thirdId))
      .run();
    ok(
      "wygasanie: wiersz po terminie → 404 i brak w liście",
      (await callSession(asEditor, "GET", `/warehouse/import/inbox/${thirdId}`)).status === 404 &&
        !((await callSession(asEditor, "GET", "/warehouse/import/inbox")).data as any[]).some(
          (e) => e.id === thirdId
        )
    );
    await callToken(editor.token, "POST", "/plugin/import", {
      html,
      url: `${PRODUCT_URL}-4`,
      mode: "queue",
    });
    ok(
      "wygasanie: kolejny import czyści wiersze po terminie",
      !db
        .select({ id: schema.warehouseImportInbox.id })
        .from(schema.warehouseImportInbox)
        .where(eq(schema.warehouseImportInbox.id, thirdId))
        .get()
    );
  } else {
    skip("import/kolejka", "brak fikstury SAMAL");
  }

  // ==================================================================
  // 5. TOKEN W PANELU
  // ==================================================================
  const tokenInfo = await callSession(asEditor, "GET", "/warehouse/plugin/token");
  ok(
    "GET /warehouse/plugin/token: {hasToken,masked,createdAt,baseUrl}",
    tokenInfo.status === 200 &&
      tokenInfo.data?.hasToken === true &&
      /^.{4}….{4}$/.test(String(tokenInfo.data?.masked)) &&
      typeof tokenInfo.data?.baseUrl === "string" &&
      tokenInfo.data.baseUrl.length > 0,
    tokenInfo.data
  );
  ok(
    "token: pełny sekret NIE wraca do frontu",
    !JSON.stringify(tokenInfo.data).includes(editor.token),
    tokenInfo.data
  );

  const shops = await callSession(asEditor, "GET", "/warehouse/plugin/shops");
  ok(
    "GET /warehouse/plugin/shops: lista z flagą calibrated",
    shops.status === 200 &&
      Array.isArray(shops.data) &&
      shops.data.length === knownShops().length &&
      shops.data.every((s: any) => ["shop", "label", "parser", "calibrated"].every((k) => k in s)),
    shops.data
  );
  ok(
    "shops: samal i janex oznaczone jako skalibrowane, reszta nie",
    (shops.data as any[]).filter((s) => s.calibrated).map((s) => s.parser).sort().join(",") ===
      "janex,samal",
    shops.data
  );

  // ==================================================================
  // 6. PACZKA ZIP
  // ==================================================================
  // Katalog `extension/` powstaje u drugiego agenta — do testu składamy
  // minimalną paczkę o tej samej liście plików.
  const realDir = existsSync(join("extension", "manifest.json")) ? "extension" : null;
  if (!realDir) {
    mkdirSync(join(TMP_DIR, "icons"), { recursive: true });
    writeFileSync(
      join(TMP_DIR, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: 3,
          name: "Alfa — magazyn",
          version: "__ALFA_VERSION__",
          permissions: ["tabs", "storage", "activeTab"],
          host_permissions: ["__ALFA_MATCH__", "https://*.samal.pl/*"],
          background: { service_worker: "background.js" },
        },
        null,
        2
      )
    );
    for (const f of ["background.js", "content-shop.js", "content-app.js", "shops.js", "options.js"]) {
      writeFileSync(join(TMP_DIR, f), `// ${f} (atrapa testowa)\n`);
    }
    writeFileSync(join(TMP_DIR, "options.html"), "<!doctype html><title>Ąćę</title>\n");
    // Najmniejszy poprawny PNG (1×1, przezroczysty) — atrapa ikony.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAX+ChlwAAAABJRU5ErkJggg==",
      "base64"
    );
    for (const f of ["icon16.png", "icon48.png", "icon128.png"]) {
      writeFileSync(join(TMP_DIR, "icons", f), png);
    }
    process.env.ALFA_EXTENSION_DIR = TMP_DIR;
  } else {
    delete process.env.ALFA_EXTENSION_DIR;
  }

  const zipRes = await asEditor.request("/warehouse/plugin/download", {
    headers: { origin: "https://alfa.example.test" },
  });
  ok("GET /warehouse/plugin/download → 200", zipRes.status === 200, zipRes.status);
  ok(
    "ZIP: content-type i nazwa pliku",
    zipRes.headers.get("content-type") === "application/zip" &&
      (zipRes.headers.get("content-disposition") ?? "").includes("alfa-magazyn-wtyczka.zip") &&
      zipRes.headers.get("cache-control") === "private, no-store",
    {
      type: zipRes.headers.get("content-type"),
      disposition: zipRes.headers.get("content-disposition"),
      cache: zipRes.headers.get("cache-control"),
    }
  );

  const zip = new PizZip(Buffer.from(await zipRes.arrayBuffer()));
  const names = Object.keys(zip.files).sort();
  ok(
    "ZIP: zawiera config.js i pliki paczki",
    ["config.js", "manifest.json", "background.js", "icons/icon128.png"].every((n) =>
      names.includes(n)
    ),
    names
  );

  const manifestText = zip.file("manifest.json")?.asText() ?? "";
  const manifest = JSON.parse(manifestText || "{}");
  ok("ZIP: manifest bez placeholdera __ALFA_MATCH__", !manifestText.includes("__ALFA_MATCH__"), manifestText.slice(0, 200));
  ok(
    "ZIP: manifest ma wersję x.y.z",
    /^\d+\.\d+\.\d+$/.test(String(manifest.version)),
    manifest.version
  );
  ok(
    "ZIP: wzorzec hosta aplikacji bez portu",
    Array.isArray(manifest.host_permissions) &&
      manifest.host_permissions.includes("https://alfa.example.test/*"),
    manifest.host_permissions
  );

  const configText = zip.file("config.js")?.asText() ?? "";
  ok(
    "ZIP: config.js z baseUrl, apiBase, wersją i kontem",
    configText.includes('baseUrl: "https://alfa.example.test"') &&
      configText.includes('apiBase: "https://alfa.example.test/api"') &&
      configText.includes(`user: "${editor.user.email}"`),
    configText
  );
  /*
   * Panel pokazuje użytkownikowi, DLA JAKIEGO adresu jest paczka („Paczka dla:
   * https://…”), a bierze go z `GET /warehouse/plugin/token`. Gdyby te dwie
   * wartości się rozjechały, ktoś z osobnym devem i produkcją wczytałby
   * wtyczkę wskazującą na drugie środowisko i nie miałby jak tego zauważyć —
   * dlatego jedno wyrażenie (`pluginBaseUrl`) i ta asercja.
   */
  const zipBaseUrl = /baseUrl:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
  // Ten sam nagłówek `origin` co przy pobieraniu ZIP-a — `resolveBaseUrl` czyta
  // właśnie nagłówki żądania, więc porównanie z odpowiedzią bez nich mówiłoby
  // tylko tyle, że dwa RÓŻNE żądania widzą różny adres.
  const panelBaseUrl = (await (
    await asEditor.request("/warehouse/plugin/token", {
      headers: { origin: "https://alfa.example.test" },
    })
  ).json()) as { data?: { baseUrl?: string } };
  ok(
    "ZIP: baseUrl z config.js == baseUrl z GET /warehouse/plugin/token",
    zipBaseUrl.length > 0 && zipBaseUrl === panelBaseUrl.data?.baseUrl,
    { zip: zipBaseUrl, panel: panelBaseUrl.data?.baseUrl }
  );

  const zipToken = /token:\s*"([0-9a-f]{64})"/.exec(configText)?.[1] ?? "";
  ok("ZIP: config.js niesie pełny token (64 znaki hex)", zipToken.length === 64, zipToken.length);
  const meFromZip = await callToken(zipToken, "GET", "/plugin/me");
  ok(
    "ZIP: token z config.js działa na /plugin/me i wskazuje właściciela paczki",
    meFromZip.status === 200 && meFromZip.data?.user?.id === editor.user.id,
    meFromZip
  );
  /*
   * `build` to skrót plików paczki — wtyczka porównuje go z `pluginBuild`
   * z API i mówi „masz starą paczkę, pobierz nową”. Cała ta informacja jest
   * bezwartościowa, jeśli obie strony liczą skrót z czego innego, dlatego
   * asercja pilnuje, że ZIP i `/plugin/me` mówią JEDNĄ liczbą.
   */
  const zipBuild = /build:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
  ok(
    "ZIP: build z config.js == pluginBuild z GET /plugin/me",
    zipBuild.length > 0 && zipBuild === meFromZip.data?.pluginBuild,
    { zip: zipBuild, me: meFromZip.data?.pluginBuild }
  );

  // Konto bez tokenu dostaje go przy PIERWSZYM pobraniu paczki.
  const fresh = makeUser("fresh", { "technical/magazyn": "edit" }, false);
  const asFresh = sessionApp(fresh.user);
  ok(
    "token: nowe konto nie ma tokenu przed pobraniem paczki",
    (await callSession(asFresh, "GET", "/warehouse/plugin/token")).data?.hasToken === false
  );
  const freshZip = await asFresh.request("/warehouse/plugin/download", {
    headers: { origin: "https://alfa.example.test" },
  });
  ok("token: pobranie paczki wydaje token", freshZip.status === 200, freshZip.status);
  ok(
    "token: po pobraniu panel widzi token",
    (await callSession(asFresh, "GET", "/warehouse/plugin/token")).data?.hasToken === true
  );

  // ==================================================================
  // 7. ROTACJA I UNIEWAŻNIENIE
  // ==================================================================
  const rotate = await callSession(asEditor, "POST", "/warehouse/plugin/token/rotate");
  ok("rotate: 200 i nowa maska", rotate.status === 200 && rotate.data?.hasToken === true, rotate);
  ok(
    "rotate: stary token przestaje działać",
    (await callToken(editor.token, "GET", "/plugin/me")).status === 401
  );
  const rotated =
    db
      .select({ token: schema.users.pluginToken })
      .from(schema.users)
      .where(eq(schema.users.id, editor.user.id))
      .get()?.token ?? "";
  ok(
    "rotate: nowy token działa",
    (await callToken(rotated, "GET", "/plugin/me")).status === 200,
    rotated.slice(0, 6)
  );
  const revoke = await callSession(asEditor, "DELETE", "/warehouse/plugin/token");
  ok("revoke: 200 i hasToken=false", revoke.status === 200 && revoke.data?.hasToken === false, revoke);
  ok(
    "revoke: token przestaje działać",
    (await callToken(rotated, "GET", "/plugin/me")).status === 401
  );

  // ==================================================================
  // 8. PARZYSTOŚĆ REJESTRU SKLEPÓW
  // ==================================================================
  if (!realDir) {
    skip("parzystość knownShops() ↔ extension/shops.js ↔ manifest.json", "katalog extension/ jeszcze nie istnieje");
  } else {
    const shopsJs = readFileSync(join("extension", "shops.js"), "utf8");
    const extManifest = readFileSync(join("extension", "manifest.json"), "utf8");
    const missingInJs = knownShops().filter((s) => !shopsJs.includes(s.shop));
    const missingInManifest = knownShops().filter((s) => !extManifest.includes(s.shop));
    ok("parzystość: każdy sklep z rejestru jest w extension/shops.js", missingInJs.length === 0, missingInJs);
    ok(
      "parzystość: każdy sklep z rejestru jest w host_permissions manifestu",
      missingInManifest.length === 0,
      missingInManifest
    );
  }
} finally {
  cleanup();
  const leftUsers = db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all();
  ok("sprzątanie: brak kont testowych", leftUsers.length === 0, leftUsers.length);
  const leftItems = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych towarów", leftItems.length === 0, leftItems.length);
  const leftInbox = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.warehouseImportInbox)
    .get();
  ok(
    "sprzątanie: kolejka bez wierszy testowych (kaskada po kontach)",
    (leftInbox?.count ?? 0) === inboxBaseline,
    { left: leftInbox?.count ?? 0, baseline: inboxBaseline }
  );
}

console.log(
  failures === 0
    ? `\nWszystkie testy OK${skipped ? ` (${skipped} pominięto)` : ""}`
    : `\n${failures} test(ów) nie przeszło${skipped ? ` (${skipped} pominięto)` : ""}`
);
process.exit(failures === 0 ? 0 : 1);
