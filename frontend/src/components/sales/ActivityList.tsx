/**
 * Lista aktywności handlowca — jeden wiersz na wydarzenie kalendarza działu
 * handlowego. Używa jej ekran „Aktywności" (cztery grupy) i „Agenda na dziś"
 * na pulpicie (wariant `compact`).
 *
 * Komponent sam wykonuje dwie mikroakcje, bo w obu miejscach znaczą to samo:
 *  - „Zrobione" = PUT z pełnym payloadem i `status: "done"` (backend nie ma
 *    endpointu na sam status — tak samo robi to menu kontekstowe kalendarza),
 *  - „Przełóż +1 dzień" = PATCH `/move` (ta sama ścieżka co drag&drop).
 * Po udanym zapisie woła `onDone` / `onPostpone`, żeby rodzic odświeżył dane;
 * brak handlera = przycisku nie ma (tak wyłącza się akcje w trybie do odczytu).
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, Clock, Handshake, Loader2, Phone, Timer } from "lucide-react";
import {
  calendarApi,
  type CalendarEvent,
  type CalendarEventInput,
} from "@/lib/api";
import {
  EVENT_TYPE_META,
  EVENT_TYPE_UI,
  fmtRange,
  fmtRangeCompact,
  fmtRelative,
  initials,
  parseLocal,
  toDateStr,
  toDateTimeStr,
} from "@/lib/calendar-labels";
import { leadHref } from "@/lib/sales-labels";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Kubełek, w którym wiersz się znalazł — decyduje o formacie terminu i pustce. */
export type ActivityGroup = "overdue" | "today" | "upcoming" | "done";

const EMPTY_TEXT: Record<ActivityGroup, string> = {
  overdue: "Nic nie zalega — wszystkie terminy dopięte.",
  today: "Na dziś nie ma zaplanowanych aktywności.",
  upcoming: "Nic nie czeka w najbliższych dniach — zaplanuj następny krok.",
  done: "W tym okresie nic nie zostało wykonane.",
};

/**
 * `CalendarEvent` → pełny payload PUT. W przeciwieństwie do bliźniaka z
 * `CalendarPage` NIESIE dział, szansę i osobę kontaktową: bez `department`
 * backend przyjąłby domyślne `technical` i odrzucił zapis („nie można zmienić
 * działu"), a bez `leadId`/`contactId` cicho zerwałby powiązania aktywności.
 */
function toSalesEventInput(ev: CalendarEvent): CalendarEventInput {
  return {
    type: ev.type,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    startAt: ev.startAt,
    endAt: ev.endAt,
    allDay: ev.allDay,
    status: ev.status,
    objectId: ev.objectId,
    department: ev.department,
    technicianIds: [],
    salespersonIds: (ev.salespeople ?? []).map((s) => s.id),
    leadId: ev.leadId ?? null,
    contactId: ev.contactId ?? null,
    ...(ev.noteId != null ? { noteId: ev.noteId } : {}),
  };
}

/** Przesunięcie terminu o pełne dni z zachowaniem godziny (i formatu all-day). */
function shiftDays(v: string, days: number, allDay: boolean): string {
  const d = parseLocal(v);
  d.setDate(d.getDate() + days);
  return allDay ? toDateStr(d) : toDateTimeStr(d);
}

/** Termin w formacie właściwym dla grupy: zaległe i dzisiejsze czyta się względnie. */
function termLabel(ev: CalendarEvent, group: ActivityGroup): string {
  if (group === "overdue") return fmtRelative(ev.startAt);
  if (group === "today") {
    return ev.allDay ? "cały dzień" : fmtRangeCompact(ev.startAt, ev.endAt, ev.allDay) || "cały dzień";
  }
  return fmtRange(ev.startAt, ev.endAt, ev.allDay);
}

