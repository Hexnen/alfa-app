import { useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, Building2, CalendarX2, Repeat, Users } from "lucide-react";
import type { CalendarEvent, CalendarEventStatus, CalendarEventType } from "@/lib/api";
import {
  EVENT_STATUS_META,
  EVENT_STATUS_ORDER,
  EVENT_TYPE_META,
  EVENT_TYPE_ORDER,
  eventTipAria,
  eventTipData,
  eventsCount,
  fmtRange,
  overdueTip,
  parseLocal,
  protocolBadgeKind,
  seriesShortLabel,
} from "@/lib/calendar-labels";
import { BillingBadge, ProtocolBadge, QuoteBadge, RealizationBadge } from "@/components/CalendarEventBadges";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Grupowanie kolumn tablicy: wg statusu (domyślnie) albo wg typu. */
export type BoardGroupBy = "status" | "type";

interface CalendarBoardProps {
  events: CalendarEvent[];
  groupBy: BoardGroupBy;
  /** Uprawnienie edycji — bez niego karty nie są przeciągalne. */
  editable: boolean;
  loading?: boolean;
  onOpen: (ev: CalendarEvent) => void;
  onContextMenu: (ev: CalendarEvent, e: ReactMouseEvent) => void;
  /** Drop karty do innej kolumny: nowy status albo nowy typ (zależnie od `groupBy`). */
  onMove: (ev: CalendarEvent, target: CalendarEventStatus | CalendarEventType) => Promise<void> | void;
  /** CTA pustego stanu (np. „Nowe wydarzenie”) — pokazywane tylko, gdy cała tablica jest pusta. */
  onCreate?: () => void;
}

interface BoardColumn {
  key: string;
  label: string;
  /** Klasy nagłówka (kolor statusu / chip typu). */
  headClass: string;
  /** Kolor akcentu (CSS) dla paska kolumny. */
  accent?: string;
  icon?: typeof Building2;
  /** Krótkie wyjaśnienie do tooltipa nagłówka („termin wstępny — czeka na potwierdzenie”). */
  hint?: string;
}

const STATUS_ACCENT: Record<CalendarEventStatus, string> = {
  planned: "hsl(var(--cal-serwis))",
  confirmed: "hsl(var(--cal-montaz))",
  done: "hsl(var(--cal-biuro))",
  cancelled: "hsl(var(--cal-overdue))",
};

/** Kolor typu — ta sama zmienna co w Calendar.css (`--cal-<typ>`). */
const typeColor = (t: CalendarEventType) => `hsl(var(${EVENT_TYPE_META[t]?.cssVar ?? "--cal-biuro"}))`;

const DRAG_MIME = "application/x-alfa-calendar-event";

/** Wydarzenie zaplanowane, którego koniec już minął. */
export function isOverdue(ev: CalendarEvent, now: Date): boolean {
  if (ev.status !== "planned" || ev.deletedAt) return false;
  const end = parseLocal(ev.endAt);
  return !Number.isNaN(end.getTime()) && end.getTime() < now.getTime();
}

const initials = (t: { firstName: string; lastName: string }) =>
  `${t.firstName[0] ?? ""}${t.lastName[0] ?? ""}`.toUpperCase();

