/**
 * Test pogody w kalendarzu (src/lib/weather.ts + GET /api/calendar/weather):
 *   npx tsx scripts/test-on-copy.ts scripts/test-weather.ts
 *
 * Zakres: wybór punktu (location → obiekt → biuro; `urlop` zawsze bez pogody), okno
 * [dziś-2, dziś+15], dobór reprezentatywnego kodu dla OKNA wydarzenia
 * (`representativeWeather` + `eventWeatherWindow`: próg prawdopodobieństwa opadu, kod
 * dominujący bez opadów, burza wygrywa, całodniowe liczone z pory pracy 07–18),
 * dopasowanie ostrzeżenia IMGW po TERYT powiatu, cache (drugie wywołanie bez
 * ruchu sieciowego + TTL 60 min dla prognozy), grupowanie punktów (n wydarzeń w jednym
 * miejscu = jedno zapytanie), brak sieci → `null` zamiast błędu, oraz endpointy
 * (`/calendar/weather?ids=`, `/calendar/events/:id/weather`).
 *
 * SIEĆ: test NIGDY nie wychodzi do internetu — `setGeoFetch` podstawia atrapę, która
 * rozdziela żądania po URL-u i liczy każde wyjście „do sieci”; fikstury odwzorowują
 * realny kształt odpowiedzi Open-Meteo, IMGW (`teryt: ["1465", …]`, `stopien: "2"`)
 * i Nominatim reverse (`extratags["teryt:terc"]`).
 *
 * Sprząta HARD: wydarzenia i obiekty z prefiksem ZZ-WX, dotknięte wpisy geo_cache
 * i ustawienia `company.*` wracają do stanu sprzed testu.
 */
import { Hono } from "hono";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import calendarRoutes from "../src/routes/calendar.js";
import { geoCacheKey, geoCacheSet, setGeoFetch } from "../src/lib/geo.js";
import { shiftLocal } from "../src/lib/calendar-recurrence.js";
import {
  WARNINGS_CACHE_KEY,
  countyCacheKey,
  eventWeatherPoint,
  eventWeatherWindow,
  isInWeatherWindow,
  parseImgwWarnings,
  representativeWeather,
  today,
  weatherBriefs,
  weatherCacheKey,
  weatherDetail,
  weatherWindow,
  type WeatherBrief,
  type WeatherDetail,
  type WeatherEventInput,
  type WeatherHour,
} from "../src/lib/weather.js";
import { COMPANY_FIELDS, COMPANY_FIELD_NAMES } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-WX";

const TODAY = today();
const day = (offset: number) => shiftLocal(TODAY, offset * 24 * 60, true);

const OFFICE = { lat: 52.4064, lng: 16.9252 }; // Poznań
const A = { lat: 52.2317, lng: 21.0059 };      // Warszawa, powiat TERYT 1465
const B = { lat: 51.1079, lng: 17.0385 };      // Wrocław, powiat TERYT 0264
const C = { lat: 54.352, lng: 18.6466 };       // Gdańsk — punkt bez wpisów w cache (test offline)
const D = { lat: 50.0647, lng: 19.945 };       // Kraków — punkt z „profilową” dobą (dobór kodu z okna)

const LOCATION_LINE = "Plac Defilad 1, Warszawa";

// ---------------------------------------------------------------------------
// Fikstury odpowiedzi (kształt jak w realnych API)
// ---------------------------------------------------------------------------

/**
 * Open-Meteo: 18 dni (past_days=2 + forecast_days=16) i 432 godziny.
 * Wartości są ROZŁĄCZNE między dniem a godziną, żeby test rozróżniał, skąd wzięto liczbę:
 * dzienne max = 25 / min = 11 / kod 61, godzinowe: temperatura = numer godziny, kod 3.
 */
function forecastFixture() {
  const daily = {
    time: [] as string[],
    weather_code: [] as number[],
    temperature_2m_max: [] as number[],
    temperature_2m_min: [] as number[],
    precipitation_sum: [] as number[],
    precipitation_probability_max: [] as (number | null)[],
    wind_speed_10m_max: [] as number[],
  };
  const hourly = {
    time: [] as string[],
    temperature_2m: [] as number[],
    weather_code: [] as number[],
    precipitation_probability: [] as (number | null)[],
    precipitation: [] as number[],
    wind_speed_10m: [] as number[],
  };
  for (let i = -2; i <= 15; i++) {
    const d = day(i);
    daily.time.push(d);
    daily.weather_code.push(61);
    daily.temperature_2m_max.push(25);
    daily.temperature_2m_min.push(11);
    daily.precipitation_sum.push(4.25);
    daily.precipitation_probability_max.push(70);
    daily.wind_speed_10m_max.push(35.4);
    for (let h = 0; h < 24; h++) {
      hourly.time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      hourly.temperature_2m.push(h);
      hourly.weather_code.push(3);
      hourly.precipitation_probability.push(20);
      hourly.precipitation.push(0.1);
      hourly.wind_speed_10m.push(12.6);
    }
  }
  return { latitude: 52.23, longitude: 21.01, timezone: "Europe/Warsaw", daily, hourly };
}

/**
 * Doba „profilowa” (punkt D) — dokładnie taka, jaka wywracała starą implementację:
 * słonecznie w godzinach pracy, ale burza o 5:00 i mżawka o 23:00, więc `daily.weather_code`
 * (najcięższy kod doby) mówi „burza”, a o 15:00 jest deszcz z prawdopodobieństwem 20%.
 *   05 → 95 burza (80%)   12 → 3 zachmurzenie   15 → 61 deszcz (20%)   23 → 53 mżawka (90%)
 *   pozostałe godziny → 0 bezchmurnie; temperatura = numer godziny.
 */
