/**
 * Wspólna logika trzech widoków analityki: pobranie danych, sumy po filtrze
 * tekstowym, komparatory i barwy pochodne.
 *
 * Wszystko tutaj powtarzałoby się dosłownie trzy razy, a kontrakt NULL-owego
 * kosztu („nieuzupełniony” ≠ 0 zł) musi zachowywać się identycznie we
 * wszystkich zakładkach — trzy kopie rozjeżdżają się przy pierwszej poprawce.
 *
 * Świadomie NIE ląduje to w `components/analytics/` obok prymitywów: tamte są
 * czysto prezentacyjne (propsy → SVG), a tu jest pobieranie danych i wiedza
 * o kształcie odpowiedzi API. Komponenty pomocnicze mieszkają w `./parts`,
 * żeby ten plik nie mieszał eksportów i nie psuł fast refresh.
 */
import { useEffect, useState } from "react";
import { pct, plnFull } from "@/components/analytics";
import {
  errStatus,
  type AnalyticsScope,
  type CostWindow,
  type PersonnelInfo,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Pobranie danych
// ---------------------------------------------------------------------------

export type LoadState = "loading" | "ready" | "forbidden" | "error";

/**
 * Każdy widok pobiera własny endpoint, bo każdy stoi pod innym uprawnieniem —
 * użytkownik z dostępem tylko do „Obiektów” dostanie 403 na dwóch pozostałych
 * i to nie może zablokować całej strony.
 *
 * `load` musi być funkcją z poziomu modułu (stabilna tożsamość), inaczej efekt
 * strzelałby żądaniem przy każdym renderze.
 *
 * Stan „ładowanie” jest WYLICZANY z porównania klucza żądania, a nie ustawiany
 * w efekcie: odpowiedź na poprzedni zakres nie może podmienić danych nowego,
 * a przy okazji odpada jeden render na każdą zmianę filtra.
 */
export function useAnalyticsResource<T>(
  load: (scope: AnalyticsScope, costWindow: CostWindow) => Promise<{ data?: T }>,
  scope: AnalyticsScope,
  costWindow: CostWindow,
  reloadKey: number
): { data: T | null; state: LoadState } {
  // Okno kosztu osobowego jest częścią klucza żądania, a nie tylko parametrem:
  // po jego zmianie wracają INNE liczby, więc odpowiedź na poprzednie okno nie
  // może podmienić danych bieżącego (i widok ma wtedy pokazać „ładowanie”).
  const key = `${scope}|${costWindow}|${reloadKey}`;
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    state: Exclude<LoadState, "loading">;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    load(scope, costWindow)
      .then((res) => {
        if (alive) setResult({ key, data: res.data ?? null, state: "ready" });
      })
      .catch((e) => {
        if (!alive) return;
        setResult({
          key,
          data: null,
          state: errStatus(e) === 403 ? "forbidden" : "error",
        });
      });
    return () => {
      alive = false;
    };
  }, [load, scope, costWindow, key]);

  if (result?.key !== key) return { data: null, state: "loading" };
  return { data: result.data, state: result.state };
}

// ---------------------------------------------------------------------------
// Sumy po filtrze tekstowym
// ---------------------------------------------------------------------------

/** Sumy widoku — ten sam słownik faktów co `AnalyticsTotals` z backendu. */
export interface Agg {
  objects: number;
  objectsWithCost: number;
  /** 0..1 — na ilu obiektach opiera się zysk i marża. */
  coverage: number;
  revenue: number;
  /** Koszt CAŁKOWITY — suma dwóch poniższych. */
  cost: number;
  /** Część osobowa (z wypłat w Kadrach, netto „na rękę"). */
  personnelCost: number;
  /** Część pozostała (ręczne `monthly_cost`: monitoring, sprzęt, abonamenty). */
  otherCost: number;
  profit: number;
  margin: number | null;
  setupCost: number;
  arpo: number | null;
}

export interface AggInput {
  objects: number;
  withCost: number;
  revenue: number;
  cost: number;
  personnelCost: number;
  otherCost: number;
  profit: number;
  setupCost: number;
}

