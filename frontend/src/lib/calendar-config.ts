/**
 * Konfiguracja kalendarza per dział — jeden silnik, dwie konfiguracje.
 *
 * `CalendarPage` i `CalendarEventDialog` dostają `config` i z niego biorą
 * WSZYSTKO, co różni dział techniczny od handlowego: klucze uprawnień, prefiks
 * localStorage, listę typów, nazwę pola z przypisanymi osobami i zestaw
 * włączonych funkcji. Dzięki temu „techniczny" po refaktorze ma dosłownie te
 * same ścieżki, co przed nim (wszystkie flagi `true`, klucze `alfa.calendar.*`
 * nietknięte), a handlowy jest wyłącznie inną konfiguracją, nie kopią kodu.
 *
 * Most nad API jest celowo cienki: `CalendarEvent` NIE dostaje generycznego
 * pola `assignees` — zamiast tego cztery helpery poniżej tłumaczą nazwę pola.
 */
import {
  getSalespeople,
  getTechnicians,
  type CalendarDepartment,
  type CalendarEvent,
  type CalendarEventStatus,
  type CalendarEventType,
} from "@/lib/api";
import { DEPARTMENT_TYPE_ORDER, EVENT_STATUS_ORDER } from "@/lib/calendar-labels";

/** Osoba, którą da się przypisać do wydarzenia: technik albo handlowiec. */
export interface AssigneeRef {
  id: number;
  firstName: string;
  lastName: string;
  active?: boolean;
}

/** Teksty zależne od tego, kogo się przypisuje (liczba mnoga po polsku boli). */
export interface AssigneeLabels {
  /** Liczba pojedyncza, mianownik: „Technik" / „Handlowiec". */
  one: string;
  /** Liczba mnoga: „Technicy" / „Handlowcy". */
  many: string;
  /** Zachęta w pickerze: „Wybierz techników". */
  pick: string;
  /** Stan pusty: „Bez technika". */
  none: string;
  /** Walidacja urlopu: „Urlop wymaga wskazania technika." */
  leave: string;
  /** aria-label panelu wyboru w filtrze: „Wybór techników". */
  pickAria: string;
  /** Placeholder szukajki w filtrze: „Szukaj technika…". */
  search: string;
  /** Pusta lista w filtrze: „Brak aktywnych techników". */
  empty: string;
  /** Prefiks dymka przycisku filtra: „Filtr techników". */
  filterLabel: string;
  /** Dymek pustego filtra: „Filtruj wydarzenia po przypisanych technikach". */
  filterHint: string;
}

export interface CalendarAssigneeConfig {
  /** Pole w `CalendarEvent` z listą przypisanych. */
  field: "technicians" | "salespeople";
  /** Pole w `CalendarEventInput` z identyfikatorami. */
  idsField: "technicianIds" | "salespersonIds";
  /** Parametr `GET /calendar/events`. */
  queryParam: "technicianId" | "salespersonId";
  /** Parametr `GET /calendar/conflicts`. */
  conflictParam: "technicianIds" | "salespersonIds";
  /** Skąd wziąć listę do filtra i pickera (tylko aktywni). */
  load: () => Promise<AssigneeRef[]>;
  labels: AssigneeLabels;
}

/** Funkcje kalendarza włączane per dział — patrz komentarze przy obu stałych. */
export interface CalendarFeatures {
  routePlanner: boolean;
  weather: boolean;
  billing: boolean;
  protocol: boolean;
  quote: boolean;
  realization: boolean;
  filterSets: boolean;
  noteMentions: boolean;
  objectPicker: boolean;
  leadPicker: boolean;
  contactPicker: boolean;
  assistant: boolean;
}

export interface CalendarConfig {
  department: CalendarDepartment;
  /** Klucz uprawnień do podglądu. */
  viewTab: string;
  /** Klucze dające edycję — `canEdit` to OR po tej liście. */
  editTabs: string[];
  /** Prefiks kluczy localStorage (widok, grupowanie tablicy, filtry…). */
  storageKeyPrefix: string;
  /** Adres strony kalendarza — deep linki i powroty z dialogu. */
  baseHref: string;
  title: string;
  typeOrder: CalendarEventType[];
  statusOrder: CalendarEventStatus[];
  /** Kogo dotyczy urlop w tym dziale. */
  urlopKind: "technician" | "salesperson";
  assignees: CalendarAssigneeConfig;
  features: CalendarFeatures;
}

const mapAssignees = (
  rows: { id: number; firstName: string; lastName: string; active?: boolean }[]
): AssigneeRef[] =>
  rows.map((r) => ({ id: r.id, firstName: r.firstName, lastName: r.lastName, active: r.active }));

