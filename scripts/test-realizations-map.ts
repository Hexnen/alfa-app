/**
 * Test lokalizacji realizacji (mapa realizacji miesiąca) na prawdziwej bazie
 * (data/alfa.db), przez trasy Hono (app.request) z podstawionym userem:
 *   npx tsx scripts/test-realizations-map.ts
 *
 * Zakres:
 *   - GET /realizations?year&month dokłada `location` z obiektu wskazanego przez
 *     wydarzenie kalendarza (source "event"),
 *   - fallback po nazwie `site` (dokładna, bez wielkości liter) → source "name",
 *   - wydarzenie wygrywa z dopasowaniem po nazwie,
 *   - obiekt bez współrzędnych: location z lat/lng = null (event) / brak dopasowania po nazwie,
 *   - brak jakiegokolwiek obiektu → location null,
 *   - GET /company/office zwraca adres i współrzędne biura z ustawień firmy.
 *
 * Dane testowe: obiekty i realizacje z prefiksem ZZ-MAPA, miesiąc 2029-07 (poza
 * danymi produkcyjnymi). Sprząta po sobie HARD (wydarzenia, realizacje, obiekty),
 * także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { eq, inArray, like } from "drizzle-orm";
import realizations from "../src/routes/realizations.js";
import company from "../src/routes/company.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-MAPA";
const YEAR = 2029;
const MONTH = 7;

const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}
const contractor = db.select().from(schema.contractors).limit(1).get();
if (!contractor) {
  console.error("Brak kontrahenta w bazie (obiekt wymaga contractor_id) — przerywam.");
  process.exit(1);
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", user);
  return next();
});
app.route("/realizations", realizations);
app.route("/company", company);

interface RealizationLocationJson {
  objectId: number;
  name: string;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  source: "event" | "name";
}
interface RealizationJson {
  id: number;
  site: string;
  calendarEventId: number | null;
  location: RealizationLocationJson | null;
}

// --- Sprzątanie ------------------------------------------------------------
function cleanup(): { events: number; realizations: number; objects: number } {
  const realIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(like(schema.realizations.site, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const objIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((o) => o.id);

  let events = 0;
  if (realIds.length) {
    events += db
      .delete(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.realizationId, realIds))
      .run().changes;
  }
  if (objIds.length) {
    events += db
      .delete(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.objectId, objIds))
      .run().changes;
  }
  const r = realIds.length
    ? db.delete(schema.realizations).where(inArray(schema.realizations.id, realIds)).run().changes
    : 0;
  const o = objIds.length
    ? db.delete(schema.objects).where(inArray(schema.objects.id, objIds)).run().changes
    : 0;
  return { events, realizations: r, objects: o };
}
cleanup();

// --- Dane testowe ----------------------------------------------------------
function insertObject(name: string, lat: number | null, lng: number | null): number {
  return db
    .insert(schema.objects)
    .values({
      contractorId: contractor!.id,
      name: `${PREFIX} ${name}`,
      address: "ul. Testowa 1",
      city: "Testowo",
      type: "monitoring",
      installationType: "new",
      status: "active",
      department: "technical",
      latitude: lat,
      longitude: lng,
    })
    .returning()
    .get().id;
}

function insertRealization(day: string, site: string): number {
  return db
    .insert(schema.realizations)
    .values({
      date: `${YEAR}-${String(MONTH).padStart(2, "0")}-${day}`,
      site,
      kind: "service",
      amountHours: 100,
      amountMaterial: 0,
      amountKm: 0,
      discount: 0,
      note: "test mapy",
      invoiced: false,
      caretaker: "",
      contractor1: "Jan Testowy",
      contractor2: "",
      actualHours: 2,
      actualKm: 10,
      hourlyCost: 50,
    })
    .returning()
    .get().id;
}

function insertEvent(objectId: number | null, realizationId: number, day: string): number {
  const date = `${YEAR}-${String(MONTH).padStart(2, "0")}-${day}`;
  return db
    .insert(schema.calendarEvents)
    .values({
      type: "serwis",
      title: `${PREFIX} wydarzenie`,
      startAt: date,
      endAt: date,
      allDay: true,
      status: "done",
      department: "technical",
      objectId,
      realizationId,
    })
    .returning()
    .get().id;
}

const list = async (): Promise<RealizationJson[]> => {
  const res = await app.request(`/realizations?year=${YEAR}&month=${MONTH}`);
  const json = (await res.json()) as { data: RealizationJson[] };
  return json.data;
};

async function main() {
  // Obiekt A — ze współrzędnymi, podpięty przez wydarzenie.
  const objA = insertObject("Obiekt A", 52.1, 21.05);
  // Obiekt B — ze współrzędnymi, wiązany tylko po nazwie (inna wielkość liter w site).
  const objB = insertObject("Obiekt B", 50.06, 19.94);
  // Obiekt C — BEZ współrzędnych.
  const objC = insertObject("Obiekt C", null, null);

  const rEvent = insertRealization("02", `${PREFIX} Obiekt A`);
  insertEvent(objA, rEvent, "02");

  // site pisane inaczej niż nazwa obiektu (wielkość liter) → dopasowanie po nazwie
  const rName = insertRealization("03", `${PREFIX} OBIEKT b`);

  // site nie pasuje do żadnego obiektu → location null
  const rNone = insertRealization("04", `${PREFIX} Nieznany Obiekt`);

  // obiekt z wydarzenia, ale bez współrzędnych → location z lat/lng null
  const rNoCoords = insertRealization("05", `${PREFIX} Obiekt C`);
  insertEvent(objC, rNoCoords, "05");

  // site wskazuje obiekt B, ale wydarzenie wskazuje A → wygrywa wydarzenie
  const rConflict = insertRealization("06", `${PREFIX} Obiekt B`);
  insertEvent(objA, rConflict, "06");

  // obiekt bez współrzędnych, dopasowanie tylko po nazwie → nie szukamy go wcale
  const rNameNoCoords = insertRealization("07", `${PREFIX} Obiekt C`);

  const rows = await list();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 1. Lokalizacja z wydarzenia kalendarza
  const a = byId.get(rEvent);
  ok(
    "wydarzenie → location.source=event z współrzędnymi obiektu",
    a?.location?.source === "event" &&
      a?.location?.objectId === objA &&
      a?.location?.lat === 52.1 &&
      a?.location?.lng === 21.05 &&
      a?.location?.city === "Testowo",
    a?.location
  );

  // 2. Dopasowanie po nazwie (case-insensitive)
  const b = byId.get(rName);
  ok(
    "brak wydarzenia → dopasowanie po nazwie site (bez wielkości liter)",
    b?.location?.source === "name" && b?.location?.objectId === objB && b?.location?.lat === 50.06,
    b?.location
  );

  // 3. Brak obiektu o takiej nazwie
  const n = byId.get(rNone);
  ok("nieznany obiekt → location = null", n?.location === null, n?.location);

  // 4. Obiekt z wydarzenia bez współrzędnych
  const c = byId.get(rNoCoords);
  ok(
    "obiekt bez współrzędnych (z wydarzenia) → location z lat/lng = null",
    c?.location?.source === "event" &&
      c?.location?.objectId === objC &&
      c?.location?.lat === null &&
      c?.location?.lng === null,
    c?.location
  );

  // 5. Wydarzenie ma pierwszeństwo przed nazwą
  const conflict = byId.get(rConflict);
  ok(
    "wydarzenie wygrywa z dopasowaniem po nazwie",
    conflict?.location?.objectId === objA && conflict?.location?.source === "event",
    conflict?.location
  );

  // 6. Po nazwie szukamy tylko obiektów ze współrzędnymi
  const nameNoCoords = byId.get(rNameNoCoords);
  ok(
    "dopasowanie po nazwie pomija obiekty bez współrzędnych → location = null",
    nameNoCoords?.location === null,
    nameNoCoords?.location
  );

  // 7. Biuro z ustawień firmy
  const res = await app.request("/company/office");
  const officeJson = (await res.json()) as {
    success: boolean;
    data: { address: string; city: string; lat: number | null; lng: number | null };
  };
  const dbLat = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, "company.office_lat"))
    .get();
  ok(
    "GET /company/office → 200 + { address, city, lat, lng }",
    res.status === 200 &&
      officeJson.success === true &&
      typeof officeJson.data.address === "string" &&
      typeof officeJson.data.city === "string" &&
      "lat" in officeJson.data &&
      "lng" in officeJson.data,
    officeJson
  );
  if (dbLat?.value) {
    ok(
      "współrzędne biura zgodne z app_settings",
      officeJson.data.lat === parseFloat(dbLat.value),
      { api: officeJson.data.lat, db: dbLat.value }
    );
  }

  // 8. Dane produkcyjne nietknięte
  const prod = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(eq(schema.realizations.id, 1))
    .get();
  ok("realizacja #1 (produkcyjna) nadal istnieje", prod?.id === 1, prod);
}

main()
  .catch((e) => {
    failures++;
    console.error("FAIL (wyjątek):", e);
  })
  .finally(() => {
    const removed = cleanup();
    console.log(
      `\nSprzątanie: usunięto ${removed.realizations} realizacji, ${removed.events} wydarzeń i ${removed.objects} obiektów testowych.`
    );
    console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} testów nie przeszło`);
    process.exit(failures === 0 ? 0 : 1);
  });
