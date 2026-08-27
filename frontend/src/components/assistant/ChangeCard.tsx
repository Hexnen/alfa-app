import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarSearch,
  Check,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantApplyResult, AssistantBriefEvent, AssistantChangeDiff, AssistantChangeKind, AssistantResolvedChange, CalendarEventStatus } from "@/lib/api";
import { EVENT_STATUS_META, eventTypeLabel, fmtRange } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { changeKey, type ChangeDecision, type PreviewRange } from "./parts";
import { ObjectPeek } from "./ObjectPeek";

// ---------------------------------------------------------------------------
// Meta rodzajów zmian
// ---------------------------------------------------------------------------

const KIND_META: Record<AssistantChangeKind, { icon: LucideIcon; label: string; tone: string; ring: string }> = {
  update: { icon: Pencil, label: "Zmiana", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300", ring: "border-l-sky-500" },
  status: { icon: CheckCircle2, label: "Status", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", ring: "border-l-emerald-500" },
  cancel: { icon: XCircle, label: "Anulowanie", tone: "bg-red-500/15 text-red-700 dark:text-red-300", ring: "border-l-red-500" },
  delete: { icon: Trash2, label: "Usunięcie", tone: "bg-red-500/15 text-red-700 dark:text-red-300", ring: "border-l-red-500" },
  restore: { icon: RotateCcw, label: "Przywrócenie", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300", ring: "border-l-amber-500" },
  create: { icon: Plus, label: "Nowe", tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300", ring: "border-l-violet-500" },
};

const statusLabel = (s: unknown): string => (typeof s === "string" && EVENT_STATUS_META[s as CalendarEventStatus]?.label) || (typeof s === "string" ? s : "");

const rangeOf = (e: AssistantBriefEvent | null | undefined): string => (e?.startAt && e?.endAt ? fmtRange(e.startAt, e.endAt, Boolean(e.allDay)) : "");
const techNames = (e: AssistantBriefEvent | null | undefined): string[] =>
  e?.technicians?.length ? e.technicians.map((t) => t.name) : e?.technicianNames?.length ? e.technicianNames : [];
const techsOf = (e: AssistantBriefEvent | null | undefined): string => techNames(e).join(", ") || (e?.technicianIds?.length ? `${e.technicianIds.length} techn.` : "");
const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Wiersze diffu: z backendu (czytelne etykiety PL) albo — gdy ich brak — wyprowadzone
 * z before/after (termin, status, tytuł, technicy, obiekt, lokalizacja).
 */
function diffRows(c: AssistantResolvedChange): AssistantChangeDiff[] {
  if (c.diff && c.diff.length) return c.diff;
  const b = c.before;
  const a = c.after;
  const rows: AssistantChangeDiff[] = [];
  if (c.kind === "create") return rows;
  if (!a) return rows;
  if (b?.title !== a.title && a.title) rows.push({ field: "Tytuł", from: b?.title ?? null, to: a.title });
  if (rangeOf(b) !== rangeOf(a) && rangeOf(a)) rows.push({ field: "Termin", from: rangeOf(b) || null, to: rangeOf(a) });
  if ((b?.status ?? "") !== (a.status ?? "") && a.status) rows.push({ field: "Status", from: statusLabel(b?.status) || null, to: statusLabel(a.status) });
  if (!sameList(techNames(b), techNames(a))) rows.push({ field: "Technicy", from: techsOf(b) || null, to: techsOf(a) || "bez techników" });
  if ((b?.objectName ?? "") !== (a.objectName ?? "")) rows.push({ field: "Obiekt", from: b?.objectName ?? null, to: a.objectName ?? "—" });
  if ((b?.location ?? "") !== (a.location ?? "")) rows.push({ field: "Lokalizacja", from: b?.location ?? null, to: a.location ?? "—" });
  if ((b?.type ?? "") !== (a.type ?? "") && a.type) rows.push({ field: "Typ", from: b?.type ? eventTypeLabel(b.type) : null, to: eventTypeLabel(a.type) });
  return rows;
}

const fmtVal = (v: AssistantChangeDiff["from"]): string => {
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "tak" : "nie";
  return String(v);
};

/** Termin do widma: after (docelowy) + before (skąd), tylko gdy zmiana dotyka terminu albo tworzy wydarzenie. */
function previewOf(c: AssistantResolvedChange): PreviewRange | null {
  const a = c.after;
  const b = c.before;
  if (c.kind === "delete" || c.kind === "cancel") return null;
  if (!a?.startAt || !a?.endAt) return null;
  const moved = !b || b.startAt !== a.startAt || b.endAt !== a.endAt || Boolean(b.allDay) !== Boolean(a.allDay);
  if (!moved && c.kind !== "create" && c.kind !== "restore") return null;
  return {
    startAt: a.startAt,
    endAt: a.endAt,
    allDay: Boolean(a.allDay),
    technicianIds: a.technicianIds ?? [],
    title: a.title ?? b?.title ?? "",
    type: a.type ?? b?.type,
    eventId: c.eventId ?? b?.id ?? null,
    before: b?.startAt && b?.endAt && moved ? { startAt: b.startAt, endAt: b.endAt, allDay: Boolean(b.allDay), eventId: b.id ?? c.eventId ?? null } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Karta
// ---------------------------------------------------------------------------

export interface ChangeCardProps {
  toolCallId: string;
  changes: AssistantResolvedChange[];
  note?: string;
  /** Decyzje per pozycja (`changeKey(toolCallId, index)`). */
  decisions: Map<string, ChangeDecision>;
  busy?: boolean;
  /** Zatwierdź wybrane pozycje → rodzic woła POST /assistant/apply-changes; zwraca wyniki per index. */
  onApply: (toolCallId: string, indexes: number[]) => Promise<AssistantApplyResult[]>;
  /** Edytuj → rodzic otwiera CalendarEventDialog (edit z prefill / create dla `create`). */
  onEdit: (toolCallId: string, change: AssistantResolvedChange) => void;
  onReject: (toolCallId: string, change: AssistantResolvedChange) => Promise<void>;
  onOpenEvent: (id: number) => void;
  onPreview?: (range: (PreviewRange & { focus?: boolean }) | null, source: string) => void;
}

/**
 * Karta `propose_changes`: paczka zmian w istniejących wydarzeniach — każda pozycja z diffem,
 * ostrzeżeniami i własnymi przyciskami; „Zatwierdź wszystkie” dla całej paczki.
 */
export function ChangeCard({ toolCallId, changes, note, decisions, busy = false, onApply, onEdit, onReject, onOpenEvent, onPreview }: ChangeCardProps) {
  const [pending, setPending] = useState<Map<number, "approve" | "reject">>(() => new Map());
  const [bulk, setBulk] = useState(false);
  const [errors, setErrors] = useState<Map<number, string>>(() => new Map());
  const [hover, setHover] = useState<number | null>(null);

  const decisionOf = (c: AssistantResolvedChange) => decisions.get(changeKey(toolCallId, c.index));
  const actionable = changes.filter((c) => !c.error && !decisionOf(c));
  const disabled = busy || bulk || pending.size > 0;

  const setErr = (i: number, msg: string | null) =>
    setErrors((m) => {
      const n = new Map(m);
      if (msg) n.set(i, msg);
      else n.delete(i);
      return n;
    });

  const applyMany = async (indexes: number[]) => {
    if (!indexes.length) return;
    setPending((m) => {
      const n = new Map(m);
      indexes.forEach((i) => n.set(i, "approve"));
      return n;
    });
    indexes.forEach((i) => setErr(i, null));
    try {
      const results = await onApply(toolCallId, indexes);
      for (const r of results) if (!r.ok) setErr(r.index, r.error || "Nie udało się zastosować zmiany.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Nie udało się zastosować zmian.";
      indexes.forEach((i) => setErr(i, msg));
    } finally {
      setPending((m) => {
        const n = new Map(m);
        indexes.forEach((i) => n.delete(i));
        return n;
      });
    }
  };

  const reject = async (c: AssistantResolvedChange) => {
    setPending((m) => new Map(m).set(c.index, "reject"));
    setErr(c.index, null);
    try {
      await onReject(toolCallId, c);
    } catch (e) {
      setErr(c.index, e instanceof Error ? e.message : "Nie udało się odrzucić zmiany.");
    } finally {
      setPending((m) => {
        const n = new Map(m);
        n.delete(c.index);
        return n;
      });
    }
  };

  const approveAll = async () => {
    setBulk(true);
    try {
      await applyMany(actionable.map((c) => c.index));
    } finally {
      setBulk(false);
    }
  };

  // Widmo before/after: pozycja pod kursorem, a bez hovera — pierwsza pozycja bez decyzji z terminem.
  const previews = useMemo(() => new Map(changes.map((c) => [c.index, previewOf(c)] as const)), [changes]);
  const firstIdx = actionable.find((c) => previews.get(c.index))?.index ?? null;
  const shownIdx = hover != null && previews.get(hover) ? hover : firstIdx;
  const shown = shownIdx != null ? previews.get(shownIdx) ?? null : null;
  const shownKey = shown ? `${shown.startAt}|${shown.endAt}|${shown.before?.startAt ?? ""}|${shown.eventId ?? ""}` : "";
  useEffect(() => {
    if (!onPreview) return;
    if (!shown) {
      onPreview(null, toolCallId);
      return;
    }
    onPreview(shown, toolCallId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zakres opisuje shownKey
  }, [onPreview, toolCallId, shownKey]);
  useEffect(() => () => onPreview?.(null, toolCallId), [onPreview, toolCallId]);

  const n = changes.length;
  const doneCount = changes.filter((c) => decisionOf(c)).length;

  return (
    <div
      className="overflow-hidden rounded-lg border bg-background text-sm shadow-sm"
      role="group"
      aria-label={`Proponowane zmiany (${n})`}
      data-testid="assistant-changes"
      data-toolcall={toolCallId}
      onMouseLeave={() => setHover(null)}
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <ListChecks className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="font-semibold">Proponowane zmiany ({n})</span>
        {doneCount > 0 && doneCount < n && <span className="text-xs text-muted-foreground">{doneCount}/{n} rozstrzygnięte</span>}
        {actionable.length > 1 && (
          <Button size="sm" variant="secondary" className="ml-auto h-10 lg:h-7" disabled={disabled} onClick={() => void approveAll()} data-testid="changes-approve-all">
            {bulk ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
            Zatwierdź wszystkie ({actionable.length})
          </Button>
        )}
      </div>
      {note?.trim() && <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{note.trim()}</p>}

      <ol className="divide-y">
        {changes.map((c) => {
          const meta = KIND_META[c.kind] ?? KIND_META.update;
          const Icon = meta.icon;
          const decision = decisionOf(c);
          const title = c.after?.title || c.before?.title || c.summary || "Wydarzenie";
          const evId = c.eventId ?? c.before?.id ?? c.after?.id ?? null;
          const obj = c.after?.objectName ?? c.before?.objectName ?? null;
          const objId = c.after?.objectId ?? c.before?.objectId ?? null;
          const rows = diffRows(c);
          const reason = (c.reason ?? c.note ?? "").trim();
          const pend = pending.get(c.index) ?? null;
          const err = errors.get(c.index) ?? null;
          const preview = previews.get(c.index);
          const isShown = shownIdx === c.index;
          const canEdit = c.kind === "update" || c.kind === "status" || c.kind === "create";
          const createRange = c.kind === "create" ? rangeOf(c.after) : "";
          return (
            <li
              key={c.index}
              className={cn(
                "relative border-l-[3px] pl-3 pr-3 py-2.5 transition-colors",
                c.error ? "border-l-red-500/70" : meta.ring,
                decision?.status === "rejected" && "opacity-60",
                isShown && !decision && preview && "bg-primary/[0.04]"
              )}
              data-testid="assistant-change"
              data-kind={c.kind}
              data-index={c.index}
              data-decision={decision?.status ?? (c.error ? "error" : "pending")}
              onMouseEnter={() => setHover(c.index)}
            >
              <div className="flex items-start gap-2">
                <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", c.error ? "bg-red-500/15 text-red-700 dark:text-red-300" : meta.tone)} title={meta.label} aria-hidden>
                  {c.error ? <Ban className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{meta.label}</span>
                    {evId != null && c.kind !== "create" && !c.error ? (
                      <button
                        type="button"
                        onClick={() => onOpenEvent(evId)}
                        className="inline-flex min-h-10 min-w-0 max-w-full items-center text-left font-semibold leading-snug underline-offset-2 hover:underline lg:min-h-0"
                        title={`Otwórz wydarzenie #${evId}`}
                      >
                        <span className="truncate">{title}</span>
                      </button>
                    ) : (
                      <span className="min-w-0 max-w-full truncate font-semibold leading-snug">{title}</span>
                    )}
                  </div>
                  {(obj || createRange) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {createRange && <span>{createRange}</span>}
                      {obj && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" aria-hidden />
                          {objId != null ? (
                            <ObjectPeek objectId={objId} title="Podgląd obiektu" className="text-foreground">
                              {obj}
                            </ObjectPeek>
                          ) : (
                            obj
                          )}
                        </span>
                      )}
                    </div>
                  )}

                  {rows.length > 0 && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs" data-testid="change-diff">
                      {rows.map((d, i) => {
                        const from = fmtVal(d.from);
                        const to = fmtVal(d.to);
                        return (
                          <div key={`${d.field}-${i}`} className="contents">
                            <dt className="text-muted-foreground">{d.field}:</dt>
                            <dd className="min-w-0 break-words">
                              {from && <span className="text-muted-foreground line-through decoration-muted-foreground/60">{from}</span>}
                              {from && to && <ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground" aria-hidden />}
                              {!from && to && <span className="mr-0.5 text-muted-foreground">+</span>}
                              {to && <span className="font-medium text-foreground">{to}</span>}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                  {rows.length === 0 && c.summary && !c.error && <p className="text-xs text-foreground/80">{c.summary}</p>}
                  {reason && <p className="text-xs italic text-muted-foreground">{reason}</p>}

                  {c.warnings && c.warnings.length > 0 && decision?.status !== "applied" && (
                    <ul className="space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-200" data-testid="change-warnings">
                      {c.warnings.map((w, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden /> <span className="min-w-0 break-words">{w}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {(c.error || err) && (
                    <div role="alert" className="rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300" data-testid="change-error">
                      {c.error || err}
                    </div>
                  )}

                  {decision?.status === "applied" ? (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
                      <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                        <Check className="h-3.5 w-3.5" aria-hidden /> {decision.edited ? "Zastosowano po edycji" : "Zastosowano"}
                      </span>
                      {(decision.eventId ?? evId) != null && c.kind !== "delete" && (
                        <button type="button" onClick={() => onOpenEvent((decision.eventId ?? evId) as number)} className="inline-flex min-h-10 items-center gap-1 text-primary underline-offset-2 hover:underline lg:min-h-0">
                          <ExternalLink className="h-3 w-3" aria-hidden /> Otwórz wydarzenie
                        </button>
                      )}
                    </div>
                  ) : decision?.status === "rejected" ? (
                    <div className="flex items-center gap-1 pt-0.5 text-xs text-muted-foreground">
                      <X className="h-3.5 w-3.5" aria-hidden /> Odrzucono
                    </div>
                  ) : c.error ? null : (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <Button size="sm" className="h-10 lg:h-7" disabled={disabled} onClick={() => void applyMany([c.index])} data-testid="change-approve">
                        {pend === "approve" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
                        Zatwierdź
                      </Button>
                      {canEdit && (
                        <Button size="sm" variant="outline" className="h-10 lg:h-7" disabled={disabled} onClick={() => onEdit(toolCallId, c)} data-testid="change-edit">
                          <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden /> Edytuj
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-10 text-muted-foreground lg:h-7" disabled={disabled} onClick={() => void reject(c)} data-testid="change-reject">
                        {pend === "reject" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="mr-1 h-3.5 w-3.5" aria-hidden />}
                        Odrzuć
                      </Button>
                      {preview && onPreview && (
                        <button
                          type="button"
                          onClick={() => onPreview({ ...preview, focus: true }, toolCallId)}
                          className="ml-auto inline-flex min-h-10 items-center gap-1 text-xs text-primary underline-offset-2 hover:underline lg:min-h-0"
                          data-testid="change-show-in-calendar"
                        >
                          <CalendarSearch className="h-3 w-3" aria-hidden /> Pokaż
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
