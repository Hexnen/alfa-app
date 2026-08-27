/**
 * Generator wolnych terminów (find_free_slots): czysta funkcja `computeFreeSlots` +
 * loader zajętości z bazy. Zajętość = wydarzenia nie-usunięte, nie-anulowane, w tym urlopy
 * (te same warunki co conflictEventIds w src/lib/calendar-queries.ts).
 * Tryb `all` (domyślny): slot jest wolny, gdy WSZYSCY wskazani technicy są wolni w [startAt, endAt).
 * Tryb `any` („dowolny technik”): slot jest wolny, gdy co najmniej jeden technik jest wolny —
 * `technicianIds` slotu zawiera wtedy tylko wolnych.
 */
import { and, asc, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { shiftLocal } from "../calendar-recurrence.js";

export interface BusyInterval {
  startAt: string; // YYYY-MM-DD lub YYYY-MM-DDTHH:MM
  endAt: string; // exclusive
  technicianIds: number[];
}

export interface FreeSlotOptions {
  technicianIds: number[];
  durationHours: number;
  /** YYYY-MM-DD — pierwszy dzień przeszukiwania. */
  from: string;
  horizonDays: number;
  /** HH:MM — najwcześniejszy początek slotu. */
  earliest: string;
  /** HH:MM — najpóźniejszy koniec slotu. */
  latest: string;
  workdaysOnly: boolean;
  limit: number;
  /** Lokalne „teraz” (YYYY-MM-DDTHH:MM) — sloty dziś nie zaczynają się w przeszłości. */
  now?: string;
  /** Krok przeszukiwania w minutach (domyślnie 30). */
  stepMinutes?: number;
  /** `all` — wszyscy technicy wolni (domyślnie); `any` — wystarczy jeden wolny (wynik: lista wolnych). */
  mode?: "all" | "any";
}

export interface FreeSlot {
  startAt: string;
  endAt: string;
  /** Technicy wolni w tym slocie (tryb all: wszyscy wskazani; tryb any: podzbiór). */
  technicianIds: number[];
  weekday: string;
}

/** Polskie nazwy dni tygodnia indeksowane jak Date#getDay() (0 = niedziela). */
export const WEEKDAYS_PL = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const toMins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Dodaje dni do YYYY-MM-DD (arytmetyka kalendarzowa z calendar-recurrence, bez DST). */
export function addDays(date: string, days: number): string {
  return shiftLocal(date, days * 24 * 60, true);
}

/** Dzień tygodnia (0 = niedziela) dla YYYY-MM-DD — niezależnie od strefy procesu. */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const TZ = process.env.TZ || "Europe/Warsaw";

/** Składowe lokalnej daty/czasu w strefie kalendarza (Intl — niezależnie od TZ procesu). */
export function localParts(now = new Date(), timeZone = TZ): { date: string; time: string; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    // Nieznana strefa → czas procesu.
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      weekday: now.getDay(),
    };
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date, time: `${hour}:${get("minute")}`, weekday: weekdayIndex(date) };
}

/** Lokalne „teraz” jako YYYY-MM-DDTHH:MM (strefa kalendarza, nie procesu). */
export function localNow(now = new Date()): string {
  const p = localParts(now);
  return `${p.date}T${p.time}`;
}

/**
 * Czysty generator: dzień po dniu (opcjonalnie tylko pon–pt), w oknie [earliest, latest],
 * krokiem `stepMinutes`; pierwsze wolne okno danego dnia trafia do wyniku (jeden slot
 * na dzień — kolejne propozycje rozkładają się na różne dni, co jest użyteczniejsze
 * niż trzy sąsiednie okna tego samego przedpołudnia). Porównania ISO leksykalne —
 * działają też dla całodniowych ("YYYY-MM-DD" < "YYYY-MM-DDTHH:MM").
 */
