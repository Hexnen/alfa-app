/**
 * Test stempli wieku ceny w kartotekach (magazyn + usługi), na prawdziwej
 * bazie (data/alfa.db), przez trasy Hono (app.request):
 *   npx tsx scripts/test-price-stamp.ts
 *
 * Sedno: `price_updated_at` ma mówić, kiedy ostatnio ZMIENIŁA SIĘ CENA, a nie
 * kiedy ktokolwiek dotknął rekordu. `updated_at` przestawia się przy poprawce
 * literówki w nazwie i przez to nie nadaje się na sygnał „cena przeterminowana"
 * — testy pilnują właśnie tej różnicy, w obie strony.
 *
 * Sprawdza dla obu katalogów: utworzenie stempluje cenę i `created_by`, edycja
 * SAMEJ NAZWY stempla nie rusza (ale zapisuje `updated_by`), zmiana ceny stempel
 * przestawia, a lista zwraca `createdByLabel`/`updatedByLabel` rozwiązane po
 * kartotece użytkowników (z surowym loginem jako fallbackiem).
 *
 * Sprząta po sobie HARD (prefiks __PSTAMP_TEST__), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { like } from "drizzle-orm";
import warehouse from "../src/routes/warehouse.js";
import services from "../src/routes/services.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__PSTAMP_TEST__";

/**
 * Udawany użytkownik z ISTNIEJĄCEGO konta — etykieta autora rozwiązuje się po
 * `users.email`, więc test na wymyślonym mailu sprawdzałby tylko fallback
 * i przegapiłby, gdyby rozwiązywanie nazw w ogóle przestało działać.
 */
const account = db
  .select({ email: schema.users.email, displayName: schema.users.displayName })
  .from(schema.users)
  .all()[0];

function userWith(email: string, permissions: Record<string, "view" | "edit">): User {
  return {
    id: null,
    email,
    displayName: "Test",
    role: "user",
    permissions: JSON.stringify(permissions),
  } as unknown as User;
}

const PERMS = { "technical/magazyn": "edit", "technical/uslugi": "edit" } as const;

function appAs(user: User) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/warehouse", warehouse);
  a.route("/services", services);
  return a;
}

const app = appAs(userWith(account?.email ?? "test", { ...PERMS }));
/** Konto, którego nie ma w `users` — etykieta ma zostać surowym loginem. */
const appGhost = appAs(userWith(`${PREFIX}duch@example.com`, { ...PERMS }));

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
const call = (method: string, path: string, body?: unknown) => callOn(app, method, path, body);

