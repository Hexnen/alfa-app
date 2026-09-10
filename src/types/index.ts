// Enum types for the application

export const ObjectType = {
  MONITORING: "monitoring",
  PHYSICAL: "physical",
  ALARM: "alarm",
  MIXED: "mixed",
} as const;
export type ObjectType = (typeof ObjectType)[keyof typeof ObjectType];

export const InstallationType = {
  NEW: "new",
  TAKEOVER: "takeover",
} as const;
export type InstallationType =
  (typeof InstallationType)[keyof typeof InstallationType];

export const ObjectStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;
export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus];

export const Department = {
  SALES: "sales",
  TECHNICAL: "technical",
  ACCOUNTING: "accounting",
} as const;
export type Department = (typeof Department)[keyof typeof Department];

export const ContractStatus = {
  DRAFT: "draft",
  ACTIVE: "active",
  EXPIRED: "expired",
  TERMINATED: "terminated",
} as const;
export type ContractStatus =
  (typeof ContractStatus)[keyof typeof ContractStatus];

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Form input types
export interface ContractorInput {
  name: string;
  nip: string;
  address?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  contactPerson?: string;
  notes?: string;
  // Uzupełniane automatycznie z wykazu VAT MF (wyszukiwarka firm po NIP).
  regon?: string;
  krs?: string;
  vatStatus?: string;
  vatCheckedAt?: string;
  /** Opiekun handlowy (null = bez przypisania). */
  salespersonId?: number | null;
}

/**
 * USŁUGI OBIEKTU JAKO OKRESY (tabela `object_services`).
 *
 * Klucze są te same, co etykiety w `frontend/src/lib/utils.ts` (`objectServiceLabels`),
 * bo jeden słownik obsługuje filtr listy, analitykę i formularze — rozjazd nazw
 * oznaczałby mapowanie w trzech miejscach naraz.
 */
export type ObjectServiceKind = "kamery" | "sswin" | "wideorecepcja" | "ofi";

/**
 * Jeden okres świadczenia usługi. Ta sama usługa może wystąpić na obiekcie wiele
 * razy (np. kamery 2020–2022 i znów od 2024), dlatego to osobne wiersze, a nie
 * flagi: historia musi zostać widoczna po zakończeniu usługi.
 *
 * Okres ZAKOŃCZONY (`endDate` w przeszłości) nie liczy się do flag `objects.has_*`,
 * filtra `?service=`, analityki ani splitu abonamentu — ale nadal wraca z API,
 * żeby kartoteka pokazała pełną historię.
 */
