// Klucze usług obiektu mają jedno źródło prawdy — słownik etykiet w utils.
// (utils nic z api nie importuje, więc zależność jest jednokierunkowa.)
import type { ObjectServiceKey } from "./utils";

const API_BASE = "/api";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

async function request<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  // Bezpieczny parse — błąd (np. 401 "Wymagane logowanie") ma dać czytelny
  // Error zamiast wykładać aplikację na nie-JSON-owej odpowiedzi.
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    // `status` pozwala UI odróżnić „endpointu jeszcze nie ma" (404) albo brak
    // uprawnień (403) od zwykłego błędu walidacji — bez parsowania komunikatu.
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), {
      status: response.status,
    });
  }

  return data;
}

// Stats
export async function getStats() {
  return request<ApiResponse<{
    contractors: number;
    objects: number;
    contracts: number;
    objectsByStatus: { pending: number; inProgress: number; active: number };
    objectsByDepartment: { sales: number; technical: number; accounting: number };
    monthlyRevenue: number;
  }>>("/stats");
}

// Contractors
export async function getContractors(params?: {
  search?: string;
  /** Zakładka: "1" = aktualni, "0" = archiwalni, brak = wszyscy. */
  active?: "1" | "0";
  /** Id handlowca albo "none" = kontrahenci bez opiekuna. */
  salespersonId?: number | "none";
  /** Id spółki albo "none" = kontrahenci bez spółki. */
  companyId?: number | "none";
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.active) searchParams.set("active", params.active);
  if (params?.salespersonId !== undefined) searchParams.set("salespersonId", String(params.salespersonId));
  if (params?.companyId !== undefined) searchParams.set("companyId", String(params.companyId));
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<ContractorsResponse>(`/contractors${query ? `?${query}` : ""}`);
}

export async function getContractor(id: number) {
  return request<ApiResponse<Contractor>>(`/contractors/${id}`);
}

