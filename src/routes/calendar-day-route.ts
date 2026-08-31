/**
 * Planer trasy — punkty i macierz odległości dla jednego dnia kalendarza.
 *
 * Endpoint jest w 100% ODCZYTOWY: liczy geografię dnia i nic nie zmienia w kalendarzu.
 * Plan trasy (podział na samochody, kolejność, kłódki) żyje wyłącznie w przeglądarce —
 * backend dostarcza tylko surowce: gdzie są punkty i ile między nimi jest km i minut.
 *
 * Wzorzec odpowiedzi jest ten sam co w src/routes/company.ts: odpowiadamy natychmiast
 * z cache'u (`cacheOnly: true`), a przy braku wpisów zwracamy przybliżenie linią prostą
 * z `pending: true` i doliczamy trasy w tle. Poza 400 zawsze 200 — brak biura, brak sieci
 * czy brak adresu obiektu wracają jako pola danych, bo widok ma działać dalej.
 *
 * Uprawnienia: montowane pod /calendar, więc `API_TAB_MAP` łapie je wpisem
 * { prefix: "/calendar", tabs: ["technical/kalendarz"] } — GET przechodzi przy poziomie `view`.
 * NIE dopisywać tego do `isOwnPreference` (to nie jest preferencja użytkownika).
 */
import { Hono } from "hono";
import { createHash } from "crypto";
import { and, asc, gt, inArray, isNull, lt } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getCompanyConfig } from "../lib/company-config.js";
import { DATE_RE } from "../lib/calendar-mutations.js";
import { loadEvents } from "../lib/calendar-queries.js";
import {
  MAX_MATRIX_POINTS,
  geoNetworkEnabled,
  isGeoError,
  objectPoint,
  officePoint,
  routeMatrix,
  type DistanceMethod,
  type GeoPoint,
} from "../lib/geo.js";
import type { ApiResponse } from "../types/index.js";

const app = new Hono();

/** Typy wydarzeń, które z definicji nie są wyjazdem do obiektu. */
const OFF_SITE_TYPES = new Set(["urlop", "biuro", "przygotowanie"]);

/** Dlaczego wydarzenie nie weszło na trasę. */
export type DayRouteSkip = "no-object" | "no-coords" | "all-day" | "off-site" | "cancelled" | "limit";

const SKIP_MESSAGES: Record<DayRouteSkip, string> = {
  "no-object": "Brak przypiętego obiektu — nie wiadomo, dokąd jechać",
  "no-coords": "Obiekt bez adresu i współrzędnych — uzupełnij kartotekę obiektu",
  "all-day": "Wydarzenie całodniowe — bez godzin nie da się ułożyć osi czasu",
  "off-site": "Nie jest wyjazdem do obiektu",
  cancelled: "Wydarzenie anulowane",
  limit: `Za dużo punktów w jednym dniu (limit ${MAX_MATRIX_POINTS})`,
};

export interface DayRoutePoint {
  /** "office" albo "obj:<id>" — spina punkt z macierzą i z wydarzeniami. */
  key: string;
  kind: "office" | "object";
  objectId: number | null;
  label: string;
  address: string | null;
  city: string | null;
  lat: number;
  lng: number;
}

export interface DayRouteEvent {
  eventId: number;
  /** Klucz punktu w `points`; null zawsze razem z `skip`. */
  pointKey: string | null;
  skip: DayRouteSkip | null;
  skipMessage: string | null;
}

export interface DayRouteMatrix {
  /** Kolejność wierszy i kolumn; indeks 0 to biuro, gdy `office !== null`. */
  keys: string[];
  km: number[][];
  minutes: number[][];
  method: DistanceMethod[][];
}

export interface DayRoute {
  date: string;
  office: DayRoutePoint | null;
  officeError: string | null;
  points: DayRoutePoint[];
  events: DayRouteEvent[];
  matrix: DayRouteMatrix | null;
  /** true = część par to jeszcze linia prosta; trasy doliczają się w tle. */
  pending: boolean;
  /** Ile punktów odcięto limitem. */
  truncated: number;
  /** Ostrzeżenia PL do paska nad mapą. */
  notes: string[];
}