export interface ObjectService {
  id: number;
  objectId: number;
  service: ObjectServiceKind;
  /** YYYY-MM-DD, wymagana. Start w przyszłości = usługa „zaplanowana” (nadal aktywna). */
  startDate: string;
  /** YYYY-MM-DD albo null = usługa trwa bezterminowo. */
  endDate: string | null;
  /**
   * `true` = daty startu NIE ZNAMY — wstawił ją backfill migracji 0084 z daty
   * założenia kartoteki (obiekt bez umowy z datą i bez `monitoring_start`).
   * Usługa jest aktywna jak każda inna (flagi, przychód, mianowniki), ale nie
   * liczy się jako „rozpoczęcie” w serii czasowej analityki, a UI pisze przy
   * dacie „szacowana”. Wpisanie daty w formularzu gasi flagę.
   */
  startEstimated: boolean;
  /**
   * Liczba kamer — tylko dla `service === "kamery"`. null = „usługa jest, ale kamer
   * nikt nie policzył”; to NIE jest zero (zero kamer wywaliłoby obiekt z wagi
   * kosztu centrum monitorowania).
   */
  cameraCount: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Okres w body zapisu obiektu/zlecenia. Brak `id` = nowy wiersz; obecność `services`
 * w body to PEŁNA PODMIANA listy (wiersze spoza niej są kasowane), bo inaczej
 * usunięcie okresu w formularzu nie miałoby jak dojechać do backendu.
 */
export interface ObjectServiceInput {
  id?: number;
  service: ObjectServiceKind;
  /** YYYY-MM-DD, wymagana. */
  startDate: string;
  endDate?: string | null;
  /**
   * Znacznik „data startu szacowana”. Formularz odsyła go takim, jaki dostał,
   * więc zwykła edycja innych pól nie kasuje wiedzy „tej daty nie znamy”.
   * Zmiana samej `startDate` w wierszu z `id` gasi flagę mimo tego pola
   * (patrz `applyServiceRows`) — data wpisana ręcznie jest datą znaną.
   */
  startEstimated?: boolean;
  /** Tylko kamery; null = nie policzono (≠ 0). */
  cameraCount?: number | null;
  notes?: string | null;
}

export interface ObjectInput {
  contractorId: number;
  name: string;
  address?: string;
  city?: string;
  /**
   * Link do Google Maps (pinezka obiektu). Walidowany po hoście — dopuszczone są
   * wyłącznie domeny Google, bo pole trafia potem do klikalnego linku w karcie.
   * null czyści wartość.
   */
  mapsUrl?: string | null;
  /**
   * @deprecated Zastąpione rozdzielnymi usługami niżej. Front go już nie wysyła;
   * dopóki kolumna `objects.type` istnieje (NOT NULL), backend wylicza ją z usług.
   */
  type?: ObjectType;
  /**
   * OKRESY USŁUG — źródło prawdy. Obecność tego pola w body oznacza pełną podmianę
   * listy; flagi `hasX`/`cameraCount` są wtedy WYLICZANE z okresów aktywnych
   * (jak `monthlyValue` z rozbicia abonamentu), a te przysłane — ignorowane.
   */
  services?: ObjectServiceInput[];
  /**
   * USŁUGI OBIEKTU — niezależne, dowolny mix (patrz src/db/schema.ts).
   * @deprecated Gdy w body jest `services`, flagi są wyliczane z okresów i to pole
   * jest ignorowane. Zostaje dla skryptów i starszych klientów API.
   */
  hasCameras?: boolean;
  /**
   * null = „usługa jest, ale kamer nikt nie policzył” — to NIE jest zero.
   * @deprecated Jak `hasCameras` — przy `services` liczone z aktywnych okresów kamer.
   */
  cameraCount?: number | null;
  /** @deprecated Jak `hasCameras` — wyliczane z `services`, gdy te są w body. */
  hasSswin?: boolean;
  /** @deprecated Jak `hasCameras` — wyliczane z `services`, gdy te są w body. */
  hasVideoreception?: boolean;
  /** @deprecated Jak `hasCameras` — wyliczane z `services`, gdy te są w body. */
  hasOfi?: boolean;
  /**
   * Przewidywane zakończenie obsługi CAŁEGO obiektu (YYYY-MM-DD). Niezależne od
   * końców pojedynczych okresów usług — to plan biznesowy, nie fakt.
   * null / puste = bezterminowo.
   */
  expectedEndDate?: string | null;
  installationType: InstallationType;
  status?: ObjectStatus;
  department?: Department;
  /**
   * @deprecated Zastąpione rozbiciem `monthlyZdw` + `monthlyOfi` (migracja 0082).
   * Backend WYLICZA je przy odczycie jako sumę obu linii, a przy zapisie —
   * gdy przyjdzie samo, bez rozbicia — rozdziela po usługach obiektu
   * (src/lib/abonament-split.ts). Nowy kod ma wysyłać rozbicie.
   */
  monthlyValue?: number | null;
  /** Abonament za zdalny dozór wizyjny (zł netto/mies.). null = nieuzupełniony. */
  monthlyZdw?: number | null;
  /** Abonament za ochronę fizyczną (zł netto/mies.). null = nieuzupełniony. */
  monthlyOfi?: number | null;
  /** Dzierżawa sprzętu (zł netto/mies.) — trzecia część przychodu obok abonamentów. */
  monthlyRental?: number | null;
  /** Miesięczny koszt obsługi obiektu (null = nieuzupełniony, to NIE jest zero). */
  monthlyCost?: number | null;
  /** Jednorazowy koszt uruchomienia (null = nieuzupełniony, to NIE jest zero). */
  setupCost?: number | null;
  notes?: string;
  /** Szerokość geograficzna (WGS84). null = nieustalona. */
  latitude?: number | null;
  /** Długość geograficzna (WGS84). null = nieustalona. */
  longitude?: number | null;
  /** Handlowiec prowadzący obiekt (null = opiekun kontrahenta). */
  salespersonId?: number | null;
  /** Spółka grupy obsługująca obiekt (null = nieprzypisana). */
  companyId?: number | null;
}

export interface ContractInput {
  objectId: number;
  contractNumber: string;
  startDate: string;
  endDate?: string;
  value?: number;
  filePath?: string;
  status?: ContractStatus;
}

export const OrderStatus = {
  NEW: "new",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export interface OrderInput {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  payerName: string;
  payerNip: string;
  payerInvoiceEmail?: string;
  payerContractorId?: number;
  objectName: string;
  objectKind?: string;
  objectAddress?: string;
  objectCity?: string;
  objectLocationUrl?: string;
  objectId?: number;
  contactPerson: string;
  contactPhone: string;
  contactEmail?: string;
  isCameraInstallation?: boolean;
  cameraCount?: number;
  megaphoneCount?: number;
  vtoolsOfferNumber?: string;
  internetIncluded?: boolean;
  interventionGroup?: boolean;
  videoReception?: boolean;
  monthlyAmount?: number;
  contractLengthMonths?: number;
  rentalAmount?: number;
  rentalLengthMonths?: number;
  invoiceIssuer?: string;
  status?: OrderStatus;
  serviceStartDate?: string;
  installationStartDate?: string;
  notes?: string;
  /**
   * Szansa sprzedaży, z której powstaje zlecenie (kierunek jest jednostronny:
   * szansa → zlecenie). Backend linkuje w obie strony i odrzuca drugie zlecenie
   * z tej samej szansy (409). Publiczny formularz ZDW tego pola nie przyjmuje.
   */
  leadId?: number;
  /** Handlowiec prowadzący; gdy pusty, bierze się z `leads.salesperson_id`. */
  salespersonId?: number;
  // Flags for auto-creating contractor and object
  createContractor?: boolean;
  createObject?: boolean;
  // Additional contractor data when creating new
  contractorAddress?: string;
  contractorCity?: string;
  contractorPostalCode?: string;
  contractorPhone?: string;
  contractorEmail?: string;
  contractorContactPerson?: string;
  // Additional object data when creating new
  /**
   * @deprecated Zastąpione usługami (`objectHas*`). Nadal akceptowane, bo publiczny
   * formularz ZDW i starsi klienci API mogą je jeszcze przysyłać.
   */
  objectType?: ObjectType;
  /**
   * OKRESY USŁUG zakładanego obiektu — zapisywane też na samym zleceniu
   * (`orders.object_services`), żeby PUT, szczegóły i mail je widziały; dotąd
   * flagi ginęły zaraz po konwersji na obiekt. Gdy brak, backend buduje listę
   * z flag `objectHas*` (start: `serviceStartDate` → `installationStartDate` → dziś).
   */
  objectServices?: ObjectServiceInput[];
  /**
   * Usługi zakładanego obiektu — patrz `ObjectInput` wyżej.
   * @deprecated Fallback dla publicznego formularza i starszych klientów; nowy kod
   * wysyła `objectServices` (usługa bez daty startu nie da się odtworzyć z flagi).
   */
  objectHasCameras?: boolean;
  /** @deprecated Jak `objectHasCameras` — używaj `objectServices[].cameraCount`. */
  objectCameraCount?: number | null;
  /** @deprecated Jak `objectHasCameras` — używaj `objectServices`. */
  objectHasSswin?: boolean;
  /** @deprecated Jak `objectHasCameras` — używaj `objectServices`. */
  objectHasVideoreception?: boolean;
  /** @deprecated Jak `objectHasCameras` — używaj `objectServices`. */
  objectHasOfi?: boolean;
  objectInstallationType?: InstallationType;
}

export interface WorkflowTransition {
  objectId: number;
  newStatus: ObjectStatus;
  newDepartment: Department;
  description?: string;
}
