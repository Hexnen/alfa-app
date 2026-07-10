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

// Importy dziennego raportu obiektów (CSV z Safestar) — jeden wiersz na plik
export const objectImports = sqliteTable("object_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  totalCount: integer("total_count").default(0).notNull(),
  newCount: integer("new_count").default(0).notNull(),
  changedCount: integer("changed_count").default(0).notNull(),
  removedCount: integer("removed_count").default(0).notNull(),
  restoredCount: integer("restored_count").default(0).notNull(),
  importedAt: text("imported_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Rejestr obiektów monitorowanych — aktualny stan z ostatniego raportu,
// identyfikacja po externalId ("ID Obiektu" z raportu)
export const monitoredObjects = sqliteTable("monitored_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  externalId: integer("external_id").notNull().unique(),
  account: text("account"),
  category: text("category"),
  name: text("name").notNull(),
  identifier1: text("identifier1"),
  identifier2: text("identifier2"),
  identifier3: text("identifier3"),
  extraData1: text("extra_data1"),
  extraData2: text("extra_data2"),
  extraData3: text("extra_data3"),
  extraData4: text("extra_data4"),
  extraData5: text("extra_data5"),
  address: text("address"),
  street: text("street"),
  houseNumber: text("house_number"),
  postalCode: text("postal_code"),
  city: text("city"),
  latitude: text("latitude"),
  longitude: text("longitude"),
  locationDescription: text("location_description"),
  objectDescription: text("object_description"),
  phones: text("phones"),
  devices: text("devices"),
  defaultCrew: text("default_crew"),
  allCrews: text("all_crews"),
  groups: text("groups"),
  monitoringStart: text("monitoring_start"),
  monitoringEnd: text("monitoring_end"),
  objectStatus: text("object_status"),
  addedAt: text("added_at"),
  authorizedPersons: text("authorized_persons"),
  authorizedPhones: text("authorized_phones"),
  authorizedPasswords: text("authorized_passwords"),
  duressPasswords: text("duress_passwords"),
  dayArrivalTime: text("day_arrival_time"),
  nightArrivalTime: text("night_arrival_time"),
  relatedObjects: text("related_objects"),
  serviceTypes: text("service_types"),
  serviceMonitoringFrom: text("service_monitoring_from"),
  serviceMonitoringTo: text("service_monitoring_to"),
  // Obecność w ostatnim imporcie — brak w raporcie oznacza "usunięty"
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  firstImportId: integer("first_import_id").references(() => objectImports.id, {
    onDelete: "set null",
  }),
  lastImportId: integer("last_import_id").references(() => objectImports.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

// Log zmian obiektów monitorowanych — jeden wiersz na zmienione pole
// (changeType "updated") lub na zdarzenie cyklu życia (created/removed/restored)
export const monitoredObjectChanges = sqliteTable("monitored_object_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  objectId: integer("object_id")
    .notNull()
    .references(() => monitoredObjects.id, { onDelete: "cascade" }),
  importId: integer("import_id").references(() => objectImports.id, {
    onDelete: "set null",
  }),
  changeType: text("change_type", {
    enum: ["created", "updated", "removed", "restored"],
  }).notNull(),
  field: text("field"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
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

export type ObjectImport = typeof objectImports.$inferSelect;
export type NewObjectImport = typeof objectImports.$inferInsert;

export type MonitoredObject = typeof monitoredObjects.$inferSelect;
export type NewMonitoredObject = typeof monitoredObjects.$inferInsert;

export type MonitoredObjectChange = typeof monitoredObjectChanges.$inferSelect;
export type NewMonitoredObjectChange = typeof monitoredObjectChanges.$inferInsert;

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

// Realizacje — rejestr serwisów i montaży działu technicznego
// (odwzorowanie miesięcznego arkusza Excel "Realizacje", np. "2026 2 Luty.xlsx").
// Każdy wiersz to dokładnie jeden typ: serwis płatny / serwis gwarancyjny
// (bezpłatny) / montaż. Suma netto = godziny + materiały + km - rabat,
// liczona w API zamiast excelowych formuł.
export const realizations = sqliteTable("realizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  site: text("site").notNull(), // Obiekt
  kind: text("kind", {
    enum: ["service", "warranty", "installation"],
  })
    .default("service")
    .notNull(),
  amountHours: real("amount_hours").default(0).notNull(), // Kwota za godziny
  amountMaterial: real("amount_material").default(0).notNull(), // Kwota za materiały
  amountKm: real("amount_km").default(0).notNull(), // Kwota za KM
  discount: real("discount").default(0).notNull(), // Rabat (kwotowy)
  note: text("note"), // Adnotacja
  invoiced: integer("invoiced", { mode: "boolean" }).default(false).notNull(),
  invoicedAt: text("invoiced_at"), // Data faktury (YYYY-MM-DD)
  caretaker: text("caretaker"), // Opiekun
  contractor1: text("contractor_1"), // Wykonawca 1
  contractor2: text("contractor_2"), // Wykonawca 2
  actualHours: real("actual_hours").default(0).notNull(), // Faktyczne godziny pracownicze
  actualKm: real("actual_km").default(0).notNull(), // Faktyczne KM
  hourlyCost: real("hourly_cost").default(0).notNull(), // Koszt godzinowy
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Realization = typeof realizations.$inferSelect;
export type NewRealization = typeof realizations.$inferInsert;

// Technicy (serwisanci) — słownik wykonawców dla realizacji,
// odwzorowanie kolumny "serwisanci" z arkusza "Dane".
export const technicians = sqliteTable("technicians", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  firstName: text("first_name").default("").notNull(),
  lastName: text("last_name").default("").notNull(),
  phone: text("phone"),
  type: text("type", { enum: ["internal", "external"] })
    .default("internal")
    .notNull(),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Technician = typeof technicians.$inferSelect;
export type NewTechnician = typeof technicians.$inferInsert;

// Cennik usług serwisowych — z załącznika do protokołu powykonawczego
// ("CENNIK USŁUG SERWISOWYCH", wer. 20260127).
export const priceList = sqliteTable("price_list", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // Nazwa usługi
  unit: text("unit").notNull(), // JM: KM / RBH / MB / SZT...
  price: real("price").default(0).notNull(), // cena netto
  position: integer("position").default(0).notNull(), // kolejność (LP)
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type PriceItem = typeof priceList.$inferSelect;
export type NewPriceItem = typeof priceList.$inferInsert;

// Szablony kamer — standardowe modele kamer i ich parametry. Wspólna biblioteka
// używana w panelu głównym (zakładka Szablony) oraz w Monitoring Designerze,
// gdzie parametry geometryczne (typ/FOV/zasięg/wysokość/kolor) pozwalają jednym
// kliknięciem postawić skonfigurowaną kamerę na mapie.
export const cameraModels = sqliteTable("camera_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // Nazwa / model kamery
  manufacturer: text("manufacturer").default("").notNull(), // Producent
  // Typ geometryczny (spójny z designerem): tubowa / kopułkowa / PTZ / 360°
  type: text("camera_type", { enum: ["bullet", "dome", "ptz", "pano"] })
    .default("bullet")
    .notNull(),
  resolution: text("resolution").default("").notNull(), // Rozdzielczość (np. 4MP, 8MP)
  lens: text("lens").default("").notNull(), // Obiektyw (np. 2.8mm, 2.8-12mm)
  irRange: text("ir_range").default("").notNull(), // Zasięg IR (np. 30m)
  power: text("power").default("").notNull(), // Zasilanie (PoE / 12V DC)
  interface: text("interface").default("").notNull(), // Interfejs (IP / HD-TVI / Analog)
  protocol: text("protocol").default("").notNull(), // Protokół (ONVIF...)
  // Parametry geometryczne dla designera (domyślne wartości kamery)
  fov: integer("fov").default(90).notNull(), // Kąt widzenia (°)
  range: integer("range_m").default(20).notNull(), // Zasięg (m)
  height: real("height").default(3).notNull(), // Wys. montażu (m)
  color: text("color").default("#38bdf8").notNull(), // Kolor na mapie
  notes: text("notes").default("").notNull(), // Uwagi
  position: integer("position").default(0).notNull(), // kolejność (LP)
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type CameraModel = typeof cameraModels.$inferSelect;
export type NewCameraModel = typeof cameraModels.$inferInsert;

// Protokoły końcowe (powykonawcze) — tworzone automatycznie 1:1 z realizacji
// wg wzoru "Protokół powykonawczy WZÓR 01.26". Pola klienta i pozycje
// materiałowe są edytowalne; items to JSON [{name, serial, unit, qty}].
export const protocols = sqliteTable("protocols", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  realizationId: integer("realization_id")
    .notNull()
    .unique()
    .references(() => realizations.id, { onDelete: "cascade" }),
  number: text("number").notNull().unique(), // np. P/2026/02/001
  workDate: text("work_date").notNull(), // Data wykonania
  workType: text("work_type", {
    enum: ["serwis", "montaz", "wizja", "inne"],
  })
    .default("serwis")
    .notNull(),
  actualHours: real("actual_hours").default(0).notNull(), // Faktyczne godziny
  actualKm: real("actual_km").default(0).notNull(), // Przejechane km
  contractor: text("contractor"), // Wykonawca
  salesperson: text("salesperson"), // Handlowiec
  clientName: text("client_name"), // Zleceniodawca
  clientNip: text("client_nip"), // NIP
  clientCity: text("client_city"), // Miejscowość
  installationAddress: text("installation_address"), // Adres montażu
  contact: text("contact"), // Kontakt
  activities: text("activities"), // Wykonane czynności / uwagi
  items: text("items").default("[]").notNull(), // JSON: pozycje materiałowe
  // Podpis zleceniodawcy (palcem na ekranie): PNG dataURL + metadane dowodowe
  signaturePng: text("signature_png"),
  signerName: text("signer_name"),
  signedAt: text("signed_at"), // ISO, czas serwera
  contentHash: text("content_hash"), // SHA-256 treści protokołu + podpisu
  status: text("status", { enum: ["draft", "final"] })
    .default("draft")
    .notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Protocol = typeof protocols.$inferSelect;
export type NewProtocol = typeof protocols.$inferInsert;

// Wyceny usług serwisowych — wg wzoru "20260610 wycena" (tabela pozycji
// z cennika + sprzęt; suma = ilość × cena, liczona w API/froncie).
// items to JSON [{name, qty, unit, price}].
export const quotes = sqliteTable("quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(), // np. W/2026/07/001
  date: text("date").notNull(), // YYYY-MM-DD
  site: text("site").default("").notNull(), // Obiekt
  address: text("address").default("").notNull(), // Adres
  items: text("items").default("[]").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;

// Projekty monitoringu (CCTV) — projektowanie kamer na mapie satelitarnej
// (moduł "Monitoring", designer w frontend/public/monitoring/designer.html).
// data to pełny stan projektu z designera (JSON: center, zoom, cameras,
// points, cables, zones, info...) — zapisywany w całości przy autozapisie.
export const monitoringProjects = sqliteTable("monitoring_projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // np. "Aluzyjna 25, Warszawa"
  address: text("address").default("").notNull(),
  notes: text("notes").default("").notNull(), // kontekst obiektu / research
  data: text("data").default("").notNull(), // JSON stanu designera ("" = nowy projekt)
  offer: text("offer").default("").notNull(), // JSON pól oferty ("" = jeszcze nie wypełniana)
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type MonitoringProject = typeof monitoringProjects.$inferSelect;
export type NewMonitoringProject = typeof monitoringProjects.$inferInsert;

// Zdjęcia z wizji lokalnej do oferty monitoringu — przeskalowane w przeglądarce
// (max 1500 px, JPEG ~80%) i zapisane jako data-URL, osadzane potem w HTML oferty.
export const monitoringPhotos = sqliteTable("monitoring_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => monitoringProjects.id, { onDelete: "cascade" }),
  caption: text("caption").default("").notNull(), // podpis (domyślnie nazwa pliku)
  attention: integer("attention", { mode: "boolean" }) // wyróżnienie (np. altanka bez kamer)
    .default(false)
    .notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  data: text("data").notNull(), // data:image/jpeg;base64,...
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type MonitoringPhoto = typeof monitoringPhotos.$inferSelect;
export type NewMonitoringPhoto = typeof monitoringPhotos.$inferInsert;

// Plany/rzuty terenu nakładane na mapę projektanta monitoringu (overlay)
// — obraz osadzony jako data-URL, pozycjonowany przez narożniki SW/NE.
export const monitoringOverlays = sqliteTable("monitoring_overlays", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => monitoringProjects.id, { onDelete: "cascade" }),
  name: text("name").default("").notNull(), // nazwa pliku / podpis planu
  data: text("data").notNull(), // data:image/...;base64,...
  swLat: real("sw_lat").notNull(),
  swLng: real("sw_lng").notNull(),
  neLat: real("ne_lat").notNull(),
  neLng: real("ne_lng").notNull(),
  rotation: real("rotation").default(0).notNull(), // stopnie
  opacity: real("opacity").default(0.7).notNull(), // 0..1
  visible: integer("visible", { mode: "boolean" }).default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type MonitoringOverlay = typeof monitoringOverlays.$inferSelect;
export type NewMonitoringOverlay = typeof monitoringOverlays.$inferInsert;

// ============================================================
// MODUŁ KADRY — odwzorowanie skoroszytu "MASTER" (godziny → wynagrodzenia)
// Przepływ: użytkownik wpisuje godziny za miesiąc → aplikacja liczy
// zestawienie godzin dla księgowości → księgowość podaje kwoty główne NETTO
// → aplikacja liczy dodatki i rozbicie przelew/gotówka.
// Logika kalkulacji: src/utils/hr-calc.ts (przepisana z formuł Excela,
// zagregowana — bez SUMIFS-ów per komórka).
// ============================================================

// Pracownicy ochrony + biuro (słownik osób)
export const hrEmployees = sqliteTable("hr_employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull().unique(), // "Nazwisko Imię" — jak w arkuszu
  code: text("code").default("").notNull(), // KOD z listy pracowników: Emeryt / Rencista / Student <26 lat
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrEmployee = typeof hrEmployees.$inferSelect;
export type NewHrEmployee = typeof hrEmployees.$inferInsert;

// Obiekty (posterunki) — słownik z arkusza "Obiekty"
export const hrObjects = sqliteTable("hr_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrObject = typeof hrObjects.$inferSelect;
export type NewHrObject = typeof hrObjects.$inferInsert;

// Normy godzin na miesiąc (arkusz "Rok": kolumny Praca / Zlecenie)
export const hrMonthNorms = sqliteTable("hr_month_norms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  year: integer("year").notNull(),
  month: integer("month").notNull(), // 1-12
  workNorm: real("work_norm").notNull(), // norma dla umowy o pracę (zmienna miesięcznie)
  contractNorm: real("contract_norm").notNull(), // norma dla zlecenia (w arkuszu stałe 158)
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrMonthNorm = typeof hrMonthNorms.$inferSelect;
export type NewHrMonthNorm = typeof hrMonthNorms.$inferInsert;

// Wypracowane godziny — wpis miesięczny pracownik×obiekt
// (arkusz "Wypracowane godziny"; może być kilka wpisów na osobę w miesiącu)
export const hrHours = sqliteTable("hr_hours", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => hrEmployees.id, { onDelete: "cascade" }),
  objectId: integer("object_id").references(() => hrObjects.id, {
    onDelete: "set null",
  }),
  year: integer("year").notNull(),
  month: integer("month").notNull(), // 1-12
  nightHours: real("night_hours"), // godziny nocne — informacyjne, nie wchodzą do płac
  workedHours: real("worked_hours"), // godziny wypracowane
  uwHours: real("uw_hours"), // urlop wypoczynkowy (godziny)
  l4Hours: real("l4_hours"), // L4 (godziny)
  maxHours: real("max_hours"), // GODZINY MAKS — indywidualny limit (nadpisuje normę przy UoP)
  deductions: real("deductions"), // POTRĄCENIA (zł)
  bonuses: real("bonuses"), // DODATKI / premie (zł)
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrHours = typeof hrHours.$inferSelect;
export type NewHrHours = typeof hrHours.$inferInsert;

// Umowa pracownika ze spółką (wiersz arkusza WYNAGRODZENIA; osoba może mieć
// kilka umów — np. ZUA w spółce docelowej + ZZA w źródłowej)
export const hrContracts = sqliteTable("hr_contracts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => hrEmployees.id, { onDelete: "cascade" }),
  company: text("company").notNull(), // SPÓŁKA: ALFA / ALFA S / CONTROL / GUARD n / ...
  contractType: text("contract_type", { enum: ["praca", "zlecenie"] })
    .default("zlecenie")
    .notNull(),
  chor: integer("chor", { mode: "boolean" }).default(false).notNull(), // ubezp. chorobowe (informacyjne)
  zua: text("zua").default("").notNull(), // zgłoszenie ZUA: "tak" albo data — liczy się niepuste
  zza: text("zza").default("").notNull(), // zgłoszenie ZZA: jw.
  zwua: text("zwua").default("").notNull(), // wyrejestrowanie (informacyjne)
  objectName: text("object_name").default("").notNull(), // OBIEKT — informacyjne
  mainChannel: text("main_channel", { enum: ["przelew", "gotowka"] })
    .default("przelew")
    .notNull(), // GŁÓWNA — kanał wypłaty głównej
  // DODATEK — rodzaj/kanał wypłaty dodatku (w Excelu tekst parsowany SEARCH-em;
  // tu jawny enum): brak / Gotówka / Delegacja-przelew / Delegacja-gotówka
  bonusType: text("bonus_type", {
    enum: ["brak", "gotowka", "delegacja_przelew", "delegacja_gotowka"],
  })
    .default("brak")
    .notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrContract = typeof hrContracts.$inferSelect;
export type NewHrContract = typeof hrContracts.$inferInsert;

// Miesięczne wejścia płacowe do umowy: kwota główna od księgowości, stawki
// ręczne i nadpisania wartości wyliczanych (null = licz z formuły).
export const hrPayroll = sqliteTable("hr_payroll", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contractId: integer("contract_id")
    .notNull()
    .references(() => hrContracts.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  mainAmount: real("main_amount"), // kwota główna NETTO — podaje księgowość
  bonusRate: real("bonus_rate"), // stawka netto dodatku (Q); null → użyj stawki głównej
  bonusRatePending: integer("bonus_rate_pending", { mode: "boolean" })
    .default(false)
    .notNull(), // "do przeliczenia" — dodatek czeka na stawkę/ręczną kwotę
  rateAdjustment: real("rate_adjustment"), // wyrównanie stawki netto (zł/h)
  maxHoursOverride: real("max_hours_override"), // ręczne maks godziny
  actualHoursOverride: real("actual_hours_override"), // ręczne fakt godziny
  bonusAmountOverride: real("bonus_amount_override"), // ręczna kwota dodatku netto
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrPayroll = typeof hrPayroll.$inferSelect;
export type NewHrPayroll = typeof hrPayroll.$inferInsert;

// Wynagrodzenia biura (arkusz "WYNAGRODZENIA - Biuro") — w większości ręczne;
// kwota = godziny×stawka gdy oba podane, delegacje/gotówka = kwota − podstawa ROR.
export const hrOfficePayroll = sqliteTable("hr_office_payroll", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => hrEmployees.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  company: text("company").default("").notNull(), // ALFA ETAT / ALFA UZ / ALFA S / CONTROL ETAT...
  etatHours: real("etat_hours"), // ETAT (godziny nominalne)
  uwL4: real("uw_l4"), // UW/L4 (godziny)
  deductions: real("deductions"), // POTRĄCENIA (zł)
  bonuses: real("bonuses"), // DODATKI (zł)
  hoursForAccounting: real("hours_for_accounting"), // GODZINY DO KSIĘGOWEJ (dla UZ)
  rate: real("rate"), // stawka (zł/h) — dla rozliczanych godzinowo
  amount: real("amount"), // kwota (zł); gdy null a są godziny×stawka → liczona
  rorBase: real("ror_base"), // podstawa ROR — część na przelew (od księgowości)
  cashOverride: real("cash_override"), // ręczne delegacje/gotówka; null → kwota − podstawa ROR
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrOfficePayroll = typeof hrOfficePayroll.$inferSelect;
export type NewHrOfficePayroll = typeof hrOfficePayroll.$inferInsert;
