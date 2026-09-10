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

/**
 * Drugi, ostrzejszy próg: cena, której nikt nie potwierdził od tak dawna, że
 * nie jest już „do odświeżenia”, a po prostu niewiarygodna.
 *
 * Podwójny próg zamiast jednego, bo w kartotece z tysiącem pozycji zawsze coś
 * będzie przekroczone o miesiąc — gdyby wszystko świeciło tym samym kolorem,
 * lista wyglądałaby jak jeden wielki alarm i przestano by na nią patrzeć.
 * Żółty mówi „zajrzyj przy okazji”, czerwony „tej kwoty nie wstawiaj do oferty”.
 * Proporcja 2× względem `PRICE_STALE_MONTHS` trzyma tę samą logikę w obu
 * katalogach (magazyn 6/12 mies., usługi 12/24).
 */
export const PRICE_OLD_MONTHS = { warehouse: 12, service: 24 } as const;

/**
 * Trzy stopnie wieku ceny: świeża / do odświeżenia / niewiarygodna.
 *
 * Rozdzielone od boolowskiego `isPriceStale`, bo poziom jest potrzebny tylko
 * tam, gdzie UI ma trzy kolory; reszta aplikacji (filtry, kropki, dymki
 * w Ofertach) pyta dalej o jedno bit-owe „stara czy nie”.
 */
export type PriceAgeLevel = "fresh" | "stale" | "old";

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

/**
 * Stopień przeterminowania ceny.
 *
 * Zgodność z `isPriceStale` jest tu warunkiem, nie zbiegiem okoliczności:
 * `priceAgeLevel(...) !== "fresh"` daje dokładnie to samo co
 * `isPriceStale(...)`, bo oba mierzą ten sam próg `PRICE_STALE_MONTHS` na tym
 * samym stemplu (brak daty → przeterminowana, tutaj od razu „old”, bo nieznany
 * wiek to najgorszy przypadek, nie średni). Gdyby kiedyś progi się rozjechały,
 * ten sam towar byłby żółty w tabeli i zielony w filtrze.
 *
 * `isPriceStale` i `priceAgeLabel` zostają bez zmian — etykietę parsuje
 * regexem `components/offers/OfferSectionCard.tsx`, więc jej format jest
 * kontraktem, a nie tylko tekstem dla człowieka.
 */
export function priceAgeLevel(
  priceUpdatedAt: string | null | undefined,
  kind: PriceSourceKind,
  now: Date = new Date()
): PriceAgeLevel {
  const stamp = parseStamp(priceUpdatedAt);
  if (!stamp) return "old";
  const t = stamp.getTime();
  if (t < monthsAgo(now, PRICE_OLD_MONTHS[kind]).getTime()) return "old";
  if (t < monthsAgo(now, PRICE_STALE_MONTHS[kind]).getTime()) return "stale";
  return "fresh";
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
