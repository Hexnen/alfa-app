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
 * przepisuje tę kwotę wprost do abonamentu obiektu (src/services/orders.ts).
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
  /**
   * @deprecated Zastąpione rozbiciem na `monthly_zdw` + `monthly_ofi` (migracja
   * 0082 + scripts/migrate-abonament-split.ts). Jeden abonament nie dawał się
   * przypisać do linii usługowej: obiekt z kamerami I wartownikiem wchodził
   * całą kwotą do OBU przekrojów Analityki, więc „ZDV + OFI" wychodziło więcej
   * niż „wszystko". Kolumna ZOSTAJE do czasu, aż nic jej już nie czyta, ale NIE
   * JEST ŹRÓDŁEM PRAWDY — backend liczy `monthlyValue` jako sumę zdw + ofi i
   * zapisuje wyłącznie te dwa pola. Nie dopisuj tu nowych zapisów.
   */
  monthlyValue: real("monthly_value"),
  /**
   * Abonament za ZDALNY DOZÓR WIZYJNY w zł NETTO/mies. — kamery, SSWiN,
   * wideorecepcja, czyli wszystko, co obsługuje centrum monitorowania.
   * NULL = nieuzupełniony, i to NIE to samo, co 0 zł (obiekt bez tej usługi
   * po prostu nie ma tu kwoty; zero znaczyłoby „robimy to za darmo").
   */
  monthlyZdw: real("monthly_zdw"),
  /**
   * Abonament za OCHRONĘ FIZYCZNĄ w zł NETTO/mies. — ludzie stojący na obiekcie.
   * NULL = nieuzupełniony (patrz `monthly_zdw`).
   */
  monthlyOfi: real("monthly_ofi"),
  /**
   * Dzierżawa sprzętu w zł NETTO/mies. — trzecia część tego, co klient płaci co
   * miesiąc, przepisywana ze zlecenia (`orders.rental_amount`).
   *
   * OSOBNA KOLUMNA, a nie doliczenie do abonamentu, żeby dało się odróżnić
   * opłatę za usługę od najmu sprzętu; Analityka sumuje wszystkie pozycje
   * (`revenue = monthly_zdw + monthly_ofi + monthly_rental`). Dzierżawiony
   * sprzęt to sprzęt monitoringu, więc w przekroju usługowym dzierżawa liczy
   * się do linii ZDV. Do wersji z sierpnia 2026 kwota dzierżawy w ogóle nie
   * docierała do obiektu i przychód takich obiektów był zaniżony — dlatego dla
   * danych sprzed migracji ta kolumna jest NULL, a nie 0: nie ma z czego jej
   * odtworzyć.
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
  /**
   * PRZEWIDYWANE ZAKOŃCZENIE OBSŁUGI CAŁEGO OBIEKTU (YYYY-MM-DD).
   *
   * To PLAN biznesowy, a nie fakt: niezależny od końców pojedynczych okresów
   * usług (`object_services.end_date`). Obiekt może mieć kamery bezterminowo,
   * a mimo to datę „do kiedy w ogóle go obsługujemy" — i odwrotnie.
   * NULL = bezterminowo.
   */
  expectedEndDate: text("expected_end_date"),
  /**
   * Link do pinezki w Google Maps. Walidowany po HOŚCIE (src/lib/maps-url.ts —
   * tylko domeny Google), bo trafia prosto do klikalnego linku w karcie obiektu;
   * dowolny adres w tym polu byłby przekierowaniem z zaufanego UI.
   */
  mapsUrl: text("maps_url"),
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

/**
 * OKRESY ŚWIADCZENIA USŁUG NA OBIEKCIE — źródło prawdy dla `objects.has_*`.
 *
 * Flagi na obiekcie odpowiadają na pytanie „czy DZIŚ", a kartoteka musi też
 * odpowiadać na „od kiedy" i „czy jeszcze". Ta sama usługa potrafi wystąpić na
 * obiekcie wielokrotnie (kamery 2020–2022, przerwa, znów od 2024) — jeden wiersz
 * na usługę tego nie zapisze, dlatego to osobna tabela, a flagi zostają jako
 * CACHE przeliczany z okresów aktywnych (src/lib/object-services.ts).
 *
 * AKTYWNY okres = `end_date IS NULL OR end_date >= dziś`. Start w przyszłości
 * NADAL liczy się do flag („zaplanowana") — literówka w roku nie może wyrzucić
 * obiektu z analityki; UI pokazuje to badge'em.
 */
