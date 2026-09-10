/**
 * Test trasy `GET /links/distances` — „ile stąd do biura" i „ile stąd do obiektu"
 * dla pinezki wklejonej w notatce (karta z mini-mapą).
 *
 * Uruchamiaj NA KOPII bazy (test przestawia współrzędne biura w `app_settings`
 * i wstawia obiekty testowe):
 *   npx tsx scripts/test-on-copy.ts scripts/test-link-distances.ts
 *
 * Sieci nie ma: OSRM i Nominatim idą przez wstrzyknięty `setGeoFetch`, więc
 * wynik zależy wyłącznie od tego, co ten mock odpowie (albo czego nie odpowie).
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { setGeoFetch } from "../src/lib/geo.js";
import { setSetting, deleteSetting } from "../src/lib/settings.js";
import linksRoutes from "../src/routes/links.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

if (!process.env.ALFA_DB_PATH) {
  console.error("Uruchom przez scripts/test-on-copy.ts — test pisze do bazy.");
  process.exit(1);
}

type User = typeof schema.users.$inferSelect;
const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkowników w bazie.");
  process.exit(1);
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", user);
  return next();
});
app.route("/links", linksRoutes);

interface DistancePayload {
  office?: { km: number; minutes: number; method: string } | null;
  object?: { km: number; minutes: number; method: string; objectName?: string } | null;
}

const call = async (query: string) => {
  const res = await app.request(`/links/distances?${query}`);
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: DistancePayload; error?: string }
    | null;
  return { status: res.status, ...(json ?? {}) };
};

/** Odpowiedź OSRM `/route`: 12 km, 18 min. */
function osrmResponse(meters: number, seconds: number): Response {
  return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: meters, duration: seconds }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// --- Fikstury --------------------------------------------------------------
// Współrzędne celowo „nieokrągłe" i wymyślone: gdyby para trafiła się w `geo_cache`
// skopiowanej bazy, test mierzyłby cache zamiast zamockowanego OSRM.
const OFFICE = { lat: 52.123456, lng: 20.987654 };
const PIN = { lat: 52.234567, lng: 21.098765 };
const OBJECT_POINT = { lat: 52.345678, lng: 21.198765 };

setSetting("company.office_lat", String(OFFICE.lat), user.id);
setSetting("company.office_lng", String(OFFICE.lng), user.id);
setSetting("company.km_source", "route", user.id);

const contractor = db.select({ id: schema.contractors.id }).from(schema.contractors).limit(1).get();
if (!contractor) {
  console.error("Brak kontrahentów w bazie — nie ma do czego podpiąć obiektu testowego.");
  process.exit(1);
}

const now = new Date().toISOString();
const withCoords = db
  .insert(schema.objects)
  .values({
    name: "TEST-DYSTANSE obiekt z pinezką",
    contractorId: contractor.id,
    type: "monitoring",
    installationType: "new",
    latitude: OBJECT_POINT.lat,
    longitude: OBJECT_POINT.lng,
    createdAt: now,
    updatedAt: now,
  })
  .returning({ id: schema.objects.id })
  .get();

const withoutCoords = db
  .insert(schema.objects)
  .values({
    name: "TEST-DYSTANSE obiekt bez pinezki",
    contractorId: contractor.id,
    type: "monitoring",
    installationType: "new",
    createdAt: now,
    updatedAt: now,
  })
  .returning({ id: schema.objects.id })
  .get();

const cleanup = () => {
  db.delete(schema.objects).where(eq(schema.objects.id, withCoords.id)).run();
  db.delete(schema.objects).where(eq(schema.objects.id, withoutCoords.id)).run();
  deleteSetting("company.office_lat");
  deleteSetting("company.office_lng");
  deleteSetting("company.km_source");
  setGeoFetch(null);
};

