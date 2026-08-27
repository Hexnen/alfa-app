import { useEffect, useState } from "react";
import { AlertTriangle, Building2, CalendarSearch, Check, ExternalLink, Loader2, MapPin, Pencil, Repeat, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantConflict, AssistantProposal, CalendarEventType } from "@/lib/api";
import {
  EVENT_STATUS_META,
  EVENT_TYPE_META,
  EVENT_TYPE_UI,
  eventTypeLabel,
  fmtDuration,
  fmtRange,
  fmtShort,
  seriesShortLabel,
  statusBadgeClass,
} from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import type { PreviewRange, ProposalDecision } from "./parts";
import { ObjectPeek } from "./ObjectPeek";
import { NotesBadge } from "@/components/CalendarEventNotes";

export interface ProposalCardProps {
  toolCallId: string;
  proposal: AssistantProposal;
  conflicts?: AssistantConflict[];
  decision?: ProposalDecision;
  busy?: boolean;
  /** Zatwierdź → rodzic zapisuje przez calendarApi.create; odrzuca Promise przy błędzie. */
  onApprove: (toolCallId: string, proposal: AssistantProposal) => Promise<void>;
  /** Edytuj → rodzic otwiera CalendarEventDialog z prefill. */
  onEdit: (toolCallId: string, proposal: AssistantProposal) => void;
  onReject: (toolCallId: string, proposal: AssistantProposal) => Promise<void>;
  onOpenEvent: (id: number) => void;
  /**
   * Sprzężenie z siatką: karta bez decyzji zgłasza swój termin (mount) — kalendarz pokazuje
   * „widmowe” wydarzenie; `null` zdejmuje podświetlenie. „Pokaż w kalendarzu” = `{…, focus:true}`.
   */
  onPreview?: (range: (PreviewRange & { focus?: boolean }) | null, source: string) => void;
}

const conflictTechs = (c: AssistantConflict): string => {
  if (!Array.isArray(c.technicians) || !c.technicians.length) return "";
  return c.technicians.map((t) => (typeof t === "string" ? t : t.name)).join(", ");
};

const proposalRange = (p: AssistantProposal, conflicts: AssistantConflict[] = []): PreviewRange => ({
  startAt: p.startAt,
  endAt: p.endAt,
  allDay: Boolean(p.allDay),
  technicianIds: p.technicianIds ?? [],
  conflictIds: conflicts.map((c) => c.id),
  title: p.title,
  type: p.type,
});