/** Kalendarz techniczny — stan sprzed refaktoru: wszystko włączone. */
export const TECHNICAL_CALENDAR: CalendarConfig = {
  department: "technical",
  viewTab: "technical/kalendarz",
  editTabs: ["technical/kalendarz"],
  // NIE zmieniać: pod tym prefiksem siedzą zapisane widoki i filtry użytkowników.
  storageKeyPrefix: "alfa.calendar",
  baseHref: "/technical/kalendarz",
  title: "Kalendarz",
  typeOrder: DEPARTMENT_TYPE_ORDER.technical,
  statusOrder: EVENT_STATUS_ORDER,
  urlopKind: "technician",
  assignees: {
    field: "technicians",
    idsField: "technicianIds",
    queryParam: "technicianId",
    conflictParam: "technicianIds",
    load: async () => mapAssignees((await getTechnicians(true)).data ?? []),
    labels: {
      one: "Technik",
      many: "Technicy",
      pick: "Wybierz techników",
      none: "Bez technika",
      leave: "Urlop wymaga wskazania technika.",
      pickAria: "Wybór techników",
      search: "Szukaj technika…",
      empty: "Brak aktywnych techników",
      filterLabel: "Filtr techników",
      filterHint: "Filtruj wydarzenia po przypisanych technikach",
    },
  },
  features: {
    routePlanner: true,
    weather: true,
    billing: true,
    protocol: true,
    quote: true,
    realization: true,
    filterSets: true,
    noteMentions: true,
    objectPicker: true,
    leadPicker: false,
    contactPicker: false,
    assistant: true,
  },
};

/**
 * Kalendarz handlowy. Wyłączone jest to, co należy do świata techniki
 * (trasa, pogoda, rozliczenia, protokoły, wyceny, realizacje) oraz zestawy
 * filtrów i asystent, które w v1 zostają techniczne. Dochodzą pickery szansy
 * i osoby kontaktowej.
 *
 * Edycję daje `handlowy/kalendarz` ALBO `handlowy/leady` — handlowiec
 * planujący następny krok z karty szansy nie potrzebuje drugiego klucza.
 */
export const SALES_CALENDAR: CalendarConfig = {
  department: "handlowy",
  viewTab: "handlowy/kalendarz",
  editTabs: ["handlowy/kalendarz", "handlowy/leady"],
  storageKeyPrefix: "alfa.handlowy.calendar",
  baseHref: "/handlowy/kalendarz",
  title: "Kalendarz",
  typeOrder: DEPARTMENT_TYPE_ORDER.handlowy,
  statusOrder: EVENT_STATUS_ORDER,
  urlopKind: "salesperson",
  assignees: {
    field: "salespeople",
    idsField: "salespersonIds",
    queryParam: "salespersonId",
    conflictParam: "salespersonIds",
    load: async () => mapAssignees((await getSalespeople(true)).data ?? []),
    labels: {
      one: "Handlowiec",
      many: "Handlowcy",
      pick: "Wybierz handlowców",
      none: "Bez handlowca",
      leave: "Urlop wymaga wskazania handlowca.",
      pickAria: "Wybór handlowców",
      search: "Szukaj handlowca…",
      empty: "Brak aktywnych handlowców",
      filterLabel: "Filtr handlowców",
      filterHint: "Filtruj wydarzenia po przypisanych handlowcach",
    },
  },
  features: {
    routePlanner: false,
    weather: false,
    billing: false,
    protocol: false,
    quote: false,
    realization: false,
    filterSets: false,
    noteMentions: false,
    objectPicker: true,
    leadPicker: true,
    contactPicker: true,
    assistant: false,
  },
};

// --- Most nad różnicą w nazwach pól API -----------------------------------

/** Przypisani do wydarzenia w tym dziale (pusta lista, gdy backend pola nie odesłał). */
export const assigneesOf = (
  ev: Pick<CalendarEvent, "technicians" | "salespeople">,
  cfg: CalendarConfig
): AssigneeRef[] => ev[cfg.assignees.field] ?? [];

/** Fragment `CalendarEventInput` z identyfikatorami przypisanych. */
export const assigneeIdsInput = (
  ids: number[],
  cfg: CalendarConfig
): { technicianIds: number[] } | { salespersonIds: number[] } =>
  cfg.assignees.idsField === "technicianIds" ? { technicianIds: ids } : { salespersonIds: ids };

/** Fragment `CalendarEventsQuery` z filtrem przypisanych (pusty przy braku wyboru). */
export const assigneeQuery = (
  ids: number[],
  cfg: CalendarConfig
): { technicianId?: number[]; salespersonId?: number[] } => {
  if (!ids.length) return {};
  return cfg.assignees.queryParam === "technicianId" ? { technicianId: ids } : { salespersonId: ids };
};

/** Fragment `CalendarConflictsQuery` z identyfikatorami przypisanych. */
export const assigneeConflictQuery = (
  ids: number[],
  cfg: CalendarConfig
): { technicianIds: number[] } | { salespersonIds: number[] } =>
  cfg.assignees.conflictParam === "technicianIds" ? { technicianIds: ids } : { salespersonIds: ids };

/** Klucz localStorage w przestrzeni działu: `storageKey(cfg, "view")`. */
export const storageKey = (cfg: CalendarConfig, name: string): string =>
  `${cfg.storageKeyPrefix}.${name}`;

/** Konfiguracja dla działu — do miejsc, które znają tylko `department` z wiersza. */
export const calendarConfigFor = (department: CalendarDepartment): CalendarConfig =>
  department === "handlowy" ? SALES_CALENDAR : TECHNICAL_CALENDAR;
