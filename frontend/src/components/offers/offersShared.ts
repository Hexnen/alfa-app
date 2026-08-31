/**
 * Etykiety, tony i formatery modułu Ofert — w konwencji `warehouseShared.ts`.
 */
import type { PillTone } from "@/lib/calendar-labels";
import type {
  OfferItemBilling,
  OfferItemKind,
  OfferKind,
  OfferSectionCategory,
  OfferStatus,
} from "@/lib/api";

export const OFFER_STATUS_META: Record<OfferStatus, { label: string; tone: PillTone }> = {
  draft: { label: "Szkic", tone: "muted" },
  sent: { label: "Wysłana", tone: "sky" },
  accepted: { label: "Zaakceptowana", tone: "emerald" },
  rejected: { label: "Odrzucona", tone: "rose" },
  expired: { label: "Wygasła", tone: "amber" },
};

export const OFFER_KIND_LABEL: Record<OfferKind, string> = {
  rozbudowa: "Rozbudowa",
  montaz: "Montaż i uruchomienie",
  serwis: "Serwis",
};

export const OFFER_CATEGORY_META: Record<
  OfferSectionCategory,
  { label: string; tone: PillTone }
> = {
  cctv: { label: "CCTV", tone: "sky" },
  sswin: { label: "SSWiN", tone: "violet" },
  kd: { label: "Kontrola dostępu", tone: "indigo" },
  wideoweryfikacja: { label: "Wideoweryfikacja", tone: "teal" },
  abonament: { label: "Abonament", tone: "emerald" },
  inne: { label: "Inne", tone: "muted" },
};

export const OFFER_ITEM_KIND_LABEL: Record<OfferItemKind, string> = {
  material: "Sprzęt",
  labour: "Robocizna",
  subscription: "Abonament",
  other: "Inne",
};

export const OFFER_BILLING_LABEL: Record<OfferItemBilling, string> = {
  one_time: "jednorazowo",
  monthly: "miesięcznie",
};

/**
 * Etykiety znaczników zakresu na liście ofert — krótkie, bo to druga linia
 * w wąskiej kolumnie. „Kontrola dostępu" skraca się do „KD", żeby wiersz nie
 * puchł, gdy oferta obejmuje cztery systemy naraz.
 */
export const OFFER_SCOPE_LABEL: Record<string, string> = {
  cctv: "CCTV",
  sswin: "SSWiN",
  kd: "KD",
  wideoweryfikacja: "wideoweryfikacja",
  abonament: "abonament",
  inne: "inne",
  dzierzawa: "dzierżawa",
};

/** Nazwa znacznika zakresu; nieznany klucz pokazujemy dosłownie, nie gubimy go. */
export const scopeLabel = (tag: string): string => OFFER_SCOPE_LABEL[tag] ?? tag;

/**
 * Kategorie pokazywane jako przyciski „+ …" nad edytorem. `abonament` i `inne`
 * są wśród nich celowo: pierwsza to osobny strumień pieniędzy, druga to furtka
 * na pozycje spoza katalogu.
 */
export const OFFER_QUICK_CATEGORIES: OfferSectionCategory[] = [
  "cctv",
  "sswin",
  "kd",
  "wideoweryfikacja",
  "abonament",
];

const plnFormat = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });

export const fmtPln = (v: number | null | undefined): string =>
  plnFormat.format(Number(v || 0));

/** Kwota, której może nie być — kreska zamiast udawanego zera. */
export const fmtPlnOrDash = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : plnFormat.format(v);

export const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? "—"
    : `${v.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`;

const qtyFormat = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 3 });
export const fmtQty = (v: number | null | undefined): string =>
  qtyFormat.format(Number(v || 0));
