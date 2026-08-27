import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminAssistantSettings,
  AssistantSettingSource,
  AssistantSettingsField,
  AssistantSettingsValues,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Typy formularza
// ---------------------------------------------------------------------------

/** Pola liczbowe — w szkicu mogą być tymczasowo puste (`null`), dopóki użytkownik nie wpisze wartości. */
export type NumField = {
  [K in AssistantSettingsField]: AssistantSettingsValues[K] extends number ? K : never;
}[AssistantSettingsField];

export type DraftValue<K extends AssistantSettingsField> = K extends NumField ? number | null : AssistantSettingsValues[K];

/** Niezapisane zmiany: tylko pola różniące się od wartości z backendu. */
export type Draft = { [K in AssistantSettingsField]?: DraftValue<K> };

export type FieldErrors = Partial<Record<AssistantSettingsField, string>>;

/** Uchwyt do stanu formularza przekazywany sekcjom — zamiast dziesiątek propsów. */
export interface FormApi {
  settings: AdminAssistantSettings;
  values: AssistantSettingsValues;
  defaults: AssistantSettingsValues;
  sources: AdminAssistantSettings["sources"];
  errors: FieldErrors;
  saving: boolean;
  val: <K extends AssistantSettingsField>(k: K) => DraftValue<K>;
  setField: <K extends AssistantSettingsField>(k: K, v: DraftValue<K>) => void;
  isDirty: (k: AssistantSettingsField) => boolean;
  /** Wartość pola liczbowego jako tekst do `<input type="number">` ("" gdy puste). */
  numVal: (k: NumField) => string;
  setNum: (k: NumField, raw: string) => void;
}

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

export const SECTIONS: { id: string; label: string }[] = [
  { id: "stan", label: "Stan" },
  { id: "dostawca", label: "Dostawca i model" },
  { id: "generowanie", label: "Generowanie" },
  { id: "prompt", label: "Prompt i osobowość" },
  { id: "reguly", label: "Reguły kalendarza" },
  { id: "narzedzia", label: "Narzędzia" },
  { id: "dostep", label: "Dostęp i limity" },
  { id: "zuzycie", label: "Zużycie" },
];

export const SECTION_FIELDS: Record<string, AssistantSettingsField[]> = {
  dostawca: ["enabled", "baseUrl", "providerLabel", "model", "providerSort"],
  generowanie: ["temperature", "maxOutputTokens", "maxSteps", "historyTokenBudget", "reasoningEffort"],
  prompt: ["customInstructions", "personaName", "greeting", "suggestions"],
  reguly: ["workStart", "workEnd", "defaultDurationHours", "allDayTypes", "defaultStatus", "allowRecurrence", "maxHorizonDays"],
  narzedzia: ["disabledTools", "allowModifications", "daySummaryDefaultStatus"],
  dostep: ["access", "retentionDays", "dailyTurnLimit"],
};

export const SOURCE_LABEL: Record<AssistantSettingSource, string> = {
  db: "z bazy",
  env: "z env",
  default: "domyślne",
};

export const keySourceLabel = (source: AdminAssistantSettings["apiKey"]["source"]) =>
  source === "db" ? "z bazy" : source === "env" ? "z env" : source === "file" ? "z pliku" : "brak";

export const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const ADVANCED_STORAGE_KEY = "alfa.adminAssistant.advanced";

// ---------------------------------------------------------------------------
// Formatowanie
// ---------------------------------------------------------------------------

export const fmtInt = (n: number) => new Intl.NumberFormat("pl-PL").format(Math.round(n));
export const fmtUsd = (n: number | null | undefined, digits = 4) =>
  n == null ? "—" : `$${n.toFixed(n >= 1 ? 2 : digits)}`;
export const fmtContext = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const fmtPrice = (m: { promptPer1M: number | null; completionPer1M: number | null }) =>
  m.promptPer1M == null && m.completionPer1M == null
    ? "cena nieznana"
    : `$${(m.promptPer1M ?? 0).toFixed(2)} / $${(m.completionPer1M ?? 0).toFixed(2)} za 1M`;
export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
};
export const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
export const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Polecane modele — gwiazdka w wyborze modelu, tylko gdy ID jest na liście z backendu
// ---------------------------------------------------------------------------

export const RECOMMENDED_MODELS = ["deepseek/deepseek-v4-flash", "openai/gpt-5-mini", "google/gemini-3-flash"] as const;
const RECOMMENDED_SET = new Set<string>(RECOMMENDED_MODELS);
export const isRecommendedModel = (id: string) => RECOMMENDED_SET.has(id);

// ---------------------------------------------------------------------------
// Hooki
// ---------------------------------------------------------------------------

/** Tryb „Zaawansowane” — jeden stan dla całej strony, zapamiętany w localStorage. */
export function useAdvancedMode(): [boolean, (v: boolean) => void] {
  const [advanced, setAdvancedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ADVANCED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setAdvanced = useCallback((v: boolean) => {
    setAdvancedState(v);
    try {
      localStorage.setItem(ADVANCED_STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* brak localStorage (tryb prywatny) — stan tylko w pamięci */
    }
  }, []);
  return [advanced, setAdvanced];
}

/** Liczy zmienione i błędne pola z podanej listy (do nagłówka zwiniętego bloku). */
export function countFieldState(form: FormApi, fields: AssistantSettingsField[]) {
  return {
    dirtyCount: fields.filter((f) => form.isDirty(f)).length,
    errorCount: fields.filter((f) => !!form.errors[f]).length,
  };
}

/** Tymczasowy komunikat (znika po `ms`); timer sprzątany przy unmount. */
export function useFlash(ms = 5000): [string | null, (msg: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );
  const flash = useCallback(
    (msg: string | null) => {
      setNotice(msg);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = msg == null ? null : window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), ms);
    },
    [ms]
  );
  return [notice, flash];
}
