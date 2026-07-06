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
  payerContractorId: number | null;
  objectName: string;
  objectAddress: string | null;
  objectCity: string | null;
  objectLocationUrl: string | null;
  objectId: number | null;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string | null;
  isCameraInstallation: boolean;
  cameraCount: number | null;
  megaphoneCount: number | null;
  vtoolsOfferNumber: string | null;
  monthlyAmount: number | null;
  rentalAmount: number | null;
  invoiceIssuer: string | null;
  status: "new" | "in_progress" | "completed" | "cancelled";
  serviceStartDate: string | null;
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
  payerContractorId?: number;
  objectName: string;
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
  rentalAmount?: number;
  invoiceIssuer?: string;
  status?: "new" | "in_progress" | "completed" | "cancelled";
  serviceStartDate?: string;
  notes?: string;
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
