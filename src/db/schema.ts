import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * KWOTY: NETTO CZY BRUTTO
 *
 * Wszystkie kwoty handlowe w tej bazie są NETTO, w sensie „bez VAT": abonamenty,
 * umowy, wyceny, cennik, realizacje, magazyn. Wynika to ze źródła — formularz
 * zlecenia przyjmuje „Abonament (zł netto)", a konwersja zlecenia na obiekt
 * przepisuje tę kwotę wprost do `objects.monthly_value` (src/services/orders.ts).
 *
 * UWAGA NA PUŁAPKĘ: w module kadr „netto" znaczy coś INNEGO — kwotę na rękę,
 * po podatku i składkach pracownika. Kwoty z `hr_payroll` / `hr_office_payroll`
 * to wypłaty netto w tym drugim sensie i NIE zawierają składek pracodawcy, więc
 * nie są pełnym kosztem zatrudnienia. Zestawiając je z przychodem (Analityka,
 * koszt osobowy obiektu) trzeba o tym pamiętać: to nie są te same „netto".
 */

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
  // Dane z wykazu VAT MF (biała lista) — uzupełniane przez wyszukiwarkę firm.
  regon: text("regon"),
  krs: text("krs"),
  // "Czynny" / "Zwolniony" / "Niezarejestrowany"; NULL = nigdy nie weryfikowano.
  vatStatus: text("vat_status"),
  // Data ostatniego sprawdzenia w wykazie ("YYYY-MM-DD").
  vatCheckedAt: text("vat_checked_at"),
  /**
   * Kontrahent bieżący (true) albo archiwalny (false) — ta sama konwencja, co przy
   * technikach: nic nie kasujemy, tylko chowamy z zakładki „Aktualni”. Historia
   * (obiekty, zlecenia, protokoły) zostaje nienaruszona.
   */
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  /** Opiekun handlowy klienta (NULL = nieprzypisany). */
  salespersonId: integer("salesperson_id").references(() => salespeople.id, {
    onDelete: "set null",
  }),
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
  /**
   * @deprecated Zastąpione rozdzielnymi usługami (hasSswin / hasCameras +
   * cameraCount / hasOfi / hasVideoreception). Jeden wybór nie opisywał obiektu,
   * na którym jest i alarm, i kamery, i warta — a od tego zależy, którym kluczem
   * liczy się koszt. Kolumna znika w osobnej migracji, gdy nic jej już nie czyta.
   */
  type: text("type", {
    enum: ["monitoring", "physical", "alarm", "mixed"],
  }).notNull(),
  /**
   * USŁUGI ŚWIADCZONE NA OBIEKCIE — niezależne od siebie, dowolny mix.
   * Decydują o tym, którym kluczem liczy się koszt osobowy:
   *  - ochrona fizyczna (OFI) → koszt wprost z godzin pracowników TEGO obiektu,
   *  - SSWiN / kamery / wideorecepcja → udział w koszcie centrum monitorowania,
   *    dzielonym po wszystkich dozorowanych jednostkach w firmie.
   */
  hasSswin: integer("has_sswin", { mode: "boolean" }).default(false).notNull(),
  hasCameras: integer("has_cameras", { mode: "boolean" }).default(false).notNull(),
  /**
   * Liczba kamer. NULL przy `hasCameras` = usługa jest, ale nikt nie policzył ilu —
   * i to NIE to samo, co zero. Taki obiekt nie ma jak wejść do podziału kosztu CMA
   * (nie znamy jego wagi), więc jest zgłaszany jako brak danych, dokładnie tak samo
   * jak nieuzupełniony koszt.
   */
  cameraCount: integer("camera_count"),
  hasOfi: integer("has_ofi", { mode: "boolean" }).default(false).notNull(),
  hasVideoreception: integer("has_videoreception", { mode: "boolean" })
    .default(false)
    .notNull(),
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
  /** Abonament miesięczny w zł NETTO (bez VAT) — przepisywany z kwoty ze zlecenia. */
  monthlyValue: real("monthly_value"),
  /**
   * Dzierżawa sprzętu w zł NETTO/mies. — druga część tego, co klient płaci co
   * miesiąc, przepisywana ze zlecenia (`orders.rental_amount`).
   *
   * OSOBNA KOLUMNA, a nie doliczenie do `monthly_value`, żeby dało się odróżnić
   * abonament za usługę od najmu sprzętu; Analityka sumuje obie pozycje
   * (`revenue = monthly_value + monthly_rental`). Do wersji z sierpnia 2026
   * kwota dzierżawy w ogóle nie docierała do obiektu i przychód takich obiektów
   * był zaniżony — dlatego dla danych sprzed migracji ta kolumna jest NULL,
   * a nie 0: nie ma z czego jej odtworzyć.
   */
  monthlyRental: real("monthly_rental"),
  /**
   * Miesięczny koszt POZOSTAŁY obiektu (zł NETTO/mies., bez VAT) — wszystko poza wynagrodzeniami:
   * monitoring, abonamenty, sprzęt, dojazdy. NIE jest to koszt całkowity.
   *
   * Koszt osobowy liczy się osobno z wypłat (src/lib/object-personnel-cost.ts),
   * przez mapowanie hr_objects.object_id, i DODAJE SIĘ do tego pola. Wpisanie tu
   * sumy wszystkiego policzyłoby wynagrodzenia drugi raz.
   *
   * NULL = nieuzupełniony, i to NIE to samo, co 0 zł — Analityka liczy pokrycie
   * danymi kosztowymi po tej różnicy, a marża obiektu bez żadnego znanego kosztu
   * jest nieznana, nie stuprocentowa.
   */
  monthlyCost: real("monthly_cost"),
  /** Jednorazowy koszt instalacji / wdrożenia w zł NETTO (bez VAT). NULL = nieuzupełniony. */
  setupCost: real("setup_cost"),
  notes: text("notes"),
  // Współrzędne obiektu (WGS84). NULL = jeszcze nieustalone; uzupełniane leniwie
  // geokoderem przy pierwszej kalkulacji dystansu (src/lib/geo.ts) albo ręcznie
  // z formularza obiektu — z nich liczy się dystans biuro → obiekt.
  latitude: real("latitude"),
  longitude: real("longitude"),
  /** Spółka grupy, która obsługuje/fakturuje obiekt (NULL = nieprzypisana). */
  companyId: integer("company_id").references(() => companies.id, {
    onDelete: "set null",
  }),
  /**
   * Handlowiec prowadzący ten obiekt. NULL = obowiązuje opiekun kontrahenta
   * (`contractors.salesperson_id`); obiekt nadpisuje przypisanie tylko wtedy,
   * gdy ktoś świadomie wskaże kogoś innego.
   */
  salespersonId: integer("salesperson_id").references(() => salespeople.id, {
    onDelete: "set null",
  }),
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
  /** Wartość umowy w zł NETTO (bez VAT). */
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
  payerInvoiceEmail: text("payer_invoice_email"),
  payerContractorId: integer("payer_contractor_id").references(() => contractors.id),
  
  // Dane obiektu
  objectName: text("object_name").notNull(),
  objectKind: text("object_kind"),
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

  // Zakres usługi / pytania
  internetIncluded: integer("internet_included", { mode: "boolean" }).default(false),
  interventionGroup: integer("intervention_group", { mode: "boolean" }).default(false),
  videoReception: integer("video_reception", { mode: "boolean" }).default(false),
  
  // Dane finansowe
  /** Abonament w zł NETTO (bez VAT) — tak podpisane w formularzu przyjęcia zlecenia. */
  monthlyAmount: real("monthly_amount"),
  contractLengthMonths: integer("contract_length_months"),
  /** Dzierżawa w zł NETTO (bez VAT). */
  rentalAmount: real("rental_amount"),
  rentalLengthMonths: integer("rental_length_months"),
  invoiceIssuer: text("invoice_issuer"),
  
  // Status i daty
  status: text("status", {
    enum: ["new", "in_progress", "completed", "cancelled"],
  })
    .default("new")
    .notNull(),
  serviceStartDate: text("service_start_date"),
  installationStartDate: text("installation_start_date"),

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
  /**
   * Obiekt z kartoteki, któremu odpowiada ta pozycja z systemu monitoringu.
   * NULL = niezmapowana, i tak jest dziś dla wszystkich 416 pozycji: rejestr
   * powstał niezależnie od kartoteki i nie pokrywa się z nią ani po nazwie,
   * ani po adresie (0 dopasowań). To trzeci — po `hr_objects` — rejestr, który
   * musiał dostać jawne powiązanie zamiast dopasowywania po tekście.
   * Mapowanie ustawia się ręcznie w module CMA.
   */
  objectId: integer("object_id").references(() => objects.id, {
    onDelete: "set null",
  }),
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
  // Uprawnienia per podzakładka: JSON { [tabKey]: 'view' | 'edit' }.
  // Brak klucza = brak dostępu. Admin (role='admin') ma pełny dostęp
  // niezależnie od tej mapy. Klucze zdefiniowane w src/lib/auth/permissions.ts.
  permissions: text("permissions").default("{}").notNull(),
  // Licznik optimistic-concurrency: każdy UPDATE bumpuje +1. Panel admina odsyła
  // odczytaną wartość jako expectedVersion; niezgodność => 409 (dwóch adminów
  // edytujących tego samego usera nie nadpisze się po cichu — lost update).
  version: integer("version").default(1).notNull(),
  // Token subskrypcji kalendarza ICS (GET /calendar/feed.ics?token=...).
  // NULL = użytkownik nie wygenerował feedu. Rotowany przez POST /calendar/feed-token.
  calendarToken: text("calendar_token").unique(),
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

