/**
 * Polskie nazwy miesięcy i drobne formatowanie dat — wspólne dla ekranów i wydruków.
 *
 * Dotąd ta sama tablica żyła w trzech miejscach (`components/kadry/shared.ts`,
 * `pages/Technical.tsx`, `lib/hrPrint.ts`). Wydruki Kadr są poza drzewem
 * komponentów, więc import z `components/kadry/shared.ts` wciągałby do modułu
 * wydruku pół zakładki; stąd osobny plik w `lib/`.
 */

/** Mianownik, wielką literą — nagłówki i przełącznik miesiąca. */
export const MONTH_NAMES = [
  "Styczeń",
  "Luty",
  "Marzec",
  "Kwiecień",
  "Maj",
  "Czerwiec",
  "Lipiec",
  "Sierpień",
  "Wrzesień",
  "Październik",
  "Listopad",
  "Grudzień",
];

/** „Wrzesień 2026” — samodzielny nagłówek. */
export const monthYearTitle = (year: number, month: number) =>
  `${MONTH_NAMES[month - 1] ?? ""} ${year}`.trim();

/** „wrzesień 2026” — w środku zdania („Lista wypłat gotówkowych — wrzesień 2026”). */
export const monthYearLabel = (year: number, month: number) =>
  `${(MONTH_NAMES[month - 1] ?? "").toLowerCase()} ${year}`.trim();

/** „15.09.2026, 21:44” — data wygenerowania dokumentu. */
export const nowStamp = (d: Date = new Date()) =>
  d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });

/** „15.09.2026” — do nazw plików nie używać (tam `ymSlug`). */
export const dayStamp = (d: Date = new Date()) => d.toLocaleDateString("pl-PL");

/** „2026-09” — bezpieczny fragment nazwy pliku. */
export const ymSlug = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;