export const objectServices = sqliteTable(
  "object_services",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    service: text("service", {
      enum: ["kamery", "sswin", "wideorecepcja", "ofi"],
    }).notNull(),
    /** YYYY-MM-DD — wymagana. Usługa bez daty startu nie jest okresem. */
    startDate: text("start_date").notNull(),
    /** YYYY-MM-DD albo NULL = trwa bezterminowo. */
    endDate: text("end_date"),
    /**
     * 1 = data startu NIEZNANA, wstawiona z daty założenia kartoteki przy
     * backfillu migracji 0084 (obiekt bez umowy z datą i bez `monitoring_start`
     * w rejestrze CMA). Taki wiersz NIE liczy się jako „rozpoczęcie" w seriach
     * czasowych analityki — inaczej dzień importu kartoteki wygląda na miesiąc,
     * w którym firma pozyskała 147 usług naraz. Usługa nadal jest AKTYWNA:
     * wchodzi do flag, przychodu i mianowników, bo ona istnieje — nie wiemy
     * tylko OD KIEDY. UI dopisuje przy takiej dacie „data szacowana".
     *
     * Wpisanie daty startu w formularzu gasi flagę: skoro ktoś ją wpisał, to ją zna.
     */
    startEstimated: integer("start_estimated", { mode: "boolean" })
      .default(false)
      .notNull(),
    /**
     * Liczba kamer w TYM okresie (tylko `service = 'kamery'`). NULL = „usługa
     * jest, ale nikt kamer nie policzył" — to NIE jest zero (zero wyrzuciłoby
     * obiekt z wagi kosztu centrum monitorowania, udając wiedzę, której nie ma).
     */
    cameraCount: integer("camera_count"),
    notes: text("notes"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    objectIdIdx: index("object_services_object_id_idx").on(t.objectId),
    objectServiceIdx: index("object_services_object_service_idx").on(
      t.objectId,
      t.service
    ),
  })
);

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
  /**
   * Draft (dokument DOCX), z którego powstał ten wpis — nadaje go akcja
   * „Przenieś do rejestru” w panelu draftów. Umowy wpisane ręcznie mają tu
   * NULL i nie pokazują dokumentu. ON DELETE SET NULL: skasowanie dokumentu
   * nie usuwa faktu handlowego z rejestru.
   *
   * Bez `.references()` w drizzle, bo `contractDrafts` deklarujemy dopiero na
   * końcu pliku; klucz obcy zakłada migracja 0092 i pilnuje go SQLite
   * (`foreign_keys = ON` w src/db/index.ts).
   */
  draftId: integer("draft_id"),
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
  /**
   * OKRESY USŁUG zakładanego obiektu (`ObjectServiceInput[]` jako JSON).
   *
   * Do wersji z września 2026 flagi `objectHas*` z formularza były polami
   * PRZEJŚCIOWYMI: zużywała je konwersja na obiekt i ginęły — edycja zlecenia,
   * jego szczegóły i mail nie miały już z czego pokazać zakresu. Lista siedzi
   * więc NA ZLECENIU, niezależnie od kartoteki obiektu (edycja zlecenia z
   * założenia nie zmienia obiektu).
   */
  objectServices: text("object_services", { mode: "json" }),

  /**
   * Szansa sprzedaży, z której zlecenie powstało. Kierunek jest JEDNOSTRONNY:
   * szansa → zlecenie. Formularz publiczny nigdy tego pola nie ustawia.
   */
  leadId: integer("lead_id").references((): AnySQLiteColumn => leads.id, {
    onDelete: "set null",
  }),
  /** Handlowiec prowadzący zlecenie (domyślnie właściciel szansy). */
  salespersonId: integer("salesperson_id").references((): AnySQLiteColumn => salespeople.id, {
    onDelete: "set null",
  }),

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
  // Token wtyczki przeglądarki „Dodaj do towarów Alfa" (Bearer na /api/plugin/*).
  // NULL = użytkownik nigdy nie pobrał paczki. Tworzony przy pierwszym pobraniu
  // ZIP-a (GET /warehouse/plugin/download), rotowany/unieważniany w panelu.
  //
  // Trzymany JAWNIE, nie jako hash — świadomie: paczkę z wtyczką generujemy
  // wielokrotnie (drugi komputer, ponowne pobranie) i za każdym razem trzeba
  // wpisać do niej DZIAŁAJĄCY token; z hashem dałoby się tylko rotować sekret
  // przy każdym pobraniu, czyli psuć wszystkie wcześniej pobrane paczki.
  // Ryzyko ograniczamy ZAKRESEM: token otwiera wyłącznie /api/plugin/*
  // (odczyt kartoteki + wrzucenie propozycji do kolejki), nigdy panelu ani
  // zapisu towaru. Reset hasła (src/lib/auth/users.ts) i rotacja unieważniają
  // go natychmiast. Dokładnie tak samo jest z `calendarToken` powyżej.
  pluginToken: text("plugin_token").unique(),
  /** Kiedy wydano bieżący token wtyczki — panel pokazuje wiek paczki. */
  pluginTokenCreatedAt: text("plugin_token_created_at"),
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
export const salespeople = sqliteTable(
  "salespeople",
  {
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
    /**
     * Konto w aplikacji. Po TYM polu (i wyłącznie po nim — bez heurystyki nazwiskowej,
     * jaką ma `findTechnicianForUser`) rozpoznajemy „Moje" w module handlowym: `/api/auth/me`
     * oddaje `salespersonId`, a filtr `salespersonId=me` bez dopasowania zwraca pustkę.
     * Jeden użytkownik = najwyżej jeden handlowiec (unikalny indeks częściowy).
     */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    active: integer("active", { mode: "boolean" }).default(true).notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    userIdUidx: uniqueIndex("salespeople_user_id_uidx")
      .on(t.userId)
      .where(sql`user_id IS NOT NULL`),
  })
);

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
  /*
   * DANE DO UMÓW (moduł „Drafty umów”, src/routes/contract-drafts.ts).
   *
   * Osobne kolumny, a nie recykling istniejących, bo dokument potrzebuje form,
   * których w kartotece MF nie ma: `full_name` z wykazu VAT przychodzi
   * WERSALIKAMI („ALFA GROUP SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ”), a treść
   * umowy wymaga zapisu z małych liter, reprezentant musi stać w dopełniaczu
   * („reprezentowaną przez: Sławomira Jaworskiego”), a kapitał zakładowy nie jest
   * w wykazie w ogóle. NULL = nieuzupełnione i to NIE to samo, co pusty napis —
   * bez `contract_code` moduł draftów odmawia nadania numeru.
   */
  /** Kod spółki w numerze umowy (`12/ZDW/2026`). NULL = spółka nie numeruje umów. */
  contractCode: text("contract_code"),
  /** Nazwa spółki w treści umowy, np. „Alfa Group Sp. z o.o.”. */
  contractName: text("contract_name"),
  /** Reprezentant w DOPEŁNIACZU, np. „Sławomira Jaworskiego - Prezesa Zarządu”. */
  representativeLine: text("representative_line"),
  /** Kapitał zakładowy jako gotowy napis, np. „50 000,00 zł”. */
  shareCapital: text("share_capital"),
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
},
(t) => ({
  /**
   * Jeden wiersz na (osoba, rok, miesiąc, SPÓŁKA). Spółka w kluczu świadomie:
   * osoba z etatem w dwóch spółkach ma dwa legalne wiersze na miesiąc (na
   * produkcji: ALFA ETAT + CONTROL ETAT tej samej osoby). Bez indeksu `POST /office`
   * dwa razy dawał dwa wiersze i podsumowanie miesiąca liczyło pensję podwójnie
   * — router robi upsert, a UNIQUE pilnuje wyścigu dwóch kart.
   */
  employeeMonthCompanyUidx: uniqueIndex("hr_office_payroll_employee_month_company_uidx").on(
    t.employeeId,
    t.year,
    t.month,
    t.company,
  ),
}));

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
  /**
   * Symbol producenta (MPN — np. „TC-C320N Spec:AK/I3/E/Y/C/2.8mm/V2.0”).
   *
   * Świadomie osobne pole obok `sku` i `barcode`: `sku` to NASZ kod z etykiety,
   * a każdy sklep ma jeszcze SWÓJ własny indeks (patrz `warehouse_item_sources.
   * supplier_code`) — jedyne, co jest wspólne dla wszystkich sklepów i dla
   * karty katalogowej, to symbol producenta. Dlatego to on jest kluczem
   * dopasowania przy imporcie strony produktu (EAN bywa nieuzupełniony).
   */
  manufacturerCode: text("manufacturer_code"),
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

/**
 * Źródła towaru = sklepy dostawców, w których ten sam towar da się kupić.
 *
 * Osobna tabela, a nie kolumny w kartotece, bo ten sam sprzęt kupujemy w kilku
 * miejscach (SAMAL, Janex, Eltrox, Grodno) i każde z nich ma WŁASNY indeks,
 * własny adres strony i własną cenę. Wiersz jest jednocześnie „skąd to brać”
 * i „ile to kosztowało, gdy ostatnio patrzyliśmy” — dzięki temu import strony
 * produktu jest ODŚWIEŻENIEM znanego źródła, a nie zakładaniem duplikatu.
 *
 * `raw_json` trzyma surowy zrzut z parsera (do diagnostyki „skąd ta cena”);
 * celowo BEZ etykiety konta — zapisana strona bywa zalogowana na osobę i login
 * nie ma po co siedzieć w bazie kartoteki.
 */
