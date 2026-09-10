// Najnowsze pierwsze. Utrzymywane przez skill /commit.

import { UPDATES_2026 } from "./updates.2026";

/** Rodzaj wpisu — decyduje o ikonie i kolorze na stronie „Co nowego”. */
export type UpdateType = "feat" | "fix" | "tweak" | "style";

/**
 * Moduł aplikacji, którego dotyczy wpis — odpowiada sekcjom menu bocznego.
 * `ogolne` to zmiany przekrojowe (logowanie, menu, panel admina, wydajność).
 */
export type UpdateModule =
  | "ogolne"
  | "analityka"
  | "kadry"
  | "cma"
  | "handlowy"
  | "techniczny"
  | "ofi";

/** Etykiety modułów pokazywane przy wpisach i w filtrze. */
export const MODULE_LABELS: Record<UpdateModule, string> = {
  ogolne: "Ogólne",
  analityka: "Analityka",
  kadry: "Kadry",
  cma: "CMA",
  handlowy: "Handlowy",
  techniczny: "Techniczny",
  ofi: "OFI",
};

/** Pojedynczy punkt na liście zmian jednej wersji. */
export interface UpdateEntry {
  text: string;
  type: UpdateType;
  module: UpdateModule;
}

/** Jedna karta na stronie „Co nowego”. */
export interface VersionUpdate {
  /**
   * Wersja aplikacji, np. `'1.2.0'`, albo zakres z półpauzą (`'1.2.0–1.2.3'`),
   * gdy kilka wydań tego samego dnia trafiło do jednej karty. Brak wersji =
   * wpis historyczny sprzed wprowadzenia wersjonowania.
   */
  version?: string;
  /** Data wydania w formacie `YYYY-MM-DD`. */
  date: string;
  /** Tytuł karty — tylko dla kamieni milowych. */
  title?: string;
  entries: UpdateEntry[];
}

/**
 * Wpisy dopisywane na bieżąco przez `/commit` (najnowsze pierwsze). Historia
 * zamknięta leży w plikach rocznych `updates.YYYY.ts` — gdy ta lista urośnie
 * albo zmieni się rok, przenosi się ją na górę pliku bieżącego roku.
 */
export const UPDATES_CURRENT: VersionUpdate[] = [
  {
    version: "1.2.0",
    date: "2026-09-10",
    title: "Co nowego w aplikacji",
    entries: [
      {
        text: "Nowa strona „Co nowego” z historią zmian od początku aplikacji, z filtrem po module i typie zmiany",
        type: "feat",
        module: "ogolne",
      },
      {
        text: "Numer wersji w prawym dolnym rogu prowadzi wprost do listy zmian, bez pytania w firmie, co weszło z ostatnią aktualizacją",
        type: "feat",
        module: "ogolne",
      },
    ],
  },
];

/** Pełna historia zmian — najnowsze pierwsze. */
export const UPDATES: VersionUpdate[] = [...UPDATES_CURRENT, ...UPDATES_2026];
