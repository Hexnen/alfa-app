/**
 * Test katalogu usług (tabela `services`) na prawdziwej bazie (data/alfa.db),
 * przez trasy Hono (app.request):
 *   npx tsx scripts/test-services.ts
 *
 * Sprawdza: CRUD, walidację nazwy i kwot, domyślne wartości kategorii/systemu,
 * filtry (kategoria, system, archiwum), marżę i narzut liczone przy odczycie,
 * uczciwe `null` przy zerowym koszcie oraz archiwizację zamiast kasowania.
 *
 * Sprząta po sobie HARD (wszystko z prefiksem __SV_TEST__), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { like } from "drizzle-orm";
import services from "../src/routes/services.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__SV_TEST__";

/**
 * Aplikacja testowa z wstrzykniętym użytkownikiem — trasy czytają go przez
 * `getUser(c)`, a zapis w katalogu wymaga własnego uprawnienia `technical/uslugi`
 * (patrz `canWriteServices` w src/routes/services.ts).
 */
const realUserId = db.select({ id: schema.users.id }).from(schema.users).all()[0]?.id ?? null;
const userWith = (permissions: Record<string, "view" | "edit">) =>
  ({
    id: realUserId,
    email: "test@example.com",
    displayName: "Test",
    role: "user",
    permissions: JSON.stringify(permissions),
  }) as never;

function appAs(user: unknown) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  a.route("/services", services);
  return a;
}

const app = appAs(userWith({ "technical/uslugi": "edit" }));
/** Ktoś z samymi Ofertami: czyta katalog, ale nie może w nim pisać ani widzieć kosztów. */
const appOffersOnly = appAs(userWith({ "technical/oferty": "edit" }));

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
  db.delete(schema.services)
    .where(like(schema.services.name, `${PREFIX}%`))
    .run();
}

