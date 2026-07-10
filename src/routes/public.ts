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
  isCameraInstallation?: boolean;
  vtoolsOfferNumber?: string;
  monthlyAmount?: number;
  rentalAmount?: number;
  invoiceIssuer?: string;
  cameraCount?: number;
  megaphoneCount?: number;
  objectName: string;
  objectAddress?: string;
  objectCity?: string;
  objectLocationUrl?: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail?: string;
  serviceStartDate?: string;
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
      objectName: body.objectName,
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
      monthlyAmount: body.monthlyAmount,
      rentalAmount: body.rentalAmount,
      invoiceIssuer: body.invoiceIssuer,
      serviceStartDate: body.serviceStartDate,
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

    const result = await createOrderFromInput(input);

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

export default app;
