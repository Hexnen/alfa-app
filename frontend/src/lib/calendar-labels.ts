import {
  ArrowRightLeft,
  Building2,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  Eye,
  HardHat,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  TreePalm,
  Undo2,
  Unplug,
  UserMinus,
  UserPlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  ActivityEntry,
  CalendarEventStatus,
  CalendarEventType,
  CalendarSeriesFreq,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Metadane typów wydarzeń: etykieta PL, ikona Lucide (nie polegamy tylko na
 * kolorze), klasy Tailwind dla chipów/badge'y oraz zmienna CSS `--cal-<typ>`
 * wykorzystywana w stylach FullCalendar (Calendar.css).
 */
export interface EventTypeMeta {
  label: string;
  icon: LucideIcon;
  /** Chip filtra / badge w liście. */
  chip: string;
  /** Aktywny chip filtra (wypełniony). */
  chipActive: string;
  /** Zmienna CSS z kolorem bazowym (patrz Calendar.css). */
  cssVar: string;
}

export const EVENT_TYPE_ORDER: CalendarEventType[] = [
  "serwis",
  "montaz",
  "wizja",
  "demontaz",
  "konserwacja",
  "przygotowanie",
  "biuro",
  "urlop",
];

export const EVENT_TYPE_META: Record<CalendarEventType, EventTypeMeta> = {
  serwis: {
    label: "Serwis",
    icon: Wrench,
    chip: "border-sky-500/50 text-sky-700 dark:text-sky-300",
    chipActive: "bg-sky-500 border-sky-500 text-white",
    cssVar: "--cal-serwis",
  },
  montaz: {
    label: "Montaż",
    icon: HardHat,
    chip: "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
    chipActive: "bg-emerald-500 border-emerald-500 text-white",
    cssVar: "--cal-montaz",
  },
  wizja: {
    label: "Wizja lokalna",
    icon: Eye,
    chip: "border-violet-500/50 text-violet-700 dark:text-violet-300",
    chipActive: "bg-violet-500 border-violet-500 text-white",
    cssVar: "--cal-wizja",
  },
  demontaz: {
    label: "Demontaż",
    icon: Unplug,
    chip: "border-orange-500/50 text-orange-700 dark:text-orange-300",
    chipActive: "bg-orange-500 border-orange-500 text-white",
    cssVar: "--cal-demontaz",
  },
  biuro: {
    label: "Biuro",
    icon: Building2,
    chip: "border-slate-400/60 text-slate-600 dark:text-slate-300",
    chipActive: "bg-slate-500 border-slate-500 text-white",
    cssVar: "--cal-biuro",
  },
  przygotowanie: {
    label: "Przygotowanie",
    icon: ClipboardList,
    chip: "border-amber-500/50 text-amber-700 dark:text-amber-300",
    chipActive: "bg-amber-500 border-amber-500 text-white",
    cssVar: "--cal-przygotowanie",
  },
  konserwacja: {
    label: "Konserwacja",
    icon: CalendarClock,
    chip: "border-teal-500/50 text-teal-700 dark:text-teal-300",
    chipActive: "bg-teal-500 border-teal-500 text-white",
    cssVar: "--cal-konserwacja",
  },
  urlop: {
    label: "Urlop",
    icon: TreePalm,
    chip: "border-rose-500/50 text-rose-700 dark:text-rose-300",
    chipActive: "bg-rose-500 border-rose-500 text-white",
    cssVar: "--cal-urlop",
  },
};

export const eventTypeLabel = (t: string): string =>
  (EVENT_TYPE_META as Record<string, EventTypeMeta>)[t]?.label ?? t;

export const EVENT_STATUS_ORDER: CalendarEventStatus[] = [
  "planned",
  "confirmed",
  "done",
  "cancelled",
];

export const EVENT_STATUS_META: Record<
  CalendarEventStatus,
  { label: string; badge: string; /** Krótki opis do legendy. */ hint: string }
> = {
  planned: {
    label: "Zaplanowane",
    badge: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    hint: "termin wstępny — czeka na potwierdzenie",
  },
  confirmed: {
    label: "Potwierdzone",
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    hint: "termin uzgodniony z klientem i ekipą",
  },
  done: {
    label: "Wykonane",
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-500/25 dark:text-slate-200",
    hint: "zakończone — wyszarzone, ze znacznikiem ✓",
  },
  cancelled: {
    label: "Anulowane",
    badge: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    hint: "odwołane — przekreślone, przerywana ramka",
  },
};

/** Warianty ciemne badge'y statusu — już zawarte w EVENT_STATUS_META.badge; zostawione dla zgodności. */
export const STATUS_BADGE_DARK: Record<CalendarEventStatus, string> = {
  planned: "dark:bg-sky-500/20 dark:text-sky-200",
  confirmed: "dark:bg-emerald-500/20 dark:text-emerald-200",
  done: "dark:bg-slate-500/25 dark:text-slate-200",
  cancelled: "dark:bg-red-500/20 dark:text-red-200",
};

/** Pełna klasa badge'a statusu (pigułka + kolory jasne/ciemne). */
export function statusBadgeClass(s: CalendarEventStatus): string {
  return cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", EVENT_STATUS_META[s]?.badge);
}

/** Kolory typów jako klasy Tailwind — do pasków/ikon poza Calendar.css (dialog, karta obiektu). */
export const EVENT_TYPE_UI: Record<CalendarEventType, { bar: string; soft: string; dot: string }> = {
  serwis: { bar: "bg-sky-500", soft: "bg-sky-500/15 text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
  montaz: { bar: "bg-emerald-500", soft: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  wizja: { bar: "bg-violet-500", soft: "bg-violet-500/15 text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  demontaz: { bar: "bg-orange-500", soft: "bg-orange-500/15 text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
  biuro: { bar: "bg-slate-500", soft: "bg-slate-500/15 text-slate-700 dark:text-slate-300", dot: "bg-slate-500" },
  przygotowanie: { bar: "bg-amber-500", soft: "bg-amber-500/15 text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  konserwacja: { bar: "bg-teal-500", soft: "bg-teal-500/15 text-teal-700 dark:text-teal-300", dot: "bg-teal-500" },
  urlop: { bar: "bg-rose-500", soft: "bg-rose-500/15 text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
};

export const eventStatusLabel = (s: string): string =>
  (EVENT_STATUS_META as Record<string, { label: string }>)[s]?.label ?? s;

// ---------------------------------------------------------------------------
// Serie (cykliczne konserwacje)
// ---------------------------------------------------------------------------

export const SERIES_FREQ_META: Record<
  CalendarSeriesFreq,
  { label: string; unitSingular: string; unitPlural: string; months: number }
> = {
  weekly: { label: "Co tydzień", unitSingular: "tydz.", unitPlural: "tyg.", months: 0 },
  monthly: { label: "Co miesiąc", unitSingular: "mies.", unitPlural: "mies.", months: 1 },
  quarterly: { label: "Co kwartał", unitSingular: "kwartał", unitPlural: "kwartały", months: 3 },
  semiannual: { label: "Co pół roku", unitSingular: "pół roku", unitPlural: "półrocza", months: 6 },
  yearly: { label: "Co rok", unitSingular: "rok", unitPlural: "lata", months: 12 },
};

/** "co 3 mies." / "co tydzień" / "co 2 lata" — krótko na badge. */
export function seriesShortLabel(freq: CalendarSeriesFreq, interval = 1): string {
  const m = SERIES_FREQ_META[freq];
  if (!m) return freq;
  if (interval <= 1) return m.label.toLowerCase();
  // Interwał > 1: przeliczamy na miesiące (czytelniej "co 6 mies." niż "co 2 kwartały").
  if (m.months > 0) return `co ${m.months * interval} mies.`;
  return `co ${interval} ${m.unitPlural}`;
}

// ---------------------------------------------------------------------------
// Daty (format "YYYY-MM-DDTHH:MM" lokalny, bez strefy)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Date → "YYYY-MM-DD" (czas lokalny). */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date → "YYYY-MM-DDTHH:MM" (czas lokalny). */
export function toDateTimeStr(d: Date): string {
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DD[THH:MM]" → Date lokalny (bez przesunięcia strefy). */
export function parseLocal(v: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (!m) return new Date(v);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0
  );
}

/** "12.09 08:00" — krótki format do zdań w historii. */
export function fmtShort(v: string | null | undefined, allDay = false): string {
  if (!v) return "—";
  const d = parseLocal(v);
  if (Number.isNaN(d.getTime())) return v;
  const dd = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(v)) return dd;
  return `${dd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "12.09.2026 08:00" / "12.09.2026". */
export function fmtLong(v: string | null | undefined, allDay = false): string {
  if (!v) return "—";
  const d = parseLocal(v);
  if (Number.isNaN(d.getTime())) return v;
  const dd = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(v)) return dd;
  return `${dd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format SQLite "YYYY-MM-DD HH:MM:SS" — UTC bez znacznika strefy. */
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Parsuje znacznik czasu z API (SQLite UTC "YYYY-MM-DD HH:MM:SS" lub ISO). */
export function parseTimestamp(v: string): Date {
  return new Date(SQLITE_UTC_RE.test(v) ? `${v.replace(" ", "T")}Z` : v);
}

const MONTHS_GEN = [
  "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
  "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
];

/** Klucz dnia "YYYY-MM-DD" (lokalnie) dla znacznika czasu z API. */
export function timestampDayKey(v: string): string {
  const d = parseTimestamp(v);
  return Number.isNaN(d.getTime()) ? v : toDateStr(d);
}

/** Nagłówek dnia w feedzie: "Dziś", "Wczoraj", "24 sierpnia 2026". */
export function fmtDayHeading(dayKey: string, now = new Date()): string {
  if (dayKey === toDateStr(now)) return "Dziś";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey === toDateStr(y)) return "Wczoraj";
  const d = parseLocal(dayKey);
  if (Number.isNaN(d.getTime())) return dayKey;
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

/** Czas relatywny PL: „przed chwilą”, „5 min temu”, „wczoraj 14:32”, „12.03.2026”. */
export function fmtRelative(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "—";
  const d = parseTimestamp(v);
  if (Number.isNaN(d.getTime())) return v;
  const diff = now - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "przed chwilą";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min temu`;
  const hrs = Math.round(min / 60);
  if (hrs < 6) return `${hrs} godz. temu`;
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `dziś ${hhmm}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `wczoraj ${hhmm}`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days} dni temu`;
  return fmtTimestamp(v).slice(0, 10);
}

/** Czas trwania „2 godz.”, „1 godz. 30 min”, „3 dni”. */
export function fmtDuration(startAt: string, endAt: string, allDay: boolean): string {
  const s = parseLocal(startAt).getTime();
  const e = parseLocal(endAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return "";
  if (allDay) {
    const days = Math.round((e - s) / 86_400_000);
    return days === 1 ? "1 dzień" : `${days} dni`;
  }
  const mins = Math.round((e - s) / 60_000);
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  const parts: string[] = [];
  if (days) parts.push(days === 1 ? "1 dzień" : `${days} dni`);
  if (hrs) parts.push(`${hrs} godz.`);
  if (rest) parts.push(`${rest} min`);
  return parts.join(" ");
}

/** Znacznik czasu z activity_log (UTC z SQLite) → "25.08.2026 14:32" lokalnie. */
export function fmtTimestamp(v: string | null | undefined): string {
  if (!v) return "—";
  const d = parseTimestamp(v);
  if (Number.isNaN(d.getTime())) return v;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** Zakres "12.09.2026 08:00 – 10:00" / "12.09.2026 – 14.09.2026" (all-day: end exclusive). */
export function fmtRange(startAt: string, endAt: string, allDay: boolean): string {
  if (allDay) {
    const s = parseLocal(startAt);
    const e = parseLocal(endAt);
    e.setDate(e.getDate() - 1); // koniec exclusive → ostatni dzień
    const ss = fmtLong(toDateStr(s), true);
    const ee = fmtLong(toDateStr(e), true);
    return ss === ee ? ss : `${ss} – ${ee}`;
  }
  const s = parseLocal(startAt);
  const e = parseLocal(endAt);
  if (toDateStr(s) === toDateStr(e)) {
    return `${fmtLong(startAt)} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
  }
  return `${fmtLong(startAt)} – ${fmtLong(endAt)}`;
}

// ---------------------------------------------------------------------------
// Activity log — etykiety i czytelne zdania
// ---------------------------------------------------------------------------

/** Ikona + czasownik (spójny w feedzie) + kolor ikony per akcja. */
export const ACTIVITY_ACTION_META: Record<string, { icon: LucideIcon; verb: string; tone: string }> = {
  created: { icon: Plus, verb: "Utworzył(a)", tone: "text-emerald-600 dark:text-emerald-400" },
  updated: { icon: Pencil, verb: "Zmienił(a)", tone: "text-sky-600 dark:text-sky-400" },
  deleted: { icon: Trash2, verb: "Usunął(-ęła)", tone: "text-red-600 dark:text-red-400" },
  restored: { icon: Undo2, verb: "Przywrócił(a)", tone: "text-emerald-600 dark:text-emerald-400" },
  moved: { icon: ArrowRightLeft, verb: "Przesunął(-ęła)", tone: "text-amber-600 dark:text-amber-400" },
  assigned: { icon: UserPlus, verb: "Przypisał(a)", tone: "text-sky-600 dark:text-sky-400" },
  unassigned: { icon: UserMinus, verb: "Odpisał(a)", tone: "text-slate-500 dark:text-slate-400" },
  status_changed: { icon: CalendarCheck, verb: "Zmienił(a) status", tone: "text-violet-600 dark:text-violet-400" },
  note_added: { icon: StickyNote, verb: "Dodał(a) notatkę", tone: "text-amber-600 dark:text-amber-400" },
  note_updated: { icon: StickyNote, verb: "Zmienił(a) notatkę", tone: "text-amber-600 dark:text-amber-400" },
  note_deleted: { icon: StickyNote, verb: "Usunął(-ęła) notatkę", tone: "text-slate-500 dark:text-slate-400" },
};

/** Opcje filtra akcji w panelu Aktywność. */
export const ACTIVITY_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "created", label: "Utworzenia" },
  { value: "updated", label: "Zmiany pól" },
  { value: "moved", label: "Przesunięcia" },
  { value: "status_changed", label: "Statusy" },
  { value: "assigned", label: "Przypisania" },
  { value: "deleted", label: "Usunięcia" },
  { value: "restored", label: "Przywrócenia" },
  { value: "note_added", label: "Notatki" },
];

/** Ikona akcji feedu (fallback: ołówek). */
export const activityIcon = (action: string): LucideIcon => ACTIVITY_ACTION_META[action]?.icon ?? Pencil;

export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  created: "utworzył(a)",
  updated: "zmienił(a)",
  deleted: "usunął(-ęła)",
  restored: "przywrócił(a)",
  moved: "przesunął(-ęła)",
  assigned: "przypisał(a) technika",
  unassigned: "odpisał(a) technika",
  status_changed: "zmienił(a) status",
  note_added: "dodał(a) notatkę",
  note_updated: "zmienił(a) notatkę",
  note_deleted: "usunął(-ęła) notatkę",
};

const NOTE_ACTIONS = new Set(["note_added", "note_updated", "note_deleted"]);
export const isNoteActivity = (action: string): boolean => NOTE_ACTIONS.has(action);

/**
 * Treść notatki z wpisu activity_log (backend: summary = „Dodano notatkę: …” / „Zmieniono …” / „Usunięto …”,
 * opcjonalnie z sufiksem „(przez asystenta)”) → { text, via }.
 */
export function noteActivityParts(entry: ActivityEntry): { text: string; via: string | null } {
  let s = (entry.summary ?? entry.newValue ?? entry.oldValue ?? "").replace(/^(Dodano|Zmieniono|Usunięto)\s+notatkę:\s*/i, "").trim();
  let via: string | null = null;
  const m = /\s*\((przez [^)]+)\)\s*$/i.exec(s);
  if (m) {
    via = m[1];
    s = s.slice(0, m.index).trim();
  }
  return { text: s, via };
}
export const noteActivityText = (entry: ActivityEntry): string => noteActivityParts(entry).text;

/** Etykiety pól logowanych przez backend (diff per pole). */
export const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  title: "tytuł",
  type: "typ",
  start_at: "początek",
  end_at: "koniec",
  startAt: "początek",
  endAt: "koniec",
  all_day: "cały dzień",
  allDay: "cały dzień",
  status: "status",
  location: "lokalizację",
  description: "opis",
  object_id: "obiekt",
  objectId: "obiekt",
  order_id: "zlecenie",
  orderId: "zlecenie",
  realization_id: "realizację",
  realizationId: "realizację",
};

