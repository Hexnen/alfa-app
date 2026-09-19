/**
 * Etykiety i formatowanie dziennika zmian Kadr (zakładka „Historia”).
 *
 * Lustro `src/lib/hr-activity.ts` po stronie frontu: te same nazwy pól, te same
 * etykiety PL. Backend składa gotowe `summary` (z nazwiskiem, nazwami obiektów
 * i miesiącem), więc front NIE odtwarza zdania od zera — używa summary i tylko
 * przycina je do kontekstu, w którym wyświetla.
 */
import type { HrActivityEntry, HrActivityEntityType } from "@/lib/api";

/** Etykiety typów encji — filtr „typ wpisu” i podpis przy wpisie. */
export const HR_ENTITY_LABELS: Record<HrActivityEntityType, string> = {
  hr_employee: "Pracownicy",
  hr_contract: "Umowy",
  hr_hours: "Godziny",
  hr_payroll: "Wypłaty",
  hr_office: "Biuro",
  hr_object: "Obiekty",
  hr_department: "Działy",
  hr_norm: "Normy",
  hr_month: "Miesiąc",
  hr_holiday: "Święta",
};

/** Kolejność opcji w selekcie typu — jak kolejność zakładek Kadr. */
export const HR_ENTITY_OPTIONS: { value: HrActivityEntityType; label: string }[] = [
  { value: "hr_norm", label: HR_ENTITY_LABELS.hr_norm },
  { value: "hr_department", label: HR_ENTITY_LABELS.hr_department },
  { value: "hr_object", label: HR_ENTITY_LABELS.hr_object },
  { value: "hr_employee", label: HR_ENTITY_LABELS.hr_employee },
  { value: "hr_contract", label: HR_ENTITY_LABELS.hr_contract },
  { value: "hr_hours", label: HR_ENTITY_LABELS.hr_hours },
  { value: "hr_payroll", label: HR_ENTITY_LABELS.hr_payroll },
  { value: "hr_office", label: HR_ENTITY_LABELS.hr_office },
  // Zamknięcie i otwarcie okresu — na końcu, bo dotyczy całego miesiąca,
  // a nie pojedynczych danych w nim.
  { value: "hr_month", label: HR_ENTITY_LABELS.hr_month },
  // Dni ustawowo wolne — słownik, z którego liczą się normy (zakładka Normy).
  { value: "hr_holiday", label: HR_ENTITY_LABELS.hr_holiday },
];

/** Etykiety pól (kolumna `field` w activity_log) — patrz HR_FIELDS na backendzie. */
export const HR_FIELD_LABELS: Record<string, string> = {
  // Pracownik
  full_name: "nazwisko i imię",
  code: "kod",
  kind: "rodzaj rozliczenia",
  department_id: "dział",
  active: "aktywny",
  notes: "uwagi",
  // Umowa
  company: "spółka",
  contract_type: "rodzaj umowy",
  chor: "ubezpieczenie chorobowe",
  zua: "ZUA",
  zza: "ZZA",
  zwua: "ZWUA",
  object_name: "obiekt (opis)",
  main_channel: "kanał wypłaty głównej",
  bonus_type: "rodzaj dodatku",
  // Okres obowiązywania umowy — puste znaczy „bezterminowo”, nie „brak danych”.
  valid_from: "obowiązuje od",
  valid_to: "obowiązuje do",
  // Godziny
  object_id: "obiekt",
  night_hours: "godziny nocne",
  worked_hours: "godziny wypracowane",
  uw_hours: "urlop (godz.)",
  l4_hours: "L4 (godz.)",
  max_hours: "godziny maks.",
  // Kwoty Kadr są NETTO („na rękę”): księgowość podaje do kadr wyłącznie kwoty
  // do wypłaty, bazy brutto aplikacja nie zna. Etykiety w dzienniku mówią to
  // wprost, tak jak nagłówki kolumn — „kwota główna: 3200 → 3400” bez tego
  // słowa jest dwuznaczne.
  deductions: "potrącenia netto",
  bonuses: "dodatki netto",
  object_uncertain: "przypisanie do potwierdzenia",
  // Wypłaty
  main_amount: "kwota główna netto",
  bonus_rate: "stawka dodatku netto",
  bonus_rate_pending: "dodatek do przeliczenia",
  rate_adjustment: "korekta stawki netto",
  max_hours_override: "godziny maks. (nadpisanie)",
  actual_hours_override: "godziny faktyczne (nadpisanie)",
  bonus_amount_override: "kwota dodatku netto (nadpisanie)",
  // Biuro
  etat_hours: "godziny etatu",
  uw_l4: "UW/L4",
  hours_for_accounting: "godziny do księgowej",
  rate: "stawka netto",
  amount: "kwota netto",
  ror_base: "podstawa ROR netto",
  cash_override: "gotówka netto (nadpisanie)",
  // Słowniki
  name: "nazwa",
  is_cma_pool: "pula centrum monitorowania",
  has_objects: "dział obiektowy",
  color: "kolor",
  // Sekcja z własnymi „Godzinami działu” (CMA / OFI / Handlowy / Techniczny).
  portal: "portal (sekcja)",
  sort_order: "kolejność",
  work_norm: "norma pracy",
  contract_norm: "norma zlecenia",
  // Dni ustawowo wolne (zakładka Normy → „Wylicz z Kodeksu pracy”)
  date: "data",
  source: "pochodzenie",
};

