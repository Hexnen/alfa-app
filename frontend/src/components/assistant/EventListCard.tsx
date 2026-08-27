import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, CalendarSearch, Check, ExternalLink, Loader2, MessageSquareText, MoveRight, Sparkles, UserPlus, UserX, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantBriefEvent, AssistantQuickChangeKind, AssistantShowEventsGroupBy, AssistantShowEventsOutput, CalendarEventStatus, CalendarEventType } from "@/lib/api";
import { BILLING_META, EVENT_STATUS_META, EVENT_TYPE_META, EVENT_TYPE_UI, PROTOCOL_BADGE_META, billingTip, protocolTip, eventStatusLabel, eventTypeLabel, fmtRange, initials, notesLabel, parseLocal, protocolBadgeKind, statusBadgeClass } from "@/lib/calendar-labels";
import type { CalendarBilling } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ObjectPeek } from "./ObjectPeek";
import { tip } from "@/components/ui/tooltip";
import type { PreviewRange } from "./parts";

/** Zakres do podświetlenia na siatce; `focus` = „Pokaż” (kalendarz przewija i podświetla). */
export type EventPreviewRange = PreviewRange & { focus?: boolean };

/** Szybkie akcje z wiersza (tylko karta `show_events` z `suggestActions`, dla edytorów kalendarza). */
export interface EventListActions {
  /** Użytkownik ma edit do technical/kalendarz. */
  canEdit: boolean;
  /** Blokada (stream / zapis / trwa quick-change). */
  busy?: boolean;
  /** Akcje „Wykonane / Anuluj / Przesuń…” (tylko karta z `suggestActions`); „Przypisz mnie” niezależne. */
  suggest?: boolean;
  /** Technik bieżącego użytkownika („Przypisz mnie”); null/brak = bez tej akcji. */
  technicianId?: number | null;
  /** eventId → rodzaj wykonanej w tej sesji szybkiej akcji (przycisk oznaczony jako wykonany). */
  quickDone?: ReadonlyMap<number, AssistantQuickChangeKind>;
  /** „Wykonane” / „Anuluj” → POST /quick-change (drawer wstawia parę wiadomości albo robi fallback). */
  onQuickChange: (eventId: number, kind: AssistantQuickChangeKind, title: string, fromToolCallId: string) => void | Promise<void>;
  /** „Przesuń…” → zwykła wiadomość do modelu. */
  onSendText: (text: string) => void;
}

export interface EventListRowsProps {
  events: AssistantBriefEvent[];
  /** Unikalne źródło podglądu (per karta / wiersz narzędzia), np. `events:<toolCallId>`. */
  source: string;
  onOpenEvent: (id: number) => void;
  onPreview?: (range: EventPreviewRange | null, source: string) => void;
  /** Brak = bez szybkich akcji (wynik list_events/search_events w wierszu narzędzia). */
  actions?: EventListActions;
  /** toolCallId karty (do `fromToolCallId` w quick-change). */
  toolCallId?: string;
  className?: string;
}

const TYPE_META = EVENT_TYPE_META as Record<string, (typeof EVENT_TYPE_META)[CalendarEventType] | undefined>;
const TYPE_UI = EVENT_TYPE_UI as Record<string, (typeof EVENT_TYPE_UI)[CalendarEventType] | undefined>;
const STATUS_META = EVENT_STATUS_META as Record<string, (typeof EVENT_STATUS_META)[CalendarEventStatus] | undefined>;

/** Ikonka rozliczenia (tylko ikona + title) — kompaktowo do wiersza listy. */
function BillingIcon({ billing }: { billing: CalendarBilling | null | undefined }) {
  const m = billing ? BILLING_META[billing] : undefined;
  if (!m) return null;
  return (
    <span className={cn("inline-flex items-center rounded-full p-0.5", m.badge)} {...tip(billingTip(billing))} aria-label={`Rozliczenie: ${m.label.toLowerCase()}`} data-testid="billing-badge" data-kind={billing}>
      <m.icon className="h-3 w-3" aria-hidden />
    </span>
  );
}

/** Ikonka protokołu (podpisany / szkic / brak) — tylko ikona + title. */
function ProtocolIcon({ event }: { event: AssistantBriefEvent }) {
  if (!event.type || !event.status) return null;
  const kind = protocolBadgeKind({ type: event.type, status: event.status, protocol: event.protocol ?? null });
  if (!kind) return null;
  const m = PROTOCOL_BADGE_META[kind];
  const title =
    protocolTip({ type: event.type, status: event.status, protocol: event.protocol ?? null }) ??
    m.label(event.protocol?.number);
  return (
    <span className={cn("inline-flex items-center rounded-full p-0.5", m.badge)} {...tip(title)} aria-label={title.replace(/\n/g, " · ")} data-testid="protocol-badge" data-kind={kind}>
      <m.icon className="h-3 w-3" aria-hidden />
    </span>
  );
}