function cleanup() {
  db.delete(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .run();
  db.delete(schema.services).where(like(schema.services.name, `${PREFIX}%`)).run();
}

/** Wiersz z listy (tam doklejane są etykiety autorów). */
async function itemFromList(name: string) {
  const r = await call("GET", "/warehouse/items?includeArchived=1");
  return (r.data as any[]).find((i) => i.name === name);
}
async function serviceFromList(name: string) {
  const r = await call("GET", "/services?includeInactive=1");
  return (r.data as any[]).find((s) => s.name === name);
}

/**
 * Stempel ma sekundową rozdzielczość (`datetime('now')`), więc dwa zapisy
 * w tej samej sekundzie dałyby identyczną wartość i test „stempel się
 * przestawił" przechodziłby przez przypadek. Czekamy na zmianę sekundy.
 */
async function tickSecond() {
  await new Promise((r) => setTimeout(r, 1100));
}

try {
  cleanup(); // resztki po przerwanym przebiegu

  ok("w bazie jest jakiekolwiek konto (do etykiet autorów)", !!account, account);

  // ===================================================================
  // MAGAZYN
  // ===================================================================
  const created = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Kamera`,
    unit: "szt",
    purchasePrice: 400,
  });
  ok("magazyn: towar z ceną utworzony", created.status === 201, created);
  ok(
    "magazyn: cena stempluje price_updated_at",
    typeof created.data?.priceUpdatedAt === "string" && created.data.priceUpdatedAt.length > 0,
    created.data
  );
  ok(
    "magazyn: created_by = login z sesji",
    created.data?.createdBy === (account?.email ?? "test"),
    created.data
  );
  ok("magazyn: nowy towar nie ma jeszcze updated_by", created.data?.updatedBy === null, created.data);
  const itemId: number = created.data.id;
  const stampAfterCreate: string = created.data.priceUpdatedAt;

  // Towar BEZ żadnej ceny nie może udawać świeżo wycenionego.
  const noPrice = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Bez ceny`,
    unit: "szt",
  });
  ok(
    "magazyn: towar bez ceny nie dostaje stempla",
    noPrice.data?.priceUpdatedAt === null,
    noPrice.data
  );

  // --- Edycja SAMEJ NAZWY -------------------------------------------------
  await tickSecond();
  const renamed = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX} Kamera kopułowa`,
    unit: "szt",
    purchasePrice: 400,
  });
  ok("magazyn: zmiana nazwy przyjęta", renamed.status === 200, renamed);
  ok(
    "magazyn: sama nazwa NIE rusza price_updated_at",
    renamed.data?.priceUpdatedAt === stampAfterCreate,
    { was: stampAfterCreate, now: renamed.data?.priceUpdatedAt }
  );
  ok(
    "magazyn: …ale updated_at owszem (to inny sygnał)",
    renamed.data?.updatedAt !== created.data?.updatedAt,
    { was: created.data?.updatedAt, now: renamed.data?.updatedAt }
  );
  ok(
    "magazyn: zmiana nazwy zapisuje updated_by",
    renamed.data?.updatedBy === (account?.email ?? "test"),
    renamed.data
  );

  // --- Zmiana ceny zakupu -------------------------------------------------
  await tickSecond();
  const repriced = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX} Kamera kopułowa`,
    unit: "szt",
    purchasePrice: 450,
  });
  ok(
    "magazyn: zmiana ceny zakupu przestawia price_updated_at",
    repriced.data?.priceUpdatedAt !== stampAfterCreate,
    { was: stampAfterCreate, now: repriced.data?.priceUpdatedAt }
  );
  const stampAfterRepricing: string = repriced.data.priceUpdatedAt;

  // Wpisanie ceny sprzedaży to też zmiana ceny.
  await tickSecond();
  const sale = await call("PUT", `/warehouse/items/${itemId}`, {
    name: `${PREFIX} Kamera kopułowa`,
    unit: "szt",
    purchasePrice: 450,
    salePrice: 600,
  });
  ok(
    "magazyn: zmiana ceny sprzedaży też przestawia stempel",
    sale.data?.priceUpdatedAt !== stampAfterRepricing,
    { was: stampAfterRepricing, now: sale.data?.priceUpdatedAt }
  );

  // NULL → 0 to zmiana ceny („za darmo" ≠ „nikt nie podał"), a nie brak zmiany.
  const freebie = await call("POST", "/warehouse/items", {
    name: `${PREFIX} Powierzony`,
    unit: "szt",
  });
  ok("magazyn: pozycja bez cen ma pusty stempel", freebie.data?.priceUpdatedAt === null, freebie.data);
  const zeroed = await call("PUT", `/warehouse/items/${freebie.data.id}`, {
    name: `${PREFIX} Powierzony`,
    unit: "szt",
    purchasePrice: 0,
  });
  ok(
    "magazyn: NULL → 0 liczy się jako zmiana ceny",
    typeof zeroed.data?.priceUpdatedAt === "string",
    zeroed.data
  );

  // --- Etykiety autorów na liście ----------------------------------------
  const listRow = await itemFromList(`${PREFIX} Kamera kopułowa`);
  ok(
    "magazyn: lista zwraca createdByLabel z kartoteki użytkowników",
    listRow?.createdByLabel === (account?.displayName || account?.email),
    listRow
  );
  ok(
    "magazyn: lista zwraca updatedByLabel",
    listRow?.updatedByLabel === (account?.displayName || account?.email),
    listRow
  );
  ok(
    "magazyn: lista niesie price_updated_at",
    listRow?.priceUpdatedAt === sale.data?.priceUpdatedAt,
    listRow
  );

  const ghost = await callOn(appGhost, "POST", "/warehouse/items", {
    name: `${PREFIX} Widmo`,
    unit: "szt",
    purchasePrice: 10,
  });
  ok("magazyn: zapis z konta spoza bazy przechodzi", ghost.status === 201, ghost);
  const ghostRow = await itemFromList(`${PREFIX} Widmo`);
  ok(
    "magazyn: nieznany login zostaje etykietą (lepszy ślad niż kreska)",
    ghostRow?.createdByLabel === `${PREFIX}duch@example.com`,
    ghostRow
  );

  // ===================================================================
  // USŁUGI (ten sam mechanizm, para cost/price zamiast jednej ceny)
  // ===================================================================
  const svc = await call("POST", "/services", {
    name: `${PREFIX} Montaż kamery`,
    unit: "szt",
    cost: 60,
    price: 150,
  });
  ok("usługi: pozycja utworzona", svc.status === 201, svc);
  ok(
    "usługi: utworzenie stempluje price_updated_at",
    typeof svc.data?.priceUpdatedAt === "string" && svc.data.priceUpdatedAt.length > 0,
    svc.data
  );
  ok(
    "usługi: created_by = login z sesji",
    svc.data?.createdBy === (account?.email ?? "test"),
    svc.data
  );
  const svcId: number = svc.data.id;
  const svcStamp: string = svc.data.priceUpdatedAt;

  await tickSecond();
  const svcRenamed = await call("PUT", `/services/${svcId}`, {
    name: `${PREFIX} Montaż kamery IP`,
    unit: "szt",
    cost: 60,
    price: 150,
  });
  ok(
    "usługi: sama nazwa NIE rusza price_updated_at",
    svcRenamed.data?.priceUpdatedAt === svcStamp,
    { was: svcStamp, now: svcRenamed.data?.priceUpdatedAt }
  );
  ok(
    "usługi: zmiana nazwy zapisuje updated_by",
    svcRenamed.data?.updatedBy === (account?.email ?? "test"),
    svcRenamed.data
  );

  await tickSecond();
  const svcCost = await call("PUT", `/services/${svcId}`, {
    name: `${PREFIX} Montaż kamery IP`,
    unit: "szt",
    cost: 80,
    price: 150,
  });
  ok(
    "usługi: zmiana kosztu własnego przestawia stempel",
    svcCost.data?.priceUpdatedAt !== svcStamp,
    { was: svcStamp, now: svcCost.data?.priceUpdatedAt }
  );
  const svcStamp2: string = svcCost.data.priceUpdatedAt;

  await tickSecond();
  const svcPrice = await call("PUT", `/services/${svcId}`, {
    name: `${PREFIX} Montaż kamery IP`,
    unit: "szt",
    cost: 80,
    price: 199,
  });
  ok(
    "usługi: zmiana ceny sprzedaży też przestawia stempel",
    svcPrice.data?.priceUpdatedAt !== svcStamp2,
    { was: svcStamp2, now: svcPrice.data?.priceUpdatedAt }
  );

  const svcRow = await serviceFromList(`${PREFIX} Montaż kamery IP`);
  ok(
    "usługi: lista zwraca createdByLabel",
    svcRow?.createdByLabel === (account?.displayName || account?.email),
    svcRow
  );
  ok(
    "usługi: lista niesie price_updated_at",
    svcRow?.priceUpdatedAt === svcPrice.data?.priceUpdatedAt,
    svcRow
  );
} finally {
  cleanup();

  const leftItems = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych towarów", leftItems.length === 0, leftItems);

  const leftSvc = db
    .select()
    .from(schema.services)
    .where(like(schema.services.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych usług", leftSvc.length === 0, leftSvc);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