export const warehouseItemSources = sqliteTable(
  "warehouse_item_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => warehouseItems.id, { onDelete: "cascade" }),
    /** Domena sklepu bez `www.` — klucz tożsamości źródła (np. „samal.pl”). */
    shop: text("shop").notNull(),
    /** Nazwa do pokazania („SAMAL”, „Janex International”) — snapshot, nie słownik. */
    shopLabel: text("shop_label"),
    productUrl: text("product_url"),
    /** Indeks towaru U DOSTAWCY (to, co pada w rozmowie i w zamówieniu). */
    supplierCode: text("supplier_code"),
    /** Techniczny identyfikator produktu w sklepie (id z formularza koszyka). */
    supplierProductId: text("supplier_product_id"),
    lastPriceNet: real("last_price_net"),
    lastPriceGross: real("last_price_gross"),
    vatRate: real("vat_rate"),
    currency: text("currency").default("PLN").notNull(),
    lastStock: real("last_stock"),
    /**
     * Czy strona, z której wzięliśmy dane, była zapisana PO ZALOGOWANIU.
     * Bez tego nie da się odróżnić naszej ceny hurtowej od ceny detalicznej
     * z witryny — a różnica bywa kilkukrotna.
     */
    loggedIn: integer("logged_in", { mode: "boolean" }).default(false).notNull(),
    rawJson: text("raw_json"),
    /** Kiedy dane pochodzą z faktycznego odczytu strony (nie kiedy zapisano wiersz). */
    fetchedAt: text("fetched_at"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    itemIdx: index("warehouse_item_sources_item_idx").on(t.itemId),
    /**
     * Jeden wiersz na (towar, sklep). To ta reguła czyni import IDEMPOTENTNYM:
     * wrzucenie tej samej strony po tygodniu odświeża cenę i stan, a nie dokłada
     * drugiego wiersza „samal.pl” obok pierwszego.
     */
    itemShopUidx: uniqueIndex("warehouse_item_sources_item_shop_uidx").on(t.itemId, t.shop),
    /** Wyszukiwanie „co to za towar” po kodzie u dostawcy (dopasowanie przy imporcie). */
    shopCodeIdx: index("warehouse_item_sources_shop_code_idx").on(t.shop, t.supplierCode),
  })
);

export type WarehouseItemSource = typeof warehouseItemSources.$inferSelect;
export type NewWarehouseItemSource = typeof warehouseItemSources.$inferInsert;

/**
 * Kolejka importów z wtyczki przeglądarki („Dodaj do towarów Alfa").
 *
 * KAŻDY klik w sklepie kończy się wierszem tutaj — także ten w trybie „open"
 * („otwórz teraz"). Bez tego kliknięcie przy zamkniętej karcie Magazynu
 * przepadałoby bez śladu, a wtyczka musiałaby trzymać stan po swojej stronie.
 * „Otwórz teraz" to tylko SYGNAŁ dla karty aplikacji; danymi jest ten wiersz.
 *
 * Wiersz jest PROPOZYCJĄ do przejrzenia przez człowieka, nie zapisem kartoteki:
 * `parsedJson` niesie dokładnie ten kształt, który zwraca
 * `POST /warehouse/import/parse` (parsed + suggestedItem + suggestedSource +
 * matches), więc formularz towaru dostaje z kolejki to samo, co przy imporcie
 * z pliku — jedna ścieżka wypełniania, jeden zestaw pól do pominięcia.
 *
 * Czego tu NIE MA: surowego HTML strony (kilka MB na wiersz, po sparsowaniu
 * zbędny) i `accountLabel` z parsera (e-mail konta w sklepie — dana osobowa
 * niepotrzebna do odświeżania ceny; wycinana przed zapisem).
 */
export const warehouseImportInbox = sqliteTable(
  "warehouse_import_inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * queued — czeka w panelu; opened — formularz towaru został z niego
     * otwarty (ale nie zapisany); done — towar zapisany; discarded — człowiek
     * odrzucił propozycję. `done`/`discarded` zostają w tabeli do wygaśnięcia:
     * inaczej „Odrzuć" i ponowny klik w sklepie mnożyłyby ten sam wiersz.
     */
    status: text("status", { enum: ["queued", "opened", "done", "discarded"] })
      .default("queued")
      .notNull(),
    /** Czym był klik: „open" = przełącz mnie na Magazyn, „queue" = zostaw w sklepie. */
    mode: text("mode", { enum: ["open", "queue"] }).default("open").notNull(),
    /** Domena sklepu bez `www.` — ten sam klucz co `warehouse_item_sources.shop`. */
    shop: text("shop"),
    shopLabel: text("shop_label"),
    /** Adres produktu w postaci surowej (do porównań normalizowany w kodzie). */
    productUrl: text("product_url"),
    /** `document.title` karty — jedyny ślad tego, co widział użytkownik. */
    pageTitle: text("page_title"),
    /** Nazwa i cena na wierzchu, żeby lista kolejki nie parsowała JSON-a. */
    name: text("name"),
    priceNet: real("price_net"),
    /** Odpowiedź serwisu parsowania (bez `accountLabel`) — źródło dla formularza. */
    parsedJson: text("parsed_json").notNull(),
    /** Miniatura produktu jako data-URL (≤1 MB, ten sam limit co kartoteka). */
    photoData: text("photo_data"),
    photoWarning: text("photo_warning"),
    matchCount: integer("match_count").default(0).notNull(),
    /**
     * Towar, do którego wiersz najpewniej należy (pierwsze dopasowanie po
     * źródle). Świadomie BEZ klucza obcego: usunięcie towaru nie ma kasować
     * propozycji z kolejki, a panel i tak sprawdza, czy id nadal istnieje.
     */
    matchItemId: integer("match_item_id"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    openedAt: text("opened_at"),
    /**
     * +7 dni od wrzucenia. Kolejka bez terminu rośnie bez końca — porzucone
     * „dodam później" zostawałoby w panelu na zawsze. Czyszczona leniwie przy
     * każdym imporcie z wtyczki (bez crona).
     */
    expiresAt: text("expires_at").notNull(),
  },
  (t) => ({
    /** Lista kolejki: „moje wiersze w statusie X, najnowsze pierwsze". */
    userStatusIdx: index("warehouse_import_inbox_user_status_idx").on(
      t.userId,
      t.status,
      t.createdAt
    ),
    /** Dedup: „czy ten sam produkt już u mnie czeka?" przy każdym imporcie. */
    userUrlIdx: index("warehouse_import_inbox_user_url_idx").on(t.userId, t.productUrl),
  })
);

export type WarehouseImportInbox = typeof warehouseImportInbox.$inferSelect;
export type NewWarehouseImportInbox = typeof warehouseImportInbox.$inferInsert;

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

    /** Szansa sprzedaży, z której powstała oferta (NULL = oferta bez lejka). */
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),

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
    leadIdIdx: index("offers_lead_id_idx").on(t.leadId),
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
// MODUŁ HANDLOWY — szanse sprzedaży (leads) i osoby kontaktowe (contacts)
//
// Lejek: nowy → kontakt → wizja → oferta → negocjacje → wygrany/przegrany.
// Zasada „activity-based selling": każda OTWARTA szansa ma zaplanowaną następną
// aktywność (wydarzenie kalendarza z `department='handlowy'` i `lead_id`); brak
// takiej aktywności albo cisza dłuższa niż SALES_ROT_DAYS = szansa „gnijąca"
// (src/lib/sales-leads.ts).
// ============================================================================