/**
 * Przelicza sumy z widocznych wierszy. Potrzebne, bo szukajka filtruje po
 * stronie przeglądarki: kafelki KPI muszą mówić o tym samym zbiorze, co
 * tabela pod nimi, inaczej strona przeczy sama sobie.
 *
 * Koszt `null` wchodzi do sumy jako 0 (tak liczy backend), ale `coverage`
 * mówi, ile z tego jest naprawdę zmierzone.
 */
export function aggregate(rows: AggInput[]): Agg {
  const acc = rows.reduce(
    (a, r) => ({
      objects: a.objects + r.objects,
      objectsWithCost: a.objectsWithCost + r.withCost,
      revenue: a.revenue + r.revenue,
      cost: a.cost + r.cost,
      personnelCost: a.personnelCost + r.personnelCost,
      otherCost: a.otherCost + r.otherCost,
      profit: a.profit + r.profit,
      setupCost: a.setupCost + r.setupCost,
    }),
    {
      objects: 0,
      objectsWithCost: 0,
      revenue: 0,
      cost: 0,
      personnelCost: 0,
      otherCost: 0,
      profit: 0,
      setupCost: 0,
    }
  );
  return {
    ...acc,
    coverage: acc.objects > 0 ? acc.objectsWithCost / acc.objects : 0,
    // Bez ani jednego znanego kosztu marża jest NIEZNANA, a nie stuprocentowa —
    // ta sama reguła, co marginOf() w src/routes/analytics.ts.
    margin:
      acc.objectsWithCost > 0 && acc.revenue > 0
        ? (acc.profit / acc.revenue) * 100
        : null,
    arpo: acc.objects > 0 ? acc.revenue / acc.objects : null,
  };
}

// ---------------------------------------------------------------------------
// Sortowanie
// ---------------------------------------------------------------------------

/**
 * Komparator „nieznane zawsze na końcu”. `null` w koszcie znaczy
 * „nieuzupełniony” — taki wiersz nie może wygrywać sortowania po marży ani po
 * zwrocie tylko dlatego, że w JS `null < 0`.
 */
export function cmpNullLast(
  a: number | null,
  b: number | null,
  dir: "asc" | "desc"
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === "asc" ? a - b : b - a;
}

export function cmpText(a: string, b: string, dir: "asc" | "desc"): number {
  const r = a.localeCompare(b, "pl");
  return dir === "asc" ? r : -r;
}

// ---------------------------------------------------------------------------
// Barwy pochodne
// ---------------------------------------------------------------------------

/**
 * Odcień barwy semantycznej — dla pasków udziałów, gdzie segmenty to
 * tożsamości (typy ochrony, kontrahenci), a nie osobne znaczenia finansowe.
 *
 * Nie generujemy nowych barw: bierzemy jedną z palety (niebieski = przychód,
 * bursztyn = koszt) i rozjaśniamy ją ku bieli. Dzięki temu pasek przychodu
 * zostaje niebieski, pasek kosztu bursztynowy, a przypisanie kategorii do
 * segmentu niesie legenda — kolor nigdy sam.
 */
export function tintOf(hex: string, index: number, count: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || count <= 1 || index <= 0) return hex;
  const n = parseInt(m[1], 16);
  // Najjaśniejszy segment zatrzymuje się na 62% drogi do bieli — dalej traci
  // kontrast z tłem karty.
  const f = (Math.min(index, count - 1) / (count - 1)) * 0.62;
  const mix = (c: number) => Math.round(c + (255 - c) * f);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Drobiazgi
// ---------------------------------------------------------------------------

/** Nazwisko handlowca z rekordu API (albo `null`, gdy nie ma opiekuna). */
export function spLabel(
  sp: { firstName: string; lastName: string } | null | undefined
): string | null {
  return sp ? `${sp.firstName} ${sp.lastName}`.trim() : null;
}

// ---------------------------------------------------------------------------
// Koszt osobowy — słowa, którymi go opisujemy
// ---------------------------------------------------------------------------

/** Etykieta okna uśredniania: „ostatni pełny miesiąc" / „średnia z 3 mies.". */
export function costWindowLabel(w: CostWindow): string {
  return w === 1 ? "ostatni pełny miesiąc" : `średnia z ${w} mies.`;
}

const MONTHS_NOM = [
  "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
  "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień",
];

/** Miesiąc z nazwy: „czerwiec 2026". Mianownik, bo zdanie brzmi „… czeka na rozliczenie". */
export function monthLabel(m: { year: number; month: number }): string {
  return `${MONTHS_NOM[m.month - 1] ?? m.month} ${m.year}`;
}