/**
 * Rodzaj prac realizacji — ten sam słownik co `calendar_events.type` (bez typów
 * biurowych/urlopowych, za to z workiem „inne”). Odpowiada na pytanie CO robiono.
 */
export const REALIZATION_WORK_TYPES = [
  "serwis",
  "montaz",
  "wizja",
  "demontaz",
  "konserwacja",
  "inne",
] as const;
export type RealizationWorkType = (typeof REALIZATION_WORK_TYPES)[number];

/**
 * Typ rozliczenia realizacji — ten sam słownik co `calendar_events.billing`,
 * ale bez NULL (realizacja zawsze jest jakoś rozliczana). Odpowiada na pytanie ZA ILE.
 */
export const REALIZATION_BILLINGS = ["paid", "warranty", "free"] as const;
export type RealizationBilling = (typeof REALIZATION_BILLINGS)[number];

// Realizacje — rejestr serwisów i montaży działu technicznego
// (odwzorowanie miesięcznego arkusza Excel "Realizacje", np. "2026 2 Luty.xlsx").
// Wiersz opisują DWA niezależne wymiary: `work_type` (rodzaj prac: serwis, montaż,
// wizja…) i `billing` (typ rozliczenia: płatne / gwarancyjne / darmowe).
// Suma netto = godziny + materiały + km - rabat, liczona w API zamiast excelowych formuł.
export const realizations = sqliteTable("realizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  /**
   * Obiekt z kartoteki — JEDYNE ŹRÓDŁO TOŻSAMOŚCI tej realizacji.
   * Dopasowywanie po `site` dawało 29 błędnych trafień na 289 realizacji (10%),
   * bo dwanaście obiektów ma zduplikowane nazwy („Stacja paliw Bochnia" ×2)
   * i nazwa wskazywała inny obiekt niż kalendarz. NULL tylko dla realizacji
   * wpisanej ręcznie, zanim obiekt powstał.
   */
  objectId: integer("object_id").references(() => objects.id, {
    onDelete: "set null",
  }),
  /**
   * Nazwa obiektu w chwili wykonania prac — MIGAWKA na dokument, nie klucz.
   * Zostaje niezmieniona, gdy ktoś przemianuje obiekt, bo protokół ma mówić to,
   * co uzgodniono wtedy. Do łączenia służy wyłącznie `objectId`.
   */
  site: text("site").notNull(),
  // Rodzaj prac (CO) — źródło prawdy dla protokołów i statystyk.
  workType: text("work_type", { enum: REALIZATION_WORK_TYPES })
    .default("serwis")
    .notNull(),
  // Typ rozliczenia (ZA ILE) — źródło prawdy dla przychodu/straty.
  billing: text("billing", { enum: REALIZATION_BILLINGS })
    .default("paid")
    .notNull(),
  /**
   * Pole ZGODNOŚCIOWE — stary, jednowymiarowy „rodzaj”. NIE jest już edytowane
   * wprost: przy każdym zapisie wyliczamy je z (`work_type`, `billing`) przez
   * `realizationKindFrom()` (billing=warranty → warranty, work_type=montaz →
   * installation, inaczej service). Żyje dalej, bo czytają je protokoły
   * (`workTypeFromKind`), wyceny i starsze raporty.
   */
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
  // Koszt godzinowy technika w zł NETTO (bez VAT) — wewnętrzny koszt roboczogodziny.
  hourlyCost: real("hourly_cost").default(0).notNull(),
  // Ślad automatu (src/lib/realization-autofill.ts): JSON { [pole]: { source, detail, at } }
  // dla pól uzupełnionych automatycznie. NULL = nic nie uzupełniano. Wpis pola znika,
  // gdy ktoś zmieni tę wartość ręcznie (PUT /realizations/:id) — badge „auto" nie kłamie.
  autofill: text("autofill"),
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
  email: text("email"),
  company: text("company"),
  nip: text("nip"),
  type: text("type", { enum: ["internal", "external"] })
    .default("internal")
    .notNull(),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  /**
   * Ta sama osoba w kartotece kadrowej (NULL = technik spoza listy płac).
   * Dotąd technik i pracownik kadr byli osobnymi rekordami bez żadnego związku,
   * choć część osób figuruje w obu (Jaworski, Sajdak).
   */
  employeeId: integer("employee_id").references(() => hrEmployees.id, {
    onDelete: "set null",
  }),
  // Cennik przypisany technikowi (NULL = korzysta z cennika głównego).
  priceListId: integer("price_list_id").references(() => priceLists.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Technician = typeof technicians.$inferSelect;
export type NewTechnician = typeof technicians.$inferInsert;

/**
 * Handlowcy — słownik opiekunów handlowych, prowadzony jak technicy (miękkie
 * archiwum przez `active`, bez kasowania historii). Do handlowca przypisuje się
 * kontrahenta (opiekun klienta) i pojedynczy obiekt (`objects.salesperson_id`),
 * bo bywa, że konkretną lokalizację prowadzi kto inny niż całą firmę.
 */
export const salespeople = sqliteTable("salespeople", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  firstName: text("first_name").default("").notNull(),
  lastName: text("last_name").default("").notNull(),
  phone: text("phone"),
  email: text("email"),
  /** Region / obszar działania — czysty opis, bez słownika. */
  region: text("region"),
  /**
   * Ile handlowiec kosztuje firmę miesięcznie: wynagrodzenie, auto, telefon.
   * Kwota wpisywana ręcznie — podawaj ją w tej samej skali, co wypłaty z kadr,
   * czyli NETTO na rękę (aplikacja nie zna składek pracodawcy). Gdy handlowiec
   * jest powiązany z pracownikiem (`employeeId`), to pole jest ignorowane, a koszt
   * bierze się wprost z wypłat. NULL = nieuzupełniony.
   */
  monthlyCost: real("monthly_cost"),
  /** Prowizja w % od przychodu prowadzonego portfela (0–100). NULL = brak prowizji. */
  commissionRate: real("commission_rate"),
  /**
   * Ta sama osoba w kartotece kadrowej. NULL = handlowiec spoza listy płac
   * (np. na własnej działalności) i wtedy liczy się `monthlyCost` wpisany ręcznie.
   * Gdy powiązanie ISTNIEJE, koszt własny bierze się z wypłat, a pole ręczne jest
   * ignorowane — inaczej ten sam człowiek kosztowałby firmę dwa razy: raz
   * w Kadrach, raz w Analityce.
   */
  employeeId: integer("employee_id").references(() => hrEmployees.id, {
    onDelete: "set null",
  }),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Salesperson = typeof salespeople.$inferSelect;
export type NewSalesperson = typeof salespeople.$inferInsert;

/**
 * Spółki grupy (ALFA, ALFA S, CONTROL, GUARD n, TRUST n…) — słownik wspólny dla kadr
 * i obiektów. `name` jest KLUCZEM zgodności z modułem wynagrodzeń, gdzie spółka jest
 * trzymana jako tekst (`hr_contracts.company`, `hr_office_payroll.company`); zmiana
 * nazwy w słowniku przepisuje te wiersze, żeby jedno nie odjechało od drugiego.
 */
export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Skrót używany w kadrach, np. „ALFA S”, „GUARD 21”. Unikalny. */
  name: text("name").notNull().unique(),
  /** Pełna nazwa prawna (z wykazu VAT MF albo wpisana ręcznie). */
  fullName: text("full_name"),
  nip: text("nip"),
  // Dane z wykazu VAT MF — uzupełniane tą samą wyszukiwarką, co przy kontrahentach
  // (src/lib/mf-whitelist.ts). NULL = nigdy nie sprawdzano.
  regon: text("regon"),
  krs: text("krs"),
  address: text("address"),
  postalCode: text("postal_code"),
  city: text("city"),
  /** "Czynny" / "Zwolniony" / "Niezarejestrowany". */
  vatStatus: text("vat_status"),
  /** Dzień sprawdzenia w wykazie ("YYYY-MM-DD"). */
  vatCheckedAt: text("vat_checked_at"),
  notes: text("notes"),
  /*
   * NARZUT SKŁADEK PRACODAWCY — nadpisania per spółka (NULL = użyj wartości globalnej
   * z app_settings, klucze `company.employer_markup_*`; opis: src/lib/company-config.ts).
   *
   * Współczynnik, przez który mnożymy wypłatę NETTO („na rękę"), żeby dostać szacunkowy
   * KOSZT PRACODAWCY. Aplikacja nie zna kwot brutto — księgowość podaje wyłącznie netto —
   * więc jest to jawne przybliżenie, a nie wyliczenie z podstawy wymiaru składek.
   *
   * Nadpisania są per spółka, bo składka WYPADKOWA zależy od branży (PKD) i od wielkości
   * płatnika: spółka ochroniarska z kilkuset osobami ma inną stopę niż mała spółka biurowa
   * z tej samej grupy, a stopa jest ustalana indywidualnie na rok składkowy. Reszta składek
   * (emerytalna, rentowa, FP, FGŚP) jest wspólna, ale różnice w wypadkowej i w zwolnieniach
   * z FP/FGŚP potrafią przesunąć narzut o kilka punktów procentowych.
   *
   * Dopasowanie do umów idzie po NAZWIE (`hr_contracts.company` = `companies.name`) —
   * w kadrach spółka jest tekstem, nie kluczem obcym (patrz komentarz nad tabelą).
   */
  /** Umowa o pracę (zawsze ZUA) — pełne składki po stronie pracodawcy. */
  employerMarkupUop: real("employer_markup_uop"),
  /** Zlecenie zgłoszone na ZUA — te same składki pracodawcy, ale bez chorobowego pracownika. */
  employerMarkupZlecenieZua: real("employer_markup_zlecenie_zua"),
  /** Zlecenie zgłoszone tylko na ZZA — samo zdrowotne, pracodawca do ZUS nie dopłaca nic. */
  employerMarkupZlecenieZza: real("employer_markup_zlecenie_zza"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

// Cenniki (grupy pozycji). Zawsze dokładnie jeden ma isDefault=1 — to „cennik
// główny", z którego startują wyceny bez kontekstu technika i który przejmuje
// pozycje po usuniętym cenniku.
export const priceLists = sqliteTable("price_lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(), // 1–80 znaków
  description: text("description").default("").notNull(),
  isDefault: integer("is_default", { mode: "boolean" })
    .default(false)
    .notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type PriceListGroup = typeof priceLists.$inferSelect;
export type NewPriceListGroup = typeof priceLists.$inferInsert;

// Rodzaj pozycji cennika — porządkuje kalkulację realizacji (materiały vs robocizna).
export const PRICE_ITEM_KINDS = ["service", "material"] as const;
export type PriceItemKind = (typeof PRICE_ITEM_KINDS)[number];

// Cennik usług serwisowych — z załącznika do protokołu powykonawczego
// ("CENNIK USŁUG SERWISOWYCH", wer. 20260127).
export const priceList = sqliteTable("price_list", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Cennik, do którego należy pozycja. Usuwanie cennika obsługiwane w routach
  // (przeniesienie pozycji do domyślnego), więc FK trzyma RESTRICT.
  priceListId: integer("price_list_id")
    .notNull()
    .references(() => priceLists.id, { onDelete: "restrict" }),
  name: text("name").notNull(), // Nazwa usługi
  unit: text("unit").notNull(), // JM: KM / RBH / MB / SZT...
  // Rodzaj pozycji: usługa (robocizna, dojazd) albo materiał (towar z protokołu).
  // Automat realizacji dopasowuje pozycje protokołu WYŁĄCZNIE do materiałów,
  // a stawki RBH/KM szuka wyłącznie wśród usług.
  kind: text("kind", { enum: PRICE_ITEM_KINDS })
    .default("service")
    .notNull(),
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
  type: text("camera_type", { enum: ["bullet", "dome", "ptz", "pano", "lpr"] })
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
// Dla PŁATNYCH prac z kalendarza wycena powstaje automatycznie razem z realizacją
// i protokołem (src/lib/calendar-realizations.ts) — stąd `realization_id`.
export const quotes = sqliteTable(
  "quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    number: text("number").notNull().unique(), // np. W/2026/07/001
    date: text("date").notNull(), // YYYY-MM-DD
    /** Obiekt z kartoteki — źródło tożsamości. NULL = wycena bez obiektu. */
    objectId: integer("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    /** Nazwa obiektu w chwili wyceny — MIGAWKA na dokument, nie klucz. */
    site: text("site").default("").notNull(),
    address: text("address").default("").notNull(), // Adres
    items: text("items").default("[]").notNull(),
    /**
     * Realizacja, do której należy wycena (1:1, jak protokół). NULL = wycena
     * wolnostojąca: utworzona ręcznie w module Wyceny albo sprzed powiązania
     * wycen z kalendarzem.
     */
    realizationId: integer("realization_id").references(() => realizations.id, {
      onDelete: "cascade",
    }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    // Realizacja ↔ wycena 1:1 (indeks częściowy — wiele wycen bez realizacji jest OK).
    realizationIdIdx: uniqueIndex("quotes_realization_id_uidx")
      .on(t.realizationId)
      .where(sql`realization_id IS NOT NULL`),
  })
);

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;

// ============================================================================
// USŁUGI (dział techniczny) — katalog rzeczy, które NIE są towarem, a wchodzą
// do oferty: montaż kamery, uruchomienie rejestratora, konfiguracja, dojazd.
// ============================================================================

/**
 * DLACZEGO OSOBNO OD `price_list`
 *
 * Cennik (`price_list`) to cennik usług SERWISOWYCH: stawki RBH i km przypisane
 * technikom, z których automat przepisuje protokół na wycenę powykonawczą.
 * Zna wyłącznie cenę sprzedaży — nie ma pojęcia o koszcie własnym, więc marży
 * z niego nie policzysz. Dołożenie tam kosztu zmieniłoby zachowanie działającego
 * automatu protokół → wycena, dlatego ofertowanie dostaje własny katalog.
 */
export const SERVICE_CATEGORIES = [
  "montaz",
  "uruchomienie",
  "konfiguracja",
  "serwis",
  "projekt",
  "abonament",
  "inne",
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** System, którego usługa dotyczy — filtr przy składaniu pakietów oferty. */
export const SERVICE_SYSTEMS = [
  "cctv",
  "sswin",
  "kd",
  "ppoz",
  "sieci",
  "inne",
] as const;
export type ServiceSystem = (typeof SERVICE_SYSTEMS)[number];

export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // np. „Montaż kamery IP"
  category: text("category", { enum: SERVICE_CATEGORIES })
    .default("montaz")
    .notNull(),
  /** NULL = usługa uniwersalna, niezwiązana z konkretnym systemem. */
  system: text("system", { enum: SERVICE_SYSTEMS }),
  unit: text("unit").default("szt").notNull(), // szt / RBH / mb / kpl
  /** Koszt własny netto (robocizna). 0 = zadeklarowane zero, nie „nie wiem". */
  cost: real("cost").default(0).notNull(),
  /** Cena sprzedaży netto. */
  price: real("price").default(0).notNull(),
  description: text("description"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  position: integer("position").default(0).notNull(),
  /** Kto założył pozycję katalogu — login (email), jak `offers.created_by`. */
  createdBy: text("created_by"),
  /** Kto ostatni zapisał pozycję — login (email). */
  updatedBy: text("updated_by"),
  /**
   * Kiedy OSTATNIO zmieniła się cena — czyli `cost` ALBO `price`, bo w usłudze
   * stawka to para (koszt robocizny i cena sprzedaży) i przeterminowanie
   * jednej psuje marżę tak samo jak drugiej. Nie zmienia się przy poprawce
   * nazwy czy opisu — od tego jest `updated_at`, po którym nie da się poznać,
   * czy stawka jest jeszcze aktualna. NULL = nie wiadomo kiedy.
   */
  priceUpdatedAt: text("price_updated_at"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;

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

// Zdjęcia z wizji do oferty monitoringu — przeskalowane w przeglądarce
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
  // blokada planu — zablokowany nie daje się przesuwać/skalować/obracać w designerze
  locked: integer("locked", { mode: "boolean" }).default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  // JSON z metadanymi skali planu (import PDF / kalibracja):
  // {imgW,imgH, mppImage (m/px obrazu), scaleDenom (1:X), sheetMM:[w,h], calibrated}
  meta: text("meta"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type MonitoringOverlay = typeof monitoringOverlays.$inferSelect;
export type NewMonitoringOverlay = typeof monitoringOverlays.$inferInsert;

// Nazwane wersje (snapshoty) projektu monitoringu — ręcznie zapisywane
// migawki pełnego stanu designera (JSON jak monitoring_projects.data),
// do których można wrócić niezależnie od autozapisu.
export const monitoringSnapshots = sqliteTable("monitoring_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => monitoringProjects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // np. "Wariant 8 kamer, 3 słupy"
  data: text("data").notNull(), // JSON pełnego stanu projektu z designera
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type MonitoringSnapshot = typeof monitoringSnapshots.$inferSelect;
export type NewMonitoringSnapshot = typeof monitoringSnapshots.$inferInsert;

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
  // Rodzaj rozliczenia: "ochrona" = osoba z umowami kadrowymi (arkusz
  // WYNAGRODZENIA), "biuro" = osoba z zestawienia "WYNAGRODZENIA - Biuro".
  // Dawniej wynikał tylko z tego, w której tabeli ktoś miał wiersze — teraz
  // jest cechą pracownika, bo kartoteka jest wspólna i niezależna od miesiąca.
  kind: text("kind", { enum: ["ochrona", "biuro"] })
    .default("ochrona")
    .notNull(),
  /**
   * Dział firmy, do którego należy osoba. NIEZALEŻNY od przypisania pojedynczego
   * wpisu godzin (`hrHours.departmentId`): tam dział mówi, CZEGO dotyczyła praca
   * w danym miesiącu, tutaj — gdzie człowiek pracuje na stałe.
   *
   * Bez tego pola biura nie dało się przypisać do działu w ogóle: pracownicy
   * `kind = "biuro"` rozliczają się przez `hrOfficePayroll`, więc nie mają ani
   * jednego wiersza w `hrHours`, na którym dział mógłby zawisnąć.
   */
  departmentId: integer("department_id").references(() => hrDepartments.id, {
    onDelete: "set null",
  }),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
},
(t) => ({
  // Licznik „W kartotece" w GET /departments i filtr kartoteki po dziale.
  departmentIdIdx: index("hr_employees_department_id_idx").on(t.departmentId),
}));

export type HrEmployee = typeof hrEmployees.$inferSelect;
export type NewHrEmployee = typeof hrEmployees.$inferInsert;

// Obiekty (posterunki) — słownik z arkusza "Obiekty"
export const hrObjects = sqliteTable("hr_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  /**
   * Obiekt z kartoteki, którego dotyczą godziny zapisane na tej pozycji.
   * NULL = niezmapowany, i to jest stan domyślny: słownik kadrowy powstał
   * niezależnie od kartoteki i nazwy nie pokrywają się ani w jednym przypadku
   * („PUŁAWSKA 233" vs „Magazyn Centralny Kraków-Płaszów"). Bez tego ogniwa
   * nie da się przypisać wynagrodzeń do obiektu — mapowanie robi się ręcznie
   * w Kadry → Obiekty. Pozycje techniczne (#BIURO, #zlecenie) zostają
   * niezmapowane celowo: to koszt ogólny, nie koszt konkretnego obiektu.
   * Praca działowa (CMA, handlowy, …) nie mieszka już tutaj — ma własny
   * słownik `hrDepartments` i własną kolumnę w `hrHours`.
   */
  objectId: integer("object_id").references(() => objects.id, {
    onDelete: "set null",
  }),
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

// Działy firmy — słownik z Kadry → Działy
//
// Rodzeństwo `hrObjects`, nie kartoteki: godziny wskazują ALBO obiekt (posterunek),
// ALBO dział (praca, która nie należy do żadnego obiektu — handlowy, księgowość,
// zarząd). Dlatego dział nie ma `objectId` i nie da się go zmapować do kartoteki.
// Wcześniej rolę działów pełniły pozycje słownika obiektów rozpoznawane po nazwie
// (prefiks "#", literalne "CMA") — nazwa przestała być kluczem.
export const hrDepartments = sqliteTable("hr_departments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  /**
   * Dział jest PULĄ CENTRUM MONITOROWANIA. Jego koszt nie należy do żadnego
   * pojedynczego obiektu — rozdziela się po wszystkich dozorowanych jednostkach
   * (SSWiN, wideorecepcja i każda kamera liczą się po jednym). W praktyce flagę
   * nosi jeden dział („CMA"). Flaga, a nie nazwa: CRUD pozwala dział przemianować,
   * a rozpoznawanie po nazwie zepsułoby wtedy po cichu alokację kosztów.
   */
  isCmaPool: integer("is_cma_pool", { mode: "boolean" }).default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(), // kolejność na liście wyboru
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type HrDepartment = typeof hrDepartments.$inferSelect;
export type NewHrDepartment = typeof hrDepartments.$inferInsert;

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

// Wypracowane godziny — wpis miesięczny pracownik×(obiekt albo dział)
// (arkusz "Wypracowane godziny"; może być kilka wpisów na osobę w miesiącu)
export const hrHours = sqliteTable("hr_hours", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => hrEmployees.id, { onDelete: "cascade" }),
  /**
   * Przypisanie wpisu. `objectId` i `departmentId` WYKLUCZAJĄ SIĘ: wiersz wskazuje
   * obiekt albo dział, albo nic (praca nieprzypisana). Rozłączności pilnuje
   * `parseHours` w src/routes/hr.ts (400 przy obu naraz) i asercja w
   * scripts/test-object-identity.ts — SQLite CHECK wymagałby przebudowy tabeli.
   */
  objectId: integer("object_id").references(() => hrObjects.id, {
    onDelete: "set null",
  }),
  departmentId: integer("department_id").references(() => hrDepartments.id, {
    onDelete: "set null",
  }),
  // Wpis przeniesiony z poprzedniego miesiąca — przypisanie do potwierdzenia
  // (zapis wpisu przez użytkownika zdejmuje flagę)
  objectUncertain: integer("object_uncertain", { mode: "boolean" })
    .default(false)
    .notNull(),
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
},
(t) => ({
  // Tabela rośnie z każdym miesiącem (2 tys. wierszy po roku) i BEZ indeksów
  // każde pytanie o nią było pełnym skanem — w GET /departments trzy skorelowane
  // podzapytania per dział, w GET /objects dwa per pozycję, w GET /hours i
  // payrollu filtr po (rok, miesiąc). FK w SQLite nie zakłada indeksu samo.
  employeeIdIdx: index("hr_hours_employee_id_idx").on(t.employeeId),
  objectIdIdx: index("hr_hours_object_id_idx").on(t.objectId),
  departmentIdIdx: index("hr_hours_department_id_idx").on(t.departmentId),
  yearMonthIdx: index("hr_hours_year_month_idx").on(t.year, t.month),
}));

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

// ============================================================
// MODUŁ MAGAZYN — kartoteka towarów, magazyny, dokumenty (PZ/WZ/RW/MM),
// ledger ruchów (źródło prawdy) + cache stanów. Stany zmieniają się
// WYŁĄCZNIE przez zatwierdzenie/anulowanie dokumentu — w jednej transakcji
// zapisywany jest ruch do warehouse_movements i aktualizowany warehouse_stock.
// ============================================================

// Kartoteka towarów / sprzętu (isAsset = sprzęt zwrotny vs materiał zużywalny).
// Nigdy nie usuwana fizycznie — tylko archiwizacja (historia ruchów musi się spinać).
export const warehouseItems = sqliteTable("warehouse_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: text("sku").unique(),
  name: text("name").notNull(),
  category: text("category"),
  /** Producent (Dahua, Hikvision, Satel...) — wolny tekst, jak `category`. */
  manufacturer: text("manufacturer"),
  unit: text("unit").default("szt").notNull(),
  description: text("description"),
  /** Cena zakupu netto = koszt własny towaru. NULL = nikt jej nie podał. */
  purchasePrice: real("purchase_price"),
  /**
   * Cena sprzedaży netto. NULL NIE znaczy „za darmo" — znaczy „licz automatem":
   * cena zakupu + globalny narzut `company.warehouse_markup`. Wpisana wartość to
   * świadome nadpisanie automatu dla tego towaru (src/lib/margin.ts).
   */
  salePrice: real("sale_price"),
  photoData: text("photo_data"), // base64 data-URL (wzorzec jak monitoringPhotos)
  minStock: real("min_stock"), // próg alertu niskiego stanu
  isAsset: integer("is_asset", { mode: "boolean" }).default(false).notNull(),
  barcode: text("barcode"),
  isArchived: integer("is_archived", { mode: "boolean" })
    .default(false)
    .notNull(),
  /** Kto założył kartotekę — login (email), jak `offers.created_by`. */
  createdBy: text("created_by"),
  /** Kto ostatni zapisał kartotekę — login (email). */
  updatedBy: text("updated_by"),
  /**
   * Kiedy OSTATNIO zmieniła się cena (zakupu albo sprzedaży) — nie kiedy
   * ktokolwiek dotknął rekordu. `updated_at` przestawia się przy poprawce
   * literówki w nazwie czy zmianie kategorii i przez to nie mówi nic
   * o aktualności cennika; bez osobnego stempla nie da się odróżnić towaru
   * z ceną potwierdzoną wczoraj od takiego z ceną sprzed dwóch lat.
   * NULL = ceny nigdy nie ustawiono (albo nie wiadomo kiedy).
   */
  priceUpdatedAt: text("price_updated_at"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type WarehouseItem = typeof warehouseItems.$inferSelect;
export type NewWarehouseItem = typeof warehouseItems.$inferInsert;

// Magazyny — główny, pojazdy, pracownicy, budowy. Hierarchia max 1 poziom
// (parent nie może sam mieć parenta — pilnowane w API).
export const warehouses = sqliteTable("warehouses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  code: text("code"),
  type: text("type", { enum: ["main", "vehicle", "employee", "site", "other"] })
    .default("main")
    .notNull(),
  parentId: integer("parent_id").references(
    (): AnySQLiteColumn => warehouses.id
  ),
  isArchived: integer("is_archived", { mode: "boolean" })
    .default(false)
    .notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;

// Dokumenty magazynowe: PZ (przyjęcie), WZ (wydanie), RW (rozchód wewnętrzny),
// MM (przesunięcie międzymagazynowe). docNumber nadawany przy zatwierdzeniu.
export const warehouseDocuments = sqliteTable("warehouse_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  docType: text("doc_type", { enum: ["PZ", "WZ", "RW", "MM"] }).notNull(),
  docNumber: text("doc_number").unique(), // np. PZ/2026/001 — nadawany przy zatwierdzeniu
  status: text("status", { enum: ["draft", "confirmed", "cancelled"] })
    .default("draft")
    .notNull(),
  warehouseFromId: integer("warehouse_from_id").references(() => warehouses.id),
  warehouseToId: integer("warehouse_to_id").references(() => warehouses.id),
  contractorName: text("contractor_name"),
  invoiceNumber: text("invoice_number"),
  invoiceFileName: text("invoice_file_name"),
  invoiceFileData: text("invoice_file_data"), // base64 data-URL
  issuedAt: text("issued_at").notNull(), // data dokumentu YYYY-MM-DD
  confirmedAt: text("confirmed_at"),
  notes: text("notes"),
  createdBy: text("created_by"), // login (email) użytkownika
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type WarehouseDocument = typeof warehouseDocuments.$inferSelect;
export type NewWarehouseDocument = typeof warehouseDocuments.$inferInsert;

// Pozycje dokumentu magazynowego
export const warehouseDocumentItems = sqliteTable(
  "warehouse_document_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .notNull()
      .references(() => warehouseDocuments.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => warehouseItems.id),
    quantity: real("quantity").notNull(),
    /** Cena jednostkowa w zł NETTO (bez VAT). */
    unitPrice: real("unit_price"),
    positionNo: integer("position_no").notNull(),
  },
  (t) => ({
    documentIdIdx: index("warehouse_document_items_document_id_idx").on(
      t.documentId
    ),
  })
);

export type WarehouseDocumentItem = typeof warehouseDocumentItems.$inferSelect;
export type NewWarehouseDocumentItem =
  typeof warehouseDocumentItems.$inferInsert;

// LEDGER ruchów magazynowych — append-only, źródło prawdy o stanach.
// Anulowanie dokumentu dopisuje ruchy odwrotne (storno), niczego nie kasuje.
export const warehouseMovements = sqliteTable(
  "warehouse_movements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => warehouseItems.id),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    quantityDelta: real("quantity_delta").notNull(), // +przyjęcie / -wydanie
    documentId: integer("document_id").references(() => warehouseDocuments.id),
    documentItemId: integer("document_item_id").references(
      () => warehouseDocumentItems.id
    ),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    createdBy: text("created_by"),
  },
  (t) => ({
    itemIdIdx: index("warehouse_movements_item_id_idx").on(t.itemId),
    warehouseIdIdx: index("warehouse_movements_warehouse_id_idx").on(
      t.warehouseId
    ),
    documentIdIdx: index("warehouse_movements_document_id_idx").on(
      t.documentId
    ),
  })
);

export type WarehouseMovement = typeof warehouseMovements.$inferSelect;
export type NewWarehouseMovement = typeof warehouseMovements.$inferInsert;

// Cache aktualnych stanów (itemId × warehouseId) — aktualizowany w tej samej
// transakcji co insert do ledgera; zawsze = SUM(quantity_delta) z ledgera.
export const warehouseStock = sqliteTable(
  "warehouse_stock",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => warehouseItems.id),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    quantity: real("quantity").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.warehouseId] }),
  })
);

export type WarehouseStock = typeof warehouseStock.$inferSelect;
export type NewWarehouseStock = typeof warehouseStock.$inferInsert;

// Sekwencje numeracji dokumentów per typ i rok (PZ/2026/001, ...)
export const warehouseDocSequences = sqliteTable(
  "warehouse_doc_sequences",
  {
    docType: text("doc_type").notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.docType, t.year] }),
  })
);

export type WarehouseDocSequence = typeof warehouseDocSequences.$inferSelect;
export type NewWarehouseDocSequence = typeof warehouseDocSequences.$inferInsert;

// ============================================================================
// OFERTY (dział techniczny) — dokument handlowy dla klienta, składany z pakietów
// ============================================================================

/*
 * CZYM OFERTA NIE JEST
 *
 * `quotes` („Wyceny") to dokument POWYKONAWCZY, sztywno związany z realizacją,
 * z pozycjami w płaskim JSON-ie bez identyfikatorów. Oferta idzie do klienta
 * PRZED pracą, zna kontrahenta, koszt własny i marżę, ma pozycje cykliczne
 * (abonament) i dzierżawę — dlatego jest osobnym bytem, a nie rozbudową wyceny.
 *
 * TRZY STRUMIENIE PIENIĘDZY, które oferta musi rozróżniać:
 *   jednorazowo — sprzęt i robocizna płatne przy wdrożeniu,
 *   miesięcznie — abonament (analityka, internet, grupa interwencyjna),
 *   dzierżawa   — najem sprzętu, liczony z wartości sprzętu w ofercie.
 *
 * Wszystkie kwoty NETTO (patrz nagłówek pliku).
 */

export const OFFER_KINDS = ["rozbudowa", "montaz", "serwis"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Tryb dzierżawy; `custom` = dowolna liczba miesięcy wpisana ręcznie. */
export const OFFER_LEASE_MODES = ["none", "y1", "y2", "custom"] as const;
export type OfferLeaseMode = (typeof OFFER_LEASE_MODES)[number];

export const offers = sqliteTable(
  "offers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** OF/RRRR/MM/NNN, wersje z sufiksem „-w2" (patrz `parentId`). */
    number: text("number").notNull().unique(),
    /**
     * Oferta pierwotna, z której powstała ta wersja. NULL = wersja pierwsza.
     * Wysłanej oferty nie wolno edytować — negocjacje tworzą nową wersję, żeby
     * to, co klient dostał na papierze, dało się odtworzyć co do złotówki.
     */
    parentId: integer("parent_id").references((): AnySQLiteColumn => offers.id, {
      onDelete: "set null",
    }),
    version: integer("version").default(1).notNull(),

    date: text("date").notNull(), // YYYY-MM-DD
    /** Termin ważności; status „expired" WYLICZAMY z niego przy odczycie. */
    validUntil: text("valid_until"),
    sentAt: text("sent_at"),

    kind: text("kind", { enum: OFFER_KINDS }).default("montaz").notNull(),
    status: text("status", { enum: OFFER_STATUSES }).default("draft").notNull(),

    // Klient: wskazanie na kartotekę + MIGAWKI na dokument. Migawka jest po to,
    // żeby zmiana nazwy kontrahenta nie przepisała wstecz wystawionej oferty.
    contractorId: integer("contractor_id").references(() => contractors.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").default("").notNull(),
    clientNip: text("client_nip").default("").notNull(),

    objectId: integer("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    site: text("site").default("").notNull(),
    address: text("address").default("").notNull(),

    /** Handlowiec prowadzący — pod konwersję ofert i prowizje w Analityce. */
    salespersonId: integer("salesperson_id").references(() => salespeople.id, {
      onDelete: "set null",
    }),
    /** Spółka wystawiająca — z niej wydruk bierze NIP/KRS/REGON do stopki. */
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),

    /** Rabat na CAŁY dokument (%), obok rabatów na pojedynczych pozycjach. */
    discountPct: real("discount_pct").default(0).notNull(),

    /**
     * PRZEWIDYWANY CZAS KONTRAKTU w miesiącach — jak długo klient ma zostać.
     *
     * To założenie handlowca, nie zobowiązanie klienta (od tego jest dzierżawa),
     * ale właśnie ono decyduje, ile warta jest oferta z abonamentem: te same
     * 460 zł miesięcznie przez rok i przez trzy lata to dwie różne transakcje.
     * Ustawia OKRES, na którym liczy się marża, zysk i prowizja; NULL = zostaje
     * dotychczasowa reguła (długość dzierżawy, a bez niej 12 miesięcy).
     */
    contractMonths: integer("contract_months"),

    // --- Dzierżawa: jeden zestaw parametrów na całą ofertę ---
    leaseMode: text("lease_mode", { enum: OFFER_LEASE_MODES })
      .default("none")
      .notNull(),
    leaseMonths: integer("lease_months"),
    /** Procent ROCZNY; rata miesięczna = podstawa × procent / 100 / 12. */
    leaseAnnualRate: real("lease_annual_rate"),
    /** Czy robocizna wchodzi do podstawy raty (raz tak, raz nie). */
    leaseIncludeLabour: integer("lease_include_labour", { mode: "boolean" })
      .default(false)
      .notNull(),

    // --- Ślady po akceptacji ---
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    warehouseDocId: integer("warehouse_doc_id").references(
      () => warehouseDocuments.id,
      { onDelete: "set null" }
    ),

    notes: text("notes"),

    /**
     * Token linku dla klienta (`/oferta/<token>`). NULL = oferta nieudostępniona.
     *
     * To JEDYNE, co chroni dokument — pod tym adresem nie ma żadnej innej
     * autoryzacji, więc token musi być losowy i długi (24 bajty z `randomBytes`).
     * Wyzerowanie kolumny natychmiast odbiera klientowi dostęp.
     */
    shareToken: text("share_token"),

    createdBy: text("created_by"), // login (email) użytkownika
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    contractorIdIdx: index("offers_contractor_id_idx").on(t.contractorId),
    objectIdIdx: index("offers_object_id_idx").on(t.objectId),
    statusIdx: index("offers_status_idx").on(t.status),
    parentIdIdx: index("offers_parent_id_idx").on(t.parentId),
    // Unikalny, ale kolumna jest nullowalna — w SQLite wiele NULL-i nie koliduje,
    // więc oferty nieudostępnione nie blokują się nawzajem.
    shareTokenIdx: uniqueIndex("offers_share_token_uidx").on(t.shareToken),
  })
);

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;

/** Kategoria sekcji — pokrywa się z usługami obiektu (src/lib/object-services.ts). */
export const OFFER_SECTION_CATEGORIES = [
  "cctv",
  "sswin",
  "kd",
  "wideoweryfikacja",
  "abonament",
  "inne",
] as const;
export type OfferSectionCategory = (typeof OFFER_SECTION_CATEGORIES)[number];

/**
 * Sekcja oferty = jeden pakiet (np. „CCTV Dahua, 8 kamer") albo ręczna grupa pozycji.
 *
 * WARIANTY: sekcje z tym samym `variantGroup` są dla klienta alternatywami
 * („Dahua albo Hikvision”) — do sum wchodzi wyłącznie ta z `variantSelected`.
 * OPCJE: sekcja `isOptional` jest na dokumencie widoczna, ale poza kwotą
 * „do zapłaty” — to propozycja dodatkowa, nie część zamówienia.
 */
export const offerSections = sqliteTable(
  "offer_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    offerId: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),
    category: text("category", { enum: OFFER_SECTION_CATEGORIES })
      .default("inne")
      .notNull(),
    title: text("title").default("").notNull(),
    /** Pakiet, z którego sekcja powstała (NULL = złożona ręcznie). */
    packageId: integer("package_id").references(
      (): AnySQLiteColumn => offerPackages.id,
      { onDelete: "set null" }
    ),
    /** Parametry użyte przy rozwijaniu pakietu, JSON: {"cameras": 8}. */
    params: text("params").default("{}").notNull(),
    isOptional: integer("is_optional", { mode: "boolean" })
      .default(false)
      .notNull(),
    variantGroup: text("variant_group"),
    variantSelected: integer("variant_selected", { mode: "boolean" })
      .default(true)
      .notNull(),
    notes: text("notes"),
  },
  (t) => ({
    offerIdIdx: index("offer_sections_offer_id_idx").on(t.offerId),
  })
);

export type OfferSection = typeof offerSections.$inferSelect;
export type NewOfferSection = typeof offerSections.$inferInsert;

/** Skąd wzięła się pozycja — decyduje, którą kartotekę odświeża „Przelicz ceny". */
export const OFFER_ITEM_SOURCES = ["warehouse", "service", "manual"] as const;
export type OfferItemSource = (typeof OFFER_ITEM_SOURCES)[number];

/**
 * Rodzaj pozycji. Rozstrzyga, co wchodzi do PODSTAWY DZIERŻAWY: zawsze
 * `material` (sprzęt), a `labour` tylko przy `leaseIncludeLabour`.
 */
export const OFFER_ITEM_KINDS = [
  "material",
  "labour",
  "subscription",
  "other",
] as const;
export type OfferItemKind = (typeof OFFER_ITEM_KINDS)[number];

/** Jednorazowo czy co miesiąc — dwa osobne strumienie w podsumowaniu oferty. */
export const OFFER_ITEM_BILLINGS = ["one_time", "monthly"] as const;
export type OfferItemBilling = (typeof OFFER_ITEM_BILLINGS)[number];

export const offerItems = sqliteTable(
  "offer_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * Denormalizacja: pozycja zna swoją ofertę wprost, żeby suma dokumentu nie
     * wymagała joinu przez sekcje. Kaskada leci obiema drogami.
     */
    offerId: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    sectionId: integer("section_id")
      .notNull()
      .references(() => offerSections.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),

    source: text("source", { enum: OFFER_ITEM_SOURCES })
      .default("manual")
      .notNull(),
    warehouseItemId: integer("warehouse_item_id").references(
      () => warehouseItems.id,
      { onDelete: "set null" }
    ),
    serviceId: integer("service_id").references(() => services.id, {
      onDelete: "set null",
    }),

    /** MIGAWKI: nazwa i jednostka na dokumencie nie zmieniają się po edycji kartoteki. */
    name: text("name").notNull(),
    unit: text("unit").default("szt").notNull(),
    qty: real("qty").default(1).notNull(),

    kind: text("kind", { enum: OFFER_ITEM_KINDS }).default("material").notNull(),
    billing: text("billing", { enum: OFFER_ITEM_BILLINGS })
      .default("one_time")
      .notNull(),

    /** Koszt własny netto za jednostkę. NULL = nieznany, i to NIE jest zero. */
    unitCost: real("unit_cost"),
    /** Cena sprzedaży netto za jednostkę. */
    unitPrice: real("unit_price").default(0).notNull(),
    discountPct: real("discount_pct").default(0).notNull(),
    /** Pozycja pokazana klientowi, ale poza kwotą „do zapłaty". */
    isOptional: integer("is_optional", { mode: "boolean" })
      .default(false)
      .notNull(),
  },
  (t) => ({
    offerIdIdx: index("offer_items_offer_id_idx").on(t.offerId),
    sectionIdIdx: index("offer_items_section_id_idx").on(t.sectionId),
  })
);

export type OfferItem = typeof offerItems.$inferSelect;
export type NewOfferItem = typeof offerItems.$inferInsert;

/**
 * Biblioteka pakietów — zapisane zestawy, z których składa się ofertę jednym
 * kliknięciem („+ CCTV → Dahua → 8 kamer").
 *
 * `parametric` skaluje pozycje od parametru (8 kamer → 8 kamer, 1 rejestrator
 * na każde 8, 8 montaży), `fixed` to sztywny zestaw ignorujący parametry.
 */
export const OFFER_PACKAGE_MODES = ["parametric", "fixed"] as const;
export type OfferPackageMode = (typeof OFFER_PACKAGE_MODES)[number];

export const offerPackages = sqliteTable("offer_packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category", { enum: OFFER_SECTION_CATEGORIES })
    .default("inne")
    .notNull(),
  /** Marka zestawu (Dahua, Hikvision, Satel) — wolny tekst, jak w magazynie. */
  manufacturer: text("manufacturer"),
  description: text("description"),
  mode: text("mode", { enum: OFFER_PACKAGE_MODES })
    .default("parametric")
    .notNull(),
  /**
   * Definicja parametrów, JSON:
   * [{ "key": "cameras", "label": "Liczba kamer", "default": 4, "min": 1, "max": 64 }]
   * Przy `mode = "fixed"` pusta tablica.
   */
  params: text("params").default("[]").notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type OfferPackage = typeof offerPackages.$inferSelect;
export type NewOfferPackage = typeof offerPackages.$inferInsert;

/** Zaokrąglenie ilości po przeskalowaniu — „1 rejestrator na każde 8 kamer". */
export const OFFER_QTY_ROUNDINGS = ["none", "up"] as const;
export type OfferQtyRounding = (typeof OFFER_QTY_ROUNDINGS)[number];

export const offerPackageItems = sqliteTable(
  "offer_package_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    packageId: integer("package_id")
      .notNull()
      .references(() => offerPackages.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),

    source: text("source", { enum: OFFER_ITEM_SOURCES })
      .default("warehouse")
      .notNull(),
    warehouseItemId: integer("warehouse_item_id").references(
      () => warehouseItems.id,
      { onDelete: "cascade" }
    ),
    serviceId: integer("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),
    /** Nazwa dla pozycji ręcznej; przy magazynie/usłudze — zapas, gdy zniknie źródło. */
    name: text("name").default("").notNull(),
    unit: text("unit").default("szt").notNull(),

    kind: text("kind", { enum: OFFER_ITEM_KINDS }).default("material").notNull(),
    billing: text("billing", { enum: OFFER_ITEM_BILLINGS })
      .default("one_time")
      .notNull(),

    /** Ilość stała, niezależna od parametru (np. 1 rejestrator „zawsze"). */
    qtyBase: real("qty_base").default(0).notNull(),
    /** Mnożnik parametru: 1 = jedna sztuka na kamerę, 0.125 = jedna na osiem. */
    qtyPerParam: real("qty_per_param").default(0).notNull(),
    /** Klucz parametru z `offerPackages.params`, np. „cameras". */
    paramKey: text("param_key"),
    qtyRound: text("qty_round", { enum: OFFER_QTY_ROUNDINGS })
      .default("none")
      .notNull(),

    /**
     * SLOT — jedno miejsce w zestawie („Rejestrator"), w którym pakiet WYBIERA
     * wariant zamiast dodawać wszystkie. Wiersze o tej samej etykiecie tworzą
     * grupę; NULL = zwykła pozycja, wchodzi zawsze.
     *
     * Tym różni się od mnożnika: przy 9–16 kamerach nie zmienia się ILOŚĆ
     * rejestratorów, tylko KTÓRY rejestrator wchodzi na ofertę. Bez slotów
     * trzeba było trzymać trzy niemal identyczne pakiety w bibliotece.
     */
    slot: text("slot"),
    /**
     * Zakres wartości parametru z `paramKey`, przy którym ten wariant wygrywa
     * slot — granice WŁĄCZNIE, NULL = strona otwarta. Ma sens tylko razem ze
     * `slot` (route pilnuje) i zakresy w jednym slocie nie mogą na siebie
     * nachodzić, bo wybór stałby się zależny od kolejności wierszy.
     */
    paramMin: real("param_min"),
    paramMax: real("param_max"),

    /** Cena narzucona przez pakiet; NULL = weź aktualną ze źródła. */
    unitPriceOverride: real("unit_price_override"),
  },
  (t) => ({
    packageIdIdx: index("offer_package_items_package_id_idx").on(t.packageId),
  })
);

export type OfferPackageItem = typeof offerPackageItems.$inferSelect;
export type NewOfferPackageItem = typeof offerPackageItems.$inferInsert;

/**
 * Biblioteka OPISÓW — powtarzalne teksty handlowe (warunki gwarancji, zakres
 * wsparcia, warunki płatności), wklejane na ofertę jednym kliknięciem.
 *
 * Analogia pakietu: to WZORZEC, a nie treść dokumentu. Dołączenie opisu na
 * ofertę KOPIUJE tekst do `offerTextBlocks`, bo moduł stoi na zamrożeniu —
 * poprawiona dziś gwarancja nie może przepisać wstecz oferty, którą klient
 * dostał w zeszłym miesiącu.
 */
export const offerTexts = sqliteTable("offer_texts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Nazwa W BIBLIOTECE („Gwarancja 24 mies."), nie nagłówek na wydruku. */
  name: text("name").notNull(),
  category: text("category", { enum: OFFER_SECTION_CATEGORIES })
    .default("inne")
    .notNull(),
  /** Nagłówek drukowany nad treścią; pusty = blok bez nagłówka. */
  title: text("title").default("").notNull(),
  /**
   * Treść w prostym markdownie. Backend trzyma ją jako zwykły tekst i niczego
   * w niej nie interpretuje — składnię rozwija dopiero front przy wydruku.
   */
  body: text("body").default("").notNull(),
  /** Wchodzi na KAŻDĄ nową ofertę (warunki płatności, klauzula RODO). */
  isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type OfferText = typeof offerTexts.$inferSelect;
export type NewOfferText = typeof offerTexts.$inferInsert;

/**
 * Opis NA KONKRETNEJ OFERCIE — pełna kopia treści, nie referencja do katalogu.
 *
 * Dzięki temu wydruk jest samowystarczalny: da się go odtworzyć co do
 * przecinka nawet po tym, jak wzorzec w bibliotece zmieniono albo schowano.
 */
export const offerTextBlocks = sqliteTable(
  "offer_text_blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    offerId: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    /**
     * ŚLAD POCHODZENIA — z którego wzorca wzięto treść (NULL = blok napisany
     * ręcznie na tej ofercie). `set null`, bo archiwizacja wzorca nie ma prawa
     * ruszyć wystawionej oferty; treść i tak leży w kolumnach obok.
     */
    textId: integer("text_id").references(
      (): AnySQLiteColumn => offerTexts.id,
      { onDelete: "set null" }
    ),
    title: text("title").default("").notNull(),
    /** Markdown, jak w katalogu — migawka z chwili dołączenia opisu. */
    body: text("body").default("").notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    offerIdIdx: index("offer_text_blocks_offer_id_idx").on(t.offerId),
  })
);

