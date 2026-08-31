/**
 * Test planera trasy — punkty i macierz dnia (GET /api/calendar/day-route):
 *   npx tsx scripts/test-day-route.ts
 *
 * Zakres: walidacja date/eventIds (400), punkty dnia z cache'u bez ruchu sieciowego,
 * cache miss → 200 z `pending: true` i przybliżeniem linią prostą, klasyfikacja wydarzeń
 * poza trasą (urlop/biuro, całodniowe, bez obiektu, bez współrzędnych), granica zakresu
 * dnia przy WYŁĄCZNYM `end_at` wydarzeń całodniowych, dedup punktów o tych samych
 * współrzędnych, zawężanie przez `eventIds`, honorowanie `km_source=straight` i
 * IGNOROWANIE `km_source=manual` (planer nie rozlicza, więc nie może zgasnąć).
 *
 * Dwie regresje pilnują założeń całej funkcji:
 *   - odpowiedź NIE zawiera żadnych danych kosztowych (stawki zostają w panelu admina),
 *   - po wywołaniu żadne wydarzenie kalendarza się NIE zmienia (endpoint jest odczytowy).
 *
 * SIEĆ: `setGeoFetch` podstawia mock liczący wywołania — test nigdy nie rusza internetu.
 * Sprząta HARD: obiekty i wydarzenia z prefiksem ZZ-ROUTE, dotknięte wpisy geo_cache
 * i ustawienia `company.*` wracają do stanu sprzed testu.
 */
import { Hono } from "hono";
import { inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import calendarDayRouteRoutes from "../src/routes/calendar-day-route.js";
import { geoCacheSet, routeCacheKey, setGeoFetch } from "../src/lib/geo.js";
import { COMPANY_FIELDS, COMPANY_FIELD_NAMES } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-ROUTE";
const DAY = "2031-03-10";
const NEXT = "2031-03-11";

const OFFICE = { lat: 52.4064, lng: 16.9252 }; // Poznań
const A = { lat: 52.2317, lng: 21.0059 };      // Warszawa
const B = { lat: 51.1079, lng: 17.0385 };      // Wrocław

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
function cacheSet(from: { lat: number; lng: number }, to: { lat: number; lng: number }, km: number, minutes: number) {
  const key = routeCacheKey(from, to);
  touchedKeys.add(key);
  geoCacheSet(key, { km, minutes, method: "route" });
}

function cleanup() {
  db.delete(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).run();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  if (touchedKeys.size > 0) {
    db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).run();
  }
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

function makeObject(name: string, point?: { lat: number; lng: number }, address?: string) {
  return db
    .insert(schema.objects)
    .values({
      contractorId: contractor!.id,
      name: `${PREFIX} ${name}`,
      address: address ?? null,
      city: address ? "Testowo" : null,
      type: "monitoring",
      installationType: "new",
      latitude: point?.lat ?? null,
      longitude: point?.lng ?? null,
    })
    .returning()
    .get();
}

const objA = makeObject("Alfa", A, "Plac Defilad 1");
const objB = makeObject("Beta", B, "Rynek 1");
// Ten sam budynek co Alfa — sprawdzamy dedup punktów macierzy.
const objDup = makeObject("Alfa-bis", A, "Plac Defilad 1");
const objBare = makeObject("Bez adresu");

function makeEvent(v: {
  title: string;
  startAt: string;
  endAt: string;
  objectId?: number | null;
  type?: string;
  status?: string;
  allDay?: boolean;
}) {
  return db
    .insert(schema.calendarEvents)
    .values({
      type: (v.type ?? "serwis") as never,
      title: `${PREFIX} ${v.title}`,
      startAt: v.startAt,
      endAt: v.endAt,
      allDay: v.allDay ?? false,
      status: (v.status ?? "planned") as never,
      objectId: v.objectId ?? null,
    })
    .returning()
    .get();
}

/** Aplikacja testowa: zalogowany technik (bez uprawnień admina). */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: 1, username: "technik", role: "user" });
    return next();
  });
  a.route("/calendar", calendarDayRouteRoutes);
  return a;
}

