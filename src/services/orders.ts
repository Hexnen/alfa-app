import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { OrderInput, OrderStatus } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import { legacyObjectType } from "../lib/object-services.js";
import {
  asRecord,
  compact,
  parseBool,
  parseDate,
  parseEmail,
  parseEnum,
  parseFk,
  parseHttpUrl,
  parseId,
  parseNumber,
  parsePhone,
  parseString,
  rejectReadonlyFields,
  requireString,
  STR,
  ValidationError,
} from "../lib/validate.js";
import Database from "better-sqlite3";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

// Generate order number (format: ZL-YYYY-XXXXX)
export function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ZL-${year}-${random}`;
}

export const ORDER_STATUSES = ["new", "in_progress", "completed", "cancelled"] as const;
const OBJECT_TYPES = ["monitoring", "physical", "alarm", "mixed"] as const;
const INSTALLATION_TYPES = ["new", "takeover"] as const;

/**
 * Pola zlecenia, które klient może ustawić — zarówno przy tworzeniu, jak i w PUT.
 * Każde przechodzi przez walidator typu i długości; wszystko poza tą listą jest
 * IGNOROWANE (formularz publiczny próbował `status`, `objectId`, `payerContractorId`).
 *
 * `undefined` = pola nie było w body (PUT: bez zmian). Rzuca `ValidationError`.
 */
export function parseOrderFields(raw: unknown) {
  const b = asRecord(raw);
  return {
    requesterName: parseString(b.requesterName, { label: "Osoba zlecająca", max: STR.NAME }),
    requesterPhone: parsePhone(b.requesterPhone, "Telefon zlecającego"),
    requesterEmail: parseEmail(b.requesterEmail, "E-mail zlecającego"),
    payerName: parseString(b.payerName, { label: "Nazwa płatnika", max: STR.NAME }),
    payerNip: parseString(b.payerNip, { label: "NIP płatnika", max: 20 }),
    payerInvoiceEmail: parseEmail(b.payerInvoiceEmail, "E-mail do faktur"),
    objectName: parseString(b.objectName, { label: "Nazwa obiektu", max: STR.NAME }),
    objectKind: parseString(b.objectKind, { label: "Rodzaj obiektu", max: STR.SHORT }),
    objectAddress: parseString(b.objectAddress, { label: "Adres obiektu", max: STR.ADDRESS }),
    objectCity: parseString(b.objectCity, { label: "Miejscowość obiektu", max: STR.SHORT }),
    objectLocationUrl: parseHttpUrl(b.objectLocationUrl, "Link do lokalizacji"),
    contactPerson: parseString(b.contactPerson, { label: "Osoba kontaktowa", max: STR.NAME }),
    contactPhone: parsePhone(b.contactPhone, "Telefon kontaktowy"),
    contactEmail: parseEmail(b.contactEmail, "E-mail kontaktowy"),
    isCameraInstallation: parseBool(b.isCameraInstallation, "Montaż kamer"),
    cameraCount: parseNumber(b.cameraCount, { label: "Liczba kamer", integer: true, max: 10_000 }),
    megaphoneCount: parseNumber(b.megaphoneCount, { label: "Liczba megafonów", integer: true, max: 10_000 }),
    vtoolsOfferNumber: parseString(b.vtoolsOfferNumber, { label: "Numer oferty vTools", max: STR.SHORT }),
    internetIncluded: parseBool(b.internetIncluded, "Internet w cenie"),
    interventionGroup: parseBool(b.interventionGroup, "Grupa interwencyjna"),
    videoReception: parseBool(b.videoReception, "Wideorecepcja"),
    monthlyAmount: parseNumber(b.monthlyAmount, { label: "Abonament miesięczny", max: 10_000_000 }),
    contractLengthMonths: parseNumber(b.contractLengthMonths, { label: "Długość umowy (mies.)", integer: true, max: 1200 }),
    rentalAmount: parseNumber(b.rentalAmount, { label: "Dzierżawa", max: 10_000_000 }),
    rentalLengthMonths: parseNumber(b.rentalLengthMonths, { label: "Długość dzierżawy (mies.)", integer: true, max: 1200 }),
    invoiceIssuer: parseString(b.invoiceIssuer, { label: "Wystawca faktury", max: STR.NAME }),
    status: parseEnum(b.status, ORDER_STATUSES, "Status"),
    serviceStartDate: parseDate(b.serviceStartDate, "Data rozpoczęcia usługi"),
    installationStartDate: parseDate(b.installationStartDate, "Data rozpoczęcia montażu"),
    notes: parseString(b.notes, { label: "Uwagi", max: STR.NOTES, keepWhitespace: true }),
  };
}

/**
 * Pełne wejście `POST /orders` (także publiczny ZDW, który podaje już wymuszone
 * flagi polityki). Pola wymagane (NOT NULL w tabeli) muszą być niepuste; flagi
 * tworzenia kontrahenta/obiektu i ich dodatkowe dane przechodzą przez te same
 * walidatory. Rzuca `ValidationError`.
 */
export function parseOrderInput(raw: unknown): OrderInput {
  const b = asRecord(raw);
  const f = parseOrderFields(b);
  const createContractor = parseBool(b.createContractor, "createContractor") ?? false;
  const createObject = parseBool(b.createObject, "createObject") ?? false;

  // Kontrahent istniejący: NIP i nazwa płatnika przepisują się z kartoteki
  // (createOrderFromInput), więc tu wymagamy ich tylko przy zakładaniu nowego.
  const payerContractorId = parseId(b.payerContractorId, "Kontrahent") ?? undefined;
  const fromCatalog = !createContractor && payerContractorId !== undefined;
  const payerNip = fromCatalog ? f.payerNip ?? "" : requireString(f.payerNip, "NIP płatnika", 20);
  const payerName = fromCatalog ? f.payerName ?? "" : requireString(f.payerName, "Nazwa płatnika");

  return {
    requesterName: requireString(f.requesterName, "Osoba zlecająca"),
    requesterPhone: requireString(f.requesterPhone, "Telefon zlecającego", STR.PHONE),
    requesterEmail: requireString(f.requesterEmail, "E-mail zlecającego", STR.EMAIL),
    payerName,
    payerNip,
    payerInvoiceEmail: f.payerInvoiceEmail ?? undefined,
    payerContractorId,
    objectName: requireString(f.objectName, "Nazwa obiektu"),
    objectKind: f.objectKind ?? undefined,
    objectAddress: f.objectAddress ?? undefined,
    objectCity: f.objectCity ?? undefined,
    objectLocationUrl: f.objectLocationUrl ?? undefined,
    objectId: parseId(b.objectId, "Obiekt") ?? undefined,
    contactPerson: requireString(f.contactPerson, "Osoba kontaktowa"),
    contactPhone: requireString(f.contactPhone, "Telefon kontaktowy", STR.PHONE),
    contactEmail: f.contactEmail ?? undefined,
    isCameraInstallation: f.isCameraInstallation,
    cameraCount: f.cameraCount ?? undefined,
    megaphoneCount: f.megaphoneCount ?? undefined,
    vtoolsOfferNumber: f.vtoolsOfferNumber ?? undefined,
    internetIncluded: f.internetIncluded,
    interventionGroup: f.interventionGroup,
    videoReception: f.videoReception,
    monthlyAmount: f.monthlyAmount ?? undefined,
    contractLengthMonths: f.contractLengthMonths ?? undefined,
    rentalAmount: f.rentalAmount ?? undefined,
    rentalLengthMonths: f.rentalLengthMonths ?? undefined,
    invoiceIssuer: f.invoiceIssuer ?? undefined,
    status: f.status,
    serviceStartDate: f.serviceStartDate ?? undefined,
    installationStartDate: f.installationStartDate ?? undefined,
    notes: f.notes ?? undefined,
    createContractor,
    createObject,
    contractorAddress: parseString(b.contractorAddress, { label: "Adres kontrahenta", max: STR.ADDRESS }) ?? undefined,
    contractorCity: parseString(b.contractorCity, { label: "Miejscowość kontrahenta", max: STR.SHORT }) ?? undefined,
    contractorPostalCode: parseString(b.contractorPostalCode, { label: "Kod pocztowy", max: 12 }) ?? undefined,
    contractorPhone: parsePhone(b.contractorPhone, "Telefon kontrahenta") ?? undefined,
    contractorEmail: parseEmail(b.contractorEmail, "E-mail kontrahenta") ?? undefined,
    contractorContactPerson: parseString(b.contractorContactPerson, { label: "Osoba kontaktowa kontrahenta", max: STR.NAME }) ?? undefined,
    objectType: parseEnum(b.objectType, OBJECT_TYPES, "Typ obiektu"),
    objectHasCameras: parseBool(b.objectHasCameras, "Kamery"),
    objectCameraCount: parseNumber(b.objectCameraCount, { label: "Liczba kamer obiektu", integer: true, max: 10_000 }),
    objectHasSswin: parseBool(b.objectHasSswin, "SSWiN"),
    objectHasVideoreception: parseBool(b.objectHasVideoreception, "Wideorecepcja obiektu"),
    objectHasOfi: parseBool(b.objectHasOfi, "OFI"),
    objectInstallationType: parseEnum(b.objectInstallationType, INSTALLATION_TYPES, "Typ instalacji"),
  };
}

/**
 * Łatka `PUT /orders/:id`: jawna lista pól (bez `id`, `orderNumber`, `createdAt`,
 * flag tworzenia). Klucze obce muszą istnieć. Puste body → 400.
 */
export function parseOrderPatch(raw: unknown) {
  const b = asRecord(raw);
  rejectReadonlyFields(b, ["orderNumber"]);
  const f = parseOrderFields(b);
  // Pola NOT NULL nie mogą zostać wyczyszczone jawnym `null`.
  for (const [key, label] of [
    ["requesterName", "Osoba zlecająca"],
    ["requesterPhone", "Telefon zlecającego"],
    ["requesterEmail", "E-mail zlecającego"],
    ["payerName", "Nazwa płatnika"],
    ["payerNip", "NIP płatnika"],
    ["objectName", "Nazwa obiektu"],
    ["contactPerson", "Osoba kontaktowa"],
    ["contactPhone", "Telefon kontaktowy"],
  ] as const) {
    if (f[key] === null) throw new ValidationError(`Pole „${label}” nie może być puste`);
  }
  if (f.payerNip) {
    const nip = normalizeNIP(f.payerNip);
    if (!validateNIP(nip)) throw new ValidationError("Nieprawidłowy NIP (błędna suma kontrolna)");
    f.payerNip = nip;
  }
  const patch = compact({
    ...f,
    payerContractorId: parseFk(b.payerContractorId, "contractors", "Kontrahent"),
    objectId: parseFk(b.objectId, "objects", "Obiekt"),
  });
  if (Object.keys(patch).length === 0) throw new ValidationError("Brak pól do zmiany");
  return patch;
}

/** Status z `PATCH /orders/:id/status` — tylko wartości ze słownika. */
export function parseOrderStatus(raw: unknown): OrderStatus {
  return parseEnum(raw, ORDER_STATUSES, "Status", { required: true }) as OrderStatus;
}

type CreatedOrder = Awaited<ReturnType<typeof fetchOrder>>;

async function fetchOrder(orderId: number) {
  const createdOrder = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  return createdOrder[0];
}

export type CreateOrderResult =
  | {
      ok: true;
      order: CreatedOrder;
      orderNumber: string;
      createdContractor: boolean;
      createdObject: boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * Core order-creation logic shared by the authenticated CRM route and the
 * public order-intake endpoint. Performs the same atomic transaction:
 *   1. create or reuse a contractor (by NIP),
 *   2. create or reuse an object (+ object_history row when created),
 *   3. insert the order with a generated ZL-YYYY-XXXXX number.
 *
 * Returns a discriminated result so callers can translate it into their own
 * response shape without leaking transaction details.
 */
export async function createOrderFromInput(
  body: OrderInput,
  options: { source?: "internal" | "public" } = {}
): Promise<CreateOrderResult> {
  const source = options.source ?? "internal";

  // NIP z body sprawdzamy tylko wtedy, gdy ma zostać zapisany: przy wskazanym
  // kontrahencie NIP i nazwa płatnika przepisują się z kartoteki (niżej), więc
  // klient nie może złożyć zlecenia „na kontrahenta A z NIP-em firmy B".
  let normalizedNip = normalizeNIP(body.payerNip ?? "");
  if ((body.createContractor || !body.payerContractorId) && !validateNIP(normalizedNip)) {
    return { ok: false, status: 400, error: "Nieprawidłowy NIP (błędna suma kontrolna)" };
  }

  // Validate that we have either contractorId or createContractor flag
  if (!body.payerContractorId && !body.createContractor) {
    return {
      ok: false,
      status: 400,
      error: "Either select an existing contractor or create a new one",
    };
  }

  // Validate that we have either objectId or createObject flag
  if (!body.objectId && !body.createObject) {
    return {
      ok: false,
      status: 400,
      error: "Either select an existing object or create a new one",
    };
  }

  // Typ instalacji jest wymagany przy zakładaniu obiektu. Usług NIE wymagamy:
  // zlecenie bywa składane, zanim ktokolwiek wie, co finalnie na obiekcie stanie,
  // a pusty zestaw usług jest widoczną luką w kartotece (lepszą niż zgadnięta usługa).
  if (body.createObject && !body.objectInstallationType) {
    return {
      ok: false,
      status: 400,
      error: "Installation type is required when creating a new object",
    };
  }

  // Use SQLite transaction for atomicity
  // better-sqlite3 uses synchronous API
  let contractorId: number;
  let objectId: number;
  let createdContractor = false;
  let createdObject = false;
  let orderId: number;

  // Begin transaction
  sqlite.exec("BEGIN TRANSACTION");

  try {
    // Step 1: Handle contractor (create new or use existing)
    if (body.createContractor) {
      // Check if NIP already exists (inside transaction for consistency)
      const checkNipStmt = sqlite.prepare(
        "SELECT id FROM contractors WHERE nip = ? LIMIT 1"
      );
      const existingContractor = checkNipStmt.get(normalizedNip);

      if (existingContractor) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 409,
          error:
            "Contractor with this NIP already exists. Use the existing contractor instead.",
        };
      }

      // Create new contractor using raw SQL for transaction support
      const insertContractorStmt = sqlite.prepare(`
        INSERT INTO contractors (name, nip, address, city, postal_code, phone, email, contact_person, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      const contractorInsert = insertContractorStmt.run(
        body.payerName,
        normalizedNip,
        body.contractorAddress || null,
        body.contractorCity || null,
        body.contractorPostalCode || null,
        body.contractorPhone || null,
        body.contractorEmail || null,
        body.contractorContactPerson || null
      );

      contractorId = Number(contractorInsert.lastInsertRowid);
      createdContractor = true;
    } else {
      // Use existing contractor
      if (!body.payerContractorId) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 400,
          error: "Contractor ID is required when not creating a new contractor",
        };
      }

      // Verify contractor exists
      const checkContractorStmt = sqlite.prepare(
        "SELECT id, nip, name FROM contractors WHERE id = ? LIMIT 1"
      );
      const contractor = checkContractorStmt.get(body.payerContractorId) as
        | { id: number; nip: string; name: string }
        | undefined;

      if (!contractor) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 400,
          error: "Selected contractor not found",
        };
      }

      contractorId = body.payerContractorId;
      // Migawka płatnika na zleceniu = dane WYBRANEGO kontrahenta, nie to, co
      // przyszło w body — inaczej zlecenie nosiło NIP innej firmy niż jego FK.
      normalizedNip = contractor.nip;
      if (!body.payerName) body.payerName = contractor.name;
    }

    // Step 2: Handle object (create new or use existing)
    if (body.createObject) {
      // Create new object
      // Usługi obiektu przepisujemy ze zlecenia. Kolumna `type` jest @deprecated
      // i wciąż NOT NULL, więc wyliczamy ją z tych samych usług (jawny objectType
      // ze starszych klientów API ma pierwszeństwo).
      const objectServices = {
        hasCameras: body.objectHasCameras ?? false,
        hasSswin: body.objectHasSswin ?? false,
        hasVideoreception: body.objectHasVideoreception ?? false,
        hasOfi: body.objectHasOfi ?? false,
      };
      // `?? null`, nie `|| null`: 0 kamer to wpis, null = „nikt nie policzył”.
      const objectCameraCount = objectServices.hasCameras
        ? body.objectCameraCount ?? null
        : null;

      const insertObjectStmt = sqlite.prepare(`
        INSERT INTO objects (contractor_id, name, address, city, type, has_cameras, camera_count, has_sswin, has_videoreception, has_ofi, installation_type, status, department, monthly_value, monthly_rental, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      const objectInsert = insertObjectStmt.run(
        contractorId,
        body.objectName,
        body.objectAddress || null,
        body.objectCity || null,
        body.objectType ?? legacyObjectType(objectServices),
        objectServices.hasCameras ? 1 : 0,
        objectCameraCount,
        objectServices.hasSswin ? 1 : 0,
        objectServices.hasVideoreception ? 1 : 0,
        objectServices.hasOfi ? 1 : 0,
        body.objectInstallationType,
        "pending",
        "technical",
        body.monthlyAmount || null,
        // Dzierżawa to druga część miesięcznego przychodu obiektu. Bez tej
        // linii kwota ze zlecenia zostawała wyłącznie na zleceniu, a Analityka
        // pokazywała zaniżony przychód obiektów ze sprzętem w najmie.
        body.rentalAmount || null,
        body.notes || null
      );

      objectId = Number(objectInsert.lastInsertRowid);
      createdObject = true;

      // Add history entry for the new object
      const objectData = JSON.stringify({
        id: objectId,
        contractorId,
        name: body.objectName,
        ...objectServices,
        cameraCount: objectCameraCount,
        status: "pending",
        department: "technical",
      });

      const insertHistoryStmt = sqlite.prepare(`
        INSERT INTO object_history (object_id, action, description, new_value, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);

      // Opis zdradza pochodzenie: obiekt z anonimowego formularza ZDW czeka na
      // weryfikację (status `pending`, dział techniczny) i handlowiec ma to widzieć.
      insertHistoryStmt.run(
        objectId,
        "created",
        source === "public"
          ? "Utworzono z publicznego formularza ZDW (do weryfikacji)"
          : "Utworzono z zlecenia montażu",
        objectData
      );
    } else {
      // Use existing object
      if (!body.objectId) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 400,
          error: "Object ID is required when not creating a new object",
        };
      }

      // Verify object exists
      const checkObjectStmt = sqlite.prepare(
        "SELECT id FROM objects WHERE id = ? LIMIT 1"
      );
      const object = checkObjectStmt.get(body.objectId);

      if (!object) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 400,
          error: "Selected object not found",
        };
      }

      objectId = body.objectId;
    }

    // Step 3: Create the order
    const insertOrderStmt = sqlite.prepare(`
      INSERT INTO orders (
        order_number, requester_name, requester_phone, requester_email,
        payer_name, payer_nip, payer_invoice_email, payer_contractor_id,
        object_name, object_kind, object_address, object_city, object_location_url, object_id,
        contact_person, contact_phone, contact_email,
        is_camera_installation, camera_count, megaphone_count, vtools_offer_number,
        internet_included, intervention_group, video_reception,
        monthly_amount, contract_length_months, rental_amount, rental_length_months, invoice_issuer,
        status, service_start_date, installation_start_date, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    // generateOrderNumber() draws a random suffix, so two concurrent creates in
    // the same year can collide on the orders.order_number UNIQUE constraint.
    // Regenerate and retry a bounded number of times before giving up, so a
    // birthday-paradox collision no longer surfaces as a 500 / rolled-back order.
    let orderInsert: Database.RunResult | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const orderNumber = generateOrderNumber();
      try {
        orderInsert = insertOrderStmt.run(
          orderNumber,
          body.requesterName,
          body.requesterPhone,
          body.requesterEmail,
          body.payerName,
          normalizedNip,
          body.payerInvoiceEmail || null,
          contractorId,
          body.objectName,
          body.objectKind ?? null,
          body.objectAddress || null,
          body.objectCity || null,
          body.objectLocationUrl || null,
          objectId,
          body.contactPerson,
          body.contactPhone,
          body.contactEmail || null,
          body.isCameraInstallation ? 1 : 0,
          body.cameraCount || null,
          body.megaphoneCount || null,
          body.vtoolsOfferNumber || null,
          body.internetIncluded ? 1 : 0,
          body.interventionGroup ? 1 : 0,
          body.videoReception ? 1 : 0,
          body.monthlyAmount || null,
          body.contractLengthMonths || null,
          body.rentalAmount || null,
          body.rentalLengthMonths || null,
          body.invoiceIssuer || null,
          body.status || "new",
          body.serviceStartDate || null,
          body.installationStartDate || null,
          body.notes || null
        );
        break;
      } catch (err) {
        // A constraint violation aborts only this statement, not the
        // surrounding transaction, so retrying with a fresh number is safe.
        const code = (err as { code?: string }).code;
        if (attempt < 9 && code === "SQLITE_CONSTRAINT_UNIQUE") {
          continue;
        }
        throw err;
      }
    }

    if (!orderInsert) {
      throw new Error("Could not generate a unique order number");
    }

    orderId = Number(orderInsert.lastInsertRowid);

    // Commit transaction
    sqlite.exec("COMMIT");
  } catch (error) {
    // Rollback on any error
    sqlite.exec("ROLLBACK");
    throw error;
  }

  // Fetch the created order using Drizzle for consistency (outside transaction)
  const order = await fetchOrder(orderId);

  return {
    ok: true,
    order,
    orderNumber: order.orderNumber,
    createdContractor,
    createdObject,
  };
}
