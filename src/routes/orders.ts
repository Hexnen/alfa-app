import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, like, or, sql, desc } from "drizzle-orm";
import type { OrderInput, ApiResponse } from "../types/index.js";
import { normalizeNIP, validateNIP } from "../utils/nip.js";
import Database from "better-sqlite3";

// Get raw SQLite instance for transactions
const sqlite = (db as any).$client as Database.Database;

const app = new Hono();

// Generate order number (format: ZL-YYYY-XXXXX)
function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `ZL-${year}-${random}`;
}

// Get all orders with optional search (with joined contractor and object data)
app.get("/", async (c) => {
  const search = c.req.query("search");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("pageSize") || "20");
  const offset = (page - 1) * pageSize;

  let query = db
    .select({
      order: schema.orders,
      contractor: schema.contractors,
      object: schema.objects,
    })
    .from(schema.orders)
    .leftJoin(schema.contractors, eq(schema.orders.payerContractorId, schema.contractors.id))
    .leftJoin(schema.objects, eq(schema.orders.objectId, schema.objects.id));

  if (search) {
    query = query.where(
      or(
        like(schema.orders.orderNumber, `%${search}%`),
        like(schema.orders.requesterName, `%${search}%`),
        like(schema.orders.payerName, `%${search}%`),
        like(schema.orders.objectName, `%${search}%`)
      )
    ) as typeof query;
  }

  if (status) {
    query = query.where(eq(schema.orders.status, status as "new" | "in_progress" | "completed" | "cancelled")) as typeof query;
  }

  const results = await query.orderBy(desc(schema.orders.createdAt)).limit(pageSize).offset(offset);

  let countQuery = db.select({ count: sql<number>`count(*)` }).from(schema.orders);
  if (search) {
    countQuery = countQuery.where(
      or(
        like(schema.orders.orderNumber, `%${search}%`),
        like(schema.orders.requesterName, `%${search}%`),
        like(schema.orders.payerName, `%${search}%`),
        like(schema.orders.objectName, `%${search}%`)
      )
    ) as typeof countQuery;
  }
  if (status) {
    countQuery = countQuery.where(eq(schema.orders.status, status as "new" | "in_progress" | "completed" | "cancelled")) as typeof countQuery;
  }
  const countResult = await countQuery;
  const total = countResult[0].count;

  // Map results to include current contractor/object names
  const orders = results.map((r) => ({
    ...r.order,
    // Use current contractor data if available, fallback to order snapshot
    payerName: r.contractor?.name || r.order.payerName,
    payerNip: r.contractor?.nip || r.order.payerNip,
    // Use current object data if available, fallback to order snapshot
    objectName: r.object?.name || r.order.objectName,
    objectAddress: r.object?.address || r.order.objectAddress,
    objectCity: r.object?.city || r.order.objectCity,
    // Include full objects for reference
    contractor: r.contractor,
    object: r.object,
  }));

  return c.json({
    success: true,
    data: orders,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
});

// Get order by ID
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  const order = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (order.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  return c.json<ApiResponse<typeof order[0]>>({
    success: true,
    data: order[0],
  });
});