try {
  cleanup(); // resztki po przerwanym przebiegu

  // --- Tworzenie i wartości domyślne ---------------------------------------
  const created = await call("POST", "/services", {
    name: `${PREFIX} Montaż kamery`,
    category: "montaz",
    system: "cctv",
    unit: "szt",
    cost: 60,
    price: 150,
  });
  ok("tworzenie usługi", created.status === 201, created);
  ok("koszt własny zapisany", created.data?.cost === 60, created.data);
  ok("cena zapisana", created.data?.price === 150, created.data);
  ok("marża 60% (zysk 90 z ceny 150)", created.data?.marginPct === 60, created.data);
  ok("narzut 150% (zysk 90 od kosztu 60)", created.data?.markupPct === 150, created.data);
  const id: number = created.data.id;

  const minimal = await call("POST", "/services", { name: `${PREFIX} Minimalna` });
  ok("usługa z samą nazwą przechodzi", minimal.status === 201, minimal);
  ok("domyślna kategoria = montaz", minimal.data?.category === "montaz", minimal.data);
  ok("domyślna jednostka = szt", minimal.data?.unit === "szt", minimal.data);
  ok("brak systemu = null", minimal.data?.system === null, minimal.data);
  ok("domyślny koszt 0", minimal.data?.cost === 0, minimal.data);
  ok(
    "koszt 0 nie daje 100% marży, tylko null",
    minimal.data?.marginPct === null,
    minimal.data
  );

  // Nieznany system z brzegu (np. literówka) nie może wywalić zapisu.
  const badSystem = await call("POST", "/services", {
    name: `${PREFIX} Zły system`,
    system: "kosmos",
  });
  ok("nieznany system → null zamiast błędu", badSystem.data?.system === null, badSystem.data);

  // --- Walidacja ------------------------------------------------------------
  const noName = await call("POST", "/services", { name: "  " });
  ok("pusta nazwa odrzucona", noName.status === 400, noName);
  const negative = await call("POST", "/services", {
    name: `${PREFIX} Ujemna`,
    cost: -1,
  });
  ok("ujemny koszt odrzucony", negative.status === 400, negative);
  const comma = await call("POST", "/services", {
    name: `${PREFIX} Przecinek`,
    price: "99,99",
  });
  ok("cena z przecinkiem przyjęta", comma.data?.price === 99.99, comma.data);

  // --- Edycja ---------------------------------------------------------------
  const updated = await call("PUT", `/services/${id}`, {
    name: `${PREFIX} Montaż kamery`,
    category: "uruchomienie",
    system: "sswin",
    unit: "RBH",
    cost: 80,
    price: 200,
  });
  ok("edycja usługi", updated.status === 200, updated);
  ok("kategoria zmieniona", updated.data?.category === "uruchomienie", updated.data);
  ok("marża przeliczona po edycji = 60%", updated.data?.marginPct === 60, updated.data);

  const missing = await call("PUT", "/services/99999999", { name: "x" });
  ok("edycja nieistniejącej usługi → 404", missing.status === 404, missing);

  // --- Filtry ---------------------------------------------------------------
  const byCategory = await call("GET", "/services?category=uruchomienie");
  ok(
    "filtr po kategorii zwraca naszą pozycję",
    (byCategory.data as any[]).some((s) => s.id === id),
    byCategory.data?.length
  );
  const byOtherCategory = await call("GET", "/services?category=projekt");
  ok(
    "filtr po innej kategorii jej nie zwraca",
    !(byOtherCategory.data as any[]).some((s) => s.id === id),
    byOtherCategory.data?.length
  );
  const bySystem = await call("GET", "/services?system=sswin");
  ok(
    "filtr po systemie działa",
    (bySystem.data as any[]).some((s) => s.id === id),
    bySystem.data?.length
  );

  // --- Archiwizacja zamiast kasowania --------------------------------------
  const archived = await call("DELETE", `/services/${id}`);
  ok("archiwizacja zwraca 200", archived.status === 200, archived);

  const rowAfter = db
    .select()
    .from(schema.services)
    .where(like(schema.services.name, `${PREFIX} Montaż kamery`))
    .all();
  ok("wiersz NADAL istnieje w bazie", rowAfter.length === 1, rowAfter);
  ok("ale jest nieaktywny", rowAfter[0]?.active === false, rowAfter[0]);

  const active = await call("GET", "/services");
  ok(
    "domyślna lista pomija zarchiwizowane",
    !(active.data as any[]).some((s) => s.id === id),
    active.data?.length
  );
  const all = await call("GET", "/services?includeInactive=1");
  ok(
    "includeInactive=1 je pokazuje",
    (all.data as any[]).some((s) => s.id === id),
    all.data?.length
  );

  const deleteMissing = await call("DELETE", "/services/99999999");
  ok("archiwizacja nieistniejącej → 404", deleteMissing.status === 404, deleteMissing);

  // ===================================================================
  // REGRESJE Z BUGHUNTU (2026-08-31): katalog usług a uprawnienia
  // ===================================================================

  // Ktoś z samymi Ofertami CZYTA katalog (edytor potrzebuje robocizny)…
  const readAsOffers = await callOn(appOffersOnly, "GET", "/services");
  ok("z samymi Ofertami katalog jest czytelny", readAsOffers.status === 200, readAsOffers.status);
  const sample = (readAsOffers.data as any[])[0];
  ok("…ale bez kosztu własnego", sample?.cost === undefined, sample);
  ok("…bez marży", sample?.marginPct === undefined, sample);
  ok("…bez narzutu", sample?.markupPct === undefined, sample);
  ok("…za to z ceną sprzedaży", typeof sample?.price === "number", sample);

  // …i NIE MOŻE w nim pisać — stawki wchodzą w marżę każdej oferty.
  const writeAsOffers = await callOn(appOffersOnly, "POST", "/services", {
    name: `${PREFIX} Wstrzyknięta`, cost: 1, price: 2,
  });
  ok("zapis w katalogu z samymi Ofertami → 403", writeAsOffers.status === 403, writeAsOffers);
  const editAsOffers = await callOn(appOffersOnly, "PUT", `/services/${comma.data.id}`, {
    name: `${PREFIX} Podmieniona`, cost: 999, price: 1,
  });
  ok("edycja cudzej pozycji → 403", editAsOffers.status === 403, editAsOffers);
  const archiveAsOffers = await callOn(appOffersOnly, "DELETE", `/services/${comma.data.id}`);
  ok("archiwizacja z samymi Ofertami → 403", archiveAsOffers.status === 403, archiveAsOffers);
  const stillThere = db
    .select()
    .from(schema.services)
    .where(like(schema.services.name, `${PREFIX} Przecinek`))
    .all();
  ok("…a pozycja została nietknięta", stillThere[0]?.price === 99.99 && stillThere[0]?.active === true, stillThere[0]);
} finally {
  cleanup();

  const left = db
    .select()
    .from(schema.services)
    .where(like(schema.services.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych usług", left.length === 0, left);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
