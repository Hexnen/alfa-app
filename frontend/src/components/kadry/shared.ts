// Wspólne drobiazgi tabel modułu Kadry: formatery i konwersja pól liczbowych.
// Trzyma je jeden plik, bo korzystają z nich i ekran Kadr, i formularze,
// i siatka godzin — trzy kopie tych samych funkcji rozjeżdżały się w zapisie
// liczb (przecinek vs kropka) i w zaokrągleniach.

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});

export const money = (v: number | null | undefined) =>
  v == null ? "—" : pln.format(v);

export const hrs = (v: number | null | undefined) =>
  v == null ? "—" : String(Math.round(v * 100) / 100).replace(".", ",");

/** Select w komórce tabeli — wygląd pól z formularzy Kadr, tylko niższy. */
export const TABLE_SELECT_CLS =
  "h-8 w-full min-w-52 rounded-md border border-input bg-background px-2 py-1 text-xs";

// pole liczbowe: puste = brak wartości (null), przecinek dozwolony
export type NumVal = number | string | null | undefined;

export const numToField = (v: NumVal) => (v == null ? "" : String(v));

export const fieldToNum = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