// Create order with optional contractor and object creation (ATOMIC TRANSACTION)
app.post("/", async (c) => {
  const body = await c.req.json<OrderInput>();
  
  // Validate NIP format
  const normalizedNip = normalizeNIP(body.payerNip);
  if (!validateNIP(normalizedNip)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Invalid NIP format or checksum" },
      400
    );
  }
  
  // Validate that we have either contractorId or createContractor flag
  if (!body.payerContractorId && !body.createContractor) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Either select an existing contractor or create a new one" },
      400
    );
  }
  
  // Validate that we have either objectId or createObject flag
  if (!body.objectId && !body.createObject) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Either select an existing object or create a new one" },
      400
    );
  }
  
  // Validate object type and installation type if creating new object
  if (body.createObject && (!body.objectType || !body.objectInstallationType)) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Object type and installation type are required when creating a new object" },
      400
    );
  }

  // Use SQLite transaction for atomicity
  // better-sqlite3 uses synchronous API
  let contractorId: number;
  let objectId: number;
  let createdContractor = false;
  let createdObject = false;
  let orderId: number;

  try {
    // Begin transaction
    sqlite.exec('BEGIN TRANSACTION');
    
    try {
      // Step 1: Handle contractor (create new or use existing)
      if (body.createContractor) {
        // Check if NIP already exists (inside transaction for consistency)
        const checkNipStmt = sqlite.prepare(
          'SELECT id FROM contractors WHERE nip = ? LIMIT 1'
        );
        const existingContractor = checkNipStmt.get(normalizedNip);
        
        if (existingContractor) {
          sqlite.exec('ROLLBACK');
          return c.json<ApiResponse<null>>(
            { 
              success: false, 
              error: "Contractor with this NIP already exists. Use the existing contractor instead."
            },
            409
          );
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
          sqlite.exec('ROLLBACK');
          return c.json<ApiResponse<null>>(
            { success: false, error: "Contractor ID is required when not creating a new contractor" },
            400
          );
        }
        
        // Verify contractor exists
        const checkContractorStmt = sqlite.prepare(
          'SELECT id FROM contractors WHERE id = ? LIMIT 1'
        );
        const contractor = checkContractorStmt.get(body.payerContractorId);
        
        if (!contractor) {
          sqlite.exec('ROLLBACK');
          return c.json<ApiResponse<null>>(
            { success: false, error: "Selected contractor not found" },
            400
          );
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
          'pending',
          'technical',
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
          status: 'pending',
          department: 'technical',
        });
        
        const insertHistoryStmt = sqlite.prepare(`
          INSERT INTO object_history (object_id, action, description, new_value, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `);
        
        insertHistoryStmt.run(
          objectId,
          'created',
          'Utworzono z zlecenia montażu',
          objectData
        );
      } else {
        // Use existing object
        if (!body.objectId) {
          sqlite.exec('ROLLBACK');
          return c.json<ApiResponse<null>>(
            { success: false, error: "Object ID is required when not creating a new object" },
            400
          );
        }
        
        // Verify object exists
        const checkObjectStmt = sqlite.prepare(
          'SELECT id FROM objects WHERE id = ? LIMIT 1'
        );
        const object = checkObjectStmt.get(body.objectId);
        
        if (!object) {
          sqlite.exec('ROLLBACK');
          return c.json<ApiResponse<null>>(
            { success: false, error: "Selected object not found" },
            400
          );
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
        body.status || 'new',
        body.serviceStartDate || null,
        body.notes || null
      );
      
      orderId = Number(orderInsert.lastInsertRowid);
      
      // Commit transaction
      sqlite.exec('COMMIT');
      
    } catch (error) {
      // Rollback on any error
      sqlite.exec('ROLLBACK');
      throw error;
    }
    
    // Fetch the created order using Drizzle for consistency (outside transaction)
    const createdOrder = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    
    const orderResult = createdOrder[0];
    
    return c.json<ApiResponse<typeof orderResult & { createdContractor: boolean; createdObject: boolean }>>(
      {
        success: true,
        data: {
          ...orderResult,
          createdContractor,
          createdObject,
        },
        message: `Order created successfully${createdContractor ? ' (with new contractor)' : ''}${createdObject ? ' (with new object)' : ''}`,
      },
      201
    );
    
  } catch (error) {
    console.error("Error creating order:", error);
    return c.json<ApiResponse<null>>(
      { success: false, error: "Failed to create order. Please try again." },
      500
    );
  }
});

// Update order
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Partial<OrderInput>>();

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  const result = await db
    .update(schema.orders)
    .set({
      ...body,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.orders.id, id))
    .returning();

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order updated successfully",
  });
});

// Delete order
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  // Check if order exists
  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  await db.delete(schema.orders).where(eq(schema.orders.id, id));

  return c.json<ApiResponse<null>>({
    success: true,
    message: "Order deleted successfully",
  });
});

// Update order status
app.patch("/:id/status", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { status } = await c.req.json<{ status: string }>();

  const existing = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);

  if (existing.length === 0) {
    return c.json<ApiResponse<null>>(
      { success: false, error: "Order not found" },
      404
    );
  }

  const result = await db
    .update(schema.orders)
    .set({
      status: status as "new" | "in_progress" | "completed" | "cancelled",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.orders.id, id))
    .returning();

  return c.json<ApiResponse<typeof result[0]>>({
    success: true,
    data: result[0],
    message: "Order status updated successfully",
  });
});

export default app;
