import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db, schema } from "../db/index.js";
import { and, eq, gte, sql } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { createOrderFromInput, parseOrderInput } from "../services/orders.js";
import { lookupCompanyByNip, isMfError } from "../lib/mf-whitelist.js";
import { createRateLimiter, clientIp } from "../lib/rate-limit.js";
import { isValidationError } from "../lib/validate.js";

const app = new Hono();

/**
 * Limit ciała dla CAŁEGO /public: formularz ZDW z uwagami to kilka KB, link do
 * mapy — kilkaset bajtów. 64 KB to zapas z dużym marginesem, a bez sufitu anonim
 * mógł wysyłać megabajty JSON-u do sparsowania. 413 zamiast domyślnego tekstu.
 */
app.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json<ApiResponse<null>>(
        { success: false, error: "Dane formularza są zbyt duże" },
        413
      ),
  })
);

/**
 * Pola przyjmowane z zewnętrznego (anonimowego) formularza ZDW. Podzbiór
 * `OrderInput` — polityka powiązania z CRM (status, tworzenie obiektu, kontrahent)
 * jest WYMUSZANA po stronie serwera; wszystko poza tą listą jest odrzucane.
 */
const PUBLIC_INTAKE_FIELDS = [
  "requesterName",
  "requesterPhone",
  "requesterEmail",
  "payerName",
  "payerNip",
  "payerInvoiceEmail",
  "isCameraInstallation",
  "vtoolsOfferNumber",
  "internetIncluded",
  "interventionGroup",
  "videoReception",
  "monthlyAmount",
  "contractLengthMonths",
  "rentalAmount",
  "rentalLengthMonths",
  "invoiceIssuer",
  "cameraCount",
  "megaphoneCount",
  "objectName",
  "objectKind",
  "objectAddress",
  "objectCity",
  "objectLocationUrl",
  "contactPerson",
  "contactPhone",
  "contactEmail",
  "serviceStartDate",
  "installationStartDate",
  "notes",
] as const;

// ---------------------------------------------------------------------------
// Wyszukiwarka firm dla formularza publicznego
// ---------------------------------------------------------------------------

/**
 * Limit per IP: 5 zapytań na 5 minut. Wypełniając formularz, człowiek sprawdza
 * jeden NIP (rzadziej dwa) — pięć prób z zapasem starcza, a bot nie zdąży
 * przemielić wykazu MF spod naszego adresu.
 */
const publicLookupPerIp = createRateLimiter({ limit: 5, windowMs: 5 * 60_000 });

/**
 * Limit globalny dla całej trasy. `X-Forwarded-For` da się podrobić, więc sam
 * limit per IP nie zatrzymałby uporczywego bota — ten sufit zatrzyma.
 */
const publicLookupGlobal = createRateLimiter({ limit: 120, windowMs: 5 * 60_000 });

// Dane firmy po NIP z wykazu VAT MF — dla anonimowego formularza ZDW.
// Bez autoryzacji (trasa montowana przed requireAuth), więc mocno limitowana.
app.get("/company-lookup/nip/:nip", async (c) => {
  const nip = normalizeNIP(c.req.param("nip"));

  // Walidacja przed limitem: literówka w NIP-ie nie może zjadać puli zapytań.
  if (!validateNIP(nip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nieprawidłowy NIP (błędna suma kontrolna)" },
      400
    );
  }

  if (!publicLookupPerIp.check(clientIp(c)) || !publicLookupGlobal.check("all")) {
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: "Za dużo zapytań do wykazu firm — spróbuj ponownie za kilka minut",
      },
      429
    );
  }

  const result = await lookupCompanyByNip(nip);

  if (isMfError(result)) {
    return c.json<ApiResponse<null>>({ success: false, error: result.error }, 502);
  }

  // Formularz publiczny dostaje tylko to, co potrzebne do wypełnienia pól —
  // rachunków bankowych i danych rejestrowych nie ma po co wystawiać anonimowo.
  const company = result.company
    ? {
        nip: result.company.nip,
        name: result.company.name,
        address: result.company.address,
        postalCode: result.company.postalCode,
        city: result.company.city,
        statusVat: result.company.statusVat,
        date: result.company.date,
      }
    : null;

  return c.json<ApiResponse<{ found: boolean; company: typeof company }>>({
    success: true,
    data: { found: result.found, company },
  });
});

