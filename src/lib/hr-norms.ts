/**
 * Norma godzin miesiąca z Kodeksu pracy — wyliczenie i słownik świąt.
 *
 * Art. 130 § 1 i 2 k.p. daje przepis na wymiar czasu pracy, który do tej pory
 * ktoś przepisywał do zakładki Normy ręcznie, raz w roku, z kalendarza w
 * internecie. Dwanaście liczb, każda mianownik stawki godzinowej — pomyłka
 * o jedną pozycję przesuwa kwoty całego miesiąca.
 *
 * Reguła (art. 130):
 *   wymiar = 40 h × liczba PEŁNYCH TYGODNI miesiąca
 *          +  8 h × dni od poniedziałku do piątku pozostałe po pełnych
 *                   tygodniach (czyli z ostatniego, niepełnego tygodnia)
 *          −  8 h × każde ŚWIĘTO przypadające w dniu INNYM NIŻ NIEDZIELA.
 *
 * Dwa miejsca, w których łatwo się pomylić:
 *  • „pełne tygodnie” liczy się od PIERWSZEGO dnia miesiąca (floor(dni/7)),
 *    a nie po tygodniach kalendarzowych — dlatego „dni wystające” to zawsze
 *    OSTATNIE 1–6 dni miesiąca, niezależnie od tego, w jaki dzień tygodnia
 *    miesiąc się zaczyna;
 *  • święto w SOBOTĘ TEŻ obniża wymiar (art. 130 § 2 po wyroku TK K 27/11 —
 *    wyłączona jest wyłącznie niedziela). To najczęstszy błąd w ręcznych
 *    tabelkach: sobotnie 15 sierpnia 2026 zabiera 8 h tak samo jak czwartek.
 *
 * Święta ustawowe: ustawa z 18.01.1951 o dniach wolnych od pracy, z nowelą
 * obowiązującą OD ROKU 2025, która dołożyła 24 grudnia (Wigilię).
 *
 * Lista świąt NIE JEST wbita w wyliczenie: `computeWorkNorms` dostaje ją
 * z zewnątrz (tabela `hr_holidays`, migracja 0108), a `statutoryHolidays`
 * służy tylko do jednorazowego zasiania roku. Gdyby ustawodawca dołożył nowe
 * święto w trakcie roku — albo firma chciała policzyć wymiar z dniem wolnym
 * spoza ustawy — wystarczy dopisać wiersz, bez wydawania nowej wersji.
 *
 * SANITY (sprawdzone przy pisaniu, patrz raport agenta):
 *  • 2026: Wielkanoc 5 IV, Poniedziałek Wielkanocny 6 IV, Zielone Świątki
 *    24 V, Boże Ciało 4 VI;
 *  • wymiary 2026 (h): I 160, II 160, III 176, IV 168, V 160, VI 168,
 *    VII 184, VIII 160, IX 176, X 176, XI 160, XII 160 — co do jednej
 *    pozycji zgadza się z normami wpisanymi ręcznie w `hr_month_norms`;
 *  • 2025: I 168, II 160, III 168, IV 168, V 160, VI 160, VII 184,
 *    VIII 160, IX 176, X 184, XI 144, XII 160 (grudzień traci 24 h: Wigilia
 *    w środę, oba dni świąt w czwartek i piątek).
 */

/** Wpis słownika świąt w postaci, jakiej potrzebuje wyliczenie. */
export interface HolidayInput {
  /** Data w formacie „YYYY-MM-DD”. */
  date: string;
  name?: string;
}

/** Święto ustawowe wyliczone algorytmem — data + nazwa urzędowa. */
export interface StatutoryHoliday {
  date: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Kalendarz
// ---------------------------------------------------------------------------

/** „2026-04-05” z daty UTC — bez `toISOString()` na dacie lokalnej (przesunięcie strefy). */
const iso = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;

/** „2026-08-15” z części — jedyne miejsce, gdzie sklejamy datę ręcznie. */
export const isoDate = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const addDays = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * 24 * 60 * 60 * 1000);

/** Dzień tygodnia daty „YYYY-MM-DD”: 0 = niedziela … 6 = sobota. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Nazwy dni tygodnia (indeks jak w `dayOfWeek`) — do opisu w oknie wyliczenia. */
export const DAY_NAMES_PL = [
  "niedziela",
  "poniedziałek",
  "wtorek",
  "środa",
  "czwartek",
  "piątek",
  "sobota",
];

/** Data „YYYY-MM-DD” jest poprawna i istnieje w kalendarzu (nie „2026-02-30”). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

/**
 * Niedziela wielkanocna — algorytm Meeusa/Jonesa/Butchera (kalendarz
 * gregoriański). Od niej liczą się trzy pozostałe święta ruchome:
 * Poniedziałek Wielkanocny (+1), Zielone Świątki (+49), Boże Ciało (+60).
 */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Rok, od którego 24 grudnia jest dniem ustawowo wolnym (nowela z 2024 r.). */