export type OfferTextBlock = typeof offerTextBlocks.$inferSelect;
export type NewOfferTextBlock = typeof offerTextBlocks.$inferInsert;

// ============================================================================
// KALENDARZ (dział techniczny) — wydarzenia, serie cykliczne, przypisani technicy
// ============================================================================

export const CALENDAR_EVENT_TYPES = [
  "serwis",
  "montaz",
  "wizja",
  "demontaz",
  "biuro",
  "przygotowanie",
  "konserwacja",
  "urlop",
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export const CALENDAR_EVENT_STATUSES = [
  "planned",
  "confirmed",
  "done",
  "cancelled",
] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/** Rozliczenie wydarzenia (NULL = nie dotyczy / nie ustalono). */
export const CALENDAR_BILLINGS = ["warranty", "free", "paid"] as const;
export type CalendarBilling = (typeof CALENDAR_BILLINGS)[number];

export const CALENDAR_SERIES_FREQS = [
  "weekly",
  "monthly",
  "quarterly",
  "semiannual",
  "yearly",
] as const;
export type CalendarSeriesFreq = (typeof CALENDAR_SERIES_FREQS)[number];

// Seria cykliczna (np. konserwacja co kwartał). Wystąpienia są
// MATERIALIZOWANE jako zwykłe wiersze calendar_events (każde ma własny
// status/historię/techników) — seria to tylko reguła + spinacz.
// Reguła: until albo count; oba NULL → 24 miesiące do przodu (max 200 wystąpień).
export const calendarSeries = sqliteTable("calendar_series", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  freq: text("freq", { enum: CALENDAR_SERIES_FREQS }).notNull(),
  interval: integer("interval").default(1).notNull(), // co ile jednostek freq
  until: text("until"), // YYYY-MM-DD (włącznie)
  count: integer("count"), // liczba wystąpień
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type CalendarSeries = typeof calendarSeries.$inferSelect;
export type NewCalendarSeries = typeof calendarSeries.$inferInsert;

// Wydarzenie kalendarza. Daty: ISO lokalny bez strefy "YYYY-MM-DDTHH:MM";
// dla all_day "YYYY-MM-DD", a end_at jest EXCLUSIVE (jak FullCalendar:
// 1-dniowy event = start "2026-09-12", end "2026-09-13").
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: CALENDAR_EVENT_TYPES }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    allDay: integer("all_day", { mode: "boolean" }).default(false).notNull(),
    status: text("status", { enum: CALENDAR_EVENT_STATUSES })
      .default("planned")
      .notNull(),
    department: text("department").default("technical").notNull(),
    objectId: integer("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    orderId: integer("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    realizationId: integer("realization_id").references(
      () => realizations.id,
      { onDelete: "set null" }
    ),
    // Użytkownik ręcznie odpiął realizację ("Odepnij") — nie twórz jej automatycznie
    // przy kolejnych zapisach ani przy statusie „wykonane”. Zdejmowane przez ręczne
    // podpięcie realizacji (src/lib/calendar-realizations.ts).
    realizationOptout: integer("realization_optout", { mode: "boolean" })
      .default(false)
      .notNull(),
    seriesId: integer("series_id").references(() => calendarSeries.id, {
      onDelete: "set null",
    }),
    // Rozliczenie: warranty | free | paid | NULL (nie dotyczy). Ukryte dla urlop/biuro/przygotowanie.
    billing: text("billing", { enum: CALENDAR_BILLINGS }),
    // Jawnie przypięty protokół; gdy NULL — protokół realizacji (realization_id → protocols.realization_id).
    protocolId: integer("protocol_id").references(() => protocols.id, {
      onDelete: "set null",
    }),
    // Jawnie przypięta wycena; gdy NULL — wycena realizacji (realization_id → quotes.realization_id).
    quoteId: integer("quote_id").references(() => quotes.id, {
      onDelete: "set null",
    }),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: integer("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    deletedAt: text("deleted_at"), // soft delete
  },
  (t) => ({
    startAtIdx: index("calendar_events_start_at_idx").on(t.startAt),
    objectIdIdx: index("calendar_events_object_id_idx").on(t.objectId),
    deletedAtIdx: index("calendar_events_deleted_at_idx").on(t.deletedAt),
    seriesIdIdx: index("calendar_events_series_id_idx").on(t.seriesId),
    // Realizacja ↔ wydarzenie 1:1 (indeks częściowy — wiele wydarzeń bez realizacji jest OK).
    realizationIdIdx: uniqueIndex("calendar_events_realization_id_uidx")
      .on(t.realizationId)
      .where(sql`realization_id IS NOT NULL`),
  })
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;

// Przypisanie techników do wydarzenia (N:M).
export const calendarEventAssignees = sqliteTable(
  "calendar_event_assignees",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    technicianId: integer("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.technicianId] }),
  })
);

export type CalendarEventAssignee = typeof calendarEventAssignees.$inferSelect;
export type NewCalendarEventAssignee = typeof calendarEventAssignees.$inferInsert;

// Notatki do wydarzenia — dziennik (wiele wpisów, z autorem i czasem). `description`
// wydarzenia pozostaje stałym opisem; notatki dopisują użytkownicy i asystent (source).
export const CALENDAR_NOTE_SOURCES = ["user", "assistant", "system"] as const;
export type CalendarNoteSource = (typeof CALENDAR_NOTE_SOURCES)[number];
export const CALENDAR_NOTE_MAX = 4000;

export const calendarEventNotes = sqliteTable(
  "calendar_event_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    // Snapshot autora (displayName || email); dla asystenta „Asystent (kto zatwierdził)”.
    userLabel: text("user_label"),
    source: text("source", { enum: CALENDAR_NOTE_SOURCES }).default("user").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    deletedAt: text("deleted_at"), // soft delete
  },
  (t) => ({
    eventCreatedIdx: index("calendar_event_notes_event_created_idx").on(t.eventId, t.createdAt),
  })
);

