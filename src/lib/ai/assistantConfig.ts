/**
 * Pełna konfiguracja Asystenta AI — jedno źródło prawdy dla wartości efektywnych.
 *
 * Każde pole: tabela app_settings (klucz `assistant.*`, panel admina /admin/asystent)
 * → zmienna env (tylko część pól) → wartość domyślna. Wszystko czytane przy KAŻDEJ
 * turze (assistant.ts / calendarPrompt.ts / calendarTools.ts) — bez restartu backendu.
 *
 * Klucz API NIE jest tu polem (patrz provider.ts: resolveApiKey — DB → env → plik);
 * ASSISTANT_FIELDS opisuje wyłącznie ustawienia, które wolno zwracać do frontu.
 */
import { CALENDAR_EVENT_STATUSES, CALENDAR_EVENT_TYPES } from "../../db/schema.js";
import { getSetting } from "../settings.js";

export const REASONING_EFFORTS = ["", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const PROVIDER_SORTS = ["latency", "price", "throughput", ""] as const;
export type ProviderSort = (typeof PROVIDER_SORTS)[number];
export const ACCESS_MODES = ["admins", "calendar_editors"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const DEFAULT_STATUSES = ["planned", "confirmed"] as const;

/** Narzędzia, które admin może wyłączyć (propose_event jest obowiązkowe). */
export const TOOL_META = [
  { name: "find_object", label: "Szukaj obiektu", description: "Wyszukiwanie obiektu klienta po nazwie/adresie/mieście.", required: false },
  { name: "find_technician", label: "Szukaj technika", description: "Wyszukiwanie technika po imieniu/nazwisku.", required: false },
  { name: "list_events", label: "Lista wydarzeń", description: "Grafik w zakresie dat z filtrem technika/obiektu.", required: false },
  { name: "check_conflicts", label: "Sprawdź kolizje", description: "Kolizje techników z innymi wydarzeniami i urlopami.", required: false },
  { name: "find_free_slots", label: "Wolne terminy", description: "Najbliższe wolne okna dla wskazanych techników (godziny pracy, pon–pt, bez kolizji i urlopów).", required: false },
  { name: "ask_choice", label: "Pytania z przyciskami", description: "Doprecyzowanie wyboru (obiekt, technik, termin) kartą z przyciskami zamiast pytania tekstowego.", required: false },
  { name: "propose_event", label: "Zaproponuj wydarzenie", description: "Karta propozycji do zatwierdzenia — nie da się wyłączyć.", required: true },
] as const;
export type ToolName = (typeof TOOL_META)[number]["name"];
export const OPTIONAL_TOOLS: string[] = TOOL_META.filter((t) => !t.required).map((t) => t.name);

export interface AssistantSettingsValues {
  enabled: boolean;
  baseUrl: string;
  providerLabel: string;
  model: string;
  providerSort: ProviderSort;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
  historyTokenBudget: number;
  reasoningEffort: ReasoningEffort;
  customInstructions: string;
  personaName: string;
  greeting: string;
  suggestions: string[];
  workStart: string;
  workEnd: string;
  defaultDurationHours: number;
  allDayTypes: string[];
  defaultStatus: "planned" | "confirmed";
  allowRecurrence: boolean;
  maxHorizonDays: number;
  disabledTools: string[];
  access: AccessMode;
  retentionDays: number;
  dailyTurnLimit: number;
}

export type AssistantField = keyof AssistantSettingsValues;
export type Source = "db" | "env" | "default";

export const ASSISTANT_DEFAULTS: AssistantSettingsValues = {
  enabled: true,
  baseUrl: "https://openrouter.ai/api/v1",
  providerLabel: "OpenRouter",
  model: "deepseek/deepseek-v4-flash",
  providerSort: "latency",
  temperature: 0.3,
  maxOutputTokens: 1200,
  maxSteps: 6,
  historyTokenBudget: 12000,
  reasoningEffort: "",
  customInstructions: "",
  personaName: "Asystent",
  greeting: "",
  suggestions: [
    "Zaplanuj serwis w Magazynie Centralnym w przyszły wtorek 9–12",
    "Co ma Wojtek w przyszłym tygodniu?",
    "Dodaj urlop technika od poniedziałku do piątku",
  ],
  workStart: "08:00",
  workEnd: "16:00",
  defaultDurationHours: 2,
  allDayTypes: ["biuro", "przygotowanie", "urlop"],
  defaultStatus: "planned",
  allowRecurrence: true,
  maxHorizonDays: 90,
  disabledTools: [],
  access: "admins",
  retentionDays: 0,
  dailyTurnLimit: 0,
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MODEL_RE = /^[\w.:-]+\/[\w.:-]+$/;

export interface FieldDef<T> {
  /** Klucz w app_settings. */
  dbKey: string;
  /** Zmienna środowiskowa (opcjonalnie). */
  env?: string;
  type: "boolean" | "string" | "number" | "enum" | "stringArray";
  /** Etykieta PL do summary w activity_log. */
  label: string;
  /** Walidacja wartości z API (już w typie docelowym). Zwraca komunikat błędu albo null. */
  validate: (v: unknown) => string | null;
  /** Tekst z DB/env → wartość; undefined = nieprawidłowy (pomijamy, lecimy dalej w precedencji). */
  parse: (raw: string) => T | undefined;
  /** Wartość → tekst do DB. */
  serialize: (v: T) => string;
  /** Formatowanie do summary. */
  format?: (v: T) => string;
}

function numberField(opts: { dbKey: string; label: string; min: number; max: number; integer: boolean; env?: string }): FieldDef<number> {
  const { min, max, integer } = opts;
  const ok = (n: number) => Number.isFinite(n) && (!integer || Number.isInteger(n)) && n >= min && n <= max;
  return {
    dbKey: opts.dbKey,
    env: opts.env,
    type: "number",
    label: opts.label,
    validate: (v) => (typeof v === "number" && ok(v) ? null : `${opts.label}: liczba ${integer ? "całkowita " : ""}${min}–${max}`),
    parse: (raw) => {
      const n = Number(raw);
      return ok(n) ? n : undefined;
    },
    serialize: (v) => String(v),
  };
}

function stringField(opts: { dbKey: string; label: string; max: number; env?: string; pattern?: RegExp; patternMsg?: string; allowEmpty?: boolean }): FieldDef<string> {
  return {
    dbKey: opts.dbKey,
    env: opts.env,
    type: "string",
    label: opts.label,
    validate: (v) => {
      if (typeof v !== "string") return `${opts.label}: oczekiwano tekstu`;
      const s = v.trim();
      if (!s && !opts.allowEmpty) return `${opts.label}: wartość nie może być pusta`;
      if (s.length > opts.max) return `${opts.label}: maks. ${opts.max} znaków`;
      if (s && opts.pattern && !opts.pattern.test(s)) return opts.patternMsg ?? `${opts.label}: nieprawidłowy format`;
      return null;
    },
    parse: (raw) => {
      const s = raw.trim();
      if (!s && !opts.allowEmpty) return undefined;
      if (s.length > opts.max) return undefined;
      if (s && opts.pattern && !opts.pattern.test(s)) return undefined;
      return s;
    },
    serialize: (v) => v.trim(),
    format: (v) => (v.trim() ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : "(puste)"),
  };
}

function enumField<T extends string>(opts: { dbKey: string; label: string; values: readonly T[]; env?: string; aliases?: Record<string, T> }): FieldDef<T> {
  const norm = (s: string): T | undefined => {
    const v = s.trim().toLowerCase();
    if (opts.aliases && v in opts.aliases) return opts.aliases[v];
    return (opts.values as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  return {
    dbKey: opts.dbKey,
    env: opts.env,
    type: "enum",
    label: opts.label,
    validate: (v) =>
      typeof v === "string" && (opts.values as readonly string[]).includes(v)
        ? null
        : `${opts.label}: dozwolone ${opts.values.map((x) => (x === "" ? "(puste)" : x)).join(", ")}`,
    parse: norm,
    serialize: (v) => v,
    format: (v) => (v === "" ? "brak" : v),
  };
}

function booleanField(opts: { dbKey: string; label: string; env?: string }): FieldDef<boolean> {
  return {
    dbKey: opts.dbKey,
    env: opts.env,
    type: "boolean",
    label: opts.label,
    validate: (v) => (typeof v === "boolean" ? null : `${opts.label}: oczekiwano true/false`),
    parse: (raw) => {
      const v = raw.trim().toLowerCase();
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return undefined;
    },
    serialize: (v) => (v ? "1" : "0"),
    format: (v) => (v ? "tak" : "nie"),
  };
}

function stringArrayField(opts: {
  dbKey: string;
  label: string;
  minLen?: number;
  maxLen: number;
  itemMax?: number;
  allowed?: readonly string[];
}): FieldDef<string[]> {
  const check = (arr: unknown): string | null => {
    if (!Array.isArray(arr)) return `${opts.label}: oczekiwano tablicy`;
    if (arr.length > opts.maxLen) return `${opts.label}: maks. ${opts.maxLen} elementów`;
    if (opts.minLen !== undefined && arr.length < opts.minLen) return `${opts.label}: min. ${opts.minLen} elementów`;
    for (const it of arr) {
      if (typeof it !== "string" || !it.trim()) return `${opts.label}: elementy muszą być niepustym tekstem`;
      if (opts.itemMax && it.trim().length > opts.itemMax) return `${opts.label}: element maks. ${opts.itemMax} znaków`;
      if (opts.allowed && !opts.allowed.includes(it.trim())) return `${opts.label}: niedozwolona wartość „${it}” (dozwolone: ${opts.allowed.join(", ")})`;
    }
    return null;
  };
  return {
    dbKey: opts.dbKey,
    type: "stringArray",
    label: opts.label,
    validate: check,
    parse: (raw) => {
      try {
        const arr = JSON.parse(raw) as unknown;
        if (check(arr) !== null) return undefined;
        return [...new Set((arr as string[]).map((s) => s.trim()))];
      } catch {
        return undefined;
      }
    },
    serialize: (v) => JSON.stringify([...new Set(v.map((s) => s.trim()))]),
    format: (v) => (v.length ? v.join(", ") : "(brak)"),
  };
}

export const ASSISTANT_FIELDS: { [K in AssistantField]: FieldDef<AssistantSettingsValues[K]> } = {
  enabled: booleanField({ dbKey: "assistant.enabled", label: "Asystent włączony" }),
  baseUrl: stringField({
    dbKey: "assistant.base_url",
    env: "OPENROUTER_BASE_URL",
    label: "Adres API",
    max: 300,
    pattern: /^https?:\/\/[^\s]+$/i,
    patternMsg: "Adres API: oczekiwano http(s)://…",
  }),
  providerLabel: stringField({ dbKey: "assistant.provider_label", label: "Nazwa dostawcy", max: 40 }),
  model: stringField({
    dbKey: "assistant.model",
    env: "OPENROUTER_MODEL",
    label: "Model",
    max: 200,
    pattern: MODEL_RE,
    patternMsg: "Model: oczekiwany format dostawca/nazwa (np. deepseek/deepseek-v4-flash)",
  }),
  providerSort: enumField({
    dbKey: "assistant.provider_sort",
    env: "OPENROUTER_PROVIDER_SORT",
    label: "Sortowanie dostawców",
    values: PROVIDER_SORTS,
    aliases: { none: "" },
  }),
  temperature: numberField({ dbKey: "assistant.temperature", label: "Temperatura", min: 0, max: 1, integer: false }),
  maxOutputTokens: numberField({ dbKey: "assistant.max_output_tokens", label: "Limit tokenów odpowiedzi", min: 100, max: 32000, integer: true }),
  maxSteps: numberField({ dbKey: "assistant.max_steps", label: "Limit kroków", min: 1, max: 20, integer: true }),
  historyTokenBudget: numberField({ dbKey: "assistant.history_token_budget", label: "Budżet tokenów historii", min: 2000, max: 200000, integer: true }),
  reasoningEffort: enumField({ dbKey: "assistant.reasoning_effort", label: "Rozumowanie", values: REASONING_EFFORTS, aliases: { none: "" } }),
  // Limit 2000: instrukcje trafiają PRZED „## Zasady” (z notą o pierwszeństwie zasad) — dłuższe rozmywały reguły i kosztowały ~2k tok/krok.
  customInstructions: stringField({ dbKey: "assistant.custom_instructions", label: "Dodatkowe instrukcje", max: 2000, allowEmpty: true }),
  personaName: stringField({ dbKey: "assistant.persona_name", label: "Nazwa asystenta", max: 40 }),
  greeting: stringField({ dbKey: "assistant.greeting", label: "Powitanie", max: 500, allowEmpty: true }),
  suggestions: stringArrayField({ dbKey: "assistant.suggestions", label: "Podpowiedzi", minLen: 0, maxLen: 5, itemMax: 120 }),
  workStart: stringField({ dbKey: "assistant.rules.work_start", label: "Początek dnia pracy", max: 5, pattern: HHMM_RE, patternMsg: "Początek dnia pracy: format HH:MM" }),
  workEnd: stringField({ dbKey: "assistant.rules.work_end", label: "Koniec dnia pracy", max: 5, pattern: HHMM_RE, patternMsg: "Koniec dnia pracy: format HH:MM" }),
  defaultDurationHours: numberField({ dbKey: "assistant.rules.default_duration_hours", label: "Domyślny czas trwania (h)", min: 0.5, max: 12, integer: false }),
  allDayTypes: stringArrayField({ dbKey: "assistant.rules.all_day_types", label: "Typy całodniowe", maxLen: CALENDAR_EVENT_TYPES.length, allowed: CALENDAR_EVENT_TYPES }),
  defaultStatus: enumField({ dbKey: "assistant.rules.default_status", label: "Domyślny status", values: DEFAULT_STATUSES }),
  allowRecurrence: booleanField({ dbKey: "assistant.rules.allow_recurrence", label: "Serie wydarzeń" }),
  maxHorizonDays: numberField({ dbKey: "assistant.rules.max_horizon_days", label: "Maks. horyzont (dni)", min: 7, max: 730, integer: true }),
  disabledTools: stringArrayField({ dbKey: "assistant.tools.disabled", label: "Wyłączone narzędzia", maxLen: OPTIONAL_TOOLS.length, allowed: OPTIONAL_TOOLS }),
  access: enumField({ dbKey: "assistant.access", label: "Dostęp", values: ACCESS_MODES }),
  retentionDays: numberField({ dbKey: "assistant.retention_days", label: "Retencja czatów (dni)", min: 0, max: 3650, integer: true }),
  dailyTurnLimit: numberField({ dbKey: "assistant.daily_turn_limit", label: "Dzienny limit tur", min: 0, max: 10000, integer: true }),
};

export const ASSISTANT_FIELD_NAMES = Object.keys(ASSISTANT_FIELDS) as AssistantField[];

/** Wartość efektywna jednego pola + źródło (DB → env → default). */
export function resolveField<K extends AssistantField>(name: K): { value: AssistantSettingsValues[K]; source: Source } {
  const def = ASSISTANT_FIELDS[name] as FieldDef<AssistantSettingsValues[K]>;
  const fromDb = getSetting(def.dbKey);
  if (fromDb !== null) {
    const v = def.parse(fromDb);
    if (v !== undefined) return { value: v, source: "db" };
  }
  if (def.env) {
    const raw = process.env[def.env];
    if (raw !== undefined) {
      const v = def.parse(raw);
      if (v !== undefined) return { value: v, source: "env" };
    }
  }
  return { value: ASSISTANT_DEFAULTS[name], source: "default" };
}

export interface AssistantConfig {
  values: AssistantSettingsValues;
  sources: Record<AssistantField, Source>;
  /** baseUrl wskazuje na OpenRouter (providerSort/usage.include tylko wtedy). */
  isOpenRouter: boolean;
  /** Efektywna lista narzędzi (po odjęciu wyłączonych). */
  enabledTools: string[];
}

export function isOpenRouterUrl(baseUrl: string): boolean {
  return /openrouter\.ai/i.test(baseUrl);
}

/** Zbiera wszystkie pola (czytane z DB przy każdym wywołaniu — tanie zapytania po PK). */
export function getAssistantConfig(): AssistantConfig {
  const values = {} as AssistantSettingsValues;
  const sources = {} as Record<AssistantField, Source>;
  for (const name of ASSISTANT_FIELD_NAMES) {
    const r = resolveField(name);
    (values as unknown as Record<string, unknown>)[name] = r.value;
    sources[name] = r.source;
  }
  // Wyłączone narzędzia nigdy nie obejmują propose_event (walidacja też to blokuje).
  values.disabledTools = values.disabledTools.filter((t) => OPTIONAL_TOOLS.includes(t));
  return {
    values,
    sources,
    isOpenRouter: isOpenRouterUrl(values.baseUrl),
    enabledTools: TOOL_META.map((t) => t.name).filter((t) => !values.disabledTools.includes(t)),
  };
}

/** Słowniki dla panelu admina (meta w GET /settings). */
export function assistantMeta() {
  return {
    eventTypes: [...CALENDAR_EVENT_TYPES],
    statuses: [...CALENDAR_EVENT_STATUSES],
    tools: TOOL_META.map((t) => ({ ...t })),
    reasoningEfforts: [...REASONING_EFFORTS],
    providerSorts: [...PROVIDER_SORTS],
    accessModes: [...ACCESS_MODES],
    defaultStatuses: [...DEFAULT_STATUSES],
  };
}