function profileFixture() {
  const daily = {
    time: [] as string[],
    weather_code: [] as number[],
    temperature_2m_max: [] as number[],
    temperature_2m_min: [] as number[],
    precipitation_sum: [] as number[],
    precipitation_probability_max: [] as (number | null)[],
    wind_speed_10m_max: [] as number[],
  };
  const hourly = {
    time: [] as string[],
    temperature_2m: [] as number[],
    weather_code: [] as number[],
    precipitation_probability: [] as (number | null)[],
    precipitation: [] as number[],
    wind_speed_10m: [] as number[],
  };
  const hourProfile = (h: number): { code: number; prob: number; mm: number } => {
    if (h === 5) return { code: 95, prob: 80, mm: 2 };
    if (h === 12) return { code: 3, prob: 0, mm: 0 };
    if (h === 15) return { code: 61, prob: 20, mm: 0.2 };
    if (h === 23) return { code: 53, prob: 90, mm: 0.3 };
    return { code: 0, prob: 0, mm: 0 };
  };
  for (let i = -2; i <= 15; i++) {
    const d = day(i);
    daily.time.push(d);
    daily.weather_code.push(95); // Open-Meteo: najcięższy kod CAŁEJ doby
    daily.temperature_2m_max.push(25);
    daily.temperature_2m_min.push(11);
    daily.precipitation_sum.push(2.5);
    daily.precipitation_probability_max.push(90);
    daily.wind_speed_10m_max.push(40);
    for (let h = 0; h < 24; h++) {
      const p = hourProfile(h);
      hourly.time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      hourly.temperature_2m.push(h);
      hourly.weather_code.push(p.code);
      hourly.precipitation_probability.push(p.prob);
      hourly.precipitation.push(p.mm);
      hourly.wind_speed_10m.push(10);
    }
  }
  return { latitude: D.lat, longitude: D.lng, timezone: "Europe/Warsaw", daily, hourly };
}

/** IMGW: kształt 1:1 z danepubliczne.imgw.pl/api/data/warningsmeteo (zweryfikowany curl-em). */
const warningsFixture = [
  {
    id: "Sk20260907093200927",
    nazwa_zdarzenia: "Silny wiatr",
    stopien: "2",
    prawdopodobienstwo: "80",
    obowiazuje_od: `${TODAY} 06:00:00`,
    obowiazuje_do: `${TODAY} 20:00:00`,
    opublikowano: `${day(-1)} 11:32:00`,
    tresc: "Prognozuje się wystąpienie silnego wiatru o średniej prędkości od 35 km/h do 45 km/h.",
    komentarz: "Brak.",
    biuro: "Centralne Biuro Prognoz Meteorologicznych w Warszawie",
    teryt: ["1465", "1420"],
  },
  {
    id: "Sk20260907093200928",
    nazwa_zdarzenia: "Upał",
    stopien: "1",
    prawdopodobienstwo: "70",
    obowiazuje_od: `${day(4)} 12:00:00`,
    obowiazuje_do: `${day(4)} 18:00:00`,
    opublikowano: `${day(-1)} 11:32:00`,
    tresc: "Prognozuje się upał.",
    komentarz: "Brak.",
    biuro: "Centralne Biuro Prognoz Meteorologicznych w Warszawie",
    teryt: ["0264"],
  },
];

/** Nominatim reverse: powiat + `extratags["teryt:terc"]` (jedyny sposób dopasowania IMGW). */
function reverseFixture(lat: number) {
  const warsaw = Math.abs(lat - A.lat) < 0.2;
  return warsaw
    ? {
        osm_type: "relation",
        addresstype: "city",
        name: "Warszawa",
        address: { city: "Warszawa", state: "województwo mazowieckie", country_code: "pl" },
        extratags: { "teryt:terc": "1465", admin_level: "6" },
      }
    : {
        osm_type: "relation",
        addresstype: "county",
        name: "Wrocław",
        address: { city: "Wrocław", state: "województwo dolnośląskie", country_code: "pl" },
        extratags: { "teryt:terc": "0264", admin_level: "6" },
      };
}

// ---------------------------------------------------------------------------
// Sieć: wyłącznie atrapa, z licznikami per host
// ---------------------------------------------------------------------------

const calls = { total: 0, forecast: 0, imgw: 0, reverse: 0, search: 0 };
let offline = false;

function resetCalls() {
  calls.total = calls.forecast = calls.imgw = calls.reverse = calls.search = 0;
}

setGeoFetch(async (input) => {
  const url = String(input);
  calls.total++;
  if (offline) throw new TypeError("fetch failed");

  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

  if (url.includes("api.open-meteo.com")) {
    calls.forecast++;
    const lat = Number(new URL(url).searchParams.get("latitude"));
    return json(Math.abs(lat - D.lat) < 0.1 ? profileFixture() : forecastFixture());
  }
  if (url.includes("danepubliczne.imgw.pl")) {
    calls.imgw++;
    return json(warningsFixture);
  }
  if (url.includes("nominatim.openstreetmap.org/reverse")) {
    calls.reverse++;
    const lat = Number(new URL(url).searchParams.get("lat"));
    return json(reverseFixture(lat));
  }
  if (url.includes("nominatim.openstreetmap.org/search")) {
    calls.search++;
    return json([{ lat: String(A.lat), lon: String(A.lng), display_name: LOCATION_LINE }]);
  }
  throw new TypeError(`nieoczekiwany URL w teście: ${url}`);
});

