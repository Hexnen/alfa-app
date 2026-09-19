/**
 * Okres obowiązywania umowy kadrowej (`hr_contracts.valid_from` / `valid_to`,
 * migracja 0112) — JEDNO miejsce z regułami dat dla backendu.
 *
 * Dlaczego osobny plik, a nie reguła wpisana w router: te same pytania zadają
 * trzy różne miejsca — kalkulacja miesiąca (`computeMonth` w src/routes/hr.ts),
 * koszt osobowy obiektu (`src/lib/object-personnel-cost.ts`, który liczy CAŁE
 * okno miesięcy wstecz) i przypomnienia o umowach do przedłużenia. Gdyby każde
 * z nich liczyło „czy umowa obowiązuje w tym miesiącu” po swojemu, wynagrodzenia
 * i koszt obiektu rozjechałyby się przy pierwszej umowie zaczynającej się
 * w połowie miesiąca.
 *
 * Daty są TEKSTEM „YYYY-MM-DD” (jak `hr_holidays.date`), więc porównania są
 * zwykłymi porównaniami napisów — bez `Date`, bez stref czasowych, bez
 * przesunięcia o dzień na serwerze w UTC.
 *
 * NULL z którejkolwiek strony = bezterminowo: pusty `valid_from` to „od zawsze”,
 * pusty `valid_to` to „do odwołania”.
 */

/** Data w formacie „YYYY-MM-DD” — jedyny akceptowany zapis. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Czy napis jest poprawną datą kalendarzową „YYYY-MM-DD”.
 * Sam wzorzec nie wystarcza: „2026-02-31” pasuje do niego, a nie istnieje.
 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** Liczba dni miesiąca (rok przestępny liczony wprost, bez `Date`). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Granice miesiąca rozliczeniowego jako daty tekstowe. */
export function monthBounds(
  year: number,
  month: number,
): { start: string; end: string } {
  const mm = String(month).padStart(2, "0");
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`,
  };
}

/** Dzisiejsza data w czasie LOKALNYM serwera (nie UTC — inaczej wieczorem gubi dzień). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Data przesunięta o `days` dni (ujemne = wstecz). Wejście i wyjście „YYYY-MM-DD”. */
export function shiftIsoDate(date: string, days: number): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) return date;
  // UTC, żeby arytmetyka nie wpadła w zmianę czasu (doba 23-godzinna w marcu).
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  );
  return d.toISOString().slice(0, 10);
}

/** Dzień poprzedzający — `valid_to` umowy zastępowanej przy zmianie warunków. */
export const dayBefore = (date: string): string => shiftIsoDate(date, -1);

/** Ile dni dzieli `from` od `to` (dodatnie = `to` w przyszłości). */
export function daysBetween(from: string, to: string): number {
  const a = ISO_DATE_RE.exec(from);
  const b = ISO_DATE_RE.exec(to);
  if (!a || !b) return 0;
  const ms =
    Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) -
    Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / 86_400_000);
}

/** Data po polsku: „31.12.2026”. Przepisanie tekstu, bez `Date`. */
export function formatDatePl(v: string | null | undefined): string {
  if (!v) return "";
  const m = ISO_DATE_RE.exec(v);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
}

/** Minimalny kształt umowy, jakiego potrzebują reguły okresu. */
export interface ContractPeriod {
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Czy okres obowiązywania PRZECINA miesiąc rozliczeniowy.
 *
 * Umowa od 15.09 liczy się we wrześniu w całości — miesiąc jest najmniejszą
 * jednostką rozliczenia w Kadrach (godziny i kwoty wpisuje się miesięcznie),
 * więc częściowy miesiąc jest miesiącem, a nie ułamkiem.
 */
export function contractCoversMonth(
  c: ContractPeriod,
  year: number,
  month: number,
): boolean {
  const { start, end } = monthBounds(year, month);
  if (c.validFrom && c.validFrom > end) return false;
  if (c.validTo && c.validTo < start) return false;
  return true;
}

/** Status umowy względem dnia `today` — jedna z czterech wartości pokazywanych w kartotece. */
export type HrContractStatus =
  | "przyszła"
  | "aktywna"
  | "zakończona"
  | "nieaktywna";

/**
 * Status widoczny w kartotece. Ręczny wyłącznik `active` ma pierwszeństwo:
 * umowa wyłączona nie jest ani przyszła, ani zakończona — jest nieaktywna.
 */
export function contractStatus(
  c: ContractPeriod & { active: boolean },
  today: string = todayIso(),
): HrContractStatus {
  if (!c.active) return "nieaktywna";
  if (c.validFrom && c.validFrom > today) return "przyszła";
  if (c.validTo && c.validTo < today) return "zakończona";
  return "aktywna";
}

/** Okres słownie: „od 15.09.2026 do 31.12.2026”, „do 31.08.2026”, „bezterminowo”. */
export function periodLabelPl(c: ContractPeriod): string {
  const from = formatDatePl(c.validFrom);
  const to = formatDatePl(c.validTo);
  if (from && to) return `od ${from} do ${to}`;
  if (from) return `od ${from}`;
  if (to) return `do ${to}`;
  return "bezterminowo";
}