export type CalendarEventNote = typeof calendarEventNotes.$inferSelect;
export type NewCalendarEventNote = typeof calendarEventNotes.$inferInsert;

/**
 * Zapisane zestawy filtrów kalendarza (per użytkownik). `filters` to JSON z tymi
 * samymi kluczami, co localStorage `alfa.calendar.filters` (+ opcjonalnie view/weekends).
 */
export const calendarFilterSets = sqliteTable(
  "calendar_filter_sets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: text("filters").notNull(), // JSON (string)
    isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    userNameUidx: uniqueIndex("calendar_filter_sets_user_name_uidx").on(t.userId, t.name),
    userSortIdx: index("calendar_filter_sets_user_sort_idx").on(t.userId, t.sortOrder),
  })
);

export type CalendarFilterSet = typeof calendarFilterSets.$inferSelect;
export type NewCalendarFilterSet = typeof calendarFilterSets.$inferInsert;

// ============================================================================
// ACTIVITY LOG — generyczny dziennik zmian dla całej aplikacji
// (kalendarz jest pierwszym konsumentem; w przyszłości magazyn itd.)
// ============================================================================

export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "deleted",
  "restored",
  "moved",
  "assigned",
  "unassigned",
  "status_changed",
  "note_added",
  "note_updated",
  "note_deleted",
  // Powiązanie encji (wydarzenie kalendarza ↔ realizacja tworzona automatycznie)
  "linked",
  "unlinked",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(), // "calendar_event", ...
    entityId: integer("entity_id").notNull(),
    // Denormalizacja: historia obiektu jednym zapytaniem.
    objectId: integer("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot nazwy/emaila użytkownika — odporny na usunięcie konta.
    userLabel: text("user_label"),
    action: text("action", { enum: ACTIVITY_ACTIONS }).notNull(),
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    summary: text("summary"), // czytelny opis PL
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    entityIdx: index("activity_log_entity_idx").on(t.entityType, t.entityId),
    objectIdIdx: index("activity_log_object_id_idx").on(t.objectId),
    createdAtIdx: index("activity_log_created_at_idx").on(t.createdAt),
  })
);

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;