/**
 * Podpis pod kafelkiem „Koszt mies.": z czego składa się pokazana suma.
 *
 * Koszt obiektu to DWIE różne rzeczy zsumowane w jedną liczbę — pensje załogi
 * z Kadr i ręczny koszt pozostały. Bez tego podpisu nie da się odróżnić obiektu
 * fizycznej ochrony (prawie sam koszt osobowy) od monitoringu (prawie sam sprzęt),
 * a to zupełnie inne dźwignie kosztowe.
 */
export function costSplitLabel(personnelCost: number, otherCost: number): string {
  return `osobowy ${plnFull(personnelCost)} · pozostały ${plnFull(otherCost)}`;
}

/**
 * Przypis o pochodzeniu kosztu osobowego — składany z `personnel` z API.
 *
 * Liczby same w sobie nic nie mówią, dopóki nie wiadomo, ILE miesięcy faktycznie
 * weszło do średniej i JAKA część godzin w ogóle trafiła na obiekty. Miesiąc bez
 * wypłat i pracownik z całym etatem na CMA wyglądają w kwocie identycznie —
 * jak niski koszt.
 */
export function personnelNote(p: PersonnelInfo): string {
  // Miesiąc z wierszami płacowymi, ale bez kwot, jest POMIJANY w średniej.
  // Sam licznik „dane za 2 z 3" wygląda na awarię systemu, a to najczęściej
  // jeden konkretny miesiąc, którego księgowa jeszcze nie domknęła — więc
  // wymieniamy go z nazwy, żeby było wiadomo, co domknąć.
  const skipped =
    p.skippedMonths.length > 0
      ? ` — ${p.skippedMonths.map(monthLabel).join(", ")} ${
          p.skippedMonths.length === 1 ? "czeka" : "czekają"
        } na rozliczenie`
      : "";
  const parts = [`Koszt osobowy: ${costWindowLabel(p.costWindow)}`];
  if (p.monthsUsed === 0) {
    parts[0] += ` (brak danych płacowych w tym oknie${skipped})`;
  } else if (p.monthsUsed < p.costWindow) {
    parts[0] += ` (dane za ${p.monthsUsed}${skipped})`;
  }
  parts.push(
    `zmapowano ${p.mappedObjects} z ${p.hrObjectsTotal} pozycji kadrowych`
  );
  if (p.unmappedHoursShare > 0) {
    parts.push(
      `${pct(p.unmappedHoursShare * 100)} godzin poza obiektami (koszt ogólny)`
    );
  }
  return `${parts.join(", ")}.`;
}

/**
 * Zdanie o DRUGIEJ ścieżce kosztu osobowego — udziale w puli centrum
 * monitorowania. To blisko połowa całego kosztu osobowego, a przypis o niej
 * milczał: czytelnik widział tylko „zmapowano N pozycji kadrowych" i miał prawo
 * sądzić, że alokacja z godzin to wszystko.
 *
 * Zwraca `null`, gdy mechanizm jest nieaktywny (nikt nie oznaczył pozycji-puli) —
 * wtedy nie ma o czym pisać.
 */
export function cmaNote(p: PersonnelInfo): string | null {
  const c = p.cma;
  if (c.poolPositions === 0 || c.pool <= 0) return null;
  return (
    `Z kosztu osobowego ${plnFull(c.pool)}/mies. to udział w puli centrum ` +
    `monitorowania: dzielona przez ${c.units} jednostek dozoru na ` +
    `${c.objectsInDenominator} obiektach, czyli ${plnFull(c.perUnit)} za jednostkę ` +
    `(kamera po sztuce, SSWiN i wideorecepcja po jednym).`
  );
}

/** Filtr tekstowy: bez rozróżniania wielkości liter, po kilku polach naraz. */
export function matches(needle: string, ...fields: (string | null | undefined)[]) {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

/** Wspólne propsy trzech widoków — pasek narzędzi mieszka w powłoce strony. */
export interface AnalyticsViewProps {
  scope: AnalyticsScope;
  /** Okno uśredniania kosztu osobowego (1 / 3 / 12 mies.) z paska narzędzi. */
  costWindow: CostWindow;
  search: string;
  reloadKey: number;
}