// ---------------------------------------------------------------------------
// Przyjęcie zlecenia z publicznego formularza ZDW
// ---------------------------------------------------------------------------

/**
 * Limit per IP: 10 zleceń na godzinę. Jedna firma składa jedno, czasem dwa
 * zlecenia — dziesięć to zapas na poprawki, a skrypt nie zaśmieci CRM tysiącem
 * kontrahentów i obiektów `pending`.
 */
const intakePerIp = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
/** Sufit globalny — na wypadek rotowanego XFF (patrz src/lib/rate-limit.ts). */
const intakeGlobal = createRateLimiter({ limit: 200, windowMs: 60 * 60_000 });

/** Klucz deduplikacji: ta sama nazwa obiektu niezależnie od wielkości liter i odstępów. */
function dedupObjectKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Zlecenie z tego samego NIP-u na ten sam obiekt złożone w ciągu ostatnich 24 h.
 * Podwójne kliknięcie „Wyślij", odświeżenie strony po wysyłce, ponowna próba po
 * zerwanym połączeniu — wszystko to wracało jako DRUGIE zlecenie z DRUGIM obiektem.
 */
function findRecentDuplicate(nip: string, objectName: string) {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const rows = db
    .select({
      id: schema.orders.id,
      orderNumber: schema.orders.orderNumber,
      objectName: schema.orders.objectName,
    })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.payerNip, nip),
        // `created_at` to `datetime('now')` (UTC, „YYYY-MM-DD HH:MM:SS") — porównanie tekstowe działa.
        gte(schema.orders.createdAt, since),
        sql`${schema.orders.status} <> 'cancelled'`
      )
    )
    .all();
  const key = dedupObjectKey(objectName);
  return rows.find((r) => dedupObjectKey(r.objectName) === key) ?? null;
}