export const hrFieldLabel = (field: string): string => HR_FIELD_LABELS[field] ?? field;

const MONEY_FIELDS = new Set([
  "deductions",
  "bonuses",
  "main_amount",
  "bonus_rate",
  "rate_adjustment",
  "bonus_amount_override",
  "rate",
  "amount",
  "ror_base",
  "cash_override",
]);

const HOUR_FIELDS = new Set([
  "night_hours",
  "worked_hours",
  "uw_hours",
  "l4_hours",
  "max_hours",
  "max_hours_override",
  "actual_hours_override",
  "etat_hours",
  "uw_l4",
  "hours_for_accounting",
  "work_norm",
  "contract_norm",
]);

const BOOL_FIELDS = new Set([
  "active",
  "chor",
  "object_uncertain",
  "bonus_rate_pending",
  "is_cma_pool",
]);

const ENUM_VALUES: Record<string, Record<string, string>> = {
  kind: { ochrona: "Ochrona", biuro: "Biuro" },
  contract_type: { praca: "Umowa o pracę", zlecenie: "Umowa zlecenie" },
  main_channel: { przelew: "Przelew", gotowka: "Gotówka" },
  bonus_type: {
    brak: "Brak",
    gotowka: "Gotówka",
    delegacja_przelew: "Delegacja — przelew",
    delegacja_gotowka: "Delegacja — gotówka",
  },
};

/** Formatowanie wartości pola z kolumn `old_value` / `new_value`. */
export function hrFieldValue(field: string | null, v: string | null): string {
  if (v == null || v === "") return "(puste)";
  if (!field) return v;
  if (BOOL_FIELDS.has(field)) return v === "1" || v === "true" ? "tak" : "nie";
  const enums = ENUM_VALUES[field];
  if (enums?.[v]) return enums[v];
  const n = Number(v);
  if (MONEY_FIELDS.has(field) && Number.isFinite(n)) {
    return `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
  }
  if (HOUR_FIELDS.has(field) && Number.isFinite(n)) {
    return `${n.toLocaleString("pl-PL", { maximumFractionDigits: 2 })} h`;
  }
  // `object_id` / `department_id` niosą samo id — nazwę ma summary, więc
  // pokazujemy id z kratką, a pełne zdanie i tak stoi w opisie operacji.
  if (field === "object_id" || field === "department_id") return `#${v}`;
  return v.length > 60 ? `${v.slice(0, 60)}…` : v;
}

/**
 * Summary bez nazwiska na początku i bez dopisku miesiąca na końcu — do listy
 * pól pod zbiorczą operacją, gdzie i jedno, i drugie już padło w nagłówku.
 */
export function hrEntryDetail(entry: HrActivityEntry): string {
  const raw = entry.summary ?? "";
  if (!raw) {
    return `${entry.field ? hrFieldLabel(entry.field) : "pole"}: ${hrFieldValue(entry.field, entry.oldValue)} → ${hrFieldValue(entry.field, entry.newValue)}`;
  }
  return raw
    .replace(/^.+?\s—\s/, "")
    .replace(/\s\(\p{L}+\s\d{4}\)\s*$/u, "")
    .trim();
}

/** „2026-09” → „wrzesień 2026”. */
const MONTHS = [
  "styczeń",
  "luty",
  "marzec",
  "kwiecień",
  "maj",
  "czerwiec",
  "lipiec",
  "sierpień",
  "wrzesień",
  "październik",
  "listopad",
  "grudzień",
];

export function hrPeriodLabel(period: string | null): string | null {
  if (!period) return null;
  const [y, m] = period.split("-");
  const idx = Number(m) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${y}` : period;
}

/** Zdanie wpisu w osi czasu: „Kto — co zrobił”. */
export function describeHrActivity(entry: HrActivityEntry): string {
  const who = entry.userLabel || "System";
  return entry.summary ? `${who} — ${entry.summary}` : `${who} — zmiana w Kadrach`;
}