export async function createContractor(data: ContractorInput) {
  return request<ApiResponse<Contractor>>("/contractors", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateContractor(id: number, data: Partial<ContractorInput>) {
  return request<ApiResponse<Contractor>>(`/contractors/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteContractor(id: number) {
  return request<ApiResponse<null>>(`/contractors/${id}`, {
    method: "DELETE",
  });
}

// Objects
/** Klucze sortowania listy obiektów — te same, co CASE-y w src/routes/objects.ts. */
export type ObjectSortKey =
  | "name"
  | "contractor"
  | "city"
  | "status"
  | "department"
  | "salesperson"
  | "company"
  | "value"
  | "cost"
  | "profit"
  | "created";

/** Lista obiektów + podsumowanie CAŁEGO wyniku filtrowania (nie tylko strony). */
export interface ObjectsResponse extends PaginatedResponse<ObjectWithContractor> {
  sort: ObjectSortKey;
  dir: "asc" | "desc";
  scope: "current" | "archived" | "all";
  /** Liczniki zakładek przy bieżących filtrach. */
  currentCount: number;
  archivedCount: number;
  /** Suma wartości miesięcznych obiektów spełniających filtry. */
  totalMonthlyValue: number;
  /** Ile z nich ma niezerowy abonament. */
  withMonthlyValue: number;
  /** Suma kosztów miesięcznych (puste liczone jak 0 — patrz withMonthlyCost). */
  totalMonthlyCost: number;
  /** Ile obiektów ma UZUPEŁNIONY koszt. Puste ≠ 0 zł, więc bez tej liczby marża kłamie. */
  withMonthlyCost: number;
  /** Suma jednorazowych kosztów instalacji. */
  totalSetupCost: number;
}

export async function getObjects(params?: {
  search?: string;
  status?: string;
  department?: string;
  /**
   * Filtr po USŁUDZE: obiekty MAJĄCE daną usługę. Podział nie jest rozłączny —
   * obiekt z kamerami i SSWiN-em wpada do obu filtrów.
   */
  service?: ObjectServiceKey;
  contractorId?: number;
  /** Widełki wartości miesięcznej (obiekt bez kwoty nigdy w nie nie wpada). */
  minValue?: number;
  maxValue?: number;
  /** "1" = tylko z abonamentem, "0" = tylko bez. */
  hasValue?: "1" | "0";
  /** Widełki kosztu miesięcznego (obiekt bez kosztu nigdy w nie nie wpada). */
  minCost?: number;
  maxCost?: number;
  /** "1" = tylko z uzupełnionym kosztem, "0" = tylko nieuzupełnione. */
  hasCost?: "1" | "0";
  /** Zakładka: bieżące (wszystko poza „nieaktywny”) albo archiwalne. */
  scope?: "current" | "archived";
  /** Id handlowca albo "none" = obiekty bez opiekuna. */
  salespersonId?: number | "none";
  /** Id spółki albo "none" = obiekty bez przypisanej spółki. */
  companyId?: number | "none";
  sort?: ObjectSortKey;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.department) searchParams.set("department", params.department);
  if (params?.service) searchParams.set("service", params.service);
  if (params?.contractorId) searchParams.set("contractorId", String(params.contractorId));
  if (params?.minValue !== undefined) searchParams.set("minValue", String(params.minValue));
  if (params?.maxValue !== undefined) searchParams.set("maxValue", String(params.maxValue));
  if (params?.hasValue) searchParams.set("hasValue", params.hasValue);
  if (params?.minCost !== undefined) searchParams.set("minCost", String(params.minCost));
  if (params?.maxCost !== undefined) searchParams.set("maxCost", String(params.maxCost));
  if (params?.hasCost) searchParams.set("hasCost", params.hasCost);
  if (params?.scope) searchParams.set("scope", params.scope);
  if (params?.salespersonId !== undefined) searchParams.set("salespersonId", String(params.salespersonId));
  if (params?.companyId !== undefined) searchParams.set("companyId", String(params.companyId));
  if (params?.sort) searchParams.set("sort", params.sort);
  if (params?.dir) searchParams.set("dir", params.dir);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<ObjectsResponse>(`/objects${query ? `?${query}` : ""}`);
}

export async function getObject(id: number) {
  return request<ApiResponse<ObjectWithDetails>>(`/objects/${id}`);
}

export async function createObject(data: ObjectInput) {
  return request<ApiResponse<ObjectRecord>>("/objects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateObject(id: number, data: Partial<ObjectInput>) {
  return request<ApiResponse<ObjectRecord>>(`/objects/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function transitionObject(id: number, data: WorkflowTransition) {
  return request<ApiResponse<ObjectRecord>>(`/objects/${id}/transition`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteObject(id: number) {
  return request<ApiResponse<null>>(`/objects/${id}`, {
    method: "DELETE",
  });
}

// Contracts
export async function getContracts(params?: {
  search?: string;
  status?: string;
  objectId?: number;
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.objectId) searchParams.set("objectId", String(params.objectId));
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<PaginatedResponse<ContractWithDetails>>(
    `/contracts${query ? `?${query}` : ""}`
  );
}

export async function getContract(id: number) {
  return request<ApiResponse<ContractWithDetails>>(`/contracts/${id}`);
}

export async function createContract(data: ContractInput) {
  return request<ApiResponse<Contract>>("/contracts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateContract(id: number, data: Partial<ContractInput>) {
  return request<ApiResponse<Contract>>(`/contracts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteContract(id: number) {
  return request<ApiResponse<null>>(`/contracts/${id}`, {
    method: "DELETE",
  });
}

// History
export async function getObjectHistory(objectId: number, params?: {
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<PaginatedResponse<ObjectHistoryRecord>>(
    `/history/object/${objectId}${query ? `?${query}` : ""}`
  );
}

export async function getRecentHistory(limit?: number) {
  const query = limit ? `?limit=${limit}` : "";
  return request<ApiResponse<HistoryWithDetails[]>>(`/history/recent${query}`);
}

// Types
export interface Contractor {
  id: number;
  name: string;
  nip: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  contactPerson: string | null;
  notes: string | null;
  // Dane z wykazu VAT MF (wyszukiwarka firm po NIP).
  regon?: string | null;
  krs?: string | null;
  vatStatus?: string | null;
  vatCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Kontrahent bieżący (true) albo archiwalny (false). */
  active: boolean;
  /** Opiekun handlowy (null = nieprzypisany). */
  salespersonId?: number | null;
  salesperson?: SalespersonRef | null;
  // Podsumowanie obiektów kontrahenta (liczy je GET /contractors; brak = starsze API).
  objectsCount?: number;
  activeObjectsCount?: number;
  /** Suma wartości miesięcznych obiektów tego kontrahenta. */
  objectsMonthlyValue?: number;
  /** Suma kosztów miesięcznych jego obiektów (puste liczone jak 0). */
  objectsMonthlyCost?: number;
  /** Suma jednorazowych kosztów instalacji jego obiektów. */
  objectsSetupCost?: number;
}

/** Lista kontrahentów + podsumowanie całego wyniku filtrowania. */
export interface ContractorsResponse extends PaginatedResponse<Contractor> {
  totalObjects: number;
  totalMonthlyValue: number;
  totalMonthlyCost: number;
  totalSetupCost: number;
  /** Liczniki zakładek „Aktualni” / „Archiwalni” przy bieżącej szukajce. */
  activeCount: number;
  archivedCount: number;
}

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
  regon?: string;
  krs?: string;
  vatStatus?: string;
  vatCheckedAt?: string;
  active?: boolean;
  salespersonId?: number | null;
}

export interface ObjectRecord {
  id: number;
  contractorId: number;
  name: string;
  address: string | null;
  city: string | null;
  /**
   * @deprecated Zastąpione rozdzielnymi usługami (`hasCameras` + `cameraCount`,
   * `hasSswin`, `hasVideoreception`, `hasOfi`). Backend jeszcze je zwraca, ale
   * front go NIE czyta — kolumna zniknie z bazy osobną migracją.
   */
  type: "monitoring" | "physical" | "alarm" | "mixed";
  /**
   * USŁUGI ŚWIADCZONE NA OBIEKCIE — niezależne, dowolny mix. Decydują o tym,
   * którym kluczem liczy się koszt osobowy: OFI z godzin pracowników obiektu,
   * reszta udziałem w koszcie centrum monitorowania.
   */
  hasCameras: boolean;
  /** null przy `hasCameras` = usługa jest, ale nikt nie policzył kamer — to NIE zero. */
  cameraCount: number | null;
  hasSswin: boolean;
  hasVideoreception: boolean;
  hasOfi: boolean;
  installationType: "new" | "takeover";
  status: "pending" | "in_progress" | "active" | "inactive";
  department: "sales" | "technical" | "accounting";
  monthlyValue: number | null;
  /** Miesięczny koszt obsługi. null = NIEUZUPEŁNIONY, co nie znaczy 0 zł. */
  monthlyCost: number | null;
  /** Jednorazowy koszt instalacji / wdrożenia. */
  setupCost: number | null;
  notes: string | null;
  /**
   * Współrzędne obiektu (kalkulacja dystansu biuro → obiekt). Uzupełniane
   * leniwie geokoderem; brak pola = starszy backend, `null` = jeszcze nieznane.
   */
  latitude?: number | null;
  longitude?: number | null;
  /** Handlowiec przypisany wprost do obiektu (null = dziedziczy po kontrahencie). */
  salespersonId?: number | null;
  /** Spółka grupy obsługująca obiekt. */
  companyId?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectWithContractor extends ObjectRecord {
  contractor: Contractor | null;
  /** Handlowiec obiektu, a gdy go nie ma — opiekun kontrahenta (`inherited: true`). */
  salesperson?: SalespersonRef | null;
  company?: CompanyRef | null;
}

export interface ObjectWithDetails extends ObjectWithContractor {
  contracts: Contract[];
}

export interface ObjectInput {
  contractorId: number;
  name: string;
  address?: string;
  city?: string;
  /** Usługi obiektu; backend dolicza z nich sposób liczenia kosztu osobowego. */
  hasCameras?: boolean;
  /** null = „usługa jest, ale kamer nikt nie policzył” (a nie zero kamer). */
  cameraCount?: number | null;
  hasSswin?: boolean;
  hasVideoreception?: boolean;
  hasOfi?: boolean;
  installationType: "new" | "takeover";
  status?: "pending" | "in_progress" | "active" | "inactive";
  department?: "sales" | "technical" | "accounting";
  monthlyValue?: number;
  /** Koszt miesięczny; null czyści wartość („nieuzupełniony”). */
  monthlyCost?: number | null;
  /** Jednorazowy koszt instalacji; null czyści wartość. */
  setupCost?: number | null;
  notes?: string;
  /** Ignorowane przez starszy backend — bezpieczne do wysłania zawsze. */
  latitude?: number | null;
  longitude?: number | null;
  /** Handlowiec obiektu; null = dziedziczy opiekuna kontrahenta. */
  salespersonId?: number | null;
  /** Spółka grupy obsługująca obiekt. */
  companyId?: number | null;
}

export interface WorkflowTransition {
  newStatus: "pending" | "in_progress" | "active" | "inactive";
  newDepartment: "sales" | "technical" | "accounting";
  description?: string;
}

export interface Contract {
  id: number;
  objectId: number;
  contractNumber: string;
  startDate: string;
  endDate: string | null;
  value: number | null;
  filePath: string | null;
  status: "draft" | "active" | "expired" | "terminated";
  createdAt: string;
}

export interface ContractWithDetails extends Contract {
  object: ObjectRecord | null;
  contractor: Contractor | null;
}

export interface ContractInput {
  objectId: number;
  contractNumber: string;
  startDate: string;
  endDate?: string;
  value?: number;
  filePath?: string;
  status?: "draft" | "active" | "expired" | "terminated";
}

export interface ObjectHistoryRecord {
  id: number;
  objectId: number;
  action: string;
  description: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  createdAt: string;
}

export interface HistoryWithDetails extends ObjectHistoryRecord {
  object: ObjectRecord | null;
  contractor: Contractor | null;
}

// Orders
export interface Order {
  id: number;
  orderNumber: string;
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  payerName: string;
  payerNip: string;
  payerInvoiceEmail: string | null;
  payerContractorId: number | null;
  objectName: string;
  objectKind: string | null;
  objectAddress: string | null;
  objectCity: string | null;
  objectLocationUrl: string | null;
  objectId: number | null;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string | null;
  isCameraInstallation: boolean;
  internetIncluded: boolean | null;
  interventionGroup: boolean | null;
  videoReception: boolean | null;
  cameraCount: number | null;
  megaphoneCount: number | null;
  vtoolsOfferNumber: string | null;
  monthlyAmount: number | null;
  contractLengthMonths: number | null;
  rentalAmount: number | null;
  rentalLengthMonths: number | null;
  invoiceIssuer: string | null;
  status: "new" | "in_progress" | "completed" | "cancelled";
  serviceStartDate: string | null;
  installationStartDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Joined data from backend
  contractor?: Contractor | null;
  object?: ObjectRecord | null;
}

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
  monthlyAmount?: number;
  contractLengthMonths?: number;
  rentalAmount?: number;
  rentalLengthMonths?: number;
  invoiceIssuer?: string;
  status?: "new" | "in_progress" | "completed" | "cancelled";
  serviceStartDate?: string;
  notes?: string;
  internetIncluded?: boolean;
  interventionGroup?: boolean;
  videoReception?: boolean;
  installationStartDate?: string;
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
  /** Usługi zakładanego obiektu (zamiast dawnego jednego „typu ochrony”). */
  objectHasCameras?: boolean;
  /** null/undefined = usługa jest, ale kamer nikt nie policzył. */
  objectCameraCount?: number | null;
  objectHasSswin?: boolean;
  objectHasVideoreception?: boolean;
  objectHasOfi?: boolean;
  objectInstallationType?: "new" | "takeover";
}

// --- Wyszukiwarka firm (wykaz podatników VAT MF) ---

/** Dane firmy pobrane z wykazu MF po NIP. */
export interface CompanyData {
  nip: string;
  name: string;
  address: string;
  postalCode: string;
  city: string;
  regon: string;
  krs: string;
  /** "Czynny" | "Zwolniony" | "Niezarejestrowany" | null (MF nie podał). */
  statusVat: "Czynny" | "Zwolniony" | "Niezarejestrowany" | null;
  accountNumbers: string[];
  rawAddress: string;
  /** Dzień, na który MF zwrócił dane ("YYYY-MM-DD"). */
  date: string;
}

/**
 * Szuka firmy po NIP w wykazie VAT MF. Rzuca Error ze `status` 502, gdy rejestr
 * nie odpowiada — UI ma wtedy pokazać ostrzeżenie, a nie blokować formularza.
 */
export async function lookupCompanyByNip(nip: string, refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  return request<ApiResponse<{ found: boolean; company: CompanyData | null; cached: boolean; source: string }>>(
    `/company-lookup/nip/${nip}${query}`
  );
}

// Check contractor by NIP
export async function checkContractorByNIP(nip: string) {
  return request<ApiResponse<{ exists: boolean; normalizedNip: string } & Partial<Contractor>>>(`/contractors/by-nip/${nip}`);
}

// Get contractor objects with history
export async function getContractorObjects(contractorId: number) {
  return request<ApiResponse<Array<ObjectRecord & { latestAction: ObjectHistoryRecord | null }>>>(`/contractors/${contractorId}/objects`);
}

export async function getOrders(params?: {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<PaginatedResponse<Order>>(
    `/orders${query ? `?${query}` : ""}`
  );
}

export async function getOrder(id: number) {
  return request<ApiResponse<Order>>(`/orders/${id}`);
}

export async function createOrder(data: OrderInput) {
  return request<ApiResponse<Order>>("/orders", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateOrder(id: number, data: Partial<OrderInput>) {
  return request<ApiResponse<Order>>(`/orders/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function updateOrderStatus(id: number, status: string) {
  return request<ApiResponse<Order>>(`/orders/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteOrder(id: number) {
  return request<ApiResponse<null>>(`/orders/${id}`, {
    method: "DELETE",
  });
}

// Public order intake (external "Formularz Zlecenia do ZDW" — no auth required).
// Payload is the subset of OrderInput mapped from the legacy ZDW form.
export interface PublicOrderIntakeInput {
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  isCameraInstallation?: boolean;
  vtoolsOfferNumber?: string;
  payerName: string;
  payerNip: string;
  payerInvoiceEmail?: string;
  monthlyAmount?: number;
  contractLengthMonths?: number;
  rentalAmount?: number;
  rentalLengthMonths?: number;
  invoiceIssuer?: string;
  cameraCount?: number;
  megaphoneCount?: number;
  objectName: string;
  objectKind?: string;
  objectAddress?: string;
  objectCity: string;
  objectLocationUrl?: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail?: string;
  serviceStartDate?: string;
  notes?: string;
  internetIncluded?: boolean;
  interventionGroup?: boolean;
  videoReception?: boolean;
  installationStartDate?: string;
}

/** Dane firmy dostępne dla formularza publicznego (węższe niż w panelu). */
export interface PublicCompanyData {
  nip: string;
  name: string;
  address: string;
  postalCode: string;
  city: string;
  statusVat: "Czynny" | "Zwolniony" | "Niezarejestrowany" | null;
  date: string;
}

/**
 * Wyszukiwarka firm dla anonimowego formularza ZDW. Trasa jest ostro limitowana
 * (5 zapytań na 5 minut z jednego adresu), więc wołamy ją tylko na żądanie
 * użytkownika — nigdy automatycznie przy pisaniu.
 */
export async function lookupPublicCompanyByNip(nip: string) {
  return request<ApiResponse<{ found: boolean; company: PublicCompanyData | null }>>(
    `/public/company-lookup/nip/${nip}`
  );
}

export async function submitPublicOrderIntake(data: PublicOrderIntakeInput) {
  return request<ApiResponse<{ orderNumber: string }>>("/public/order-intake", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// CMA (camera monitoring reports)
export interface CmaReport {
  id: number;
  fileName: string;
  title: string;
  dateFrom: string | null;
  dateTo: string | null;
  entryCount: number;
  importedAt: string;
}

export interface CmaReportEntry {
  id: number;
  reportId: number;
  objectCategory: string | null;
  objectName: string;
  address: string | null;
  identifier1: string | null;
  identifier2: string | null;
  identifier3: string | null;
  generatedAt: string | null;
  patrolName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endType: string | null;
  description: string | null;
  videoDevice: string | null;
  videoChannel: string | null;
  userName: string | null;
}

export interface CmaReportStats {
  entryCount: number;
  objectCount: number;
  userCount: number;
  operatorHandled: number;
  byEndType: { endType: string | null; count: number }[];
  byObject: { objectName: string; count: number }[];
  byUser: { userName: string; count: number }[];
}

export interface CmaCameraIssueCamera {
  videoChannel: string | null;
  videoDevice: string | null;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface CmaCameraIssueObject {
  objectName: string;
  address: string | null;
  totalCount: number;
  cameras: CmaCameraIssueCamera[];
}

export interface CmaCameraIssues {
  classifications: { classification: string; count: number }[];
  classification: string;
  issues: CmaCameraIssueObject[];
}

export const cmaApi = {
  async getReports(params?: {
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<CmaReport>>(
      `/cma/reports${query ? `?${query}` : ""}`
    );
  },

  async getReport(id: number) {
    return request<ApiResponse<{ report: CmaReport; stats: CmaReportStats }>>(
      `/cma/reports/${id}`
    );
  },

  async getReportEntries(
    id: number,
    params?: {
      search?: string;
      objectName?: string;
      endType?: string;
      page?: number;
      pageSize?: number;
    }
  ) {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.objectName) searchParams.set("objectName", params.objectName);
    if (params?.endType) searchParams.set("endType", params.endType);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<CmaReportEntry>>(
      `/cma/reports/${id}/entries${query ? `?${query}` : ""}`
    );
  },

  async getCameraIssues(id: number, classification?: string) {
    const searchParams = new URLSearchParams();
    if (classification) searchParams.set("classification", classification);

    const query = searchParams.toString();
    return request<ApiResponse<CmaCameraIssues>>(
      `/cma/reports/${id}/camera-issues${query ? `?${query}` : ""}`
    );
  },

  async importReport(file: File) {
    const formData = new FormData();
    formData.append("file", file);

    // No manual Content-Type header - the browser sets the multipart boundary.
    const response = await fetch(`${API_BASE}/cma/reports/import`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Import failed");
    }

    return data as ApiResponse<CmaReport>;
  },

  async deleteReport(id: number) {
    return request<ApiResponse<null>>(`/cma/reports/${id}`, {
      method: "DELETE",
    });
  },

  async getTrends() {
    return request<ApiResponse<CmaTrends>>("/cma/trends");
  },

  async getCameraOutages() {
    return request<ApiResponse<CmaCameraOutages | null>>(
      "/cma/camera-outages/current"
    );
  },
};

// CMA camera outages (aktualne braki obrazu vs poprzedni raport)
export interface CmaOutageReportRef {
  id: number;
  title: string;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface CmaOutageCamera {
  videoChannel: string | null;
  status: "new" | "still";
  occurrences: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface CmaOutageObject {
  objectName: string;
  address: string | null;
  camerasOutCount: number;
  /** Szacunek: distinct kanały wideo obiektu z całej historii zdarzeń */
  totalKnownCameras: number;
  allOut: boolean;
  cameras: CmaOutageCamera[];
  /** Kamery z brakiem w poprzednim raporcie, które już wróciły */
  resolved: { videoChannel: string | null }[];
}

export interface CmaCameraOutages {
  latestReport: CmaOutageReportRef;
  previousReport: CmaOutageReportRef | null;
  summary: {
    objectsWithOutages: number;
    camerasOut: number;
    newCameras: number;
    resolvedCameras: number;
    allOutObjects: number;
  };
  objects: CmaOutageObject[];
}

// CMA mail (auto-import from mailbox + sending camera issue lists)
export interface CmaMailSettings {
  id: number;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  email: string | null;
  hasPassword: boolean;
  folder: string;
  subjectFilter: string | null;
  fromFilter: string | null;
  pollMinutes: number;
  importEnabled: boolean;
  sendEnabled: boolean;
  recipients: string | null;
  /** Deprecated — zastąpione przez sendMode */
  autoSendAfterImport: boolean;
  sendMode: "after_import" | "scheduled";
  sendTimes: string | null;
  lastScheduledSendKey: string | null;
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
  updatedAt: string;
}

export interface CmaMailSettingsInput {
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  email?: string;
  // Send only when the user typed a new password (empty = keep current).
  password?: string;
  folder?: string;
  subjectFilter?: string;
  fromFilter?: string;
  pollMinutes?: number;
  importEnabled?: boolean;
  sendEnabled?: boolean;
  recipients?: string;
  sendMode?: "after_import" | "scheduled";
  sendTimes?: string;
}

export interface CmaMailFolderMatch {
  folder: string;
  matched: number;
  error?: string;
}

export interface CmaMailTestImapResult {
  folders: string[];
  /** Suma dopasowań ze wszystkich skonfigurowanych folderów */
  matchedInFolder: number;
  matchedPerFolder: CmaMailFolderMatch[];
}

export interface CmaMailCheckNowResult {
  checked: number;
  matched: number;
  imported: number;
  skipped: number;
  errors: number;
}

export interface CmaMailLogEntry {
  id: number;
  direction: "import" | "send";
  messageUid: number | null;
  subject: string | null;
  fileName: string | null;
  reportId: number | null;
  status: "ok" | "skipped" | "error";
  detail: string | null;
  createdAt: string;
}

export const cmaMailApi = {
  async getSettings() {
    return request<ApiResponse<CmaMailSettings>>("/cma/mail/settings");
  },

  async saveSettings(data: CmaMailSettingsInput) {
    return request<ApiResponse<CmaMailSettings>>("/cma/mail/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  async testImap() {
    return request<ApiResponse<CmaMailTestImapResult>>(
      "/cma/mail/test-imap",
      { method: "POST" }
    );
  },

  async testSmtp(to?: string) {
    return request<ApiResponse<null>>("/cma/mail/test-smtp", {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
    });
  },

  async checkNow() {
    return request<ApiResponse<CmaMailCheckNowResult>>(
      "/cma/mail/check-now",
      { method: "POST" }
    );
  },

  async getLog(params?: { page?: number; pageSize?: number }) {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<CmaMailLogEntry>>(
      `/cma/mail/log${query ? `?${query}` : ""}`
    );
  },

  async sendIssues(
    reportId: number,
    data?: { classification?: string; to?: string }
  ) {
    return request<ApiResponse<null>>(`/cma/mail/send-issues/${reportId}`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    });
  },

  async sendLatest() {
    return request<ApiResponse<null>>("/cma/mail/send-latest", {
      method: "POST",
    });
  },
};

// CMA trends (dashboard trendów po wszystkich zaimportowanych raportach)
export interface CmaTrendDay {
  date: string;
  entries: number;
  noImage: number;
  noImageObjects: number;
  noImageCameras: number;
  operatorHandled: number;
}

export interface CmaTrendObject {
  objectName: string;
  noImage: number;
  entries: number;
}

export interface CmaTrendCamera {
  objectName: string;
  videoChannel: string | null;
  noImage: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface CmaTrends {
  range: { from: string | null; to: string | null };
  reportCount: number;
  entryCountTotal: number;
  perDay: CmaTrendDay[];
  topObjects: CmaTrendObject[];
  topCameras: CmaTrendCamera[];
}

// ---------------------------------------------------------------------------
// Realizacje (dział Techniczny) — rejestr serwisów i montaży
// ---------------------------------------------------------------------------

/**
 * Pole ZGODNOŚCIOWE — stary, jednowymiarowy „rodzaj”, dziś wyliczany przez backend
 * z pary (`workType`, `billing`). Czytają go protokoły i starsze widoki; UI realizacji
 * pokazuje i wysyła wyłącznie nową parę.
 */
export type RealizationKind = "service" | "warranty" | "installation";

/** Rodzaj prac (CO robiono) — ten sam słownik co typ wydarzenia kalendarza + „inne”. */
export type RealizationWorkType =
  | "serwis"
  | "montaz"
  | "wizja"
  | "demontaz"
  | "konserwacja"
  | "inne";

export const REALIZATION_WORK_TYPES: RealizationWorkType[] = [
  "serwis",
  "montaz",
  "wizja",
  "demontaz",
  "konserwacja",
  "inne",
];

/** Typ rozliczenia (ZA ILE) — jak `billing` wydarzenia, ale bez „nie dotyczy”. */
export type RealizationBilling = "paid" | "warranty" | "free";

export const REALIZATION_BILLINGS: RealizationBilling[] = ["paid", "warranty", "free"];

/** Skrót protokołu dołączany do realizacji (badge + deep-link w tabeli). */
export interface RealizationProtocol {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
}

/**
 * Obiekt powiązany z realizacją — pinezka na mapie miesiąca. Backend bierze go
 * z wydarzenia kalendarza (`source: "event"`), a dla wpisów ręcznych dopasowuje
 * po nazwie `site` (`source: "name"`). `lat`/`lng` null = obiekt bez współrzędnych
 * (realizacja trafia do licznika „bez lokalizacji”, nie na mapę).
 */
export interface RealizationLocation {
  objectId: number;
  name: string;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  source: "event" | "name";
}

/** Adres i współrzędne biura — znacznik na mapie (GET /company/office). */
export interface CompanyOffice {
  address: string;
  city: string;
  lat: number | null;
  lng: number | null;
}

/** Ślad automatu przy pojedynczym polu realizacji (kolumna `autofill`). */
export interface AutofillMark {
  source?: string;
  detail?: string;
  /** ISO timestamp zapisu. */
  at?: string;
}

export interface Realization {
  id: number;
  date: string; // YYYY-MM-DD
  site: string;
  /** Rodzaj prac. Brak pola = starszy backend (przed rozdzieleniem `kind`). */
  workType: RealizationWorkType;
  /** Typ rozliczenia. Brak pola = starszy backend. */
  billing: RealizationBilling;
  /** Pole zgodnościowe, TYLKO do odczytu — backend wylicza je z `workType` + `billing`. */
  readonly kind: RealizationKind;
  amountHours: number;
  amountMaterial: number;
  amountKm: number;
  discount: number;
  note: string | null;
  invoiced: boolean;
  invoicedAt: string | null;
  caretaker: string | null;
  contractor1: string | null;
  contractor2: string | null;
  actualHours: number;
  actualKm: number;
  hourlyCost: number;
  subtotal: number; // suma bez rabatu (liczona w API)
  total: number; // suma netto (liczona w API)
  labourCost: number; // koszt roboczogodzin (liczony w API)
  /**
   * Wydarzenie kalendarza, z którego powstała realizacja (LEFT JOIN po
   * `calendar_events.realization_id`). Brak pola = starszy backend.
   */
  calendarEventId?: number | null;
  /**
   * Protokół realizacji (LEFT JOIN po `protocols.realization_id`).
   * `null` = realizacja bez protokołu, brak pola = starszy backend.
   */
  protocol?: RealizationProtocol | null;
  /**
   * Obiekt powiązany z realizacją — źródło pinezki na mapie miesiąca.
   * `null` = nie udało się powiązać, brak pola = starszy backend.
   */
  location?: RealizationLocation | null;
  /**
   * Pola uzupełnione automatem (badge „auto" w tabeli). Backend zapisuje mapę
   * `{ pole: { source, detail, at } }` jako JSON w kolumnie; akceptujemy też
   * samą listę pól. Brak kolumny → UI schodzi do lokalnych znaczników z
   * ostatniego zapisu (`components/realization/autofill-marks.ts`).
   */
  autofill?: string[] | Record<string, AutofillMark> | string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RealizationInput {
  date: string;
  site: string;
  workType: RealizationWorkType;
  billing: RealizationBilling;
  amountHours: number | string;
  amountMaterial: number | string;
  amountKm: number | string;
  discount: number | string;
  note?: string;
  invoiced: boolean;
  invoicedAt?: string | null;
  caretaker?: string;
  contractor1?: string;
  contractor2?: string;
  actualHours: number | string;
  actualKm: number | string;
  hourlyCost: number | string;
}

export interface RealizationSummary {
  paidServices: number;
  installations: number;
  revenue: number;
  freePotential: number;
  freeCost: number;
  grandTotal: number;
  /**
   * Kubełki pieniędzy w starym kształcie: `service` = płatne prace inne niż montaż,
   * `installation` = płatne montaże, `warranty` = wszystko bezpłatne (gwarancja + darmowe).
   */
  counts: { service: number; warranty: number; installation: number };
  /** Rozbicie po nowych wymiarach; brak pola = starszy backend. */
  byWorkType?: Record<RealizationWorkType, number>;
  byBilling?: Record<RealizationBilling, number>;
  uninvoicedCount: number;
  months: { month: number; revenue: number; loss: number }[];
}

/**
 * `source` — filtr pochodzenia, `protocol` — filtr obecności protokołu
 * (oba opcjonalne; starszy backend je ignoruje).
 */
export async function getRealizations(
  year: number,
  month: number,
  opts?: { source?: "calendar" | "manual"; protocol?: "with" | "without" }
) {
  const params = new URLSearchParams({ year: String(year), month: String(month) });
  if (opts?.source) params.set("source", opts.source);
  if (opts?.protocol) params.set("protocol", opts.protocol);
  return request<ApiResponse<Realization[]>>(`/realizations?${params.toString()}`);
}

export async function getRealizationSummary(year: number, month: number) {
  return request<ApiResponse<RealizationSummary>>(
    `/realizations/summary?year=${year}&month=${month}`
  );
}

/**
 * Adres biura dla znacznika na mapie. Lekki odczyt dla każdego zalogowanego —
 * pełne ustawienia firmy (`/admin/company/settings`) wymagają admina.
 */
export async function getCompanyOffice() {
  return request<ApiResponse<CompanyOffice>>("/company/office");
}

export async function createRealization(data: RealizationInput) {
  return request<ApiResponse<Realization>>("/realizations", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateRealization(
  id: number,
  data: RealizationInput,
  // Backend wymaga optymistycznej blokady: znacznik updatedAt wersji, którą
  // użytkownik miał na ekranie (bez niego PUT kończy się 428).
  expectedUpdatedAt: string
) {
  return request<ApiResponse<Realization>>(`/realizations/${id}`, {
    method: "PUT",
    body: JSON.stringify({ ...data, expectedUpdatedAt }),
  });
}

export async function deleteRealization(id: number) {
  return request<ApiResponse<null>>(`/realizations/${id}`, {
    method: "DELETE",
  });
}

/**
 * Tworzy protokół dla pojedynczej realizacji (starsze wpisy bez protokołu).
 * 409 „Realizacja ma już protokół” trafia do `request` jako wyjątek.
 */
export async function createRealizationProtocol(id: number) {
  return request<ApiResponse<{ protocol: RealizationProtocol }>>(
    `/realizations/${id}/protocol`,
    { method: "POST" }
  );
}

// ---------------------------------------------------------------------------
// Technicy (serwisanci) — słownik wykonawców dla realizacji
// ---------------------------------------------------------------------------

export type TechnicianType = "internal" | "external";

export interface Technician {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  nip: string | null;
  type: TechnicianType;
  notes: string | null;
  active: boolean;
  /** Cennik przypisany technikowi; null = korzysta z cennika głównego. */
  priceListId: number | null;
  /** Ta sama osoba w kartotece kadrowej; null = technik spoza listy płac. */
  employeeId: number | null;
  /** Nazwisko z Kadr doklejane przez API (null = brak powiązania). */
  employeeName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TechnicianInput {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  company?: string;
  nip?: string;
  type: TechnicianType;
  notes?: string;
  active?: boolean;
  /** null / brak = cennik główny. */
  priceListId?: number | null;
  /** Powiązanie z kartoteką kadrową; null czyści powiązanie. */
  employeeId?: number | null;
}

export async function getTechnicians(onlyActive = false) {
  return request<ApiResponse<Technician[]>>(
    `/technicians${onlyActive ? "?active=true" : ""}`
  );
}

export async function createTechnician(data: TechnicianInput) {
  return request<ApiResponse<Technician>>("/technicians", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTechnician(id: number, data: TechnicianInput) {
  return request<ApiResponse<Technician>>(`/technicians/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteTechnician(id: number) {
  return request<ApiResponse<null>>(`/technicians/${id}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Handlowcy (opiekunowie kontrahentów i obiektów)
// ---------------------------------------------------------------------------

export interface Salesperson {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  region: string | null;
  /** Ile handlowiec kosztuje firmę miesięcznie. null = nieuzupełniony. */
  monthlyCost: number | null;
  /** Prowizja w % od przychodu portfela (0–100). null = brak prowizji. */
  commissionRate: number | null;
  /**
   * Ta sama osoba w kartotece kadrowej; null = handlowiec spoza listy płac.
   * Gdy jest ustawiona, koszt własny bierze się z wypłat, a `monthlyCost`
   * jest ignorowany — inaczej ten sam człowiek kosztowałby firmę dwa razy.
   */
  employeeId: number | null;
  /** Nazwisko z Kadr doklejane przez API (null = brak powiązania). */
  employeeName?: string | null;
  notes: string | null;
  active: boolean;
  /** Liczone przez API: ilu kontrahentów i ile obiektów prowadzi. */
  contractorsCount?: number;
  objectsCount?: number;
  /**
   * Portfel handlowca: obiekty przypisane wprost ORAZ odziedziczone po kontrahencie —
   * ta sama reguła, co na liście obiektów i w Analityce.
   */
  objectsMonthlyValue?: number;
  objectsMonthlyCost?: number;
  objectsSetupCost?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SalespersonInput {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  region?: string;
  /** Koszt miesięczny handlowca; null czyści wartość. */
  monthlyCost?: number | null;
  /** Prowizja w % (0–100); null czyści wartość. Backend odrzuca spoza zakresu. */
  commissionRate?: number | null;
  /** Powiązanie z kartoteką kadrową; null czyści powiązanie. */
  employeeId?: number | null;
  notes?: string;
  active?: boolean;
}

/** Skrót handlowca dołączany do kontrahenta i obiektu. */
export interface SalespersonRef {
  id: number;
  firstName: string;
  lastName: string;
  active: boolean;
  /** Tylko przy obiekcie: true = handlowiec odziedziczony po kontrahencie. */
  inherited?: boolean;
}

export function salespersonName(s: SalespersonRef | Salesperson | null | undefined): string {
  if (!s) return "—";
  return `${s.firstName} ${s.lastName}`.trim();
}

export async function getSalespeople(onlyActive = false) {
  return request<ApiResponse<Salesperson[]>>(
    `/salespeople${onlyActive ? "?active=true" : ""}`
  );
}

export async function createSalesperson(data: SalespersonInput) {
  return request<ApiResponse<Salesperson>>("/salespeople", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateSalesperson(id: number, data: Partial<SalespersonInput>) {
  return request<ApiResponse<Salesperson>>(`/salespeople/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteSalesperson(id: number) {
  return request<ApiResponse<null>>(`/salespeople/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Spółki grupy (słownik wspólny z kadrami)
// ---------------------------------------------------------------------------

export interface Company {
  id: number;
  /** Skrót używany w kadrach („ALFA S”, „GUARD 21”) — klucz zgodności z arkuszem WYNAGRODZENIA. */
  name: string;
  fullName: string | null;
  nip: string | null;
  // Dane z wykazu VAT MF (uzupełniane wyszukiwarką po NIP).
  regon: string | null;
  krs: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  vatStatus: string | null;
  vatCheckedAt: string | null;
  notes: string | null;
  active: boolean;
  // Nadpisania narzutów składek pracodawcy dla tej spółki. NULL = bierzemy
  // wartość globalną z Ustawień firmy (Administracja → Firma → Składki pracodawcy).
  employerMarkupUop: number | null;
  employerMarkupZlecenieZua: number | null;
  employerMarkupZlecenieZza: number | null;
  /** Liczone przez API. */
  objectsCount?: number;
  objectsMonthlyValue?: number;
  /** Ile umów w kadrach wskazuje na tę spółkę (po nazwie). */
  contractsCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyInput {
  name: string;
  fullName?: string;
  nip?: string;
  regon?: string;
  krs?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  vatStatus?: string;
  vatCheckedAt?: string;
  notes?: string;
  active?: boolean;
  /** null = wyczyść nadpisanie i wróć do wartości globalnej. */
  employerMarkupUop?: number | null;
  employerMarkupZlecenieZua?: number | null;
  employerMarkupZlecenieZza?: number | null;
}

/** Skrót spółki dołączany do obiektu. */
export interface CompanyRef {
  id: number;
  name: string;
  active: boolean;
}

export async function getCompanies(onlyActive = false) {
  return request<ApiResponse<Company[]>>(`/companies${onlyActive ? "?active=true" : ""}`);
}

export async function createCompany(data: CompanyInput) {
  return request<ApiResponse<Company>>("/companies", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateCompany(id: number, data: Partial<CompanyInput>) {
  return request<ApiResponse<Company>>(`/companies/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/** Sprawdzenie spółki w wykazie VAT MF po jej NIP-ie i zapis pobranych danych. */
export async function lookupCompanyInMf(id: number, refresh = false) {
  return request<ApiResponse<Company> & { message?: string }>(
    `/companies/${id}/lookup${refresh ? "?refresh=1" : ""}`,
    { method: "POST" }
  );
}

export async function deleteCompany(id: number) {
  return request<ApiResponse<null>>(`/companies/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Cennik usług serwisowych
// ---------------------------------------------------------------------------

/**
 * Rodzaj pozycji cennika. Materiały dopasowują się do pozycji protokołu przy
 * automatycznym wyliczaniu realizacji, usługi dają stawkę RBH / KM.
 * Starszy backend nie zwraca `kind` — UI traktuje brak jako „usługa".
 */
export type PriceItemKind = "service" | "material";

/** Rodzaj pozycji z bezpiecznym domyślnym („usługa"), gdy backend go nie zwraca. */
export const priceItemKind = (item: { kind?: string | null }): PriceItemKind =>
  item.kind === "material" ? "material" : "service";

export const PRICE_ITEM_KIND_LABEL: Record<PriceItemKind, string> = {
  service: "Usługa",
  material: "Materiał",
};

export interface PriceItem {
  id: number;
  /** Cennik, do którego należy pozycja. */
  priceListId: number;
  name: string;
  unit: string;
  price: number;
  position: number;
  active: boolean;
  /** Brak pola = starszy backend (czytaj przez `priceItemKind`). */
  kind?: PriceItemKind;
  createdAt: string;
  updatedAt: string;
}

export interface PriceItemInput {
  name: string;
  unit: string;
  price: number | string;
  position?: number;
  active?: boolean;
  /** Pomijane przez starszy backend — bezpieczne do wysłania zawsze. */
  kind?: PriceItemKind;
  /** Brak = cennik główny (POST) / bez zmiany (PUT). */
  priceListId?: number;
}

/** Cennik (grupa pozycji) wraz z licznikami z `GET /pricelist/lists`. */
export interface PriceListGroup {
  id: number;
  name: string;
  description: string;
  /** Cennik główny — dokładnie jeden w bazie. */
  isDefault: boolean;
  active: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  technicianCount: number;
}

export interface PriceListGroupInput {
  name: string;
  description?: string;
  active?: boolean;
  position?: number;
}

/** Bez `listId` backend zwraca pozycje cennika głównego (zgodność wsteczna). */
/**
 * Pozycje cennika. `kind` zawęża wynik po stronie backendu (usługi / materiały);
 * starszy backend parametr ignoruje, więc filtr trzeba i tak zastosować w UI.
 */
export async function getPriceList(listId?: number, kind?: PriceItemKind) {
  const qs = new URLSearchParams();
  if (listId) qs.set("listId", String(listId));
  if (kind) qs.set("kind", kind);
  const q = qs.toString();
  return request<ApiResponse<PriceItem[]>>(`/pricelist${q ? `?${q}` : ""}`);
}

/** Cenniki: CRUD grup, cennik główny, duplikacja, przypisania, kopiowanie pozycji. */
export const priceListsApi = {
  list: () => request<ApiResponse<PriceListGroup[]>>("/pricelist/lists"),

  create: (data: PriceListGroupInput) =>
    request<ApiResponse<PriceListGroup>>("/pricelist/lists", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: number, data: PriceListGroupInput) =>
    request<ApiResponse<PriceListGroup>>(`/pricelist/lists/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  /** `force` przenosi pozycje do cennika głównego i zdejmuje przypisania techników. */
  remove: (id: number, force = false) =>
    request<ApiResponse<null>>(
      `/pricelist/lists/${id}${force ? "?force=1" : ""}`,
      { method: "DELETE" }
    ),

  setDefault: (id: number) =>
    request<ApiResponse<PriceListGroup>>(`/pricelist/lists/${id}/default`, {
      method: "POST",
    }),

  duplicate: (id: number, data?: { name?: string; description?: string }) =>
    request<ApiResponse<PriceListGroup>>(`/pricelist/lists/${id}/duplicate`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    }),

  technicians: (id: number) =>
    request<ApiResponse<Technician[]>>(`/pricelist/lists/${id}/technicians`),

  /** Ustawia dokładny zbiór techników korzystających z cennika. */
  setTechnicians: (id: number, technicianIds: number[]) =>
    request<ApiResponse<Technician[]>>(`/pricelist/lists/${id}/technicians`, {
      method: "PUT",
      body: JSON.stringify({ technicianIds }),
    }),

  /** Kopiuje pozycje (wszystkie lub wskazane) do innego cennika. */
  copyItems: (fromListId: number, toListId: number, itemIds?: number[]) =>
    request<ApiResponse<PriceItem[]>>("/pricelist/copy", {
      method: "POST",
      body: JSON.stringify({ fromListId, toListId, itemIds }),
    }),
};

export async function createPriceItem(data: PriceItemInput) {
  return request<ApiResponse<PriceItem>>("/pricelist", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updatePriceItem(id: number, data: PriceItemInput) {
  return request<ApiResponse<PriceItem>>(`/pricelist/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deletePriceItem(id: number) {
  return request<ApiResponse<null>>(`/pricelist/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Szablony kamer (standardowe modele kamer i ich parametry)
// ---------------------------------------------------------------------------

export type CameraModelType = "bullet" | "dome" | "ptz" | "pano";

export interface CameraModel {
  id: number;
  name: string;
  manufacturer: string;
  type: CameraModelType;
  resolution: string;
  lens: string;
  irRange: string;
  power: string;
  interface: string;
  protocol: string;
  fov: number;
  range: number;
  height: number;
  color: string;
  notes: string;
  position: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CameraModelInput {
  name: string;
  manufacturer?: string;
  type?: CameraModelType;
  resolution?: string;
  lens?: string;
  irRange?: string;
  power?: string;
  interface?: string;
  protocol?: string;
  fov?: number | string;
  range?: number | string;
  height?: number | string;
  color?: string;
  notes?: string;
  position?: number;
  active?: boolean;
}

export async function getCameraModels() {
  return request<ApiResponse<CameraModel[]>>("/camera-models");
}

export async function createCameraModel(data: CameraModelInput) {
  return request<ApiResponse<CameraModel>>("/camera-models", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateCameraModel(id: number, data: CameraModelInput) {
  return request<ApiResponse<CameraModel>>(`/camera-models/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteCameraModel(id: number) {
  return request<ApiResponse<null>>(`/camera-models/${id}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Protokoły końcowe (generowane automatycznie z realizacji)
// ---------------------------------------------------------------------------

export type ProtocolWorkType = "serwis" | "montaz" | "wizja" | "inne";

export interface ProtocolItem {
  name: string;
  serial: string;
  unit: string;
  qty: string;
}

export interface Protocol {
  id: number;
  realizationId: number;
  number: string;
  workDate: string;
  workType: ProtocolWorkType;
  actualHours: number;
  actualKm: number;
  contractor: string | null;
  salesperson: string | null;
  clientName: string | null;
  clientNip: string | null;
  clientCity: string | null;
  installationAddress: string | null;
  contact: string | null;
  activities: string | null;
  items: ProtocolItem[];
  status: "draft" | "final";
  signaturePng?: string | null;
  signerName?: string | null;
  signedAt?: string | null;
  contentHash?: string | null;
  site?: string | null; // obiekt z powiązanej realizacji
  kind?: RealizationKind | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProtocolInput {
  workDate: string;
  workType: ProtocolWorkType;
  actualHours: number | string;
  actualKm: number | string;
  contractor?: string;
  salesperson?: string;
  clientName?: string;
  clientNip?: string;
  clientCity?: string;
  installationAddress?: string;
  contact?: string;
  activities?: string;
  items: ProtocolItem[];
  status: "draft" | "final";
}

export async function getProtocols(year?: number, month?: number, opts?: { q?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  return request<ApiResponse<Protocol[]>>(
    `/protocols${query ? `?${query}` : ""}`
  );
}

export async function syncProtocols() {
  return request<ApiResponse<{ created: number }>>("/protocols/sync", {
    method: "POST",
  });
}

export async function updateProtocol(id: number, data: ProtocolInput) {
  return request<ApiResponse<Protocol>>(`/protocols/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteProtocol(id: number) {
  return request<ApiResponse<null>>(`/protocols/${id}`, { method: "DELETE" });
}

// --- Uzupełnianie protokołu z danych, które system już zna ------------------
// Backend: src/lib/protocol-prefill.ts (wydarzenie → obiekt → kontrahent → cennik).
// Podgląd nic nie zapisuje; zapis obejmuje wyłącznie wskazane pola. Protokół
// podpisany albo zatwierdzony → 400 (przycisk jest wtedy ukryty).

/** Pola protokołu objęte uzupełnianiem (kolejność = kolejność w dialogu). */
export const PROTOCOL_PREFILL_FIELDS = [
  "workDate",
  "workType",
  "actualHours",
  "actualKm",
  "contractor",
  "salesperson",
  "clientName",
  "clientNip",
  "clientCity",
  "installationAddress",
  "contact",
  "activities",
  "items",
] as const;
export type ProtocolPrefillField = (typeof PROTOCOL_PREFILL_FIELDS)[number];

/** Kształt jak `AutofillSuggestion` w realizacjach — ta sama konwencja pól. */
export interface ProtocolSuggestion {
  field: ProtocolPrefillField | string;
  label: string;
  current: string | number | null;
  suggested: string | number;
  /** „kalendarz" | „obiekt" | „kontrahent" | „cennik" | „realizacja". */
  source: string;
  detail: string;
  /** true = pole puste, można podstawić bez pytania; false = nadpisze wartość albo jest szacunkiem. */
  confident: boolean;
  /** true = wartość szacowana (norma dnia dla wydarzenia całodniowego) — zawsze do potwierdzenia. */
  assumed?: boolean;
}

export interface ProtocolPrefillContext {
  realizationId: number;
  event: { id: number; type: string; title: string; startAt: string } | null;
  object: { id: number; name: string } | null;
  contractor: { id: number; name: string } | null;
  priceList: { id: number; name: string; via: "technik" | "domyślny"; technician: string | null } | null;
  materialCount: number;
}

export interface ProtocolPrefillPreview {
  suggestions: ProtocolSuggestion[];
  context: ProtocolPrefillContext | null;
}

export interface ProtocolPrefillApplied extends Protocol {
  applied: string[];
  skipped: { field: string; reason: string }[];
}

export const protocolPrefillApi = {
  /** Podgląd sugestii „obecnie → proponowane" — bez zapisu. */
  async preview(id: number): Promise<ProtocolPrefillPreview> {
    const r = await request<ApiResponse<ProtocolPrefillPreview>>(`/protocols/${id}/prefill`);
    const d = r.data;
    return {
      suggestions: Array.isArray(d?.suggestions) ? d.suggestions : [],
      context: d?.context ?? null,
    };
  },

  /** Zapisuje wskazane pola i zwraca zaktualizowany protokół. */
  async apply(id: number, fields: string[]): Promise<ProtocolPrefillApplied> {
    const r = await request<ApiResponse<ProtocolPrefillApplied>>(`/protocols/${id}/prefill`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    return r.data as ProtocolPrefillApplied;
  },
};

// ---------------------------------------------------------------------------
// Wyceny usług serwisowych
// ---------------------------------------------------------------------------

export interface QuoteItem {
  name: string;
  qty: string;
  unit: string;
  price: string;
}

export interface Quote {
  id: number;
  number: string;
  date: string;
  site: string;
  address: string;
  items: QuoteItem[];
  total: number;
  /** Realizacja, z której powstała wycena (null = wycena wolnostojąca). */
  realizationId?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteInput {
  date: string;
  site: string;
  address: string;
  items?: QuoteItem[];
}

export async function getQuotes(
  year?: number,
  month?: number,
  opts: { q?: string; limit?: number } = {}
) {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  if (opts.q) params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  return request<ApiResponse<Quote[]>>(`/quotes${query ? `?${query}` : ""}`);
}

/**
 * Nowa wycena. Bez `items` backend prefilluje ją pozycjami cennika: wskazanego
 * przez `priceListId`, cennika technika (`technicianId`) albo — domyślnie —
 * cennika głównego.
 */
export async function createQuote(
  data: Partial<QuoteInput> & { priceListId?: number; technicianId?: number } = {}
) {
  return request<ApiResponse<Quote>>("/quotes", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateQuote(id: number, data: QuoteInput) {
  return request<ApiResponse<Quote>>(`/quotes/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteQuote(id: number) {
  return request<ApiResponse<null>>(`/quotes/${id}`, { method: "DELETE" });
}

// --- Podpisywanie protokołów ---

export async function signProtocol(
  id: number,
  data: { signaturePng: string; signerName: string }
) {
  return request<ApiResponse<Protocol>>(`/protocols/${id}/sign`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function unsignProtocol(id: number) {
  return request<ApiResponse<Protocol>>(`/protocols/${id}/unsign`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Projekty monitoringu (designer CCTV na mapie)
// ---------------------------------------------------------------------------

export interface MonitoringProject {
  id: number;
  name: string;
  address: string;
  notes: string;
  cameras: number;
  points: number;
  zones: number;
  cables: number;
  pinAddress: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringProjectInput {
  name: string;
  address?: string;
  notes?: string;
}

export async function getMonitoringProjects() {
  return request<ApiResponse<MonitoringProject[]>>("/monitoring");
}

export async function createMonitoringProject(data: MonitoringProjectInput) {
  return request<ApiResponse<MonitoringProject>>("/monitoring", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateMonitoringProject(
  id: number,
  data: Partial<MonitoringProjectInput>
) {
  return request<ApiResponse<MonitoringProject>>(`/monitoring/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteMonitoringProject(id: number) {
  return request<ApiResponse<null>>(`/monitoring/${id}`, { method: "DELETE" });
}

// --- Rejestr obiektów monitorowanych (Techniczny -> Obiekty) ---

export interface MonitoredObject {
  id: number;
  externalId: number;
  account: string | null;
  category: string | null;
  name: string;
  identifier1: string | null;
  identifier2: string | null;
  identifier3: string | null;
  extraData1: string | null;
  extraData2: string | null;
  extraData3: string | null;
  extraData4: string | null;
  extraData5: string | null;
  address: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  latitude: string | null;
  longitude: string | null;
  locationDescription: string | null;
  objectDescription: string | null;
  phones: string | null;
  devices: string | null;
  defaultCrew: string | null;
  allCrews: string | null;
  groups: string | null;
  monitoringStart: string | null;
  monitoringEnd: string | null;
  objectStatus: string | null;
  addedAt: string | null;
  authorizedPersons: string | null;
  authorizedPhones: string | null;
  authorizedPasswords: string | null;
  duressPasswords: string | null;
  dayArrivalTime: string | null;
  nightArrivalTime: string | null;
  relatedObjects: string | null;
  serviceTypes: string | null;
  serviceMonitoringFrom: string | null;
  serviceMonitoringTo: string | null;
  active: boolean;
  firstImportId: number | null;
  lastImportId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectImport {
  id: number;
  fileName: string;
  totalCount: number;
  newCount: number;
  changedCount: number;
  removedCount: number;
  restoredCount: number;
  importedAt: string;
}

export interface MonitoredObjectChange {
  id: number;
  objectId: number;
  importId: number | null;
  changeType: "created" | "updated" | "removed" | "restored";
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  importFileName?: string | null;
  importedAt?: string | null;
  objectName?: string;
  objectExternalId?: number;
}

export const monitoredObjectsApi = {
  async getObjects(params?: {
    search?: string;
    active?: "1" | "0";
    page?: number;
    pageSize?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.active) searchParams.set("active", params.active);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<MonitoredObject>>(
      `/monitored-objects${query ? `?${query}` : ""}`
    );
  },

  async getObject(id: number) {
    return request<
      ApiResponse<{ object: MonitoredObject; changes: MonitoredObjectChange[] }>
    >(`/monitored-objects/${id}`);
  },

  async getImports(params?: { page?: number; pageSize?: number }) {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<ObjectImport>>(
      `/monitored-objects/imports${query ? `?${query}` : ""}`
    );
  },

  async getChanges(params?: {
    importId?: number;
    page?: number;
    pageSize?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.importId) searchParams.set("importId", String(params.importId));
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

    const query = searchParams.toString();
    return request<PaginatedResponse<MonitoredObjectChange>>(
      `/monitored-objects/changes${query ? `?${query}` : ""}`
    );
  },

  async importReport(file: File) {
    const formData = new FormData();
    formData.append("file", file);

    // No manual Content-Type header - the browser sets the multipart boundary.
    const response = await fetch(`${API_BASE}/monitored-objects/import`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Import failed");
    }

    return data as ApiResponse<ObjectImport>;
  },
};

// --- Oferta monitoringu (zdjęcia + pola tekstowe + generowanie HTML) ---

export interface MonitoringOfferFields {
  kicker: string;
  subtitle: string;
  visitDate: string;
  purpose: string;
  contact: string;
  summary: string;
  calloutTitle: string;
  callout: string;
  existing: string;
}

export interface MonitoringProjectFull extends Omit<
    MonitoringProject,
    "cameras" | "points" | "zones" | "cables"
  > {
  data: string;
  offer: string;
}

export interface MonitoringPhoto {
  id: number;
  projectId: number;
  caption: string;
  attention: boolean;
  sortOrder: number;
  data: string;
  createdAt: string;
}

export async function getMonitoringProject(id: number) {
  return request<ApiResponse<MonitoringProjectFull>>(`/monitoring/${id}`);
}

export async function saveMonitoringOffer(
  id: number,
  offer: MonitoringOfferFields
) {
  return request<ApiResponse<MonitoringProject>>(`/monitoring/${id}`, {
    method: "PUT",
    body: JSON.stringify({ offer }),
  });
}

export async function getMonitoringPhotos(projectId: number) {
  return request<ApiResponse<MonitoringPhoto[]>>(
    `/monitoring/${projectId}/photos`
  );
}

export async function addMonitoringPhoto(
  projectId: number,
  photo: { caption: string; attention?: boolean; data: string }
) {
  return request<ApiResponse<MonitoringPhoto>>(
    `/monitoring/${projectId}/photos`,
    { method: "POST", body: JSON.stringify(photo) }
  );
}

export async function updateMonitoringPhoto(
  photoId: number,
  updates: { caption?: string; attention?: boolean; sortOrder?: number }
) {
  return request<ApiResponse<MonitoringPhoto>>(`/monitoring/photos/${photoId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export async function deleteMonitoringPhoto(photoId: number) {
  return request<ApiResponse<null>>(`/monitoring/photos/${photoId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Kadry — pracownicy, obiekty, normy, godziny, umowy, wynagrodzenia, biuro
// ---------------------------------------------------------------------------

/** Rodzaj rozliczenia pracownika: ochrona = umowy kadrowe, biuro = zestawienie biura. */
export type HrEmployeeKind = "ochrona" | "biuro";

export interface HrEmployee {
  id: number;
  fullName: string;
  code: string;
  kind: HrEmployeeKind;
  /** Spółki z rozliczeń biura (cała historia) — liczone przez API. */
  officeCompanies?: string[];
  active: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface HrEmployeeInput {
  fullName: string;
  code?: string;
  kind?: HrEmployeeKind;
  active?: boolean;
  notes?: string;
}

/** Obiekt z kartoteki w formie pozycji listy wyboru przy mapowaniu. */
export interface HrObjectRef {
  id: number;
  name: string;
  city: string | null;
  contractorName: string;
}

export interface HrObject {
  id: number;
  name: string;
  active: boolean;
  /**
   * Obiekt z kartoteki, którego dotyczą godziny tej pozycji. null = niezmapowana
   * (stan domyślny — słownik kadrowy powstał niezależnie od kartoteki i nazwy się
   * nie pokrywają). Bez tego ogniwa wynagrodzenia nie trafią do Analityki obiektu.
   */
  objectId: number | null;
  /** Rozwinięcie `objectId` doklejane przez API (null = brak mapowania). */
  object: HrObjectRef | null;
  /** Suma godzin z CAŁEJ historii — waga pozycji przy mapowaniu. */
  hoursTotal: number;
  /** Ilu różnych pracowników kiedykolwiek księgowało godziny na tej pozycji. */
  employeesCount: number;
}

/** Pracownik kadr w wersji do listy wyboru (bez danych płacowych). */
export interface HrEmployeeRef {
  id: number;
  fullName: string;
  kind: HrEmployeeKind;
  active: boolean;
}

export interface HrMonthNorm {
  id: number;
  year: number;
  month: number;
  workNorm: number;
  contractNorm: number;
}

export interface HrHoursEntry {
  id: number;
  employeeId: number;
  objectId: number | null;
  objectUncertain: boolean;
  year: number;
  month: number;
  nightHours: number | null;
  workedHours: number | null;
  uwHours: number | null;
  l4Hours: number | null;
  maxHours: number | null;
  deductions: number | null;
  bonuses: number | null;
  notes: string;
  employeeName: string;
  objectName: string;
}

export interface HrHoursInput {
  employeeId: number | string;
  objectId?: number | string | null;
  year: number;
  month: number;
  nightHours?: number | string | null;
  workedHours?: number | string | null;
  uwHours?: number | string | null;
  l4Hours?: number | string | null;
  maxHours?: number | string | null;
  deductions?: number | string | null;
  bonuses?: number | string | null;
  notes?: string;
}

export type HrContractType = "praca" | "zlecenie";
export type HrChannel = "przelew" | "gotowka";
export type HrBonusType =
  | "brak"
  | "gotowka"
  | "delegacja_przelew"
  | "delegacja_gotowka";

export interface HrContract {
  id: number;
  employeeId: number;
  company: string;
  contractType: HrContractType;
  chor: boolean;
  zua: string;
  zza: string;
  zwua: string;
  objectName: string;
  mainChannel: HrChannel;
  bonusType: HrBonusType;
  active: boolean;
  notes: string;
  employeeName: string;
}

export interface HrContractInput {
  employeeId: number | string;
  company: string;
  contractType: HrContractType;
  chor?: boolean;
  zua?: string;
  zza?: string;
  zwua?: string;
  objectName?: string;
  mainChannel: HrChannel;
  bonusType: HrBonusType;
  active?: boolean;
  notes?: string;
}

export interface HrPayrollInputs {
  mainAmount: number | null;
  bonusRate: number | null;
  bonusRatePending: boolean;
  rateAdjustment: number | null;
  maxHoursOverride: number | null;
  actualHoursOverride: number | null;
  bonusAmountOverride: number | null;
  notes: string;
}

export interface HrPayrollRow {
  contractId: number;
  employeeId: number;
  employeeName: string;
  company: string;
  contractType: HrContractType;
  chor: boolean;
  zua: string;
  zza: string;
  objectName: string;
  mainChannel: HrChannel;
  bonusType: HrBonusType;
  contractActive: boolean;
  registration: "zua" | "zza" | null;
  maxHoursSource: "override" | "individual" | "norm";
  maksGodziny: number;
  faktGodziny: number | null;
  godzinyDodatek: number;
  stawkaNetto: number | null;
  kwotaGlowna: number | null;
  kwotaWyrownania: number | null;
  kwotaDodatku: number | null;
  bonusPending: boolean;
  premiaPotracenie: number | null;
  dodatekFinalny: number | null;
  przelew: number;
  gotowka: number;
  wyplata: number;
  warnings: string[];
  inputs: HrPayrollInputs;
}

export interface HrPayrollSaveInput extends Partial<HrPayrollInputs> {
  contractId: number;
  year: number;
  month: number;
}

export interface HrOfficeRow {
  id: number;
  employeeId: number;
  employeeName: string;
  year: number;
  month: number;
  company: string;
  etatHours: number | null;
  uwL4: number | null;
  deductions: number | null;
  bonuses: number | null;
  hoursForAccounting: number | null;
  rate: number | null;
  amount: number | null;
  rorBase: number | null;
  cashOverride: number | null;
  notes: string;
  amountComputed: number | null;
  cash: number | null;
  total: number;
}

export interface HrOfficeInput {
  employeeId: number | string;
  year: number;
  month: number;
  company?: string;
  etatHours?: number | string | null;
  uwL4?: number | string | null;
  deductions?: number | string | null;
  bonuses?: number | string | null;
  hoursForAccounting?: number | string | null;
  rate?: number | string | null;
  amount?: number | string | null;
  rorBase?: number | string | null;
  cashOverride?: number | string | null;
  notes?: string;
}

export interface HrSummary {
  year: number;
  month: number;
  employeesWithHours: number;
  hoursEntries: number;
  totalHours: number;
  contractsCount: number;
  przelew: number;
  gotowka: number;
  wyplaty: number;
  missingMain: number;
  pendingBonus: number;
  officeTotal: number;
  officeCount: number;
}

export const getHrEmployees = (onlyActive = false) =>
  request<ApiResponse<HrEmployee[]>>(
    `/hr/employees${onlyActive ? "?active=true" : ""}`,
  );
export const createHrEmployee = (data: HrEmployeeInput) =>
  request<ApiResponse<HrEmployee>>("/hr/employees", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateHrEmployee = (id: number, data: HrEmployeeInput) =>
  request<ApiResponse<HrEmployee>>(`/hr/employees/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteHrEmployee = (id: number) =>
  request<ApiResponse<null>>(`/hr/employees/${id}`, { method: "DELETE" });

export const getHrObjects = (onlyActive = false) =>
  request<ApiResponse<HrObject[]>>(
    `/hr/objects${onlyActive ? "?active=true" : ""}`,
  );
export const createHrObject = (data: { name: string; active?: boolean }) =>
  request<ApiResponse<HrObject>>("/hr/objects", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateHrObject = (
  id: number,
  data: { name: string; active?: boolean },
) =>
  request<ApiResponse<HrObject>>(`/hr/objects/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteHrObject = (id: number) =>
  request<ApiResponse<null>>(`/hr/objects/${id}`, { method: "DELETE" });

/**
 * Ustawia (albo zdejmuje przy `null`) mapowanie pozycji kadrowej na obiekt
 * z kartoteki. Osobny endpoint od zapisu nazwy, żeby edycja nazwy nie czyściła
 * przypadkiem powiązania.
 */
export const setHrObjectMapping = (id: number, objectId: number | null) =>
  request<ApiResponse<HrObject>>(`/hr/objects/${id}/mapping`, {
    method: "PUT",
    body: JSON.stringify({ objectId }),
  });

/** Kartoteka obiektów do listy wyboru w mapowaniu (pod /hr — bez modułu Obiekty). */
export const getHrObjectCatalog = () =>
  request<ApiResponse<HrObjectRef[]>>("/hr/object-catalog");

/** Skrócona lista pracowników kadr — do powiązania handlowca / technika z listą płac. */
export const getHrEmployeeDirectory = (onlyActive = false) =>
  request<ApiResponse<HrEmployeeRef[]>>(
    `/hr/directory/employees${onlyActive ? "?active=true" : ""}`,
  );

export const getHrNorms = (year: number) =>
  request<ApiResponse<HrMonthNorm[]>>(`/hr/norms?year=${year}`);
export const saveHrNorm = (data: {
  year: number;
  month: number;
  workNorm: number | string;
  contractNorm: number | string;
}) =>
  request<ApiResponse<HrMonthNorm>>("/hr/norms", {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const getHrHours = (year: number, month: number) =>
  request<ApiResponse<HrHoursEntry[]>>(`/hr/hours?year=${year}&month=${month}`);
export const createHrHours = (data: HrHoursInput) =>
  request<ApiResponse<HrHoursEntry>>("/hr/hours", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateHrHours = (id: number, data: HrHoursInput) =>
  request<ApiResponse<HrHoursEntry>>(`/hr/hours/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteHrHours = (id: number) =>
  request<ApiResponse<null>>(`/hr/hours/${id}`, { method: "DELETE" });
// Przeniesienie aktywnych pracowników z poprzedniego miesiąca (puste wpisy
// z flagą objectUncertain); idempotentne — zwraca liczbę dodanych wierszy
export const carryOverHrHours = (year: number, month: number) =>
  request<ApiResponse<{ inserted: number }>>("/hr/hours/carry-over", {
    method: "POST",
    body: JSON.stringify({ year, month }),
  });

export const getHrContracts = (onlyActive = false) =>
  request<ApiResponse<HrContract[]>>(
    `/hr/contracts${onlyActive ? "?active=true" : ""}`,
  );
export const createHrContract = (data: HrContractInput) =>
  request<ApiResponse<HrContract>>("/hr/contracts", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateHrContract = (id: number, data: HrContractInput) =>
  request<ApiResponse<HrContract>>(`/hr/contracts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteHrContract = (id: number) =>
  request<ApiResponse<null>>(`/hr/contracts/${id}`, { method: "DELETE" });

export const getHrPayroll = (year: number, month: number) =>
  request<ApiResponse<HrPayrollRow[]>>(
    `/hr/payroll?year=${year}&month=${month}`,
  );
export const saveHrPayroll = (data: HrPayrollSaveInput) =>
  request<ApiResponse<unknown>>("/hr/payroll", {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const getHrOffice = (year: number, month: number) =>
  request<ApiResponse<HrOfficeRow[]>>(`/hr/office?year=${year}&month=${month}`);
export const createHrOffice = (data: HrOfficeInput) =>
  request<ApiResponse<HrOfficeRow>>("/hr/office", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateHrOffice = (id: number, data: HrOfficeInput) =>
  request<ApiResponse<HrOfficeRow>>(`/hr/office/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteHrOffice = (id: number) =>
  request<ApiResponse<null>>(`/hr/office/${id}`, { method: "DELETE" });

export const getHrSummary = (year: number, month: number) =>
  request<ApiResponse<HrSummary>>(`/hr/summary?year=${year}&month=${month}`);

// ---------------------------------------------------------------------------
// Magazyn (Techniczny -> Magazyn) — towary, magazyny, dokumenty, ruchy
// ---------------------------------------------------------------------------

export interface WarehouseItem {
  id: number;
  sku: string | null;
  name: string;
  category: string | null;
  unit: string;
  description: string | null;
  photoData: string | null;
  minStock: number | null;
  isAsset: boolean;
  barcode: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseItemInput {
  name: string;
  unit: string;
  sku?: string;
  category?: string;
  description?: string;
  minStock?: number | null;
  isAsset?: boolean;
  barcode?: string;
  photoData?: string | null;
  /** false = przywrócenie towaru z archiwum */
  isArchived?: boolean;
}

export type WarehouseType = "main" | "vehicle" | "employee" | "site" | "other";

export interface WarehouseDef {
  id: number;
  name: string;
  code: string | null;
  type: WarehouseType;
  parentId: number | null;
  isArchived: boolean;
  createdAt: string;
}

export interface WarehouseDefInput {
  name: string;
  code?: string;
  type: WarehouseType;
  parentId?: number | null;
  /** false = przywrócenie magazynu z archiwum */
  isArchived?: boolean;
}

export interface StockEntry {
  itemId: number;
  warehouseId: number;
  quantity: number;
}

export type WarehouseDocType = "PZ" | "WZ" | "RW" | "MM";
export type WarehouseDocStatus = "draft" | "confirmed" | "cancelled";

export interface WarehouseDocumentItem {
  id: number;
  documentId: number;
  itemId: number;
  itemName?: string;
  itemUnit?: string;
  quantity: number;
  unitPrice: number | null;
  positionNo: number;
}

export interface WarehouseDocument {
  id: number;
  docType: WarehouseDocType;
  docNumber: string | null;
  status: WarehouseDocStatus;
  warehouseFromId: number | null;
  warehouseToId: number | null;
  contractorName: string | null;
  invoiceNumber: string | null;
  invoiceFileName: string | null;
  hasInvoiceFile?: boolean;
  issuedAt: string;
  confirmedAt: string | null;
  notes: string | null;
  createdBy: string | null;
  itemCount?: number;
  warehouseFromName?: string | null;
  warehouseToName?: string | null;
  items?: WarehouseDocumentItem[];
}

export interface WarehouseDocumentItemInput {
  itemId: number;
  quantity: number;
  unitPrice?: number | null;
}

/**
 * Body dokumentu (POST i PUT). PUT szkicu = pełna podmiana nagłówka jak POST:
 * brak/null pola opcjonalnego czyści wartość — dlatego pola tekstowe wysyłamy
 * jawnie (`wartość || null`), nigdy przez pominięcie.
 */
export interface WarehouseDocumentInput {
  docType: WarehouseDocType;
  warehouseFromId?: number | null;
  warehouseToId?: number | null;
  contractorName?: string | null;
  invoiceNumber?: string | null;
  /** Wyjątek od pełnej podmiany: undefined = zachowaj załącznik (bez zmian),
   *  null = usuń istniejący, string = podmień. */
  invoiceFileName?: string | null;
  invoiceFileData?: string | null;
  issuedAt?: string;
  notes?: string | null;
  items: WarehouseDocumentItemInput[];
  /** true = zapisz i od razu zatwierdź atomowo (nadaje numer, księguje ruchy) */
  confirm?: boolean;
}

export interface WarehouseMovement {
  id: number;
  itemId: number;
  itemName: string;
  itemUnit: string;
  warehouseId: number;
  warehouseName: string;
  quantityDelta: number;
  documentId: number;
  docNumber: string | null;
  docType: WarehouseDocType | null;
  createdAt: string;
  createdBy: string | null;
}

export const warehouseApi = {
  // Towary (kartoteka)
  async getItems(includeArchived = false) {
    return request<ApiResponse<WarehouseItem[]>>(
      `/warehouse/items${includeArchived ? "?includeArchived=1" : ""}`
    );
  },

  async createItem(data: WarehouseItemInput) {
    return request<ApiResponse<WarehouseItem>>("/warehouse/items", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /** PUT = pełna podmiana kartoteki (backend waliduje komplet pól). */
  async updateItem(id: number, data: WarehouseItemInput) {
    return request<ApiResponse<WarehouseItem>>(`/warehouse/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  /** DELETE = archiwizacja towaru (nie usuwa historii) */
  async archiveItem(id: number) {
    return request<ApiResponse<null>>(`/warehouse/items/${id}`, {
      method: "DELETE",
    });
  },

  // Magazyny
  async getWarehouses() {
    return request<ApiResponse<WarehouseDef[]>>("/warehouse/warehouses");
  },

  async createWarehouse(data: WarehouseDefInput) {
    return request<ApiResponse<WarehouseDef>>("/warehouse/warehouses", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /** PUT = pełna podmiana definicji magazynu (backend waliduje komplet pól). */
  async updateWarehouse(id: number, data: WarehouseDefInput) {
    return request<ApiResponse<WarehouseDef>>(`/warehouse/warehouses/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  /** DELETE = archiwizacja magazynu (400 przy niezerowym stanie) */
  async archiveWarehouse(id: number) {
    return request<ApiResponse<null>>(`/warehouse/warehouses/${id}`, {
      method: "DELETE",
    });
  },

  // Stany (tylko niezerowe wpisy)
  async getStock() {
    return request<ApiResponse<StockEntry[]>>("/warehouse/stock");
  },

  // Dokumenty
  async getDocuments(params?: {
    type?: string;
    status?: string;
    /** Maks. liczba dokumentów (backend domyślnie 500). */
    limit?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set("type", params.type);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const query = searchParams.toString();
    return request<ApiResponse<WarehouseDocument[]>>(
      `/warehouse/documents${query ? `?${query}` : ""}`
    );
  },

  async getDocument(id: number) {
    return request<ApiResponse<WarehouseDocument>>(`/warehouse/documents/${id}`);
  },

  async getDocumentInvoice(id: number) {
    return request<ApiResponse<{ fileName: string; data: string }>>(
      `/warehouse/documents/${id}/invoice`
    );
  },

  async createDocument(data: WarehouseDocumentInput) {
    return request<ApiResponse<WarehouseDocument>>("/warehouse/documents", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /**
   * PUT szkicu = pełna podmiana nagłówka i pozycji; `confirm: true` = zapisz
   * i zatwierdź atomowo w jednej transakcji (błąd stanu → nic nie zapisane).
   */
  async updateDocument(id: number, data: WarehouseDocumentInput) {
    return request<ApiResponse<WarehouseDocument>>(
      `/warehouse/documents/${id}`,
      { method: "PUT", body: JSON.stringify(data) }
    );
  },

  async confirmDocument(id: number) {
    return request<ApiResponse<WarehouseDocument>>(
      `/warehouse/documents/${id}/confirm`,
      { method: "POST" }
    );
  },

  /** Storno zatwierdzonego dokumentu */
  async cancelDocument(id: number) {
    return request<ApiResponse<WarehouseDocument>>(
      `/warehouse/documents/${id}/cancel`,
      { method: "POST" }
    );
  },

  /** Usuwanie tylko szkiców */
  async deleteDocument(id: number) {
    return request<ApiResponse<null>>(`/warehouse/documents/${id}`, {
      method: "DELETE",
    });
  },

  // Ruchy magazynowe
  async getMovements(params?: {
    itemId?: number;
    warehouseId?: number;
    limit?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.itemId) searchParams.set("itemId", String(params.itemId));
    if (params?.warehouseId)
      searchParams.set("warehouseId", String(params.warehouseId));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const query = searchParams.toString();
    return request<ApiResponse<WarehouseMovement[]>>(
      `/warehouse/movements${query ? `?${query}` : ""}`
    );
  },
};

// --- ADMIN: zarządzanie użytkownikami ---
export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: "user" | "admin";
  permissions: Record<string, "view" | "edit">;
  version: number;
  createdAt?: string;
}

export interface AdminTabDef {
  key: string;
  label: string;
  group: string;
}

export const getAdminTabs = () =>
  request<ApiResponse<AdminTabDef[]>>("/admin/tabs");

export const getAdminUsers = () =>
  request<ApiResponse<AdminUser[]>>("/admin/users");

export interface AdminCreateUserInput {
  email: string;
  password: string;
  displayName?: string;
  role?: "user" | "admin";
  permissions?: Record<string, "view" | "edit">;
}

export const createAdminUser = (data: AdminCreateUserInput) =>
  request<ApiResponse<AdminUser>>("/admin/users", {
    method: "POST",
    body: JSON.stringify(data),
  });

export interface AdminUpdateUserInput {
  displayName?: string;
  role?: "user" | "admin";
  permissions?: Record<string, "view" | "edit">;
  /** Wersja wczytana przez klienta — backend odrzuci zapis (409), jeśli w
   *  międzyczasie ktoś inny zmienił tego użytkownika (optimistic concurrency). */
  expectedVersion?: number;
}

export const updateAdminUser = (id: number, data: AdminUpdateUserInput) =>
  request<ApiResponse<AdminUser>>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const setAdminUserPassword = (id: number, password: string) =>
  request<ApiResponse<null>>(`/admin/users/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });

export const deleteAdminUser = (id: number) =>
  request<ApiResponse<null>>(`/admin/users/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Kalendarz (dział techniczny) + globalny activity_log
// ---------------------------------------------------------------------------

export type CalendarEventType =
  | "serwis"
  | "montaz"
  | "wizja"
  | "demontaz"
  | "biuro"
  | "przygotowanie"
  | "konserwacja"
  | "urlop";

export type CalendarEventStatus = "planned" | "confirmed" | "done" | "cancelled";

/** Rozliczenie wydarzenia (null = nie dotyczy). */
export type CalendarBilling = "warranty" | "free" | "paid";

/** Skrót protokołu przypiętego do wydarzenia (jawnie `protocolId` albo protokół realizacji). */
export interface CalendarEventProtocol {
  id: number;
  number: string;
  status: "draft" | "final";
  signedAt: string | null;
  workDate?: string;
}

/**
 * Skrót realizacji powiązanej z wydarzeniem (`calendar_events.realization_id`).
 * Brak pola w odpowiedzi = starszy backend (traktujemy jak `null`).
 */
export interface CalendarEventRealization {
  id: number;
  /** YYYY-MM-DD */
  date: string;
  site: string;
  kind: RealizationKind;
  invoiced: boolean;
  /** Suma netto (amountHours + amountMaterial + amountKm - discount). */
  total: number;
}

/**
 * Skrót wyceny przypiętej do wydarzenia (jawnie `quoteId` albo wycena realizacji).
 * Powstaje automatycznie dla prac PŁATNYCH — patrz src/lib/calendar-realizations.ts.
 */
export interface CalendarEventQuote {
  id: number;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  /** Suma netto pozycji (ilość × cena). */
  total: number;
  /** Liczba pozycji z wpisaną ilością — 0 = wycena pusta (szkic z cennika). */
  filledItems: number;
}

export type CalendarSeriesFreq =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "yearly";

export interface CalendarSeries {
  id: number;
  freq: CalendarSeriesFreq;
  interval: number;
  until: string | null;
  count: number | null;
}

export interface CalendarRecurrenceInput {
  freq: CalendarSeriesFreq;
  interval?: number;
  until?: string | null;
  count?: number | null;
}

export interface CalendarEventTechnician {
  id: number;
  firstName: string;
  lastName: string;
}

export interface CalendarEvent {
  id: number;
  type: CalendarEventType;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO lokalny bez strefy: "YYYY-MM-DDTHH:MM" (all-day: "YYYY-MM-DD"). */
  startAt: string;
  /** Dla all-day koniec jest EXCLUSIVE (jak w FullCalendar). */
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  department: string;
  objectId: number | null;
  objectName: string | null;
  orderId: number | null;
  realizationId: number | null;
  /** Rozliczenie: warranty | free | paid | null. Brak = null (starszy backend). */
  billing?: CalendarBilling | null;
  /** Jawnie przypięty protokół (null → protokół realizacji, jeśli jest). */
  protocolId?: number | null;
  /** Wyliczone przez backend: protokół z `protocolId` albo z realizacji. */
  protocol?: CalendarEventProtocol | null;
  /** Skrót realizacji z `realizationId`. Brak pola = starszy backend. */
  realization?: CalendarEventRealization | null;
  /** Jawnie przypięta wycena (null → wycena realizacji, jeśli jest). */
  quoteId?: number | null;
  /** Wyliczone przez backend: wycena z `quoteId` albo z realizacji. */
  quote?: CalendarEventQuote | null;
  /** `true` = realizacja została ręcznie odpięta; automat jej nie odtworzy. */
  realizationOptout: boolean;
  technicians: CalendarEventTechnician[];
  createdBy: number | null;
  createdByLabel: string | null;
  updatedBy: number | null;
  updatedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  seriesId: number | null;
  series?: CalendarSeries | null;
  /** Opcjonalnie od backendu: pozycja wystąpienia w serii (badge "5/8"). */
  seriesIndex?: number;
  seriesTotal?: number;
  /** Tylko w odpowiedzi POST z recurrence. */
  occurrencesCount?: number;
  /** Liczba notatek (lista + szczegóły). Brak = 0 (starszy backend). */
  notesCount?: number;
  /** Notatki — tylko w GET /calendar/events/:id. */
  notes?: CalendarNote[];
}

export type CalendarNoteSource = "user" | "assistant" | "system";

/** Notatka do wydarzenia (dziennik) — osobna od `description` (stały opis). */
export interface CalendarNote {
  id: number;
  eventId: number;
  userId: number | null;
  userLabel: string | null;
  source: CalendarNoteSource;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventWithHistory extends CalendarEvent {
  history: ActivityEntry[];
}

export interface CalendarEventInput {
  type: CalendarEventType;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status?: CalendarEventStatus;
  objectId?: number | null;
  orderId?: number | null;
  /** Ręczne podpięcie (id realizacji) / odpięcie (`null`). */
  realizationId?: number | null;
  /** `true` = nie twórz realizacji automatem (ustawiane przez „Odepnij”); `false` = włącz automat. */
  realizationOptout?: boolean;
  /** Rozliczenie (null = nie dotyczy; ignorowane dla urlop/biuro/przygotowanie). */
  billing?: CalendarBilling | null;
  /** Jawnie przypięty protokół (null = odepnij → protokół realizacji / brak). */
  protocolId?: number | null;
  /** Jawnie przypięta wycena (null = odepnij → wycena realizacji / brak). */
  quoteId?: number | null;
  technicianIds: number[];
  recurrence?: CalendarRecurrenceInput | null;
}

export interface CalendarMoveInput {
  startAt: string;
  endAt: string;
  allDay: boolean;
}

/** Zakres operacji na wystąpieniu serii. */
export type CalendarSeriesScope = "this" | "future" | "all";

export type ActivityAction =
  | "created"
  | "updated"
  | "deleted"
  | "restored"
  | "moved"
  | "assigned"
  | "unassigned"
  | "status_changed"
  | "note_added"
  | "note_updated"
  | "note_deleted";

export interface ActivityEventRef {
  id: number;
  title: string;
  type: CalendarEventType;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
  deletedAt: string | null;
}

export interface ActivityEntry {
  id: number;
  entityType: string;
  entityId: number;
  objectId: number | null;
  userId: number | null;
  userLabel: string | null;
  action: ActivityAction | string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  summary: string | null;
  createdAt: string;
  event?: ActivityEventRef | null;
}

export interface CalendarEventsQuery {
  from: string;
  to: string;
  type?: CalendarEventType[];
  /** Jeden technik albo lista (backend przyjmuje "1,2,3"). */
  technicianId?: number | number[];
  objectId?: number;
  status?: CalendarEventStatus | CalendarEventStatus[];
  /** Rozliczenie; "none" = bez rozliczenia (NULL). */
  billing?: (CalendarBilling | "none")[];
  /** "with" = z protokołem, "without" = wykonane prace bez protokołu. */
  protocol?: "with" | "without";
  includeDeleted?: boolean;
}

export interface CalendarConflictsQuery {
  technicianIds: number[];
  startAt: string;
  endAt: string;
  excludeId?: number;
}

/** Kolizja z GET /calendar/conflicts — `conflictKind: "urlop"` = technik na urlopie. */
export interface CalendarConflict extends CalendarEvent {
  conflictKind: "urlop" | "event";
}

/** Urlopy technika w zakresie (GET /calendar/availability). */
export interface TechnicianLeave {
  eventId: number;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: CalendarEventStatus;
}

export interface TechnicianAvailability {
  technicianId: number;
  firstName: string;
  lastName: string;
  leaves: TechnicianLeave[];
}

const scopeQuery = (scope?: CalendarSeriesScope) =>
  scope && scope !== "this" ? `?scope=${scope}` : "";

export const calendarApi = {
  async getEvents(params: CalendarEventsQuery) {
    const sp = new URLSearchParams();
    sp.set("from", params.from);
    sp.set("to", params.to);
    if (params.type?.length) sp.set("type", params.type.join(","));
    const techs = Array.isArray(params.technicianId) ? params.technicianId : params.technicianId ? [params.technicianId] : [];
    if (techs.length) sp.set("technicianId", techs.join(","));
    if (params.objectId) sp.set("objectId", String(params.objectId));
    const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
    if (statuses.length) sp.set("status", statuses.join(","));
    if (params.billing?.length) sp.set("billing", params.billing.join(","));
    if (params.protocol) sp.set("protocol", params.protocol);
    if (params.includeDeleted) sp.set("includeDeleted", "1");
    return request<ApiResponse<CalendarEvent[]>>(
      `/calendar/events?${sp.toString()}`
    );
  },

  async getEvent(id: number) {
    return request<ApiResponse<CalendarEventWithHistory>>(
      `/calendar/events/${id}`
    );
  },

  async create(data: CalendarEventInput) {
    return request<ApiResponse<CalendarEvent>>("/calendar/events", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /** PUT = pełna aktualizacja; `scope` tylko dla wystąpień serii. */
  async update(id: number, data: CalendarEventInput, scope?: CalendarSeriesScope) {
    return request<ApiResponse<CalendarEvent>>(
      `/calendar/events/${id}${scopeQuery(scope)}`,
      { method: "PUT", body: JSON.stringify(data) }
    );
  },

  /** Drag&drop / resize w kalendarzu. */
  async move(id: number, data: CalendarMoveInput) {
    return request<ApiResponse<CalendarEvent>>(`/calendar/events/${id}/move`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  /** Soft delete; `scope` tylko dla wystąpień serii. */
  async remove(id: number, scope?: CalendarSeriesScope) {
    return request<ApiResponse<null>>(
      `/calendar/events/${id}${scopeQuery(scope)}`,
      { method: "DELETE" }
    );
  },

  async restore(id: number) {
    return request<ApiResponse<CalendarEvent>>(
      `/calendar/events/${id}/restore`,
      { method: "POST" }
    );
  },

  /** Kolizje terminów techników (ostrzeżenie, nie blokada). */
  async conflicts(params: CalendarConflictsQuery) {
    const sp = new URLSearchParams();
    sp.set("technicianIds", params.technicianIds.join(","));
    sp.set("startAt", params.startAt);
    sp.set("endAt", params.endAt);
    if (params.excludeId) sp.set("excludeId", String(params.excludeId));
    return request<ApiResponse<CalendarConflict[]>>(
      `/calendar/conflicts?${sp.toString()}`
    );
  },

  /** Urlopy techników nachodzące na zakres [from, to) — do oznaczania w dialogu. */
  async availability(from: string, to: string) {
    const sp = new URLSearchParams({ from, to });
    return request<ApiResponse<TechnicianAvailability[]>>(
      `/calendar/availability?${sp.toString()}`
    );
  },

  async objectEvents(objectId: number) {
    return request<ApiResponse<CalendarEvent[]>>(
      `/calendar/objects/${objectId}/events`
    );
  },

  // --- Notatki (dziennik wydarzenia) — zapisywane od razu, niezależnie od formularza ---

  async notes(eventId: number) {
    return request<ApiResponse<CalendarNote[]>>(`/calendar/events/${eventId}/notes`);
  },

  async addNote(eventId: number, text: string) {
    return request<ApiResponse<CalendarNote>>(`/calendar/events/${eventId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },

  /** Autor lub admin. */
  async updateNote(noteId: number, text: string) {
    return request<ApiResponse<CalendarNote>>(`/calendar/notes/${noteId}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    });
  },

  /** Soft delete; autor lub admin. */
  async deleteNote(noteId: number) {
    return request<ApiResponse<null>>(`/calendar/notes/${noteId}`, { method: "DELETE" });
  },

  /** Bieżący token ICS (null, jeśli jeszcze nie wygenerowano) — bez rotacji. */
  async getFeedToken() {
    return request<ApiResponse<{ token: string; url: string } | null>>(
      "/calendar/feed-token"
    );
  },

  /** Generuje / rotuje token subskrypcji ICS dla zalogowanego użytkownika. */
  async feedToken() {
    return request<ApiResponse<{ token: string; url: string }>>(
      "/calendar/feed-token",
      { method: "POST" }
    );
  },
};

// ---------------------------------------------------------------------------
// Zapisane zestawy filtrów kalendarza (per użytkownik) — /calendar/filter-sets
// ---------------------------------------------------------------------------

/**
 * Filtry zapisane w zestawie — te same klucze, co localStorage `alfa.calendar.filters`,
 * plus opcjonalnie widok i weekendy (zapisywane tylko gdy user zaznaczy checkbox).
 * Backend waliduje białą listą i wycina nieznane klucze/wartości.
 */
export interface CalendarFilterSetFilters {
  types: CalendarEventType[];
  statuses: CalendarEventStatus[];
  billings: (CalendarBilling | "none")[];
  technicianIds: number[];
  protocol: "" | "with" | "without";
  realization: "" | "with" | "without";
  /** "dayGridMonth" | "timeGridWeek" | "timeGridDay" | "listWeek" | "board" */
  view?: string;
  weekends?: boolean;
}

export interface CalendarFilterSet {
  id: number;
  name: string;
  filters: CalendarFilterSetFilters;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Limit zestawów na użytkownika (musi zgadzać się z MAX_FILTER_SETS na backendzie). */
export const CALENDAR_FILTER_SET_LIMIT = 20;
/** Maksymalna długość nazwy zestawu (backend: FILTER_SET_NAME_MAX). */
export const CALENDAR_FILTER_SET_NAME_MAX = 60;

export const calendarFilterSetsApi = {
  async list() {
    return request<ApiResponse<CalendarFilterSet[]>>("/calendar/filter-sets");
  },

  async create(payload: { name: string; filters: CalendarFilterSetFilters; isDefault?: boolean }) {
    return request<ApiResponse<CalendarFilterSet>>("/calendar/filter-sets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** Częściowa aktualizacja: nazwa (zmiana nazwy) i/lub filters (nadpisanie bieżącymi). */
  async update(
    id: number,
    payload: { name?: string; filters?: CalendarFilterSetFilters; isDefault?: boolean; sortOrder?: number }
  ) {
    return request<ApiResponse<CalendarFilterSet>>(`/calendar/filter-sets/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },

  async remove(id: number) {
    return request<ApiResponse<{ id: number }>>(`/calendar/filter-sets/${id}`, { method: "DELETE" });
  },

  /** Ustawia zestaw jako domyślny (odznacza pozostałe); zwraca całą, świeżą listę. */
  async setDefault(id: number) {
    return request<ApiResponse<CalendarFilterSet[]>>(`/calendar/filter-sets/${id}/default`, {
      method: "POST",
    });
  },
};

export const activityApi = {
  async object(objectId: number, limit = 100) {
    return request<ApiResponse<ActivityEntry[]>>(
      `/activity/object/${objectId}?limit=${limit}`
    );
  },

  async recent(limit = 50) {
    return request<ApiResponse<ActivityEntry[]>>(
      `/activity/recent?limit=${limit}`
    );
  },
};

// ---------------------------------------------------------------------------
// Asystent kalendarza (admin-only) — kontrakt: scratchpad/ASSISTANT_CONTRACT.md
// ---------------------------------------------------------------------------

export interface AssistantStatus {
  configured: boolean;
  model: string;
  keySource: "env" | "file" | "db" | null;
  /** Czy asystent jest włączony w ustawieniach administracyjnych. */
  enabled?: boolean;
  /** Czy bieżący użytkownik ma dostęp do asystenta (admin lub edytor kalendarza wg `access`). */
  allowed?: boolean;
  /** Czytelny powód, gdy `configured === false` lub `enabled === false`. */
  reason?: string;
  persona?: { name: string; greeting: string; suggestions: string[] };
  access?: "admins" | "calendar_editors";
  /** Limit kroków narzędzi w jednej turze (do wiersza „Krok n/max”); brak → front zakłada 8. */
  maxSteps?: number;
  /** Maksymalna długość wiadomości użytkownika (znaki); brak → 4000. */
  messageMaxChars?: number;
  turnTimeoutMs?: number;
  /** Technik dopasowany do bieżącego użytkownika (imię i nazwisko) — „Przypisz mnie”; null gdy brak. */
  technicianId?: number | null;
}

export interface AssistantChat {
  id: number;
  title: string | null;
  updatedAt: string;
}

/** Wynik `propose_event` (output tool-parta) — NIE zapisany event, tylko propozycja. */
export interface AssistantProposal extends CalendarEventInput {
  objectName?: string | null;
  technicianNames?: string[];
  /** Liczba notatek istniejącego wydarzenia (propozycje edycji); brak = 0. */
  notesCount?: number;
}

export interface AssistantProposalOutput {
  proposal?: AssistantProposal;
  needsConfirmation?: boolean;
  error?: string;
}

/** Opcja pytania `ask_choice` — przycisk w karcie wyboru. */
export interface AssistantChoiceOption {
  label: string;
  /** Tekst wysyłany jako odpowiedź (domyślnie label). */
  value?: string;
  /** Drobny opis pod etykietą (dla obiektów: adres, miasto). */
  hint?: string;
  /** Id obiektu z find_object — podgląd karty obiektu. */
  objectId?: number;
  /** Id technika (opcja „wybierz technika”). */
  technicianId?: number;
  /** Zakres slotu (opcje z find_free_slots) — front podświetla termin na siatce. */
  startAt?: string;
  endAt?: string;
  /**
   * Gotowa akcja (kontrakt ASSISTANT_CHOICE_ACTION_CONTRACT.md): klik wystawia kartę
   * zmiany/propozycji od razu przez POST /choose, bez drugiej tury modelu.
   */
  action?: AssistantChoiceAction;
  /** Podgląd wyniku akcji (change → resolved[0]; event → proposal) — do skrótu pod etykietą. */
  actionPreview?: AssistantResolvedChange | AssistantProposal;
  /** Akcja odrzucona przez backend (opcja zachowuje się jak zwykła). */
  actionError?: string;
}

/** Akcja przypięta do opcji `ask_choice`. */
export type AssistantChoiceAction =
  | { kind: "change"; change: AssistantChange }
  | { kind: "event"; event: CalendarEventInput };

/** Wiadomość UI (ai@7 UIMessage) zwracana przez backend — typ luźny, jak w `messages()`. */
export interface AssistantUIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
}

/** Odpowiedź POST /assistant/chats/:id/choose. */
export type AssistantChooseResult =
  | { fallback: true }
  | { fallback?: false; userMessage: AssistantUIMessage; assistantMessage: AssistantUIMessage };

/** Wynik `show_events` — karta listy wydarzeń (elementy w kształcie `AssistantBriefEvent`, jak list_events/search_events). */
export interface AssistantShowEventsOutput {
  events: AssistantBriefEvent[];
  title: string | null;
  note: string | null;
  count: number;
  suggestActions: boolean;
  /** Id z wejścia, których nie znaleziono. */
  missing?: number[];
  /** Zestawienie: sekcje karty (null = płaska lista). */
  groupBy?: AssistantShowEventsGroupBy | null;
  /** Zakres zestawienia do nagłówka (`to` exclusive). */
  range?: { from: string; to: string } | null;
}

export type AssistantShowEventsGroupBy = "day" | "technician" | "object" | "type";

/** Szybka akcja z karty listy wydarzeń (POST /assistant/chats/:id/quick-change). `assign_me` = dopisz mnie do techników. */
export type AssistantQuickChangeKind = "done" | "cancel" | "confirm" | "restore" | "delete" | "assign_me";

export interface AssistantQuickChangeBody {
  eventId: number;
  kind: AssistantQuickChangeKind;
  note?: string;
  fromToolCallId?: string;
}

/** Błąd API asystenta z kodem z backendu (`forbidden` / `invalid` / `busy`). */
export class AssistantApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AssistantApiError";
    this.status = status;
    this.code = code;
  }
}

/** Wynik `ask_choice` — karta pytania z przyciskami. */
export interface AssistantChoiceOutput {
  awaitingUserChoice?: boolean;
  question: string;
  options: AssistantChoiceOption[];
  allowCustom?: boolean;
  multi?: boolean;
}

/** Wynik `check_conflicts` — ostrzeżenia przy karcie propozycji. */
export interface AssistantConflict {
  id: number;
  title: string;
  type: string;
  startAt: string;
  endAt: string;
  kind: "event" | "urlop";
  technicians?: string[] | { id: number; name: string }[];
}

// --- Modyfikacje istniejących wydarzeń (`propose_changes`) — kontrakt: ASSISTANT_UPDATES_CONTRACT.md ---

/** Skrót wydarzenia w wyniku `propose_changes` (before/after). Pola opcjonalne — kodujemy defensywnie. */
export interface AssistantBriefEvent {
  id?: number;
  title?: string;
  type?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  status?: string;
  objectId?: number | null;
  objectName?: string | null;
  location?: string | null;
  description?: string | null;
  technicianIds?: number[];
  /** Backend: `technicians: {id,name}[]`; starsze kształty: `technicianNames`. */
  technicians?: { id: number; name: string }[];
  technicianNames?: string[];
  seriesId?: number | null;
  deleted?: boolean;
  deletedAt?: string | null;
  /** Liczba notatek (brak = 0). */
  notesCount?: number;
  /** Rozliczenie (warranty | free | paid | null). */
  billing?: CalendarBilling | null;
  /** Skrót protokołu (list_events/get_event: `signed` boolean; propose_changes: `signedAt`). */
  protocol?: { id: number; number: string; status: "draft" | "final"; signedAt?: string | null; signed?: boolean } | null;
}

export type AssistantChangeKind = "update" | "status" | "cancel" | "delete" | "restore" | "create" | "note";

export interface AssistantChangePatch {
  title?: string;
  type?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  objectId?: number | null;
  location?: string | null;
  description?: string | null;
  technicianIds?: number[];
  status?: string;
  billing?: CalendarBilling | null;
}

/** Surowa zmiana (wejście narzędzia `propose_changes`; po edycji — override do apply-changes). */
export type AssistantChange =
  | { kind: "update"; eventId: number; patch: AssistantChangePatch; reason?: string }
  | { kind: "status"; eventId: number; status: "confirmed" | "done" | "cancelled"; actualStartAt?: string; actualEndAt?: string; note?: string; reason?: string }
  | { kind: "cancel"; eventId: number; reason?: string }
  | { kind: "delete"; eventId: number; reason?: string }
  | { kind: "restore"; eventId: number }
  | { kind: "note"; eventId: number; text: string }
  | { kind: "create"; event: CalendarEventInput & { objectName?: string | null; technicianNames?: string[] }; reason?: string };

export interface AssistantChangeDiff {
  field: string;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
}

/** Zmiana po walidacji backendu (output `propose_changes.changes[]`). */
export interface AssistantResolvedChange {
  index: number;
  kind: AssistantChangeKind;
  eventId?: number | null;
  before?: AssistantBriefEvent | null;
  after?: AssistantBriefEvent | null;
  diff?: AssistantChangeDiff[];
  summary?: string;
  warnings?: string[];
  error?: string | null;
  /** Surowa zmiana (jeśli backend ją odsyła — do „Edytuj”/override). */
  change?: AssistantChange;
  reason?: string;
  note?: string;
}

export interface AssistantChangesOutput {
  needsConfirmation?: boolean;
  changes?: AssistantResolvedChange[];
  note?: string;
  error?: string;
}

export interface AssistantApplyResult {
  index: number;
  ok: boolean;
  event?: CalendarEvent;
  error?: string;
}

/** Decyzja użytkownika wobec karty propozycji (POST /assistant/chats/:id/system). */
export interface AssistantSystemNote {
  kind: "saved" | "rejected" | "edited" | "applied";
  eventId?: number;
  title?: string;
  /** toolCallId karty propozycji — jednoznaczne dopasowanie decyzji do karty. */
  toolCallId?: string;
  /** Indeks pozycji w karcie zmian (`propose_changes`). */
  changeIndex?: number;
  /** Gotowy tekst (fallback dla starszego backendu; nowy buduje go sam). */
  text?: string;
}

/** Tekst notatki systemowej w formacie, który rozumie także starszy backend/front. */
export function systemNoteText(n: AssistantSystemNote): string {
  const t = n.title?.trim() ?? "";
  if (n.kind === "rejected") return n.changeIndex != null ? `Użytkownik odrzucił zmianę${t ? `: ${t}` : ""}` : `Użytkownik odrzucił propozycję${t ? `: ${t}` : ""}`;
  if (n.kind === "applied") return `Zmiana zastosowana${n.eventId != null ? ` (#${n.eventId})` : ""}${t ? `: ${t}` : ""}`;
  if (n.kind === "edited" && n.changeIndex != null) return `Wydarzenie ${n.eventId != null ? `#${n.eventId} ` : ""}zmienione po edycji${t ? `: ${t}` : ""}`;
  const ev = n.eventId != null ? `#${n.eventId} ` : "";
  return `Wydarzenie ${ev}zapisane${n.kind === "edited" ? " po edycji" : ""}${t ? `: ${t}` : ""}`;
}

/**
 * Tolerancyjny request: backend asystenta może zwracać `{ success, data }`
 * (konwencja alfa) albo goły obiekt/tablicę (konwencja AI SDK). Obsługujemy oba.
 */
async function assistantRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (body && typeof body === "object" && (body.error || body.message)) || `Request failed (${response.status})`
    );
  }
  if (body && typeof body === "object" && !Array.isArray(body) && "success" in body) {
    if (!body.success) throw new Error(body.error || "Request failed");
    return body.data as T;
  }
  return body as T;
}

export const assistantApi = {
  /** Ścieżka streamu dla `DefaultChatTransport` (useChat). */
  messageUrl(chatId: number) {
    return `${API_BASE}/assistant/chats/${chatId}/message`;
  },
  async status() {
    return assistantRequest<AssistantStatus>("/assistant/status");
  },
  async listChats() {
    const r = await assistantRequest<AssistantChat[] | { chats: AssistantChat[] }>("/assistant/chats");
    return Array.isArray(r) ? r : r.chats ?? [];
  },
  async createChat(title?: string) {
    return assistantRequest<AssistantChat>("/assistant/chats", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
  },
  async deleteChat(id: number) {
    return assistantRequest<unknown>(`/assistant/chats/${id}`, { method: "DELETE" });
  },
  /** Przerwanie tury po stronie serwera (obok `stop()` z useChat, który tylko zrywa stream). */
  async stop(chatId: number) {
    return assistantRequest<unknown>(`/assistant/chats/${chatId}/stop`, { method: "POST", body: "{}" }).catch(() => undefined);
  },
  /** UIMessage[] (z parts) — typ luźny, bo `ai` definiuje go generycznie. */
  async messages(chatId: number) {
    const r = await assistantRequest<unknown[] | { messages: unknown[] }>(`/assistant/chats/${chatId}/messages`);
    return Array.isArray(r) ? r : r.messages ?? [];
  },
  /**
   * Dopisuje notatkę systemową o decyzji użytkownika (Zatwierdź / Edytuj→Zapisz / Odrzuć).
   * Nowy kontrakt: `{ kind, eventId?, title? }` — serwer sam buduje tekst i part `data-system`.
   * Dla zgodności ze starszym backendem wysyłamy też gotowy `text`.
   */
  async system(chatId: number, note: AssistantSystemNote) {
    return assistantRequest<unknown>(`/assistant/chats/${chatId}/system`, {
      method: "POST",
      body: JSON.stringify({ ...note, text: note.text ?? systemNoteText(note) }),
    });
  },
  /**
   * Zatwierdzenie pozycji z karty `propose_changes` — backend wykonuje zmiany przez logikę
   * kalendarza (każda w osobnej transakcji) i dopisuje notatki `data-system {kind:"applied"}`.
   */
  async applyChanges(chatId: number, toolCallId: string, indexes: number[], overrides?: Record<number, AssistantChange>): Promise<AssistantApplyResult[]> {
    const r = await assistantRequest<{ results?: AssistantApplyResult[] } | AssistantApplyResult[]>(`/assistant/apply-changes`, {
      method: "POST",
      body: JSON.stringify({ chatId, toolCallId, indexes, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) }),
    });
    const results = Array.isArray(r) ? r : Array.isArray(r?.results) ? r.results : [];
    return results.map((x, i) => ({ index: typeof x?.index === "number" ? x.index : indexes[i], ok: Boolean(x?.ok), event: x?.event, error: x?.error }));
  },
  /**
   * Wybór opcji `ask_choice` z gotową `action` — backend bez modelu dopisuje wiadomość
   * użytkownika i asystenta z kartą (`tool-propose_changes` / `tool-propose_event`,
   * toolCallId `local_*`). `{ fallback: true }` → wyślij wybór zwykłą ścieżką (sendMessage).
   */
  async choose(chatId: number, toolCallId: string, optionIndex: number, optionLabel?: string): Promise<AssistantChooseResult> {
    const r = await assistantRequest<AssistantChooseResult | null>(`/assistant/chats/${chatId}/choose`, {
      method: "POST",
      body: JSON.stringify({ toolCallId, optionIndex, ...(optionLabel ? { optionLabel } : {}) }),
    });
    return normalizeChooseResult(r);
  },
  /**
   * Szybka akcja z karty listy wydarzeń („Wykonane” / „Anuluj”) — backend bez modelu dopisuje
   * wiadomość użytkownika i asystenta z kartą `propose_changes` (jak /choose). `{ fallback: true }`
   * → wyślij polecenie zwykłą ścieżką. Błędy: `AssistantApiError` z `code` (forbidden / invalid / busy).
   */
  async quickChange(chatId: number, body: AssistantQuickChangeBody): Promise<AssistantChooseResult> {
    const response = await fetch(`${API_BASE}/assistant/chats/${chatId}/quick-change`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw: unknown = await response.json().catch(() => null);
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const codeOf = (o: Record<string, unknown> | null) => (o && typeof o.code === "string" ? o.code : undefined);
    if (!response.ok) {
      const msg = (obj && (typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : "")) || `Request failed (${response.status})`;
      throw new AssistantApiError(msg, response.status, codeOf(obj));
    }
    if (obj && "success" in obj) {
      if (!obj.success) throw new AssistantApiError(typeof obj.error === "string" ? obj.error : "Request failed", response.status, codeOf(obj));
      return normalizeChooseResult(obj.data as AssistantChooseResult | null);
    }
    return normalizeChooseResult(raw as AssistantChooseResult | null);
  },
};

/** Odpowiedź /choose i /quick-change → para wiadomości albo `{ fallback: true }`. */
function normalizeChooseResult(r: AssistantChooseResult | null | undefined): AssistantChooseResult {
  if (!r || typeof r !== "object") return { fallback: true };
  if ("fallback" in r && r.fallback) return { fallback: true };
  const ok = r as { userMessage?: AssistantUIMessage; assistantMessage?: AssistantUIMessage };
  if (!ok.userMessage || !ok.assistantMessage) return { fallback: true };
  return {
    userMessage: { ...ok.userMessage, id: String(ok.userMessage.id) },
    assistantMessage: { ...ok.assistantMessage, id: String(ok.assistantMessage.id) },
  };
}

// ---------------------------------------------------------------------------
// Administracja asystenta AI (admin-only) — kontrakt v2:
// scratchpad/ADMIN_ASSISTANT_CONTRACT.md. Precedencja: DB → env → domyślne.
// ---------------------------------------------------------------------------

export type AssistantSettingSource = "db" | "env" | "default";
export type AssistantProviderSort = "latency" | "price" | "throughput" | "";
export type AssistantReasoningEffort = "" | "low" | "medium" | "high";
export type AssistantAccess = "admins" | "calendar_editors";

/** Wszystkie konfigurowalne pola (bez klucza API). */
export interface AssistantSettingsValues {
  // Dostawca i model
  enabled: boolean;
  baseUrl: string;
  providerLabel: string;
  model: string;
  providerSort: AssistantProviderSort;
  // Generowanie
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
  historyTokenBudget: number;
  reasoningEffort: AssistantReasoningEffort;
  // Prompt i osobowość
  customInstructions: string;
  personaName: string;
  greeting: string;
  suggestions: string[];
  // Reguły kalendarza
  workStart: string;
  workEnd: string;
  defaultDurationHours: number;
  allDayTypes: string[];
  defaultStatus: "planned" | "confirmed";
  allowRecurrence: boolean;
  maxHorizonDays: number;
  // Narzędzia
  disabledTools: string[];
  /** Modyfikowanie istniejących wydarzeń (`propose_changes`, `get_event`). Domyślnie true. */
  allowModifications: boolean;
  /** Status nadawany wydarzeniom z „Podsumowania dnia” (domyślnie done). */
  daySummaryDefaultStatus: "done" | "confirmed";
  // Dostęp i limity
  access: AssistantAccess;
  retentionDays: number;
  dailyTurnLimit: number;
}

export type AssistantSettingsField = keyof AssistantSettingsValues;

export interface AdminAssistantToolMeta {
  name: string;
  label: string;
  description: string;
  required: boolean;
}

export interface AdminAssistantSettings {
  values: AssistantSettingsValues;
  sources: Record<AssistantSettingsField, AssistantSettingSource>;
  defaults: AssistantSettingsValues;
  apiKey: { set: boolean; source: "db" | "env" | "file" | null; masked: string | null };
  isOpenRouter: boolean;
  env: {
    OPENROUTER_API_KEY: boolean;
    OPENROUTER_KEY_FILE: string | null;
    keyFileExists: boolean;
    OPENROUTER_MODEL: string | null;
    OPENROUTER_PROVIDER_SORT: string | null;
    OPENROUTER_BASE_URL: string | null;
  };
  meta: {
    eventTypes: string[];
    statuses: string[];
    tools: AdminAssistantToolMeta[];
    reasoningEfforts: AssistantReasoningEffort[];
    providerSorts: AssistantProviderSort[];
  };
}

/**
 * PUT: dowolny podzbiór `values` + `apiKey`. Pole pominięte = bez zmian;
 * `null` = usuń z bazy (powrót do env/domyślnego); apiKey "" = bez zmian.
 */
export type AdminAssistantSettingsUpdate = {
  [K in AssistantSettingsField]?: AssistantSettingsValues[K] | null;
} & { apiKey?: string | null };

export interface AdminAssistantModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPer1M: number | null;
  completionPer1M: number | null;
}

export interface AdminAssistantModels {
  models: AdminAssistantModel[];
  fetchedAt: string;
  error: string | null;
  source?: "openrouter" | "custom";
}

export interface AdminAssistantTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  model: string;
  error?: string;
  /** Kod błędu z classifyError (np. "auth", "timeout") — tylko gdy ok=false. */
  code?: string;
}

export interface AdminAssistantPromptPreview {
  prompt: string;
  tokensEstimate: number;
  tools: string[];
}

export interface AdminAssistantUsage {
  days: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  avgMs: number;
  estimatedCostUsd: number | null;
  /** Udział tur z policzonym kosztem (0..1). */
  costCoverage: number;
  byModel: { model: string; turns: number; promptTokens: number; completionTokens: number; costUsd: number | null }[];
  topUsers: { userId: number; label: string; turns: number; promptTokens: number; completionTokens: number }[];
  daily: { date: string; turns: number; promptTokens: number; completionTokens: number }[];
}

export interface AdminAssistantTurn {
  id: number;
  createdAt: string;
  userId: number;
  userLabel: string;
  chatId: number | null;
  chatTitle: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  ms: number;
  steps: number;
  toolCalls: number;
  finishReason: string | null;
}

export interface AdminAssistantTurns {
  items: AdminAssistantTurn[];
  total: number;
  page: number;
  pageSize: number;
}

export const adminAssistantApi = {
  async settings() {
    const r = await request<ApiResponse<AdminAssistantSettings>>("/admin/assistant/settings");
    return r.data as AdminAssistantSettings;
  },
  async updateSettings(body: AdminAssistantSettingsUpdate) {
    const r = await request<ApiResponse<AdminAssistantSettings>>("/admin/assistant/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return r.data as AdminAssistantSettings;
  },
  async models(refresh?: boolean) {
    const r = await request<ApiResponse<AdminAssistantModels>>(
      `/admin/assistant/models${refresh ? "?refresh=1" : ""}`
    );
    return r.data as AdminAssistantModels;
  },
  async test(body: { model?: string; apiKey?: string; baseUrl?: string }) {
    const r = await request<ApiResponse<AdminAssistantTestResult>>("/admin/assistant/test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return r.data as AdminAssistantTestResult;
  },
  async promptPreview() {
    const r = await request<ApiResponse<AdminAssistantPromptPreview>>("/admin/assistant/prompt-preview");
    return r.data as AdminAssistantPromptPreview;
  },
  async usage(days: 7 | 30 | 90) {
    const r = await request<ApiResponse<AdminAssistantUsage>>(`/admin/assistant/usage?days=${days}`);
    return r.data as AdminAssistantUsage;
  },
  async turns(params: { days: number; page: number; pageSize: number }) {
    const q = new URLSearchParams({
      days: String(params.days),
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    const r = await request<ApiResponse<AdminAssistantTurns>>(`/admin/assistant/turns?${q}`);
    return r.data as AdminAssistantTurns;
  },
  async deleteAllChats() {
    const r = await request<ApiResponse<{ deleted: number }>>("/admin/assistant/chats", { method: "DELETE" });
    return r.data as { deleted: number };
  },
};

// ---------------------------------------------------------------------------
// Administracja kalendarza (admin-only) — realizacje z wydarzeń.
// Kontrakt: scratchpad/REALIZATIONS_CONTRACT.md §1 i §4. Precedencja wartości
// jak w asystencie: DB → env → domyślne (`sources` per pole).
// ---------------------------------------------------------------------------

/** Kiedy wydarzenie ma tworzyć realizację. */
export type CalendarAutoRealization = "on_create" | "on_done" | "off";

export interface CalendarSettingsValues {
  autoRealization: CalendarAutoRealization;
  /** Typy wydarzeń objęte automatem (np. serwis, montaz, wizja, demontaz, konserwacja). */
  realizationTypes: string[];
  /** Czy edycja wydarzenia aktualizuje powiązaną realizację. */
  realizationSync: boolean;
  /** Czy dla płatnego wydarzenia powstaje wycena (razem z realizacją i protokołem). */
  autoQuote: boolean;
}

export type CalendarSettingsField = keyof CalendarSettingsValues;

export interface AdminCalendarSettings {
  values: CalendarSettingsValues;
  /** Może nie przyjść ze starszego backendu — UI radzi sobie bez tego. */
  sources?: Partial<Record<CalendarSettingsField, AssistantSettingSource>>;
  defaults?: CalendarSettingsValues;
  meta?: {
    /** Typy, które wolno objąć automatem (urlop nigdy). */
    allowedTypes?: CalendarEventType[];
    forbiddenTypes?: CalendarEventType[];
    defaultTypes?: CalendarEventType[];
    autoRealizationModes?: { value: CalendarAutoRealization; label: string }[];
  };
}

/** PUT: dowolny podzbiór; `null` = usuń z bazy (powrót do env/domyślnego). */
export type AdminCalendarSettingsUpdate = {
  [K in CalendarSettingsField]?: CalendarSettingsValues[K] | null;
};

export interface AdminCalendarBackfillCandidate {
  eventId: number;
  title: string;
  startAt: string;
  type: CalendarEventType | string;
  /** Obiekt realizacji wyliczony z wydarzenia. */
  site: string;
}
export interface AdminCalendarBackfillCreated {
  eventId: number;
  realizationId: number;
  protocolNumber: string | null;
  /** Numer wyceny — tylko prace płatne (null = wycena nie powstała). */
  quoteNumber?: string | null;
}
export interface AdminCalendarBackfillSkipped {
  eventId: number;
  reason: string;
}

/**
 * Wynik backfillu. Backend zwraca listy; akceptujemy też same liczby, gdyby
 * kiedyś odchudził odpowiedź (UI liczy `backfillCount`).
 */
export interface AdminCalendarBackfillResult {
  /** Wydarzenia kwalifikujące się do utworzenia realizacji. */
  candidates: AdminCalendarBackfillCandidate[] | number;
  /** Faktycznie utworzone (brak w trybie `dryRun`). */
  created?: AdminCalendarBackfillCreated[] | number;
  /** Pominięte (mają już realizację / typ nieobjęty / błąd). */
  skipped: AdminCalendarBackfillSkipped[] | number;
  /** Płatne wydarzenia z realizacją, ale bez wyceny (starszy backend nie zwraca pola). */
  quoteCandidates?: number;
  /** Wyceny faktycznie utworzone (brak w trybie `dryRun`). */
  quotesCreated?: number;
}

/** Liczność pola wyniku backfillu — lista albo gotowa liczba. */
export const backfillCount = (v: unknown[] | number | undefined): number =>
  Array.isArray(v) ? v.length : typeof v === "number" ? v : 0;

export const adminCalendarApi = {
  async settings() {
    const r = await request<ApiResponse<AdminCalendarSettings>>("/admin/calendar/settings");
    return r.data as AdminCalendarSettings;
  },
  async updateSettings(body: AdminCalendarSettingsUpdate) {
    const r = await request<ApiResponse<AdminCalendarSettings>>("/admin/calendar/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return r.data as AdminCalendarSettings;
  },
  async backfillRealizations(body: { dryRun: boolean; from?: string }) {
    const r = await request<ApiResponse<AdminCalendarBackfillResult>>(
      "/admin/calendar/backfill-realizations",
      { method: "POST", body: JSON.stringify(body) }
    );
    return r.data as AdminCalendarBackfillResult;
  },
};

// ---------------------------------------------------------------------------
// Automatyczne uzupełnianie realizacji (kontrakt AUTOFILL §3–§4)
// Podgląd nie zapisuje niczego; zapis obejmuje wyłącznie wskazane pola.
// ---------------------------------------------------------------------------

/** Pola realizacji objęte automatem (kolejność = kolejność w dialogu). */
export const AUTOFILL_FIELDS = [
  "actualHours",
  "amountHours",
  "amountMaterial",
  "actualKm",
  "amountKm",
  "hourlyCost",
  "caretaker",
] as const;
export type AutofillField = (typeof AUTOFILL_FIELDS)[number];

export const AUTOFILL_FIELD_LABEL: Record<string, string> = {
  actualHours: "Faktyczne godziny",
  amountHours: "Kwota za godziny",
  amountMaterial: "Materiały",
  actualKm: "Faktyczne KM",
  amountKm: "Kwota za KM",
  hourlyCost: "Koszt godzinowy",
  caretaker: "Opiekun",
};

/** Pola kwotowe — formatowane jako złotówki w dialogu i adnotacjach. */
export const AUTOFILL_MONEY_FIELDS = new Set<string>([
  "amountHours",
  "amountMaterial",
  "amountKm",
  "hourlyCost",
]);

/**
 * Pojedyncza propozycja automatu. `confident` = pole jest puste/zerowe, więc
 * wartość można podstawić bez pytania; `false` = konflikt z tym, co już jest.
 */
export interface AutofillSuggestion {
  field: AutofillField | string;
  current: number | string | null;
  suggested: number | string | null;
  /** „kalendarz" | „protokół" | „kalkulacja" | „cennik" | „ustawienia". */
  source: string;
  detail: string;
  confident: boolean;
  /** Etykieta pola z backendu; brak → słownik `AUTOFILL_FIELD_LABEL`. */
  label?: string;
}

export interface AutofillPreview {
  suggestions: AutofillSuggestion[];
  warnings: string[];
}

/** Wynik masowego uzupełniania (pętla po realizacjach — bez endpointu bulk). */
export interface AutofillBulkRow {
  id: number;
  site: string;
  fields: AutofillField[] | string[];
  suggestions: AutofillSuggestion[];
  error?: string;
}

const emptyPreview = (): AutofillPreview => ({ suggestions: [], warnings: [] });

export const realizationAutofillApi = {
  /** Podgląd sugestii — bez zapisu. */
  async preview(id: number): Promise<AutofillPreview> {
    const r = await request<ApiResponse<AutofillPreview>>(`/realizations/${id}/autofill`);
    const d = r.data ?? emptyPreview();
    return {
      suggestions: Array.isArray(d.suggestions) ? d.suggestions : [],
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
    };
  },

  /** Zapisuje wskazane pola i zwraca zaktualizowaną realizację. */
  async apply(id: number, fields: string[]): Promise<Realization> {
    const r = await request<ApiResponse<Realization>>(`/realizations/${id}/autofill`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    return r.data as Realization;
  },

  /**
   * Masowy podgląd: pobiera sugestie po kolei (backend nie ma endpointu bulk —
   * pętla po stronie klienta trzyma 1 request naraz, żeby nie zalać geokodera).
   * Zwraca tylko wiersze, dla których automat coś proponuje.
   */
  async bulkPreview(
    rows: { id: number; site: string }[],
    opts?: { confidentOnly?: boolean }
  ): Promise<AutofillBulkRow[]> {
    const out: AutofillBulkRow[] = [];
    for (const row of rows) {
      try {
        const preview = await realizationAutofillApi.preview(row.id);
        const picked = preview.suggestions.filter((s) => !opts?.confidentOnly || s.confident);
        if (picked.length > 0) {
          out.push({ id: row.id, site: row.site, fields: picked.map((s) => s.field), suggestions: picked });
        }
      } catch (e) {
        out.push({
          id: row.id,
          site: row.site,
          fields: [],
          suggestions: [],
          error: e instanceof Error ? e.message : "Błąd podglądu",
        });
      }
    }
    return out;
  },

  /** Masowy zapis — po jednej realizacji, żeby błąd jednej nie ubił reszty. */
  async bulkApply(rows: AutofillBulkRow[]): Promise<{ applied: number; failed: { id: number; error: string }[] }> {
    let applied = 0;
    const failed: { id: number; error: string }[] = [];
    for (const row of rows) {
      if (row.fields.length === 0) continue;
      try {
        await realizationAutofillApi.apply(row.id, row.fields as string[]);
        applied += 1;
      } catch (e) {
        failed.push({ id: row.id, error: e instanceof Error ? e.message : "Błąd zapisu" });
      }
    }
    return { applied, failed };
  },
};

// ---------------------------------------------------------------------------
// Administracja → Firma (kontrakt AUTOFILL §1): adres biura, stawki, automat
// ---------------------------------------------------------------------------

/** Skąd brać dystans biuro → obiekt. */
export type CompanyKmSource = "route" | "straight" | "manual";

export const KM_SOURCE_LABEL: Record<CompanyKmSource, string> = {
  route: "Trasa drogowa (OSRM)",
  straight: "Linia prosta × 1,3",
  manual: "Ręcznie (bez kalkulacji)",
};

export interface CompanySettingsValues {
  officeAddress: string;
  officeCity: string;
  officePostcode: string;
  /** null = współrzędne nieustalone (geokoder ich jeszcze nie policzył). */
  officeLat: number | null;
  officeLng: number | null;
  /** Norma dnia roboczego (godz.) — szacunek godzin dla wydarzenia całodniowego. */
  workDayHours: number;
  /** Stawka sprzedaży za roboczogodzinę (netto). */
  rateHour: number;
  /** Koszt wewnętrzny roboczogodziny. */
  hourlyCost: number;
  /** Stawka za kilometr. */
  rateKm: number;
  /** Dystans liczony w obie strony (×2). */
  kmRoundTrip: boolean;
  kmSource: CompanyKmSource;
  /** Narzut procentowy na materiały z protokołu. */
  materialMarkup: number;
  // Narzuty składek pracodawcy. Wypłaty w kadrach są netto „na rękę”, więc żeby
  // pokazać realny koszt zatrudnienia, mnożymy je przez współczynnik zależny od
  // formy zatrudnienia. Spółka może mieć własne wartości (Company.employerMarkup*).
  /** Umowa o pracę (ZUA) — pełne składki pracodawcy. */
  employerMarkupUop: number;
  /** Zlecenie ze zgłoszeniem ZUA — te same składki, bez chorobowego. */
  employerMarkupZlecenieZua: number;
  /** Zlecenie ze zgłoszeniem ZZA — tylko zdrowotne po stronie pracownika. */
  employerMarkupZlecenieZza: number;
  /** Wiersze wynagrodzeń biura bez dopasowanej umowy — formy nie da się odczytać. */
  employerMarkupOfficeDefault: number;
  autofillEnabled: boolean;
  autofillFields: string[];
  /** Czy realizacja podlicza się wstępnie już po oznaczeniu wydarzenia jako „wykonane”. */
  autofillOnEventDone: boolean;
}

export type CompanySettingsField = keyof CompanySettingsValues;

export interface AdminCompanySettings {
  values: CompanySettingsValues;
  sources?: Partial<Record<CompanySettingsField, AssistantSettingSource>>;
  defaults?: Partial<CompanySettingsValues>;
  meta?: {
    autofillFields?: { value: string; label: string }[];
    kmSources?: { value: CompanyKmSource; label: string }[];
  };
}

/** PUT: dowolny podzbiór; `null` = usuń z bazy (powrót do domyślnego). */
export type AdminCompanySettingsUpdate = {
  [K in CompanySettingsField]?: CompanySettingsValues[K] | null;
};

export interface GeocodeResult {
  lat: number;
  lng: number;
  display?: string;
}

/**
 * Wynik „Testuj kalkulację” — dystans biuro → obiekt i kwoty z niego wynikające.
 * Backend nie zwraca 500 przy braku adresu/sieci: wtedy `distance` = null,
 * a powód siedzi w `error` (200), żeby panel mógł go pokazać obok pól.
 */
export interface CompanyDistanceTest {
  object?: { id: number; name: string; address?: string | null; city?: string | null } | null;
  distance: {
    /** Dystans w jedną stronę. */
    km: number;
    /** Po uwzględnieniu round tripu — to trafia do `actualKm`. */
    totalKm: number;
    roundTrip: boolean;
    method?: "route" | "straight" | string;
    cached?: boolean;
    /** Punkty z etykietami („Marszałkowska 1, 00-001 Warszawa" → nazwa obiektu). */
    from?: { lat: number; lng: number; label?: string } | null;
    to?: { lat: number; lng: number; label?: string } | null;
  } | null;
  amounts: {
    actualKm: number;
    amountKm: number | null;
    rate: number | null;
    /** „cennik: …” albo „stawka firmowa”. */
    rateSource: string | null;
    hourlyCost: number;
    rateHour: number;
  } | null;
  /** Gotowe podsumowanie wyliczenia („12,4 km × 2 × 1,20 zł = 29,76 zł”). */
  summary?: string;
  error?: string | null;
}

/** Domyślne wartości używane, dopóki backend nie zwróci swoich. */
export const COMPANY_FALLBACK_VALUES: CompanySettingsValues = {
  officeAddress: "",
  officeCity: "",
  officePostcode: "",
  officeLat: null,
  officeLng: null,
  workDayHours: 8,
  rateHour: 0,
  hourlyCost: 0,
  rateKm: 0,
  kmRoundTrip: true,
  kmSource: "route",
  materialMarkup: 0,
  employerMarkupUop: 1.65,
  employerMarkupZlecenieZua: 1.59,
  employerMarkupZlecenieZza: 1.22,
  employerMarkupOfficeDefault: 1.65,
  autofillEnabled: true,
  autofillFields: [...AUTOFILL_FIELDS],
  autofillOnEventDone: true,
};

/**
 * Normalizacja kluczy z backendu: akceptujemy camelCase (`officeLat`) i wariant
 * z podkreśleniami (`office_lat`), żeby panel działał niezależnie od tego,
 * którą konwencję ostatecznie zwróci API.
 */
function normalizeKeyed<T>(raw: unknown): Partial<Record<CompanySettingsField, T>> {
  if (!raw || typeof raw !== "object") return {};
  const byLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    byLower.set(k.replace(/_/g, "").toLowerCase(), v);
  }
  const out: Partial<Record<CompanySettingsField, T>> = {};
  for (const field of Object.keys(COMPANY_FALLBACK_VALUES) as CompanySettingsField[]) {
    const v = byLower.get(field.toLowerCase());
    if (v !== undefined) out[field] = v as T;
  }
  return out;
}

const asStr = (v: unknown, fb: string) => (typeof v === "string" ? v : v == null ? fb : String(v));
const asNum = (v: unknown, fb: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : fb;
};
const asNumOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = asNum(v, NaN);
  return Number.isFinite(n) ? n : null;
};
const asBool = (v: unknown, fb: boolean) =>
  typeof v === "boolean" ? v : v === "true" || v === 1 ? true : v === "false" || v === 0 ? false : fb;

/** Wartości z backendu → typy UI (liczby mogą przyjść jako tekst z app_settings). */
function coerceCompanyValues(raw: unknown): CompanySettingsValues {
  const v = normalizeKeyed<unknown>(raw);
  const fb = COMPANY_FALLBACK_VALUES;
  const kmSource = asStr(v.kmSource, fb.kmSource);
  return {
    officeAddress: asStr(v.officeAddress, fb.officeAddress),
    officeCity: asStr(v.officeCity, fb.officeCity),
    officePostcode: asStr(v.officePostcode, fb.officePostcode),
    officeLat: asNumOrNull(v.officeLat),
    officeLng: asNumOrNull(v.officeLng),
    workDayHours: asNum(v.workDayHours, fb.workDayHours),
    rateHour: asNum(v.rateHour, fb.rateHour),
    hourlyCost: asNum(v.hourlyCost, fb.hourlyCost),
    rateKm: asNum(v.rateKm, fb.rateKm),
    kmRoundTrip: asBool(v.kmRoundTrip, fb.kmRoundTrip),
    kmSource: (["route", "straight", "manual"] as string[]).includes(kmSource)
      ? (kmSource as CompanyKmSource)
      : fb.kmSource,
    materialMarkup: asNum(v.materialMarkup, fb.materialMarkup),
    employerMarkupUop: asNum(v.employerMarkupUop, fb.employerMarkupUop),
    employerMarkupZlecenieZua: asNum(v.employerMarkupZlecenieZua, fb.employerMarkupZlecenieZua),
    employerMarkupZlecenieZza: asNum(v.employerMarkupZlecenieZza, fb.employerMarkupZlecenieZza),
    employerMarkupOfficeDefault: asNum(v.employerMarkupOfficeDefault, fb.employerMarkupOfficeDefault),
    autofillEnabled: asBool(v.autofillEnabled, fb.autofillEnabled),
    autofillFields: Array.isArray(v.autofillFields) ? v.autofillFields.map(String) : fb.autofillFields,
    autofillOnEventDone: asBool(v.autofillOnEventDone, fb.autofillOnEventDone),
  };
}

function normalizeCompanySettings(raw: unknown): AdminCompanySettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  return {
    values: coerceCompanyValues(src.values),
    sources: normalizeKeyed<AssistantSettingSource>(src.sources),
    defaults: src.defaults ? coerceCompanyValues(src.defaults) : undefined,
    meta: (src.meta as AdminCompanySettings["meta"]) ?? undefined,
  };
}

export const adminCompanyApi = {
  async settings(): Promise<AdminCompanySettings> {
    const r = await request<ApiResponse<AdminCompanySettings>>("/admin/company/settings");
    return normalizeCompanySettings(r.data);
  },

  async updateSettings(body: AdminCompanySettingsUpdate): Promise<AdminCompanySettings> {
    const r = await request<ApiResponse<AdminCompanySettings>>("/admin/company/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return normalizeCompanySettings(r.data);
  },

  /**
   * Geokodowanie adresu (Nominatim po stronie backendu, z cache w `geo_cache`).
   * Bez pól backend bierze aktualny adres biura; `query` nadpisuje wszystko.
   */
  async geocode(body: {
    address?: string;
    city?: string;
    postcode?: string;
    query?: string;
  }): Promise<GeocodeResult> {
    const r = await request<ApiResponse<GeocodeResult>>("/admin/company/geocode", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return r.data as GeocodeResult;
  },

  /** Kalkulacja dystansu do wskazanego obiektu (podgląd ustawień w praktyce). */
  async testDistance(objectId: number): Promise<CompanyDistanceTest> {
    const r = await request<ApiResponse<CompanyDistanceTest>>("/admin/company/test-distance", {
      method: "POST",
      body: JSON.stringify({ objectId }),
    });
    return r.data as CompanyDistanceTest;
  },
};

/** Status błędu z `request` (404 = endpointu jeszcze nie ma, 403 = brak uprawnień). */
export const errStatus = (e: unknown): number | undefined =>
  typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number"
    ? (e as { status: number }).status
    : undefined;

/** Czy błąd oznacza „backend nie ma jeszcze tego endpointu". */
export const isMissingEndpoint = (e: unknown): boolean => errStatus(e) === 404;

// ---------------------------------------------------------------------------
// Analityka — przychód / koszt / zysk w trzech przekrojach
// ---------------------------------------------------------------------------
//
// Wszystkie trzy widoki mówią tym samym słownikiem faktów, liczonym w
// src/routes/analytics.ts:
//   revenue = coalesce(monthly_value, 0)
//   cost    = personnelCost + otherCost      ← KOSZT SKŁADA SIĘ Z DWÓCH CZĘŚCI
//   profit  = revenue - cost                 margin = profit / revenue * 100
// gdzie `personnelCost` to koszt osobowy policzony z wypłat kadrowych (mapowanie
// hr_objects.object_id → obiekt), a `otherCost` to ręczne `objects.monthly_cost`
// (monitoring, sprzęt, abonamenty). Nigdy jedno ZAMIAST drugiego — podmiana
// zaniżyłaby koszt obiektów fizycznej ochrony o całą pensję załogi.
// Kluczowe rozróżnienie: koszt NULL znaczy „nieuzupełniony”, a nie 0 zł.
// Sumy traktują go jak zero, ale `objectsWithCost` / `coverage` mówią, na ilu
// obiektach ta arytmetyka w ogóle się opiera — bez tego marża kłamie.
//
// KWOTY SĄ NETTO, ale w DWÓCH różnych znaczeniach. Strona handlowa (abonamenty,
// koszty pozostałe, nakłady) jest netto „bez VAT". Koszt osobowy pochodzi z wypłat,
// a następnie mnożony przez narzut składek pracodawcy, czyli jest SZACOWANYM pełnym kosztem
// zatrudnienia — mnożnik jest jednak PRZYBLIŻENIEM, bo składki liczy się od brutto,
// a aplikacja zna tylko netto. `personnel.employer` niesie użyte narzuty i strukturę
// form zatrudnienia, żeby UI mogło pokazać, skąd liczba się wzięła.

/** Zakres danych: bieżące (bez archiwum), tylko aktywne, albo wszystko. */
export type AnalyticsScope = "current" | "active" | "all";

/**
 * Okno uśredniania KOSZTU OSOBOWEGO: ostatni pełny miesiąc / średnia z 3 / z 12.
 * Jeden miesiąc bywa wystrzałowy (premie, wyrównania), dwanaście rozmywa sezon —
 * stąd domyślna trójka po stronie backendu (`DEFAULT_COST_WINDOW`).
 */
export type CostWindow = 1 | 3 | 12;

/**
 * Skąd wziął się koszt osobowy — blok informacyjny, z którego UI robi przypis.
 *
 * Bez niego „koszt osobowy 0 zł" jest nie do odróżnienia od „nikt nie zmapował
 * pozycji kadrowych na obiekty", a to dwie zupełnie różne historie: pierwsza to
 * wynik, druga to milcząca dziura w danych.
 */
export interface PersonnelInfo {
  costWindow: CostWindow;
  /** Ile miesięcy FAKTYCZNIE weszło do średniej — bywa mniej niż `costWindow`. */
  monthsUsed: number;
  /** Które to miesiące, od najstarszego. */
  months: Array<{ year: number; month: number }>;
  /** Ile pozycji słownika kadrowego ma mapowanie na kartotekę obiektów. */
  mappedObjects: number;
  /** Ile pozycji kadrowych jest w ogóle — do przypisu „12 z 44". */
  hrObjectsTotal: number;
  /** 0..1 — jaka część godzin poszła w koszt ogólny firmy zamiast na obiekt. */
  unmappedHoursShare: number;
  /**
   * Podstawa kwoty kosztu osobowego. "employerCost" = wypłata netto przemnożona
   * przez narzut składek pracodawcy (Administracja → Firma), czyli SZACOWANY pełny
   * koszt zatrudnienia. Zastąpiło dawne `net: true` — po doliczeniu składek zdanie
   * „bez składek pracodawcy" przestało być prawdziwe.
   */
  costBasis: "employerCost";
  /** Skąd wzięła się kwota — do przypisu i do obrony liczby przed księgową. */
  employer: EmployerCostInfo;
}

/** Rozliczenie narzutu składek: ile wierszy poszło którą formą i jakim mnożnikiem. */
export interface EmployerCostInfo {
  applied: true;
  /** Ile wypłat użyło narzutu danej formy zatrudnienia. */
  byForm: {
    uop: number;
    zlecenieZua: number;
    zlecenieZza: number;
    /** Rozliczenia biura bez dopasowanej umowy — narzut domyślny. */
    officeFallback: number;
  };
  /** Globalne wartości narzutów (spółka może mieć własne). */
  markups: { uop: number; zlecenieZua: number; zlecenieZza: number; officeDefault: number };
  /** Ile spółek ma własne narzuty zamiast globalnych. */
  companyOverrides: number;
  /** Koszt łączny / wypłaty netto łącznie — jedna liczba do pokazania w UI. */
  effectiveMarkup: number;
}

export interface AnalyticsTotals {
  objects: number;
  /** Ile obiektów ma UZUPEŁNIONY koszt (monthly_cost IS NOT NULL). */
  objectsWithCost: number;
  /** objectsWithCost / objects, 0..1 — „na ilu obiektach opiera się marża”. */
  coverage: number;
  revenue: number;
  /** Koszt CAŁKOWITY: `personnelCost + otherCost`. */
  cost: number;
  /** Część osobowa — z wypłat kadrowych, netto „na rękę". */
  personnelCost: number;
  /** Część pozostała — ręczne `objects.monthly_cost` (monitoring, sprzęt). */
  otherCost: number;
  profit: number;
  /** Procent; null gdy przychód = 0 (marża byłaby dzieleniem przez zero). */
  margin: number | null;
  setupCost: number;
  /** Średni przychód na obiekt; null gdy brak obiektów. */
  arpo: number | null;
  /** Obiekty z uzupełnionym kosztem i ujemnym zyskiem. */
  unprofitable: number;
  noRevenue: number;
  personnel: PersonnelInfo;
}

/** Kubełek zestawienia (wg typu, statusu, spółki, przedziału marży). */
export interface AnalyticsBucket {
  key: string;
  /** Gotowa etykieta z backendu; brak = front zna własną (label mapy z utils). */
  label?: string;
  count: number;
  revenue: number;
  cost: number;
  profit: number;
}

/** Wspólna koperta odpowiedzi wszystkich trzech widoków. */
interface AnalyticsEnvelope {
  scope: AnalyticsScope;
  /** Echo parametru zapytania — okno, z którego policzono koszt osobowy. */
  costWindow: CostWindow;
  generatedAt: string;
  totals: AnalyticsTotals;
  personnel: PersonnelInfo;
}

export interface AnalyticsContractorRow {
  id: number;
  name: string;
  city: string | null;
  active: boolean;
  salesperson: { id: number; firstName: string; lastName: string } | null;
  objectsCount: number;
  activeObjectsCount: number;
  objectsWithCost: number;
  revenue: number;
  cost: number;
  /** Rozbicie kosztu: osobowy z Kadr + pozostały z kartotek obiektów. */
  personnelCost: number;
  otherCost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  /** Miesiące zwrotu z instalacji; null = brak nakładu albo zysk <= 0. */
  payback: number | null;
  arpo: number | null;
}

export interface AnalyticsContractorsData extends AnalyticsEnvelope {
  rows: AnalyticsContractorRow[];
  /** Kontrahenci bez ani jednego obiektu — poza rankingami, ale warto o nich wiedzieć. */
  contractorsWithoutObjects: number;
}

export interface AnalyticsObjectRow {
  id: number;
  name: string;
  city: string | null;
  /**
   * Usługi obiektu — z nich składa się kolumna „Usługi” i przekrój po usługach.
   * Analityka ma własne, zwięzłe nazwy pól (src/routes/analytics.ts →
   * `ObjectServicesInfo`); kartoteka trzyma je jako `hasCameras` itd.
   */
  services?: {
    sswin: boolean;
    cameras: boolean;
    /** null przy `cameras` = usługa jest, ale kamer nikt nie policzył (≠ zero). */
    cameraCount: number | null;
    ofi: boolean;
    videoreception: boolean;
  };
  /** Waga obiektu w podziale kosztu centrum monitorowania (SSWiN + wideorecepcja + kamery). */
  serviceUnits?: number;
  status: "pending" | "in_progress" | "active" | "inactive";
  contractorId: number;
  contractorName: string | null;
  companyName: string | null;
  salesperson: {
    id: number;
    firstName: string;
    lastName: string;
    /** true = opiekun kontrahenta, obiekt nie ma własnego handlowca. */
    inherited: boolean;
  } | null;
  revenue: number;
  cost: number;
  /** Rozbicie kosztu: osobowy z Kadr + pozostały z pola `monthly_cost`. */
  personnelCost: number;
  otherCost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  payback: number | null;
  /** false = koszt nieuzupełniony; marża i zysk są wtedy nieznane, nie zerowe. */
  hasCost: boolean;
}

export interface AnalyticsObjectsData extends AnalyticsEnvelope {
  rows: AnalyticsObjectRow[];
  /**
   * Przekrój po usługach. NIE SUMUJE SIĘ do całości: obiekt z kamerami i SSWiN-em
   * wchodzi do obu kubełków, a obiekt bez ani jednej usługi — do żadnego.
   */
  byService: AnalyticsBucket[];
  byStatus: AnalyticsBucket[];
  byCompany: AnalyticsBucket[];
  /** Zawsze 6 pozycji: „<0%”, „0–20”, „20–40”, „40–60”, „60%+”, „brak danych”. */
  marginBuckets: AnalyticsBucket[];
}

export interface AnalyticsSalespersonRow {
  id: number;
  firstName: string;
  lastName: string;
  region: string | null;
  active: boolean;
  /** Powiązanie z kartoteką kadrową; null = osoba spoza listy płac. */
  employeeId: number | null;
  contractorsCount: number;
  objectsCount: number;
  objectsWithCost: number;
  unprofitableObjects: number;
  revenue: number;
  objectsCost: number;
  /** Rozbicie kosztu obiektów portfela: osobowy z Kadr + pozostały. */
  objectsPersonnelCost: number;
  objectsOtherCost: number;
  setupCost: number;
  /** Koszt własny handlowca (wynagrodzenie, auto, telefon). */
  ownCost: number;
  /**
   * Skąd `ownCost`: „kadry" = z wypłat powiązanego pracownika (pole ręczne jest
   * wtedy IGNOROWANE, inaczej ten sam człowiek kosztowałby firmę dwa razy),
   * „reczny" = z pola `salespeople.monthly_cost`.
   */
  ownCostSource: "kadry" | "reczny";
  /** Kwota z pola ręcznego; przy źródle „kadry" NIE wchodzi do wyniku. */
  manualMonthlyCost: number | null;
  commissionRate: number | null;
  commission: number;
  /** Marża portfela PRZED kosztem handlowca: revenue - objectsCost. */
  contribution: number;
  /** contribution - ownCost - commission. */
  profit: number;
  margin: number | null;
  /** Ile złotych przychodu na złotówkę kosztu handlowca; < 1 = nie zarabia na siebie. */
  roi: number | null;
}

/** Portfel bez opiekuna — przychód, którego nikt nie prowadzi. */
export interface AnalyticsUnassigned {
  objectsCount: number;
  objectsWithCost: number;
  unprofitableObjects: number;
  revenue: number;
  objectsCost: number;
  objectsPersonnelCost: number;
  objectsOtherCost: number;
  setupCost: number;
  profit: number;
  margin: number | null;
}

export interface AnalyticsSalespeopleData extends AnalyticsEnvelope {
  totals: AnalyticsTotals & {
    salespeopleCost: number;
    commission: number;
    netProfit: number;
    unassignedRevenue: number;
    salespeopleWithCost: number;
  };
  rows: AnalyticsSalespersonRow[];
  unassigned: AnalyticsUnassigned;
}

function analyticsQuery(params?: {
  scope?: AnalyticsScope;
  limit?: number;
  costWindow?: CostWindow;
}) {
  const sp = new URLSearchParams();
  if (params?.scope) sp.set("scope", params.scope);
  if (params?.limit) sp.set("limit", String(params.limit));
  // Brak wartości = nie wysyłamy parametru: domyślne okno (3 mies.) zna backend
  // i nie ma powodu, żeby front trzymał drugą kopię tej decyzji.
  if (params?.costWindow) sp.set("costWindow", String(params.costWindow));
  const q = sp.toString();
  return q ? `?${q}` : "";
}

export async function getAnalyticsContractors(params?: {
  scope?: AnalyticsScope;
  limit?: number;
  costWindow?: CostWindow;
}) {
  return request<ApiResponse<AnalyticsContractorsData>>(
    `/analytics/kontrahenci${analyticsQuery(params)}`
  );
}

export async function getAnalyticsObjects(params?: {
  scope?: AnalyticsScope;
  limit?: number;
  costWindow?: CostWindow;
}) {
  return request<ApiResponse<AnalyticsObjectsData>>(
    `/analytics/obiekty${analyticsQuery(params)}`
  );
}

export async function getAnalyticsSalespeople(params?: {
  scope?: AnalyticsScope;
  limit?: number;
  costWindow?: CostWindow;
}) {
  return request<ApiResponse<AnalyticsSalespeopleData>>(
    `/analytics/handlowcy${analyticsQuery(params)}`
  );
}
