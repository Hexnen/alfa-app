/**
 * Dodatki raportu (v2/v3, docs/PODJAZDY-RAPORTY.md). Przyjazd „z notatki” (hint)
 * od v3 siedzi w werdykcie karty „Co się stało” (PatrolReport.tsx), nie tu.
 * - `RelatedEvents` — inne zdarzenia na obiekcie ±90 min (burze alarmów),
 *   zwinięte, paczki „17 podobnych alarmów”, klik otwiera raport tamtego zdarzenia;
 * - `VideoPatrolSummary` — wideopatrol AI: siatka kamer zamiast 20 kroków.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PatrolEventDetail, PatrolRelatedEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  DASH,
  KIND_META,
  diffMin,
  eventKindOf,
  fmtMinutes,
  fmtTime,
  fmtTimeSec,
  groupRelated,
  pluralEvents,
  similarLabel,
} from "./patrolHelpers";
import type { CameraCheck } from "./stepView";

/* ------------------------------------------------------------------ */
/* Inne zdarzenia na obiekcie ±90 min                                  */
/* ------------------------------------------------------------------ */

function offsetLabel(base: string | null, at: string | null, fromApi?: number | null): string | null {
  const d = fromApi != null ? fromApi : diffMin(base, at);
  if (d == null) return null;
  const r = Math.round(d);
  if (r === 0) return "±0 min";
  return `${r > 0 ? "+" : "−"}${fmtMinutes(Math.abs(r))}`;
}

function KindBadge({ kind, className }: { kind: ReturnType<typeof eventKindOf>; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap rounded px-1 py-px text-[11px] font-semibold ring-1", KIND_META[kind].badge, className)}>
      {KIND_META[kind].short}
    </span>
  );
}

function RelatedRow({
  r,
  base,
  onOpen,
  nested,
}: {
  r: PatrolRelatedEvent;
  base: string | null;
  onOpen?: (id: number) => void;
  nested?: boolean;
}) {
  const kind = eventKindOf(r);
  const off = offsetLabel(base, r.startedAt, r.offsetMin);
  return (
    <li>
      <button
        type="button"
        className={cn("group flex w-full items-center gap-3 rounded px-1.5 py-1 text-left hover:bg-slate-50", nested && "pl-6")}
        onClick={() => onOpen?.(r.id)}
        disabled={!onOpen}
        data-testid="podjazdy-related-item"
        data-kind={kind}
      >
        <span className="tnum w-16 shrink-0 text-[13px] text-slate-700">{fmtTimeSec(r.startedAt)}</span>
        <span className="tnum hidden w-16 shrink-0 whitespace-nowrap text-xs text-slate-400 sm:inline">{off}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {kind !== "alarm" && <KindBadge kind={kind} />}
          <span className="truncate text-[13px] text-slate-700" title={[r.alarmText, r.eventType].filter(Boolean).join(" · ") || undefined}>
            {r.alarmText || r.eventType || DASH}
          </span>
        </span>
        {onOpen && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" aria-hidden />}
      </button>
    </li>
  );
}

export function RelatedEvents({
  detail,
  onOpen,
}: {
  detail: PatrolEventDetail;
  onOpen?: (id: number) => void;
}) {
  const related = detail.related ?? [];
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  if (related.length === 0) return null;
  const groups = groupRelated(related);
  const patrols = related.filter((r) => eventKindOf(r) === "patrol").length;
  const hints = related.filter((r) => eventKindOf(r) === "patrol_hint").length;
  const summary = [
    `${related.length} ${pluralEvents(related.length)}`,
    patrols ? `${patrols} z podjazdem` : null,
    hints ? `${hints} możliwy podjazd` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const times = related.map((r) => r.startedAt).filter(Boolean).sort() as string[];
  const toggleGroup = (i: number) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <div data-testid="podjazdy-related-list">
      <p className="tnum mb-1 text-xs text-slate-500">
        {summary}
        {times.length > 0 && ` · ${fmtTime(times[0])}–${fmtTime(times[times.length - 1])}`}
        {patrols + hints > 0 && " · patrol mógł być podpięty pod inne zdarzenie"}
      </p>
      <ul className="space-y-px">
        {groups.map((g, i) =>
          g.items.length === 1 ? (
            <RelatedRow key={g.items[0].id} r={g.items[0]} base={detail.startedAt} onOpen={onOpen} />
          ) : (
            <li key={`g${i}`}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded px-1.5 py-1 text-left hover:bg-slate-50"
                onClick={() => toggleGroup(i)}
                aria-expanded={openGroups.has(i)}
                data-testid="podjazdy-related-group"
              >
                <span className="tnum w-16 shrink-0 text-[13px] text-slate-700">{fmtTime(g.items[0].startedAt)}</span>
                <span className="min-w-0 flex-1 text-[13px] text-slate-700">
                  {g.kind !== "alarm" && <KindBadge kind={g.kind} className="mr-1.5" />}
                  <span className="font-medium">{similarLabel(g.eventType, g.items.length)}</span>
                  <span className="tnum ml-1.5 text-xs text-slate-500">do {fmtTime(g.items[g.items.length - 1].startedAt)}</span>
                </span>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform", openGroups.has(i) && "rotate-180")} aria-hidden />
              </button>
              {openGroups.has(i) && (
                <ul className="space-y-px">
                  {g.items.map((r) => (
                    <RelatedRow key={r.id} r={r} base={detail.startedAt} onOpen={onOpen} nested />
                  ))}
                </ul>
              )}
            </li>
          )
        )}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Wideopatrol AI                                                      */
/* ------------------------------------------------------------------ */

/**
 * Wideopatrol AI: siatka kamer (w zwijanej sekcji). Wynik, liczba kamer i najniższe
 * podobieństwo są w chipie i linii liczb podsumowania — tu ich nie powtarzamy.
 */
export function VideoPatrolSummary({ checks }: { checks: CameraCheck[] }) {
  const sources = [...new Set(checks.map((c) => c.source).filter(Boolean))];
  const n = checks.length;
  return (
    <div data-testid="podjazdy-report-video">
      {sources.length > 0 && <p className="mb-1.5 text-xs text-slate-500">{sources.join(", ")}</p>}
      {n > 0 && (
        <ul className="grid grid-cols-5 gap-1 sm:grid-cols-9" data-testid="podjazdy-report-cameras">
          {checks.map((c) => (
            <li
              key={c.step.id}
              className={cn("rounded px-1.5 py-0.5 text-center", c.ok ? "bg-slate-50" : "bg-rose-50 ring-1 ring-rose-300")}
              title={`${c.source ? `${c.source}: ` : ""}${c.camera} — obraz ${c.result}`}
            >
              <div className="text-xs font-medium text-slate-700">{c.camera}</div>
              <div
                className={cn(
                  "tnum text-xs",
                  !c.ok ? "font-semibold text-rose-700" : c.similarity != null && c.similarity < 80 ? "font-semibold text-amber-700" : "text-slate-500"
                )}
              >
                {c.ok ? (c.similarity != null ? `${c.similarity}%` : "OK") : c.result}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