export const CHRISTMAS_EVE_FROM_YEAR = 2025;

/**
 * Święta ustawowe roku, posortowane po dacie. Nazwy jak w ustawie — trafiają
 * do bazy i do okna wyliczenia, więc mają być czytelne, a nie skrótowe.
 */
export function statutoryHolidays(year: number): StatutoryHoliday[] {
  const easter = easterSunday(year);
  const out: StatutoryHoliday[] = [
    { date: isoDate(year, 1, 1), name: "Nowy Rok" },
    { date: isoDate(year, 1, 6), name: "Święto Trzech Króli" },
    { date: iso(easter), name: "Wielkanoc" },
    { date: iso(addDays(easter, 1)), name: "Poniedziałek Wielkanocny" },
    { date: isoDate(year, 5, 1), name: "Święto Pracy" },
    { date: isoDate(year, 5, 3), name: "Święto Narodowe Trzeciego Maja" },
    { date: iso(addDays(easter, 49)), name: "Zielone Świątki" },
    { date: iso(addDays(easter, 60)), name: "Boże Ciało" },
    { date: isoDate(year, 8, 15), name: "Wniebowzięcie Najświętszej Maryi Panny" },
    { date: isoDate(year, 11, 1), name: "Wszystkich Świętych" },
    { date: isoDate(year, 11, 11), name: "Narodowe Święto Niepodległości" },
    { date: isoDate(year, 12, 25), name: "Boże Narodzenie — pierwszy dzień" },
    { date: isoDate(year, 12, 26), name: "Boże Narodzenie — drugi dzień" },
  ];
  if (year >= CHRISTMAS_EVE_FROM_YEAR) {
    out.push({ date: isoDate(year, 12, 24), name: "Wigilia Bożego Narodzenia" });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Wymiar czasu pracy
// ---------------------------------------------------------------------------

/** Wyliczenie jednego miesiąca — z rozbiciem, żeby dało się je pokazać w dymku. */
export interface ComputedMonthNorm {
  month: number;
  /** Wymiar godzin po odjęciu świąt. */
  hours: number;
  /** 40 h × pełne tygodnie + 8 h × dni robocze wystające — przed świętami. */
  baseHours: number;
  fullWeeks: number;
  /** Dni od poniedziałku do piątku z ostatniego, niepełnego tygodnia. */
  extraWorkdays: number;
  /** Daty świąt, które OBNIŻYŁY wymiar (czyli te poza niedzielą). */
  reducingHolidays: string[];
}

/** Godziny dobowej normy — stałe z art. 129 § 1 k.p. */
const WEEK_HOURS = 40;
const DAY_HOURS = 8;

/** Liczba dni miesiąca (miesiąc 1–12). */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Wymiar czasu pracy dla dwunastu miesięcy roku.
 *
 * `holidays` to CAŁA lista dni ustawowo wolnych, jaką ma obowiązywać — funkcja
 * nie dokłada nic od siebie i nie sprawdza, czy data należy do `year`
 * (wpisy z innych lat po prostu nie trafią do żadnego miesiąca). Duplikaty
 * tej samej daty liczą się raz, bo lista idzie przez zbiór.
 */
export function computeWorkNorms(
  year: number,
  holidays: HolidayInput[],
): ComputedMonthNorm[] {
  const dates = new Set(holidays.map((h) => h.date));
  const out: ComputedMonthNorm[] = [];
  for (let month = 1; month <= 12; month++) {
    const days = daysInMonth(year, month);
    const fullWeeks = Math.floor(days / 7);
    const restDays = days % 7;
    let extraWorkdays = 0;
    for (let d = days - restDays + 1; d <= days; d++) {
      const dow = dayOfWeek(isoDate(year, month, d));
      if (dow >= 1 && dow <= 5) extraWorkdays++;
    }
    const baseHours = WEEK_HOURS * fullWeeks + DAY_HOURS * extraWorkdays;
    const reducingHolidays: string[] = [];
    for (let d = 1; d <= days; d++) {
      const date = isoDate(year, month, d);
      // Niedziela i tak jest dniem wolnym — święto, które w nią wypada, nie
      // obniża wymiaru (art. 130 § 2 k.p.). Sobota obniża.
      if (dates.has(date) && dayOfWeek(date) !== 0) reducingHolidays.push(date);
    }
    out.push({
      month,
      baseHours,
      hours: baseHours - DAY_HOURS * reducingHolidays.length,
      fullWeeks,
      extraWorkdays,
      reducingHolidays,
    });
  }
  return out;
}
