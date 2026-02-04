import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Contractors table
export const contractors = sqliteTable("contractors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  nip: text("nip").notNull().unique(),
  address: text("address"),
  city: text("city"),
  postalCode: text("postal_code"),
  phone: text("phone"),
  email: text("email"),
  contactPerson: text("contact_person"),
  notes: text("notes"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Objects table
export const objects = sqliteTable("objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contractorId: integer("contractor_id")
    .notNull()
    .references(() => contractors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  type: text("type", {
    enum: ["monitoring", "physical", "alarm", "mixed"],
  }).notNull(),
  installationType: text("installation_type", {
    enum: ["new", "takeover"],
  }).notNull(),
  status: text("status", {
    enum: ["pending", "in_progress", "active", "inactive"],
  })
    .default("pending")
    .notNull(),
  department: text("department", {
    enum: ["sales", "technical", "accounting"],
  })
    .default("sales")
    .notNull(),
  monthlyValue: real("monthly_value"),
  notes: text("notes"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Contracts table
export const contracts = sqliteTable("contracts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  objectId: integer("object_id")
    .notNull()
    .references(() => objects.id, { onDelete: "cascade" }),
  contractNumber: text("contract_number").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  value: real("value"),
  filePath: text("file_path"),
  status: text("status", {
    enum: ["draft", "active", "expired", "terminated"],
  })
    .default("draft")
    .notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Object history table
export const objectHistory = sqliteTable("object_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  objectId: integer("object_id")
    .notNull()
    .references(() => objects.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  description: text("description"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: text("changed_by"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Orders table - zlecenia montażu
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderNumber: text("order_number").notNull().unique(),
  
  // Osoba zlecająca
  requesterName: text("requester_name").notNull(),
  requesterPhone: text("requester_phone").notNull(),
  requesterEmail: text("requester_email").notNull(),
  
  // Dane płatnika
  payerName: text("payer_name").notNull(),
  payerNip: text("payer_nip").notNull(),
  payerContractorId: integer("payer_contractor_id").references(() => contractors.id),
  
  // Dane obiektu
  objectName: text("object_name").notNull(),
  objectAddress: text("object_address"),
  objectCity: text("object_city"),
  objectLocationUrl: text("object_location_url"),
  objectId: integer("object_id").references(() => objects.id),
  
  // Osoba kontaktowa na miejscu
  contactPerson: text("contact_person").notNull(),
  contactPhone: text("contact_phone").notNull(),
  contactEmail: text("contact_email"),
  
  // Szczegóły techniczne
  isCameraInstallation: integer("is_camera_installation", { mode: "boolean" }).default(false),
  cameraCount: integer("camera_count"),
  megaphoneCount: integer("megaphone_count"),
  vtoolsOfferNumber: text("vtools_offer_number"),
  
  // Dane finansowe
  monthlyAmount: real("monthly_amount"),
  rentalAmount: real("rental_amount"),
  invoiceIssuer: text("invoice_issuer"),
  
  // Status i daty
  status: text("status", {
    enum: ["new", "in_progress", "completed", "cancelled"],
  })
    .default("new")
    .notNull(),
  serviceStartDate: text("service_start_date"),
  
  // Uwagi
  notes: text("notes"),
  
  // Timestampy
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Type exports
export type Contractor = typeof contractors.$inferSelect;
export type NewContractor = typeof contractors.$inferInsert;

export type ObjectRecord = typeof objects.$inferSelect;
export type NewObject = typeof objects.$inferInsert;

export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;

export type ObjectHistoryRecord = typeof objectHistory.$inferSelect;
export type NewObjectHistory = typeof objectHistory.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