// ---------------------------------------------------------------------------
// Stan do przywrócenia
// ---------------------------------------------------------------------------

const settingsBackup = new Map<string, string | null>();
for (const name of COMPANY_FIELD_NAMES) {
  const key = COMPANY_FIELDS[name].dbKey;
  settingsBackup.set(key, getSetting(key));
}

/** Wszystkie klucze cache'u, których test może dotknąć — kasujemy je co do jednego. */
const touchedKeys = new Set<string>([
  WARNINGS_CACHE_KEY,
  geoCacheKey(LOCATION_LINE),
  ...[OFFICE, A, B, C, D].flatMap((p) => [weatherCacheKey(p), countyCacheKey(p)]),
]);

function clearCache() {
  db.delete(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).run();
}

/** Postarza wpis cache'u o N minut (test TTL bez czekania godziny). */
function age(key: string, minutes: number) {
  db.update(schema.geoCache)
    .set({ createdAt: sql`datetime('now', ${`-${minutes} minutes`})` })
    .where(eq(schema.geoCache.key, key))
    .run();
}

function cleanup() {
  db.delete(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).run();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  clearCache();
  for (const [key, value] of settingsBackup) {
    if (value === null) deleteSetting(key);
    else setSetting(key, value, null);
  }
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury bazodanowe
// ---------------------------------------------------------------------------

const contractor = db.select({ id: schema.contractors.id }).from(schema.contractors).limit(1).get();
if (!contractor) {
  console.error("Brak kontrahenta w bazie — przerywam.");
  process.exit(1);
}

function makeObject(name: string, point: { lat: number; lng: number } | null) {
  return db
    .insert(schema.objects)
    .values({
      contractorId: contractor!.id,
      name: `${PREFIX} ${name}`,
      address: point ? "Testowa 1" : null,
      city: point ? "Testowo" : null,
      type: "monitoring",
      installationType: "new",
      latitude: point?.lat ?? null,
      longitude: point?.lng ?? null,
    })
    .returning()
    .get();
}

function makeEvent(v: {
  title: string;
  startAt: string;
  endAt: string;
  type?: string;
  allDay?: boolean;
  objectId?: number | null;
  location?: string | null;
}) {
  return db
    .insert(schema.calendarEvents)
    .values({
      type: (v.type ?? "serwis") as never,
      title: `${PREFIX} ${v.title}`,
      startAt: v.startAt,
      endAt: v.endAt,
      allDay: v.allDay ?? false,
      objectId: v.objectId ?? null,
      location: v.location ?? null,
    })
    .returning()
    .get();
}

/** Wejście modułu prosto z wiersza (bez rundy przez bazę tam, gdzie test tego nie bada). */
const input = (e: { id: number; type: string; location: string | null; objectId: number | null; startAt: string; endAt: string; allDay: boolean }): WeatherEventInput => ({
  id: e.id,
  type: e.type,
  location: e.location,
  objectId: e.objectId,
  startAt: e.startAt,
  endAt: e.endAt,
  allDay: e.allDay,
});

/** Aplikacja testowa: zalogowany technik (bez uprawnień admina). */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: 1, username: "technik", role: "user" });
    return next();
  });
  a.route("/calendar", calendarRoutes);
  return a;
}