export const LEAD_STAGES = ["nowy", "kontakt", "wizja", "oferta", "negocjacje", "wygrany", "przegrany"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Etapy OTWARTE — tylko one wchodzą do lejka, prognozy i liczenia „gnicia". */
export const LEAD_OPEN_STAGES = LEAD_STAGES.slice(0, 5) as readonly LeadStage[];

export const LEAD_SOURCES = ["polecenie", "www", "formularz", "telefon", "targi", "inne"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Usługi rozważane w szansie; mapują się 1:1 na usługi obiektu (`ochrona` → OFI). */
export const LEAD_SERVICES = ["kamery", "sswin", "wideorecepcja", "ofi", "ochrona"] as const;
export type LeadService = (typeof LEAD_SERVICES)[number];

export const LEAD_LOST_REASONS = ["cena", "konkurencja", "brak_decyzji", "brak_potrzeby", "brak_kontaktu", "inne"] as const;
export type LeadLostReason = (typeof LEAD_LOST_REASONS)[number];

/**
 * Szansa sprzedaży. Klient bywa DWOJAKI: albo wskazany kontrahent z kartoteki
 * (`contractor_id`), albo jeszcze nieistniejący prospekt (`prospect_*`) — kartoteka
 * powstaje dopiero przy konwersji na wygraną, żeby lejek nie zaśmiecał bazy klientami,
 * którzy nigdy nic nie podpisali.
 */
export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    stage: text("stage", { enum: LEAD_STAGES }).default("nowy").notNull(),
    source: text("source", { enum: LEAD_SOURCES }),
    /** Klient z kartoteki (NULL = prospekt, patrz `prospect_*`). */
    contractorId: integer("contractor_id").references(() => contractors.id, { onDelete: "set null" }),
    prospectName: text("prospect_name"),
    prospectNip: text("prospect_nip"),
    prospectPhone: text("prospect_phone"),
    prospectEmail: text("prospect_email"),
    /** Rodzaj obiektu — te same wartości, co OBJECT_KINDS w formularzu zlecenia. */
    objectKind: text("object_kind"),
    address: text("address"),
    city: text("city"),
    mapsUrl: text("maps_url"),
    lat: real("lat"),
    lng: real("lng"),
    /** `LeadService[]` jako JSON — zakres rozważanych usług. */
    services: text("services", { mode: "json" }),
    /** MRR: abonament w zł NETTO za miesiąc (jak wszystkie kwoty handlowe w bazie). */
    estimatedMonthly: real("estimated_monthly"),
    /** Jednorazowe wdrożenie w zł NETTO. */
    estimatedSetup: real("estimated_setup"),
    /** Szansa powodzenia 0–100 (%) — do lejka ważonego. */
    probability: integer("probability"),
    expectedCloseDate: text("expected_close_date"), // YYYY-MM-DD
    salespersonId: integer("salesperson_id").references(() => salespeople.id, { onDelete: "set null" }),
    /** Obiekt założony przy konwersji (NULL = jeszcze nie skonwertowana). */
    objectId: integer("object_id").references(() => objects.id, { onDelete: "set null" }),
    /** Zlecenie utworzone z szansy (kierunek jest jednostronny: szansa → zlecenie). */
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    wonAt: text("won_at"),
    lostAt: text("lost_at"),
    lostReason: text("lost_reason", { enum: LEAD_LOST_REASONS }),
    lostNote: text("lost_note"),
    /**
     * DENORMALIZACJA: moment ostatniego ruchu na szansie (mutacja kalendarza z `lead_id`,
     * notatka, zmiana etapu, edycja). Ustawiana wyłącznie przez `touchLead`
     * (src/lib/sales-leads.ts); `recomputeLastActivity` odtwarza ją do asercji w testach.
     */
    lastActivityAt: text("last_activity_at"),
    notes: text("notes"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    deletedAt: text("deleted_at"), // soft delete
  },
  (t) => ({
    stageIdx: index("leads_stage_idx").on(t.stage),
    salespersonStageIdx: index("leads_salesperson_stage_idx").on(t.salespersonId, t.stage),
    contractorIdIdx: index("leads_contractor_id_idx").on(t.contractorId),
    objectIdIdx: index("leads_object_id_idx").on(t.objectId),
    deletedAtIdx: index("leads_deleted_at_idx").on(t.deletedAt),
    lastActivityAtIdx: index("leads_last_activity_at_idx").on(t.lastActivityAt),
    expectedCloseDateIdx: index("leads_expected_close_date_idx").on(t.expectedCloseDate),
  })
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

/**
 * Osoba kontaktowa — pełnoprawna encja, w odróżnieniu od jednego pola
 * `contractors.contact_person` (które zostaje; migracji danych w v1 nie ma).
 * Kontakt wisi przy kontrahencie, szansie albo obiekcie — router wymaga nazwiska
 * i co najmniej jednego powiązania.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contractorId: integer("contractor_id").references(() => contractors.id, { onDelete: "cascade" }),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
    objectId: integer("object_id").references(() => objects.id, { onDelete: "set null" }),
    firstName: text("first_name").default("").notNull(),
    lastName: text("last_name").default("").notNull(),
    /** Stanowisko / rola („kierownik obiektu", „księgowość") — czysty opis. */
    role: text("role"),
    phone: text("phone"),
    email: text("email"),
    /** Kontakt główny kontrahenta — jeden na kontrahenta (unikalny indeks częściowy). */
    isPrimary: integer("is_primary", { mode: "boolean" }).default(false).notNull(),
    notes: text("notes"),
    active: integer("active", { mode: "boolean" }).default(true).notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    contractorIdIdx: index("contacts_contractor_id_idx").on(t.contractorId),
    leadIdIdx: index("contacts_lead_id_idx").on(t.leadId),
    objectIdIdx: index("contacts_object_id_idx").on(t.objectId),
    nameIdx: index("contacts_name_idx").on(t.lastName, t.firstName),
    primaryUidx: uniqueIndex("contacts_primary_uidx")
      .on(t.contractorId)
      .where(sql`is_primary = 1 AND contractor_id IS NOT NULL`),
  })
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;

// ============================================================================
// KALENDARZ — wydarzenia, serie cykliczne, przypisani technicy i handlowcy.
// Jeden silnik dla dwóch działów: `calendar_events.department` decyduje, czyj
// jest wiersz (technical | handlowy) i kto go widzi (src/lib/calendar-scope.ts).
// ============================================================================

/** Działy korzystające z kalendarza. Wartość siedzi w `calendar_events.department`. */
export const CALENDAR_DEPARTMENTS = ["technical", "handlowy"] as const;
export type CalendarDepartment = (typeof CALENDAR_DEPARTMENTS)[number];