const quote = (v: string | null) => (v == null || v === "" ? "(puste)" : `„${v}”`);

/** Wartości pól przekładamy na etykiety PL, gdzie to możliwe. */
function fieldValue(field: string | null, v: string | null): string {
  if (v == null || v === "") return "(puste)";
  switch (field) {
    case "type":
      return eventTypeLabel(v);
    case "status":
      return eventStatusLabel(v);
    case "start_at":
    case "startAt":
    case "end_at":
    case "endAt":
      return fmtShort(v);
    case "all_day":
    case "allDay":
      return v === "1" || v === "true" ? "tak" : "nie";
    default:
      return quote(v);
  }
}

/**
 * Czytelne zdanie PL z wpisu activity_log, np.
 * „Jan Kowalski przesunął z 12.09 08:00 na 14.09 08:00”.
 * Gdy backend dostarczył `summary`, jest preferowane (ma pełniejszy kontekst).
 */
export function describeActivity(entry: ActivityEntry): string {
  const who = entry.userLabel || "System";
  if (isNoteActivity(entry.action)) {
    const { text: t, via } = noteActivityParts(entry);
    return `${who} ${ACTIVITY_ACTION_LABELS[entry.action]}${via ? ` (${via})` : ""}${t ? `: „${t}”` : ""}`;
  }
  if (entry.summary) return `${who} — ${entry.summary}`;
  const a = entry.action;
  switch (a) {
    case "created":
      return `${who} utworzył(a) wydarzenie`;
    case "deleted":
      return `${who} usunął(-ęła) wydarzenie`;
    case "restored":
      return `${who} przywrócił(a) wydarzenie`;
    case "moved": {
      if (entry.oldValue || entry.newValue) {
        return `${who} przesunął(-ęła) z ${fmtShort(entry.oldValue)} na ${fmtShort(entry.newValue)}`;
      }
      return `${who} przesunął(-ęła) wydarzenie`;
    }
    case "assigned":
      return `${who} przypisał(a) technika ${entry.newValue ?? ""}`.trim();
    case "unassigned":
      return `${who} odpisał(a) technika ${entry.oldValue ?? ""}`.trim();
    case "status_changed":
      return `${who} zmienił(a) status z ${eventStatusLabel(entry.oldValue ?? "")} na ${eventStatusLabel(entry.newValue ?? "")}`;
    case "updated": {
      const f = entry.field ? ACTIVITY_FIELD_LABELS[entry.field] ?? entry.field : null;
      if (f) {
        return `${who} zmienił(a) ${f}: ${fieldValue(entry.field, entry.oldValue)} → ${fieldValue(entry.field, entry.newValue)}`;
      }
      return `${who} zmienił(a) wydarzenie`;
    }
    default:
      return `${who} ${ACTIVITY_ACTION_LABELS[a] ?? a}`;
  }
}

