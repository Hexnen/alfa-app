import type { TechnikJob } from "@/lib/api";
import { EVENT_TYPE_META } from "@/lib/calendar-labels";
import { jobStateOf } from "../lib/jobs";
import { formatDayShort, timeOf, todayIso } from "../lib/dates";

/**
 * PINEZKI MAPY — grupowanie zleceń po miejscu i kolory typów.
 *
 * Zlecenia stoją w obiektach, a w jednym obiekcie potrafi być kilka zleceń
 * w tym samym tygodniu. Dwie pinezki na tych samych współrzędnych nakładają się
 * co do piksela, więc miejsce = JEDNA pinezka z licznikiem („×3”).
 */

/** Zakres zakładki: dziś albo dwa tygodnie do przodu. */
export type MapRange = "dzis" | "14";

export interface JobPin {
  /** Klucz grupy = zaokrąglone współrzędne (patrz `keyOf`). */
  key: string;
  lat: number;
  lng: number;
  /** Zlecenia w tym miejscu, rosnąco po terminie. Zawsze ≥ 1. */
  jobs: TechnikJob[];
}

/**
 * Pięć miejsc po przecinku to ~1 m — dwa zlecenia w tym samym obiekcie mają
 * współrzędne z tej samej kolumny w bazie, więc i tak są identyczne; dłuższe
 * porównanie tekstowe tylko psułoby się na „-0”.
 */
function keyOf(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Ma współrzędne = da się postawić na mapie. */
export function hasLocation(job: TechnikJob): boolean {
  return typeof job.lat === "number" && typeof job.lng === "number";
}

/** Zlecenia → pinezki (miejsca), rosnąco po pierwszym terminie w miejscu. */
export function pinsOf(jobs: TechnikJob[]): JobPin[] {
  const byPlace = new Map<string, JobPin>();
  for (const job of jobs) {
    if (!hasLocation(job)) continue;
    const lat = job.lat as number;
    const lng = job.lng as number;
    const key = keyOf(lat, lng);
    const pin = byPlace.get(key);
    if (pin) pin.jobs.push(job);
    else byPlace.set(key, { key, lat, lng, jobs: [job] });
  }
  for (const pin of byPlace.values()) pin.jobs.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return [...byPlace.values()].sort((a, b) => a.jobs[0].startAt.localeCompare(b.jobs[0].startAt));
}

/** Zlecenia bez pinezki — pokazuje je chip „N bez lokalizacji”, nie mapa. */
export function withoutLocation(jobs: TechnikJob[]): TechnikJob[] {
  return jobs.filter((j) => !hasLocation(j));
}

/**
 * Druga linijka etykiety: w trybie „Dziś” sama godzina (dzień jest jeden),
 * w „14 dni” dzień przed godziną — inaczej „09:00” na czterech pinezkach
 * znaczyłoby cztery różne dni.
 */
export function pinTimeLabel(job: TechnikJob, range: MapRange, today = todayIso()): string {
  const clock = job.allDay ? "cały dzień" : timeOf(job.startAt) || "—";
  if (range === "dzis") return clock;
  const day = job.startAt.slice(0, 10);
  return day === today ? clock : `${formatDayShort(day)} ${clock}`;
}

/** Nazwa miejsca na etykiecie i w nagłówku dolnej karty. */
export function pinTitle(job: TechnikJob): string {
  return job.objectName || job.title;
}

/**
 * Kolor typu. Najpierw zmienna `--cal-<typ>` (gdyby arkusz kalendarza był
 * załadowany), a gdy jej nie ma — ten sam odcień co pasek karty zlecenia
 * (`EVENT_TYPE_UI[...].bar`, paleta Tailwind 500). Panel technika NIE ładuje
 * `Calendar.css`, więc w praktyce działa fallback i pinezka ma dokładnie kolor
 * paska na liście — o to chodzi, żeby to była jedna mapa kolorów, nie druga.
 */
const TYPE_FALLBACK: Record<string, string> = {
  serwis: "#0ea5e9",
  montaz: "#10b981",
  wizja: "#8b5cf6",
  demontaz: "#f97316",
  biuro: "#64748b",
  przygotowanie: "#f59e0b",
  konserwacja: "#14b8a6",
  urlop: "#f43f5e",
  notatka: "#d97706",
  spotkanie: "#6366f1",
  telefon: "#06b6d4",
  email: "#d946ef",
  zadanie: "#65a30d",
  prezentacja: "#3b82f6",
  termin: "#dc2626",
};

export function typeColor(type: string): string {
  const cssVar = (EVENT_TYPE_META as Record<string, { cssVar?: string } | undefined>)[type]?.cssVar;
  if (cssVar) {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
      if (raw) return `hsl(${raw})`;
    } catch {
      /* SSR / brak stylów — lecimy fallbackiem */
    }
  }
  return TYPE_FALLBACK[type] ?? "#64748b";
}

/**
 * Stan pinezki: `done` przygaszamy, „w toku” dostaje pulsującą obwódkę.
 * Dla miejsca z kilkoma zleceniami liczy się najbardziej „żywe” z nich —
 * jedno trwające zlecenie w obiekcie ma być widać z drugiego końca ekranu.
 */
export function pinState(pin: JobPin): "running" | "done" | "planned" {
  let allDone = true;
  for (const job of pin.jobs) {
    const state = jobStateOf(job);
    if (state === "running") return "running";
    if (state !== "done") allDone = false;
  }
  return allDone ? "done" : "planned";
}

/** Ikona typu jako surowy SVG — Lucide jako komponent nie wejdzie do `divIcon`. */
export function typeIconSvg(type: string): string {
  const path = TYPE_ICON_PATHS[type] ?? TYPE_ICON_PATHS.default;
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/**
 * Ścieżki ikon przepisane z Lucide (tych samych, które niosą chipy typów):
 * `EVENT_TYPE_META[...].icon` to komponent Reacta, a `L.divIcon` przyjmuje
 * wyłącznie HTML. Ikona jest DRUGIM nośnikiem znaczenia obok koloru.
 */
const TYPE_ICON_PATHS: Record<string, string> = {
  // Wrench
  serwis: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
  // HardHat
  montaz: `<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z"/><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><path d="M14 6a6 6 0 0 1 6 6v3"/>`,
  // Eye
  wizja: `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
  // Unplug
  demontaz: `<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>`,
  // CalendarClock
  konserwacja: `<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><circle cx="16" cy="16" r="6"/><path d="M16 14v2l1 1"/>`,
  // ClipboardList
  przygotowanie: `<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>`,
  // Building2 (biuro)
  biuro: `<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>`,
  // MapPin — typy spoza kalendarza technicznego
  default: `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>`,
};

/** Podtytuł dolnej karty: „Serwis · 09:00 · Testowa 1” albo „3 zlecenia · najbliższe pt. 19.09 09:00”. */
export function pinSubtitle(pin: JobPin, today = todayIso()): string {
  const first = pin.jobs[0];
  const day = first.startAt.slice(0, 10);
  const when = first.allDay ? "cały dzień" : timeOf(first.startAt) || "—";
  const stamp = day === today ? when : `${formatDayShort(day)} ${when}`;
  return pin.jobs.length > 1
    ? `${pin.jobs.length} zlecenia · najbliższe ${stamp}`
    : [first.typeLabel, stamp, first.address].filter(Boolean).join(" · ");
}
