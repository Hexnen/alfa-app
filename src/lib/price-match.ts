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

/** lower + bez polskich znaków (ł też) — wspólny krok normalizacji. */
function fold(s: string): string {
  return s
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** lower + bez polskich znaków + bez wszystkiego, co nie jest literą/cyfrą. */
export function normalizeName(s: string): string {
  return fold(s).replace(/[^a-z0-9]/g, "");
}

/**
 * Tokeny nazwy: ciągi liter i ciągi cyfr, osobno. Granica litera/cyfra też dzieli
 * („2TB" → „2", „tb"; „KAM-10" → „kam", „10"), dzięki czemu „12V/2A" i „12 V 2 A"
 * dają te same tokeny, a „kat 5e" i „kat 6" — różne.
 */
export function nameTokens(s: string): string[] {
  return fold(s).match(/[a-z]+|[0-9]+/g) ?? [];
}

/**
 * Pozycja cennika dla nazwy z protokołu.
 *
 * 1. Dokładne dopasowanie po znormalizowanej nazwie (bez spacji/znaków) wygrywa zawsze.
 * 2. Inaczej kandydatem jest pozycja, której tokeny zawierają WSZYSTKIE tokeny zapytania
 *    jako CAŁE tokeny — „KAM-1" nie pasuje już do „KAM-10", a „kat 5e" do „kat 6".
 *    Lepszy kandydat = mniej tokenów nadmiarowych (nazwa bliższa zapytaniu).
 * 3. Remis między kandydatami („Kamera" vs „Kamera IP" i „Kamera PTZ") → null: automat
 *    nie zgaduje, człowiek wybiera. Wcześniej wygrywał pierwszy z listy.
 *
 * Zapytanie krótsze niż 4 znaki (po normalizacji) nie dopasowuje się częściowo —
 * „IP" trafiałoby w każdą kamerę IP.
 */
export function matchPriceItem(name: string, items: PriceItem[]): PriceItem | null {
  const target = normalizeName(name);
  if (!target) return null;

  const exact = items.filter((i) => normalizeName(i.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  if (target.length < 4) return null;
  const queryTokens = new Set(nameTokens(name));
  if (queryTokens.size === 0) return null;

  let best: PriceItem | null = null;
  let bestExtra = Infinity;
  let tie = false;
  for (const i of items) {
    const tokens = new Set(nameTokens(i.name));
    if (tokens.size === 0) continue;
    let covered = true;
    for (const t of queryTokens) {
      if (!tokens.has(t)) {
        covered = false;
        break;
      }
    }
    if (!covered) continue;
    const extra = tokens.size - queryTokens.size;
    if (extra < bestExtra) {
      best = i;
      bestExtra = extra;
      tie = false;
    } else if (extra === bestExtra) {
      tie = true;
    }
  }
  return tie ? null : best;
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
