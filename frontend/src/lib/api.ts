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

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || "Request failed");
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