async function get(path: string) {
  const res = await app().request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------

async function main() {
  setSetting("company.office_lat", String(OFFICE.lat), null);
  setSetting("company.office_lng", String(OFFICE.lng), null);
  setSetting("company.office_address", "Stary Rynek 1", null);
  setSetting("company.office_city", "Poznań", null);

  const objA = makeObject("Obiekt A", A);
  const objB = makeObject("Obiekt B", B);
  const objC = makeObject("Obiekt C", C);
  const objBare = makeObject("Bez adresu", null);

  // --- Parser IMGW (realny kształt + warianty defensywne) --------------------
  {
    const parsed = parseImgwWarnings(warningsFixture);
    ok("IMGW: parser czyta obie pozycje", parsed.length === 2, parsed.length);
    ok("IMGW: stopień „2” → level 2", parsed[0].level === 2, parsed[0]);
    ok("IMGW: data „YYYY-MM-DD HH:MM:SS” → ISO", parsed[0].from === `${TODAY}T06:00`, parsed[0].from);
    ok("IMGW: teryt zachowany", parsed[0].teryt.join(",") === "1465,1420", parsed[0].teryt);

    const odd = parseImgwWarnings([
      { nazwa_zdarzenia: "Mróz", stopien: "9", obowiazuje_od: "2026-01-01 00:00:00", obowiazuje_do: "2026-01-02 00:00:00", teryt: "146501" },
      { nazwa_zdarzenia: "Bez dat" },
      null,
      "śmieć",
    ]);
    ok("IMGW: wpis bez dat odrzucony", odd.length === 1, odd);
    ok("IMGW: stopień poza skalą przycięty do 3", odd[0].level === 3, odd[0]);
    ok("IMGW: teryt gminny obcięty do powiatu", odd[0].teryt.join(",") === "1465", odd[0].teryt);
    ok("IMGW: pusta odpowiedź nie wywraca parsera", parseImgwWarnings(null).length === 0);
  }

  // --- Okno prognozy --------------------------------------------------------
  {
    const w = weatherWindow();
    ok("okno zaczyna się dwa dni wstecz", w.from === day(-2), w);
    ok("okno kończy się 15 dni w przód", w.to === day(15), w);
    ok("dziś w oknie", isInWeatherWindow(TODAY));
    ok("dziś-2 w oknie", isInWeatherWindow(day(-2)));
    ok("dziś-3 poza oknem", !isInWeatherWindow(day(-3)));
    ok("dziś+15 w oknie", isInWeatherWindow(day(15)));
    ok("dziś+16 poza oknem", !isInWeatherWindow(day(16)));
  }

  // --- Okno wydarzenia (eventWeatherWindow) ---------------------------------
  {
    const win = (startAt: string, endAt: string | null, allDay = false) =>
      eventWeatherWindow({ startAt, endAt, allDay });

    const w1 = win(`${TODAY}T10:00`, `${TODAY}T14:00`);
    ok("okno: [start, koniec) z godziny", w1.from === `${TODAY}T10:00` && w1.to === `${TODAY}T14:00`, w1);

    const w2 = win(`${TODAY}T10:30`, `${TODAY}T11:00`);
    ok("okno: start zaokrąglony w dół do pełnej godziny", w2.from === `${TODAY}T10:00`, w2);

    const w3 = win(`${TODAY}T10:00`, null);
    ok("okno: brak końca → sama godzina startu", w3.to === `${TODAY}T11:00`, w3);

    const w4 = win(`${TODAY}T10:00`, `${TODAY}T09:00`);
    ok("okno: koniec przed startem → sama godzina startu", w4.to === `${TODAY}T11:00`, w4);

    const w5 = win(TODAY, day(1), true);
    ok("okno całodniowe: pora pracy 07–18", w5.from === `${TODAY}T07:00` && w5.to === `${TODAY}T18:00`, w5);

    const w6 = win(`${TODAY}T10:00`, `${day(5)}T10:00`);
    ok("okno: wielodniowe przycięte do doby", w6.to === `${day(1)}T10:00`, w6);
  }

  // --- Dobór reprezentatywnego kodu (representativeWeather) ------------------
  {
    /** Godzina prognozy: temperatura = numer godziny (żeby średnia była policzalna w głowie). */
    const hr = (h: number, code: number, prob: number | null = 0, mm = 0, wind = 10): WeatherHour => ({
      time: `${TODAY}T${String(h).padStart(2, "0")}:00`,
      tempC: h,
      code,
      precipProb: prob,
      precipMm: mm,
      windKmh: wind,
    });
    const codeOf = (hours: WeatherHour[]) => representativeWeather(hours)?.code ?? null;

    ok("puste okno → null", representativeWeather([]) === null);

    // Jedna godzina zachmurzenia nie może zrobić „pochmurno” z siedmiu godzin słońca.
    const sunny = [7, 8, 9, 10, 11, 12, 13].map((h) => hr(h, 1)).concat(hr(14, 3));
    ok("7 h słońca + 1 h chmury → kod dominujący (1)", codeOf(sunny) === 1, codeOf(sunny));
    const clear = [7, 8, 9, 10, 11, 12, 13].map((h) => hr(h, 0)).concat(hr(14, 3));
    ok("7 h bezchmurnie + 1 h chmury → 0", codeOf(clear) === 0, codeOf(clear));

    // Próg prawdopodobieństwa: 20% to nie jest „pada”.
    const drizzly = [hr(10, 0), hr(11, 0), hr(12, 61, 20, 0.2), hr(13, 0)];
    ok("deszcz z prawdopodobieństwem 20% → nie deszcz", codeOf(drizzly) === 0, codeOf(drizzly));

    // …ale 60% w jednej godzinie z czterech to już deszcz.
    const wet = [hr(10, 0), hr(11, 0), hr(12, 61, 60, 1.2), hr(13, 0)];
    ok("deszcz 60% w 1 h z 4 → deszcz", codeOf(wet) === 61, codeOf(wet));

    // Brak danych o prawdopodobieństwie nie może wyciszać opadu.
    const noProb = [hr(10, 0), hr(11, 63, null, 1)];
    ok("brak prawdopodobieństwa → opad liczy się zawsze", codeOf(noProb) === 63, codeOf(noProb));

    // Burza wygrywa z deszczem, choćby trwała jedną godzinę.
    const storm = [hr(10, 61, 80, 1), hr(11, 95, 60, 3), hr(12, 61, 80, 1), hr(13, 63, 90, 2)];
    ok("burza wygrywa z deszczem", codeOf(storm) === 95, codeOf(storm));
    const snow = [hr(10, 61, 80, 1), hr(11, 73, 70, 2)];
    ok("śnieg wygrywa z deszczem", codeOf(snow) === 73, codeOf(snow));
    const rainVsDrizzle = [hr(10, 53, 80, 0.2), hr(11, 65, 80, 4)];
    ok("deszcz wygrywa z mżawką (i to najcięższy kod)", codeOf(rainVsDrizzle) === 65, codeOf(rainVsDrizzle));

    // Remis w głosowaniu → cięższe zjawisko (bezpieczniej dla ekipy w terenie).
    const tie = [hr(10, 0), hr(11, 0), hr(12, 3), hr(13, 3)];
    ok("remis kodów bezopadowych → cięższy", codeOf(tie) === 3, codeOf(tie));

    // Godzina „deszczu” poniżej progu głosuje jako zachmurzenie, nie jako słońce.
    const belowThreshold = [hr(10, 61, 10, 0.1), hr(11, 61, 10, 0.1), hr(12, 0)];
    ok("opad poniżej progu głosuje jako zachmurzenie", codeOf(belowThreshold) === 3, codeOf(belowThreshold));

    // Liczby: średnia / min / max / suma / maksima.
    const rep = representativeWeather([hr(10, 0, 10, 0.1, 12), hr(11, 0, 40, 0.3, 30), hr(12, 3, 20, 0.1, 20)])!;
    ok("liczby: temperatura średnia z okna", rep.tempC === 11, rep);
    ok("liczby: min/max z okna", rep.tempMinC === 10 && rep.tempMaxC === 12, rep);
    ok("liczby: opady sumą okna", rep.precipMm === 0.5, rep);
    ok("liczby: prawdopodobieństwo i wiatr jako maksimum", rep.precipProb === 40 && rep.windKmh === 30, rep);
    ok("liczby: granice okna", rep.from === `${TODAY}T10:00` && rep.to === `${TODAY}T13:00`, rep);

    // Bug wyjściowy: mżawka o 23:00 nie może opisywać wydarzenia całodniowego.
    const fullDay: WeatherHour[] = [];
    for (let h = 0; h < 24; h++) fullDay.push(h === 23 ? hr(h, 53, 90, 0.3) : hr(h, 0));
    const w = eventWeatherWindow({ startAt: TODAY, endAt: day(1), allDay: true });
    const inWindow = fullDay.filter((x) => x.time >= w.from && x.time < w.to);
    ok("all-day z mżawką o 23:00 → nie mżawka", codeOf(inWindow) === 0, codeOf(inWindow));
    ok("all-day: okno to 11 godzin pracy", inWindow.length === 11, inWindow.length);
    ok("cała doba nadal daje mżawkę (dowód, że różnicę robi okno)", codeOf(fullDay) === 53, codeOf(fullDay));
  }

  // --- Wybór punktu ---------------------------------------------------------
  {
    const vacation = await eventWeatherPoint({ type: "urlop", location: LOCATION_LINE, objectId: objA.id });
    ok("urlop nie dostaje punktu", vacation.value === null && vacation.reason === "vacation", vacation);

    // Adres wygrywa z obiektem — mimo że obiekt B jest we Wrocławiu.
    const byLocation = await eventWeatherPoint({ type: "serwis", location: LOCATION_LINE, objectId: objB.id });
    ok(
      "location ma pierwszeństwo przed obiektem",
      byLocation.value?.lat === A.lat && byLocation.value?.label === LOCATION_LINE,
      byLocation
    );

    const byObject = await eventWeatherPoint({ type: "serwis", location: null, objectId: objB.id });
    ok("bez adresu punkt z obiektu", byObject.value?.lat === B.lat && byObject.value?.label === objB.name, byObject);

    const byOffice = await eventWeatherPoint({ type: "biuro", location: null, objectId: null });
    ok("typ biuro → punkt biura", byOffice.value?.lat === OFFICE.lat, byOffice);

    const prep = await eventWeatherPoint({ type: "przygotowanie", location: null, objectId: null });
    ok("typ przygotowanie → punkt biura", prep.value?.lat === OFFICE.lat, prep);

    const none = await eventWeatherPoint({ type: "serwis", location: null, objectId: null });
    ok("serwis bez adresu i obiektu → brak punktu", none.value === null && none.reason === "no_point", none);

    const bare = await eventWeatherPoint({ type: "serwis", location: null, objectId: objBare.id });
    ok("obiekt bez współrzędnych → brak punktu", bare.value === null, bare);
  }

  // --- Brief: całodniowy vs. z godziną --------------------------------------
  clearCache();
  resetCalls();
  const evHour = makeEvent({ title: "Serwis A", startAt: `${TODAY}T07:00`, endAt: `${TODAY}T09:00`, objectId: objA.id });
  const evAllDay = makeEvent({ title: "Całodniowe A", startAt: TODAY, endAt: day(1), allDay: true, objectId: objA.id });
  const evFar = makeEvent({ title: "Za daleko", startAt: `${day(30)}T08:00`, endAt: `${day(30)}T10:00`, objectId: objA.id });
  const evVacation = makeEvent({ title: "Urlop", startAt: TODAY, endAt: day(1), allDay: true, type: "urlop", objectId: objA.id });
  const evWroclaw = makeEvent({ title: "Serwis B", startAt: `${TODAY}T13:00`, endAt: `${TODAY}T15:00`, objectId: objB.id });

  {
    const batch = await weatherBriefs([evHour, evAllDay, evFar, evVacation, evWroclaw].map(input));
    const briefs = batch.items;

    // Fikstura: godziny 07 i 08 → kod 3, temperatura 7 i 8, opad 0,1 mm przy 20%, wiatr 12,6.
    const hour = briefs.get(evHour.id) as WeatherBrief;
    ok("brief z godziną: temperatura średnia z okna", hour?.tempC === 7.5, hour);
    ok("brief z godziną: kod z okna, nie z doby", hour?.code === 3, hour);
    ok("brief z godziną: min/max z okna", hour?.tempMinC === 7 && hour?.tempMaxC === 8, hour);
    ok(
      "brief z godziną: opady i wiatr z okna",
      hour?.precipMm === 0.2 && hour?.precipProb === 20 && hour?.windKmh === 13,
      hour
    );
    ok("brief z godziną: okno w wyniku", hour?.window?.from === "07:00" && hour?.window?.to === "09:00", hour?.window);
    ok("brief: punkt z etykietą obiektu", hour?.point.label === objA.name && hour?.point.lat === A.lat, hour?.point);
    ok("brief: data = dzień wydarzenia", hour?.date === TODAY, hour);

    // Całodniowe: kod i liczby z pory pracy 07–18 (godziny 7…17 → średnia 12), ale amplituda doby.
    const allDay = briefs.get(evAllDay.id) as WeatherBrief;
    ok("brief całodniowy: temperatura średnia z pory pracy", allDay?.tempC === 12, allDay);
    ok("brief całodniowy: kod z okna pracy, nie dobowy", allDay?.code === 3, allDay);
    ok("brief całodniowy: min/max nadal dobowe", allDay?.tempMinC === 11 && allDay?.tempMaxC === 25, allDay);
    ok("brief całodniowy: bez okna godzinowego w wyniku", allDay?.window === null, allDay?.window);

    ok("wydarzenie poza oknem → null", briefs.get(evFar.id) === null, briefs.get(evFar.id));
    ok("urlop → null", briefs.get(evVacation.id) === null, briefs.get(evVacation.id));
    // Urlop i dzień poza oknem prognozy to odpowiedzi OSTATECZNE — ponawianie ich to pętla.
    ok("urlop i poza oknem nie trafiają do retry", batch.retry.length === 0, batch.retry);

    // --- Ostrzeżenie dopasowane po powiecie (TERYT) -------------------------
    ok("ostrzeżenie IMGW dla powiatu 1465 → poziom 2", hour?.warningLevel === 2, hour);
    const wroclaw = briefs.get(evWroclaw.id) as WeatherBrief;
    ok("powiat 0264 bez ostrzeżenia na dziś → poziom 0", wroclaw?.warningLevel === 0, wroclaw);

    // --- Ruch sieciowy: grupowanie punktów ---------------------------------
    ok("jedno zapytanie o ostrzeżenia na cały batch", calls.imgw === 1, calls);
    ok("jedna prognoza na punkt (2 punkty, 5 wydarzeń)", calls.forecast === 2, calls);
    ok("jedno reverse na punkt", calls.reverse === 2, calls);
  }

  // --- Cache: drugie wywołanie bez sieci ------------------------------------
  {
    resetCalls();
    const again = (await weatherBriefs([evHour, evAllDay, evWroclaw].map(input))).items;
    ok("drugie wywołanie nie rusza sieci", calls.total === 0, calls);
    ok("wynik z cache'u identyczny", (again.get(evHour.id) as WeatherBrief)?.tempC === 7.5, again.get(evHour.id));
  }

  // --- TTL prognozy: 60 minut -----------------------------------------------
  {
    age(weatherCacheKey(A), 61);
    age(WARNINGS_CACHE_KEY, 5); // ostrzeżenia wciąż świeże (TTL 15 min)
    resetCalls();
    await weatherBriefs([evHour].map(input));
    ok("prognoza starsza niż 60 min → ponowne pobranie", calls.forecast === 1, calls);
    ok("ostrzeżenia młodsze niż 15 min → bez pobrania", calls.imgw === 0, calls);
  }

  // --- TTL ostrzeżeń: 15 minut ----------------------------------------------
  {
    age(WARNINGS_CACHE_KEY, 16);
    resetCalls();
    await weatherBriefs([evHour].map(input));
    ok("ostrzeżenia starsze niż 15 min → ponowne pobranie", calls.imgw === 1, calls);
    ok("prognoza świeża → bez pobrania", calls.forecast === 0, calls);
  }

  // --- Dobór kodu end-to-end na „profilowej” dobie (punkt D) -----------------
  // Doba ma burzę o 5:00 i mżawkę o 23:00, więc `daily.weather_code` = 95 dla KAŻDEGO
  // wydarzenia tego dnia. Ikona ma opisywać okno, nie dobę.
  {
    const objD = makeObject("Obiekt D", D);
    const at = (from: string, to: string, title: string) =>
      makeEvent({ title, startAt: `${TODAY}T${from}`, endAt: `${TODAY}T${to}`, objectId: objD.id });

    const evStorm = at("05:00", "06:00", "Burza");
    const evWork = at("10:00", "14:00", "Wizja");
    const evLow = at("15:00", "16:00", "Deszcz 20%");
    const evNight = makeEvent({
      title: "Nocna",
      startAt: `${TODAY}T23:00`,
      endAt: `${day(1)}T00:00`,
      objectId: objD.id,
    });
    const evAllDayD = makeEvent({ title: "Całodniowe D", startAt: TODAY, endAt: day(1), allDay: true, objectId: objD.id });

    const briefs = (await weatherBriefs([evStorm, evWork, evLow, evNight, evAllDayD].map(input))).items;
    const b = (id: number) => briefs.get(id) as WeatherBrief;

    ok("okno 05–06 → burza", b(evStorm.id)?.code === 95, b(evStorm.id));
    ok("okno 10–14 → bezchmurnie (mimo burzy o 5:00 w dobie)", b(evWork.id)?.code === 0, b(evWork.id));
    ok("okno 10–14: temperatura średnia z okna", b(evWork.id)?.tempC === 11.5, b(evWork.id));
    ok(
      "okno 10–14: zakres godzin w wyniku",
      b(evWork.id)?.window?.from === "10:00" && b(evWork.id)?.window?.to === "14:00",
      b(evWork.id)?.window
    );
    ok("okno 15–16: deszcz 20% → zachmurzenie, nie deszcz", b(evLow.id)?.code === 3, b(evLow.id));
    ok("okno 23–24 → mżawka", b(evNight.id)?.code === 53, b(evNight.id));
    ok("całodniowe (07–18) → bezchmurnie, nie burza z 5:00", b(evAllDayD.id)?.code === 0, b(evAllDayD.id));
    ok("całodniowe: średnia z godzin pracy", b(evAllDayD.id)?.tempC === 12, b(evAllDayD.id));
    ok(
      "całodniowe: opady i wiatr z godzin pracy, nie z doby",
      b(evAllDayD.id)?.precipMm === 0.2 && b(evAllDayD.id)?.precipProb === 20 && b(evAllDayD.id)?.windKmh === 10,
      b(evAllDayD.id)
    );

    // Szczegóły korzystają z tego samego briefu (i nadal mają pełną dobę w `hourly`).
    const det = (await weatherDetail(input(evWork))).value as WeatherDetail;
    ok("szczegóły: kod ten sam co w briefie", det?.code === 0, det?.code);
    ok("szczegóły: godzinowo nadal cała doba", det?.hourly.length === 24, det?.hourly.length);
    ok("szczegóły: dobowy kod zostaje w `daily`", det?.daily[0]?.code === 95, det?.daily[0]);
  }

  // --- Limit świeżych geokodowań w jednym batchu ----------------------------
  // Widok miesiąca potrafi mieć kilkadziesiąt NIEznanych adresów, a kolejka Nominatim
  // przepuszcza 1 req/s — bez limitu jedno żądanie wisiało po sekundzie na adres.
  // Ósemka idzie od razu, reszta wraca w `retry` (front dopyta w kolejnej turze).
  {
    clearCache();
    resetCalls();
    const addrs = Array.from({ length: 12 }, (_, i) => `${PREFIX} Testowa ${i + 1}, Warszawa`);
    for (const a of addrs) touchedKeys.add(geoCacheKey(a));
    const evs = addrs.map((a, i) =>
      makeEvent({ title: `Adres ${i + 1}`, startAt: `${TODAY}T08:00`, endAt: `${TODAY}T10:00`, location: a })
    );

    const first = await weatherBriefs(evs.map(input));
    ok("limit: najwyżej 8 świeżych geokodowań w batchu", calls.search === 8, calls);
    ok("limit: 8 wydarzeń z briefem od razu", evs.filter((e) => first.items.get(e.id) !== null).length === 8, calls);
    ok("limit: pozostałe 4 w retry", first.retry.length === 4, first.retry);
    ok(
      "limit: retry to dokładnie te bez briefu",
      first.retry.every((id) => first.items.get(id) === null),
      first.retry
    );

    resetCalls();
    const second = await weatherBriefs(evs.map(input));
    ok("drugi batch dociąga resztę (4 świeże geokodowania)", calls.search === 4, calls);
    ok("drugi batch: wszystkie mają brief", evs.every((e) => second.items.get(e.id) !== null), second.retry);
    ok("drugi batch: nic do ponowienia", second.retry.length === 0, second.retry);

    // Trafienia w cache limitu NIE dotyczą — inaczej znany miesiąc pytałby po 8 na turę.
    resetCalls();
    const third = await weatherBriefs(evs.map(input));
    ok("trafienia w cache bez limitu: 12 wydarzeń, zero sieci", calls.total === 0, calls);
    ok("trafienia w cache: wszystkie z briefem", evs.every((e) => third.items.get(e.id) !== null), third.retry);
  }

  // --- Szczegóły ------------------------------------------------------------
  {
    const res = await weatherDetail(input(evHour));
    const d = res.value as WeatherDetail;
    ok("szczegóły: 24 godziny dnia wydarzenia", d?.hourly.length === 24, d?.hourly.length);
    ok("szczegóły: godziny tylko z dnia wydarzenia", d?.hourly.every((h) => h.time.startsWith(TODAY)) === true);
    ok("szczegóły: 7 dni od dnia wydarzenia", d?.daily.length === 7 && d.daily[0].date === TODAY, d?.daily.slice(0, 1));
    ok("szczegóły: pełna treść ostrzeżenia", d?.warnings.length === 1 && d.warnings[0].event === "Silny wiatr", d?.warnings);
    ok("szczegóły: nazwa powiatu do UI", d?.county === "Warszawa", d?.county);
    ok("szczegóły: link do Windy z współrzędnymi", d?.links.windy.includes("52.232") === true, d?.links);
    ok("szczegóły: link do IMGW", d?.links.imgw.startsWith("https://meteo.imgw.pl/"), d?.links);
    ok("szczegóły: fetchedAt jest datą ISO", !Number.isNaN(Date.parse(d?.fetchedAt ?? "")), d?.fetchedAt);

    const far = await weatherDetail(input(evFar));
    ok("szczegóły poza oknem → null + reason", far.value === null && far.reason === "out_of_range", far);
    const vac = await weatherDetail(input(evVacation));
    ok("szczegóły dla urlopu → null", vac.value === null && vac.reason === "vacation", vac);
  }

  // --- Brak sieci → null, nigdy wyjątek -------------------------------------
  {
    const evGdansk = makeEvent({ title: "Serwis C", startAt: `${TODAY}T10:00`, endAt: `${TODAY}T12:00`, objectId: objC.id });
    offline = true;
    resetCalls();
    const offBatch = await weatherBriefs([evGdansk].map(input));
    const briefs = offBatch.items;
    ok("brak sieci → brief null (bez wyjątku)", briefs.get(evGdansk.id) === null, briefs.get(evGdansk.id));
    ok("brak sieci: próba wyjścia była", calls.total > 0, calls);
    // Bez tego front nie odróżnia „null, bo nie ma pogody” od „null, bo padła sieć”
    // i zostawia wydarzenie bez znacznika aż do przeładowania strony.
    ok("brak sieci → id w retry", offBatch.retry.includes(evGdansk.id), offBatch.retry);

    const detail = await weatherDetail(input(evGdansk));
    ok("brak sieci → szczegóły null z reason offline", detail.value === null && detail.reason === "offline", detail);

    // Zasada modułu: błędów NIE cache'ujemy — po powrocie sieci wynik jest.
    offline = false;
    const back = (await weatherBriefs([evGdansk].map(input))).items;
    ok("po powrocie sieci brief jest (błąd nie trafił do cache'u)", (back.get(evGdansk.id) as WeatherBrief)?.tempC === 10.5, back.get(evGdansk.id));

    // GEO_OFFLINE=1 — pełny tryb offline, punkt spoza cache'u.
    db.delete(schema.geoCache).where(eq(schema.geoCache.key, weatherCacheKey(C))).run();
    process.env.GEO_OFFLINE = "1";
    resetCalls();
    const off = (await weatherBriefs([evGdansk].map(input))).items;
    ok("GEO_OFFLINE=1 → null i zero ruchu", off.get(evGdansk.id) === null && calls.total === 0, calls);
    delete process.env.GEO_OFFLINE;
  }

  // --- Endpointy ------------------------------------------------------------
  {
    const res = await get(`/calendar/weather?ids=${evHour.id},${evAllDay.id},${evFar.id},${evVacation.id},999999999`);
    ok("GET /calendar/weather → 200", res.status === 200, res.status);
    const items = ((res.body.data as { items: Record<string, WeatherBrief | null> }) ?? { items: {} }).items;
    ok("batch: klucze dla wszystkich pytanych id", Object.keys(items).length === 5, Object.keys(items));
    ok("batch: wydarzenie z pogodą", items[String(evHour.id)]?.tempC === 7.5, items[String(evHour.id)]);
    ok("batch: urlop → null", items[String(evVacation.id)] === null);
    ok("batch: poza oknem → null", items[String(evFar.id)] === null);
    ok("batch: nieistniejące id → null", items["999999999"] === null);
    ok("batch: bez awarii pusta lista retry", ((res.body.data as { retry?: number[] }).retry ?? []).length === 0, res.body.data);

    const empty = await get("/calendar/weather");
    ok("batch bez ids → pusta mapa, 200", empty.status === 200 && Object.keys(((empty.body.data as { items: object }).items)).length === 0, empty.body);

    const detail = await get(`/calendar/events/${evHour.id}/weather`);
    ok("GET /events/:id/weather → 200 z danymi", detail.status === 200 && (detail.body.data as WeatherDetail)?.hourly.length === 24, detail.status);

    const missing = await get("/calendar/events/999999999/weather");
    ok("nieistniejące wydarzenie → 404", missing.status === 404, missing.status);

    const bad = await get("/calendar/events/abc/weather");
    ok("złe id → 400", bad.status === 400, bad.status);

    const vac = await get(`/calendar/events/${evVacation.id}/weather`);
    ok("urlop → 200 z data: null", vac.status === 200 && vac.body.data === null, vac.body);

    // Brak sieci NIGDY nie daje 500 — ani w batchu, ani w szczegółach.
    clearCache();
    offline = true;
    const offBatch = await get(`/calendar/weather?ids=${evHour.id}`);
    ok("brak sieci: batch nadal 200", offBatch.status === 200 && (offBatch.body.data as { items: Record<string, unknown> }).items[String(evHour.id)] === null, offBatch.body);
    ok(
      "brak sieci: endpoint podaje id w retry",
      ((offBatch.body.data as { retry?: number[] }).retry ?? []).includes(evHour.id),
      offBatch.body.data
    );
    const offDetail = await get(`/calendar/events/${evHour.id}/weather`);
    ok("brak sieci: szczegóły 200 z null", offDetail.status === 200 && offDetail.body.data === null, offDetail.body);
    offline = false;
  }

  // --- REGRESJA: endpoint jest odczytowy ------------------------------------
  {
    const snapshot = () =>
      JSON.stringify(
        db
          .select()
          .from(schema.calendarEvents)
          .where(like(schema.calendarEvents.title, `${PREFIX}%`))
          .all()
          .map((e) => ({ id: e.id, startAt: e.startAt, status: e.status, updatedAt: e.updatedAt }))
      );
    const before = snapshot();
    await get(`/calendar/weather?ids=${evHour.id},${evAllDay.id}`);
    ok("pogoda niczego nie zapisuje w kalendarzu", before === snapshot());
  }
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  delete process.env.GEO_OFFLINE;
  cleanup();
  const leftEvents = db.select().from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych wydarzeń", leftEvents.length === 0, leftEvents.length);
  const leftObjects = db.select().from(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).all();
  ok("sprzątanie: brak testowych obiektów", leftObjects.length === 0, leftObjects.length);
  const leftCache = db.select().from(schema.geoCache).where(inArray(schema.geoCache.key, [...touchedKeys])).all();
  ok("sprzątanie: brak testowych wpisów geo_cache", leftCache.length === 0, leftCache.length);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
