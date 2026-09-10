/**
 * Podgląd linków wpisanych w wolnych tekstach (notatki wydarzeń, notatki
 * obiektu, opisy). Montowane pod `/links`, POZA `API_TAB_MAP` — adres pochodzi
 * z tekstu, który użytkownik i tak widzi, a odpowiedź nie ujawnia niczego z
 * naszej bazy, więc wystarczy zalogowana sesja (jak `/company-lookup`).
 *
 * Cała robota i całe bezpieczeństwo siedzą w `src/lib/link-preview.ts` — tutaj
 * zostaje walidacja wejścia (400 dla adresu, którego nie tkniemy) i limit tempa.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ApiResponse } from "../types/index.js";
import { getUserId } from "../middleware/auth.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { getCompanyConfig } from "../lib/company-config.js";
import {
  estimateMinutes,
  isGeoError,
  officePoint,
  routeDistanceSnapped,
  straightLineKm,
  type DistanceMethod,
} from "../lib/geo.js";
import {
  checkHostname,
  getLinkPreview,
  LinkPreviewError,
  normalizeUrl,
  type LinkPreview,
} from "../lib/link-preview.js";

const app = new Hono();

/**
 * Hojny limit per użytkownik: jedna notatka pyta o maks. 3 adresy, a wyniki
 * lecą z cache'u — 300 pobrań na godzinę zobaczy tylko skrypt.
 */
const perUser = createRateLimiter({ limit: 300, windowMs: 60 * 60_000 });

