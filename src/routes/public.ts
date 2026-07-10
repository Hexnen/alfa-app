import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { createOrderFromInput } from "../services/orders.js";

const app = new Hono();

/**
 * Fields accepted from the external (anonymous) ZDW order form.
 * Subset of OrderInput — CRM-linking policy is forced server-side.
 */
interface PublicOrderIntake {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  payerName: string;
  payerNip: string;
  payerInvoiceEmail?: string;
  isCameraInstallation?: boolean;
  vtoolsOfferNumber?: string;
  internetIncluded?: boolean;
  interventionGroup?: boolean;
  videoReception?: boolean;
  monthlyAmount?: number;
  contractLengthMonths?: number;
  rentalAmount?: number;
  rentalLengthMonths?: number;
  invoiceIssuer?: string;
  cameraCount?: number;
  megaphoneCount?: number;
  objectName: string;
  objectKind?: string;
  objectAddress?: string;
  objectCity?: string;
  objectLocationUrl?: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail?: string;
  serviceStartDate?: string;
  installationStartDate?: string;
  notes?: string;
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// Public order intake — creates a real CRM order from an external form.
// No authentication (mounted before requireAuth). CRM-linking policy is
// forced server-side; the client is never trusted for it.
app.post("/order-intake", async (c) => {
  try {
    let body: PublicOrderIntake;
    try {
      body = await c.req.json<PublicOrderIntake>();
    } catch {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowe dane formularza" },
        400
      );
    }

    // Required-field guard
    const requiredMissing =
      !isNonEmpty(body.requesterName) ||
      !isNonEmpty(body.requesterPhone) ||
      !isNonEmpty(body.requesterEmail) ||
      !isNonEmpty(body.payerName) ||
      !isNonEmpty(body.payerNip) ||
      !isNonEmpty(body.objectName) ||
      !isNonEmpty(body.contactPerson) ||
      !isNonEmpty(body.contactPhone);

    if (requiredMissing) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Brakuje wymaganych pól formularza" },
        400
      );
    }

    // Validate NIP
    const normalizedNip = normalizeNIP(body.payerNip);
    if (!validateNIP(normalizedNip)) {
      return c.json<ApiResponse<null>>(
        { success: false, error: "Nieprawidłowy NIP" },
        400
      );
    }

    // Contractor-reuse policy: if a contractor with this NIP already exists,
    // reuse it (anonymous returning customers must NOT hit a 409). Otherwise
    // create a fresh contractor.
    const existing = await db
      .select({ id: schema.contractors.id })
      .from(schema.contractors)
      .where(eq(schema.contractors.nip, normalizedNip))
      .limit(1);

    const reuseContractor = existing.length > 0;

    // Build the OrderInput, forcing the CRM-linking policy server-side.
    const input: OrderInput = {
      requesterName: body.requesterName,
      requesterPhone: body.requesterPhone,
      requesterEmail: body.requesterEmail,
      payerName: body.payerName,
      payerNip: normalizedNip,
      payerInvoiceEmail: body.payerInvoiceEmail,
      objectName: body.objectName,
      objectKind: body.objectKind,
      objectAddress: body.objectAddress,
      objectCity: body.objectCity,
      objectLocationUrl: body.objectLocationUrl,
      contactPerson: body.contactPerson,
      contactPhone: body.contactPhone,
      contactEmail: body.contactEmail,
      isCameraInstallation: body.isCameraInstallation,
      cameraCount: body.cameraCount,
      megaphoneCount: body.megaphoneCount,
      vtoolsOfferNumber: body.vtoolsOfferNumber,
      internetIncluded: body.internetIncluded,
      interventionGroup: body.interventionGroup,
      videoReception: body.videoReception,
      monthlyAmount: body.monthlyAmount,
      contractLengthMonths: body.contractLengthMonths,
      rentalAmount: body.rentalAmount,
      rentalLengthMonths: body.rentalLengthMonths,
      invoiceIssuer: body.invoiceIssuer,
      serviceStartDate: body.serviceStartDate,
      installationStartDate: body.installationStartDate,
      notes: body.notes,
      // Forced CRM-linking policy — never trust the client for these
      status: "new",
      createObject: true,
      objectType: "monitoring",
      objectInstallationType: "new",
      // Contractor policy: reuse existing by NIP, else create new
      createContractor: !reuseContractor,
      payerContractorId: reuseContractor ? existing[0].id : undefined,
    };

    let result = await createOrderFromInput(input);

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
        result = await createOrderFromInput(input);
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

// Resolve a Google Maps short link (maps.app.goo.gl / goo.gl/maps / g.co) into
// coordinates by following the redirect server-side (browsers can't — CORS).
// Host-allowlisted to Google domains to avoid SSRF. No auth (public form).
app.get("/resolve-location", async (c) => {
  const url = c.req.query("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Podaj prawidłowy link" },
      400
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Podaj prawidłowy link" },
      400
    );
  }

  const allowedHost =
    /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/.test(hostname) ||
    hostname === "maps.app.goo.gl";
  if (!allowedHost) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Obsługiwane są tylko linki Google Maps" },
      400
    );
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        // A real UA — goo.gl serves a bare redirect stub to bots otherwise.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "pl,en;q=0.9",
      },
    });

    let coords = extractCoords(res.url);
    if (!coords) {
      const body = await res.text();
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