export function CalendarBoard({
  events,
  groupBy,
  editable,
  loading,
  onOpen,
  onContextMenu,
  onMove,
  onCreate,
}: CalendarBoardProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const columns = useMemo<BoardColumn[]>(() => {
    if (groupBy === "status") {
      return EVENT_STATUS_ORDER.map((s) => ({
        key: s,
        label: EVENT_STATUS_META[s].label,
        headClass: EVENT_STATUS_META[s].badge,
        accent: STATUS_ACCENT[s],
        hint: EVENT_STATUS_META[s].hint,
      }));
    }
    return EVENT_TYPE_ORDER.map((t) => ({
      key: t,
      label: EVENT_TYPE_META[t].label,
      headClass: cn("border bg-background", EVENT_TYPE_META[t].chip),
      accent: typeColor(t),
      icon: EVENT_TYPE_META[t].icon,
    }));
  }, [groupBy]);

  const grouped = useMemo(() => {
    const now = new Date();
    const map = new Map<string, CalendarEvent[]>();
    for (const c of columns) map.set(c.key, []);
    const sorted = [...events]
      .filter((e) => !e.deletedAt)
      .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id - b.id);
    let total = 0;
    for (const ev of sorted) {
      total++;
      const key = groupBy === "status" ? ev.status : ev.type;
      const arr = map.get(key);
      if (arr) arr.push(ev);
      else map.set(key, [ev]);
    }
    const overdue = new Map<string, number>();
    for (const [k, arr] of map) overdue.set(k, arr.filter((e) => isOverdue(e, now)).length);
    return { map, now, total, overdue };
  }, [events, columns, groupBy]);

  const keyOf = (ev: CalendarEvent) => (groupBy === "status" ? ev.status : ev.type);

  const handleDragStart = (ev: CalendarEvent) => (e: DragEvent<HTMLDivElement>) => {
    if (!editable) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_MIME, String(ev.id));
    e.dataTransfer.setData("text/plain", ev.title);
    e.dataTransfer.effectAllowed = "move";
    setDragId(ev.id);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setOverKey(null);
  };

  const handleDragOver = (col: BoardColumn) => (e: DragEvent<HTMLDivElement>) => {
    if (!editable || dragId === null) return;
    const dragged = events.find((x) => x.id === dragId);
    if (!dragged || keyOf(dragged) === col.key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overKey !== col.key) setOverKey(col.key);
  };

  const handleDragLeave = (col: BoardColumn) => (e: DragEvent<HTMLDivElement>) => {
    // Ignoruj przejścia między dziećmi tej samej kolumny.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (overKey === col.key) setOverKey(null);
  };

  const handleDrop = (col: BoardColumn) => async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOverKey(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    const id = raw ? Number(raw) : dragId;
    setDragId(null);
    if (!editable || !id) return;
    const ev = events.find((x) => x.id === id);
    if (!ev || keyOf(ev) === col.key) return;
    setBusyId(ev.id);
    try {
      await onMove(ev, col.key as CalendarEventStatus | CalendarEventType);
    } finally {
      setBusyId(null);
    }
  };

  const dragging = dragId !== null;

  return (
    // min-h-0 + flex-1: w trybie pełnej wysokości (rodzic .alfa-calendar[data-fit])
    // tablica wypełnia okno, a przewijają się same kolumny.
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {grouped.total === 0 && !loading && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <CalendarX2 className="h-7 w-7 text-muted-foreground/60" aria-hidden />
          <p className="text-sm font-medium">Brak wydarzeń w tym miesiącu</p>
          <p className="text-xs text-muted-foreground">
            Zmień miesiąc strzałkami, wyczyść filtry albo dodaj pierwsze wydarzenie.
          </p>
          {onCreate && (
            <button
              type="button"
              onClick={onCreate}
              className="mt-1 inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Nowe wydarzenie
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          // Mobile: poziomy pasek ze snapem. Desktop: siatka zawijająca kolumny
          // (8 typów → 2 rzędy), żeby tablica nie rozpychała strony w poziomie.
          "alfa-board flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:grid md:snap-none md:overflow-visible md:[grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]",
          loading && "opacity-70"
        )}
        data-testid="calendar-board"
        aria-busy={loading || undefined}
      >
        {columns.map((col) => {
          const items = grouped.map.get(col.key) ?? [];
          const overdueCount = grouped.overdue.get(col.key) ?? 0;
          const ColIcon = col.icon;
          const isOver = overKey === col.key;
          const dragged = dragging ? events.find((x) => x.id === dragId) : undefined;
          const isDropTarget = dragged ? keyOf(dragged) !== col.key : false;
          return (
            <section
              key={col.key}
              data-board-column={col.key}
              aria-label={`${col.label} — ${eventsCount(items.length)}`}
              onDragOver={handleDragOver(col)}
              onDragEnter={handleDragOver(col)}
              onDragLeave={handleDragLeave(col)}
              onDrop={handleDrop(col)}
              className={cn(
                "flex w-[82vw] shrink-0 snap-start flex-col rounded-lg border bg-muted/30 transition-colors md:w-auto md:min-h-0 md:min-w-0",
                isDropTarget && !isOver && "border-dashed border-primary/40",
                isOver && "border-primary bg-primary/5 ring-2 ring-primary/30"
              )}
              style={{ borderTopColor: col.accent, borderTopWidth: 3 }}
            >
              <header
                className="sticky top-0 z-[1] flex items-center justify-between gap-2 rounded-t-md bg-muted/60 px-3 py-2 backdrop-blur-sm"
                {...tipAttrs({
                  title: `${col.label} — ${eventsCount(items.length)}`,
                  accent: col.accent,
                  text: col.hint,
                  warnings: overdueCount > 0 ? [`W tym ${eventsCount(overdueCount)} po terminie`] : undefined,
                  hint: editable ? "Przeciągnij kartę tutaj, by zmienić kolumnę" : undefined,
                })}
              >
                <span
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold",
                    col.headClass
                  )}
                >
                  {ColIcon && <ColIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  <span className="truncate">{col.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {overdueCount > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-red-700 dark:bg-red-500/20 dark:text-red-200"
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden />
                      {overdueCount}
                      <span className="sr-only"> po terminie</span>
                    </span>
                  )}
                  <span
                    className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                    aria-label={eventsCount(items.length)}
                  >
                    {items.length}
                  </span>
                </span>
              </header>
              <div className="alfa-board-col-body flex flex-1 flex-col gap-2 px-2 pb-2 pt-1">
                {items.length === 0 && (
                  <p
                    className={cn(
                      "flex min-h-[5rem] items-center justify-center rounded-md border border-dashed px-2 py-4 text-center text-xs text-muted-foreground transition-colors",
                      isOver && "border-primary bg-primary/5 font-medium text-primary"
                    )}
                  >
                    {isOver ? "Upuść tutaj" : dragging && isDropTarget ? "Przeciągnij tutaj" : "Pusto"}
                  </p>
                )}
                {items.map((ev) => (
                  <BoardCard
                    key={ev.id}
                    ev={ev}
                    overdue={isOverdue(ev, grouped.now)}
                    draggable={editable}
                    dragging={dragId === ev.id}
                    busy={busyId === ev.id}
                    onDragStart={handleDragStart(ev)}
                    onDragEnd={handleDragEnd}
                    onOpen={() => onOpen(ev)}
                    onContextMenu={(e) => onContextMenu(ev, e)}
                  />
                ))}
                {items.length > 0 && isOver && (
                  <div className="rounded-md border-2 border-dashed border-primary/60 bg-primary/5 px-2 py-3 text-center text-xs font-medium text-primary">
                    Upuść tutaj
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface BoardCardProps {
  ev: CalendarEvent;
  overdue: boolean;
  draggable: boolean;
  dragging: boolean;
  busy: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}

function BoardCard({
  ev,
  overdue,
  draggable,
  dragging,
  busy,
  onDragStart,
  onDragEnd,
  onOpen,
  onContextMenu,
}: BoardCardProps) {
  const meta = EVENT_TYPE_META[ev.type];
  const Icon = meta?.icon ?? Building2;
  const techs = ev.technicians ?? [];
  const color = typeColor(ev.type);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      data-board-card={ev.id}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onContextMenu}
      aria-label={eventTipAria(ev)}
      {...tipAttrs(
        eventTipData(ev, {
          hint: draggable
            ? "Przeciągnij, by zmienić kolumnę · prawy przycisk: więcej akcji"
            : "Kliknij, by otworzyć szczegóły",
        })
      )}
      className={cn(
        "group relative rounded-md border bg-card py-2 pl-3 pr-2 text-left text-sm shadow-sm transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        dragging && "opacity-40 shadow-none",
        busy && "pointer-events-none opacity-60",
        ev.status === "cancelled" && "border-dashed opacity-70",
        ev.status === "done" && "opacity-80",
        overdue && "border-red-400/70 dark:border-red-400/50"
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
    >
      <div className="flex items-start gap-1.5">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} aria-label={meta?.label} />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate font-medium leading-tight",
              ev.status === "done" && "font-normal text-muted-foreground",
              ev.status === "cancelled" && "font-normal line-through"
            )}
          >
            {ev.title}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {fmtRange(ev.startAt, ev.endAt, ev.allDay)}
          </div>
        </div>
      </div>

      {(ev.objectName || techs.length > 0 || ev.seriesId || overdue || ev.billing || protocolBadgeKind(ev)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {ev.objectName && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1">
              <Building2 className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{ev.objectName}</span>
            </span>
          )}
          {techs.length > 0 && (
            <span
              className="inline-flex items-center gap-1"
              {...tipAttrs({
                title: techs.length > 1 ? "Technicy" : "Technik",
                text: techs.map((t) => `${t.firstName} ${t.lastName}`).join("\n"),
              })}
            >
              <Users className="h-3 w-3 shrink-0" aria-hidden />
              <span className="flex -space-x-1">
                {techs.slice(0, 4).map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-semibold text-foreground"
                  >
                    {initials(t)}
                  </span>
                ))}
                {techs.length > 4 && (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-[10px]">
                    +{techs.length - 4}
                  </span>
                )}
              </span>
            </span>
          )}
          {ev.seriesId && (
            <span
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium"
              {...tipAttrs({
                title: `Seria cykliczna${ev.series ? `: ${seriesShortLabel(ev.series.freq, ev.series.interval)}` : ""}`,
                text:
                  ev.seriesIndex != null && ev.seriesTotal != null
                    ? `Wystąpienie ${ev.seriesIndex} z ${ev.seriesTotal}`
                    : undefined,
              })}
            >
              <Repeat className="h-3 w-3" aria-hidden />
              {ev.series ? seriesShortLabel(ev.series.freq, ev.series.interval) : "seria"}
              {ev.seriesIndex != null && ev.seriesTotal != null && ` ${ev.seriesIndex}/${ev.seriesTotal}`}
            </span>
          )}
          {overdue && (
            <span
              className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-500/20 dark:text-red-200"
              {...tipAttrs({ title: "Po terminie", text: overdueTip(ev) })}
            >
              <AlertTriangle className="h-3 w-3" aria-hidden /> po terminie
            </span>
          )}
          <BillingBadge billing={ev.billing} compact />
          <ProtocolBadge event={ev} compact />
          <QuoteBadge event={ev} compact />
          <RealizationBadge event={ev} compact />
        </div>
      )}
    </div>
  );
}