export const CALENDAR_EVENT_TYPES = [
  "serwis",
  "montaz",
  "wizja",
  "demontaz",
  "biuro",
  "przygotowanie",
  "konserwacja",
  "urlop",
  // Kafelek WSKAZUJĄCY istniejącą notatkę (calendar_event_notes) — nie da się go stworzyć
  // „z niczego”: albo ręcznie z gotowej notatki, albo automatycznie ze wzmianki daty w jej
  // treści (@piątek, @15.09 — src/lib/note-mentions.ts). Zawsze całodniowy, bez techników,
  // bez serii, bez realizacji/protokołu/wyceny.
  "notatka",
  // --- Typy działu handlowego (dopisane NA KOŃCU: kolejność jest kontraktem UI) ---
  "spotkanie",
  "telefon",
  "email",
  "zadanie",
  "prezentacja",
  "termin",
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

/**
 * Typy dozwolone w danym dziale. `wizja` jest WSPÓLNA (ten sam byt — oględziny obiektu),
 * `urlop` i `notatka` też działają w obu działach; przekazanie wizji technikom robi się
 * nowym wydarzeniem, bo zmiana działu jest zabroniona (src/lib/calendar-mutations.ts).
 */
export const DEPARTMENT_EVENT_TYPES: Record<CalendarDepartment, readonly CalendarEventType[]> = {
  technical: ["serwis", "montaz", "wizja", "demontaz", "biuro", "przygotowanie", "konserwacja", "urlop", "notatka"],
  handlowy: ["spotkanie", "telefon", "email", "zadanie", "prezentacja", "wizja", "termin", "urlop", "notatka"],
};

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
    /**
     * Czyj jest wiersz: `technical` (serwis/montaż/…) albo `handlowy` (spotkania,
     * telefony, zadania). Działu NIE da się zmienić edycją — przekazanie sprawy
     * drugiemu działowi robi się nowym wydarzeniem (src/lib/calendar-mutations.ts).
     * Widoczność i prawo edycji wiersza: src/lib/calendar-scope.ts.
     */
    department: text("department", { enum: CALENDAR_DEPARTMENTS }).default("technical").notNull(),
    objectId: integer("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    /** Szansa sprzedaży, do której należy aktywność (tylko dział handlowy). */
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** Osoba kontaktowa spotkania/telefonu (tylko dział handlowy). */
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
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
    // Tylko dla type = "notatka": notatka, na którą wskazuje kafelek. Twarde usunięcie notatki
    // (kaskada po wydarzeniu źródłowym) zostawia osierocony kafelek z NULL — sprząta go
    // soft-delete w src/lib/calendar-mutations.ts.
    // `AnySQLiteColumn` przerywa cykl wnioskowania typów: calendar_event_notes wskazuje
    // z powrotem na calendar_events (event_id).
    noteId: integer("note_id").references((): AnySQLiteColumn => calendarEventNotes.id, {
      onDelete: "set null",
    }),
    // Klucz wzmianki (NoteMention.key), z której powstał kafelek — NULL = podpięty ręcznie.
    // Synchronizacja wzmianek dotyka wyłącznie kafelków z niepustym note_mention.
    noteMention: text("note_mention"),
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
    noteIdIdx: index("calendar_events_note_id_idx").on(t.noteId),
    leadIdIdx: index("calendar_events_lead_id_idx").on(t.leadId),
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

/**
 * Przypisanie handlowców do wydarzenia (N:M) — RÓWNOLEGLE do
 * `calendar_event_assignees`, a nie polimorficznie. Osobna tabela zamiast jednej
 * z kolumną „rodzaj": klucze obce zostają prawdziwymi kluczami obcymi, a zapytania
 * o kolizje i urlopy nie muszą filtrować po dyskryminatorze.
 */
export const calendarEventSalespeople = sqliteTable(
  "calendar_event_salespeople",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    salespersonId: integer("salesperson_id")
      .notNull()
      .references(() => salespeople.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.salespersonId] }),
  })
);

export type CalendarEventSalesperson = typeof calendarEventSalespeople.$inferSelect;
export type NewCalendarEventSalesperson = typeof calendarEventSalespeople.$inferInsert;

// Notatki do wydarzenia — dziennik (wiele wpisów, z autorem i czasem). `description`
// wydarzenia pozostaje stałym opisem; notatki dopisują użytkownicy i asystent (source).
export const CALENDAR_NOTE_SOURCES = ["user", "assistant", "system"] as const;
/**
 * Rodzaj notatki: zwykły wpis dziennika albo MAIL z Outlooka (upuszczony na
 * kalendarz — src/lib/outlook-msg.ts). Mail ma własny nagłówek w polach `mail*`,
 * a w `text` SAMĄ treść — dzięki temu UI składa kartę maila, zamiast pokazywać
 * sklejony tekst. Migracja 0094.
 */
export const CALENDAR_NOTE_KINDS = ["text", "email"] as const;
export type CalendarNoteKind = (typeof CALENDAR_NOTE_KINDS)[number];
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
    /** "text" = zwykły wpis; "email" = mail z Outlooka (pola mail* niżej). */
    kind: text("kind", { enum: CALENDAR_NOTE_KINDS }).default("text").notNull(),
    /** Treść wpisu; dla maila SAMO body, bez nagłówka. */
    text: text("text").notNull(),
    mailSubject: text("mail_subject"),
    /** Nadawca w formie „Jan Kowalski <jan@x.pl>". */
    mailFrom: text("mail_from"),
    /** Odbiorcy jako tablica JSON stringów (snapshot z maila, nie kartoteka). */
    mailTo: text("mail_to"),
    /** Kopia (DW) jako tablica JSON stringów. */
    mailCc: text("mail_cc"),
    /** Data wysłania w ISO 8601 (albo NULL, gdy mail jej nie niósł). */
    mailSentAt: text("mail_sent_at"),
    /**
     * NAZWY załączników maila jako tablica JSON stringów (migracja 0096). Snapshot
     * wiersza „Załączniki:” z Outlooka — także tych, których nie dało się wypakować
     * (za duże, nieobsługiwany typ); UI pokazuje je wtedy jako szare chipy.
     */
    mailAttachments: text("mail_attachments"),
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
 * Notatki KARTOTEKI OBIEKTU — dziennik przy obiekcie, niezależny od kalendarza.
 * Ta sama konwencja co `calendar_event_notes` (autor + snapshot etykiety, soft
 * delete, limit CALENDAR_NOTE_MAX), ale wiszą przy obiekcie, a nie przy dacie.
 *
 * `source_event_id` / `source_note_id` są niepuste, gdy notatka POWSTAŁA jako
 * kopia notatki wydarzenia („Zapisz też w obiekcie"). Kopia jest samodzielnym
 * wierszem — edycja oryginału w kalendarzu jej nie zmienia (i odwrotnie); łącze
 * służy wyłącznie do pokazania źródła i do IDEMPOTENCJI kopiowania: partial
 * unique index pilnuje, że jedna notatka kalendarza ma najwyżej JEDNĄ żywą
 * kopię. Soft delete kopii zwalnia miejsce — można skopiować ponownie.
 */
export const objectNotes = sqliteTable(
  "object_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Snapshot autora (displayName || email) — odporny na usunięcie konta. */
    userLabel: text("user_label"),
    text: text("text").notNull(),
    /** Wydarzenie, z którego notatkę skopiowano (NULL = notatka napisana wprost w kartotece). */
    sourceEventId: integer("source_event_id").references((): AnySQLiteColumn => calendarEvents.id, {
      onDelete: "set null",
    }),
    /** Notatka kalendarza, z której to kopia (partial UNIQUE — jedna żywa kopia). */
    sourceNoteId: integer("source_note_id").references((): AnySQLiteColumn => calendarEventNotes.id, {
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
    objectCreatedIdx: index("object_notes_object_created_idx").on(t.objectId, t.createdAt),
    sourceNoteUidx: uniqueIndex("object_notes_source_note_uidx")
      .on(t.sourceNoteId)
      .where(sql`source_note_id IS NOT NULL AND deleted_at IS NULL`),
  })
);

export type ObjectNote = typeof objectNotes.$inferSelect;
export type NewObjectNote = typeof objectNotes.$inferInsert;

/**
 * Załączniki do notatek wydarzeń — pliki leżą na dysku (data/attachments/<eventId>/<uuid>.<ext>,
 * patrz src/lib/calendar-attachments.ts), w bazie tylko metadane. Obrazki są ZAWSZE
 * konwertowane do WebP (sharp), stąd `width`/`height` tylko dla kind = "image".
 */
export const CALENDAR_ATTACHMENT_KINDS = ["image", "file"] as const;
export type CalendarAttachmentKind = (typeof CALENDAR_ATTACHMENT_KINDS)[number];

/** Skąd wziął się załącznik notatki: „upload” = wybrany/upuszczony ręcznie, „msg” = wypakowany z maila .msg. */
export const NOTE_ATTACHMENT_ORIGINS = ["upload", "msg"] as const;
export type NoteAttachmentOrigin = (typeof NOTE_ATTACHMENT_ORIGINS)[number];

export const calendarNoteAttachments = sqliteTable(
  "calendar_note_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: integer("note_id")
      .notNull()
      .references(() => calendarEventNotes.id, { onDelete: "cascade" }),
    /** Oryginalna nazwa pliku; dla obrazków rozszerzenie zamienione na .webp. */
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    /** Bajty zapisane na dysku (po konwersji, nie surowy upload). */
    size: integer("size").notNull(),
    /** Ścieżka relatywna wewnątrz katalogu załączników, np. `12/3f0a….webp`. */
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    /** „upload” = plik dodany ręcznie, „msg” = wypakowany z maila .msg (migracja 0096). */
    origin: text("origin", { enum: NOTE_ATTACHMENT_ORIGINS }).default("upload").notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    noteIdx: index("calendar_note_attachments_note_idx").on(t.noteId),
  })
);

