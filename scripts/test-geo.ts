/**
 * Test modułu geo (src/lib/geo.ts) na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-geo.ts
 *
 * Zakres: haversine i linia prosta ×1,3, klucze cache'u, TTL 90 dni (wpis przeterminowany
 * = brak wpisu), upsert odświeżający TTL, prune, geokodowanie z cache'u BEZ sieci,
 * brak sieci → `{ error }` (nigdy wyjątek), fallback OSRM → linia prosta, tryb offline
 * (GEO_OFFLINE=1), `distanceForObject` przy braku adresu / źródle „manual” / z cache'u.
 *
 * SIEĆ: test nigdy nie wychodzi do internetu — `setGeoFetch` podstawia mock, który albo
 * udaje brak połączenia, albo zwraca gotowy JSON, a licznik wywołań pilnuje, że trafienia
 * w cache w ogóle nie ruszają „sieci”.
 *
 * Sprząta po sobie HARD: wpisy geo_cache założone przez test (klucze zapamiętane w toku),
 * testowy obiekt (prefiks ZZ-GEO) i ustawienia `company.*` wracają do stanu sprzed testu.
 */
import { eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import {
  distanceForObject,
  geoCacheGet,
  geoCacheKey,
  geoCacheSet,
  geocode,
  haversineKm,
  isGeoError,
  objectPoint,
  pruneGeoCache,
  routeCacheKey,
  routeDistanceKm,
  setGeoFetch,
  straightLineKm,
  GEO_CACHE_TTL_DAYS,
} from "../src/lib/geo.js";
import { COMPANY_FIELDS, COMPANY_FIELD_NAMES } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-GEO";

// --- Sieć: wyłącznie mock; każde wyjście „do sieci” jest liczone ------------
let netCalls = 0;
type FetchLike = typeof fetch;
const offlineFetch: FetchLike = async () => {
  netCalls++;
  throw new TypeError("fetch failed");
};
function jsonFetch(payload: unknown): FetchLike {
  return async () => {
    netCalls++;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
setGeoFetch(offlineFetch);

// --- Stan do przywrócenia ---------------------------------------------------
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

/** Postarza wpis cache'u o N dni (test TTL bez czekania 90 dni). */
function age(key: string, days: number) {
  db.update(schema.geoCache)
    .set({ createdAt: sql`datetime('now', ${`-${days} days`})` })
    .where(eq(schema.geoCache.key, key))
    .run();
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
  // UWAGA: NIE przywracamy tu prawdziwego fetcha — cleanup() leci też przed testem,
  // a od tego momentu do końca procesu „sieć” ma być wyłącznie mockiem.
}
cleanup();

// Obiekt testowy (Warszawa, Pałac Kultury) — potrzebny do distanceForObject.
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
    latitude: 52.2317,
    longitude: 21.0059,
  })
  .returning()
  .get();

// Obiekt bez adresu i bez współrzędnych — ścieżka „Brak adresu obiektu”.
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

const OFFICE = { lat: 52.4064, lng: 16.9252 }; // Poznań, Stary Rynek

async function main() {
  // -------------------------------------------------------------------------
  // 1. Geometria
  // -------------------------------------------------------------------------
  const dist = haversineKm(OFFICE, { lat: object.latitude!, lng: object.longitude! });
  ok("haversine Poznań → Warszawa ≈ 279 km", Math.abs(dist - 279) < 6, dist);
  ok("haversine tego samego punktu = 0", haversineKm(OFFICE, OFFICE) === 0, haversineKm(OFFICE, OFFICE));
  ok(
    "linia prosta = haversine × 1,3 (1 miejsce po przecinku)",
    Math.abs(straightLineKm(OFFICE, { lat: object.latitude!, lng: object.longitude! }) - Math.round(dist * 1.3 * 10) / 10) < 0.06,
    straightLineKm(OFFICE, { lat: object.latitude!, lng: object.longitude! })
  );

  // -------------------------------------------------------------------------
  // 2. Klucze i cache
  // -------------------------------------------------------------------------
  ok("klucz geokodera jest stabilny (trim + case)", geoCacheKey("  Plac Defilad 1, WARSZAWA ") === geoCacheKey("plac defilad 1, warszawa"));
  ok("klucz trasy zawiera oba punkty", routeCacheKey(OFFICE, { lat: 52.2317, lng: 21.0059 }) === "route:52.40640,16.92520|52.23170,21.00590", routeCacheKey(OFFICE, { lat: 52.2317, lng: 21.0059 }));

  const k = geoCacheKey(`${PREFIX} zapytanie testowe`);
  cacheSet(k, { lat: 52.1, lng: 21.1, display: "Testowy adres" });
  const hit = geoCacheGet<{ lat: number; display: string }>(k);
  ok("odczyt świeżego wpisu z cache", hit?.lat === 52.1 && hit.display === "Testowy adres", hit);

  // TTL: postarzamy wpis o 91 dni → ma zniknąć z odczytu
  age(k, GEO_CACHE_TTL_DAYS + 1);
  ok("wpis starszy niż TTL nie jest zwracany", geoCacheGet(k) === null, geoCacheGet(k));

  // Upsert odświeża created_at → wpis znów jest ważny
  cacheSet(k, { lat: 52.2, lng: 21.2, display: "Po odświeżeniu" });
  const refreshed = geoCacheGet<{ lat: number }>(k);
  ok("upsert odświeża TTL", refreshed?.lat === 52.2, refreshed);

  // Uszkodzony JSON = brak wpisu (nigdy wyjątek)
  db.update(schema.geoCache).set({ value: "{to nie jest json" }).where(eq(schema.geoCache.key, k)).run();
  ok("uszkodzony JSON w cache traktowany jak brak wpisu", geoCacheGet(k) === null);
  cacheSet(k, { lat: 52.2, lng: 21.2, display: "Po odświeżeniu" });

  // prune kasuje tylko przeterminowane
  const stale = `geo:${PREFIX}-stale`;
  cacheSet(stale, { lat: 1, lng: 1, display: "stary" });
  age(stale, GEO_CACHE_TTL_DAYS + 5);
  const pruned = pruneGeoCache();
  ok("prune kasuje przeterminowany wpis", pruned >= 1, pruned);
  ok("prune nie rusza świeżych wpisów", geoCacheGet(k) !== null);

  // -------------------------------------------------------------------------
  // 3. Geokoder bez sieci
  // -------------------------------------------------------------------------
  netCalls = 0;
  const fromCache = await geocode(`${PREFIX} zapytanie testowe`);
  ok("geocode trafia w cache bez ruchu sieciowego", !isGeoError(fromCache) && fromCache.cached === true && netCalls === 0, { fromCache, netCalls });

  const missing = await geocode(`${PREFIX} adres spoza cache`);
  ok("geocode bez sieci zwraca { error } zamiast wyjątku", isGeoError(missing) && /połączenia|odpowiedzi|offline/i.test(missing.error), missing);

  const empty = await geocode("   ");
  ok("puste zapytanie → { error }", isGeoError(empty), empty);

  netCalls = 0;
  const cacheOnly = await geocode(`${PREFIX} inny adres`, { cacheOnly: true });
  ok("cacheOnly nie wychodzi do sieci", isGeoError(cacheOnly) && netCalls === 0, { cacheOnly, netCalls });

  // Zapytanie z odpowiedzią Nominatim ląduje w cache i jest odtwarzane bez sieci
  setGeoFetch(jsonFetch([{ lat: "52.2317", lon: "21.0059", display_name: "Plac Defilad 1, Warszawa" }]));
  netCalls = 0;
  const geoQuery = `${PREFIX} Plac Defilad 1, Warszawa`;
  touchedKeys.add(geoCacheKey(geoQuery));
  const first = await geocode(geoQuery);
  ok("geocode zapisuje wynik do cache", !isGeoError(first) && first.cached === false && first.lat === 52.2317, first);
  const second = await geocode(geoQuery);
  ok("drugie wywołanie idzie z cache (1 zapytanie sieciowe łącznie)", !isGeoError(second) && second.cached === true && netCalls === 1, { second, netCalls });

  // Pusta lista wyników = czytelny błąd
  setGeoFetch(jsonFetch([]));
  const notFound = await geocode(`${PREFIX} nie ma takiego adresu`);
  ok("brak wyników geokodera → { error }", isGeoError(notFound) && /Nie znaleziono/.test(notFound.error), notFound);
  setGeoFetch(offlineFetch);

  // Tryb GEO_OFFLINE=1 — nawet z działającym „fetchem” nie ruszamy sieci
  setGeoFetch(jsonFetch([{ lat: "50", lon: "20", display_name: "x" }]));
  process.env.GEO_OFFLINE = "1";
  netCalls = 0;
  const offline = await geocode(`${PREFIX} offline`);
  ok("GEO_OFFLINE=1 → { error } i zero ruchu", isGeoError(offline) && netCalls === 0, { offline, netCalls });
  delete process.env.GEO_OFFLINE;
  setGeoFetch(offlineFetch);

  // -------------------------------------------------------------------------
  // 4. Dystans
  // -------------------------------------------------------------------------
  const target = { lat: object.latitude!, lng: object.longitude! };
  const fallback = await routeDistanceKm(OFFICE, target);
  ok(
    "OSRM niedostępny → fallback linia prosta (nigdy błąd)",
    fallback.method === "straight" && Math.abs(fallback.km - straightLineKm(OFFICE, target)) < 0.001,
    fallback
  );

  const rk = routeCacheKey(OFFICE, target);
  cacheSet(rk, { km: 310.5, method: "route" });
  netCalls = 0;
  const cachedRoute = await routeDistanceKm(OFFICE, target);
  ok("trasa z cache: 310,5 km, method=route, bez sieci", cachedRoute.km === 310.5 && cachedRoute.method === "route" && cachedRoute.cached === true && netCalls === 0, { cachedRoute, netCalls });

  const forcedStraight = await routeDistanceKm(OFFICE, target, { useRouting: false });
  ok("useRouting:false pomija cache trasy i liczy linią prostą", forcedStraight.method === "straight", forcedStraight);

  // OSRM z odpowiedzią → zapis do cache
  const other = { lat: 51.1079, lng: 17.0385 }; // Wrocław
  setGeoFetch(jsonFetch({ code: "Ok", routes: [{ distance: 183_400 }] }));
  touchedKeys.add(routeCacheKey(OFFICE, other));
  const osrm = await routeDistanceKm(OFFICE, other);
  ok("OSRM 183 400 m → 183,4 km (method=route)", osrm.km === 183.4 && osrm.method === "route", osrm);
  setGeoFetch(offlineFetch);
  const osrmCached = await routeDistanceKm(OFFICE, other);
  ok("trasa OSRM odtworzona z cache po utracie sieci", osrmCached.km === 183.4 && osrmCached.cached === true, osrmCached);

  // -------------------------------------------------------------------------
  // 5. distanceForObject (biuro z ustawień)
  // -------------------------------------------------------------------------
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);
  setSetting("company.office_address", "Stary Rynek 1", null);
  setSetting("company.office_city", "Poznań", null);
  setSetting("company.km_source", "route", null);

  netCalls = 0;
  const d = await distanceForObject(object.id);
  ok(
    "distanceForObject bierze trasę z cache (bez sieci)",
    !isGeoError(d) && d.km === 310.5 && d.method === "route" && d.cached === true && netCalls === 0,
    { d, netCalls }
  );
  ok("distanceForObject zwraca punkty from/to z etykietami", !isGeoError(d) && d.from.label.includes("Stary Rynek") && d.to.label === object.name, d);

  setSetting("company.km_source", "straight", null);
  const straight = await distanceForObject(object.id);
  ok("źródło „straight” liczy linią prostą (bez cache trasy)", !isGeoError(straight) && straight.method === "straight", straight);

  setSetting("company.km_source", "manual", null);
  const manual = await distanceForObject(object.id);
  ok("źródło „manual” → { error } (kalkulacja wyłączona)", isGeoError(manual) && /ręcznie/.test(manual.error), manual);
  setSetting("company.km_source", "route", null);

  const noAddress = await distanceForObject(bare.id);
  ok("obiekt bez adresu → { error: Brak adresu obiektu }", isGeoError(noAddress) && noAddress.error === "Brak adresu obiektu", noAddress);

  const noObject = await distanceForObject(999_999);
  ok("nieistniejący obiekt → { error }", isGeoError(noObject), noObject);

  // Leniwe geokodowanie współrzędnych obiektu (z cache — bez sieci)
  const lazy = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Leniwy`,
      address: "Plac Defilad 1",
      city: "Warszawa",
      type: "monitoring",
      installationType: "new",
    })
    .returning()
    .get();
  touchedKeys.add(geoCacheKey("Plac Defilad 1, Warszawa"));
  cacheSet(geoCacheKey("Plac Defilad 1, Warszawa"), { lat: 52.2317, lng: 21.0059, display: "PKiN" });
  netCalls = 0;
  const lazyPoint = await objectPoint(lazy.id);
  ok("objectPoint geokoduje adres z cache", !isGeoError(lazyPoint) && lazyPoint.lat === 52.2317 && netCalls === 0, { lazyPoint, netCalls });
  const stored = db.select().from(schema.objects).where(eq(schema.objects.id, lazy.id)).get();
  ok("współrzędne zapisane leniwie w obiekcie", stored?.latitude === 52.2317 && stored?.longitude === 21.0059, stored);

  // Ręczna korekta współrzędnych nie jest nadpisywana
  db.update(schema.objects).set({ latitude: 50, longitude: 20 }).where(eq(schema.objects.id, lazy.id)).run();
  const manualPoint = await objectPoint(lazy.id);
  ok("ręcznie wpisane współrzędne mają pierwszeństwo", !isGeoError(manualPoint) && manualPoint.lat === 50, manualPoint);

  // Brak adresu biura → czytelny komunikat
  // Kasujemy WSZYSTKIE pola adresu biura — wystarczy sam kod pocztowy w bazie,
  // żeby `officeAddressLine` zwróciło niepusty adres i test poszedł inną ścieżką.
  for (const key of ["company.office_lat", "company.office_lng", "company.office_address", "company.office_city", "company.office_postcode"]) {
    deleteSetting(key);
  }
  const noOffice = await distanceForObject(object.id);
  ok("brak adresu biura → { error } z podpowiedzią gdzie uzupełnić", isGeoError(noOffice) && /Administracja/.test(noOffice.error), noOffice);
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  cleanup();
  const leftObjects = db.select().from(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych obiektów", leftObjects.length === 0, leftObjects);
  const leftCache = db
    .select()
    .from(schema.geoCache)
    .where(inArray(schema.geoCache.key, [...touchedKeys]))
    .all();
  ok("sprzątanie: brak testowych wpisów geo_cache", leftCache.length === 0, leftCache);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
