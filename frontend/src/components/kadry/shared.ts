// Wspólne drobiazgi tabel modułu Kadry: formatery, konwersja pól liczbowych
// i kodowanie przypisania wiersza godzin.
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

// --- przypisanie wiersza godzin: obiekt ALBO dział ---

/**
 * Wiersz godzin wskazuje obiekt albo dział — dwa rozłączne słowniki w jednym
 * `<select>`. Wartością opcji jest TOKEN, a nie samo id: numeracja obu tabel
 * zaczyna się od 1, więc „5" nie odróżniłoby obiektu od działu, a sztuczki
 * w rodzaju ujemnych id dla działów przeciekłyby stąd wprost do payloadu.
 */
export interface Assignment {
  objectId: number | null;
  departmentId: number | null;
}

export const NO_ASSIGNMENT: Assignment = { objectId: null, departmentId: null };

/** Wiersz → token `""` (brak) / `o:<id>` (obiekt) / `d:<id>` (dział). */
export const formatAssignment = (row: Partial<Assignment>): string =>
  row.departmentId != null
    ? `d:${row.departmentId}`
    : row.objectId != null
      ? `o:${row.objectId}`
      : "";

/**
 * Token → para id. Zawsze zwraca OBA pola (jedno `null`), żeby wywołujący
 * wysłał komplet: PUT nadpisuje cały wiersz, więc pominięcie drugiego pola
 * zostawiłoby stare przypisanie i wpis wskazywałby jednocześnie obiekt i dział
 * (backend odbija to jako 400).
 */
export const parseAssignment = (token: string): Assignment => {
  const raw = (token ?? "").trim();
  const id = Number(raw.slice(2));
  if (!Number.isInteger(id) || id <= 0) return { ...NO_ASSIGNMENT };
  if (raw.startsWith("o:")) return { objectId: id, departmentId: null };
  if (raw.startsWith("d:")) return { objectId: null, departmentId: id };
  return { ...NO_ASSIGNMENT };
};
