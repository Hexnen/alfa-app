/**
 * Dopasowanie nazw do cennika i stawki (RBH, km) — moduł CELOWO bez zależności od bazy.
 *
 * Wydzielony z src/lib/realization-autofill.ts, żeby te same reguły mogła stosować wycena
 * budowana z protokołu (src/routes/quotes.ts) bez wciągania automatu realizacji, który
 * importuje kalendarz — a kalendarz importuje wyceny (cykl importów).
 *
 * Autofill re-eksportuje wszystko z tego pliku, więc dotychczasowe importy działają bez zmian.
 */
import type { PriceItem } from "../db/schema.js";
import type { CompanySettingsValues } from "./company-config.js";

/** lower + bez polskich znaków + bez wszystkiego, co nie jest literą/cyfrą. */
export function normalizeName(s: string): string {
  return s
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Pozycja cennika dla nazwy z protokołu: najpierw dokładne dopasowanie po znormalizowanej
 * nazwie, potem częściowe (jedna nazwa zawiera drugą — wygrywa najdłuższa wspólna).
 */
export function matchPriceItem(name: string, items: PriceItem[]): PriceItem | null {
  const target = normalizeName(name);
  if (!target) return null;

  const exact = items.find((i) => normalizeName(i.name) === target);
  if (exact) return exact;

  let best: PriceItem | null = null;
  let bestLen = 0;
  for (const i of items) {
    const n = normalizeName(i.name);
    if (!n) continue;
    if (n.includes(target) || target.includes(n)) {
      const len = Math.min(n.length, target.length);
      if (len > bestLen) {
        best = i;
        bestLen = len;
      }
    }
  }
  // Zbyt krótkie dopasowanie (np. „kabel” do „kabelutpkat5e”) łatwo trafia w przypadkowy wiersz.
  return bestLen >= 4 ? best : null;
}

export const HOUR_UNITS = new Set(["RBH", "RG", "H", "G", "GODZ", "GODZ.", "GODZINA", "GODZINY"]);
export const KM_UNITS = new Set(["KM", "KM.", "KILOMETR"]);

export const unitOf = (i: PriceItem) => i.unit.trim().toUpperCase();

export type HourRate =
  | { mode: "flat"; rate: number; itemName: string }
  | { mode: "tiered"; first: number; next: number; firstName: string; nextName: string }
  | { mode: "settings"; rate: number }
  | null;

/**
 * Stawka RBH szukana WYŁĄCZNIE wśród pozycji usługowych z jednostką godzinową.
 * Cennik usera rozbija robociznę na „PIERWSZA ROZPOCZĘTA GODZINA” i „KOLEJNA…”, więc gdy obie
 * pozycje istnieją, liczymy schodkowo (1 × pierwsza + reszta × kolejna) — inaczej jedna stawka.
 */
export function resolveHourRate(items: PriceItem[], values: Pick<CompanySettingsValues, "rateHour">): HourRate {
  const hourly = items.filter((i) => i.kind === "service" && (HOUR_UNITS.has(unitOf(i)) || /godz/i.test(i.unit)));
  if (hourly.length > 0) {
    const first = hourly.find((i) => /pierwsz/i.test(i.name));
    const next = hourly.find((i) => /kolejn|nastepn|następn/i.test(i.name));
    if (first && next && first.id !== next.id) {
      return { mode: "tiered", first: first.price, next: next.price, firstName: first.name, nextName: next.name };
    }
    const named = hourly.find((i) => /roboczogodz|rbh/i.test(`${i.name} ${i.unit}`));
    const pickItem = named ?? hourly[0];
    if (pickItem.price > 0) return { mode: "flat", rate: pickItem.price, itemName: pickItem.name };
  }
  return values.rateHour > 0 ? { mode: "settings", rate: values.rateHour } : null;
}

/** Stawka za km: pozycja usługowa z jednostką KM ma pierwszeństwo przed `company.rate_km`. */
export function resolveKmRate(
  items: PriceItem[],
  values: Pick<CompanySettingsValues, "rateKm">
): { rate: number; itemName: string | null } | null {
  const kmItem = items.find((i) => i.kind === "service" && KM_UNITS.has(unitOf(i)) && i.price > 0);
  if (kmItem) return { rate: kmItem.price, itemName: kmItem.name };
  return values.rateKm > 0 ? { rate: values.rateKm, itemName: null } : null;
}
