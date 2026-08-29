/**
 * Wspólny fundament generatora danych deweloperskich (scripts/seed-dev-year.ts).
 *
 * Trzy zasady, które obowiązują KAŻDY moduł seeda:
 *
 * 1. DETERMINIZM. Losowość idzie wyłącznie przez `rng()` z ustalonego ziarna,
 *    więc dwa uruchomienia dają tę samą bazę. Bez tego „u mnie działa" przy
 *    debugowaniu wykresów jest bezwartościowe.
 *
 * 2. ZNACZNIK. Każdy wygenerowany wiersz niesie MARKER w polu tekstowym
 *    (notatka / opis / uwagi). Po nim `--reset` potrafi skasować dokładnie to,
 *    co seed dodał, nie tykając danych zaimportowanych (kadry, CMA, monitoring),
 *    które są prawdziwe i kosztowne do odtworzenia.
 *
 * 3. OKNO CZASU. Wszystko mieści się w `PERIOD` — ostatnich dwunastu miesiącach
 *    liczonych wstecz od TODAY. Daty poza tym oknem psują widoki miesięczne.
 */

/** Dzień „dzisiaj" dla generatora — stały, żeby baza była powtarzalna. */
export const TODAY = "2026-08-29";

/** Okno danych: 12 pełnych miesięcy wstecz od TODAY. */
export const PERIOD = {
  from: "2025-09-01",
  to: "2026-08-31",
} as const;

/**
 * Znacznik wierszy z seeda. Widoczny w UI i to celowo — patrząc na ekran ma być
 * od razu jasne, że to dane deweloperskie, a nie czyjś prawdziwy kontrahent.
 */
export const MARKER = "[dane deweloperskie]";

/** Czy tekst pochodzi z seeda (do `--reset`). */
export const isSeeded = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.includes(MARKER);

/** Dokleja znacznik do notatki, zachowując treść. */
export const mark = (text?: string): string =>
  text && text.trim() ? `${text}\n\n${MARKER}` : MARKER;

/* ------------------------------------------------------------------ */
/* Deterministyczna losowość (mulberry32)                              */
/* ------------------------------------------------------------------ */

let state = 0x9e3779b9;

/** Ustawia ziarno — wołane raz na starcie seeda. */
export function seed(n: number): void {
  state = n >>> 0;
}

