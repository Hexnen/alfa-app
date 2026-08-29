/**
 * Geometria wykresów — przepisane z `CmaTrends.tsx:103-134`, żeby nie ruszać
 * działającej strony. Te dwie funkcje to cały „silnik" wykresów w tym repo.
 */

/** „Ładna" skala osi: równe kroki, ~4 linie siatki. */
export function niceScale(maxValue: number): { max: number; ticks: number[] } {
  if (maxValue <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const rawStep = maxValue / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = 10 * pow;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (rawStep <= m * pow) {
      step = m * pow;
      break;
    }
  }
  const top = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return { max: top, ticks };
}

/** Słupek pionowy: 4px zaokrąglenia od strony danych, prosto przy osi. */
export function barPath(
  cx: number,
  top: number,
  width: number,
  height: number
): string {
  const r = Math.min(4, width / 2, height);
  const x0 = cx - width / 2;
  const bottom = top + height;
  return [
    `M${x0},${bottom}`,
    `V${top + r}`,
    `Q${x0},${top} ${x0 + r},${top}`,
    `H${x0 + width - r}`,
    `Q${x0 + width},${top} ${x0 + width},${top + r}`,
    `V${bottom}`,
    "Z",
  ].join(" ");
}

/**
 * Słupek poziomy: zaokrąglony koniec od strony danych (prawa), prosty przy
 * osi. Wersja pozioma jest tu potrzebna, bo polskie nazwy firm są za długie
 * na obróconą oś kategorii — wiersze czytają się bez przekręcania głowy.
 */
export function hBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  roundEnd = true
): string {
  const r = roundEnd ? Math.min(4, height / 2, Math.max(width, 0)) : 0;
  const w = Math.max(width, 0);
  const right = x + w;
  if (r <= 0) return `M${x},${y} H${right} V${y + height} H${x} Z`;
  return [
    `M${x},${y}`,
    `H${right - r}`,
    `Q${right},${y} ${right},${y + r}`,
    `V${y + height - r}`,
    `Q${right},${y + height} ${right - r},${y + height}`,
    `H${x}`,
    "Z",
  ].join(" ");
}

/** Wartość → pozycja na osi liniowej. */
export function linScale(
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number
): number {
  const span = domainMax - domainMin;
  if (span === 0) return rangeMin;
  return rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

/**
 * Minimalna liczba punktów, przy której wykres rozrzutu ma sens.
 * Przy 3-4 punktach kwadranty i linia zera wyglądają jak zepsuty wykres,
 * a nie jak analiza — wtedy wołający ma pokazać tabelę albo ranking.
 * `ScatterQuadrant` sam się tego pilnuje, ale strona powinna sprawdzić to
 * wcześniej, żeby w ogóle nie rezerwować miejsca na kartę.
 */
export const SCATTER_MIN_ROWS = 5;
