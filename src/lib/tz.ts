/**
 * Strefa czasowa procesu. Kalendarz/asystent liczą „dzisiaj” i godziny pracy
 * lokalnie (Date#getHours itp.), więc backend MUSI działać w czasie warszawskim
 * niezależnie od hosta (Docker = UTC, a hosting potrafi wstrzyknąć TZ=UTC do env — dlatego
 * nadpisujemy, nie tylko uzupełniamy; inna strefa wyłącznie przez jawne APP_TZ).
 * Importowane jako PIERWSZY moduł w src/index.ts (importy ESM wykonują się przed ciałem
 * modułu — zwykłe przypisanie w index.ts byłoby za późno). Node czyta process.env.TZ
 * przy pierwszym użyciu Date i przy każdej zmianie zmiennej.
 */
export const APP_TZ = process.env.APP_TZ?.trim() || "Europe/Warsaw";
process.env.TZ = APP_TZ;

const pad = (n: number) => String(n).padStart(2, "0");

/** Składowe daty/czasu w strefie APP_TZ (Intl — działa nawet gdy TZ nie zadziałało). */
export function zonedParts(now = new Date()): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const g: Record<string, string> = {};
  for (const p of f.formatToParts(now)) g[p.type] = p.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g.weekday);
  return { y: Number(g.year), m: Number(g.month), d: Number(g.day), hh: Number(g.hour) % 24, mm: Number(g.minute), weekday };
}

/** "YYYY-MM-DD" w strefie aplikacji. */
export function zonedToday(now = new Date()): string {
  const { y, m, d } = zonedParts(now);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "YYYY-MM-DDTHH:MM" w strefie aplikacji. */
export function zonedNow(now = new Date()): string {
  const { hh, mm } = zonedParts(now);
  return `${zonedToday(now)}T${pad(hh)}:${pad(mm)}`;
}
