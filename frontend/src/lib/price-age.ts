/**
 * Wiek ceny w kartotekach — JEDNO źródło reguły „cena przeterminowana"
 * dla Magazynu, Usług i edytora Ofert.
 *
 * Trzy ekrany pokazują ten sam sygnał (kropka / dymek przy cenie), więc reguła
 * nie może być trzy razy przepisana: rozjazd progu między Magazynem a Ofertami
 * oznaczałby, że ta sama pozycja raz jest „stara", a raz nie, zależnie od tego,
 * skąd się na nią patrzy.
 *
 * Moduł jest świadomie bez zależności od Reacta — używa go też logika
 * sortowania i filtrów, nie tylko render.
 */

/**
 * Progi przeterminowania w miesiącach, osobne dla każdego katalogu.
 *
 * Różnica nie jest przypadkiem: ceny sprzętu ruszają się z kursem walut
 * i cennikami dostawców po kilka razy w roku, a stawki robocizny renegocjuje
 * się raz na rok. Wspólny próg dałby albo ciągły alarm na całym katalogu usług
 * (przy 6 miesiącach), albo ślepotę na sprzęt wyceniony rok temu (przy 12).
 */
export const PRICE_STALE_MONTHS = { warehouse: 6, service: 12 } as const;

export type PriceSourceKind = keyof typeof PRICE_STALE_MONTHS;

/** `now` minus `months` miesięcy kalendarzowych. */
function monthsAgo(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  // setMonth przenosi rok sam; dzień może się „przelać" przy krótszym miesiącu
  // (31.03 − 1 mies. → 03.03), ale przy progach 6/12 to i tak dzień różnicy.
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Parsuje stempel z API („2026-02-12" albo ISO z godziną). null = nie do odczytania. */
function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  // SQLite zapisuje „RRRR-MM-DD HH:MM:SS" (spacja zamiast T) — Safari takiego
  // formatu nie parsuje, więc normalizujemy przed oddaniem do Date.
  const d = new Date(value.includes(" ") ? value.replace(" ", "T") : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Czy cena jest przeterminowana dla danego katalogu.
 *
 * BRAK DATY = PRZETERMINOWANA. Pusty stempel nie znaczy „świeża", tylko „nikt
 * nie wie, kiedy tę cenę ostatnio potwierdzono" — a to gorszy przypadek niż
 * znana stara data, bo przy starej dacie widać przynajmniej skalę problemu.
 * Wyjątek (pozycja, która w ogóle nie ma ceny, więc nie ma czego
 * przeterminować) rozstrzyga UI, zanim tu zajrzy — ta funkcja nie widzi kwot.
 */
export function isPriceStale(
  priceUpdatedAt: string | null | undefined,
  kind: PriceSourceKind,
  now: Date = new Date()
): boolean {
  const stamp = parseStamp(priceUpdatedAt);
  if (!stamp) return true;
  return stamp.getTime() < monthsAgo(now, PRICE_STALE_MONTHS[kind]).getTime();
}

/** Pełne miesiące kalendarzowe między dwiema datami (nieujemne). */
function fullMonthsBetween(from: Date, to: Date): number {
  let months =
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function formatPL(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Krótki tekst do dymka przy cenie, np. „cena z 12.02.2026 (7 mies. temu)".
 * Bez daty mówi wprost, że stempla nie ma — inaczej pusty dymek wyglądałby
 * jak potwierdzenie, że wszystko w porządku.
 */
export function priceAgeLabel(
  priceUpdatedAt: string | null | undefined,
  kind: PriceSourceKind,
  now: Date = new Date()
): string {
  const stamp = parseStamp(priceUpdatedAt);
  if (!stamp) {
    return `brak daty aktualizacji ceny (próg: ${PRICE_STALE_MONTHS[kind]} mies.)`;
  }
  const months = fullMonthsBetween(stamp, now);
  const age =
    months === 0 ? "w tym miesiącu" : months === 1 ? "miesiąc temu" : `${months} mies. temu`;
  return `cena z ${formatPL(stamp)} (${age})`;
}
