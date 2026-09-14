/**
 * Daty i godziny panelu technika.
 *
 * Kalendarz alfy trzyma czas jako LOKALNY ISO bez strefy
 * (`"YYYY-MM-DDTHH:MM"`, całodniowe `"YYYY-MM-DD"`), więc dzień i godzinę
 * wycinamy z tekstu. Przepuszczanie tego przez `new Date()` cofałoby lub
 * przesuwało zlecenia o strefę — najgorszy możliwy błąd na ekranie, który ma
 * powiedzieć „o której jestem u klienta”.
 */

/** Dzień lokalny (`YYYY-MM-DD`) z obiektu Date — bez `toISOString()` (UTC). */
export function toLocalDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Dzisiejszy dzień lokalny. */
export function todayIso(): string {
  return toLocalDay(new Date());
}

/** Przesunięcie dnia `YYYY-MM-DD` o `n` dni (bezpieczne na zmianie czasu). */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + n, 12, 0, 0);
  return toLocalDay(dt);
}

/** Dzień (`YYYY-MM-DD`) z lokalnego ISO wydarzenia. */
export function dayOf(isoDateTime: string): string {
  return isoDateTime.slice(0, 10);
}

/**
 * Dzień, pod którym zlecenie ma stać na liście „Nadchodzące”: `max(dzień
 * startu, dziś)`. Wielodniowy montaż z poniedziałku oglądany w środę wpadał
 * inaczej pod nagłówek z przeszłości, choć trwa i jest „przede mną”.
 */
export function upcomingDayOf(startAt: string, today: string): string {
  const day = dayOf(startAt);
  return day < today ? today : day;
}

/** Godzina `HH:MM` z lokalnego ISO; pusty string dla wartości całodniowej. */
export function timeOf(isoDateTime: string | null | undefined): string {
  if (!isoDateTime || isoDateTime.length < 16) return "";
  return isoDateTime.slice(11, 16);
}

/** Ile minut do przodu jeszcze uchodzi za „teraz” (rozjazd zegara tabletu). */
export const FUTURE_TOLERANCE_MIN = 5;

/**
 * Czy lokalny znacznik (`YYYY-MM-DDTHH:MM`) jest z przyszłości — dokładnie ta
 * sama reguła, po której backend odrzuca „Rozpocznij / Zakończ” z 400. Front
 * ma to powiedzieć, ZANIM technik kliknie Zapisz, a nie po okrągłej sekundzie
 * czekania na błąd serwera.
 */
export function isFutureStamp(at: string, now: Date = new Date()): boolean {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return false;
  return t > now.getTime() + FUTURE_TOLERANCE_MIN * 60_000;
}

/** Lokalny ISO kalendarza bez strefy: `YYYY-MM-DDTHH:MM` — wycinamy tekstowo. */
const LOCAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/**
 * Znacznik SQLite `YYYY-MM-DD HH:MM[:SS]` — to UTC bez oznaczenia strefy.
 *
 * Sekundy są OPCJONALNE: `datetime('now')` je daje, ale `strftime('%Y-%m-%d
 * %H:%M', …)` i ręcznie sklejane wartości już nie, a taki znacznik wchodził
 * w `new Date()` jako czas LOKALNY i technik widział godzinę przesuniętą
 * o strefę. Spacja zamiast „T” jest tu jedynym wyróżnikiem formatu, więc
 * decyduje ona, a nie długość napisu.
 */
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

/**
 * Godzina znacznika czasu w strefie urządzenia. Trzy źródła, trzy formaty:
 * lokalny ISO kalendarza (bez przeliczania), `datetime('now')` z SQLite (UTC
 * bez „Z”, więc trzeba je dopisać) i pełny ISO z `toISOString()` (UTC z „Z”).
 * Wycinanie znaków 11–16 z dwóch ostatnich pokazywało technikowi czas UTC —
 * o dwie godziny wcześniejszy niż „Rozpoczęto o …” w treści notatki.
 */
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return "";
  if (LOCAL_ISO_RE.test(iso)) return iso.slice(11, 16);
  const d = new Date(SQLITE_UTC_RE.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Znacznik czasu → `Date` w strefie urządzenia. Te same trzy formaty co
 * w `clockOf`: lokalny ISO kalendarza (bez strefy — `Date` czyta go jako
 * lokalny, i dobrze), `datetime('now')` z SQLite (UTC bez „Z”) i pełny ISO.
 * `null` = nie ma czego parsować.
 */
export function parseStamp(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(SQLITE_UTC_RE.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateFromIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

/** „poniedziałek, 15 września” — pełny tytuł paska dnia. */
export function formatDayTitle(iso: string): string {
  return dateFromIso(iso).toLocaleDateString("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** „poniedziałek” — górna linia paska dnia. */
export function formatWeekday(iso: string): string {
  return dateFromIso(iso).toLocaleDateString("pl-PL", { weekday: "long" });
}

/** „14 września” — dolna linia paska dnia. */
export function formatDayMonth(iso: string): string {
  return dateFromIso(iso).toLocaleDateString("pl-PL", { day: "numeric", month: "long" });
}

/** „pt. 19.09” — nagłówek grupy na liście nadchodzących. */
export function formatDayShort(iso: string): string {
  const d = dateFromIso(iso);
  const weekday = d.toLocaleDateString("pl-PL", { weekday: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${weekday} ${day}.${month}`;
}

/**
 * Nagłówek grupy dni: „Dziś” / „Jutro” / „pt. 19.09”. Dwa pierwsze dni mają
 * nazwy, bo o nich myśli się słowami, a nie datą.
 */
export function groupLabel(iso: string, today = todayIso()): string {
  if (iso === today) return "Dziś";
  if (iso === addDays(today, 1)) return "Jutro";
  return formatDayShort(iso);
}

/** Data w formacie `DD.MM.YYYY` (podpisy protokołu, karty „Co nowego”). */
export function formatDatePl(iso: string | null | undefined): string {
  if (!iso) return "—";
  const day = iso.slice(0, 10);
  const [y, m, d] = day.split("-");
  return y && m && d ? `${d}.${m}.${y}` : day;
}
