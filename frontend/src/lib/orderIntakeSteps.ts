import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { validateNIP } from "./nip";
import { todayIsoLocal } from "./utils";
import type { ObjectServiceInput } from "./api";

/**
 * Shared 8-step config for BOTH order-intake forms (internal
 * `OrderIntakeForm` app-themed + external `PublicOrderForm` blue-themed).
 * Keeps field grouping + per-step validation in one place; each form renders
 * its own themed inputs per step but shares the flow / validation logic.
 */

export const INVOICE_ISSUERS = [
  "ALFA GROUP SP Z O.O.",
  "ALFA GROUP S SP Z O.O.",
] as const;

/** Rodzaje obiektów oferowane w kroku „Dane obiektu" (pole opcjonalne). */
export const OBJECT_KINDS = [
  "Salon samochodowy",
  "Wspólnota mieszkaniowa",
  "Farma fotowoltaiczna",
  "Teren budowy",
  "Teren produkcyjny",
  "Dom prywatny",
  "Inne",
] as const;

/** Single form state shape used by both forms (text inputs kept as strings). */
export interface OrderIntakeFormState {
  // 1. Osoba zlecająca
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  // 2. Kontrahent (płatnik)
  payerName: string;
  payerNip: string;
  payerInvoiceEmail: string;
  invoiceIssuer: string;
  // 3. Pytania (gating booleans)
  isCameraInstallation: boolean;
  internetIncluded: boolean;
  interventionGroup: boolean;
  // 4. Dane obiektu
  objectName: string;
  objectKind: string;
  objectAddress: string;
  objectCity: string;
  objectLocationUrl: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  // 5. Montaż (only when isCameraInstallation)
  vtoolsOfferNumber: string;
  // 6. Zakres i warunki usługi
  cameraCount: string;
  videoReception: boolean;
  megaphoneCount: string;
  monthlyAmount: string;
  contractLengthMonths: string;
  rentalAmount: string;
  rentalLengthMonths: string;
  // 7. Terminy
  installationStartDate: string;
  serviceStartDate: string;
  notes: string;
  /**
   * OKRESY USŁUG ZAKŁADANEGO OBIEKTU (Część 3 planu). Zlecenie zakłada obiekt,
   * a obiekt opisuje usługi okresami, nie flagami — więc lista musi powstać już
   * tutaj, razem ze zleceniem.
   *
   * Wewnętrzny wizard edytuje ją wprost (`ObjectServicesEditor` w kroku
   * „Zakres”); publiczny formularz jej NIE pokazuje — klient odpowiada tylko na
   * pytania o montaż kamer i wideorecepcję, a okresy powstają z tych odpowiedzi
   * dopiero w payloadzie (i tak samo, awaryjnie, na backendzie —
   * src/routes/public.ts:240).
   */
  objectServices: ObjectServiceInput[];
}

export const emptyIntakeState: OrderIntakeFormState = {
  requesterName: "",
  requesterPhone: "",
  requesterEmail: "",
  payerName: "",
  payerNip: "",
  payerInvoiceEmail: "",
  invoiceIssuer: INVOICE_ISSUERS[0],
  isCameraInstallation: false,
  internetIncluded: false,
  interventionGroup: false,
  objectName: "",
  objectKind: "",
  objectAddress: "",
  objectCity: "",
  objectLocationUrl: "",
  contactPerson: "",
  contactPhone: "",
  contactEmail: "",
  vtoolsOfferNumber: "",
  cameraCount: "",
  videoReception: false,
  megaphoneCount: "",
  monthlyAmount: "",
  contractLengthMonths: "",
  rentalAmount: "",
  rentalLengthMonths: "",
  installationStartDate: "",
  serviceStartDate: "",
  notes: "",
  objectServices: [],
};

/**
 * Okresy usług wyprowadzone z odpowiedzi formularza (montaż kamer +
 * wideorecepcja). SSWiN-u i ochrony fizycznej nie zgadujemy: formularz o nie nie
 * pyta, a usługa wpisana „na wszelki wypadek” jest gorsza niż jej brak.
 *
 * Publiczny formularz buduje tym payload (klient nie widzi edytora okresów),
 * a wewnętrzny wizard — prefill listy, zanim ktokolwiek dotknie edytora.
 */