/**
 * Doliczenie macierzy w tle. Klucz to hasz ZESTAWU punktów, żeby dwa równoległe otwarcia
 * tego samego dnia nie odpaliły dwóch zapytań `/table`.
 */
const inflight = new Map<string, Promise<unknown>>();

function warmMatrix(points: { lat: number; lng: number }[]): void {
  const key = createHash("sha1")
    .update(points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|"))
    .digest("hex");
  if (inflight.has(key)) return;
  const p = routeMatrix(points)
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

/** Dzień następny w formacie YYYY-MM-DD (granica zakresu, wyłączna). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
}

/**
 * GET /day-route?date=YYYY-MM-DD[&eventIds=1,2,3]
 *
 * `eventIds` zawęża plan do wydarzeń, które użytkownik faktycznie widzi — kalendarz ma
 * filtry klientowe (typ, technik, status), więc plan liczony ze wszystkich wydarzeń dnia
 * rozjeżdżałby się z ekranem.
 */
app.get("/day-route", async (c) => {
  const date = c.req.query("date") ?? "";
  if (!DATE_RE.test(date)) {
    return c.json<ApiResponse<null>>({ success: false, error: "Parametr date: YYYY-MM-DD" }, 400);
  }
  const onlyIds = parseIdList(c.req.query("eventIds"));
  if (c.req.query("eventIds") !== undefined && onlyIds.length === 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Pusta lista wydarzeń (eventIds)" }, 400);
  }

  // Nachodzenie na dzień: start < jutro AND end > dziś. Porównanie leksykalne ISO działa
  // także między "YYYY-MM-DD" a "YYYY-MM-DDTHH:MM" (jak w GET /events).
  // `endAt` całodniowych jest WYŁĄCZNY (jutro), więc `>` — nie `>=` — jest tu konieczne,
  // inaczej wciągnęlibyśmy wydarzenia kończące się dzień wcześniej.
  const ids = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        lt(schema.calendarEvents.startAt, nextDay(date)),
        gt(schema.calendarEvents.endAt, date)
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .limit(500)
    .all()
    .map((r) => r.id);

  const wanted = onlyIds.length ? ids.filter((id) => onlyIds.includes(id)) : ids;
  const events = loadEvents(db, wanted);

  const notes: string[] = [];
  const { values } = getCompanyConfig();

  // Źródło km: planer niczego nie rozlicza, więc tryb "ręcznie" (który wyłącza kalkulację
  // kwot w realizacjach) NIE może wyłączyć mapy — liczymy jak "route" i tylko o tym mówimy.
  // Tryb "straight" honorujemy: firma świadomie wyłączyła OSRM.
  const useRouting = values.kmSource !== "straight";
  if (values.kmSource === "manual") {
    notes.push("Źródło km ustawione na „ręcznie” — odległości poniżej są orientacyjne i niczego nie rozliczają.");
  }
  if (values.kmSource === "straight") {
    notes.push("Źródło km ustawione na „linia prosta” — odległości są przybliżone (×1,3), bez trasowania.");
  }

  // --- Punkty ---
  const office = await officePoint({ cacheOnly: true });
  const officeError = isGeoError(office) ? office.error : null;
  if (officeError) notes.push(officeError);

  const points: DayRoutePoint[] = [];
  const outEvents: DayRouteEvent[] = [];
  /** Dedup po współrzędnych — dwa obiekty w tym samym budynku to jeden punkt macierzy. */
  const keyByCoord = new Map<string, string>();
  const keyByObject = new Map<number, string>();
  const coordKey = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

  let officePointOut: DayRoutePoint | null = null;
  if (!isGeoError(office)) {
    officePointOut = {
      key: "office",
      kind: "office",
      objectId: null,
      label: office.label,
      address: values.officeAddress || null,
      city: values.officeCity || null,
      lat: office.lat,
      lng: office.lng,
    };
    points.push(officePointOut);
    keyByCoord.set(coordKey(office), "office");
  }

  let truncated = 0;

  for (const ev of events) {
    const skip = (reason: DayRouteSkip) =>
      outEvents.push({ eventId: ev.id, pointKey: null, skip: reason, skipMessage: SKIP_MESSAGES[reason] });

    if (ev.status === "cancelled") { skip("cancelled"); continue; }
    if (OFF_SITE_TYPES.has(ev.type)) { skip("off-site"); continue; }
    if (ev.allDay) { skip("all-day"); continue; }
    if (ev.objectId == null) { skip("no-object"); continue; }

    const known = keyByObject.get(ev.objectId);
    if (known) {
      outEvents.push({ eventId: ev.id, pointKey: known, skip: null, skipMessage: null });
      continue;
    }

    // Bezpiecznik: nie wołamy geokodera bez końca, gdy dzień ma absurdalnie dużo obiektów.
    if (points.length >= MAX_MATRIX_POINTS) { truncated++; skip("limit"); continue; }

    const pt = await objectPoint(ev.objectId, { cacheOnly: true });
    if (isGeoError(pt)) { skip("no-coords"); continue; }

    // Ten sam adres co inny punkt (także biuro) — reużywamy klucza zamiast dublować wiersz macierzy.
    const dup = keyByCoord.get(coordKey(pt));
    if (dup) {
      keyByObject.set(ev.objectId, dup);
      outEvents.push({ eventId: ev.id, pointKey: dup, skip: null, skipMessage: null });
      continue;
    }

    const key = `obj:${ev.objectId}`;
    points.push({
      key,
      kind: "object",
      objectId: ev.objectId,
      label: pt.label || ev.objectName || `Obiekt ${ev.objectId}`,
      address: null,
      city: null,
      lat: pt.lat,
      lng: pt.lng,
    });
    keyByCoord.set(coordKey(pt), key);
    keyByObject.set(ev.objectId, key);
    outEvents.push({ eventId: ev.id, pointKey: key, skip: null, skipMessage: null });
  }

  // Adresy obiektów (do etykiety pinezki i sekcji „poza trasą") — jedno zapytanie zbiorcze,
  // bo `objectPoint` zwraca tylko współrzędne i nazwę.
  const objectIds = points.map((p) => p.objectId).filter((id): id is number => id != null);
  if (objectIds.length > 0) {
    const rows = db
      .select({ id: schema.objects.id, address: schema.objects.address, city: schema.objects.city })
      .from(schema.objects)
      .where(inArray(schema.objects.id, objectIds))
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const pt of points) {
      if (pt.objectId == null) continue;
      const row = byId.get(pt.objectId);
      if (!row) continue;
      pt.address = row.address;
      pt.city = row.city;
    }
  }

  // --- Macierz ---
  let matrix: DayRouteMatrix | null = null;
  let pending = false;

  if (points.length >= 2) {
    const coords = points.map((p) => ({ lat: p.lat, lng: p.lng }));
    const res = await routeMatrix(coords, { cacheOnly: true, useRouting });
    matrix = { keys: points.map((p) => p.key), km: res.km, minutes: res.minutes, method: res.method };

    if (res.missing > 0 && useRouting && geoNetworkEnabled()) {
      pending = true;
      warmMatrix(coords);
    } else if (res.missing > 0 && useRouting) {
      notes.push("Brak połączenia z serwerem tras — odległości liczone w linii prostej.");
    }
  }

  if (truncated > 0) {
    notes.push(`Dzień ma więcej obiektów, niż planer liczy naraz — pominięto ${truncated}.`);
  }

  return c.json<ApiResponse<DayRoute>>({
    success: true,
    data: {
      date,
      office: officePointOut,
      officeError,
      points,
      events: outEvents,
      matrix,
      pending,
      truncated,
      notes,
    },
  });
});

export default app;
