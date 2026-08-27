import type { AssistantSettingsField, AssistantSettingsValues } from "@/lib/api";
import type { Draft, DraftValue, FieldErrors } from "./helpers";

/** Czysta walidacja szkicu — bez zależności od komponentu, więc useMemo ma pełną listę zależności. */
export function validateDraft(draft: Draft, values: AssistantSettingsValues, isOpenRouter: boolean): FieldErrors {
  const e: FieldErrors = {};
  const val = <K extends AssistantSettingsField>(k: K): DraftValue<K> =>
    (k in draft ? draft[k] : values[k]) as DraftValue<K>;
  const num = (k: AssistantSettingsField, min: number, max: number, label: string) => {
    const v = val(k) as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) e[k] = `${label}: zakres ${min}–${max}`;
  };
  const model = (val("model") || "").trim();
  if (!model) e.model = "Podaj identyfikator modelu";
  else if (isOpenRouter && !model.includes("/")) e.model = "ID modelu OpenRouter ma postać „dostawca/model”";
  const baseUrl = (val("baseUrl") || "").trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) e.baseUrl = "Adres musi zaczynać się od http:// lub https://";
  if ((val("providerLabel") || "").length > 40) e.providerLabel = "Maksymalnie 40 znaków";
  num("temperature", 0, 1, "Temperatura");
  num("maxOutputTokens", 100, 32000, "Maks. tokenów");
  num("maxSteps", 1, 20, "Maks. kroków");
  num("historyTokenBudget", 2000, 200000, "Budżet historii");
  if ((val("customInstructions") || "").length > 8000) e.customInstructions = "Maksymalnie 8000 znaków";
  const pn = (val("personaName") || "").trim();
  if (!pn) e.personaName = "Podaj nazwę asystenta";
  else if (pn.length > 40) e.personaName = "Maksymalnie 40 znaków";
  if ((val("greeting") || "").length > 500) e.greeting = "Maksymalnie 500 znaków";
  const sg = val("suggestions") || [];
  if (sg.length < 3 || sg.length > 5) e.suggestions = "Podaj od 3 do 5 sugestii";
  else if (sg.some((s) => !s.trim())) e.suggestions = "Sugestie nie mogą być puste";
  else if (sg.some((s) => s.length > 120)) e.suggestions = "Każda sugestia maks. 120 znaków";
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const ws = val("workStart") || "";
  const we = val("workEnd") || "";
  if (!hhmm.test(ws)) e.workStart = "Format GG:MM";
  if (!hhmm.test(we)) e.workEnd = "Format GG:MM";
  else if (hhmm.test(ws) && we <= ws) e.workEnd = "Koniec musi być po początku";
  num("defaultDurationHours", 0.5, 12, "Domyślny czas trwania");
  num("maxHorizonDays", 7, 730, "Horyzont");
  num("retentionDays", 0, 3650, "Retencja");
  num("dailyTurnLimit", 0, 10000, "Dzienny limit");
  return e;
}