export function servicesFromAnswers(
  form: Pick<
    OrderIntakeFormState,
    "isCameraInstallation" | "cameraCount" | "videoReception" | "serviceStartDate"
  >
): ObjectServiceInput[] {
  const startDate = form.serviceStartDate.trim() || todayIsoLocal();
  const raw = form.cameraCount.trim();
  const cameras = raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const out: ObjectServiceInput[] = [];
  if (form.isCameraInstallation) {
    out.push({ service: "kamery", startDate, endDate: null, cameraCount: cameras });
  }
  if (form.videoReception) {
    out.push({ service: "wideorecepcja", startDate, endDate: null });
  }
  return out;
}

/**
 * Przestawienie startu w wierszach, które nadal trzymają STARĄ podpowiedź.
 *
 * „Początek usługi” z sekcji Terminy jest domyślnym startem okresów, ale ludzie
 * wypełniają formularz w dowolnej kolejności: najpierw dodają usługi (start =
 * dziś), potem wpisują właściwą datę. Wiersz zmieniony ręcznie ma inną datę niż
 * poprzednia podpowiedź, więc zostaje nietknięty.
 */
export function applyDefaultServiceStart(
  services: ObjectServiceInput[],
  prevDefault: string,
  nextDefault: string
): ObjectServiceInput[] {
  if (prevDefault === nextDefault) return services;
  let changed = false;
  const next = services.map((s) => {
    if (s.startDate !== prevDefault) return s;
    changed = true;
    return { ...s, startDate: nextDefault };
  });
  return changed ? next : services;
}

/** A required text field within a step, with a human label for error messages. */
export interface StepRequiredField {
  key: keyof OrderIntakeFormState;
  label: string;
}

export interface OrderIntakeStep {
  id:
    | "requester"
    | "payer"
    | "questions"
    | "location"
    | "object"
    | "installation"
    | "scope"
    | "terms";
  title: string;
  /** Required (non-empty) text fields for this step. */
  required: StepRequiredField[];
  /** Shown only when isCameraInstallation === true (the Montaż step). */
  onlyIfInstallation?: boolean;
}

/** Ordered 8-step spec (same order + fields for both forms). */
export const ORDER_INTAKE_STEPS: OrderIntakeStep[] = [
  {
    id: "requester",
    title: "Osoba zlecająca",
    required: [
      { key: "requesterName", label: "Osoba zlecająca" },
      { key: "requesterPhone", label: "Telefon" },
      { key: "requesterEmail", label: "Email" },
    ],
  },
  {
    id: "payer",
    title: "Kontrahent (płatnik)",
    required: [
      { key: "payerName", label: "Nazwa płatnika" },
      { key: "payerInvoiceEmail", label: "Mail do faktur płatnika" },
    ],
  },
  {
    id: "questions",
    title: "Pytania",
    required: [],
  },
  {
    id: "location",
    title: "Lokalizacja obiektu",
    required: [
      { key: "objectLocationUrl", label: "Pinezka obiektu na mapie" },
    ],
  },
  {
    id: "object",
    title: "Dane obiektu",
    required: [
      { key: "objectName", label: "Nazwa obiektu w SAFESTAR" },
      { key: "contactPerson", label: "Osoba kontaktowa" },
      { key: "contactPhone", label: "Telefon (osoba kontaktowa)" },
    ],
  },
  {
    id: "installation",
    title: "Montaż",
    required: [],
    onlyIfInstallation: true,
  },
  {
    id: "scope",
    title: "Zakres i warunki usługi",
    required: [],
  },
  {
    id: "terms",
    title: "Terminy",
    // `serviceStartDate` jest wymagane WARUNKOWO — dopiero gdy zlecenie zakłada
    // obiektowi jakąkolwiek usługę. `required` opisuje pola wymagane zawsze,
    // więc reguła siedzi w `validateStep` niżej, nie tutaj.
    required: [],
  },
];

/** Steps actually shown for the current form state (Montaż skipped if false). */
export function getVisibleSteps(form: OrderIntakeFormState): OrderIntakeStep[] {
  return ORDER_INTAKE_STEPS.filter(
    (step) => !step.onlyIfInstallation || form.isCameraInstallation
  );
}

export interface StepValidation {
  ok: boolean;
  /** Human message about the first missing/invalid field (when !ok). */
  message?: string;
}

