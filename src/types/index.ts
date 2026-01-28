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
}

export interface ObjectInput {
  contractorId: number;
  name: string;
  address?: string;
  city?: string;
  type: ObjectType;
  installationType: InstallationType;
  status?: ObjectStatus;
  department?: Department;
  monthlyValue?: number;
  notes?: string;
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

export interface WorkflowTransition {
  objectId: number;
  newStatus: ObjectStatus;
  newDepartment: Department;
  description?: string;
}
