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

export interface ObjectInput {
  contractorId: number;
  name: string;
  address?: string;
  city?: string;
  /**
   * @deprecated Zastąpione rozdzielnymi usługami niżej. Front go już nie wysyła;
   * dopóki kolumna `objects.type` istnieje (NOT NULL), backend wylicza ją z usług.
   */
  type?: ObjectType;
  /** USŁUGI OBIEKTU — niezależne, dowolny mix (patrz src/db/schema.ts). */
  hasCameras?: boolean;
  /** null = „usługa jest, ale kamer nikt nie policzył” — to NIE jest zero. */
  cameraCount?: number | null;
  hasSswin?: boolean;
  hasVideoreception?: boolean;
  hasOfi?: boolean;
  installationType: InstallationType;
  status?: ObjectStatus;
  department?: Department;
  monthlyValue?: number;
  /** Dzierżawa sprzętu (zł netto/mies.) — druga część przychodu obok abonamentu. */
  monthlyRental?: number | null;
  /** Miesięczny koszt obsługi obiektu (null = nieuzupełniony, to NIE jest zero). */
  monthlyCost?: number | null;
  /** Jednorazowy koszt uruchomienia (null = nieuzupełniony, to NIE jest zero). */
  setupCost?: number | null;
  notes?: string;
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
  /** Usługi zakładanego obiektu — patrz `ObjectInput` wyżej. */
  objectHasCameras?: boolean;
  objectCameraCount?: number | null;
  objectHasSswin?: boolean;
  objectHasVideoreception?: boolean;
  objectHasOfi?: boolean;
  objectInstallationType?: InstallationType;
}

export interface WorkflowTransition {
  objectId: number;
  newStatus: ObjectStatus;
  newDepartment: Department;
  description?: string;
}