/**
 * Wpis feedu w formacie „Aktor · Czasownik · zmiana (pole: stare → nowe)”.
 * Tytuł wydarzenia rodzic pokazuje osobno, więc nie powtarzamy go w `detail`
 * (backendowe `summary` dla created/deleted/restored zawiera tytuł).
 */
export function activityParts(entry: ActivityEntry): {
  who: string;
  verb: string;
  detail: string | null;
} {
  const who = entry.userLabel || "System";
  const a = entry.action;
  const verb = ACTIVITY_ACTION_META[a]?.verb ?? ACTIVITY_ACTION_LABELS[a] ?? a;
  if (isNoteActivity(a)) {
    const { text: t, via } = noteActivityParts(entry);
    return { who, verb: via ? `${verb} (${via})` : verb, detail: t ? `„${t}”` : null };
  }
  switch (a) {
    case "created": {
      const m = entry.summary ? /w ramach serii.*$/.exec(entry.summary) : null;
      return { who, verb, detail: m ? m[0] : null };
    }
    case "deleted": {
      const m = entry.summary ? /—\s*zakres:\s*(.+)$/.exec(entry.summary) : null;
      return { who, verb, detail: m ? `zakres: ${m[1]}` : null };
    }
    case "restored":
      return { who, verb, detail: null };
    case "moved":
      return {
        who,
        verb,
        detail:
          entry.oldValue || entry.newValue
            ? `${fmtShort(entry.oldValue)} → ${fmtShort(entry.newValue)}`
            : null,
      };
    case "assigned":
    case "unassigned": {
      // Backend w summary podaje nazwisko („Przypisano technika: Jan K.”), w old/new — id.
      const m = entry.summary ? /technika:\s*(.+)$/.exec(entry.summary) : null;
      const name = m?.[1] ?? (a === "assigned" ? entry.newValue : entry.oldValue);
      return { who, verb, detail: name ? `technik: ${name}` : null };
    }
    case "status_changed":
      return {
        who,
        verb,
        detail: `${eventStatusLabel(entry.oldValue ?? "")} → ${eventStatusLabel(entry.newValue ?? "")}`,
      };
    case "updated": {
      const f = entry.field ? ACTIVITY_FIELD_LABELS[entry.field] ?? entry.field : null;
      if (f) {
        return {
          who,
          verb,
          detail: `${f}: ${fieldValue(entry.field, entry.oldValue)} → ${fieldValue(entry.field, entry.newValue)}`,
        };
      }
      return { who, verb, detail: entry.summary ?? null };
    }
    default:
      return { who, verb, detail: entry.summary ?? null };
  }
}

/** Limit długości notatki (backend: 4000). */
export const NOTE_MAX = 4000;

/** „1 notatka” / „3 notatki” / „7 notatek”. */
export function notesLabel(n: number): string {
  const abs = Math.abs(n);
  const last = abs % 10;
  const tens = abs % 100;
  const word = abs === 1 ? "notatka" : last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14) ? "notatki" : "notatek";
  return `${n} ${word}`;
}

/** Inicjały: „Jan Kowalski” → „JK”; „msajdak” → „MS”. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/** „Wojtek B.” — krótka forma nazwiska technika. */
export const techShort = (t: { firstName: string; lastName: string }) =>
  `${t.firstName} ${t.lastName ? `${t.lastName[0]}.` : ""}`.trim();
