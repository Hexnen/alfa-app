/**
 * Generator wystąpień serii cyklicznych kalendarza (czysta funkcja, bez DB).
 *
 * Daty w formacie lokalnym bez strefy: "YYYY-MM-DDTHH:MM" lub "YYYY-MM-DD"
 * (all-day, end EXCLUSIVE). Arytmetyka na kalendarzu "cywilnym" — dodajemy
 * miesiące/tygodnie do składowych daty (bez DST), więc 08:00 zostaje 08:00.
 *
 * Reguły:
 * - freq weekly = +7*interval dni; monthly = +1*interval mies.;
 *   quarterly = +3*interval mies.; semiannual = +6*interval; yearly = +12*interval.
 * - Miesięczne cykle zachowują dzień miesiąca bazowego wystąpienia; gdy nie
 *   istnieje (31 → luty) używamy ostatniego dnia miesiąca.
 * - Koniec: `count` (liczba wystąpień) albo `until` (YYYY-MM-DD, włącznie po
 *   dacie startu wystąpienia). Gdy oba puste → 24 miesiące do przodu od startu.
 * - Twardy limit: MAX_OCCURRENCES wystąpień.
 */
import type { CalendarSeriesFreq } from "../db/schema.js";

export const MAX_OCCURRENCES = 200;
export const DEFAULT_HORIZON_MONTHS = 24;

export interface RecurrenceRule {
  freq: CalendarSeriesFreq;
  interval?: number | null;
  until?: string | null; // YYYY-MM-DD
  count?: number | null;
}

export interface Occurrence {
  startAt: string;
  endAt: string;
}

interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseLocal(s: string): Parts {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) throw new Error(`Nieprawidłowa data: ${s}`);
  return {
    y: +m[1],
    m: +m[2],
    d: +m[3],
    hh: m[4] ? +m[4] : 0,
    mm: m[5] ? +m[5] : 0,
  };
}

export function formatLocal(p: Parts, allDay: boolean): string {
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return allDay ? date : `${date}T${pad(p.hh)}:${pad(p.mm)}`;
}

/** Liczba dni w miesiącu (m = 1-12). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Minuty od epoki (UTC, bez DST) — do liczenia trwania i przesunięć. */
export function toMinutes(p: Parts): number {
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / 60000;
}

export function fromMinutes(min: number): Parts {
  const dt = new Date(min * 60000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
  };
}

/** Przesuwa datę o `minutes` minut (kalendarz cywilny, bez DST). */
export function shiftLocal(s: string, minutes: number, allDay: boolean): string {
  return formatLocal(fromMinutes(toMinutes(parseLocal(s)) + minutes), allDay);
}

/** Różnica w minutach b - a. */
export function diffMinutes(a: string, b: string): number {
  return toMinutes(parseLocal(b)) - toMinutes(parseLocal(a));
}

/** Dodaje `months` miesięcy zachowując dzień `keepDay` (clamp do końca miesiąca). */
function addMonthsKeepDay(base: Parts, months: number, keepDay: number): Parts {
  const total = base.y * 12 + (base.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const d = Math.min(keepDay, daysInMonth(y, m));
  return { ...base, y, m, d };
}

function monthsPerUnit(freq: CalendarSeriesFreq): number {
  switch (freq) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "semiannual":
      return 6;
    case "yearly":
      return 12;
    default:
      return 0;
  }
}

/** Start n-tego wystąpienia (n=0 → bazowe). */
function nthStart(base: Parts, n: number, freq: CalendarSeriesFreq, interval: number): Parts {
  if (freq === "weekly") {
    return fromMinutes(toMinutes(base) + n * interval * 7 * 24 * 60);
  }
  return addMonthsKeepDay(base, n * interval * monthsPerUnit(freq), base.d);
}

/**
 * Rozwija regułę na listę wystąpień (pierwsze = bazowe start/end).
 * Zwraca co najmniej 1 wystąpienie (bazowe), maksymalnie MAX_OCCURRENCES.
 */
export function expandOccurrences(
  start: string,
  end: string,
  allDay: boolean,
  rule: RecurrenceRule
): Occurrence[] {
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  const count = rule.count != null && rule.count > 0 ? Math.floor(rule.count) : null;
  const until = rule.until ? rule.until.slice(0, 10) : null;

  const base = parseLocal(start);
  const duration = diffMinutes(start, end); // trwanie w minutach
  const horizon =
    count == null && until == null
      ? addMonthsKeepDay(base, DEFAULT_HORIZON_MONTHS, base.d)
      : null;

  const out: Occurrence[] = [];
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    if (count != null && n >= count) break;
    const s = nthStart(base, n, rule.freq, interval);
    const sDate = formatLocal(s, true);
    if (until != null && sDate > until) break;
    if (horizon != null && n > 0 && toMinutes(s) >= toMinutes(horizon)) break;
    out.push({
      startAt: formatLocal(s, allDay),
      endAt: formatLocal(fromMinutes(toMinutes(s) + duration), allDay),
    });
  }
  return out;
}

/** Etykieta reguły PL, np. "co 3 miesiące", "co tydzień". */
export function describeRule(rule: RecurrenceRule): string {
  const i = Math.max(1, Math.floor(rule.interval ?? 1));
  switch (rule.freq) {
    case "weekly":
      return i === 1 ? "co tydzień" : `co ${i} tyg.`;
    case "monthly":
      return i === 1 ? "co miesiąc" : `co ${i} mies.`;
    case "quarterly":
      return i === 1 ? "co kwartał" : `co ${i * 3} mies.`;
    case "semiannual":
      return i === 1 ? "co pół roku" : `co ${i * 6} mies.`;
    case "yearly":
      return i === 1 ? "co rok" : `co ${i} lata`;
  }
}