// Public order intake — creates a real CRM order from an external form.
// No authentication (mounted before requireAuth). CRM-linking policy is
// forced server-side; the client is never trusted for it.
app.post("/order-intake", async (c) => {
  try {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowe dane formularza" },
        400
      );
    }
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowe dane formularza" },
        400
      );
    }

    // Whitelist PRZED walidacją: `status`, `objectId`, `payerContractorId`,
    // `createObject` z body lądują w koszu, a nie w zleceniu.
    const body = rawBody as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of PUBLIC_INTAKE_FIELDS) {
      if (key in body) picked[key] = body[key];
    }

    // Wymuszona polityka CRM — nigdy z klienta.
    picked.status = "new";
    picked.createObject = true;
    picked.objectType = "monitoring";
    picked.objectInstallationType = "new";
    picked.createContractor = true;

    let input: OrderInput;
    try {
      input = parseOrderInput(picked);
    } catch (err) {
      if (isValidationError(err)) {
        return c.json<ApiResponse<null>>({ success: false, error: err.message }, 400);
      }
      throw err;
    }

    // NIP przed limitem: literówka w NIP-ie nie zjada puli zgłoszeń.
    const normalizedNip = normalizeNIP(input.payerNip);
    if (!validateNIP(normalizedNip)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy NIP" },
        400
      );
    }
    input.payerNip = normalizedNip;

    // Deduplikacja PRZED limitem i przed tworzeniem: powtórka dostaje to samo
    // zlecenie (200), bo anonimowy nadawca nie ma jak sprawdzić, czy pierwsza
    // wysyłka doszła — 409 zostawiłby go z pytaniem „to złożyłem czy nie?".
    const duplicate = findRecentDuplicate(normalizedNip, input.objectName);
    if (duplicate) {
      return c.json<ApiResponse<{ orderNumber: string; duplicate: true }>>(
        { success: true, data: { orderNumber: duplicate.orderNumber, duplicate: true } },
        200
      );
    }

    if (!intakePerIp.check(clientIp(c)) || !intakeGlobal.check("all")) {
      return c.json<ApiResponse<null>>(
        {
          success: false,
          error: "Za dużo zgłoszeń z tego adresu — spróbuj ponownie za godzinę",
        },
        429
      );
    }

    // Contractor-reuse policy: if a contractor with this NIP already exists,
    // reuse it (anonymous returning customers must NOT hit a 409). Otherwise
    // create a fresh contractor. Obiekt trafia do portfela istniejącego
    // kontrahenta ze statusem `pending` i wpisem w historii „z formularza ZDW
    // (do weryfikacji)" — handlowiec widzi, że to zgłoszenie z zewnątrz.
    const existing = await db
      .select({ id: schema.contractors.id })
      .from(schema.contractors)
      .where(eq(schema.contractors.nip, normalizedNip))
      .limit(1);

    const reuseContractor = existing.length > 0;
    input.createContractor = !reuseContractor;
    input.payerContractorId = reuseContractor ? existing[0].id : undefined;

    let result = await createOrderFromInput(input, { source: "public" });

    // Race guard: our SELECT above and the transaction's own NIP re-check
    // straddle await points, so two concurrent same-NIP intakes can both
    // pick createContractor=true. The first commits the contractor; the
    // second's transaction then re-checks, finds it and returns 409. Per
    // policy, returning/duplicate-NIP intakes must REUSE the contractor,
    // not fail — so on that 409 re-select the now-existing contractor and
    // retry once as a reuse.
    if (!result.ok && result.status === 409) {
      const nowExisting = await db
        .select({ id: schema.contractors.id })
        .from(schema.contractors)
        .where(eq(schema.contractors.nip, normalizedNip))
        .limit(1);
      if (nowExisting.length > 0) {
        input.createContractor = false;
        input.payerContractorId = nowExisting[0].id;
        result = await createOrderFromInput(input, { source: "public" });
      }
    }

    if (!result.ok) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie udało się utworzyć zlecenia" },
        500
      );
    }

    return c.json<ApiResponse<{ orderNumber: string }>>(
      { success: true, data: { orderNumber: result.orderNumber } },
      201
    );
  } catch (error) {
    console.error("Error in public order intake:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się utworzyć zlecenia" },
      500
    );
  }
});

// ---------------------------------------------------------------------------
// Rozwiązywanie skróconych linków Google Maps
// ---------------------------------------------------------------------------

/**
 * Extract lat/lng from a Google Maps URL or HTML body. Covers the shapes a
 * resolved short link can land on: @lat,lng · !3d..!4d.. · ?q=/ll=/center=lat,lng.
 */
function extractCoords(text: string): { lat: number; lng: number } | null {
  const inRange = (lat: number, lng: number) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    // /maps/search/<lat>,+<lng> · /place/<lat>,<lng> · /dir/<lat>,<lng>
    /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?),\+?\s*(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|ll|center|destination|query)=(?:loc:)?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (inRange(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

/**
 * Hosty, do których serwer w ogóle wykona żądanie. Lista DOKŁADNA (host równy
 * albo poddomena) — poprzedni wzorzec `google\.[a-z.]+` przepuszczał
 * `google.evil.com`, a `redirect: "follow"` pozwalał skróconemu linkowi
 * poprowadzić serwer pod dowolny adres, także w sieci wewnętrznej (SSRF).
 *
 * Skąd biorą się linki: użytkownik wkleja z aplikacji Google Maps —
 * `maps.app.goo.gl/…`, `goo.gl/maps/…`, `g.co/kgs/…` — które przekierowują na
 * `www.google.com/maps/…` albo `www.google.pl/maps/…` (patrz LocationPicker.tsx).
 */
const ALLOWED_HOST_SUFFIXES = ["google.com", "google.pl", "goo.gl", "g.co"] as const;

function isAllowedMapsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Adres z allowlisty, http(s), bez loginu/hasła w URL-u. */
function parseAllowedMapsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!isAllowedMapsHost(u.hostname)) return null;
  return u;
}

