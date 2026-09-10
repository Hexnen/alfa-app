/**
 * Kwota słownie po polsku — „1900 → jeden tysiąc dziewięćset złotych”.
 *
 * DLACZEGO WŁASNA IMPLEMENTACJA. Wzory umów mają obok każdej kwoty nawias
 * „(słownie: …)”, który handlowcy dopisywali ręcznie — i to jest miejsce, w którym
 * najłatwiej o literówkę w dokumencie mającym moc prawną. Biblioteki npm dla
 * polskiej odmiany albo nie odmieniają rzeczownika „złoty”, albo ciągną zależność
 * kilkudziesięciu kilobajtów po jedną funkcję; tu wystarczy czysta funkcja bez
 * stanu, którą da się przetestować tablicą przypadków.
 *
 * KONWENCJA ZGODNA Z ORYGINALNYM SZABLONEM: grupa równa 1 dostaje jawne „jeden”
 * („jeden tysiąc dziewięćset”, nie „tysiąc dziewięćset”), bo tak brzmi wzór
 * „Aktualna Umowa Draft Tylko ZDW.docx”. Grosze idą liczbowo jako „56/100”,
 * też za wzorem — to standard w umowach, a nie ozdobnik.
 */

const JEDNOSTKI = [
  "zero",
  "jeden",
  "dwa",
  "trzy",
  "cztery",
  "pięć",
  "sześć",
  "siedem",
  "osiem",
  "dziewięć",
];

const NASTKI = [
  "dziesięć",
  "jedenaście",
  "dwanaście",
  "trzynaście",
  "czternaście",
  "piętnaście",
  "szesnaście",
  "siedemnaście",
  "osiemnaście",
  "dziewiętnaście",
];

const DZIESIATKI = [
  "",
  "dziesięć",
  "dwadzieścia",
  "trzydzieści",
  "czterdzieści",
  "pięćdziesiąt",
  "sześćdziesiąt",
  "siedemdziesiąt",
  "osiemdziesiąt",
  "dziewięćdziesiąt",
];

const SETKI = [
  "",
  "sto",
  "dwieście",
  "trzysta",
  "czterysta",
  "pięćset",
  "sześćset",
  "siedemset",
  "osiemset",
  "dziewięćset",
];

/** Formy rzeczownika grupy: [1, 2–4, reszta]. */
type Formy = readonly [string, string, string];

const GRUPY: Formy[] = [
  ["", "", ""], // jedności — bez rzeczownika
  ["tysiąc", "tysiące", "tysięcy"],
  ["milion", "miliony", "milionów"],
  ["miliard", "miliardy", "miliardów"],
];

export const ZLOTE: Formy = ["złoty", "złote", "złotych"];

/**
 * Wybór formy rzeczownika dla liczby `n` (polska odmiana przez liczebnik):
 * 1 → forma pojedyncza, końcówka 2–4 poza nastkami → forma mnoga „lekka”,
 * reszta → dopełniacz. Stąd „21 złotych”, ale „22 złote”.
 */
export function forma(n: number, formy: Formy): string {
  const abs = Math.abs(Math.trunc(n));
  if (abs === 1) return formy[0];
  const ostatnia = abs % 10;
  const dwieOstatnie = abs % 100;
  if (ostatnia >= 2 && ostatnia <= 4 && (dwieOstatnie < 12 || dwieOstatnie > 14)) return formy[1];
  return formy[2];
}

/** Trzycyfrowa grupa (1–999) słownie, bez rzeczownika grupy. */
function grupaSlownie(n: number): string[] {
  const out: string[] = [];
  const setki = Math.floor(n / 100);
  const reszta = n % 100;
  if (setki > 0) out.push(SETKI[setki]);
  if (reszta >= 10 && reszta <= 19) {
    out.push(NASTKI[reszta - 10]);
  } else {
    const dziesiatki = Math.floor(reszta / 10);
    const jednosci = reszta % 10;
    if (dziesiatki > 0) out.push(DZIESIATKI[dziesiatki]);
    if (jednosci > 0) out.push(JEDNOSTKI[jednosci]);
  }
  return out;
}

/**
 * Liczba całkowita nieujemna słownie: `1900` → „jeden tysiąc dziewięćset”.
 * Rzuca przy liczbie ujemnej albo spoza zakresu miliardów — kwota w umowie
 * poza tym zakresem to na pewno pomyłka wpisu, a nie przypadek do obsłużenia.
 */
export function liczbaSlownie(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error("Liczba słownie wymaga nieujemnej liczby całkowitej");
  }
  if (n === 0) return JEDNOSTKI[0];
  if (n >= 1_000_000_000_000) {
    throw new Error("Liczba słownie obsługuje kwoty do miliardów");
  }

  // Rozbicie na trzycyfrowe grupy od najmniejszej.
  const grupy: number[] = [];
  let reszta = n;
  while (reszta > 0) {
    grupy.push(reszta % 1000);
    reszta = Math.floor(reszta / 1000);
  }

  const out: string[] = [];
  for (let i = grupy.length - 1; i >= 0; i--) {
    const g = grupy[i];
    if (g === 0) continue;
    out.push(...grupaSlownie(g));
    const rzeczownik = GRUPY[i];
    if (rzeczownik[0]) out.push(forma(g, rzeczownik));
  }
  return out.join(" ");
}

/**
 * Kwota słownie w formacie umowy: „jeden tysiąc dziewięćset złotych”,
 * a z groszami „jeden tysiąc dwieście trzydzieści cztery złote 56/100”.
 *
 * Zaokrąglamy do groszy PRZED podziałem — inaczej 1234.565 dałoby „56/100”
 * przy złotówkach policzonych z niezaokrąglonej wartości.
 */
export function kwotaSlownie(kwota: number): string {
  if (!Number.isFinite(kwota) || kwota < 0) {
    throw new Error("Kwota słownie wymaga nieujemnej liczby");
  }
  const grosze = Math.round(kwota * 100);
  const zlote = Math.floor(grosze / 100);
  const reszta = grosze % 100;
  const slowa = `${liczbaSlownie(zlote)} ${forma(zlote, ZLOTE)}`;
  return reszta === 0 ? slowa : `${slowa} ${String(reszta).padStart(2, "0")}/100`;
}