export type CalendarNoteAttachment = typeof calendarNoteAttachments.$inferSelect;
export type NewCalendarNoteAttachment = typeof calendarNoteAttachments.$inferInsert;

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
  // Lejek handlowy (entity_type = "lead"): zmiana etapu, zamknięcie i konwersja
  // szansy na kontrahenta + obiekt.
  "stage_changed",
  "won",
  "lost",
  "converted",
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
// DZIENNIK POCZTY WYCHODZĄCEJ (src/services/mail-sender.ts)
// Jeden wiersz na PRÓBĘ wysyłki — także nieudaną. To nie jest kopia activity_log:
// tam ląduje fakt „człowiek wysłał mail", tutaj techniczne szczegóły (adresaci,
// temat, messageId serwera, treść błędu SMTP), po których da się odpowiedzieć
// klientowi „wysłaliśmy 12.03 o 9:41 na ten adres". Adresatów trzymamy jako
// tekst rozdzielony przecinkami — logu nikt nie joinuje, a lista ma być czytelna
// dokładnie taka, jaka poszła na serwer.
// ============================================================================

export const MAIL_LOG_STATUSES = ["sent", "failed"] as const;
export type MailLogStatus = (typeof MAIL_LOG_STATUSES)[number];

export const mailLog = sqliteTable(
  "mail_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // "order" — dziś jedyny konsument; kolumna jest tekstem, żeby kolejne moduły
    // (oferty, protokoły) dopisywały się bez migracji.
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    // "client" | "internal" | "test" — który szablon poszedł.
    variant: text("variant"),
    toAddr: text("to_addr").notNull(),
    ccAddr: text("cc_addr"),
    bccAddr: text("bcc_addr"),
    subject: text("subject").notNull(),
    status: text("status", { enum: MAIL_LOG_STATUSES }).notNull(),
    error: text("error"),
    messageId: text("message_id"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    // Snapshot nazwy/emaila — odporny na usunięcie konta (jak w activity_log).
    userLabel: text("user_label"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    entityIdx: index("mail_log_entity_idx").on(t.entityType, t.entityId),
  })
);

export type MailLogEntry = typeof mailLog.$inferSelect;
export type NewMailLogEntry = typeof mailLog.$inferInsert;

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

// ============================================================================
// MODUŁ MANUALE (Techniczny → /technical/manuale)
// Biblioteka instrukcji i dokumentacji sprzętu oraz usług: tytuł, opis,
// załączniki (pliki na dysku jak w notatkach kalendarza — src/lib/calendar-attachments.ts)
// i powiązania z kartoteką magazynu (warehouse_items) oraz katalogiem usług (services).
// Trasy: src/routes/manuals.ts.
// ============================================================================

export const manuals = sqliteTable("manuals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  /** Kto założył manual — login (email), jak `offers.created_by`. */
  createdBy: text("created_by"),
  /** Kto ostatni zapisał manual — login (email). */
  updatedBy: text("updated_by"),
  createdAt: text("created_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type Manual = typeof manuals.$inferSelect;
export type NewManual = typeof manuals.$inferInsert;

/**
 * Punkty i podpunkty manuala — treść uporządkowana jak w instrukcji („1.", „1.1").
 * Maksymalnie dwa poziomy: punkt ma `parentId` = NULL, podpunkt wskazuje na punkt
 * (głębszego zagnieżdżenia pilnuje src/routes/manuals.ts, baza sama tego nie ograniczy).
 * Punkt ma opcjonalny tytuł, opcjonalny tekst i 0..n załączników (`manual_attachments.section_id`).
 * `position` = kolejność wśród rodzeństwa (0, 1, 2…), przepisywana przy każdym PUT /:id/sections.
 */
export const manualSections = sqliteTable(
  "manual_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    manualId: integer("manual_id")
      .notNull()
      .references(() => manuals.id, { onDelete: "cascade" }),
    /** NULL = punkt najwyższego poziomu; inaczej id punktu-rodzica (kasowanie kaskadą). */
    parentId: integer("parent_id").references((): AnySQLiteColumn => manualSections.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull().default(0),
    title: text("title"),
    body: text("body"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    manualIdx: index("manual_sections_manual_idx").on(t.manualId),
    parentIdx: index("manual_sections_parent_idx").on(t.parentId),
  })
);

export type ManualSection = typeof manualSections.$inferSelect;
export type NewManualSection = typeof manualSections.$inferInsert;

/**
 * Załączniki manuala — bliźniak `calendar_note_attachments`: pliki leżą na dysku
 * (data/attachments/manuals/<manualId>/<uuid>.<ext>), w bazie tylko metadane.
 * Obrazki są ZAWSZE konwertowane do WebP, stąd `width`/`height` tylko dla kind = "image".
 */
export const manualAttachments = sqliteTable(
  "manual_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    manualId: integer("manual_id")
      .notNull()
      .references(() => manuals.id, { onDelete: "cascade" }),
    /**
     * Punkt, do którego plik należy. NULL = plik „luzem" (stare manuale sprzed
     * punktów albo plik wyrzucony z punktu) — front pokazuje takie jako „Pozostałe pliki".
     * ON DELETE SET NULL: skasowanie punktu NIE kasuje plików.
     */
    sectionId: integer("section_id").references((): AnySQLiteColumn => manualSections.id, {
      onDelete: "set null",
    }),
    /** Kolejność pliku w obrębie punktu (0, 1, 2…); poza punktem bez znaczenia. */
    position: integer("position").notNull().default(0),
    /** Oryginalna nazwa pliku; dla obrazków rozszerzenie zamienione na .webp. */
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    /** Bajty zapisane na dysku (po konwersji, nie surowy upload). */
    size: integer("size").notNull(),
    /** Ścieżka relatywna wewnątrz katalogu załączników, np. `manuals/12/3f0a….webp`. */
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    manualIdx: index("manual_attachments_manual_idx").on(t.manualId),
  })
);

export type ManualAttachment = typeof manualAttachments.$inferSelect;
export type NewManualAttachment = typeof manualAttachments.$inferInsert;