const RESOLVE_TIMEOUT_MS = 5_000;
const RESOLVE_MAX_HOPS = 3;
const RESOLVE_MAX_BYTES = 512 * 1024;

/**
 * Czyta ciało odpowiedzi do limitu bajtów — strona Google Maps waży megabajty,
 * a współrzędne siedzą w pierwszych kilkuset KB (meta/og:image/URL kanoniczny).
 */
async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const ch of chunks) {
    const slice = ch.subarray(0, Math.max(0, merged.length - offset));
    merged.set(slice, offset);
    offset += slice.length;
    if (offset >= merged.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/**
 * Limit per IP na rozwiązywanie linków: 30 na 5 minut — człowiek wkleja jeden,
 * może poprawi dwa razy; każde wywołanie to wyjście serwera do sieci.
 */
const resolvePerIp = createRateLimiter({ limit: 30, windowMs: 5 * 60_000 });
const resolveGlobal = createRateLimiter({ limit: 300, windowMs: 5 * 60_000 });

// Resolve a Google Maps short link (maps.app.goo.gl / goo.gl/maps / g.co) into
// coordinates by following the redirect server-side (browsers can't — CORS).
// Host-allowlisted to Google domains to avoid SSRF. No auth (public form).
app.get("/resolve-location", async (c) => {
  const url = c.req.query("url");
  if (!url || url.length > 2000) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Podaj prawidłowy link" },
      400
    );
  }

  const start = parseAllowedMapsUrl(url);
  if (!start) {
    // Rozróżniamy niepoprawny URL od poprawnego, ale spoza Google — komunikat
    // dla użytkownika jest wtedy konkretniejszy.
    let parses = false;
    try {
      new URL(url);
      parses = true;
    } catch {
      parses = false;
    }
    return c.json<ApiResponse<null>>(
      {
        success: false,
        error: parses ? "Obsługiwane są tylko linki Google Maps" : "Podaj prawidłowy link",
      },
      400
    );
  }

  if (!resolvePerIp.check(clientIp(c)) || !resolveGlobal.check("all")) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Za dużo zapytań — spróbuj ponownie za kilka minut" },
      429
    );
  }

  try {
    const headers = {
      // A real UA — goo.gl serves a bare redirect stub to bots otherwise.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "pl,en;q=0.9",
    };

    // Przekierowania śledzimy RĘCZNIE: każdy skok sprawdzamy na allowliście, bo
    // skrócony link może wskazywać dokądkolwiek — w tym na adresy prywatne.
    let current = start;
    let res: Response | null = null;
    for (let hop = 0; hop <= RESOLVE_MAX_HOPS; hop++) {
      // Współrzędne bywają już w samym adresie po przekierowaniu — bez pobierania ciała.
      const fromUrl = extractCoords(current.href);
      if (fromUrl && hop > 0) {
        return c.json<ApiResponse<{ lat: number; lng: number }>>({ success: true, data: fromUrl });
      }

      res = await fetch(current, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });

      const location = res.headers.get("location");
      const isRedirect = res.status >= 300 && res.status < 400 && location;
      if (!isRedirect) break;

      await res.body?.cancel().catch(() => undefined);
      if (hop === RESOLVE_MAX_HOPS) {
        return c.json<ApiResponse<null>>(
          { success: false, error: "Link ma zbyt wiele przekierowań" },
          422
        );
      }
      const next = parseAllowedMapsUrl(new URL(location, current).href);
      if (!next) {
        return c.json<ApiResponse<null>>(
          { success: false, error: "Link prowadzi poza Google Maps" },
          400
        );
      }
      current = next;
    }

    let coords = extractCoords(current.href);
    if (!coords && res) {
      const body = await readBodyLimited(res, RESOLVE_MAX_BYTES);
      coords = extractCoords(body);
    }

    if (!coords) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nie udało się odczytać współrzędnych z linku" },
        422
      );
    }

    return c.json<ApiResponse<{ lat: number; lng: number }>>({
      success: true,
      data: coords,
    });
  } catch (error) {
    console.error("Error resolving location link:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Nie udało się rozpoznać linku" },
      502
    );
  }
});

export default app;
