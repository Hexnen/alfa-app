/**
 * Formatery liczb dla modułu analityki.
 *
 * Celowo NIE poszerzamy `@/lib/utils` — importuje je prawie każda strona,
 * a te funkcje są potrzebne wyłącznie na wykresach. `formatCurrency` z utils
 * jest poza tym za długie na etykietę osi („12 400,00 zł" vs „12,4 tys. zł").
 */

/** Półpauza — jedno miejsce na „nie wiemy" w całym module. */
export const DASH = "—";

// `useGrouping: "always"` — domyślne „auto" w pl-PL NIE grupuje liczb
// czterocyfrowych, więc „9000 zł" stałoby obok „42 000 zł" w tej samej kolumnie.
// Rzutowanie, bo `lib` tego projektu nie zna jeszcze NumberFormat v3;
// w przeglądarce opcja działa, a starsze silniki po prostu ją zignorują.
const ALWAYS_GROUP = { useGrouping: "always" } as unknown as Intl.NumberFormatOptions;

const PLN_FULL = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
  maximumFractionDigits: 0,
  ...ALWAYS_GROUP,
});

const NUM = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 0,
  ...ALWAYS_GROUP,
});

/** Pełna kwota: „12 400 zł". `null` → DASH (koszt nieuzupełniony ≠ 0 zł). */
export function plnFull(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return PLN_FULL.format(n);
}

function decimalsFor(v: number): number {
  // Jedna cyfra po przecinku ma sens tylko przy małych mantysach — „124,3 tys."
  // na osi to szum, „12,4 tys." to informacja. Minimum zostaje na zerze, więc
  // okrągłe działki osi to „20 tys.", a nie „20,0 tys.".
  return Math.abs(v) < 100 ? 1 : 0;
}

/** Skrócona kwota na oś: „12,4 tys. zł", „1,2 mln zł". */
export function plnCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  let value = n;
  let unit = "";
  if (abs >= 1e9) {
    value = n / 1e9;
    unit = " mld";
  } else if (abs >= 1e6) {
    value = n / 1e6;
    unit = " mln";
  } else if (abs >= 1e3) {
    value = n / 1e3;
    unit = " tys.";
  }
  const d = unit ? decimalsFor(value) : 0;
  const text = value.toLocaleString("pl-PL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
    ...ALWAYS_GROUP,
  });
  return `${text.replace("-", "−")}${unit} zł`;
}

/**
 * Procent w punktach procentowych: `pct(62)` → „62%", `pct(62.5, 1)` → „62,5%".
 * Minus jest prawdziwy (U+2212) — tak samo jak w `signedPln`, żeby ujemna
 * marża na osi i ujemny zysk w tabeli wyglądały identycznie.
 */
export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const text = Math.abs(v).toLocaleString("pl-PL", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${v < 0 ? "−" : ""}${text}%`;
}

/**
 * Kwota ze znakiem: „+1 240 zł" / „−820 zł".
 * Minus to prawdziwy U+2212, nie dywiz — w tabelach liczb dywiz jest za krótki
 * i wizualnie gubi się przy cyfrach.
 */
export function signedPln(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const sign = n < 0 ? "−" : "+";
  return `${sign}${NUM.format(Math.abs(n))} zł`;
}

/**
 * Okres zwrotu: „4 mies.". `null` → DASH (brak danych kosztowych),
 * wartość nieskończona lub ujemna → „nigdy" (marża nie pokrywa wdrożenia).
 */
export function monthsLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  if (!Number.isFinite(n) || n < 0) return "nigdy";
  return `${NUM.format(Math.round(n))} mies.`;
}

/** Liczba całkowita w pl-PL — spójna z resztą etykiet wykresów. */
export function nf(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return NUM.format(n);
}
