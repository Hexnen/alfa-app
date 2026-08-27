/**
 * Formatowanie wartości i źródeł automatu (wspólne dla dialogu, adnotacji
 * w formularzu i podglądu masowego).
 */
import { AUTOFILL_FIELD_LABEL, AUTOFILL_MONEY_FIELDS, type AutofillSuggestion } from "@/lib/api";

const pln = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const dec = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });

export const autofillFieldLabel = (field: string) => AUTOFILL_FIELD_LABEL[field] ?? field;

/** Etykieta sugestii: backend zna własne nazwy pól, słownik UI jest zapasowy. */
export const suggestionLabel = (s: Pick<AutofillSuggestion, "field" | "label">) =>
  s.label?.trim() || autofillFieldLabel(s.field);

/** Wartość pola w postaci czytelnej dla człowieka („—" dla pustej/zerowej). */
export function fmtAutofillValue(field: string, value: number | string | null | undefined): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" && !/^-?\d+([.,]\d+)?$/.test(value.trim())) return value;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return "—";
  if (AUTOFILL_MONEY_FIELDS.has(field)) return pln.format(n);
  if (field === "actualHours") return `${dec.format(n)} godz.`;
  if (field === "actualKm") return `${dec.format(n)} km`;
  return dec.format(n);
}

/** Kolor pigułki źródła — każdemu źródłu inny odcień, żeby czytać je wzrokiem. */
export const AUTOFILL_SOURCE_TONE: Record<string, string> = {
  kalendarz: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  protokół: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  protokol: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  kalkulacja: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  cennik: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  ustawienia: "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
};

/** Dopełniacz źródła — adnotacja czyta się jako „z kalendarza", nie „z kalendarz". */
const AUTOFILL_SOURCE_GENITIVE: Record<string, string> = {
  kalendarz: "kalendarza",
  protokół: "protokołu",
  protokol: "protokołu",
  kalkulacja: "kalkulacji",
  cennik: "cennika",
  ustawienia: "ustawień",
};

export const autofillSourceGenitive = (source: string) =>
  AUTOFILL_SOURCE_GENITIVE[source?.toLowerCase?.() ?? ""] ?? source;

export const autofillSourceTone = (source: string) =>
  AUTOFILL_SOURCE_TONE[source?.toLowerCase?.() ?? ""] ??
  "bg-muted text-muted-foreground";
