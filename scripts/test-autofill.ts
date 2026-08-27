/**
 * Test automatu uzupełniania realizacji (src/lib/realization-autofill.ts + trasy) na
 * prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-autofill.ts
 *
 * Zakres (sekcja 5 kontraktu): dopasowanie cen z cennika (dokładne / częściowe / brak),
 * rozdział usługa ↔ materiał (materiał nie wycenia się z pozycji usługowej i odwrotnie),
 * suma materiałów z narzutem, godziny z kalendarza vs z protokołu, km z cache (bez sieci),
 * przejazd w obie strony, stawki RBH/KM z cennika z fallbackiem na ustawienia firmy,
 * `confident` (puste pole) vs sprzeczność, zafakturowana realizacja → 400, zapis wyłącznie
 * wskazanych pól + wpis w activity_log, ślad `realizations.autofill` i jego kasowanie przy
 * ręcznej edycji, automat po podpisaniu protokołu (i cisza, gdy automat wyłączony),
 * podgląd i zapis masowy.
 *
 * SIEĆ: `setGeoFetch` podstawia mock „brak połączenia”, a dystans wchodzi wyłącznie
 * przez wstrzyknięty wpis `geo_cache` — test nigdy nie wychodzi do internetu.
 *
 * Dane testowe: prefiks ZZ-AUTOFILL, daty 2029-07 (poza danymi produkcyjnymi). Sprząta po
 * sobie HARD (realizacje, protokoły, wydarzenia, obiekty, cennik, technik, activity_log,
 * geo_cache), a ustawienia `company.*` wracają do stanu sprzed testu — także po wyjątku.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import type { PriceItem, User } from "../src/db/schema.js";
import realizationsRoutes from "../src/routes/realizations.js";
import protocolsRoutes from "../src/routes/protocols.js";
import {
  computeAutofill,
  matchPriceItem,
  normalizeName,
  parseAutofillMarks,
  resolveHourRate,
  resolveKmRate,
  type Suggestion,
} from "../src/lib/realization-autofill.js";
import { COMPANY_FIELDS, COMPANY_FIELD_NAMES } from "../src/lib/company-config.js";
import { CALENDAR_FIELDS } from "../src/lib/calendar-config.js";
import { createEvent, parseInput, updateEvent, type MutationCtx } from "../src/lib/calendar-mutations.js";
import { flushEventDoneAutofill } from "../src/lib/calendar-realizations.js";
import { applyChange } from "../src/lib/ai/calendarChanges.js";
import { ASSISTANT_DEFAULTS } from "../src/lib/ai/assistantConfig.js";
import { geoCacheSet, routeCacheKey, setGeoFetch } from "../src/lib/geo.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-AUTOFILL";
const OFFICE = { lat: 52.4064, lng: 16.9252 }; // Poznań
const SITE = { lat: 52.2317, lng: 21.0059 }; // Warszawa

// --- Sieć: wyłącznie mock „brak połączenia” --------------------------------
setGeoFetch(async () => {
  throw new TypeError("fetch failed (test nie ma prawa ruszać sieci)");
});

const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}
const contractor = db.select({ id: schema.contractors.id }).from(schema.contractors).limit(1).get();
if (!contractor) {
  console.error("Brak kontrahenta w bazie — przerywam.");
  process.exit(1);
}

// --- Klient HTTP (kontekst jak po requireAuth) -----------------------------
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", user);
  return next();
});
app.route("/realizations", realizationsRoutes);
app.route("/protocols", protocolsRoutes);

interface Json {
  status: number;
  success?: boolean;
  data?: any;
  error?: string;
  message?: string;
}
async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Omit<Json, "status"> | null;
  return { status: res.status, ...(json ?? {}) };
}

// --- Stan do przywrócenia ---------------------------------------------------
const settingsBackup = new Map<string, string | null>();
for (const name of COMPANY_FIELD_NAMES) {
  const key = COMPANY_FIELDS[name].dbKey;
  settingsBackup.set(key, getSetting(key));
}
// Sekcja 12 przestawia `calendar.auto_realization` — backup razem z resztą ustawień.
for (const f of Object.values(CALENDAR_FIELDS)) settingsBackup.set(f.dbKey, getSetting(f.dbKey));
const cacheKeys = new Set<string>();

function cleanup() {
  const realizationIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(like(schema.realizations.site, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((o) => o.id);

  // Wydarzenia testowe: po tytule ORAZ po powiązaniu z testową realizacją (sekcja 12 tworzy
  // je przez prawdziwe mutacje, więc ciągną za sobą assignees i wpisy activity_log).
  const eventIds = new Set<number>();
  for (const e of db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()) {
    eventIds.add(e.id);
  }
  if (realizationIds.length > 0) {
    for (const e of db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.realizationId, realizationIds))
      .all()) {
      eventIds.add(e.id);
    }
  }
  if (eventIds.size > 0) {
    const ids = [...eventIds];
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, ids)).run();
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, ids)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, ids)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
  }

  if (realizationIds.length > 0) {
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.realizationId, realizationIds)).run();
    db.delete(schema.protocols).where(inArray(schema.protocols.realizationId, realizationIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "realization"), inArray(schema.activityLog.entityId, realizationIds)))
      .run();
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realizationIds)).run();
  }
  db.delete(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).run();
  if (objectIds.length > 0) {
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  const lists = db
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(like(schema.priceLists.name, `${PREFIX}%`))
    .all()
    .map((l) => l.id);
  if (lists.length > 0) {
    db.update(schema.technicians)
      .set({ priceListId: null })
      .where(inArray(schema.technicians.priceListId, lists))
      .run();
    db.delete(schema.priceList).where(inArray(schema.priceList.priceListId, lists)).run();
    db.delete(schema.priceLists).where(inArray(schema.priceLists.id, lists)).run();
  }
  if (cacheKeys.size > 0) {
    db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [...cacheKeys])).run();
  }
  for (const [key, value] of settingsBackup) {
    if (value === null) deleteSetting(key);
    else setSetting(key, value, null);
  }
}
cleanup();

// ---------------------------------------------------------------------------
// Dane testowe
// ---------------------------------------------------------------------------

const list = db
  .insert(schema.priceLists)
  .values({ name: `${PREFIX} Cennik`, description: "cennik testowy", isDefault: false, position: 999 })
  .returning()
  .get();

const priceItem = (
  name: string,
  unit: string,
  kind: "service" | "material",
  price: number,
  position: number
) =>
  db
    .insert(schema.priceList)
    .values({ priceListId: list.id, name, unit, kind, price, position, active: true })
    .returning()
    .get();

priceItem("ROBOCZOGODZINA SERWISOWA", "RBH", "service", 100, 1);
priceItem("DOJAZD DO KLIENTA", "KM", "service", 2.5, 2);
priceItem(`KAMERA IP ${PREFIX}`, "SZT", "material", 400, 3);
priceItem(`KABEL UTP KAT 5E ${PREFIX}`, "MB", "material", 3, 4);
// Pozycja USŁUGOWA o nazwie materiałowej — automat NIE ma jej użyć do wyceny materiałów.
priceItem(`MONTAZ KAMERY ${PREFIX}`, "SZT", "service", 999, 5);

const tech = db
  .insert(schema.technicians)
  .values({
    firstName: "Jan",
    lastName: `${PREFIX}owski`,
    type: "internal",
    active: true,
    priceListId: list.id,
  })
  .returning()
  .get();
const techName = `${tech.firstName} ${tech.lastName}`;

const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    address: "Plac Defilad 1",
    city: "Warszawa",
    type: "monitoring",
    installationType: "new",
    latitude: SITE.lat,
    longitude: SITE.lng,
  })
  .returning()
  .get();

// Obiekt bez adresu — ścieżka „brak danych do kalkulacji km” (bez sieci, bez 500).
const objectNoAddress = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt bez adresu`,
    type: "monitoring",
    installationType: "new",
  })
  .returning()
  .get();

// Obiekt z adresem, ale bez współrzędnych i bez wpisu w geo_cache — geokoder musiałby wyjść
// do sieci (a ta jest zamockowana na „brak połączenia”), więc km wypada z ostrzeżeniem.
const objectNoCoords = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt bez wspolrzednych`,
    address: "Ulica Nieistniejaca 99",
    city: "Testowo",
    type: "monitoring",
    installationType: "new",
  })
  .returning()
  .get();

// Dystans wyłącznie z cache — 310,5 km w jedną stronę.
const routeKey = routeCacheKey(OFFICE, SITE);
cacheKeys.add(routeKey);
geoCacheSet(routeKey, { km: 310.5, method: "route" });

// Ustawienia firmy na czas testu.
setSetting("company.office_address", "Stary Rynek 1", null);
setSetting("company.office_city", "Poznań", null);
setSetting("company.office_lat", String(OFFICE.lat), null);
setSetting("company.office_lng", String(OFFICE.lng), null);
setSetting("company.rate_hour", "80", null);
setSetting("company.hourly_cost", "55", null);
setSetting("company.rate_km", "1.2", null);
setSetting("company.km_round_trip", "1", null);
setSetting("company.km_source", "route", null);
setSetting("company.material_markup", "10", null);
setSetting("company.autofill_enabled", "1", null);

const PROTOCOL_ITEMS = JSON.stringify([
  { name: `KAMERA IP ${PREFIX}`, serial: "SN-1", unit: "szt", qty: "3" }, // dokładne dopasowanie
  { name: "KABEL UTP KAT 5E", serial: "", unit: "mb", qty: "10" }, // dopasowanie częściowe
  { name: `SRUBA MOTYLKOWA ${PREFIX}`, serial: "", unit: "szt", qty: "5" }, // brak w cenniku
  { name: `MONTAZ KAMERY ${PREFIX}`, serial: "", unit: "szt", qty: "2" }, // jest, ale jako USŁUGA
  { name: "PESZEL - RURA KARBOWANA", serial: "", unit: "mb", qty: "" }, // brak ilości = wzór
]);
// 3 × 400 + 10 × 3 = 1230; narzut 10% → 1353,00
const MATERIAL_TOTAL = 1353;

/** Realizacja z wydarzeniem kalendarza (2 godz.) i protokołem. */
function makeRealization(opts: {
  suffix: string;
  date?: string;
  withEvent?: boolean;
  objectId?: number;
  amounts?: Partial<Record<string, number>>;
}) {
  const r = db
    .insert(schema.realizations)
    .values({
      date: opts.date ?? "2029-07-10",
      site: `${PREFIX} ${opts.suffix}`,
      kind: "service",
      contractor1: techName,
      amountHours: 0,
      amountMaterial: 0,
      amountKm: 0,
      actualHours: 0,
      actualKm: 0,
      hourlyCost: 0,
      ...(opts.amounts ?? {}),
    })
    .returning()
    .get();

  if (opts.withEvent !== false) {
    db.insert(schema.calendarEvents)
      .values({
        type: "serwis",
        title: `${PREFIX} ${opts.suffix}`,
        startAt: `${r.date}T08:00:00`,
        endAt: `${r.date}T10:00:00`,
        status: "done",
        objectId: opts.objectId ?? object.id,
        realizationId: r.id,
      })
      .run();
  }
  return r;
}

