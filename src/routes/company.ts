/**
 * Firma — lekki odczyt dla zalogowanych (/api/company/*).
 *
 * Pełne ustawienia firmy (stawki, automat, źródła km) siedzą w /api/admin/company/settings
 * za `requireAdmin`. Mapa realizacji potrzebuje z nich wyłącznie znacznika biura, a dialog
 * kalendarza — dystansu i czasu dojazdu, więc wystawiamy je osobno: geografia bez żadnych
 * danych kosztowych (stawki i kwoty zostają w panelu admina).
 *
 * UWAGA przy zmianach uprawnień: `/company` celowo NIE ma wpisu w `API_TAB_MAP`
 * (src/middleware/auth.ts) — dodanie go odcięłoby technikom zarówno dojazd w kalendarzu,
 * jak i znacznik biura na mapie realizacji.
 */
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getCompanyConfig, officeAddressLine } from "../lib/company-config.js";
import { distanceForObject, geoNetworkEnabled, isGeoError, type GeoPoint } from "../lib/geo.js";
import type { ApiResponse } from "../types/index.js";

const app = new Hono();

/** Znacznik biura na mapie: { address, city, lat, lng } (lat/lng null = nieustalone). */
app.get("/office", (c) => {
  const { values } = getCompanyConfig();
  return c.json({
    success: true,
    data: {
      address: officeAddressLine(values),
      city: values.officeCity,
      lat: values.officeLat,
      lng: values.officeLng,
    },
  });
});

// ---------------------------------------------------------------------------
// Dojazd biuro → obiekt
// ---------------------------------------------------------------------------

export interface CompanyTravel {
  objectId: number;
  /** W jedną stronę; `null` tylko razem z `error`. */
  km: number | null;
  minutes: number | null;
  method: "route" | "straight" | null;
  /** true = czas policzony ze średniej prędkości, nie z trasy OSRM. */
  minutesEstimated: boolean;
  cached: boolean;
  /** true = wynik tymczasowy (liczy się w tle); warto odpytać ponownie za chwilę. */
  pending: boolean;
  from: GeoPoint | null;
  to: GeoPoint | null;
  /** Czytelny komunikat PL zamiast 500 (brak adresu, tryb ręczny, brak sieci). */
  error: string | null;
}

/**
 * Doliczenie pełnego wyniku w tle. Efektem ubocznym jest zapis do `geo_cache`
 * i uzupełnienie `objects.latitude/longitude`, więc kolejne pytanie trafia w cache.
 */
const inflight = new Map<number, Promise<unknown>>();

function warmTravel(objectId: number): void {
  if (inflight.has(objectId)) return;
  const p = distanceForObject(objectId)
    .catch(() => undefined)
    .finally(() => inflight.delete(objectId));
  inflight.set(objectId, p);
}

/** Maksymalna liczba obiektów w jednym pytaniu zbiorczym. */
export const TRAVEL_BATCH_LIMIT = 200;
/**
 * Ile tras wolno dołożyć do kolejki w tle na jedno pytanie zbiorczne. Doliczanie idzie przez
 * throttlowany geokoder (1 zapytanie/s), więc przy pierwszym wejściu na kalendarz z setką
 * obiektów rozkładamy pracę na kilka odsłon zamiast zapychać kolejkę na kwadrans.
 */
const WARM_PER_BATCH = 10;

/** Policz dojazd dla jednego obiektu — z cache'u, bez ruchu sieciowego. */
async function travelFor(
  objectId: number,
  source: ReturnType<typeof getCompanyConfig>["values"]["kmSource"]
): Promise<{ data: CompanyTravel; wantsWarm: boolean }> {
  const base: CompanyTravel = {
    objectId,
    km: null,
    minutes: null,
    method: null,
    minutesEstimated: false,
    cached: false,
    pending: false,
    from: null,
    to: null,
    error: null,
  };

  const fast = await distanceForObject(objectId, { cacheOnly: true, source });

  if (isGeoError(fast)) {
    // Brak wpisu w cache / tryb offline da się jeszcze naprawić siecią; brak adresu i tryb
    // ręczny to stan trwały — wtedy nie ma po co niczego doliczać w tle.
    const retryable = /w cache|offline/i.test(fast.error);
    const wantsWarm = retryable && geoNetworkEnabled() && source !== "manual";
    return { data: { ...base, pending: wantsWarm, error: fast.error }, wantsWarm };
  }

  // Sygnatura cache-missa: pytaliśmy o trasę, a dostaliśmy świeżo policzoną linię prostą.
  const missed = source === "route" && fast.method === "straight" && !fast.cached;
  const wantsWarm = missed && geoNetworkEnabled();
  return {
    data: {
      ...base,
      km: fast.km,
      minutes: fast.minutes,
      method: fast.method,
      minutesEstimated: fast.minutesEstimated,
      cached: fast.cached,
      pending: wantsWarm,
      from: fast.from,
      to: fast.to,
    },
    wantsWarm,
  };
}