async function get(path: string) {
  const res = await app().request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type DayRouteBody = {
  points: { key: string; kind: string; objectId: number | null; lat: number; address: string | null }[];
  events: { eventId: number; pointKey: string | null; skip: string | null; skipMessage: string | null }[];
  matrix: { keys: string[]; km: number[][]; minutes: number[][]; method: string[][] } | null;
  office: { key: string; lat: number } | null;
  officeError: string | null;
  pending: boolean;
  truncated: number;
  notes: string[];
};

async function main() {
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);
  setSetting("company.office_address", "Stary Rynek 1", null);
  setSetting("company.office_city", "Poznań", null);
  setSetting("company.km_source", "route", null);

  // --- Walidacja ---
  ok("brak date → 400", (await get("/calendar/day-route")).status === 400);
  ok("date w złym formacie → 400", (await get("/calendar/day-route?date=10-03-2031")).status === 400);
  ok("puste eventIds → 400", (await get(`/calendar/day-route?date=${DAY}&eventIds=abc`)).status === 400);

  // --- Wydarzenia dnia ---
  const evA = makeEvent({ title: "Serwis Alfa", startAt: `${DAY}T08:00`, endAt: `${DAY}T10:00`, objectId: objA.id, status: "confirmed" });
  const evB = makeEvent({ title: "Montaż Beta", startAt: `${DAY}T13:00`, endAt: `${DAY}T15:00`, objectId: objB.id, type: "montaz" });
  const evNoObj = makeEvent({ title: "Bez obiektu", startAt: `${DAY}T16:00`, endAt: `${DAY}T17:00` });
  const evBare = makeEvent({ title: "Bez adresu", startAt: `${DAY}T17:00`, endAt: `${DAY}T18:00`, objectId: objBare.id });
  const evUrlop = makeEvent({ title: "Urlop", startAt: `${DAY}T00:00`, endAt: `${DAY}T23:59`, type: "urlop" });
  const evCancelled = makeEvent({ title: "Anulowane", startAt: `${DAY}T09:00`, endAt: `${DAY}T10:00`, objectId: objB.id, status: "cancelled" });
  // Całodniowe: end_at jest WYŁĄCZNY (dzień następny).
  const evAllDay = makeEvent({ title: "Całodniowe", startAt: DAY, endAt: NEXT, allDay: true, objectId: objA.id });

  // Trasy w cache — komplet par biuro/A/B w obie strony.
  cacheSet(OFFICE, A, 310.5, 190);
  cacheSet(A, OFFICE, 311.9, 191);
  cacheSet(OFFICE, B, 183.4, 122);
  cacheSet(B, OFFICE, 184.2, 123);
  cacheSet(A, B, 348.0, 215);
  cacheSet(B, A, 347.1, 214);

  netCalls = 0;
  const r1 = await get(`/calendar/day-route?date=${DAY}`);
  const d1 = r1.body.data as DayRouteBody;
  ok("dzień z cache'u: 200 i zero ruchu sieciowego", r1.status === 200 && netCalls === 0, { status: r1.status, netCalls });
  ok("biuro jest punktem 0 macierzy", d1.office?.key === "office" && d1.matrix?.keys[0] === "office", d1.matrix?.keys);
  ok("punkty: biuro + Alfa + Beta", d1.points.length === 3, d1.points.map((p) => p.key));
  ok("macierz z cache'u, bez pending", d1.pending === false && d1.matrix?.method[0][1] === "route", { pending: d1.pending });
  ok("macierz jest asymetryczna (km biuro→A ≠ A→biuro)", d1.matrix?.km[0][1] === 310.5 && d1.matrix?.km[1][0] === 311.9, d1.matrix?.km);
  ok("adresy obiektów dołączone do punktów", d1.points.some((p) => p.address === "Plac Defilad 1"), d1.points);

  const skipOf = (id: number) => d1.events.find((e) => e.eventId === id)?.skip ?? null;
  ok("urlop → poza trasą (off-site)", skipOf(evUrlop.id) === "off-site", d1.events);
  ok("anulowane → poza trasą", skipOf(evCancelled.id) === "cancelled");
  ok("bez obiektu → poza trasą", skipOf(evNoObj.id) === "no-object");
  ok("obiekt bez adresu → poza trasą (no-coords)", skipOf(evBare.id) === "no-coords");
  ok("całodniowe → poza trasą (brak godzin)", skipOf(evAllDay.id) === "all-day");
  ok("wydarzenia na trasie mają pointKey", skipOf(evA.id) === null && skipOf(evB.id) === null);
  ok("każde pominięcie ma komunikat PL", d1.events.filter((e) => e.skip).every((e) => (e.skipMessage ?? "").length > 5));

  // --- Dedup punktów ---
  const evDup = makeEvent({ title: "Alfa-bis", startAt: `${DAY}T11:00`, endAt: `${DAY}T12:00`, objectId: objDup.id });
  const d2 = (await get(`/calendar/day-route?date=${DAY}`)).body.data as DayRouteBody;
  ok("dwa obiekty pod tym samym adresem = jeden punkt macierzy", d2.points.length === 3, d2.points.map((p) => p.key));
  ok("drugi obiekt wskazuje na ten sam punkt", d2.events.find((e) => e.eventId === evDup.id)?.pointKey === `obj:${objA.id}`, d2.events);

  // --- Granica dnia przy WYŁĄCZNYM end_at ---
  const dNext = (await get(`/calendar/day-route?date=${NEXT}`)).body.data as DayRouteBody;
  ok(
    "całodniowe z end_at=jutro NIE wchodzi do dnia następnego",
    !dNext.events.some((e) => e.eventId === evAllDay.id),
    dNext.events
  );
  ok("wydarzenia poprzedniego dnia nie wyciekają", !dNext.events.some((e) => e.eventId === evA.id));

  // --- Zawężenie przez eventIds (filtry widoku) ---
  const dOnly = (await get(`/calendar/day-route?date=${DAY}&eventIds=${evA.id}`)).body.data as DayRouteBody;
  ok("eventIds zawęża plan do wskazanych wydarzeń", dOnly.events.length === 1 && dOnly.points.length === 2, {
    events: dOnly.events.length,
    points: dOnly.points.length,
  });

  // --- Cache miss → pending, przybliżenie linią prostą ---
  db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).run();
  netCalls = 0;
  const dMiss = (await get(`/calendar/day-route?date=${DAY}`)).body.data as DayRouteBody;
  ok("cache miss → pending i linia prosta zamiast czekania", dMiss.pending === true && dMiss.matrix?.method[0][1] === "straight", {
    pending: dMiss.pending,
  });
  ok("cache miss nadal zwraca sensowne km", (dMiss.matrix?.km[0][1] ?? 0) > 0, dMiss.matrix?.km);

  // --- Źródło km ---
  setSetting("company.km_source", "straight", null);
  netCalls = 0;
  const dStraight = (await get(`/calendar/day-route?date=${DAY}`)).body.data as DayRouteBody;
  ok(
    "km_source=straight: bez trasowania, bez pending, zero sieci",
    dStraight.matrix?.method[0][1] === "straight" && dStraight.pending === false && netCalls === 0,
    { pending: dStraight.pending, netCalls }
  );
  ok("km_source=straight jest wyjaśnione w notes", dStraight.notes.some((n) => /linia prosta/i.test(n)), dStraight.notes);

  setSetting("company.km_source", "manual", null);
  const dManual = (await get(`/calendar/day-route?date=${DAY}`)).body.data as DayRouteBody;
  ok(
    "km_source=manual NIE gasi planera (to ustawienie rozliczeniowe)",
    dManual.matrix !== null && dManual.points.length === 3,
    { matrix: dManual.matrix !== null, points: dManual.points.length }
  );
  ok("km_source=manual jest wyjaśnione w notes", dManual.notes.some((n) => /ręcznie/i.test(n)), dManual.notes);
  setSetting("company.km_source", "route", null);

  // --- Brak biura ---
  for (const key of ["company.office_lat", "company.office_lng", "company.office_address", "company.office_city", "company.office_postcode"]) {
    deleteSetting(key);
  }
  const dNoOffice = (await get(`/calendar/day-route?date=${DAY}`)).body.data as DayRouteBody;
  ok("brak biura → 200 z officeError, widok działa dalej", dNoOffice.office === null && (dNoOffice.officeError ?? "").length > 0, {
    office: dNoOffice.office,
    err: dNoOffice.officeError,
  });
  ok("bez biura punkty obiektów nadal są", dNoOffice.points.length === 2, dNoOffice.points.map((p) => p.key));
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);

  // --- REGRESJA: żadnych kwot w odpowiedzi ---
  const raw = JSON.stringify((await get(`/calendar/day-route?date=${DAY}`)).body);
  ok(
    "odpowiedź nie wystawia danych kosztowych",
    !/rateKm|rate_km|hourlyCost|hourly_cost|amount|netto|brutto/i.test(raw),
    raw.slice(0, 200)
  );

  // --- REGRESJA: endpoint jest w 100% odczytowy ---
  const before = db
    .select()
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()
    .map((e) => ({ id: e.id, startAt: e.startAt, endAt: e.endAt, status: e.status, updatedAt: e.updatedAt }));
  await get(`/calendar/day-route?date=${DAY}`);
  const after = db
    .select()
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()
    .map((e) => ({ id: e.id, startAt: e.startAt, endAt: e.endAt, status: e.status, updatedAt: e.updatedAt }));
  ok("planer niczego nie zapisuje w kalendarzu", JSON.stringify(before) === JSON.stringify(after), { before, after });
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  cleanup();
  const leftEvents = db.select().from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych wydarzeń", leftEvents.length === 0, leftEvents.length);
  const leftObjects = db.select().from(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych obiektów", leftObjects.length === 0, leftObjects.length);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