/** Protokół realizacji (numer testowy, poza numeracją produkcyjną). */
function makeProtocol(realizationId: number, suffix: string, actualHours = 0) {
  return db
    .insert(schema.protocols)
    .values({
      realizationId,
      number: `P/2029/07/${suffix}`,
      workDate: "2029-07-10",
      workType: "service",
      actualHours,
      items: PROTOCOL_ITEMS,
      status: "draft",
    })
    .returning()
    .get();
}

const byField = (list: Suggestion[], field: string) => list.find((s) => s.field === field);

/** Sztuczna pozycja cennika do testów jednostkowych dopasowania. */
const fake = (name: string, unit: string, kind: "service" | "material", price: number): PriceItem => ({
  id: Math.floor(Math.random() * 1e6),
  priceListId: 0,
  name,
  unit,
  kind,
  price,
  position: 0,
  active: true,
  createdAt: "",
  updatedAt: "",
});

async function main() {
  // -------------------------------------------------------------------------
  // 1. Dopasowanie nazw i stawki (jednostkowo)
  // -------------------------------------------------------------------------
  ok("normalizeName ściąga diakrytyki i spacje", normalizeName("Kamera IP — ŻÓŁĆ ół") === "kameraipzolcol", normalizeName("Kamera IP — ŻÓŁĆ ół"));

  const materials = [fake("KAMERA IP HIKVISION", "SZT", "material", 400), fake("KABEL UTP KAT 5E", "MB", "material", 3)];
  ok("dopasowanie dokładne", matchPriceItem("kamera ip hikvision", materials)?.price === 400);
  ok("dopasowanie częściowe (nazwa protokołu krótsza)", matchPriceItem("KABEL UTP KAT 5E.", materials)?.price === 3);
  ok("brak dopasowania → null", matchPriceItem("REJESTRATOR 8CH", materials) === null);
  ok("zbyt krótka wspólna część → null", matchPriceItem("IP", materials) === null);

  const services = [fake("MONTAŻ KAMERY", "SZT", "service", 999)];
  ok("materiał nie dopasuje się do listy samych usług", matchPriceItem("MONTAŻ KAMERY", services.filter((i) => i.kind === "material")) === null);

  const hourItems = [fake("ROBOCZOGODZINA", "RBH", "service", 100), fake("KAMERA IP", "SZT", "material", 400)];
  const hr = resolveHourRate(hourItems, { rateHour: 80 });
  ok("stawka RBH z cennika (usługa)", hr?.mode === "flat" && hr.rate === 100, hr);
  const hrFallback = resolveHourRate([fake("KAMERA IP", "SZT", "material", 400)], { rateHour: 80 });
  ok("brak pozycji RBH → stawka firmowa", hrFallback?.mode === "settings" && hrFallback.rate === 80, hrFallback);
  const hrMaterialRbh = resolveHourRate([fake("ROBOCZOGODZINA", "RBH", "material", 100)], { rateHour: 80 });
  ok("pozycja RBH oznaczona jako materiał NIE jest stawką godzinową", hrMaterialRbh?.mode === "settings", hrMaterialRbh);
  const hrTiered = resolveHourRate(
    [fake("PIERWSZA ROZPOCZĘTA GODZINA", "RBH", "service", 150), fake("KOLEJNA GODZINA", "RBH", "service", 90)],
    { rateHour: 80 }
  );
  ok("cennik schodkowy (pierwsza / kolejna godzina)", hrTiered?.mode === "tiered" && hrTiered.first === 150 && hrTiered.next === 90, hrTiered);

  const kmRate = resolveKmRate([fake("DOJAZD", "KM", "service", 2.5)], { rateKm: 1.2 });
  ok("stawka za km z cennika ma pierwszeństwo", kmRate?.rate === 2.5 && kmRate.itemName === "DOJAZD", kmRate);
  const kmFallback = resolveKmRate([fake("DOJAZD", "KM", "material", 2.5)], { rateKm: 1.2 });
  ok("pozycja KM oznaczona jako materiał → stawka firmowa", kmFallback?.rate === 1.2 && kmFallback.itemName === null, kmFallback);

  // -------------------------------------------------------------------------
  // 2. Podgląd: godziny z kalendarza, materiały, km z cache
  // -------------------------------------------------------------------------
  const r1 = makeRealization({ suffix: "Podglad" });
  makeProtocol(r1.id, "901");

  let res = await call("GET", `/realizations/${r1.id}/autofill`);
  ok("GET /autofill 200", res.status === 200 && Array.isArray(res.data?.suggestions), res);
  let sug = res.data.suggestions as Suggestion[];

  const hours = byField(sug, "actualHours");
  ok("godziny z kalendarza: 2 godz., źródło kalendarz", hours?.suggested === 2 && hours.source === "kalendarz", hours);
  ok("godziny w pustym polu są pewne (confident)", hours?.confident === true, hours);

  const amountHours = byField(sug, "amountHours");
  ok("kwota za godziny = 2 × 100 zł z cennika technika", amountHours?.suggested === 200 && amountHours.source === "cennik", amountHours);

  const material = byField(sug, "amountMaterial");
  ok(`materiały = 1230 zł + 10% narzutu = ${MATERIAL_TOTAL} zł`, material?.suggested === MATERIAL_TOTAL, material);
  ok("detal materiałów wypisuje pozycje i pozycje bez ceny", /3 × KAMERA IP/.test(material?.detail ?? "") && /narzut/.test(material?.detail ?? "") && /bez ceny/.test(material?.detail ?? ""), material?.detail);

  const warnings = res.data.warnings as string[];
  ok(
    "ostrzeżenie o materiale bez pozycji w cenniku",
    warnings.some((w) => w.includes("SRUBA MOTYLKOWA")),
    warnings
  );
  ok(
    "pozycja usługowa nie wycenia materiału (ostrzeżenie o MONTAZ KAMERY)",
    warnings.some((w) => w.includes("MONTAZ KAMERY")),
    warnings
  );
  ok(
    "pozycja bez ilości (wzór protokołu) nie generuje ostrzeżenia",
    !warnings.some((w) => w.includes("PESZEL")),
    warnings
  );

  const km = byField(sug, "actualKm");
  ok("km z cache: 310,5 × 2 (w obie strony) = 621", km?.suggested === 621 && km.source === "kalkulacja", km);
  ok("detal km opisuje metodę i cache", /trasa OSRM/.test(km?.detail ?? "") && /z cache/.test(km?.detail ?? ""), km?.detail);
  const amountKm = byField(sug, "amountKm");
  ok("kwota za km = 621 × 2,50 zł (pozycja KM z cennika)", amountKm?.suggested === 1552.5 && amountKm.source === "cennik", amountKm);
  const hourly = byField(sug, "hourlyCost");
  ok("koszt godzinowy z ustawień firmy = 55", hourly?.suggested === 55 && hourly.source === "ustawienia", hourly);
  ok("brak sugestii dla pola caretaker (brak źródła w modelu)", byField(sug, "caretaker") === undefined);

  const ctx = res.data.context;
  ok("kontekst: obiekt ustalony po wydarzeniu", ctx.object?.id === object.id, ctx.object);
  ok("kontekst: cennik wzięty od technika", ctx.priceList?.id === list.id && ctx.priceList?.via === "technik", ctx.priceList);
  ok("kontekst: dystans z cache (method route)", ctx.distance?.method === "route" && ctx.distance?.cached === true && ctx.distance?.totalKm === 621, ctx.distance);
  ok("kontekst: 1 wydarzenie kalendarza po 2 godz.", ctx.events?.length === 1 && ctx.events[0].hours === 2, ctx.events);

  // Przejazd w jedną stronę
  setSetting("company.km_round_trip", "0", null);
  res = await call("GET", `/realizations/${r1.id}/autofill`);
  ok("bez round trip: 310,5 km", byField(res.data.suggestions, "actualKm")?.suggested === 310.5, res.data.suggestions);
  setSetting("company.km_round_trip", "1", null);

  // -------------------------------------------------------------------------
  // 3. Protokół wygrywa z kalendarzem
  // -------------------------------------------------------------------------
  db.update(schema.protocols).set({ actualHours: 4 }).where(eq(schema.protocols.realizationId, r1.id)).run();
  res = await call("GET", `/realizations/${r1.id}/autofill`);
  sug = res.data.suggestions;
  ok("godziny z protokołu wygrywają z kalendarzem (4 godz.)", byField(sug, "actualHours")?.suggested === 4 && byField(sug, "actualHours")?.source === "protokół", byField(sug, "actualHours"));
  ok("detal wskazuje protokół i podaje wartość z kalendarza", /z protokołu P\/2029\/07\/901/.test(byField(sug, "actualHours")?.detail ?? "") && /kalendarz: 2/.test(byField(sug, "actualHours")?.detail ?? ""), byField(sug, "actualHours")?.detail);
  ok("kwota za godziny liczona z godzin protokołu (4 × 100)", byField(sug, "amountHours")?.suggested === 400, byField(sug, "amountHours"));

  // -------------------------------------------------------------------------
  // 4. Sprzeczność z ręcznie wpisaną wartością → confident: false
  // -------------------------------------------------------------------------
  db.update(schema.realizations).set({ amountMaterial: 777 }).where(eq(schema.realizations.id, r1.id)).run();
  res = await call("GET", `/realizations/${r1.id}/autofill`);
  const conflicting = byField(res.data.suggestions, "amountMaterial");
  ok("wartość wpisana ręcznie → confident:false + current w sugestii", conflicting?.confident === false && conflicting.current === 777, conflicting);
  db.update(schema.realizations).set({ amountMaterial: 0 }).where(eq(schema.realizations.id, r1.id)).run();

  db.update(schema.realizations).set({ hourlyCost: 55 }).where(eq(schema.realizations.id, r1.id)).run();
  res = await call("GET", `/realizations/${r1.id}/autofill`);
  ok("pole równe sugestii nie trafia na listę", byField(res.data.suggestions, "hourlyCost") === undefined, res.data.suggestions);
  db.update(schema.realizations).set({ hourlyCost: 0 }).where(eq(schema.realizations.id, r1.id)).run();

  // -------------------------------------------------------------------------
  // 5. Zapis: tylko wskazane pola + activity_log + ślad autofill
  // -------------------------------------------------------------------------
  res = await call("POST", `/realizations/${r1.id}/autofill`, { fields: [] });
  ok("pusta lista pól → 400", res.status === 400, res);
  res = await call("POST", `/realizations/${r1.id}/autofill`, { fields: ["nieistniejace"] });
  ok("nieznane pole → 400", res.status === 400 && /Nieznane pole/.test(res.error ?? ""), res);
  res = await call("POST", "/realizations/999999/autofill", { fields: ["actualHours"] });
  ok("nieistniejąca realizacja → 404", res.status === 404, res);

  res = await call("POST", `/realizations/${r1.id}/autofill`, { fields: ["actualHours", "amountMaterial"] });
  ok("POST /autofill 200", res.status === 200, res);
  ok("zapisane dokładnie wskazane pola", JSON.stringify(res.data.applied) === JSON.stringify(["actualHours", "amountMaterial"]), res.data.applied);

  const afterApply = db.select().from(schema.realizations).where(eq(schema.realizations.id, r1.id)).get()!;
  ok("actualHours zapisane (4)", afterApply.actualHours === 4, afterApply.actualHours);
  ok("amountMaterial zapisane (1353)", afterApply.amountMaterial === MATERIAL_TOTAL, afterApply.amountMaterial);
  ok("pola spoza listy nietknięte (amountHours = 0)", afterApply.amountHours === 0 && afterApply.actualKm === 0, afterApply);
  ok("realizacja w odpowiedzi ma przeliczone total (data i data.realization)", res.data.realization?.total === MATERIAL_TOTAL && res.data.total === MATERIAL_TOTAL, { top: res.data.total, nested: res.data.realization?.total });

  const marks = parseAutofillMarks(afterApply.autofill);
  ok("ślad automatu zapisany dla obu pól", marks.actualHours?.value === 4 && marks.amountMaterial?.value === MATERIAL_TOTAL, marks);
  ok("ślad zawiera źródło i opis", marks.amountMaterial?.source === "protokół" && (marks.amountMaterial?.detail ?? "").length > 0, marks.amountMaterial);

  const logs = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "realization"), eq(schema.activityLog.entityId, r1.id)))
    .all();
  ok("wpis w activity_log z opisem pól i dopiskiem „(przez automat)”", logs.length === 1 && /Uzupełniono automatycznie: godziny, materiały \(przez automat\)/.test(logs[0].summary ?? ""), logs.map((l) => l.summary));

  // Ręczna edycja kasuje ślad automatu dla zmienionego pola
  const fresh = db.select().from(schema.realizations).where(eq(schema.realizations.id, r1.id)).get()!;
  res = await call("PUT", `/realizations/${r1.id}`, {
    date: fresh.date,
    site: fresh.site,
    kind: fresh.kind,
    amountHours: fresh.amountHours,
    amountMaterial: 1000,
    amountKm: fresh.amountKm,
    discount: 0,
    actualHours: fresh.actualHours,
    actualKm: fresh.actualKm,
    hourlyCost: fresh.hourlyCost,
    contractor1: fresh.contractor1,
    expectedUpdatedAt: fresh.updatedAt,
  });
  ok("PUT realizacji 200", res.status === 200, res);
  const afterManual = db.select().from(schema.realizations).where(eq(schema.realizations.id, r1.id)).get()!;
  const marks2 = parseAutofillMarks(afterManual.autofill);
  ok("ręczna zmiana kasuje badge „auto” dla tego pola", marks2.amountMaterial === undefined, marks2);
  ok("badge „auto” zostaje przy polu, którego człowiek nie ruszył", marks2.actualHours?.value === 4, marks2);

  // -------------------------------------------------------------------------
  // 6. Realizacja zafakturowana — tylko podgląd
  // -------------------------------------------------------------------------
  const r2 = makeRealization({ suffix: "Zafakturowana" });
  db.update(schema.realizations).set({ invoiced: true }).where(eq(schema.realizations.id, r2.id)).run();
  makeProtocol(r2.id, "902", 3);

  res = await call("GET", `/realizations/${r2.id}/autofill`);
  ok("zafakturowana: podgląd działa", res.status === 200 && res.data.context.invoiced === true, res.status);
  res = await call("POST", `/realizations/${r2.id}/autofill`, { fields: ["actualHours"] });
  ok("zafakturowana: zapis → 400", res.status === 400 && /zafakturowana/.test(res.error ?? ""), res);
  const r2After = db.select().from(schema.realizations).where(eq(schema.realizations.id, r2.id)).get()!;
  ok("zafakturowana: wartości nietknięte", r2After.actualHours === 0 && r2After.amountMaterial === 0, r2After);

  // -------------------------------------------------------------------------
  // 7. Brak danych do km — ostrzeżenie zamiast błędu (i zero ruchu sieciowego)
  // -------------------------------------------------------------------------
  const r3 = makeRealization({ suffix: "Bez adresu", objectId: objectNoAddress.id });
  res = await call("GET", `/realizations/${r3.id}/autofill`);
  ok("brak adresu obiektu: 200 (nie 500)", res.status === 200, res.status);
  ok("brak adresu obiektu: brak sugestii km", byField(res.data.suggestions, "actualKm") === undefined, res.data.suggestions);
  ok("brak adresu obiektu: czytelne ostrzeżenie + distanceError", /Brak adresu obiektu/.test(res.data.context.distanceError ?? "") && (res.data.warnings as string[]).some((w) => /Kalkulacja km/.test(w)), res.data.context.distanceError);
  ok("brak adresu obiektu: godziny nadal policzone", byField(res.data.suggestions, "actualHours")?.suggested === 2, res.data.suggestions);

  // -------------------------------------------------------------------------
  // 8. Automat po podpisaniu protokołu
  // -------------------------------------------------------------------------
  const r4 = makeRealization({ suffix: "Podpis", amounts: { amountHours: 333 } });
  const p4 = makeProtocol(r4.id, "903", 5);

  res = await call("POST", `/protocols/${p4.id}/sign`, {
    signaturePng: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    signerName: "Klient Testowy",
  });
  ok("POST /protocols/:id/sign 200", res.status === 200, res);
  ok("odpowiedź podpisu niesie informację o automacie", Array.isArray(res.data?.autofill?.applied) && res.data.autofill.applied.includes("actualHours"), res.data?.autofill);

  const r4After = db.select().from(schema.realizations).where(eq(schema.realizations.id, r4.id)).get()!;
  ok("po podpisie: godziny z protokołu (5)", r4After.actualHours === 5, r4After.actualHours);
  ok("po podpisie: materiały wycenione", r4After.amountMaterial === MATERIAL_TOTAL, r4After.amountMaterial);
  ok("po podpisie: km z cache (621)", r4After.actualKm === 621, r4After.actualKm);
  ok("po podpisie: ręcznie wpisana kwota za godziny NIE nadpisana", r4After.amountHours === 333, r4After.amountHours);
  const signLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "realization"), eq(schema.activityLog.entityId, r4.id)))
    .all();
  ok("po podpisie: wpis w activity_log z dopiskiem o podpisie", signLog.some((l) => /po podpisaniu protokołu/.test(l.summary ?? "")), signLog.map((l) => l.summary));

  // Automat wyłączony → podpis nic nie uzupełnia
  setSetting("company.autofill_enabled", "0", null);
  const r5 = makeRealization({ suffix: "Podpis bez automatu" });
  const p5 = makeProtocol(r5.id, "904", 6);
  res = await call("POST", `/protocols/${p5.id}/sign`, {
    signaturePng: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    signerName: "Klient Testowy",
  });
  ok("podpis przy wyłączonym automacie: 200 i brak autofill", res.status === 200 && res.data?.autofill === null, res.data?.autofill);
  const r5After = db.select().from(schema.realizations).where(eq(schema.realizations.id, r5.id)).get()!;
  ok("podpis przy wyłączonym automacie: realizacja nietknięta", r5After.actualHours === 0 && r5After.amountMaterial === 0, r5After);
  setSetting("company.autofill_enabled", "1", null);

  // -------------------------------------------------------------------------
  // 9. Ograniczenie pól automatu w ustawieniach
  // -------------------------------------------------------------------------
  setSetting("company.autofill_fields", JSON.stringify(["actualHours"]), null);
  res = await call("GET", `/realizations/${r3.id}/autofill`);
  ok(
    "company.autofill_fields zawęża sugestie do wybranych pól",
    (res.data.suggestions as Suggestion[]).every((s) => s.field === "actualHours"),
    res.data.suggestions
  );
  deleteSetting("company.autofill_fields");

  // -------------------------------------------------------------------------
  // 10. Podgląd i zapis masowy
  // -------------------------------------------------------------------------
  const r6 = makeRealization({ suffix: "Masowa A", date: "2029-07-11" });
  makeProtocol(r6.id, "905", 2);
  const r7 = makeRealization({ suffix: "Masowa B", date: "2029-07-12" });
  makeProtocol(r7.id, "906", 3);

  res = await call("POST", "/realizations/autofill/bulk", { ids: [r6.id, r7.id, r2.id] });
  ok("bulk podgląd 200", res.status === 200 && res.data.applied === false, res);
  ok("bulk: 3 pozycje w odpowiedzi", res.data.items.length === 3, res.data.items?.length);
  ok("bulk: zafakturowana oznaczona jako pominięta", res.data.items.find((i: any) => i.id === r2.id)?.error?.includes("zafakturowana"), res.data.items);
  ok("bulk podgląd nic nie zapisuje", db.select().from(schema.realizations).where(eq(schema.realizations.id, r6.id)).get()!.actualHours === 0);

  res = await call("POST", "/realizations/autofill/bulk", { ids: [r6.id, r7.id, r2.id], apply: true });
  ok("bulk zapis 200", res.status === 200 && res.data.applied === true, res.status);
  const r6After = db.select().from(schema.realizations).where(eq(schema.realizations.id, r6.id)).get()!;
  ok("bulk zapisał godziny z protokołu (2)", r6After.actualHours === 2, r6After.actualHours);
  ok("bulk zapisał materiały i km", r6After.amountMaterial === MATERIAL_TOTAL && r6After.actualKm === 621, r6After);
  ok("bulk nie ruszył zafakturowanej", db.select().from(schema.realizations).where(eq(schema.realizations.id, r2.id)).get()!.actualHours === 0);
  res = await call("POST", "/realizations/autofill/bulk", { ids: [] });
  ok("bulk bez ids → 400", res.status === 400, res.status);

  // -------------------------------------------------------------------------
  // 11. computeAutofill dla nieistniejącej realizacji
  // -------------------------------------------------------------------------
  ok("computeAutofill dla nieistniejącego id → null", (await computeAutofill(999_999)) === null);

  // -------------------------------------------------------------------------
  // 12. Wstępne podliczenie po oznaczeniu wydarzenia jako „wykonane”
  //     (src/lib/calendar-realizations.ts → autofillAfterEventDone)
  // -------------------------------------------------------------------------
  const mctx: MutationCtx = { user };
  const eventBase = (over: Record<string, unknown> = {}) => ({
    type: "serwis",
    title: `${PREFIX} Wydarzenie`,
    startAt: "2029-07-10T08:00",
    endAt: "2029-07-10T10:00",
    objectId: object.id,
    technicianIds: [tech.id],
    status: "planned",
    ...over,
  });
  const newEvent = (over: Record<string, unknown> = {}) =>
    db.transaction((tx) => createEvent(tx, parseInput(eventBase(over)), mctx).firstId);
  const editEvent = (id: number, over: Record<string, unknown> = {}) =>
    db.transaction((tx) => updateEvent(tx, id, parseInput(eventBase(over)), "this", mctx));
  const eventRow = (id: number) =>
    db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get()!;
  const realizationOf = (id: number) => {
    const rid = eventRow(id).realizationId;
    return rid == null ? undefined : db.select().from(schema.realizations).where(eq(schema.realizations.id, rid)).get();
  };
  const realizationLogs = (realizationId: number) =>
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "realization"), eq(schema.activityLog.entityId, realizationId)))
      .all();
  const eventLogs = (eventId: number) =>
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, eventId)))
      .all();

  setSetting("company.autofill_on_event_done", "1", null);
  deleteSetting(CALENDAR_FIELDS.autoRealization.dbKey); // tryb domyślny: on_create

  // 12a. planned → done: pola pewne policzone, ręcznie wpisane nietknięte
  const evDone = newEvent({ title: `${PREFIX} Done A` });
  const rDoneId = eventRow(evDone).realizationId!;
  ok("wydarzenie planned: realizacja powstała, kwoty zerowe", realizationOf(evDone)?.amountHours === 0, realizationOf(evDone));
  // Ręcznie wpisana kwota za km — automat nie ma prawa jej ruszyć.
  db.update(schema.realizations).set({ amountKm: 999 }).where(eq(schema.realizations.id, rDoneId)).run();

  editEvent(evDone, { title: `${PREFIX} Done A`, status: "done" });
  let flushed = await flushEventDoneAutofill();
  let rDone = realizationOf(evDone)!;
  ok("status → done: kwota za godziny policzona (2 × 100)", rDone.amountHours === 200, rDone.amountHours);
  ok("status → done: km z cache (621) i koszt godzinowy (55)", rDone.actualKm === 621 && rDone.hourlyCost === 55, rDone);
  ok("status → done: godziny z wydarzenia (2)", rDone.actualHours === 2, rDone.actualHours);
  ok("status → done: ręcznie wpisana kwota za km NIE nadpisana", rDone.amountKm === 999, rDone.amountKm);
  ok(
    "status → done: materiały zostają na 0 (protokół po „wykonane” nie ma pozycji z ilością)",
    rDone.amountMaterial === 0,
    rDone.amountMaterial
  );
  ok(
    "status → done: ostrzeżenie o pustym protokole zamiast wyceny materiałów",
    flushed.some((o) => o.realizationId === rDoneId && o.warnings.some((w) => /nie ma pozycji z podaną ilością/.test(w))),
    flushed
  );
  const doneMarks = parseAutofillMarks(rDone.autofill);
  ok("status → done: ślad automatu na policzonych polach", doneMarks.amountHours?.value === 200 && doneMarks.actualKm?.value === 621, doneMarks);
  ok("status → done: brak śladu na polu wpisanym ręcznie", doneMarks.amountKm === undefined, doneMarks);
  const doneLogs = realizationLogs(rDoneId);
  ok(
    "status → done: jeden wpis w activity_log „Wstępnie podliczono … (przez automat)”",
    doneLogs.length === 1 &&
      /^Wstępnie podliczono realizację po oznaczeniu wydarzenia #\d+ jako wykonane: .+ \(przez automat\)$/.test(doneLogs[0].summary ?? ""),
    doneLogs.map((l) => l.summary)
  );

  // 12b. done → planned nie cofa wyliczeń (tylko ostrzeżenie), a ponowne „done” nie dubluje logu
  editEvent(evDone, { title: `${PREFIX} Done A`, status: "planned" });
  await flushEventDoneAutofill();
  rDone = realizationOf(evDone)!;
  ok("cofnięcie statusu: wyliczenia zostają", rDone.amountHours === 200 && rDone.actualKm === 621, rDone);
  ok(
    "cofnięcie statusu: ostrzeżenie w activity_log wydarzenia",
    eventLogs(evDone).some((l) => /Cofnięto status „wykonane”, ale wstępne wyliczenia realizacji #\d+ zostają/.test(l.summary ?? "")),
    eventLogs(evDone).map((l) => l.summary)
  );

  editEvent(evDone, { title: `${PREFIX} Done A`, status: "done" });
  await flushEventDoneAutofill();
  ok("ponowne „done”: brak drugiego wpisu w activity_log", realizationLogs(rDoneId).length === 1, realizationLogs(rDoneId).map((l) => l.summary));
  ok("ponowne „done”: wartości bez zmian", realizationOf(evDone)?.amountHours === 200, realizationOf(evDone));

  // 12c. realization_optout — automat trzyma się z daleka
  const evOptout = newEvent({ title: `${PREFIX} Optout` });
  editEvent(evOptout, { title: `${PREFIX} Optout`, status: "done", realizationOptout: true });
  await flushEventDoneAutofill();
  const rOptout = realizationOf(evOptout)!;
  ok("optout: realizacja nietknięta przez automat", rOptout.amountHours === 0 && rOptout.actualKm === 0, rOptout);
  ok("optout: brak wpisu w activity_log realizacji", realizationLogs(rOptout.id).length === 0, realizationLogs(rOptout.id).map((l) => l.summary));

  // 12d. realizacja zafakturowana — pomijana
  const evInvoiced = newEvent({ title: `${PREFIX} Zafakturowany` });
  const rInvId = eventRow(evInvoiced).realizationId!;
  db.update(schema.realizations).set({ invoiced: true }).where(eq(schema.realizations.id, rInvId)).run();
  editEvent(evInvoiced, { title: `${PREFIX} Zafakturowany`, status: "done" });
  await flushEventDoneAutofill();
  const rInv = db.select().from(schema.realizations).where(eq(schema.realizations.id, rInvId)).get()!;
  ok("zafakturowana: automat jej nie dotyka", rInv.amountHours === 0 && rInv.actualKm === 0 && rInv.hourlyCost === 0, rInv);
  ok("zafakturowana: brak wpisu autofill w activity_log", realizationLogs(rInvId).length === 0, realizationLogs(rInvId).map((l) => l.summary));

  // 12e. tryb calendar.auto_realization = "on_done": realizacja powstaje i od razu jest podliczana
  setSetting(CALENDAR_FIELDS.autoRealization.dbKey, "on_done", null);
  const evOnDone = newEvent({ title: `${PREFIX} OnDone` });
  ok("tryb on_done: przy planned realizacja jeszcze nie istnieje", eventRow(evOnDone).realizationId === null, eventRow(evOnDone).realizationId);
  editEvent(evOnDone, { title: `${PREFIX} OnDone`, status: "done" });
  await flushEventDoneAutofill();
  const rOnDone = realizationOf(evOnDone);
  ok("tryb on_done: realizacja powstała po oznaczeniu jako wykonane", rOnDone != null, eventRow(evOnDone).realizationId);
  ok("tryb on_done: od razu podliczona (godziny, kwota, km)", rOnDone?.actualHours === 2 && rOnDone?.amountHours === 200 && rOnDone?.actualKm === 621, rOnDone);
  deleteSetting(CALENDAR_FIELDS.autoRealization.dbKey);

  // 12f. wyłączone company.autofill_on_event_done → nic się nie liczy
  setSetting("company.autofill_on_event_done", "0", null);
  const evOff = newEvent({ title: `${PREFIX} Wylaczony` });
  editEvent(evOff, { title: `${PREFIX} Wylaczony`, status: "done" });
  await flushEventDoneAutofill();
  const rOff = realizationOf(evOff)!;
  ok("autofill_on_event_done = 0: realizacja nietknięta", rOff.amountHours === 0 && rOff.actualKm === 0, rOff);
  ok("autofill_on_event_done = 0: brak wpisu w activity_log", realizationLogs(rOff.id).length === 0, realizationLogs(rOff.id).map((l) => l.summary));
  setSetting("company.autofill_on_event_done", "1", null);

  // 12g. brak wpisu w geo_cache (i brak sieci) → ostrzeżenie, ale zapis wydarzenia przechodzi
  const evNoGeo = newEvent({ title: `${PREFIX} Bez geo`, objectId: objectNoCoords.id });
  editEvent(evNoGeo, { title: `${PREFIX} Bez geo`, objectId: objectNoCoords.id, status: "done" });
  flushed = await flushEventDoneAutofill();
  const rNoGeo = realizationOf(evNoGeo)!;
  ok("brak geo_cache: wydarzenie zapisane ze statusem done", eventRow(evNoGeo).status === "done", eventRow(evNoGeo).status);
  ok("brak geo_cache: km pominięte, godziny i stawka policzone", rNoGeo.actualKm === 0 && rNoGeo.amountHours === 200, rNoGeo);
  ok(
    "brak geo_cache: czytelne ostrzeżenie o kalkulacji km",
    flushed.some((o) => o.realizationId === rNoGeo.id && o.warnings.some((w) => /Kalkulacja km/.test(w))),
    flushed
  );

  // 12h. ścieżka asystenta (propose_changes → applyChange) odpala ten sam hak
  const evAsst = newEvent({ title: `${PREFIX} Asystent` });
  const rAsstId = eventRow(evAsst).realizationId!;
  applyChange(
    { kind: "status", eventId: evAsst, status: "done" },
    0,
    { cfg: { ...ASSISTANT_DEFAULTS }, today: "2029-07-20" },
    { user }
  );
  await flushEventDoneAutofill();
  const rAsst = db.select().from(schema.realizations).where(eq(schema.realizations.id, rAsstId)).get()!;
  ok("asystent: zmiana statusu na done też podlicza realizację", rAsst.amountHours === 200 && rAsst.actualKm === 621, rAsst);
  ok(
    "asystent: wpis autofill z dopiskiem „(przez automat)” (liczy automat, nie asystent)",
    realizationLogs(rAsstId).some((l) => /Wstępnie podliczono realizację .* \(przez automat\)$/.test(l.summary ?? "")),
    realizationLogs(rAsstId).map((l) => l.summary)
  );
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  cleanup();
  const leftRealizations = db.select().from(schema.realizations).where(like(schema.realizations.site, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych realizacji", leftRealizations.length === 0, leftRealizations.length);
  const leftLists = db.select().from(schema.priceLists).where(like(schema.priceLists.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych cenników", leftLists.length === 0, leftLists.length);
  const leftEvents = db.select().from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych wydarzeń", leftEvents.length === 0, leftEvents.length);
  const leftObjects = db.select().from(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych obiektów", leftObjects.length === 0, leftObjects.length);
  const leftCache = db.select().from(schema.geoCache).where(inArray(schema.geoCache.key, [...cacheKeys])).all();
  ok("sprzątanie: brak testowych wpisów geo_cache", leftCache.length === 0, leftCache.length);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
