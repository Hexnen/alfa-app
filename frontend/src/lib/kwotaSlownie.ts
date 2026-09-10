/**
 * Kwota słownie po polsku — wersja KLIENCKA (bliźniak `src/lib/kwota-slownie.ts`
 * z backendu).
 *
 * Po co duplikat: pola `*_slownie` w draftach umów mają się przeliczać W LOCIE,
 * kiedy handlowiec zmienia abonament w formularzu — czekanie na zapis i odpowiedź
 * serwera znaczyłoby, że użytkownik widzi „starą” kwotę słownie w polu, które
 * zaraz trafi do umowy. Serwer i tak jest źródłem prawdy (dolicza puste pola
 * `*_slownie` przy zapisie), więc rozjazd formatu grozi tylko kosmetyką.
 *
 * Funkcje są czyste (bez Reacta), żeby dało się je wołać i z komponentu, i z testu.
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

/** Odmiana rzeczownika grupy: [1, 2–4, reszta]. */
type Odmiana = readonly [string, string, string];

const GRUPY: Odmiana[] = [
  ["", "", ""],
  ["tysiąc", "tysiące", "tysięcy"],
  ["milion", "miliony", "milionów"],
  ["miliard", "miliardy", "miliardów"],
  ["bilion", "biliony", "bilionów"],
];

/** Wybór formy: 1 → [0], 2–4 (poza 12–14) → [1], reszta → [2]. */
function forma(n: number, odmiana: Odmiana): string {
  const abs = Math.abs(n);
  if (abs === 1) return odmiana[0];
  const setka = abs % 100;
  const jednosc = abs % 10;
  if (jednosc >= 2 && jednosc <= 4 && !(setka >= 12 && setka <= 14)) return odmiana[1];
  return odmiana[2];
}

/** Trzycyfrowa grupa słownie („sto dwadzieścia trzy”); 0 → pusty string. */
function grupaSlownie(n: number): string {
  const out: string[] = [];
  const setki = Math.floor(n / 100);
  const reszta = n % 100;
  if (setki > 0) out.push(SETKI[setki]);
  if (reszta >= 10 && reszta < 20) {
    out.push(NASTKI[reszta - 10]);
  } else {
    const dzies = Math.floor(reszta / 10);
    const jedn = reszta % 10;
    if (dzies > 0) out.push(DZIESIATKI[dzies]);
    if (jedn > 0) out.push(JEDNOSTKI[jedn]);
  }
  return out.join(" ");
}

/**
 * Liczba całkowita słownie. Świadomie mówimy „jeden tysiąc”, a nie „tysiąc” —
 * tak brzmią wzory umów, które ten moduł odtwarza.
 */
export function liczbaSlownie(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "zero";

  // Rozbicie na grupy po trzy cyfry, od najmniej znaczącej.
  const grupy: number[] = [];
  let rest = n;
  while (rest > 0) {
    grupy.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const out: string[] = [];
  for (let i = grupy.length - 1; i >= 0; i--) {
    const g = grupy[i];
    if (g === 0) continue;
    out.push(grupaSlownie(g));
    if (i > 0) out.push(forma(g, GRUPY[i] ?? GRUPY[GRUPY.length - 1]));
  }
  const slowa = out.join(" ").trim();
  return value < 0 ? `minus ${slowa}` : slowa;
}

/** Odmiana złotówek: 1 złoty, 2–4 złote, reszta złotych. */
export function zlotyForma(n: number): string {
  return forma(Math.floor(Math.abs(n)), ["złoty", "złote", "złotych"]);
}

/**
 * Kwota słownie w formacie umów: `1900` → „jeden tysiąc dziewięćset złotych”,
 * `1234.56` → „jeden tysiąc dwieście trzydzieści cztery złote 56/100”.
 *
 * Grosze zostają cyframi (`56/100`) — tak są zapisane we wzorach umów i tak
 * czyta je księgowość; rozpisywanie ich słownie byłoby zmianą treści dokumentu.
 */
export function kwotaSlownie(value: number | string | null | undefined): string {
  const n = typeof value === "number" ? value : parseKwota(value);
  if (n === null) return "";
  // Zaokrąglenie do groszy przed rozbiciem: 0.1 + 0.2 w double potrafi dać 0.30000000000000004.
  const grosze = Math.round(Math.abs(n) * 100);
  const zlote = Math.floor(grosze / 100);
  const reszta = grosze % 100;
  const znak = n < 0 ? "minus " : "";
  const glowna = `${znak}${liczbaSlownie(zlote)} ${zlotyForma(zlote)}`;
  return reszta > 0 ? `${glowna} ${String(reszta).padStart(2, "0")}/100` : glowna;
}

/**
 * Kwota z pola formularza (string) na liczbę: przecinek jak kropka, spacje
 * (także twarde, z kopiuj-wklej) ignorowane. Pusto/śmieci → null.
 */
export function parseKwota(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  // U+00A0 = twarda spacja; wchodzi razem z kwotą kopiowaną z arkusza albo PDF-a.
  const s = String(raw)
    .replace(/[\s\u00A0]/g, "")
    .replace(",", ".")
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