/** Liczba z [0,1). Jedyne źródło losowości w całym seedzie. */
export function rng(): number {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Liczba całkowita z [min, max]. */
export const int = (min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

/** Liczba zmiennoprzecinkowa zaokrąglona do `dp` miejsc. */
export const num = (min: number, max: number, dp = 0): number => {
  const v = rng() * (max - min) + min;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Jeden element listy. */
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

/** `n` różnych elementów listy (albo tyle, ile się da). */
export function pickMany<T>(arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Zdarzenie o zadanym prawdopodobieństwie. */
export const chance = (p: number): boolean => rng() < p;

/** Losowy element z wagami: [[wartość, waga], …]. */
export function weighted<T>(pairs: readonly (readonly [T, number])[]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

/* ------------------------------------------------------------------ */
/* Daty — wszystko w ISO, tak jak trzyma to baza                       */
/* ------------------------------------------------------------------ */

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const isoStamp = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");
/** Format `calendar_events.start_at`: "YYYY-MM-DDTHH:MM" (bez strefy). */
export const isoLocal = (d: Date): string => d.toISOString().slice(0, 16);

export const parseDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

export function addDays(iso: string, n: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function addMonths(iso: string, n: number): string {
  const d = parseDate(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return isoDate(d);
}

/** Losowa data z okna PERIOD (albo z podanego zakresu). */
export function dateBetween(from: string = PERIOD.from, to: string = PERIOD.to): string {
  const a = parseDate(from).getTime();
  const b = parseDate(to).getTime();
  return isoDate(new Date(a + rng() * (b - a)));
}

/** Czy dzień jest roboczy (pon–pt). */
export function isWorkday(iso: string): boolean {
  const wd = parseDate(iso).getUTCDay();
  return wd >= 1 && wd <= 5;
}

/** Najbliższy dzień roboczy nie wcześniejszy niż `iso`. */
export function nextWorkday(iso: string): string {
  let d = iso;
  while (!isWorkday(d)) d = addDays(d, 1);
  return d;
}

/** Lista [rok, miesiąc] dla wszystkich miesięcy okna PERIOD. */
export function monthsInPeriod(): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const end = parseDate(PERIOD.to);
  const d = parseDate(PERIOD.from);
  while (d <= end) {
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Polskie słowniki — fikcyjne, ale wiarygodne                         */
/* ------------------------------------------------------------------ */

export const CITIES = [
  ["Kraków", "małopolskie"], ["Warszawa", "mazowieckie"], ["Katowice", "śląskie"],
  ["Gliwice", "śląskie"], ["Kielce", "świętokrzyskie"], ["Tarnów", "małopolskie"],
  ["Rzeszów", "podkarpackie"], ["Częstochowa", "śląskie"], ["Radom", "mazowieckie"],
  ["Skawina", "małopolskie"], ["Nowy Sącz", "małopolskie"], ["Bochnia", "małopolskie"],
  ["Olkusz", "małopolskie"], ["Chrzanów", "małopolskie"], ["Busko-Zdrój", "świętokrzyskie"],
  ["Sosnowiec", "śląskie"], ["Bytom", "śląskie"], ["Zabrze", "śląskie"],
  ["Mielec", "podkarpackie"], ["Dębica", "podkarpackie"], ["Wieliczka", "małopolskie"],
  ["Oświęcim", "małopolskie"], ["Myślenice", "małopolskie"], ["Piaseczno", "mazowieckie"],
] as const;

export const STREETS = [
  "Przemysłowa", "Fabryczna", "Handlowa", "Krakowska", "Warszawska", "Kolejowa",
  "Logistyczna", "Wrocławska", "Zielona", "Słoneczna", "Lipowa", "Dworcowa",
  "Chopina", "Piłsudskiego", "Wojska Polskiego", "Rynek", "Ogrodowa", "Graniczna",
  "Magazynowa", "Spółdzielcza", "Tysiąclecia", "Armii Krajowej",
] as const;

/** Człony nazw firm — składane w `companyName()`. */
export const FIRM_CORE = [
  "Nowak", "Kowalski", "Wiśniewski", "Zieliński", "Mazur", "Krawczyk", "Kaczmarek",
  "Piotrowski", "Grabowski", "Pawłowski", "Michalski", "Adamczyk", "Dudek", "Sikora",
  "Wróbel", "Baran", "Rutkowski", "Ostrowski", "Górski", "Jasiński",
] as const;

export const FIRM_TRADE = [
  "Logistyka", "Nieruchomości", "Energia", "Inwestycje", "Handel", "Produkcja",
  "Transport", "Development", "Serwis", "Technika", "Systemy", "Chemia",
  "Metal", "Drewno", "Spożywcza", "Motors", "Recykling", "Budownictwo",
] as const;

export const FIRM_SUFFIX = ["Sp. z o.o.", "S.A.", "Sp. z o.o. Sp. k.", "Sp.j."] as const;

/** Typy obiektów chronionych — do nazw lokalizacji. */
export const SITE_KIND = [
  "Magazyn Centralny", "Hala produkcyjna", "Biurowiec", "Galeria handlowa",
  "Parking dozorowany", "Terminal przeładunkowy", "Farma PV", "Osiedle",
  "Portiernia i brama główna", "Salon sprzedaży", "Stacja paliw", "Centrum logistyczne",
  "Zakład produkcyjny", "Punkt handlowy", "Baza sprzętowa", "Archiwum zakładowe",
] as const;

export const FIRST_NAMES_M = ["Marek", "Paweł", "Tomasz", "Piotr", "Adam", "Rafał", "Jacek", "Krzysztof", "Michał", "Grzegorz"] as const;
export const FIRST_NAMES_F = ["Anna", "Katarzyna", "Magdalena", "Agnieszka", "Joanna", "Ewa", "Beata", "Monika", "Alicja", "Dorota"] as const;
export const LAST_NAMES = ["Dąbrowa", "Kowalczyk", "Zieliński", "Lewandowska", "Szymański", "Woźniak", "Kozłowski", "Jankowska", "Mazurek", "Kwiatkowski", "Wojciechowska", "Kamiński"] as const;

/** Nazwa firmy — kombinacja nazwiska, branży i formy prawnej. */
export function companyName(): string {
  return `${pick(FIRM_CORE)} ${pick(FIRM_TRADE)} ${pick(FIRM_SUFFIX)}`;
}

/** Imię i nazwisko osoby kontaktowej. */
export function personName(): string {
  const first = chance(0.5) ? pick(FIRST_NAMES_M) : pick(FIRST_NAMES_F);
  return `${first} ${pick(LAST_NAMES)}`;
}

export function address(): string {
  return `${pick(STREETS)} ${int(1, 180)}${chance(0.25) ? `/${int(1, 40)}` : ""}`;
}

export function phone(): string {
  return `${int(500, 899)} ${int(100, 999)} ${int(100, 999)}`;
}

/**
 * NIP z poprawną cyfrą kontrolną — walidatory w aplikacji (NIPField, formularz
 * kontrahenta) odrzucają byle jakie dziesięć cyfr, więc syntetyczny NIP też musi
 * się liczyć. Prefiks 999 nie występuje w prawdziwych numerach.
 *
 * UWAGA NA KOLIZJE: gdy cyfra kontrolna wypadnie 10 (niedozwolona), funkcja
 * zwraca numer dla `n + 1` — czyli ten sam, co dla następnego indeksu. Kto woła
 * to w pętli po unikalnej kolumnie, musi deduplikować sam (patrz `nipAllocator`
 * w commercial.ts), inaczej dostanie UNIQUE constraint w środku transakcji.
 */
export function nip(n: number): string {
  const base = `999${String(100000 + n).slice(0, 6)}`;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(base[i]) * w[i];
  const check = sum % 11;
  // Cyfra kontrolna 10 jest niedozwolona — podbijamy bazę i próbujemy dalej.
  return check === 10 ? nip(n + 1) : base + String(check);
}

export function email(name: string, domain = "example.invalid"): string {
  const slug = name
    .toLowerCase()
    .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l")
    .replace(/ń/g, "n").replace(/ó/g, "o").replace(/ś/g, "s").replace(/[żź]/g, "z")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `${slug}@${domain}`;
}

/** Ładna kwota — zaokrąglona do dziesiątek, jak w cennikach. */
export const money = (min: number, max: number, step = 10): number =>
  Math.round(num(min, max) / step) * step;