export function computeFreeSlots(busy: BusyInterval[], opts: FreeSlotOptions): FreeSlot[] {
  const step = Math.max(5, opts.stepMinutes ?? 30);
  const durMins = Math.round(opts.durationHours * 60);
  const dayStart = toMins(opts.earliest);
  const dayEnd = toMins(opts.latest);
  const techs = new Set(opts.technicianIds);
  const anyMode = opts.mode === "any";
  const relevant = busy.filter((b) => b.technicianIds.some((id) => techs.has(id)));
  const out: FreeSlot[] = [];
  if (durMins <= 0 || dayStart + durMins > dayEnd || techs.size === 0) return out;

  for (let i = 0; i < opts.horizonDays && out.length < opts.limit; i++) {
    const date = addDays(opts.from, i);
    const dow = weekdayIndex(date);
    if (opts.workdaysOnly && (dow === 0 || dow === 6)) continue;
    let first = dayStart;
    if (opts.now && opts.now.slice(0, 10) === date) {
      // Dziś: nie wcześniej niż teraz, zaokrąglone w górę do kroku.
      const nowMins = toMins(opts.now.slice(11, 16));
      first = Math.max(first, Math.ceil(nowMins / step) * step);
    } else if (opts.now && date < opts.now.slice(0, 10)) {
      continue;
    }
    for (let s = first; s + durMins <= dayEnd; s += step) {
      const startAt = `${date}T${hhmm(s)}`;
      const endAt = `${date}T${hhmm(s + durMins)}`;
      const clashes = relevant.filter((b) => b.startAt < endAt && b.endAt > startAt);
      if (clashes.length === 0) {
        out.push({ startAt, endAt, technicianIds: [...techs], weekday: WEEKDAYS_PL[dow] });
        break;
      }
      if (anyMode) {
        const busyIds = new Set(clashes.flatMap((b) => b.technicianIds));
        const free = [...techs].filter((id) => !busyIds.has(id));
        if (free.length > 0) {
          out.push({ startAt, endAt, technicianIds: free, weekday: WEEKDAYS_PL[dow] });
          break;
        }
        // Wszyscy zajęci — przeskocz za najwcześniejszy koniec kolizji (zwalnia się pierwszy technik).
        const earliestEnd = clashes.map((b) => b.endAt).sort()[0];
        if (earliestEnd.slice(0, 10) === date && earliestEnd.length > 10) {
          const aligned = Math.ceil(toMins(earliestEnd.slice(11, 16)) / step) * step;
          if (aligned > s) s = aligned - step;
        } else {
          break; // ktoś zajęty całodniowo, reszta też koliduje — dzień zajęty
        }
        continue;
      }
      // Tryb all: przeskocz za koniec najdłuższej kolizji (wyrównane do kroku).
      const clash = clashes.reduce((a, b) => (a.endAt >= b.endAt ? a : b));
      if (clash.endAt.slice(0, 10) === date && clash.endAt.length > 10) {
        const endMins = toMins(clash.endAt.slice(11, 16));
        const aligned = Math.ceil(endMins / step) * step;
        if (aligned > s) s = aligned - step;
      } else {
        break; // kolizja całodniowa / do kolejnego dnia — ten dzień jest zajęty
      }
    }
  }
  return out;
}

/** Wydarzenie bez przypisanego technika (nieprzydzielona praca firmy) — skrót dla narzędzi dostępności. */
export interface UnassignedEvent {
  id: number;
  type: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  objectName: string | null;
  location: string | null;
}

/**
 * Wydarzenia BEZ przypisanych techników nachodzące na [from, to) (bez usuniętych/anulowanych/urlopów).
 * find_free_slots i check_conflicts liczą tylko przypisanych — takie wydarzenia to praca firmy,
 * której nikt jeszcze nie wziął; model ma o nich powiedzieć przy pytaniu o dostępność.
 */
export function loadUnassignedEvents(from: string, to: string, limit = 20): UnassignedEvent[] {
  return db
    .select({
      id: schema.calendarEvents.id,
      type: schema.calendarEvents.type,
      title: schema.calendarEvents.title,
      startAt: schema.calendarEvents.startAt,
      endAt: schema.calendarEvents.endAt,
      allDay: schema.calendarEvents.allDay,
      status: schema.calendarEvents.status,
      objectName: schema.objects.name,
      location: schema.calendarEvents.location,
    })
    .from(schema.calendarEvents)
    .leftJoin(schema.objects, sql`${schema.objects.id} = ${schema.calendarEvents.objectId}`)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        ne(schema.calendarEvents.type, "urlop"),
        lt(schema.calendarEvents.startAt, to),
        gt(schema.calendarEvents.endAt, from),
        sql`NOT EXISTS (SELECT 1 FROM calendar_event_assignees a WHERE a.event_id = ${schema.calendarEvents.id})`
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, title: r.title.replace(/\s+/g, " ").trim().slice(0, 120), objectName: r.objectName ?? null }));
}

/** Zajętość techników w zakresie [from, to) — wydarzenia i urlopy (bez usuniętych/anulowanych). */
export function loadBusyIntervals(technicianIds: number[], from: string, to: string): BusyInterval[] {
  if (technicianIds.length === 0) return [];
  const rows = db
    .select({
      id: schema.calendarEvents.id,
      startAt: schema.calendarEvents.startAt,
      endAt: schema.calendarEvents.endAt,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled"),
        lt(schema.calendarEvents.startAt, to),
        gt(schema.calendarEvents.endAt, from),
        sql`${schema.calendarEvents.id} IN (SELECT event_id FROM calendar_event_assignees WHERE technician_id IN (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)}))`
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(2000)
    .all();
  if (rows.length === 0) return [];
  const assignees = db
    .select({ eventId: schema.calendarEventAssignees.eventId, technicianId: schema.calendarEventAssignees.technicianId })
    .from(schema.calendarEventAssignees)
    .where(sql`${schema.calendarEventAssignees.eventId} IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`)
    .all();
  const byEvent = new Map<number, number[]>();
  for (const a of assignees) byEvent.set(a.eventId, [...(byEvent.get(a.eventId) ?? []), a.technicianId]);
  return rows.map((r) => ({ startAt: r.startAt, endAt: r.endAt, technicianIds: byEvent.get(r.id) ?? [] }));
}