/** Klasy koloru tekstu typu (z `EVENT_TYPE_UI.soft`, bez tła) — do ikony typu. */
const typeTextClass = (type: string): string =>
  (TYPE_UI[type]?.soft ?? "text-muted-foreground")
    .split(" ")
    .filter((c) => c.startsWith("text-") || c.startsWith("dark:text-"))
    .join(" ");

const hasRange = (e: AssistantBriefEvent): e is AssistantBriefEvent & { startAt: string; endAt: string } => typeof e.startAt === "string" && typeof e.endAt === "string";

/** Zakres widma dla istniejącego wydarzenia (siatka wycisza oryginał i rysuje podświetlenie w jego miejscu). */
function eventRangeOf(e: AssistantBriefEvent): PreviewRange | null {
  if (!hasRange(e)) return null;
  return {
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: Boolean(e.allDay),
    title: e.title ?? "",
    type: e.type,
    eventId: e.id ?? null,
    technicianIds: e.technicians?.map((t) => t.id) ?? e.technicianIds ?? [],
  };
}

/** Wydarzenie po terminie: zaplanowane/potwierdzone, a koniec już minął. */
function isOverdue(e: AssistantBriefEvent, now = new Date()): boolean {
  if (e.deleted) return false;
  if (e.status !== "planned" && e.status !== "confirmed") return false;
  if (typeof e.endAt !== "string") return false;
  const end = parseLocal(e.endAt);
  return !Number.isNaN(end.getTime()) && end.getTime() < now.getTime();
}

const techsOf = (e: AssistantBriefEvent): { id: number; name: string }[] => {
  if (Array.isArray(e.technicians)) return e.technicians.filter((t) => t && typeof t.name === "string");
  if (Array.isArray(e.technicianNames)) return e.technicianNames.map((name, i) => ({ id: -(i + 1), name }));
  return [];
};

/** Ikona + etykieta akcji w wierszu (desktop: ikona z title, mobile: ikona + tekst na pełnej szerokości). */
function RowAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  pending,
  tone = "default",
  testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  tone?: "default" | "primary" | "muted";
  testId?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-busy={pending || undefined}
      className={cn(
        "h-10 min-w-[6.25rem] flex-1 gap-1 px-2 text-xs sm:h-7 sm:w-7 sm:min-w-0 sm:flex-none sm:px-0",
        tone === "primary" && "border-primary/40 text-primary hover:text-primary",
        tone === "muted" && "text-muted-foreground"
      )}
      data-testid={testId}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span className="truncate sm:sr-only">{label}</span>
    </Button>
  );
}

/**
 * Wiersze listy wydarzeń: pasek koloru typu + ikona, tytuł (→ dialog), zakres, obiekt (podgląd),
 * technicy (inicjały), badge statusu / „po terminie” / notatek. Hover/fokus wiersza → widmo na siatce.
 */
