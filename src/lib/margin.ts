/**
 * Marża i narzut — jedno miejsce, z którego liczą magazyn, usługi i oferty.
 *
 * MARŻA vs NARZUT to dwie różne liczby i mylenie ich kosztuje pieniądze:
 * przy koszcie 100 zł i cenie 125 zł marża wynosi 20% (część ceny, która jest
 * zyskiem), a narzut 25% (o ile podniesiono koszt). Pokazujemy obie.
 *
 * Wszystkie kwoty NETTO — jak w całej bazie (patrz nagłówek src/db/schema.ts).
 */

/** Zaokrąglenie do groszy; ta sama konwencja co `money()` w src/routes/quotes.ts. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Margin {
  /** Zysk na jednostce w zł (cena − koszt). */
  amount: number;
  /** Marża: udział zysku w cenie sprzedaży (%). */
  marginPct: number;
  /** Narzut: o ile procent cena przewyższa koszt (%). */
  markupPct: number;
}

/**
 * Marża i narzut dla pary koszt/cena.
 *
 * Zwraca `null`, kiedy liczby nie da się policzyć uczciwie — brak kosztu, brak
 * ceny albo koszt zerowy. `null` znaczy „nie wiem", a UI ma pokazać „brak
 * danych", NIE zero i NIE 100%: towar bez wpisanej ceny zakupu wyglądałby
 * inaczej jako w pełni zyskowny, co jest najgorszą możliwą pomyłką w ofercie.
 */
export function marginOf(
  cost: number | null | undefined,
  price: number | null | undefined
): Margin | null {
  if (cost === null || cost === undefined) return null;
  if (price === null || price === undefined) return null;
  if (!Number.isFinite(cost) || !Number.isFinite(price)) return null;
  // Koszt 0 daje narzut nieskończony, a cena 0 — marżę nieskończoną na minusie.
  // Obie sytuacje to brak danych, nie wynik.
  if (cost <= 0 || price <= 0) return null;

  const amount = round2(price - cost);
  return {
    amount,
    marginPct: round2(((price - cost) / price) * 100),
    markupPct: round2(((price - cost) / cost) * 100),
  };
}

/**
 * Cena sprzedaży towaru: własna, a gdy jej nie ma — cena zakupu powiększona
 * o globalny narzut `company.warehouse_markup`.
 *
 * Liczymy PRZY ODCZYCIE, nie zapisujemy do bazy: dzięki temu zmiana narzutu
 * w panelu firmy przelicza cały katalog, zamiast zostawiać stare ceny
 * w towarach, których nikt od tamtej pory nie edytował.
 */
export function effectiveSalePrice(
  item: { purchasePrice?: number | null; salePrice?: number | null },
  markupPct: number
): number | null {
  if (item.salePrice !== null && item.salePrice !== undefined) {
    return round2(item.salePrice);
  }
  if (item.purchasePrice === null || item.purchasePrice === undefined) return null;
  if (!Number.isFinite(item.purchasePrice)) return null;
  return round2(item.purchasePrice * (1 + markupPct / 100));
}

/** Czy cena sprzedaży pochodzi z automatu (towar nie ma własnej). */
export const isSalePriceAuto = (item: {
  salePrice?: number | null;
}): boolean => item.salePrice === null || item.salePrice === undefined;

/** Pola cenowe doklejane do towaru w odpowiedzi API. */
export interface PricingFields {
  effectiveSalePrice: number | null;
  salePriceAuto: boolean;
  marginAmount: number | null;
  marginPct: number | null;
  markupPct: number | null;
}

/** Wylicza komplet pól cenowych dla jednego towaru. */
export function pricingFor(
  item: { purchasePrice?: number | null; salePrice?: number | null },
  markupPct: number
): PricingFields {
  const price = effectiveSalePrice(item, markupPct);
  const m = marginOf(item.purchasePrice, price);
  return {
    effectiveSalePrice: price,
    salePriceAuto: isSalePriceAuto(item),
    marginAmount: m?.amount ?? null,
    marginPct: m?.marginPct ?? null,
    markupPct: m?.markupPct ?? null,
  };
}
