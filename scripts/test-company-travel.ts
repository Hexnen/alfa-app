/**
 * Test trasy dojazdu w kalendarzu (GET /api/company/travel):
 *   npx tsx scripts/test-company-travel.ts
 *
 * Zakres: walidacja objectId (400), nieistniejący obiekt (404), tryb zbiorczy (?objectIds=…:
 * jedno zapytanie na wiele obiektów, limit, nieznane id), odpowiedź z cache'u bez
 * ruchu sieciowego, cache miss → 200 z `pending: true` i przybliżeniem linią prostą
 * (zamiast wieszania dialogu na throttlowanym OSRM), tryb „ręcznie” i obiekt bez adresu
 * jako `data.error` przy statusie 200, oraz regresja: odpowiedź NIE wystawia danych
 * kosztowych (stawki i kwoty zostają w /api/admin/company/test-distance).
 *
 * SIEĆ: `setGeoFetch` podstawia mock liczący wywołania — test nigdy nie rusza internetu.
 * Sprząta po sobie HARD: obiekty z prefiksem ZZ-TRAVEL, dotknięte wpisy geo_cache
 * i ustawienia `company.*` wracają do stanu sprzed testu.
 */
import { Hono } from "hono";
import { inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import companyRoutes, { TRAVEL_BATCH_LIMIT } from "../src/routes/company.js";
import { geoCacheSet, routeCacheKey, setGeoFetch, estimateMinutes } from "../src/lib/geo.js";
import { COMPANY_FIELDS, COMPANY_FIELD_NAMES } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-TRAVEL";
const OFFICE = { lat: 52.4064, lng: 16.9252 }; // Poznań, Stary Rynek
const TARGET = { lat: 52.2317, lng: 21.0059 }; // Warszawa, PKiN

let netCalls = 0;
setGeoFetch(async () => {
  netCalls++;
  throw new TypeError("fetch failed");
});

const settingsBackup = new Map<string, string | null>();
for (const name of COMPANY_FIELD_NAMES) {
  const key = COMPANY_FIELDS[name].dbKey;
  settingsBackup.set(key, getSetting(key));
}
const touchedKeys = new Set<string>();
function cacheSet(key: string, value: unknown) {
  touchedKeys.add(key);
  geoCacheSet(key, value);
}

function cleanup() {
  if (touchedKeys.size > 0) {
    db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).run();
  }
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  for (const [key, value] of settingsBackup) {
    if (value === null) deleteSetting(key);
    else setSetting(key, value, null);
  }
}
cleanup();

const contractor = db.select({ id: schema.contractors.id }).from(schema.contractors).limit(1).get();
if (!contractor) {
  console.error("Brak kontrahenta w bazie — przerywam.");
  process.exit(1);
}

const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    address: "Plac Defilad 1",
    city: "Warszawa",
    type: "monitoring",
    installationType: "new",
    latitude: TARGET.lat,
    longitude: TARGET.lng,
  })
  .returning()
  .get();

