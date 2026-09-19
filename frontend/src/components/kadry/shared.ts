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

/**
 * Liczba → tekst pola edycji, w zapisie POLSKIM (przecinek). Wcześniej pole
 * pokazywało „3583.34”, choć kadrowa wpisuje „3583,34” i tak samo widzi kwoty
 * w Excelu — wystarczyło wejść w komórkę i wyjść, żeby zobaczyć „obcy” format
 * własnej liczby. Wczytywanie działa w obie strony (patrz `fieldToNum`).
 */
export const numToField = (v: NumVal) =>
  v == null ? "" : String(v).replace(".", ",");

/**
 * Liczba PO normalizacji: opcjonalny minus, cyfry, opcjonalna część dziesiętna.
 * Lustro `DECIMAL_RE` z backendu (src/routes/hr.ts) — front nie ma prawa uznać
 * za liczbę czegoś, czego backend by odrzucił.
 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Tekst z pola → kanoniczny zapis liczby. Usuwa separatory tysięcy (spacja
 * zwykła, NBSP, wąska NBSP) i dopisek waluty, zamienia przecinek dziesiętny
 * na kropkę. NICZEGO nie zgaduje: co po normalizacji nie jest liczbą, zostaje
 * niepoprawne.
 */
const normalizeNumText = (v: string): string =>
  v
    // `\s` w JS obejmuje TAKŻE NBSP (U+00A0) i wąską spację (U+202F) — a to
    // one przyjeżdżają z Excela jako separator tysięcy.
    .replace(/\s/g, "")
    .replace(/zł/gi, "")
    .replace(",", ".");

/** Komunikat pod komórką/polem z niepoprawną liczbą — jedno brzmienie w całym module. */
export const NUM_FIELD_ERROR = "Nieprawidłowa liczba";

/**
 * Czy tekst pola da się zapisać? Puste = TAK (to „brak wartości”, nie błąd).
 *
 * Potrzebne osobno od `fieldToNum`, bo ta zwraca `null` i dla pustego pola,
 * i dla śmiecia — a to dwie różne rzeczy: pierwsze zapisujemy jako brak,
 * drugiego nie wysyłamy wcale.
 */
export const isNumFieldValid = (v: string): boolean => {
  const t = v.trim();
  return t === "" || DECIMAL_RE.test(normalizeNumText(t));
};

/**
 * Tekst pola → liczba albo `null` (puste LUB niepoprawne).
 *
 * Wcześniej `parseFloat`, który czyta PREFIKS: „3 200,00” dawało `3`, „12h”
 * dawało `12`, a „1e3” — `1000`. Kwota z separatorem tysięcy zapisywała się
 * jako trzy złote i pokazywała zielony ptaszek; backend nigdy tej wartości nie
 * widział, bo front wysyłał już liczbę. Sprawdzaj `isNumFieldValid()` PRZED
 * zapisem — samo `null` nie odróżnia pustego pola od błędu.
 */
export const fieldToNum = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = normalizeNumText(t);
  return DECIMAL_RE.test(n) ? Number(n) : null;
};

// --- dopasowanie po nazwisku (wklejki z arkusza) ---

/**
 * Tekst do PORÓWNANIA nazwisk: bez ogonków, bez interpunkcji, małymi literami.
 * Arkusz księgowości pisze „Kowalska-Nowak, Anna”, kartoteka „Kowalska Nowak
 * Anna” — bez tego żadne z nich nie trafi w drugie.
 */
export const normName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** „Kowalski Jan” i „Jan Kowalski” to ta sama osoba — klucz nie zna kolejności. */
export const nameKey = (s: string) => normName(s).split(" ").sort().join(" ");

// --- sortowanie list: wspólne porównania (wzorzec z Obiektów i Spółek) ---

/**
 * Teksty po polsku (żeby Ł nie lądowało za Z), a puste na końcu w OBU
 * kierunkach — jak NULLS LAST w SQL. Inaczej „sortuj po dziale” zaczynałoby się
 * od osób bez działu, czyli od wierszy, które w tej kolumnie nic nie mówią.
 */
export const cmpText = (
  a: string | null | undefined,
  b: string | null | undefined,
  mul: number,
): number => {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (!as || !bs) return !as && !bs ? 0 : as ? -1 : 1;
  return as.localeCompare(bs, "pl") * mul;
};

/** Liczby — ta sama reguła: brak wartości zawsze na końcu. */
export const cmpNum = (
  a: number | null | undefined,
  b: number | null | undefined,
  mul: number,
): number => {
  if (a == null || b == null)
    return a == null && b == null ? 0 : a == null ? 1 : -1;
  return (a - b) * mul;
};

/**
 * Kwoty, które tabela rysuje pustą komórką przy zerze (przelew/gotówka/wypłata,
 * kwota biura) — zero znaczy tu „nic nie ma”, więc sortuje się jak brak.
 */
export const cmpMoney = (a: number, b: number, mul: number) =>
  cmpNum(a || null, b || null, mul);

/**
 * Kwota z pola widełek — ten sam parser, co w komórkach („3 200,00” to 3200,
 * a nie 3). Śmieci dalej znaczą „bez ograniczenia”, czyli `undefined`.
 */
export function parseAmount(raw: string): number | undefined {
  return fieldToNum(raw) ?? undefined;
}

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

/**
 * Nazwy miesięcy po polsku — wspólne dla przełącznika miesiąca i nagłówków.
 *
 * Źródłem jest `@/lib/plDates`: ta sama tablica żyła w trzech miejscach naraz
 * (tutaj, w `pages/Technical.tsx` i w module wydruku), a wydruki stoją poza
 * drzewem komponentów i nie mogą ciągnąć pół zakładki Kadr przez ten jeden
 * import. Re-eksport zostaje, żeby dotychczasowe importy nie musiały się
 * przeprowadzać.
 */
export { MONTH_NAMES } from "@/lib/plDates";

/**
 * Pozycje słownika kadrowego, które NIE są obiektem chronionym, tylko kosztem
 * technicznym firmy: `#BIURO`, `#zlecenie`. Mapowanie ich na pojedynczy obiekt
 * zrzuciłoby koszt centrali na jednego klienta, więc zostają niezmapowane
 * celowo. Praca działowa ma własny słownik w Kadry → Działy.
 */
export function overheadKind(name: string): "techniczna" | null {
  return name.trim().startsWith("#") ? "techniczna" : null;
}