/**
 * GET /travel — dystans i przewidywany czas dojazdu z biura do obiektu.
 *
 * Dwa tryby, bo kalendarz i formularz mają różne potrzeby:
 *   ?objectId=123        → `data` = pojedynczy wynik (formularz wydarzenia),
 *   ?objectIds=1,2,3     → `data` = tablica wyników (dymki całego widoku jednym strzałem,
 *                          zamiast kilkudziesięciu równoległych zapytań).
 *
 * Odpowiada z cache'u (bez ruchu sieciowego), żeby nie wieszać UI na throttlowanych
 * zapytaniach do Nominatim/OSRM: przy braku wpisu zwraca przybliżenie linią prostą
 * z `pending: true` i dolicza trasę w tle. Poza 400/404 zawsze 200 — brak adresu czy
 * brak sieci wraca jako `data.error`, bo formularz kalendarza ma działać dalej.
 */
app.get("/travel", async (c) => {
  const raw = c.req.query("objectIds");
  const source = getCompanyConfig().values.kmSource;

  // --- Tryb zbiorczy ---
  if (raw !== undefined) {
    const ids = [
      ...new Set(
        raw
          .split(",")
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isInteger(v) && v > 0)
      ),
    ];
    if (ids.length === 0) {
      return c.json<ApiResponse<null>>({ success: false, error: "Pusta lista obiektów (objectIds)" }, 400);
    }
    if (ids.length > TRAVEL_BATCH_LIMIT) {
      return c.json<ApiResponse<null>>(
        { success: false, error: `Za dużo obiektów naraz (limit ${TRAVEL_BATCH_LIMIT})` },
        400
      );
    }

    const known = new Set(
      db
        .select({ id: schema.objects.id })
        .from(schema.objects)
        .where(inArray(schema.objects.id, ids))
        .all()
        .map((r) => r.id)
    );

    const out: CompanyTravel[] = [];
    let warmed = 0;
    for (const id of ids) {
      if (!known.has(id)) {
        out.push({
          objectId: id,
          km: null,
          minutes: null,
          method: null,
          minutesEstimated: false,
          cached: false,
          pending: false,
          from: null,
          to: null,
          error: "Nie znaleziono obiektu",
        });
        continue;
      }
      const { data, wantsWarm } = await travelFor(id, source);
      if (wantsWarm && warmed < WARM_PER_BATCH) {
        warmTravel(id);
        warmed++;
      }
      // Poza limitem doliczania `pending` nadal jest prawdą — klient wróci po to przy
      // kolejnym odświeżeniu widoku, a my nie zapychamy kolejki geokodera na raz.
      out.push(data);
    }
    return c.json<ApiResponse<CompanyTravel[]>>({ success: true, data: out });
  }

  // --- Tryb pojedynczy ---
  const objectId = Number(c.req.query("objectId"));
  if (!Number.isInteger(objectId) || objectId <= 0) {
    return c.json<ApiResponse<null>>({ success: false, error: "Wskaż obiekt (objectId)" }, 400);
  }

  const object = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(eq(schema.objects.id, objectId))
    .get();
  if (!object) return c.json<ApiResponse<null>>({ success: false, error: "Nie znaleziono obiektu" }, 404);

  const { data, wantsWarm } = await travelFor(objectId, source);
  if (wantsWarm) warmTravel(objectId);
  return c.json<ApiResponse<CompanyTravel>>({ success: true, data });
});

export default app;