try {
  // --- A. Walidacja --------------------------------------------------------
  console.log("\n=== A. Walidacja wejścia ===");
  setGeoFetch((async () => {
    throw new Error("sieć NIE POWINNA być ruszana przy błędnym wejściu");
  }) as typeof fetch);

  ok("lat=999 → 400", (await call("lat=999&lng=21")).status === 400);
  ok("lng=999 → 400", (await call("lat=52&lng=999")).status === 400);
  ok("brak współrzędnych → 400", (await call("")).status === 400);
  ok("lat nie-liczba → 400", (await call("lat=abc&lng=21")).status === 400);
  ok("objectId=0 → 400", (await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=0`)).status === 400);
  ok("objectId nie-liczba → 400", (await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=abc`)).status === 400);

  // --- B. Oba dystanse -----------------------------------------------------
  console.log("\n=== B. Biuro + obiekt (OSRM odpowiada) ===");
  let osrmCalls = 0;
  setGeoFetch((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("router.project-osrm.org")) throw new Error(`nieoczekiwane zapytanie: ${url}`);
    // Pinezka stoi na nazwanej ulicy (distance 0) — przyklejanie nic nie zmienia.
    if (url.includes("/nearest/")) {
      return new Response(
        JSON.stringify({
          code: "Ok",
          waypoints: [{ location: [PIN.lng, PIN.lat], name: "Testowa", distance: 0 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    osrmCalls++;
    // Pierwsza trasa (biuro) 12,4 km / 18 min, druga (obiekt) 3,1 km / 7 min.
    return osrmCalls === 1 ? osrmResponse(12_400, 18 * 60) : osrmResponse(3_100, 7 * 60);
  }) as typeof fetch);

  const both = await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=${withCoords.id}`);
  ok("200 i oba dystanse", both.status === 200 && !!both.data?.office && !!both.data?.object, both);
  ok(
    "biuro: 12,4 km / 18 min / trasa",
    both.data?.office?.km === 12.4 && both.data?.office?.minutes === 18 && both.data?.office?.method === "route",
    both.data?.office
  );
  ok(
    "obiekt: 3,1 km / 7 min / trasa + nazwa",
    both.data?.object?.km === 3.1 &&
      both.data?.object?.minutes === 7 &&
      both.data?.object?.method === "route" &&
      both.data?.object?.objectName === "TEST-DYSTANSE obiekt z pinezką",
    both.data?.object
  );
  ok("dwa zapytania do OSRM (biuro + obiekt)", osrmCalls === 2, osrmCalls);

  // Drugie pytanie o ten sam punkt schodzi w całości z `geo_cache`.
  setGeoFetch((async () => {
    throw new Error("OSRM NIE POWINIEN być pytany drugi raz");
  }) as typeof fetch);
  const cached = await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=${withCoords.id}`);
  ok(
    "powtórka bez sieci (cache `geo_cache`)",
    cached.status === 200 && cached.data?.office?.km === 12.4 && cached.data?.object?.km === 3.1,
    cached
  );

  // --- C. Obiekt bez współrzędnych ----------------------------------------
  console.log("\n=== C. Obiekt bez pinezki ===");
  const noObject = await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=${withoutCoords.id}`);
  ok(
    "obiekt bez współrzędnych → object: null, biuro zostaje",
    noObject.status === 200 && noObject.data?.object === null && !!noObject.data?.office,
    noObject
  );

  const missing = await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=99999999`);
  ok("nieistniejący obiekt → object: null (bez 404)", missing.status === 200 && missing.data?.object === null, missing);

  const noId = await call(`lat=${PIN.lat}&lng=${PIN.lng}`);
  ok("bez objectId → samo biuro", noId.status === 200 && noId.data?.object === null && !!noId.data?.office, noId);

  // --- D. OSRM pada --------------------------------------------------------
  console.log("\n=== D. OSRM niedostępny ===");
  const FAR = { lat: 51.876543, lng: 19.876543 }; // inny punkt = pusty cache tras
  setGeoFetch((async () => {
    throw new Error("brak sieci");
  }) as typeof fetch);
  const straight = await call(`lat=${FAR.lat}&lng=${FAR.lng}&objectId=${withCoords.id}`);
  ok(
    "biuro liczone linią prostą",
    straight.data?.office?.method === "straight" && (straight.data?.office?.km ?? 0) > 0,
    straight.data?.office
  );
  ok(
    "obiekt też linią prostą",
    straight.data?.object?.method === "straight" && (straight.data?.object?.km ?? 0) > 0,
    straight.data?.object
  );

  // --- D2. Przyklejanie pinezki do drogi (OSRM nearest) --------------------
  //
  // Zgłoszenie z produkcji: dwie pinezki 150 m od siebie w lesie dawały „2,3 km"
  // i „6,3 km" od biura, bo druga przykleiła się do bezimiennej ścieżki.
  console.log("\n=== D2. Pinezka poza siecią dróg ===");

  /** Odpowiedź `nearest` z listą kandydatów (kolejność jak w OSRM: rosnąco po `distance`). */
  const nearestResponse = (waypoints: { lat: number; lng: number; name: string; distance: number }[]) =>
    new Response(
      JSON.stringify({
        code: "Ok",
        waypoints: waypoints.map((w) => ({ location: [w.lng, w.lat], name: w.name, distance: w.distance })),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  {
    // Bezimienna ścieżka BLIŻEJ (100 m), nazwana ulica dalej (250 m) — wygrywa ulica.
    // Punkt wymyślony (nie: prawdziwy z Lasu Bródnowskiego) — dla prawdziwego w
    // `geo_cache` skopiowanej bazy siedziałaby już odpowiedź `nearest` z produkcji.
    const PIN_FOREST = { lat: 52.414831, lng: 21.163751 };
    const PATH = { lat: 52.4152, lng: 21.1638, name: "", distance: 100 };
    const STREET = { lat: 52.4165, lng: 21.1655, name: "Kondratowicza", distance: 250 };
    const routed: string[] = [];
    setGeoFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nearest/")) return nearestResponse([PATH, STREET]);
      routed.push(url);
      return osrmResponse(2_300, 4 * 60);
    }) as typeof fetch);

    const snapped = await call(`lat=${PIN_FOREST.lat}&lng=${PIN_FOREST.lng}`);
    ok("trasa liczona do NAZWANEJ ulicy, nie do ścieżki", routed.some((u) => u.includes(`${STREET.lng},${STREET.lat}`)), routed);
    ok("…ścieżka bez nazwy pominięta", !routed.some((u) => u.includes(`${PATH.lng},${PATH.lat}`)), routed);
    ok("…wynik to trasa 2,3 km", snapped.data?.office?.km === 2.3 && snapped.data?.office?.method === "route", snapped.data?.office);
    ok(
      "…`snapKm` = ile pinezkę dzieli od tej ulicy",
      typeof snapped.data?.snapKm === "number" && snapped.data.snapKm > 0.1 && snapped.data.snapKm < 0.5,
      snapped.data?.snapKm
    );
  }

  {
    // Nazwana droga BARDZO daleko (5 km) nie wygrywa z bezimienną tuż obok —
    // inaczej pinezka na wsi przykleiłaby się do trasy wojewódzkiej.
    const PIN_RURAL = { lat: 52.441122, lng: 21.185533 };
    const CLOSE_PATH = { lat: 52.4412, lng: 21.1856, name: "", distance: 120 };
    const FAR_ROAD = { lat: 52.48, lng: 21.24, name: "Wojewódzka 631", distance: 5000 };
    const routed: string[] = [];
    setGeoFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nearest/")) return nearestResponse([CLOSE_PATH, FAR_ROAD]);
      routed.push(url);
      return osrmResponse(2_000, 5 * 60);
    }) as typeof fetch);

    await call(`lat=${PIN_RURAL.lat}&lng=${PIN_RURAL.lng}`);
    ok(
      "nazwana droga 5 km dalej przegrywa z bezimienną tuż obok",
      routed.some((u) => u.includes(`${CLOSE_PATH.lng},${CLOSE_PATH.lat}`)) &&
        !routed.some((u) => u.includes(`${FAR_ROAD.lng},${FAR_ROAD.lat}`)),
      routed
    );
  }

  {
    // Każdy kandydat daje absurdalny objazd (> 3× linia prosta + 1 km) → linia prosta.
    const PIN_ABSURD = { lat: 52.424412, lng: 21.171223 };
    let routeCalls = 0;
    setGeoFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nearest/")) {
        return nearestResponse([
          { lat: 52.4246, lng: 21.1714, name: "Leśna A", distance: 90 },
          { lat: 52.4248, lng: 21.1717, name: "Leśna B", distance: 120 },
          { lat: 52.425, lng: 21.172, name: "Leśna C", distance: 160 },
        ]);
      }
      routeCalls++;
      // Absurd: pół tysiąca kilometrów tam, gdzie w linii prostej jest kilkadziesiąt.
      return osrmResponse(500_000, 400 * 60);
    }) as typeof fetch);

    const absurd = await call(`lat=${PIN_ABSURD.lat}&lng=${PIN_ABSURD.lng}`);
    ok("objazd > 3× linia prosta → method: straight", absurd.data?.office?.method === "straight", absurd.data?.office);
    ok("…i nie próbujemy w nieskończoność (maks. 3 kandydatów)", routeCalls === 3, routeCalls);
  }

  {
    // `nearest` niedostępny → trasujemy surowy punkt, czyli jak przed zmianą.
    const PIN_RAW = { lat: 52.433311, lng: 21.179922 };
    const routed: string[] = [];
    setGeoFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nearest/")) throw new Error("nearest padł");
      routed.push(url);
      return osrmResponse(5_000, 10 * 60);
    }) as typeof fetch);

    const raw = await call(`lat=${PIN_RAW.lat}&lng=${PIN_RAW.lng}`);
    ok("awaria `nearest` → trasa do surowego punktu", routed.some((u) => u.includes(`${PIN_RAW.lng},${PIN_RAW.lat}`)), routed);
    ok("…wynik nadal jest trasą", raw.data?.office?.method === "route" && raw.data?.office?.km === 5, raw.data?.office);
    ok("…bez dopisku o dojściu pieszo", raw.data?.snapKm === 0, raw.data?.snapKm);
  }

  // --- E. Tryb „ręcznie" ---------------------------------------------------
  console.log("\n=== E. km_source = manual ===");
  setSetting("company.km_source", "manual", user.id);
  const manual = await call(`lat=${PIN.lat}&lng=${PIN.lng}&objectId=${withCoords.id}`);
  ok(
    "wyłączone liczenie km → oba null (decyzja administratora)",
    manual.status === 200 && manual.data?.office === null && manual.data?.object === null,
    manual
  );
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystko przeszło." : `\n${failures} testów nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