/**
 * Powiązanie manuala z towarem magazynu ALBO usługą — dokładnie jedno z pól jest
 * wypełnione (walidacja w src/routes/manuals.ts; SQLite nie ma CHECK-a w drizzle).
 * Pary UNIQUE pilnują, żeby ten sam towar/usługa nie wpadły do manuala dwa razy
 * (NULL-e w SQLite nie kolidują ze sobą, więc dwa wpisy usługowe są OK).
 */
export const manualLinks = sqliteTable(
  "manual_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    manualId: integer("manual_id")
      .notNull()
      .references(() => manuals.id, { onDelete: "cascade" }),
    warehouseItemId: integer("warehouse_item_id").references(() => warehouseItems.id, {
      onDelete: "cascade",
    }),
    serviceId: integer("service_id").references(() => services.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    manualIdx: index("manual_links_manual_idx").on(t.manualId),
    itemUnique: uniqueIndex("manual_links_manual_item_unique").on(t.manualId, t.warehouseItemId),
    serviceUnique: uniqueIndex("manual_links_manual_service_unique").on(t.manualId, t.serviceId),
  })
);

export type ManualLink = typeof manualLinks.$inferSelect;
export type NewManualLink = typeof manualLinks.$inferInsert;

// ============================================================================
// GRUPY INTERWENCYJNE (CMA → /cma/grupy-interwencyjne)
// Firmy świadczące usługę grupy interwencyjnej (podwykonawcy dojeżdżający na
// alarm), WARUNKI tej usługi per obiekt i REJESTR wykonanych podjazdów.
//
// Trzy tabele główne + trzy tabele załączników (klony `manual_attachments`,
// po jednej na właściciela — dyskryminatora `owner_type` nie da się objąć
// kluczem obcym, a chcemy kaskadę FK zamiast sprzątania w kodzie).
//
// DLACZEGO WIELE WIERSZY WARUNKÓW NA OBIEKT: firmy się zmieniają, a rejestr
// podjazdów sprzed dwóch lat ma się rozliczać stawkami, które wtedy obowiązywały.
// Wiersz warunków to okres (`start_date` … `end_date`), okresy tego samego obiektu
// nie mogą się nakładać (kontrola w src/lib/intervention-terms.ts), a interwencja
// zapisuje `term_id` z dnia zdarzenia. „Zakończenie" współpracy to DATA
// wypowiedzenia, nie kwota.
//
// KWOTY: złote NETTO, `real`. NULL = nieuzupełnione i to NIE to samo, co 0
// (podjazd za 0 zł znaczyłby „jeździmy za darmo"). Rozliczenie liczy się PRZY
// ODCZYCIE (src/lib/intervention-terms.ts), żeby korekta warunków przeliczała
// historię, zamiast zostawiać zamrożone kwoty w wierszach interwencji.
//
// Trasy: src/routes/intervention-groups.ts. Szablony maili: app_settings
// (`interventions.rfq.*`, `interventions.termination.*`) — bez migracji.
// ============================================================================

export const interventionCompanies = sqliteTable(
  "intervention_companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Nazwa firmy. Unikalność case-insensitive pilnuje trasa (SQLite nie ma tu indeksu). */
    name: text("name").notNull(),
    /** Obszar działania („Warszawa i okolice", „woj. mazowieckie"). */
    area: text("area"),
    contactPerson: text("contact_person"),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
    /** Miękkie archiwum — firma z historią warunków nie znika, tylko przestaje być wybieralna. */
    active: integer("active", { mode: "boolean" }).default(true).notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    activeNameIdx: index("intervention_companies_active_name_idx").on(t.active, t.name),
  })
);

export type InterventionCompany = typeof interventionCompanies.$inferSelect;
export type NewInterventionCompany = typeof interventionCompanies.$inferInsert;

/**
 * Warunki usługi grupy interwencyjnej dla obiektu w danym okresie.
 * `end_date` NULL = umowa trwa. Firma ma `onDelete: restrict` — skasowanie firmy
 * z historią warunków musi być świadomym przepięciem, nie efektem ubocznym.
 */
export const interventionTerms = sqliteTable(
  "intervention_terms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => interventionCompanies.id, { onDelete: "restrict" }),
    /** Początek obowiązywania, YYYY-MM-DD. */
    startDate: text("start_date").notNull(),
    /** Koniec obowiązywania (data wypowiedzenia), YYYY-MM-DD. NULL = trwa. */
    endDate: text("end_date"),
    /** Kwota jednego płatnego podjazdu, zł netto. */
    calloutFee: real("callout_fee"),
    /** Abonament miesięczny za gotowość, zł netto. */
    subscriptionFee: real("subscription_fee"),
    /** Ile podjazdów w miesiącu mieści się w abonamencie (0/NULL = żaden). */
    freeCallouts: integer("free_callouts"),
    /** Stawka za godzinę postoju na obiekcie, zł netto. */
    hourlyStandbyFee: real("hourly_standby_fee"),
    notes: text("notes"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    objectIdx: index("intervention_terms_object_idx").on(t.objectId, t.startDate),
    companyIdx: index("intervention_terms_company_idx").on(t.companyId),
  })
);

export type InterventionTerm = typeof interventionTerms.$inferSelect;
export type NewInterventionTerm = typeof interventionTerms.$inferInsert;

/**
 * Pojedynczy podjazd grupy interwencyjnej. `company_id` jest DENORMALIZACJĄ
 * z warunków — rozwiązane raz, przy zapisie, żeby rejestr dało się filtrować
 * po firmie bez joinu i żeby przepięcie obiektu na inną firmę nie przepisywało
 * historii. Kwoty NIE są zapisywane: liczy je odczyt z aktualnych warunków.
 */
export const interventions = sqliteTable(
  "interventions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    termId: integer("term_id")
      .notNull()
      .references(() => interventionTerms.id, { onDelete: "restrict" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => interventionCompanies.id, { onDelete: "restrict" }),
    /** Data i godzina podjazdu, ISO bez sekund: `YYYY-MM-DDTHH:MM`. */
    happenedAt: text("happened_at").notNull(),
    reason: text("reason"),
    /** Kto zgłosił podjazd (operator CMA, klient). */
    reportedBy: text("reported_by"),
    /** Godziny postoju na obiekcie (1.5 = półtorej godziny). NULL = bez postoju/nieuzupełnione. */
    standbyHours: real("standby_hours"),
    notes: text("notes"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    objectIdx: index("interventions_object_idx").on(t.objectId, t.happenedAt),
    termIdx: index("interventions_term_idx").on(t.termId, t.happenedAt),
    companyIdx: index("interventions_company_idx").on(t.companyId),
  })
);

export type Intervention = typeof interventions.$inferSelect;
export type NewIntervention = typeof interventions.$inferInsert;

/**
 * Umowy ramowe firmy interwencyjnej — bliźniak `manual_attachments`
 * (scope katalogu: `interventions/companies/<companyId>`).
 */
export const interventionCompanyAttachments = sqliteTable(
  "intervention_company_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id")
      .notNull()
      .references(() => interventionCompanies.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    companyIdx: index("intervention_company_attachments_company_idx").on(t.companyId),
  })
);

export type InterventionCompanyAttachment = typeof interventionCompanyAttachments.$inferSelect;
export type NewInterventionCompanyAttachment = typeof interventionCompanyAttachments.$inferInsert;

/** Umowa na obiekt przy wierszu warunków (scope: `interventions/terms/<termId>`). */
export const interventionTermAttachments = sqliteTable(
  "intervention_term_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    termId: integer("term_id")
      .notNull()
      .references(() => interventionTerms.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    termIdx: index("intervention_term_attachments_term_idx").on(t.termId),
  })
);

