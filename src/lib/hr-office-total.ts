/**
 * Rozliczenie jednego wiersza `hr_office_payroll` (arkusz "WYNAGRODZENIA - Biuro").
 *
 * JEDNA funkcja dla routera kadr (GET/POST/PUT /hr/office, /hr/summary) i dla
 * kosztu osobowego w analityce (src/lib/object-personnel-cost.ts). Do tej pory
 * były to dwie kopie tej samej formuły — i obie miały tę samą dziurę: wiersz
 * z kwotą, ale BEZ podstawy ROR, wychodził jako koszt ZERO, bo gotówkę liczyło
 * się wyłącznie jako „kwota − ROR", a bez ROR nie było od czego odjąć.
 *
 * SEMANTYKA KOLUMN (za arkuszem i komentarzami w schemacie):
 *  - `amount` (KWOTA) — ile osobie się należy za miesiąc; gdy puste, a są
 *    godziny do księgowej i stawka → godziny × stawka;
 *  - `rorBase` (PODSTAWA ROR) — część wypłacana PRZELEWEM, podaje księgowość
 *    (to od niej idą składki — stąd nazwa); może być większa od kwoty (22 wiersze
 *    na produkcji: wyrównania, dodatki księgowane po stronie przelewu);
 *  - `cashOverride` — ręczne delegacje/gotówka; gdy puste → kwota − ROR.
 *
 * ZASADA: koszt całkowity (`total`) NIE MOŻE być mniejszy niż to, co osobie
 * wypłacono. Stąd trzy przypadki gotówki wyliczanej:
 *  - kwota > ROR   → gotówka = kwota − ROR, razem = kwota,
 *  - kwota ≤ ROR   → gotówki nie ma (null), razem = ROR (przelew jest większy
 *                    od kwoty, więc to ON jest tym, co wypłacono),
 *  - brak ROR      → CAŁA kwota idzie jako gotówka, razem = kwota (a nie zero).
 * Ręczne `cashOverride` respektujemy dosłownie — operator wie lepiej.
 */
import type { HrOfficePayroll } from "../db/schema.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Kolumny wiersza biura potrzebne do rachunku (podzbiór `HrOfficePayroll`). */
export type OfficeRowInputs = Pick<
  HrOfficePayroll,
  "amount" | "hoursForAccounting" | "rate" | "rorBase" | "cashOverride"
>;

export interface OfficeRowTotals {
  /** Kwota — wpisana albo godziny × stawka; null, gdy nie ma z czego policzyć. */
  amountComputed: number | null;
  /** Część gotówkowa (delegacje/gotówka); null = nic nie idzie gotówką. */
  cash: number | null;
  /** Koszt całkowity wiersza = przelew (ROR) + gotówka. */
  total: number;
}

export function officeRowTotals(row: OfficeRowInputs): OfficeRowTotals {
  const amountComputed =
    row.amount ??
    (row.hoursForAccounting != null && row.rate != null
      ? round2(row.hoursForAccounting * row.rate)
      : null);
  let cash: number | null;
  if (row.cashOverride != null) {
    cash = row.cashOverride;
  } else if (amountComputed == null) {
    cash = null;
  } else if (row.rorBase == null) {
    // Bez podstawy ROR nie ma przelewu, więc cała kwota jest wypłatą „poza
    // przelewem". Wcześniej: null → razem 0, czyli pracownik za darmo.
    cash = amountComputed;
  } else {
    cash = amountComputed > row.rorBase ? round2(amountComputed - row.rorBase) : null;
  }
  const total = round2((row.rorBase ?? 0) + (cash ?? 0));
  return { amountComputed, cash, total };
}
