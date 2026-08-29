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
import { errStatus, type AnalyticsScope } from "@/lib/api";

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
  load: (scope: AnalyticsScope) => Promise<{ data?: T }>,
  scope: AnalyticsScope,
  reloadKey: number
): { data: T | null; state: LoadState } {
  const key = `${scope}|${reloadKey}`;
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    state: Exclude<LoadState, "loading">;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    load(scope)
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
  }, [load, scope, key]);

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
  cost: number;
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
      profit: a.profit + r.profit,
      setupCost: a.setupCost + r.setupCost,
    }),
    { objects: 0, objectsWithCost: 0, revenue: 0, cost: 0, profit: 0, setupCost: 0 }
  );
  return {
    ...acc,
    coverage: acc.objects > 0 ? acc.objectsWithCost / acc.objects : 0,
    margin: acc.revenue > 0 ? (acc.profit / acc.revenue) * 100 : null,
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

/** Filtr tekstowy: bez rozróżniania wielkości liter, po kilku polach naraz. */
export function matches(needle: string, ...fields: (string | null | undefined)[]) {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

/** Wspólne propsy trzech widoków — pasek narzędzi mieszka w powłoce strony. */
export interface AnalyticsViewProps {
  scope: AnalyticsScope;
  search: string;
  reloadKey: number;
}
