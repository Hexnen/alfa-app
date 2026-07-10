import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { OrderInput } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import Database from "better-sqlite3";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

// Generate order number (format: ZL-YYYY-XXXXX)
export function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ZL-${year}-${random}`;
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
  body: OrderInput
): Promise<CreateOrderResult> {
  // Validate NIP format
  const normalizedNip = normalizeNIP(body.payerNip);
  if (!validateNIP(normalizedNip)) {
    return { ok: false, status: 400, error: "Invalid NIP format or checksum" };
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

  // Validate object type and installation type if creating new object
  if (body.createObject && (!body.objectType || !body.objectInstallationType)) {
    return {
      ok: false,
      status: 400,
      error:
        "Object type and installation type are required when creating a new object",
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
        "SELECT id FROM contractors WHERE id = ? LIMIT 1"
      );
      const contractor = checkContractorStmt.get(body.payerContractorId);

      if (!contractor) {
        sqlite.exec("ROLLBACK");
        return {
          ok: false,
          status: 400,
          error: "Selected contractor not found",
        };
      }

      contractorId = body.payerContractorId;
    }

    // Step 2: Handle object (create new or use existing)
    if (body.createObject) {
      // Create new object
      const insertObjectStmt = sqlite.prepare(`
        INSERT INTO objects (contractor_id, name, address, city, type, installation_type, status, department, monthly_value, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      const objectInsert = insertObjectStmt.run(
        contractorId,
        body.objectName,
        body.objectAddress || null,
        body.objectCity || null,
        body.objectType,
        body.objectInstallationType,
        "pending",
        "technical",
        body.monthlyAmount || null,
        body.notes || null
      );

      objectId = Number(objectInsert.lastInsertRowid);
      createdObject = true;

      // Add history entry for the new object
      const objectData = JSON.stringify({
        id: objectId,
        contractorId,
        name: body.objectName,
        type: body.objectType,
        status: "pending",
        department: "technical",
      });

      const insertHistoryStmt = sqlite.prepare(`
        INSERT INTO object_history (object_id, action, description, new_value, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);

      insertHistoryStmt.run(
        objectId,
        "created",
        "Utworzono z zlecenia montażu",
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
    const orderNumber = generateOrderNumber();

    const insertOrderStmt = sqlite.prepare(`
      INSERT INTO orders (
        order_number, requester_name, requester_phone, requester_email,
        payer_name, payer_nip, payer_contractor_id,
        object_name, object_address, object_city, object_location_url, object_id,
        contact_person, contact_phone, contact_email,
        is_camera_installation, camera_count, megaphone_count, vtools_offer_number,
        monthly_amount, rental_amount, invoice_issuer,
        status, service_start_date, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const orderInsert = insertOrderStmt.run(
      orderNumber,
      body.requesterName,
      body.requesterPhone,
      body.requesterEmail,
      body.payerName,
      normalizedNip,
      contractorId,
      body.objectName,
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
      body.monthlyAmount || null,
      body.rentalAmount || null,
      body.invoiceIssuer || null,
      body.status || "new",
      body.serviceStartDate || null,
      body.notes || null
    );

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