const bare = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Bez adresu`,
    type: "monitoring",
    installationType: "new",
  })
  .returning()
  .get();

/** Aplikacja testowa: zalogowany technik (bez uprawnień admina) zamiast prawdziwej sesji. */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: 1, username: "technik", role: "user" });
    return next();
  });
  a.route("/company", companyRoutes);
  return a;
}

async function get(path: string) {
  const res = await app().request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function main() {
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);
  setSetting("company.office_address", "Stary Rynek 1", null);
  setSetting("company.office_city", "Poznań", null);
  setSetting("company.km_source", "route", null);

  // --- Walidacja ---
  const noParam = await get("/company/travel");
  ok("brak objectId → 400", noParam.status === 400 && noParam.body.success === false, noParam);

  const badParam = await get("/company/travel?objectId=abc");
  ok("objectId nie-liczba → 400", badParam.status === 400, badParam);

  const missing = await get("/company/travel?objectId=999999");
  ok("nieistniejący obiekt → 404", missing.status === 404, missing);

  // --- Trafienie w cache: natychmiast, bez sieci ---
  cacheSet(routeCacheKey(OFFICE, TARGET), { km: 310.5, minutes: 226, method: "route" });
  netCalls = 0;
  const cached = await get(`/company/travel?objectId=${object.id}`);
  const d = cached.body.data as Record<string, unknown>;
  ok(
    "trasa z cache → 200 z km i minutami, bez ruchu sieciowego",
    cached.status === 200 && d.km === 310.5 && d.minutes === 226 && d.method === "route" &&
      d.cached === true && d.pending === false && d.error === null && netCalls === 0,
    { cached, netCalls }
  );
  ok("czas z OSRM nie jest oznaczony jako estymowany", d.minutesEstimated === false, d);
  ok("odpowiedź zawiera punkty from/to", !!d.from && !!d.to, d);

  // --- Regresja: zero danych kosztowych w odpowiedzi dla zwykłego użytkownika ---
  const leaked = ["amountKm", "rate", "rateSource", "hourlyCost", "amounts", "totalKm"].filter(
    (k) => k in d
  );
  ok("odpowiedź nie wystawia stawek ani kwot", leaked.length === 0, leaked);

  // --- Cache miss: 200 + pending, przybliżenie linią prostą (dialog nie czeka) ---
  db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [routeCacheKey(OFFICE, TARGET)])).run();
  const miss = await get(`/company/travel?objectId=${object.id}`);
  const m = miss.body.data as Record<string, unknown>;
  ok(
    "cache miss → 200, pending, linia prosta z estymowanym czasem",
    miss.status === 200 && m.pending === true && m.method === "straight" &&
      m.minutesEstimated === true && m.minutes === estimateMinutes(m.km as number),
    miss
  );

  // --- Tryb „ręcznie”: komunikat zamiast liczb, nic nie liczymy w tle ---
  setSetting("company.km_source", "manual", null);
  const manual = await get(`/company/travel?objectId=${object.id}`);
  const mm = manual.body.data as Record<string, unknown>;
  ok(
    "km_source=manual → 200 z komunikatem, bez liczb i bez pending",
    manual.status === 200 && mm.km === null && mm.pending === false && /ręcznie/.test(String(mm.error)),
    manual
  );
  setSetting("company.km_source", "route", null);

  // --- Obiekt bez adresu: stan trwały, więc nic nie dolicza się w tle ---
  const noAddr = await get(`/company/travel?objectId=${bare.id}`);
  const na = noAddr.body.data as Record<string, unknown>;
  ok(
    "obiekt bez adresu → 200 z „Brak adresu obiektu”, pending=false",
    noAddr.status === 200 && na.error === "Brak adresu obiektu" && na.pending === false,
    noAddr
  );

  // --- Brak adresu biura ---
  for (const key of ["company.office_lat", "company.office_lng", "company.office_address", "company.office_city", "company.office_postcode"]) {
    deleteSetting(key);
  }
  const noOffice = await get(`/company/travel?objectId=${object.id}`);
  const no = noOffice.body.data as Record<string, unknown>;
  ok(
    "brak adresu biura → 200 z podpowiedzią gdzie uzupełnić",
    noOffice.status === 200 && /Administracja/.test(String(no.error)) && no.km === null,
    noOffice
  );

  // --- Tryb zbiorczy ---
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);
  setSetting("company.office_address", "Stary Rynek 1", null);
  setSetting("company.office_city", "Poznań", null);
  cacheSet(routeCacheKey(OFFICE, TARGET), { km: 310.5, minutes: 226, method: "route" });

  const batch = await get(`/company/travel?objectIds=${object.id},${bare.id},999999,${object.id}`);
  const rows = batch.body.data as Record<string, unknown>[];
  ok("tryb zbiorczy → 200 z tablicą wyników", batch.status === 200 && Array.isArray(rows), batch);
  ok("powtórzone id liczone raz (3 unikalne)", rows.length === 3, rows);
  const byId = new Map(rows.map((r) => [r.objectId as number, r]));
  ok(
    "obiekt z cache ma km i minuty",
    byId.get(object.id)?.km === 310.5 && byId.get(object.id)?.minutes === 226,
    byId.get(object.id)
  );
  ok("obiekt bez adresu → komunikat zamiast liczb", byId.get(bare.id)?.error === "Brak adresu obiektu", byId.get(bare.id));
  ok("nieznane id → wpis z błędem, nie 404 całości", byId.get(999999)?.error === "Nie znaleziono obiektu", byId.get(999999));

  const emptyBatch = await get("/company/travel?objectIds=");
  ok("pusta lista → 400", emptyBatch.status === 400, emptyBatch);
  const junkBatch = await get("/company/travel?objectIds=abc,-1,0");
  ok("same śmieci w liście → 400", junkBatch.status === 400, junkBatch);

  const tooMany = Array.from({ length: TRAVEL_BATCH_LIMIT + 1 }, (_, i) => i + 1).join(",");
  const overLimit = await get(`/company/travel?objectIds=${tooMany}`);
  ok("powyżej limitu → 400", overLimit.status === 400 && /limit/.test(String(overLimit.body.error)), overLimit);

  // --- /office nadal działa (ta sama trasa, nie zepsuliśmy mapy realizacji) ---
  const office = await get("/company/office");
  ok("GET /company/office nadal odpowiada 200", office.status === 200 && office.body.success === true, office);
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  cleanup();
  const left = db.select().from(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych obiektów", left.length === 0, left);
  const leftCache = db.select().from(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).all();
  ok("sprzątanie: brak testowych wpisów geo_cache", leftCache.length === 0, leftCache);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