/** Karta propozycji wydarzenia — w stylu podglądu z Calendar.tsx. Zapis dopiero po Zatwierdź. */
export function ProposalCard({
  toolCallId,
  proposal: p,
  conflicts = [],
  decision,
  busy = false,
  onApprove,
  onEdit,
  onReject,
  onOpenEvent,
  onPreview,
}: ProposalCardProps) {
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = p.type as CalendarEventType;
  const meta = EVENT_TYPE_META[type];
  const ui = EVENT_TYPE_UI[type];
  const Icon = meta?.icon ?? Building2;
  const status = p.status ?? "planned";
  const statusMeta = EVENT_STATUS_META[status];
  const techs = p.technicianNames?.length ? p.technicianNames : null;
  const duration = fmtDuration(p.startAt, p.endAt, p.allDay);
  const disabled = busy || pending !== null;
  const undecided = !decision;

  // Widmo na siatce, dopóki karta czeka na decyzję (zdejmowane przy decyzji / odmontowaniu).
  const conflictKey = conflicts.map((c) => c.id).join(",");
  useEffect(() => {
    if (!onPreview || !undecided) return;
    onPreview(proposalRange(p, conflicts), toolCallId);
    return () => onPreview(null, toolCallId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zakres zależy od pól p i listy id konfliktów
  }, [onPreview, undecided, toolCallId, p.startAt, p.endAt, p.allDay, conflictKey]);

  const run = async (kind: "approve" | "reject") => {
    setPending(kind);
    setError(null);
    try {
      if (kind === "approve") await onApprove(toolCallId, p);
      else await onReject(toolCallId, p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wykonać akcji.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-background text-sm shadow-sm",
        decision?.status === "rejected" && "opacity-70"
      )}
      role="group"
      aria-label={`Propozycja wydarzenia: ${p.title}`}
      data-testid="assistant-proposal"
      data-decision={decision?.status ?? "pending"}
    >
      <div className={cn("absolute inset-y-0 left-0 w-1", ui?.bar ?? "bg-slate-500")} aria-hidden />
      <div className="space-y-2 py-2.5 pl-4 pr-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", ui?.soft)}>
            <Icon className="h-3.5 w-3.5" aria-hidden /> {eventTypeLabel(p.type)}
          </span>
          <span className={statusBadgeClass(status)}>{statusMeta?.label ?? status}</span>
          {p.recurrence && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              <Repeat className="h-3 w-3" aria-hidden /> {seriesShortLabel(p.recurrence.freq, p.recurrence.interval ?? 1)}
            </span>
          )}
          <span className="ml-auto text-[11px] uppercase tracking-wide text-muted-foreground">Propozycja</span>
        </div>

        <div className="font-semibold leading-snug">{p.title}</div>

        <dl className="space-y-1 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-start gap-x-1.5 gap-y-0.5">
            <dt className="sr-only">Termin</dt>
            <dd>
              {fmtRange(p.startAt, p.endAt, p.allDay)}
              {duration && <span className="opacity-80"> · {duration}</span>}
              {p.allDay && <span className="opacity-80"> · cały dzień</span>}
            </dd>
            {onPreview && (
              <button
                type="button"
                onClick={() => onPreview({ ...proposalRange(p, conflicts), focus: true }, toolCallId)}
                className="inline-flex items-center gap-1 rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="proposal-show-in-calendar"
              >
                <CalendarSearch className="h-3 w-3" aria-hidden /> Pokaż w kalendarzu
              </button>
            )}
          </div>
          {(p.objectName || p.location) && (
            <div className="flex items-start gap-1.5">
              <MapPin className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <dt className="sr-only">Obiekt</dt>
              <dd>
                {p.objectName && p.objectId != null ? (
                  <ObjectPeek objectId={p.objectId} title="Podgląd obiektu" className="text-foreground">
                    {p.objectName}
                  </ObjectPeek>
                ) : (
                  p.objectName
                )}
                {p.objectName && p.location ? " · " : ""}
                {p.location}
              </dd>
            </div>
          )}
          <div className="flex items-start gap-1.5">
            <Users className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <dt className="sr-only">Technicy</dt>
            <dd>
              {techs
                ? techs.join(", ")
                : p.technicianIds?.length
                  ? `${p.technicianIds.length} techn.`
                  : "bez techników"}
            </dd>
          </div>
          {p.description && <div className="whitespace-pre-wrap break-words pt-0.5 text-foreground/80">{p.description}</div>}
          {(p.notesCount ?? 0) > 0 && (
            <div className="pt-0.5">
              <NotesBadge count={p.notesCount} />
            </div>
          )}
        </dl>

        {conflicts.length > 0 && decision?.status !== "saved" && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Konflikty ({conflicts.length})
            </div>
            <ul className="mt-1 space-y-0.5">
              {conflicts.slice(0, 4).map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-1">
                  <button
                    type="button"
                    onClick={() => onOpenEvent(c.id)}
                    className="underline-offset-2 hover:underline"
                  >
                    {c.kind === "urlop" ? "Urlop" : eventTypeLabel(c.type)}: {c.title}
                  </button>
                  <span className="opacity-80">
                    {fmtShort(c.startAt)} – {fmtShort(c.endAt)}
                    {conflictTechs(c) ? ` · ${conflictTechs(c)}` : ""}
                  </span>
                </li>
              ))}
              {conflicts.length > 4 && <li className="opacity-80">…i {conflicts.length - 4} więcej</li>}
            </ul>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {decision?.status === "saved" ? (
          <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5" aria-hidden /> {decision.edited ? "Zapisano po edycji" : "Zapisano"}
            </span>
            {decision.eventId != null && (
              <>
                <span className="text-muted-foreground">·</span>
                <button
                  type="button"
                  onClick={() => onOpenEvent(decision.eventId as number)}
                  className="inline-flex min-h-10 items-center gap-1 text-primary underline-offset-2 hover:underline lg:min-h-0"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden /> Otwórz wydarzenie
                </button>
              </>
            )}
          </div>
        ) : decision?.status === "rejected" ? (
          <div className="flex items-center gap-1 border-t pt-2 text-xs text-muted-foreground">
            <X className="h-3.5 w-3.5" aria-hidden /> Odrzucono
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
            <Button size="sm" className="h-10 lg:h-8" disabled={disabled} onClick={() => void run("approve")} data-testid="proposal-approve">
              {pending === "approve" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Zatwierdź
            </Button>
            <Button size="sm" variant="outline" className="h-10 lg:h-8" disabled={disabled} onClick={() => onEdit(toolCallId, p)}>
              <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden /> Edytuj
            </Button>
            <Button size="sm" variant="ghost" className="h-10 text-muted-foreground lg:h-8" disabled={disabled} onClick={() => void run("reject")} data-testid="proposal-reject">
              {pending === "reject" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Odrzuć
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
