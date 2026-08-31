/**
 * Etykiety i stałe katalogu usług — wspólne dla strony i formularza,
 * w konwencji `warehouseShared.ts` (Record z etykietą i tonem pigułki).
 */
import type { PillTone } from "@/lib/calendar-labels";
import type { ServiceCategory, ServiceSystem } from "@/lib/api";

export const SERVICE_CATEGORY_LABEL: Record<ServiceCategory, string> = {
  montaz: "Montaż",
  uruchomienie: "Uruchomienie",
  konfiguracja: "Konfiguracja",
  serwis: "Serwis",
  projekt: "Projekt",
  abonament: "Abonament",
  inne: "Inne",
};

export const SERVICE_CATEGORY_TONE: Record<ServiceCategory, PillTone> = {
  montaz: "sky",
  uruchomienie: "teal",
  konfiguracja: "violet",
  serwis: "amber",
  projekt: "indigo",
  abonament: "emerald",
  inne: "muted",
};

export const SERVICE_SYSTEM_LABEL: Record<ServiceSystem, string> = {
  cctv: "CCTV",
  sswin: "SSWiN",
  kd: "Kontrola dostępu",
  ppoz: "PPOŻ",
  sieci: "Sieci",
  inne: "Inne",
};

/** Podpowiedzi jednostek — pole zostaje wolnym tekstem. */
export const SERVICE_UNITS = ["szt", "RBH", "mb", "kpl", "km", "mies."];
