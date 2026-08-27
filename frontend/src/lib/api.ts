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
    throw new Error(data.error || `Request failed (${response.status})`);
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
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<PaginatedResponse<Contractor>>(
    `/contractors${query ? `?${query}` : ""}`
  );
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
export async function getObjects(params?: {
  search?: string;
  status?: string;
  department?: string;
  type?: string;
  contractorId?: number;
  page?: number;
  pageSize?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.department) searchParams.set("department", params.department);
  if (params?.type) searchParams.set("type", params.type);
  if (params?.contractorId) searchParams.set("contractorId", String(params.contractorId));
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return request<PaginatedResponse<ObjectWithContractor>>(
    `/objects${query ? `?${query}` : ""}`
  );
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
  createdAt: string;
  updatedAt: string;
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
}

export interface ObjectRecord {
  id: number;
  contractorId: number;
  name: string;
  address: string | null;
  city: string | null;
  type: "monitoring" | "physical" | "alarm" | "mixed";
  installationType: "new" | "takeover";
  status: "pending" | "in_progress" | "active" | "inactive";
  department: "sales" | "technical" | "accounting";
  monthlyValue: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectWithContractor extends ObjectRecord {
  contractor: Contractor | null;
}

export interface ObjectWithDetails extends ObjectWithContractor {
  contracts: Contract[];
}

export interface ObjectInput {
  contractorId: number;
  name: string;
  address?: string;
  city?: string;
  type: "monitoring" | "physical" | "alarm" | "mixed";
  installationType: "new" | "takeover";
  status?: "pending" | "in_progress" | "active" | "inactive";
  department?: "sales" | "technical" | "accounting";
  monthlyValue?: number;
  notes?: string;
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
  objectType?: "monitoring" | "physical" | "alarm" | "mixed";
  objectInstallationType?: "new" | "takeover";
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

export type RealizationKind = "service" | "warranty" | "installation";

export interface Realization {
  id: number;
  date: string; // YYYY-MM-DD
  site: string;
  kind: RealizationKind;
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
  createdAt: string;
  updatedAt: string;
}

export interface RealizationInput {
  date: string;
  site: string;
  kind: RealizationKind;
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
  counts: { service: number; warranty: number; installation: number };
  uninvoicedCount: number;
  months: { month: number; revenue: number; loss: number }[];
}

export async function getRealizations(year: number, month: number) {
  return request<ApiResponse<Realization[]>>(
    `/realizations?year=${year}&month=${month}`
  );
}

export async function getRealizationSummary(year: number, month: number) {
  return request<ApiResponse<RealizationSummary>>(
    `/realizations/summary?year=${year}&month=${month}`
  );
}

export async function createRealization(data: RealizationInput) {
  return request<ApiResponse<Realization>>("/realizations", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateRealization(id: number, data: RealizationInput) {
  return request<ApiResponse<Realization>>(`/realizations/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteRealization(id: number) {
  return request<ApiResponse<null>>(`/realizations/${id}`, {
    method: "DELETE",
  });
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
  type: TechnicianType;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TechnicianInput {
  firstName: string;
  lastName: string;
  phone?: string;
  type: TechnicianType;
  notes?: string;
  active?: boolean;
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
// Cennik usług serwisowych
// ---------------------------------------------------------------------------

export interface PriceItem {
  id: number;
  name: string;
  unit: string;
  price: number;
  position: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceItemInput {
  name: string;
  unit: string;
  price: number | string;
  position?: number;
  active?: boolean;
}

export async function getPriceList() {
  return request<ApiResponse<PriceItem[]>>("/pricelist");
}

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

export async function getProtocols(year?: number, month?: number) {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
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
  createdAt: string;
  updatedAt: string;
}

export interface QuoteInput {
  date: string;
  site: string;
  address: string;
  items?: QuoteItem[];
}

export async function getQuotes(year?: number, month?: number) {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  const query = params.toString();
  return request<ApiResponse<Quote[]>>(`/quotes${query ? `?${query}` : ""}`);
}

export async function createQuote(data: Partial<QuoteInput> = {}) {
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

export interface HrEmployee {
  id: number;
  fullName: string;
  code: string;
  active: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface HrEmployeeInput {
  fullName: string;
  code?: string;
  active?: boolean;
  notes?: string;
}

export interface HrObject {
  id: number;
  name: string;
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
  realizationId?: number | null;
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
  | "status_changed";

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
  /** Limit kroków narzędzi w jednej turze (do wiersza „Krok n/max”); brak → front zakłada 6. */
  maxSteps?: number;
  /** Maksymalna długość wiadomości użytkownika (znaki); brak → 4000. */
  messageMaxChars?: number;
  turnTimeoutMs?: number;
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
}

export type AssistantChangeKind = "update" | "status" | "cancel" | "delete" | "restore" | "create";

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
}

/** Surowa zmiana (wejście narzędzia `propose_changes`; po edycji — override do apply-changes). */
export type AssistantChange =
  | { kind: "update"; eventId: number; patch: AssistantChangePatch; reason?: string }
  | { kind: "status"; eventId: number; status: "confirmed" | "done" | "cancelled"; actualStartAt?: string; actualEndAt?: string; note?: string; reason?: string }
  | { kind: "cancel"; eventId: number; reason?: string }
  | { kind: "delete"; eventId: number; reason?: string }
  | { kind: "restore"; eventId: number }
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
};

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
