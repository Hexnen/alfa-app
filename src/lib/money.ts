/**
 * Jeden parser kwot dla wszystkich tras z cenami (magazyn, cennik, usługi).
 *
 * Do tej pory każdy moduł miał własną kopię z INNĄ semantyką: cennik robił
 * `parseFloat("1 234,56")` = 1 zł (cicho ucinał po spacji), usługi to samo przez
 * `parseFloat`, a magazyn przez `Number()` odrzucał — ta sama wartość wpisana
 * przez tego samego użytkownika dawała trzy różne wyniki. Tu reguły są jedne:
 *
 *  - `""` / `null` / `undefined` → `null` („nie podano”; caller decyduje, czy
 *    to 0, NULL w bazie czy błąd „pole wymagane”),
 *  - liczba → zaokrąglona do grosza,
 *  - string → po `trim()` musi być CAŁY liczbą dziesiętną (kropka albo
 *    przecinek); spacja w środku, „abc”, „1.234,56” → błąd, nigdy cicha jedynka,
 *  - poniżej `min` → błąd (domyślnie `min: 0` — kwota ujemna nie ma sensu
 *    w żadnym z tych modułów; kto potrzebuje ujemnych, podaje `min: -Infinity`).
 */

const DECIMAL_RE = /^-?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

export interface ParseMoneyOptions {
  /** Dolna granica (włącznie). Domyślnie 0. */
  min?: number;
  /** Zaokrąglenie do grosza (domyślnie tak). `false` = surowa wartość. */
  round?: boolean;
}

export type ParseMoneyResult =
  | { value: number | null; error?: undefined }
  | { value?: undefined; error: string };

export function parseMoney(
  raw: unknown,
  label: string,
  opts: ParseMoneyOptions = {}
): ParseMoneyResult {
  const min = opts.min ?? 0;
  const round = opts.round ?? true;

  if (raw === undefined || raw === null || raw === "") return { value: null };

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return { value: null };
    if (!DECIMAL_RE.test(t)) {
      return { error: `${label} musi być liczbą (np. 1234,56 — bez spacji)` };
    }
    n = Number(t.replace(",", "."));
  } else {
    return { error: `${label} musi być liczbą` };
  }

  if (!Number.isFinite(n)) return { error: `${label} musi być liczbą` };
  if (n < min) {
    return {
      error:
        min === 0
          ? `${label} musi być liczbą nieujemną`
          : `${label} nie może być mniejsza niż ${min}`,
    };
  }
  return { value: round ? Math.round(n * 100) / 100 : n };
}
