/**
 * Stan planera trasy w localStorage.
 *
 * Plan celowo NIE trafia do bazy: jest roboczy i „na nic nie wpływa”, więc trzymanie go
 * obok kalendarza groziłoby pomyleniem propozycji z uzgodnionym terminem. Cena tej decyzji
 * jest realna i trzeba ją komunikować w UI: plan widzi tylko ta przeglądarka, znika po
 * wyczyszczeniu danych witryny i nie wędruje między urządzeniami.
 *
 * Konwencja zapisu (ciche try/catch, tryb prywatny) jest ta sama co przy `alfa.calendar.view`
 * w Calendar.tsx. Wersja w kluczu zamiast migracji: zmiana kształtu = nowy klucz.
 */
import type { LockState, Vehicle } from "@/lib/route-plan";

const KEY = "alfa.calendar.routePlan.v1";

/** Po tylu dniach plan przeszły przestaje mieć wartość — dzień się odbył. */
const KEEP_DAYS = 60;
/** Twardy limit wpisów, gdyby ktoś planował daleko w przyszłość. */
const MAX_DAYS = 120;

export interface StoredDayPlan {
  /** "YYYY-MM-DD" ostatniej zmiany — po tym przycinamy. */
  updatedAt: string;
  vehicles: Vehicle[];
  /** eventId → vehicleId (ręczne przypięcia). */
  pins: Record<string, string>;
  /** eventId → kłódka nadpisana ręcznie (brak = domyślna ze statusu). */
  locks: Record<string, LockState>;
  /** vehicleId → eventId[] — warstwa „ręczna”. */
  manualOrder: Record<string, number[]>;
  /** vehicleId → eventId[] — zastosowana optymalizacja. */
  optimizedOrder: Record<string, number[]>;
  /** vehicleId → "HH:MM" — wymuszona godzina wyjazdu. */
  depart: Record<string, string>;
  objective: "km" | "time";
  /**
   * Ręczne ramy dnia ("HH:MM"). null = automatyczne (szerokie domyślne + rozszerzenie
   * do kotwic). Trasy po 300 km w jedną stronę nie mieszczą się w zwykłych godzinach pracy,
   * więc to musi być regulowane, a nie zaszyte.
   */
  dayWindow: { from: string; to: string } | null;
  /** Czy wydarzenia wykonane mają zostać na trasie (domyślnie tak — ekipa tam była). */
  includeDone: boolean;
}

export interface StoredRoutePlans {
  /** „Lepkie” samochody między dniami — nazwy, kolory, domyślne załogi. */
  defaults: Vehicle[];
  days: Record<string, StoredDayPlan>;
}

export function emptyDayPlan(vehicles: Vehicle[]): StoredDayPlan {
  return {
    updatedAt: new Date().toISOString().slice(0, 10),
    vehicles,
    pins: {},
    locks: {},
    manualOrder: {},
    optimizedOrder: {},
    depart: {},
    objective: "km",
    dayWindow: null,
    includeDone: true,
  };
}

function readAll(): StoredRoutePlans {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { defaults: [], days: {} };
    const parsed = JSON.parse(raw) as Partial<StoredRoutePlans>;
    return {
      defaults: Array.isArray(parsed.defaults) ? parsed.defaults : [],
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
    };
  } catch {
    // Uszkodzony JSON traktujemy jak brak planu — lepiej zacząć od zera niż wysypać widok.
    return { defaults: [], days: {} };
  }
}

function writeAll(value: StoredRoutePlans): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* prywatny tryb / brak miejsca — plan jest roboczy, więc cicho odpuszczamy */
  }
}

/** Usuwa plany starsze niż KEEP_DAYS, a potem docina do MAX_DAYS najświeższych. */
function prune(days: Record<string, StoredDayPlan>): Record<string, StoredDayPlan> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let entries = Object.entries(days).filter(([date]) => date >= cutoffStr);
  if (entries.length > MAX_DAYS) {
    entries = entries
      .sort((a, b) => (b[1].updatedAt ?? "").localeCompare(a[1].updatedAt ?? ""))
      .slice(0, MAX_DAYS);
  }
  return Object.fromEntries(entries);
}

export function readPlan(date: string): StoredDayPlan | null {
  return readAll().days[date] ?? null;
}

export function writePlan(date: string, plan: StoredDayPlan): void {
  const all = readAll();
  all.days[date] = { ...plan, updatedAt: new Date().toISOString().slice(0, 10) };
  all.days = prune(all.days);
  writeAll(all);
}

export function readDefaults(): Vehicle[] {
  return readAll().defaults;
}

export function writeDefaults(vehicles: Vehicle[]): void {
  const all = readAll();
  all.defaults = vehicles;
  writeAll(all);
}
