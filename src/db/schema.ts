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

// CMA reports table - raporty z przeglądu kamer (DMSI/Safestar)
export const cmaReports = sqliteTable("cma_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  title: text("title").notNull(),
  dateFrom: text("date_from"),
  dateTo: text("date_to"),
  entryCount: integer("entry_count").default(0).notNull(),
  importedAt: text("imported_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// CMA report entries table - wpisy raportu (wideo-obchody)
export const cmaReportEntries = sqliteTable("cma_report_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: integer("report_id")
    .notNull()
    .references(() => cmaReports.id, { onDelete: "cascade" }),
  objectCategory: text("object_category"),
  objectName: text("object_name").notNull(),
  address: text("address"),
  identifier1: text("identifier1"),
  identifier2: text("identifier2"),
  identifier3: text("identifier3"),
  generatedAt: text("generated_at"),
  patrolName: text("patrol_name"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  endType: text("end_type"),
  description: text("description"),
  videoDevice: text("video_device"),
  videoChannel: text("video_channel"),
  userName: text("user_name"),
});

// CMA mail settings table - konfiguracja skrzynki pocztowej (IMAP/SMTP)
// Single-row table (id = 1), created lazily on first read/write
export const cmaMailSettings = sqliteTable("cma_mail_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  imapHost: text("imap_host").default("imap.zenbox.pl").notNull(),
  imapPort: integer("imap_port").default(993).notNull(),
  imapSecure: integer("imap_secure", { mode: "boolean" })
    .default(true)
    .notNull(),
  smtpHost: text("smtp_host").default("smtp.zenbox.pl").notNull(),
  smtpPort: integer("smtp_port").default(465).notNull(),
  smtpSecure: integer("smtp_secure", { mode: "boolean" })
    .default(true)
    .notNull(),
  email: text("email"),
  password: text("password"),
  folder: text("folder").default("INBOX").notNull(),
  subjectFilter: text("subject_filter"),
  // Filtr nadawcy: dopasowanie "zawiera" (case-insensitive) do adresu/nazwy nadawcy
  fromFilter: text("from_filter"),
  pollMinutes: integer("poll_minutes").default(15).notNull(),
  importEnabled: integer("import_enabled", { mode: "boolean" })
    .default(false)
    .notNull(),
  sendEnabled: integer("send_enabled", { mode: "boolean" })
    .default(false)
    .notNull(),
  recipients: text("recipients"),
  // Deprecated: zastąpione przez sendMode (kolumna zostaje w DB)
  autoSendAfterImport: integer("auto_send_after_import", { mode: "boolean" })
    .default(true)
    .notNull(),
  // Tryb wysyłki: zaraz po imporcie lub o wyznaczonych godzinach
  sendMode: text("send_mode", { enum: ["after_import", "scheduled"] })
    .default("after_import")
    .notNull(),
  // Lista godzin "HH:MM" po przecinku, np. "07:30, 15:00"
  sendTimes: text("send_times"),
  // Guard przed duplikatami wysyłki planowej: "YYYY-MM-DD HH:MM"
  lastScheduledSendKey: text("last_scheduled_send_key"),
  lastCheckAt: text("last_check_at"),
  lastCheckStatus: text("last_check_status"),
  lastCheckError: text("last_check_error"),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// CMA mail log table - dziennik operacji pocztowych (import/wysyłka)
export const cmaMailLog = sqliteTable("cma_mail_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  direction: text("direction", { enum: ["import", "send"] }).notNull(),
  messageUid: integer("message_uid"),
  subject: text("subject"),
  fileName: text("file_name"),
  reportId: integer("report_id").references(() => cmaReports.id, {
    onDelete: "set null",
  }),
  status: text("status", { enum: ["ok", "skipped", "error"] }).notNull(),
  detail: text("detail"),
  createdAt: text("created_at")
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

export type CmaReport = typeof cmaReports.$inferSelect;
export type NewCmaReport = typeof cmaReports.$inferInsert;

export type CmaReportEntry = typeof cmaReportEntries.$inferSelect;
export type NewCmaReportEntry = typeof cmaReportEntries.$inferInsert;

export type CmaMailSettings = typeof cmaMailSettings.$inferSelect;
export type NewCmaMailSettings = typeof cmaMailSettings.$inferInsert;

export type CmaMailLogEntry = typeof cmaMailLog.$inferSelect;
export type NewCmaMailLogEntry = typeof cmaMailLog.$inferInsert;

// --- AUTH (multi-user) ---

// Konta użytkowników — otwarta rejestracja, hasła hashowane scryptem ("salt:hash" hex).
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").default("").notNull(),
  role: text("role").default("user").notNull(), // 'user' | 'admin'
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Sesje logowania — opaque token w httpOnly cookie, wygasają po ~30 dniach.
// expiresAt: integer — epoch w milisekundach (Date.now()).
export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(), // losowy 32-bajtowy token (hex)
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