// ============================================================================
// ASYSTENT AI (kalendarz) — czaty adminów z botem planującym wydarzenia.
// Wiadomości trzymają UIMessage.parts (JSON) — tool-calle i karty propozycji
// przeżywają reload; content to tekstowy fallback (wyszukiwanie / podgląd).
// ============================================================================

export const assistantChats = sqliteTable("assistant_chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").default("Nowy czat").notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type AssistantChat = typeof assistantChats.$inferSelect;
export type NewAssistantChat = typeof assistantChats.$inferInsert;

export const ASSISTANT_MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type AssistantMessageRole = (typeof ASSISTANT_MESSAGE_ROLES)[number];

export const assistantMessages = sqliteTable(
  "assistant_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    role: text("role", { enum: ASSISTANT_MESSAGE_ROLES }).notNull(),
    content: text("content").default("").notNull(), // tekst fallback
    parts: text("parts", { mode: "json" }), // UIMessage.parts
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    chatCreatedIdx: index("assistant_messages_chat_created_idx").on(t.chatId, t.createdAt),
  })
);

export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;

// Prosty log zużycia tokenów per tura (koszt/monitoring w panelu admina).
export const assistantUsage = sqliteTable("assistant_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").references(() => assistantChats.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").default(0).notNull(),
  completionTokens: integer("completion_tokens").default(0).notNull(),
  reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
  steps: integer("steps").default(0).notNull(),
  toolCalls: integer("tool_calls").default(0).notNull(),
  finishReason: text("finish_reason"),
  ms: integer("ms").default(0).notNull(),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type AssistantUsage = typeof assistantUsage.$inferSelect;
export type NewAssistantUsage = typeof assistantUsage.$inferInsert;

// ============================================================================
// USTAWIENIA APLIKACJI (generyczny key/value; np. konfiguracja Asystenta AI z panelu admina)
// ============================================================================

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;

// ============================================================================
// CACHE GEOKODERA I TRAS (src/lib/geo.ts)
// Każde zapytanie do Nominatim/OSRM idzie przez tę tabelę — aplikacja i testy
// nigdy nie zależą twardo od sieci. TTL 90 dni (GEO_CACHE_TTL_DAYS), klucze:
//   geo:<sha1(zapytanie)>            → { lat, lng, display }
//   route:<lat,lng>|<lat,lng>        → { km, method }
// Wpis o wartości { error } NIE jest zapisywany — brak sieci nie truje cache'u.
// ============================================================================

export const geoCache = sqliteTable("geo_cache", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type GeoCacheRow = typeof geoCache.$inferSelect;
export type NewGeoCacheRow = typeof geoCache.$inferInsert;
