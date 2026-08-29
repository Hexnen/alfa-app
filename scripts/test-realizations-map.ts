/**
 * Test lokalizacji realizacji (mapa realizacji miesiąca) na prawdziwej bazie
 * (data/alfa.db), przez trasy Hono (app.request) z podstawionym userem:
 *   npx tsx scripts/test-realizations-map.ts
 *
 * Zakres:
 *   - GET /realizations?year&month dokłada `location` z KLUCZA `realizations.object_id`
 *     (source "realizacja"),
 *   - gdy klucza brak — z `calendar_events.object_id` wpiętego wydarzenia (source "kalendarz"),
 *   - klucz realizacji wygrywa z kluczem wydarzenia,
 *   - sama zgodna nazwa w `site` NIE podpina obiektu (dopasowanie po nazwie zostało
 *     usunięte — myliło się w 29 z 289 realizacji, patrz src/lib/object-identity.ts),
 *   - obiekt bez współrzędnych: location z lat/lng = null,
 *   - brak jakiegokolwiek klucza → location null,
 *   - GET /company/office zwraca adres i współrzędne biura z ustawień firmy.
 *
 * Dane testowe: obiekty i realizacje z prefiksem ZZ-MAPA, miesiąc 2029-07 (poza
 * danymi produkcyjnymi). Sprząta po sobie HARD (wydarzenia, realizacje, obiekty),
 * także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { asc, eq, inArray, like } from "drizzle-orm";
import realizations from "../src/routes/realizations.js";
import company from "../src/routes/company.js";
import type { User } from "../src/db/schema.js";

let failures = 0;

/**
 * Kanarek „dane produkcyjne nietknięte”: najstarsza realizacja istniejąca PRZED testem.
 * Wcześniej było tu twarde `id === 1`, ale baza demonstracyjna numeruje realizacje od nowa.
 */
const canaryRealizationId: number | null =
  db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .orderBy(asc(schema.realizations.id))
    .get()?.id ?? null;
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
  source: "realizacja" | "kalendarz";
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

function insertRealization(day: string, site: string, objectId: number | null = null): number {
  return db
    .insert(schema.realizations)
    .values({
      date: `${YEAR}-${String(MONTH).padStart(2, "0")}-${day}`,
      // `objectId` to klucz, `site` obok niego jest wyłącznie migawką nazwy.
      objectId,
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
  // Obiekt A — ze współrzędnymi, wskazywany kluczem realizacji.
  const objA = insertObject("Obiekt A", 52.1, 21.05);
  // Obiekt B — ze współrzędnymi; jego NAZWA pojawi się w `site` bez żadnego klucza.
  const objB = insertObject("Obiekt B", 50.06, 19.94);
  // Obiekt C — BEZ współrzędnych.
  const objC = insertObject("Obiekt C", null, null);

  // Klucz na realizacji — źródło prawdy.
  const rOwn = insertRealization("02", `${PREFIX} Obiekt A`, objA);

  // Bez klucza na realizacji, ale wydarzenie zna obiekt (wpis sprzed migracji tożsamości).
  const rEvent = insertRealization("03", `${PREFIX} Obiekt A`);
  insertEvent(objA, rEvent, "03");

  // `site` to DOKŁADNA nazwa istniejącego obiektu B, ale nie ma żadnego klucza →
  // location musi być null. To jest asercja pilnująca, żeby nie wróciło dopasowanie
  // po nazwie (myliło się w 29 z 289 realizacji).
  const rNameOnly = insertRealization("04", `${PREFIX} Obiekt B`);

  // Nic nie wskazuje obiektu → location null.
  const rNone = insertRealization("05", `${PREFIX} Nieznany Obiekt`);

  // Obiekt bez współrzędnych → location jest, ale lat/lng = null (front liczy go
  // jako „bez lokalizacji”, zamiast gubić w ogóle).
  const rNoCoords = insertRealization("06", `${PREFIX} Obiekt C`, objC);

  // Klucz realizacji (C) kontra klucz wydarzenia (A) — wygrywa realizacja.
  const rConflict = insertRealization("07", `${PREFIX} Obiekt C`, objC);
  insertEvent(objA, rConflict, "07");

  const rows = await list();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 1. Lokalizacja z klucza realizacji
  const own = byId.get(rOwn);
  ok(
    "realizations.object_id → location.source=realizacja ze współrzędnymi obiektu",
    own?.location?.source === "realizacja" &&
      own?.location?.objectId === objA &&
      own?.location?.lat === 52.1 &&
      own?.location?.lng === 21.05 &&
      own?.location?.city === "Testowo",
    own?.location
  );

  // 2. Zastępczo: klucz z wydarzenia
  const a = byId.get(rEvent);
  ok(
    "brak object_id → obiekt z klucza wydarzenia (source=kalendarz)",
    a?.location?.source === "kalendarz" && a?.location?.objectId === objA && a?.location?.lat === 52.1,
    a?.location
  );

  // 3. Sama nazwa nie wystarcza
  const b = byId.get(rNameOnly);
  ok(
    "zgodna nazwa w site bez klucza → location = null (żadnego dopasowania po nazwie)",
    b?.location === null,
    b?.location
  );

  // 4. Brak jakiegokolwiek powiązania
  const n = byId.get(rNone);
  ok("nic nie wskazuje obiektu → location = null", n?.location === null, n?.location);

  // 5. Obiekt bez współrzędnych
  const c = byId.get(rNoCoords);
  ok(
    "obiekt bez współrzędnych → location z lat/lng = null",
    c?.location?.source === "realizacja" &&
      c?.location?.objectId === objC &&
      c?.location?.lat === null &&
      c?.location?.lng === null,
    c?.location
  );

  // 6. Klucz realizacji ma pierwszeństwo przed kluczem wydarzenia
  const conflict = byId.get(rConflict);
  ok(
    "klucz realizacji wygrywa z kluczem wydarzenia",
    conflict?.location?.objectId === objC && conflict?.location?.source === "realizacja",
    conflict?.location
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
  ok(
    "realizacja sprzed testu nadal istnieje",
    canaryRealizationId === null ||
      !!db.select().from(schema.realizations).where(eq(schema.realizations.id, canaryRealizationId)).get(),
    canaryRealizationId
  );
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