export function EventListRows({ events, source, onOpenEvent, onPreview, actions, toolCallId, className }: EventListRowsProps) {
  const now = useMemo(() => new Date(), []);
  /** eventId, którego szybka akcja właśnie trwa (spinner, reszta wiersza zablokowana). */
  const [acting, setActing] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Zdejmij podświetlenie, gdy lista znika (przełączenie czatu, zwinięcie wiersza narzędzia).
  useEffect(() => {
    if (!onPreview) return;
    return () => onPreview(null, source);
  }, [onPreview, source]);

  const hover = (e: AssistantBriefEvent | null) => {
    if (!onPreview) return;
    onPreview(e ? eventRangeOf(e) : null, source);
  };

  const quick = (e: AssistantBriefEvent, kind: AssistantQuickChangeKind) => {
    if (!actions || e.id == null || acting != null) return;
    const id = e.id;
    setActing(id);
    Promise.resolve()
      .then(() => actions.onQuickChange(id, kind, e.title ?? "", toolCallId ?? ""))
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setActing(null);
      });
  };

  return (
    <ul className={cn("flex flex-col divide-y", className)} data-testid="assistant-event-rows" onMouseLeave={() => hover(null)}>
      {events.map((e, i) => {
        const type = e.type ?? "";
        const TypeIcon = TYPE_META[type]?.icon ?? Sparkles;
        const bar = TYPE_UI[type]?.bar ?? "bg-muted-foreground";
        const status = e.status ?? "";
        const overdue = isOverdue(e, now);
        const techs = techsOf(e);
        const notes = typeof e.notesCount === "number" ? e.notesCount : 0;
        const range = hasRange(e) ? fmtRange(e.startAt, e.endAt, Boolean(e.allDay)) : "";
        const deleted = Boolean(e.deleted);
        const id = e.id;
        const done = id != null ? actions?.quickDone?.get(id) : undefined;
        const isActing = id != null && acting === id;
        const showQuick = Boolean(actions?.canEdit) && Boolean(actions?.suggest) && !deleted && id != null;
        const disabled = Boolean(actions?.busy) || acting != null;
        const unassigned = techs.length === 0 && !deleted;
        const me = actions?.technicianId ?? null;
        // „Przypisz mnie”: użytkownik ma technika, wydarzenie otwarte i jeszcze bez niego.
        const showAssignMe = Boolean(actions?.canEdit) && me != null && !deleted && id != null && status !== "cancelled" && status !== "done" && !techs.some((t) => t.id === me);
        return (
          <li
            key={id ?? i}
            className={cn("group flex flex-col gap-1.5 px-2.5 py-2 text-xs transition-colors hover:bg-accent/60 focus-within:bg-accent/60", deleted && "opacity-60")}
            onMouseEnter={() => hover(e)}
            onFocus={() => hover(e)}
            onBlur={(ev) => {
              if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) hover(null);
            }}
            data-testid="assistant-event-row"
            data-event-id={id ?? undefined}
            data-status={status || undefined}
          >
            <div className="flex min-w-0 items-start gap-2">
              <span className={cn("mt-0.5 h-8 w-1 shrink-0 rounded-full", bar)} aria-hidden />
              <TypeIcon className={cn("mt-0.5 h-4 w-4 shrink-0", typeTextClass(type))} aria-label={eventTypeLabel(type)} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {id != null ? (
                    <button
                      type="button"
                      onClick={() => onOpenEvent(id)}
                      className={cn("min-w-0 max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded", deleted && "line-through")}
                      title={`Otwórz „${e.title ?? ""}”`}
                      data-testid="assistant-event-title"
                    >
                      {e.title || `Wydarzenie #${id}`}
                    </button>
                  ) : (
                    <span className="truncate text-sm font-medium">{e.title || "Wydarzenie"}</span>
                  )}
                  {id != null && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{id}</span>}
                  {status && (
                    <span className={cn(statusBadgeClass(status as CalendarEventStatus), "px-1.5 py-0 text-[10px]", !STATUS_META[status] && "bg-muted text-muted-foreground")} data-testid="assistant-event-status">
                      {eventStatusLabel(status)}
                    </span>
                  )}
                  <BillingIcon billing={e.billing} />
                  <ProtocolIcon event={e} />
                  {overdue && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" data-testid="assistant-event-overdue">
                      po terminie
                    </span>
                  )}
                  {unassigned && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" data-testid="assistant-event-unassigned">
                      <UserX className="h-3 w-3" aria-hidden />
                      bez technika
                    </span>
                  )}
                  {deleted && (
                    <span className="inline-flex items-center rounded-full border border-dashed px-1.5 py-0 text-[10px] text-muted-foreground" data-testid="assistant-event-deleted">
                      usunięte
                    </span>
                  )}
                  {notes > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title={notesLabel(notes)} data-testid="assistant-event-notes">
                      <MessageSquareText className="h-3 w-3" aria-hidden />
                      {notes}
                      <span className="sr-only"> {notesLabel(notes).replace(/^\d+\s*/, "")}</span>
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                  {range && (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <CalendarRange className="h-3 w-3 shrink-0" aria-hidden />
                      {range}
                    </span>
                  )}
                  {e.objectId != null ? (
                    <ObjectPeek objectId={e.objectId} title="Podgląd obiektu" className="min-w-0 max-w-full truncate">
                      {e.objectName ?? `Obiekt #${e.objectId}`}
                    </ObjectPeek>
                  ) : e.location ? (
                    <span className="min-w-0 truncate">{e.location}</span>
                  ) : null}
                  {techs.length > 0 && (
                    <span className="inline-flex items-center -space-x-1" aria-label={`Technicy: ${techs.map((t) => t.name).join(", ")}`} data-testid="assistant-event-techs">
                      {techs.map((t) => (
                        <span
                          key={t.id}
                          {...tip(`Technik: ${t.name}`)}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-semibold uppercase text-foreground"
                        >
                          {initials(t.name)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1 pl-[1.4rem] sm:pl-[1.4rem]">
              {onPreview && hasRange(e) && (
                <RowAction icon={CalendarSearch} label="Pokaż" tone="primary" onClick={() => onPreview({ ...eventRangeOf(e)!, focus: true }, source)} testId="assistant-event-show" />
              )}
              {id != null && <RowAction icon={ExternalLink} label="Otwórz" onClick={() => onOpenEvent(id)} testId="assistant-event-open" />}
              {showAssignMe && (
                <RowAction
                  icon={UserPlus}
                  label={done === "assign_me" ? "Przypisano" : "Przypisz mnie"}
                  tone="primary"
                  onClick={() => quick(e, "assign_me")}
                  disabled={disabled || done === "assign_me" || isActing}
                  pending={isActing && done !== "assign_me"}
                  testId="assistant-event-assign-me"
                />
              )}
              {showQuick && actions && (
                <>
                  {status !== "done" && (
                    <RowAction
                      icon={Check}
                      label={done === "done" ? "Oznaczono jako wykonane" : "Wykonane"}
                      onClick={() => quick(e, "done")}
                      disabled={disabled || done === "done" || isActing}
                      pending={isActing}
                      testId="assistant-event-done"
                    />
                  )}
                  {status !== "cancelled" && (
                    <RowAction
                      icon={XCircle}
                      label={done === "cancel" ? "Anulowanie zgłoszone" : "Anuluj"}
                      tone="muted"
                      onClick={() => quick(e, "cancel")}
                      disabled={disabled || done === "cancel" || isActing}
                      testId="assistant-event-cancel"
                    />
                  )}
                  <RowAction
                    icon={MoveRight}
                    label="Przesuń…"
                    tone="muted"
                    onClick={() => actions.onSendText(`Przesuń wydarzenie #${id} „${e.title ?? ""}”`)}
                    disabled={disabled}
                    testId="assistant-event-move"
                  />
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface EventListCardProps {
  toolCallId: string;
  output: AssistantShowEventsOutput;
  onOpenEvent: (id: number) => void;
  onPreview?: (range: EventPreviewRange | null, source: string) => void;
  /** Szybkie akcje (tylko gdy `output.suggestActions`); brak → wiersze bez akcji. */
  actions?: EventListActions;
}

// ---------------------------------------------------------------------------
// Zestawienia (groupBy): sekcje karty
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = ["nd", "pon", "wt", "śr", "czw", "pt", "sob"];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** „YYYY-MM-DD” → lokalna data (bez błędów strefy). */
const dayOf = (iso: string): Date => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** „czw 27.08” (+ „.YYYY”, gdy inny rok niż bieżący). */
function fmtDay(iso: string, now: Date): string {
  const d = dayOf(iso);
  const base = `${WEEKDAY_SHORT[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}.${d.getFullYear()}`;
}
/** Nagłówek dnia: „Dziś · czw 27.08” / „Jutro · pt 28.08” / „pon 31.08”. */
function dayLabel(iso: string, now: Date): string {
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const key = iso.slice(0, 10);
  const d = fmtDay(key, now);
  if (key === today) return `Dziś · ${d}`;
  if (key === tomorrow) return `Jutro · ${d}`;
  return d;
}
/** Zakres do nagłówka karty: ostatni dzień = `to` − 1 dzień (to exclusive) dla samej daty / północy; dla daty z godziną — dzień `to`. */
function fmtRangeHeader(from: string, to: string, now = new Date()): string {
  const start = from.slice(0, 10);
  let last = to.slice(0, 10);
  if (to.length === 10 || /T00:00$/.test(to)) {
    const d = dayOf(to);
    d.setDate(d.getDate() - 1);
    last = dayKey(d);
  }
  if (last < start) last = start;
  return start === last ? fmtDay(start, now) : `${fmtDay(start, now)} – ${fmtDay(last, now)}`;
}

interface EventGroup {
  key: string;
  label: string;
  events: AssistantBriefEvent[];
}

const NO_TECH = "Bez technika";
const NO_OBJECT = "Bez obiektu";
const collator = new Intl.Collator("pl");

/** Dzieli listę na sekcje wg `groupBy` (pomijając pozycje bez sensownego klucza, np. bez daty przy `day`). */
function groupEvents(events: AssistantBriefEvent[], groupBy: AssistantShowEventsGroupBy, range: { from: string; to: string } | null, now = new Date()): EventGroup[] {
  const map = new Map<string, EventGroup>();
  const push = (key: string, label: string, e: AssistantBriefEvent) => {
    const g = map.get(key) ?? { key, label, events: [] };
    g.events.push(e);
    map.set(key, g);
  };
  if (groupBy === "day") {
    const floor = range?.from?.slice(0, 10) ?? null;
    for (const e of events) {
      if (typeof e.startAt !== "string") continue;
      let key = e.startAt.slice(0, 10);
      // Wydarzenie trwające od przed zakresem → pierwszy dzień zakresu.
      if (floor && key < floor) key = floor;
      push(key, dayLabel(key, now), e);
    }
    return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  if (groupBy === "technician") {
    for (const e of events) {
      const techs = techsOf(e);
      if (techs.length === 0) push("tech:none", NO_TECH, e);
      for (const t of techs) push(`tech:${t.id}`, t.name, e);
    }
    return [...map.values()].sort((a, b) => (a.key === "tech:none" ? 1 : b.key === "tech:none" ? -1 : collator.compare(a.label, b.label)));
  }
  if (groupBy === "object") {
    for (const e of events) {
      const label = e.objectName ?? e.location ?? null;
      if (!label) push("obj:none", NO_OBJECT, e);
      else push(`obj:${e.objectId != null ? e.objectId : label.toLowerCase()}`, label, e);
    }
    return [...map.values()].sort((a, b) => (a.key === "obj:none" ? 1 : b.key === "obj:none" ? -1 : collator.compare(a.label, b.label)));
  }
  // type: kolejność jak EVENT_TYPE_META (nieznane typy na końcu).
  const order = Object.keys(EVENT_TYPE_META);
  for (const e of events) {
    const t = e.type ?? "";
    push(`type:${t}`, eventTypeLabel(t), e);
  }
  const idx = (k: string) => {
    const i = order.indexOf(k.slice("type:".length));
    return i < 0 ? order.length : i;
  };
  return [...map.values()].sort((a, b) => idx(a.key) - idx(b.key));
}

/** Karta `show_events`: nagłówek (tytuł + liczba + zakres), notatka, wiersze wydarzeń — płasko albo w sekcjach (`groupBy`). */
export function EventListCard({ toolCallId, output, onOpenEvent, onPreview, actions }: EventListCardProps) {
  const title = output.title || "Wydarzenia";
  const count = output.count || output.events.length;
  const missing = output.missing?.length ?? 0;
  const now = useMemo(() => new Date(), []);
  const rowActions: EventListActions | undefined = actions ? { ...actions, suggest: output.suggestActions } : undefined;
  const groups = useMemo(
    () => (output.groupBy && output.events.length > 0 ? groupEvents(output.events, output.groupBy, output.range ?? null, now) : null),
    [output.groupBy, output.events, output.range, now]
  );
  const rangeLabel = output.range ? fmtRangeHeader(output.range.from, output.range.to, now) : "";
  return (
    <div className="rounded-lg border bg-background text-sm shadow-sm" role="group" aria-label={`${title} (${count})`} data-testid="assistant-event-list" data-toolcall={toolCallId} data-group-by={output.groupBy ?? undefined}>
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <CalendarSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate font-medium leading-snug">{title}</span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground" data-testid="assistant-event-list-count">
              {count}
            </span>
          </div>
          {rangeLabel && (
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground" data-testid="assistant-event-list-range">
              {rangeLabel}
            </p>
          )}
          {output.note && <p className="mt-0.5 text-xs text-muted-foreground">{output.note}</p>}
          {missing > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Nie znaleziono: #{output.missing!.join(", #")}</p>}
        </div>
      </div>
      {output.events.length === 0 ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">Brak wydarzeń do pokazania.</p>
      ) : groups ? (
        <div className="border-t">
          {groups.map((g) => (
            <section key={g.key} data-testid="assistant-event-group" data-group-key={g.key} aria-label={`${g.label} (${g.events.length})`}>
              <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-1 text-xs font-medium">
                <span className="min-w-0 truncate">{g.label}</span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{g.events.length}</span>
              </div>
              <EventListRows events={g.events} source={`events:${toolCallId}`} toolCallId={toolCallId} onOpenEvent={onOpenEvent} onPreview={onPreview} actions={rowActions} className="border-b last:border-b-0" />
            </section>
          ))}
        </div>
      ) : (
        <EventListRows
          events={output.events}
          source={`events:${toolCallId}`}
          toolCallId={toolCallId}
          onOpenEvent={onOpenEvent}
          onPreview={onPreview}
          actions={rowActions}
          className="border-t"
        />
      )}
    </div>
  );
}