/** Validate a single step's required fields (+ NIP checksum on the payer step). */
export function validateStep(
  step: OrderIntakeStep,
  form: OrderIntakeFormState
): StepValidation {
  for (const field of step.required) {
    const value = form[field.key];
    if (typeof value === "string" && value.trim() === "") {
      return { ok: false, message: `Uzupełnij pole: ${field.label}.` };
    }
  }
  if (step.id === "terms") {
    /*
     * Okres usługi bez daty startu nie istnieje (backend odrzuci go 400), a start
     * podpowiadany jest właśnie z tego pola — więc gdy zlecenie zakłada obiektowi
     * jakąkolwiek usługę, „Początek usługi” przestaje być opcjonalny. Warunek
     * łapie oba formularze: wewnętrzny ma jawną listę okresów, publiczny tylko
     * odpowiedzi, z których ta lista dopiero powstanie (`servicesFromAnswers`).
     */
    const needsStart =
      form.objectServices.length > 0 ||
      form.isCameraInstallation ||
      form.videoReception;
    if (needsStart && form.serviceStartDate.trim() === "") {
      return {
        ok: false,
        message:
          "Podaj przewidywany termin rozpoczęcia usługi — od tej daty liczą się okresy usług obiektu.",
      };
    }
  }
  if (step.id === "payer") {
    if (!validateNIP(form.payerNip)) {
      return { ok: false, message: "Podaj prawidłowy NIP płatnika (10 cyfr)." };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.payerInvoiceEmail.trim())) {
      return { ok: false, message: "Podaj prawidłowy mail do faktur płatnika." };
    }
  }
  return { ok: true };
}

export interface WizardApi {
  visibleSteps: OrderIntakeStep[];
  stepIndex: number;
  currentStep: OrderIntakeStep;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;
  /** Validate the currently visible step against the current form. */
  validateCurrent: () => StepValidation;
  next: () => void;
  back: () => void;
  reset: () => void;
}

/**
 * Minimal wizard helper: tracks the current index into the *visible* steps.
 * Because the Montaż step is filtered out of `visibleSteps` when montaż=false,
 * next()/back() move through visible steps only — the conditional step is
 * skipped in both directions and the counter reflects only visible steps.
 */
export function useOrderIntakeWizard(form: OrderIntakeFormState): WizardApi {
  const [stepIndex, setStepIndex] = useState(0);

  const visibleSteps = useMemo(
    () => getVisibleSteps(form),
    // Only the montaż flag changes which steps are visible.
    [form.isCameraInstallation]
  );

  const clampedIndex = Math.min(stepIndex, visibleSteps.length - 1);
  const currentStep = visibleSteps[clampedIndex];
  const isFirst = clampedIndex === 0;
  const isLast = clampedIndex === visibleSteps.length - 1;

  const next = () =>
    setStepIndex((i) => Math.min(i + 1, visibleSteps.length - 1));
  const back = () => setStepIndex((i) => Math.max(0, i - 1));
  const reset = () => setStepIndex(0);

  return {
    visibleSteps,
    stepIndex: clampedIndex,
    currentStep,
    totalSteps: visibleSteps.length,
    isFirst,
    isLast,
    validateCurrent: () => validateStep(currentStep, form),
    next,
    back,
    reset,
  };
}

/**
 * Form state that autosaves to localStorage on every change and restores it on
 * mount — so a half-filled intake survives a reload/navigation. The draft is
 * kept until the caller invokes `clearDraft()` (do this after a successful
 * submit). Reaching the empty state also clears the stored draft.
 */
export function useOrderIntakeDraft(
  storageKey: string
): [
  OrderIntakeFormState,
  Dispatch<SetStateAction<OrderIntakeFormState>>,
  () => void
] {
  const [form, setForm] = useState<OrderIntakeFormState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return { ...emptyIntakeState, ...JSON.parse(raw) };
    } catch {
      /* corrupt/unavailable storage — fall back to a clean form */
    }
    return emptyIntakeState;
  });

  useEffect(() => {
    try {
      const serialized = JSON.stringify(form);
      if (serialized === JSON.stringify(emptyIntakeState)) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, serialized);
      }
    } catch {
      /* ignore quota / unavailable storage */
    }
  }, [storageKey, form]);

  const clearDraft = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  return [form, setForm, clearDraft];
}