export interface ActivityListProps {
  events: CalendarEvent[];
  /** Klik w wiersz — rodzic otwiera `CalendarEventDialog`. */
  onOpen: (ev: CalendarEvent) => void;
  /** Wywołane PO udanym oznaczeniu jako wykonane (rodzic odświeża dane). */
  onDone?: (ev: CalendarEvent) => void;
  /** Wywołane PO udanym przełożeniu terminu. */
  onPostpone?: (ev: CalendarEvent) => void;
  grouping?: ActivityGroup;
  /** Gęstsza wersja — pulpit ma mało miejsca, więc bez opisów i drugiej linii. */
  compact?: boolean;
  /** Nadpisanie tekstu pustego stanu (np. „Brak aktywności tego typu"). */
  emptyText?: ReactNode;
  /** Prefiks `data-testid` — „aktywnosci" na ekranie listy, „pulpit" na pulpicie. */
  testIdPrefix?: string;
  className?: string;
}

export function ActivityList({
  events,
  onOpen,
  onDone,
  onPostpone,
  grouping = "upcoming",
  compact = false,
  emptyText,
  testIdPrefix = "aktywnosci",
  className,
}: ActivityListProps) {
  /** Id wiersza w trakcie zapisu — blokuje oba przyciski tylko w tym wierszu. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (ev: CalendarEvent, fn: () => Promise<unknown>, after?: (ev: CalendarEvent) => void) => {
    setBusyId(ev.id);
    setError(null);
    try {
      await fn();
      after?.(ev);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nie udało się zapisać zmiany.");
    } finally {
      setBusyId(null);
    }
  };

  if (events.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
        {emptyText ?? EMPTY_TEXT[grouping]}
      </p>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {error && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-md border" data-testid={`${testIdPrefix}-list`}>
        {events.map((ev) => {
          const meta = EVENT_TYPE_META[ev.type];
          const Icon = meta?.icon ?? Clock;
          const busy = busyId === ev.id;
          const people = ev.salespeople ?? [];
          return (
            <li
              key={ev.id}
              data-testid={`${testIdPrefix}-row-${ev.id}`}
              className={cn(
                "flex items-center gap-2 px-2.5 hover:bg-muted/50",
                compact ? "py-1.5" : "py-2"
              )}
            >
              <span
                className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", EVENT_TYPE_UI[ev.type]?.soft)}
                {...tip(meta?.label ?? ev.type)}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">{meta?.label ?? ev.type}</span>
              </span>

              <span
                className={cn(
                  "shrink-0 truncate text-xs tabular-nums",
                  compact ? "w-24" : "w-32",
                  grouping === "overdue" ? "font-medium text-destructive" : "text-muted-foreground"
                )}
                {...tip(fmtRange(ev.startAt, ev.endAt, ev.allDay))}
              >
                {grouping === "overdue" && <AlertTriangle className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />}
                {termLabel(ev, grouping)}
              </span>

              <button
                type="button"
                onClick={() => onOpen(ev)}
                data-testid={`${testIdPrefix}-open-${ev.id}`}
                className="min-w-[6rem] flex-1 basis-0 truncate rounded px-1 text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={cn(ev.status === "cancelled" && "line-through")}>{ev.title}</span>
                {!compact && ev.objectName && (
                  <span className="ml-2 text-xs text-muted-foreground">{ev.objectName}</span>
                )}
              </button>

              {ev.leadId != null && (
                <Link
                  to={leadHref(ev.leadId)}
                  {...tip(`Szansa: ${ev.leadTitle ?? `#${ev.leadId}`}`)}
                  className="hidden min-w-0 max-w-[10rem] shrink items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline md:inline-flex"
                >
                  <Handshake className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{ev.leadTitle ?? `Szansa #${ev.leadId}`}</span>
                </Link>
              )}

              {compact ? null : ev.contactId != null && ev.contactPhone ? (
                <a
                  href={`tel:${ev.contactPhone.replace(/\s+/g, "")}`}
                  {...tip(`Zadzwoń: ${ev.contactName ?? ""} ${ev.contactPhone}`.trim())}
                  className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline lg:inline-flex"
                >
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {ev.contactName ?? ev.contactPhone}
                </a>
              ) : ev.contactName ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">{ev.contactName}</span>
              ) : null}

              {!compact && people.length > 0 && (
                <span
                  className="hidden shrink-0 text-xs font-medium text-muted-foreground sm:inline"
                  {...tip(
                    `${people.length > 1 ? "Handlowcy" : "Handlowiec"}: ${people
                      .map((s) => `${s.firstName} ${s.lastName}`.trim())
                      .join(", ")}`
                  )}
                >
                  {people.map((s) => initials(`${s.firstName} ${s.lastName}`.trim())).join(" ")}
                </span>
              )}

              <span className="flex shrink-0 items-center gap-1">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
                {onDone && ev.status !== "done" && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`${testIdPrefix}-done-${ev.id}`}
                    {...tip("Oznacz jako wykonane")}
                    onClick={() =>
                      void run(
                        ev,
                        () =>
                          calendarApi.update(
                            ev.id,
                            { ...toSalesEventInput(ev), status: "done" },
                            ev.seriesId ? "this" : undefined
                          ),
                        onDone
                      )
                    }
                    className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    <span className={compact ? "sr-only" : undefined}>Zrobione</span>
                  </button>
                )}
                {onPostpone && ev.status !== "done" && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`${testIdPrefix}-postpone-${ev.id}`}
                    {...tip("Przełóż termin o jeden dzień")}
                    onClick={() =>
                      void run(
                        ev,
                        () =>
                          calendarApi.move(ev.id, {
                            startAt: shiftDays(ev.startAt, 1, ev.allDay),
                            endAt: shiftDays(ev.endAt, 1, ev.allDay),
                            allDay: ev.allDay,
                          }),
                        onPostpone
                      )
                    }
                    className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Timer className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">Przełóż o dzień</span>
                    {!compact && <span aria-hidden>+1 dzień</span>}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ActivityList;

// ---------------------------------------------------------------------------
// Podział na kubełki — wspólny dla ekranu „Aktywności" i pulpitu
// ---------------------------------------------------------------------------

export interface ActivityBuckets {
  overdue: CalendarEvent[];
  today: CalendarEvent[];
  upcoming: CalendarEvent[];
  done: CalendarEvent[];
}

/**
 * Rozdziela pobrany zakres wydarzeń na cztery kubełki. Podział jest po stronie
 * klienta świadomie: jedno zapytanie o szeroki zakres wystarcza na wszystkie
 * sekcje, a granice („dziś", „7 dni") liczy się w strefie przeglądarki, czyli
 * tak, jak widzi je handlowiec.
 *
 * Odpada to, co nie jest robotą do zrobienia: odwołane i usunięte wydarzenia.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function splitActivities(
  events: CalendarEvent[],
  opts: { upcomingDays?: number; doneDays?: number; now?: Date } = {}
): ActivityBuckets {
  const now = opts.now ?? new Date();
  const upcomingDays = opts.upcomingDays ?? 7;
  const doneDays = opts.doneDays ?? 30;
  const todayStr = toDateStr(now);
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + upcomingDays);
  const horizonStr = toDateStr(horizon);
  const doneFrom = new Date(now);
  doneFrom.setDate(doneFrom.getDate() - doneDays);
  const doneFromStr = toDateStr(doneFrom);

  const out: ActivityBuckets = { overdue: [], today: [], upcoming: [], done: [] };
  for (const ev of events) {
    if (ev.deletedAt || ev.status === "cancelled") continue;
    const day = toDateStr(parseLocal(ev.startAt));
    if (ev.status === "done") {
      if (day >= doneFromStr) out.done.push(ev);
      continue;
    }
    if (parseLocal(ev.endAt).getTime() < now.getTime()) out.overdue.push(ev);
    else if (day <= todayStr) out.today.push(ev);
    else if (day <= horizonStr) out.upcoming.push(ev);
  }
  const byStart = (a: CalendarEvent, b: CalendarEvent) => a.startAt.localeCompare(b.startAt);
  out.overdue.sort(byStart);
  out.today.sort(byStart);
  out.upcoming.sort(byStart);
  out.done.sort((a, b) => b.startAt.localeCompare(a.startAt));
  return out;
}