// GET /links/preview?url=... — metadane strony (z cache'u albo świeżo pobrane)
app.get("/preview", async (c) => {
  const raw = c.req.query("url") ?? "";
  const normalized = normalizeUrl(raw);
  if (!normalized) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy adres URL" }, 400);
  }

  // Odrzucamy PRZED pobraniem to, czego serwerowi nie wolno tknąć — adresy
  // lokalne i prywatne. Reszta walidacji (DNS, przekierowania) siedzi w
  // `getLinkPreview` i kończy się podglądem ze `status: "error"`, bo tam chodzi
  // już o cudzą stronę, a nie o próbę sięgnięcia do naszej sieci.
  const hostProblem = checkHostname(new URL(normalized).hostname);
  if (hostProblem) {
    return c.json<ApiResponse<null>>({ success: false, error: hostProblem }, 400);
  }

  if (!perUser.check(String(getUserId(c)))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań o podgląd linków — spróbuj za chwilę" },
      429
    );
  }

  try {
    const data = await getLinkPreview(normalized);
    return c.json<ApiResponse<LinkPreview>>({ success: true, data });
  } catch (err) {
    if (err instanceof LinkPreviewError) {
      return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
    }
    console.error("[links/preview]", err);
    return c.json<ApiResponse<null>>({ success: false, error: "Nie udało się pobrać podglądu" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Dystanse do punktu z karty mapy
// ---------------------------------------------------------------------------

/**
 * Ile stąd do biura i ile do obiektu, którego dotyczy notatka.
 *
 * Po co osobna trasa zamiast `/company/travel`: tamta liczy WYŁĄCZNIE biuro →
 * obiekt z kartoteki (klucz `objectId`), a tu punktem docelowym jest pinezka
 * wklejona w tekście — nie ma jej w żadnej tabeli. Cała arytmetyka i cache i
 * tak są wspólne (`src/lib/geo.ts`, `geo_cache`, klucz po obu punktach z
 * dokładnością do 5 miejsc), więc trasa policzona tutaj jest darmowa dla
 * kalendarza i odwrotnie.
 */
export interface LinkDistance {
  km: number;
  minutes: number;
  method: DistanceMethod;
  /** Nazwa obiektu — tylko w polu `object`, żeby front nie musiał jej dociągać. */
  objectName?: string;
}

export interface LinkDistances {
  office: LinkDistance | null;
  object: LinkDistance | null;
  /**
   * Ile kilometrów dzieli pinezkę od drogi, do której liczona jest trasa
   * (pinezka bywa postawiona w lesie albo na środku osiedla). Front dopisuje
   * z tego „+ ok. 250 m pieszo od drogi”. 0 = pinezka praktycznie na drodze.
   */
  snapKm: number;
}

/**
 * OSRM stoi we wspólnej kolejce 1 req/s — przy zimnym cache'u odpowiedź mogłaby
 * przyjść po kilkunastu sekundach, a to jest ozdobnik karty, nie treść. Po
 * czterech sekundach oddajemy przybliżenie linią prostą; prawdziwa trasa
 * dojedzie do cache'u i pokaże się przy następnym otwarciu notatki.
 */
const DISTANCE_TIMEOUT_MS = 4_000;

/** Limit osobny od podglądów: karta pyta raz na punkt, a wynik siedzi w cache'u przeglądarki. */
const distancePerUser = createRateLimiter({ limit: 300, windowMs: 60 * 60_000 });

function straightDistance(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): LinkDistance & { snapKm: number } {
  const km = straightLineKm(from, to);
  return { km, minutes: estimateMinutes(km), method: "straight", snapKm: 0 };
}

/**
 * Trasa z limitem czasu; przekroczenie = przybliżenie linią prostą (nigdy nie rzuca).
 * Idzie przez `routeDistanceSnapped`, bo cel jest PINEZKĄ z notatki — może stać
 * poza siecią dróg i wymaga przyklejenia do sensownej ulicy.
 */
async function distanceWithBudget(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  useRouting: boolean
): Promise<LinkDistance & { snapKm: number }> {
  const fallback = straightDistance(from, to);
  if (!useRouting) return fallback;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      routeDistanceSnapped(from, to),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DISTANCE_TIMEOUT_MS);
      }),
    ]);
    if (!result) return fallback;
    return { km: result.km, minutes: result.minutes, method: result.method, snapKm: result.snapKm };
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// GET /links/distances?lat=&lng=&objectId= — „od biura" i „od obiektu" dla pinezki z notatki
app.get("/distances", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowe współrzędne" }, 400);
  }

  const rawObjectId = c.req.query("objectId");
  let objectId: number | null = null;
  if (rawObjectId !== undefined && rawObjectId !== "" && rawObjectId !== "null") {
    const parsed = Number(rawObjectId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return c.json<ApiResponse<null>>({ success: false, error: "Nieprawidłowy identyfikator obiektu" }, 400);
    }
    objectId = parsed;
  }

  if (!distancePerUser.check(String(getUserId(c)))) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań o dystanse — spróbuj za chwilę" },
      429
    );
  }

  const point = { lat, lng };
  // `manual` = administrator wyłączył automatyczne liczenie kilometrów; karta
  // mapy nie jest wyjątkiem od tej decyzji.
  const source = getCompanyConfig().values.kmSource;
  if (source === "manual") {
    return c.json<ApiResponse<LinkDistances>>({ success: true, data: { office: null, object: null, snapKm: 0 } });
  }
  const useRouting = source === "route";

  // Odległość pinezki od drogi jest cechą PUNKTU, nie odcinka — obie nogi
  // trasują do tego samego kandydata, więc bierzemy pierwszą znaną wartość.
  let snapKm = 0;
  let office: (LinkDistance & { snapKm: number }) | null = null;
  try {
    const from = await officePoint();
    if (!isGeoError(from)) {
      office = await distanceWithBudget(from, point, useRouting);
      snapKm = office.snapKm;
    }
  } catch (err) {
    // Brak biura w konfiguracji albo martwy geokoder — front po prostu pominie
    // fragment „Od biura", a nie zobaczy błędu.
    console.warn("[links/distances] biuro:", err);
  }

  let object: (LinkDistance & { snapKm: number }) | null = null;
  if (objectId !== null) {
    const row = db
      .select({
        name: schema.objects.name,
        latitude: schema.objects.latitude,
        longitude: schema.objects.longitude,
      })
      .from(schema.objects)
      .where(eq(schema.objects.id, objectId))
      .get();
    // Świadomie BEZ geokodowania adresu obiektu: to odczyt w tle przy renderze
    // notatki, a nie kalkulacja rozliczeniowa — obiekt bez pinezki wraca jako
    // `null` i karta milczy.
    if (row && row.latitude !== null && row.longitude !== null) {
      const from = { lat: row.latitude, lng: row.longitude };
      object = { ...(await distanceWithBudget(from, point, useRouting)), objectName: row.name };
      if (!snapKm) snapKm = object.snapKm;
    }
  }

  return c.json<ApiResponse<LinkDistances>>({ success: true, data: { office, object, snapKm } });
});

export default app;
