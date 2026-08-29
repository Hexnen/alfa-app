/**
 * Dwa wymiary realizacji: RODZAJ prac (`work_type`) i TYP rozliczenia (`billing`).
 *
 * Do sierpnia 2026 oba mieszały się w jednej kolumnie `realizations.kind`
 * (`service|warranty|installation`), przez co „serwis gwarancyjny” i „montaż
 * gwarancyjny” były nie do odróżnienia. Kalendarz miał ten podział od początku
 * (`calendar_events.type` + `calendar_events.billing`) — realizacje go przejmują.
 *
 * `kind` zostaje jako pole ZGODNOŚCIOWE (wyliczane przy każdym zapisie), bo
 * czytają je protokoły (`workTypeFromKind`), wyceny i starsze raporty.
 */
import type {
  CalendarBilling,
  CalendarEventType,
  RealizationBilling,
  RealizationWorkType,
} from "../db/schema.js";
import { REALIZATION_BILLINGS, REALIZATION_WORK_TYPES } from "../db/schema.js";

export type RealizationKind = "service" | "warranty" | "installation";

/**
 * Pole zgodnościowe `kind` z pary (rodzaj, rozliczenie).
 * Gwarancja wygrywa z rodzajem — dokładnie jak w starym `realizationKindOf`
 * (wydarzenie → realizacja), więc dla danych sprzed rozdzielenia pól wartość
 * `kind` wychodzi identyczna. `free` NIE mapuje się na „warranty”: w starym
 * słowniku nie istniał, a protokół montażu darmowego ma zostać montażem.
 */
export function realizationKindFrom(
  workType: RealizationWorkType,
  billing: RealizationBilling,
): RealizationKind {
  if (billing === "warranty") return "warranty";
  if (workType === "montaz") return "installation";
  return "service";
}

/** Rodzaj prac z typu wydarzenia kalendarza (biuro/przygotowanie/urlop → „inne”). */
export function realizationWorkTypeOf(type: CalendarEventType | string): RealizationWorkType {
  return (REALIZATION_WORK_TYPES as readonly string[]).includes(type)
    ? (type as RealizationWorkType)
    : "inne";
}

/** Rozliczenie z wydarzenia; NULL (typ bez rozliczenia) → płatne. */
export function realizationBillingOf(billing: CalendarBilling | null | undefined): RealizationBilling {
  return billing === "warranty" || billing === "free" ? billing : "paid";
}

/**
 * Rozbicie starego `kind` na parę (rodzaj, rozliczenie) — używane przez migrację
 * danych i przez API, gdy klient przysłał wyłącznie `kind` (starszy front).
 */
export function splitLegacyKind(kind: string | null | undefined): {
  workType: RealizationWorkType;
  billing: RealizationBilling;
} {
  if (kind === "installation") return { workType: "montaz", billing: "paid" };
  if (kind === "warranty") return { workType: "serwis", billing: "warranty" };
  return { workType: "serwis", billing: "paid" };
}

export const isRealizationWorkType = (v: unknown): v is RealizationWorkType =>
  typeof v === "string" && (REALIZATION_WORK_TYPES as readonly string[]).includes(v);

export const isRealizationBilling = (v: unknown): v is RealizationBilling =>
  typeof v === "string" && (REALIZATION_BILLINGS as readonly string[]).includes(v);

/** Etykiety PL — activity_log, asystent, raporty. */
export const REALIZATION_WORK_TYPE_LABELS: Record<RealizationWorkType, string> = {
  serwis: "Serwis",
  montaz: "Montaż",
  wizja: "Wizja",
  demontaz: "Demontaż",
  konserwacja: "Konserwacja",
  inne: "Inne",
};

export const REALIZATION_BILLING_LABELS: Record<RealizationBilling, string> = {
  paid: "Płatny",
  warranty: "Gwarancyjny",
  free: "Darmowy",
};
