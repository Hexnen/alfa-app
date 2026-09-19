/**
 * Oś czasu wpisów `activity_log` — wspólna dla kalendarza i Kadr.
 *
 * Wyjęta 1:1 z `CalendarEventDialog.tsx` (sekcja „Historia”), żeby dziennik Kadr
 * wyglądał dokładnie tak samo, a nie „prawie tak samo”. Komponent nie zna
 * żadnej domeny: etykiety pól i formatowanie wartości wstrzykuje rodzic przez
 * `fieldLabel` / `formatValue`, a całe zdanie wpisu — przez `describe`.
 *
 * Grupowanie: kolejne wpisy `updated` z tym samym znacznikiem czasu i autorem to
 * JEDNA operacja (backend loguje diff per pole w jednej transakcji) — pokazujemy
 * je jako „zmienił(a) 3 pola” z listą, a nie jako trzy osobne zdarzenia.
 */
import { useMemo, useState } from "react";
import {
  ACTIVITY_FIELD_LABELS,
  activityIcon,
  describeActivity,
  eventStatusLabel,
  eventTypeLabel,
  fmtRelative,
  fmtShort,
  fmtTimestamp,
  initials,
} from "@/lib/calendar-labels";
import type { ActivityEntry } from "@/lib/api";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const plural = (n: number, one: string, few: string, many: string) => {
  if (n === 1) return one;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
  return many;
};

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground",
        className
      )}
    >
      {initials(name)}
    </span>
  );
}

interface HistoryGroup {
  key: string;
  at: string;
  user: string;
  action: string;
  entries: ActivityEntry[];
}

function groupHistory(entries: ActivityEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const sameOp =
      last &&
      last.at === e.createdAt &&
      last.user === (e.userLabel ?? "") &&
      last.action === "updated" &&
      e.action === "updated";
    if (sameOp) last.entries.push(e);
    else
      groups.push({
        key: `g-${e.id}`,
        at: e.createdAt,
        user: e.userLabel ?? "",
        action: e.action,
        entries: [e],
      });
  }
  return groups;
}

/** Domyślne formatowanie wartości pola — reguły kalendarza. */
const defaultFieldValue = (field: string | null, v: string | null): string => {
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
      return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  }
};

export interface ActivityTimelineProps {
  entries: ActivityEntry[];
  /** Całe zdanie wpisu (domyślnie `describeActivity` z calendar-labels). */
  describe?: (entry: ActivityEntry) => string;
  /** Etykieta pola przy zbiorczej zmianie (domyślnie `ACTIVITY_FIELD_LABELS`). */
  fieldLabel?: (field: string) => string;
  /** Formatowanie starej/nowej wartości pola. */
  formatValue?: (field: string | null, value: string | null) => string;
  /**
   * Gotowy opis JEDNEJ zmiany na liście zbiorczej operacji. Kadry podają tu
   * własne zdanie złożone z `summary` (zna nazwy obiektów i działów, których
   * z samego id w `old_value`/`new_value` nie dałoby się odtworzyć na froncie).
   */
  entryDetail?: (entry: ActivityEntry) => string;
  /** Ile grup pokazać na starcie (przycisk „Pokaż więcej” dokłada po 20). */
  initialLimit?: number;
  /** Dodatkowa treść pod wpisem (np. link do pracownika w dzienniku Kadr). */
  renderExtra?: (entry: ActivityEntry) => React.ReactNode;
  emptyText?: string;
}

export function ActivityTimeline({
  entries,
  describe = describeActivity,
  fieldLabel = (f) => ACTIVITY_FIELD_LABELS[f] ?? f,
  formatValue = defaultFieldValue,
  entryDetail,
  initialLimit = 10,
  renderExtra,
  emptyText = "Brak wpisów.",
}: ActivityTimelineProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupHistory(entries), [entries]);
  const visible = groups.slice(0, limit);

  if (groups.length === 0) {
    // Wyśrodkowane jak puste stany kalendarza — pusty dziennik w karcie na całą
    // szerokość wyglądał jak urwane zdanie przyklejone do lewej krawędzi.
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
    );
  }

  // Nagłówki dnia
  let lastDay = "";
  return (
    <div className="space-y-1">
      {visible.map((g) => {
        const day = fmtTimestamp(g.at).slice(0, 10);
        const showDay = day !== lastDay;
        lastDay = day;
        const first = g.entries[0];
        const Icon = activityIcon(g.action);
        const who = g.user || "System";
        const multi = g.entries.length > 1;
        const isOpen = !!expanded[g.key];
        return (
          <div key={g.key}>
            {showDay && (
              <div className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
                {day}
              </div>
            )}
            <div className="flex gap-2.5 py-1">
              <div className="flex flex-col items-center">
                <Avatar name={who} />
                <div className="mt-1 w-px flex-1 bg-border" />
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {multi ? (
                        <span>
                          <span className="font-medium">{who}</span> zmienił(a){" "}
                          {g.entries.length}{" "}
                          {plural(g.entries.length, "pole", "pola", "pól")}
                        </span>
                      ) : (
                        <span>{describe(first)}</span>
                      )}
                    </span>
                    {multi && (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {(isOpen ? g.entries : g.entries.slice(0, 3)).map((e) =>
                          entryDetail ? (
                            <li key={e.id}>{entryDetail(e)}</li>
                          ) : (
                            <li key={e.id}>
                              <span className="text-foreground/80">
                                {e.field ? fieldLabel(e.field) : "pole"}
                              </span>
                              : {formatValue(e.field, e.oldValue)} → {formatValue(e.field, e.newValue)}
                            </li>
                          )
                        )}
                        {g.entries.length > 3 && (
                          <li>
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() =>
                                setExpanded((m) => ({ ...m, [g.key]: !isOpen }))
                              }
                            >
                              {isOpen ? "Zwiń" : `Pokaż wszystkie (${g.entries.length})`}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                    {renderExtra?.(first)}
                  </div>
                  <time
                    dateTime={g.at}
                    {...tip(fmtTimestamp(g.at))}
                    className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                  >
                    {fmtRelative(g.at)}
                  </time>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {groups.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + 20)}
          className="w-full rounded-md border border-dashed py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          Pokaż więcej ({groups.length - limit})
        </button>
      )}
    </div>
  );
}
