/**
 * Okres obowiązywania umowy kadrowej po stronie frontu (migracja 0112).
 *
 * Lustro `src/lib/hr-contract-period.ts`: te same reguły nazewnicze, ale bez
 * liczenia STATUSU — status przychodzi z serwera (`HrContract.status`), bo
 * „dziś” w Kadrach to dzień firmy, a nie zegar laptopa. Tutaj zostaje wyłącznie
 * formatowanie i dobór tonu pigułki.
 */
import type { HrContractStatus } from "@/lib/api";
import type { BadgeTone } from "./ui";

/** „2026-12-31” → „31.12.2026”. Przepisanie tekstu, bez `Date` (i bez stref). */
export function datePl(v: string | null | undefined): string {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
}

/** Data przesunięta o `days` dni — podgląd „poprzednia umowa do …”. */
export function shiftIsoDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return "";
  // UTC, żeby arytmetyka nie wpadła w zmianę czasu (doba 23-godzinna w marcu).
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * Kolumna „Obowiązuje”: „od 15.09.2026 do 31.12.2026”, „od 15.09.2026”,
 * „do 31.12.2026” albo „bezterminowo”. Pusta data to informacja
 * („bez terminu”), nie brak danych — dlatego nigdy nie wypada myślnik.
 */
export function contractPeriodLabel(c: {
  validFrom: string | null;
  validTo: string | null;
}): string {
  const from = datePl(c.validFrom);
  const to = datePl(c.validTo);
  if (from && to) return `od ${from} do ${to}`;
  if (from) return `od ${from}`;
  if (to) return `do ${to}`;
  return "bezterminowo";
}

/**
 * Ton pigułki statusu. „Zakończona” jest neutralna, nie ostrzegawcza — umowa
 * sprzed dwóch lat nie jest problemem; o tych, które problemem SĄ (koniec bez
 * następczyni), mówi kafel „Umowy do przedłużenia”.
 */
export const CONTRACT_STATUS_TONE: Record<HrContractStatus, BadgeTone> = {
  przyszła: "info",
  aktywna: "aktywny",
  zakończona: "neutral",
  nieaktywna: "nieaktywny",
};

/**
 * Statusy, dla których „Nowa umowa od…” (zmiana warunków) ma sens: umowa
 * obowiązuje albo dopiero zacznie, więc jest co zamknąć dzień przed nowymi
 * stawkami. Bezterminowa jest zwyczajnie „aktywna” — brak daty końca niczego
 * tu nie zmienia. Zakończona i wyłączona przycisku NIE dostają (nie są
 * wyszarzone — po prostu ich nie ma): nowa umowa po nich to nowa umowa, a nie
 * zmiana warunków tamtej.
 */
export const CONTRACT_SUPERSEDABLE: ReadonlySet<HrContractStatus> = new Set<HrContractStatus>([
  "aktywna",
  "przyszła",
]);

/** Dymek przy pigułce statusu — jedno zdanie, co ten status znaczy. */
export const CONTRACT_STATUS_HINT: Record<HrContractStatus, string> = {
  przyszła:
    "Umowa zacznie obowiązywać dopiero w przyszłości — w bieżącym miesiącu nie wchodzi do wynagrodzeń.",
  aktywna: "Umowa obowiązuje dziś i liczy się w bieżącym miesiącu.",
  zakończona:
    "Okres obowiązywania minął — umowa nie wchodzi do kolejnych miesięcy (miesiące z zapisanymi kwotami zostają nietknięte).",
  nieaktywna:
    "Ręcznie wyłączona — niezależnie od dat nie liczy się w żadnym miesiącu poza tymi, które mają zapisane dane płacowe.",
};