export type InterventionTermAttachment = typeof interventionTermAttachments.$inferSelect;
export type NewInterventionTermAttachment = typeof interventionTermAttachments.$inferInsert;

/** Dokumentacja podjazdu — zdjęcia, notatka z interwencji (scope: `interventions/interventions/<id>`). */
export const interventionAttachments = sqliteTable(
  "intervention_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    interventionId: integer("intervention_id")
      .notNull()
      .references(() => interventions.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    interventionIdx: index("intervention_attachments_intervention_idx").on(t.interventionId),
  })
);

export type InterventionAttachment = typeof interventionAttachments.$inferSelect;
export type NewInterventionAttachment = typeof interventionAttachments.$inferInsert;

// ============================================================================
// DRAFTY UMÓW — generowanie umowy z oryginalnego szablonu Word (moduł „Umowy”,
// panel „Drafty umów”). Tabele stoją NA KOŃCU pliku, bo załączniki draftu są
// klonem `intervention_attachments` i potrzebują CALENDAR_ATTACHMENT_KINDS.
//
// Rejestr `contracts` (numer, daty, wartość) zostaje osobnym bytem: tam jest
// UMOWA JAKO FAKT handlowy, tu — DOKUMENT, który dopiero powstaje. Draft nie
// blokuje kasowania obiektu (kaskada FK), umowa z rejestru blokuje.
// ============================================================================

export const CONTRACT_DRAFT_STATUSES = ["draft", "sent", "signed", "rejected", "archived"] as const;
export type ContractDraftStatus = (typeof CONTRACT_DRAFT_STATUSES)[number];

/** Etykiety PL — front nie trzyma własnego słownika (kontrakt z api.ts). */
export const CONTRACT_DRAFT_STATUS_LABELS: Record<ContractDraftStatus, string> = {
  draft: "Szkic",
  sent: "Wysłana do klienta",
  signed: "Podpisana",
  rejected: "Odrzucona",
  archived: "Archiwalna",
};

export const contractDrafts = sqliteTable(
  "contract_drafts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    objectId: integer("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    /**
     * Kontrahent jest SNAPSHOTEM z chwili założenia draftu (dane i tak siedzą
     * w `fields`), więc usunięcie kartoteki nie kasuje dokumentu — zeruje tylko
     * odsyłacz.
     */
    contractorId: integer("contractor_id").references(() => contractors.id, { onDelete: "set null" }),
    /**
     * Spółka, która NADAŁA NUMER. `restrict`, bo skasowanie spółki rozsypałoby
     * licznik: kolejny draft dostałby seq 1 i wpadł w duplikat numeru z archiwum.
     */
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    /** Klucz szablonu z rejestru (src/lib/contract-templates/registry.ts). */
    templateKey: text("template_key").notNull(),
    /** Pełny numer `seq/KOD/rok` — jedyne miejsce formatu: contract-numbering.ts. */
    contractNumber: text("contract_number").notNull().unique(),
    seq: integer("seq").notNull(),
    year: integer("year").notNull(),
    /** Data zawarcia ("YYYY-MM-DD"); do DOCX idzie jako DD.MM.RRRR. */
    contractDate: text("contract_date").notNull(),
    status: text("status", { enum: CONTRACT_DRAFT_STATUSES }).default("draft").notNull(),
    /** Wartości pól formularza jako JSON `Record<string, string>`. */
    fields: text("fields").default("{}").notNull(),
    notes: text("notes"),
    /** Nazwa pliku pokazywana użytkownikowi, np. „Umowa ZDW 12-ZDW-2026.docx”. */
    generatedFileName: text("generated_file_name"),
    /** Ścieżka względem katalogu załączników: `contract-drafts/<id>/<uuid>.docx`. */
    generatedStoredPath: text("generated_stored_path"),
    generatedAt: text("generated_at"),
    /**
     * Skrót pól z chwili generacji. Różny od skrótu bieżących `fields` znaczy
     * „plik jest nieaktualny” — liczone PRZY ODCZYCIE, nie trzymane jako flaga.
     */
    generatedHash: text("generated_hash"),
    generatedBy: integer("generated_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    objectIdx: index("contract_drafts_object_idx").on(t.objectId),
    companyYearIdx: index("contract_drafts_company_year_idx").on(t.companyId, t.year),
    statusIdx: index("contract_drafts_status_idx").on(t.status),
    /** Właściwa gwarancja braku dziur i duplikatów w liczniku (wyścig dwóch POST-ów). */
    seqUidx: uniqueIndex("contract_drafts_company_year_seq_uidx").on(t.companyId, t.year, t.seq),
  })
);

export type ContractDraft = typeof contractDrafts.$inferSelect;
export type NewContractDraft = typeof contractDrafts.$inferInsert;

/**
 * Skany podpisanej umowy, aneksy, korespondencja — bliźniak
 * `intervention_attachments` (scope katalogu: `contract-drafts/<draftId>`,
 * ten sam, w którym leży wygenerowany DOCX).
 */
export const contractDraftAttachments = sqliteTable(
  "contract_draft_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    draftId: integer("draft_id")
      .notNull()
      .references(() => contractDrafts.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storedPath: text("stored_path").notNull(),
    kind: text("kind", { enum: CALENDAR_ATTACHMENT_KINDS }).notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (t) => ({
    draftIdx: index("contract_draft_attachments_draft_idx").on(t.draftId),
  })
);

export type ContractDraftAttachment = typeof contractDraftAttachments.$inferSelect;
export type NewContractDraftAttachment = typeof contractDraftAttachments.$inferInsert;

/**
 * Cache podglądów linków (unfurl) — patrz `src/lib/link-preview.ts`.
 *
 * Klucz to adres ZNORMALIZOWANY (bez fragmentu, przycięty), a nie ten, który
 * użytkownik wpisał w notatce: ten sam link w dwóch notatkach ma dawać jedno
 * pobranie. Wiersze z `status = 'error'` też trzymamy — martwy adres nie ma
 * być odpytywany przy każdym renderze; TTL błędu jest po prostu krótszy
 * (1 h wobec 7 dni dla `ok`), a liczy się go przy odczycie, nie zadaniem
 * czyszczącym.
 */
export const linkPreviews = sqliteTable("link_previews", {
  /** Znormalizowany adres — klucz główny. */
  url: text("url").primaryKey(),
  /** Adres po przekierowaniach (może być równy `url`). */
  finalUrl: text("final_url"),
  host: text("host").notNull(),
  title: text("title"),
  description: text("description"),
  image: text("image"),
  favicon: text("favicon"),
  siteName: text("site_name"),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  /** Powód niepowodzenia (po polsku, pokazywany tylko pomocniczo). */
  error: text("error"),
  /**
   * Punkt do mini-mapy dla linków Google Maps: `{lat,lng,zoom,label}` jako JSON
   * albo NULL, gdy to nie jest link do map. Trzymany razem z podglądem, bo ma
   * to samo źródło (jedno wyjście w sieć) i to samo TTL.
   */
  mapJson: text("map_json"),
  fetchedAt: text("fetched_at")
    .default(sql`(datetime('now'))`)
    .notNull(),
});

export type LinkPreviewRow = typeof linkPreviews.$inferSelect;
export type NewLinkPreviewRow = typeof linkPreviews.$inferInsert;
