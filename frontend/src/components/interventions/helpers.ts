/**
 * Czyste drobiazgi modułu „Grupy interwencyjne”: komunikaty błędów, kwoty z
 * przecinkiem, formaty dat i podpis obiektu. Bez Reacta — wyszukiwarka obiektów
 * siedzi obok, w `ObjectPicker.tsx` (osobny plik, bo fast refresh nie lubi
 * modułów mieszających komponenty z funkcjami).
 */

/** Brak danych w tabeli — ta sama kreska, co w kartotece obiektu. */
export const DASH = "—";

export const errMsg = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

/** Kwota z pola tekstowego: pusto = null („nieuzupełnione”), przecinek jak kropka. */
export function parseAmountField(raw: string): number | null | "INVALID" {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return "INVALID";
  return n;
}

/** Liczba całkowita ≥ 0 z pola tekstowego (darmowe podjazdy). */
export function parseIntField(raw: string): number | null | "INVALID" {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return "INVALID";
  return n;
}

/** Wartość liczbowa do pola formularza — null zostaje pustym polem, nie zerem. */
export const numField = (v: number | null | undefined): string => (v == null ? "" : String(v));

/** `2026-09-09T18:30` → „09.09.2026, 18:30”. Bez sekund, bo backend ich nie trzyma. */
export function fmtHappenedAt(iso: string): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
}

/** Bieżący miesiąc jako `YYYY-MM` w strefie przeglądarki (domyślny filtr). */
export function currentMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** „teraz” w formacie `<input type="datetime-local">` (bez sekund, czas lokalny). */
export function nowLocalDateTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Dzisiejsza data jako `YYYY-MM-DD` w strefie przeglądarki. */
export function todayIso(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Podpis obiektu w podpowiedziach: adres, miasto i kontrahent jedną linią. */
export const objectMeta = (o: { address?: string | null; city?: string | null; contractorName?: string | null }) =>
  [o.address, o.city, o.contractorName].filter(Boolean).join(" · ") || null;

/** Godziny postoju po polsku: `1.5` → „1,5”. Reszta modułu też liczy z przecinkiem. */
export const fmtHours = (h: number | null | undefined): string =>
  h == null ? DASH : h.toLocaleString("pl-PL", { maximumFractionDigits: 2 });

/** Odmiana rzeczownika „podjazd” — 1 podjazd, 3 podjazdy, 5 podjazdów. */
export function pluralCallouts(n: number): string {
  const abs = Math.abs(n) % 100;
  if (abs === 1) return "podjazd";
  const last = abs % 10;
  if (last >= 2 && last <= 4 && !(abs >= 12 && abs <= 14)) return "podjazdy";
  return "podjazdów";
}
