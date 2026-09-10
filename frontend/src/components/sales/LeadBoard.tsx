/**
 * LEJEK SZANS — kanban z przeciąganiem kart między etapami.
 *
 * DnD jest własne (HTML5 drag&drop), przepisane z idiomu `CalendarBoard.tsx`:
 * ten sam zestaw zdarzeń, ta sama obsługa podświetlenia kolumny i ten sam
 * wzorzec „upuść tutaj”. Osobny komponent, bo kanban szans grupuje po ETAPIE
 * (kolumna = etap lejka), ma własne podsumowania kwotowe w nagłówkach i inne
 * karty — próba sparametryzowania tablicy kalendarza dołożyłaby jej pięć
 * propsów, których dział techniczny nigdy nie użyje.
 *
 * MIME `application/x-alfa-lead` jest inny niż w kalendarzu celowo: karty
 * z dwóch tablic nie mają się nawzajem przyjmować.
 *
 * Kolumny zamknięte (Wygrane/Przegrane) są ZWINIĘTE do wąskiego paska — to
 * archiwum ostatnich 30 dni, a nie kolejny krok pracy; rozwija się je klikiem,
 * ale karty da się na nie upuścić także zwinięte (drop = zamknięcie szansy).
 */
import { useMemo, useState, type DragEvent } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Plus,
  Users,
} from "lucide-react";
import type { Lead, LeadBoardColumn, LeadStage } from "@/lib/api";
import {
  LEAD_OPEN_STAGES,
  LEAD_SERVICE_META,
  LEAD_STAGE_META,
  isClosedStage,
  rottingTip,
  fmtWhen,
} from "@/lib/sales-labels";
import { EVENT_TYPE_META, initials, pillClass } from "@/lib/calendar-labels";
import { tip, tipAttrs } from "@/components/ui/tooltip";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

const DRAG_MIME = "application/x-alfa-lead";

/** Zamknięte etapy w kolejności — wąskie kolumny na końcu tablicy. */
const CLOSED_STAGES: LeadStage[] = ["wygrany", "przegrany"];

export interface LeadBoardProps {
  columns: LeadBoardColumn[];
  editable: boolean;
  loading?: boolean;
  /** Klik w kartę — karta szansy. */
  onOpen: (lead: Lead) => void;
  /**
   * Upuszczenie karty w innej kolumnie. Rodzic robi optymistyczną podmianę
   * i rollback, a dla `przegrany`/`wygrany` otwiera dialog (powód / konwersja).
   */
  onMove: (lead: Lead, stage: LeadStage) => Promise<void> | void;
  /** „+” w nagłówku kolumny — nowa szansa od razu na tym etapie. */
  onCreate?: (stage: LeadStage) => void;
}

export function LeadBoard({
  columns,
  editable,
  loading,
  onOpen,
  onMove,
  onCreate,
}: LeadBoardProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStage, setOverStage] = useState<LeadStage | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);

  const byStage = useMemo(() => {
    const map = new Map<LeadStage, LeadBoardColumn>();
    for (const c of columns) map.set(c.stage, c);
    return map;
  }, [columns]);

  const allLeads = useMemo(() => columns.flatMap((c) => c.items), [columns]);
  const dragged = dragId == null ? null : allLeads.find((l) => l.id === dragId) ?? null;

  const column = (stage: LeadStage): LeadBoardColumn =>
    byStage.get(stage) ?? { stage, count: 0, monthly: 0, setup: 0, items: [] };

  const dragStart = (lead: Lead) => (e: DragEvent<HTMLDivElement>) => {
    if (!editable) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_MIME, String(lead.id));
    e.dataTransfer.setData("text/plain", lead.title);
    e.dataTransfer.effectAllowed = "move";
    setDragId(lead.id);
  };

  const dragEnd = () => {
    setDragId(null);
    setOverStage(null);
  };

  const dragOver = (stage: LeadStage) => (e: DragEvent<HTMLElement>) => {
    if (!editable || dragId === null) return;
    if (dragged?.stage === stage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overStage !== stage) setOverStage(stage);
  };

  const dragLeave = (stage: LeadStage) => (e: DragEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (overStage === stage) setOverStage(null);
  };

  const drop = (stage: LeadStage) => async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setOverStage(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    const id = raw ? Number(raw) : dragId;
    setDragId(null);
    if (!editable || !id) return;
    const lead = allLeads.find((l) => l.id === id);
    if (!lead || lead.stage === stage) return;
    await onMove(lead, stage);
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3" data-testid="lead-board">
      <div
        className={cn(
          "alfa-board flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2",
          "md:grid md:snap-none md:overflow-visible md:[grid-template-columns:repeat(5,minmax(200px,1fr))]",
          loading && "opacity-70"
        )}
        aria-busy={loading || undefined}
      >
        {LEAD_OPEN_STAGES.map((stage) => {
          const col = column(stage);
          const meta = LEAD_STAGE_META[stage];
          const Icon = meta.icon;
          const isOver = overStage === stage;
          const isTarget = dragged ? dragged.stage !== stage : false;
          const rotting = col.items.filter((l) => l.rotting).length;
          return (
            <section
              key={stage}
              data-lead-column={stage}
              aria-label={`${meta.label} — ${col.count}`}
              onDragOver={dragOver(stage)}
              onDragEnter={dragOver(stage)}
              onDragLeave={dragLeave(stage)}
              onDrop={drop(stage)}
              className={cn(
                "flex w-[82vw] shrink-0 snap-start flex-col rounded-lg border bg-muted/30 transition-colors md:w-auto md:min-w-0",
                isTarget && !isOver && "border-dashed border-primary/40",
                isOver && "border-primary bg-primary/5 ring-2 ring-primary/30"
              )}
            >
              <header className="sticky top-0 z-[1] rounded-t-md bg-muted/60 px-2.5 py-2 backdrop-blur-sm">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(pillClass(meta.tone), "min-w-0")}
                    {...tipAttrs({
                      title: meta.label,
                      text: meta.hint,
                      hint: editable ? "Przeciągnij kartę tutaj, by zmienić etap" : undefined,
                    })}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{meta.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {rotting > 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                        {...tip(`${rotting} szans wymaga uwagi`)}
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        {rotting}
                      </span>
                    )}
                    <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                      {col.count}
                    </span>
                    {editable && onCreate && (
                      <button
                        type="button"
                        onClick={() => onCreate(stage)}
                        {...tip(`Nowa szansa na etapie „${meta.label}”`)}
                        data-testid={`lead-board-add-${stage}`}
                        aria-label={`Nowa szansa: ${meta.label}`}
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] tabular-nums text-muted-foreground">
                  {formatCurrency(col.monthly)}/mies.
                  {col.setup > 0 ? ` · wdrożenie ${formatCurrency(col.setup)}` : ""}
                </p>
              </header>
              <div className="flex flex-1 flex-col gap-2 px-2 pb-2 pt-1">
                {col.items.length === 0 && (
                  <p
                    className={cn(
                      "flex min-h-[5rem] items-center justify-center rounded-md border border-dashed px-2 py-4 text-center text-xs text-muted-foreground transition-colors",
                      isOver && "border-primary bg-primary/5 font-medium text-primary"
                    )}
                  >
                    {isOver ? "Upuść tutaj" : dragged && isTarget ? "Przeciągnij tutaj" : "Pusto"}
                  </p>
                )}
                {col.items.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    draggable={editable}
                    dragging={dragId === lead.id}
                    onDragStart={dragStart(lead)}
                    onDragEnd={dragEnd}
                    onOpen={() => onOpen(lead)}
                  />
                ))}
                {col.items.length > 0 && isOver && (
                  <div className="rounded-md border-2 border-dashed border-primary/60 bg-primary/5 px-2 py-3 text-center text-xs font-medium text-primary">
                    Upuść tutaj
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Zamknięcia: wąski pasek po prawej. Zwinięty przyjmuje drop tak samo,
          jak rozwinięty — przeciągnięcie karty NA „Wygrane” otwiera konwersję. */}
      <div
        className={cn(
          "hidden shrink-0 flex-col gap-2 transition-all md:flex",
          closedOpen ? "w-[420px]" : "w-[104px]"
        )}
      >
        <button
          type="button"
          onClick={() => setClosedOpen((o) => !o)}
          data-testid="lead-board-closed-toggle"
          className="inline-flex items-center justify-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {closedOpen ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          Zamknięte (30 dni)
        </button>
        <div className={cn("flex min-h-0 flex-1 gap-2", closedOpen ? "flex-row" : "flex-col")}>
          {CLOSED_STAGES.map((stage) => {
            const col = column(stage);
            const meta = LEAD_STAGE_META[stage];
            const Icon = meta.icon;
            const isOver = overStage === stage;
            const isTarget = dragged ? dragged.stage !== stage : false;
            return (
              <section
                key={stage}
                data-lead-column={stage}
                aria-label={`${meta.label} — ${col.count}`}
                onDragOver={dragOver(stage)}
                onDragEnter={dragOver(stage)}
                onDragLeave={dragLeave(stage)}
                onDrop={drop(stage)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col rounded-lg border bg-muted/30 p-2 transition-colors",
                  isTarget && !isOver && "border-dashed border-primary/40",
                  isOver && "border-primary bg-primary/5 ring-2 ring-primary/30"
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className={cn(pillClass(meta.tone, { compact: true }), "min-w-0")}>
                    <Icon className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">{meta.label}</span>
                  </span>
                  <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                    {col.count}
                  </span>
                </div>
                <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                  {formatCurrency(col.monthly)}/mies.
                </p>
                {closedOpen ? (
                  <div className="mt-2 flex flex-1 flex-col gap-2 overflow-y-auto">
                    {col.items.length === 0 ? (
                      <p className="rounded-md border border-dashed px-2 py-3 text-center text-[11px] text-muted-foreground">
                        {isOver ? "Upuść tutaj" : "Pusto"}
                      </p>
                    ) : (
                      col.items.map((lead) => (
                        <LeadCard
                          key={lead.id}
                          lead={lead}
                          compact
                          draggable={editable}
                          dragging={dragId === lead.id}
                          onDragStart={dragStart(lead)}
                          onDragEnd={dragEnd}
                          onOpen={() => onOpen(lead)}
                        />
                      ))
                    )}
                  </div>
                ) : (
                  <p
                    className={cn(
                      "mt-2 flex flex-1 items-center justify-center rounded-md border border-dashed px-1 text-center text-[10px] text-muted-foreground",
                      isOver && "border-primary bg-primary/5 font-medium text-primary"
                    )}
                  >
                    {isOver ? "Upuść" : dragged && isTarget ? "Tutaj" : "—"}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Karta szansy. „Brak następnej aktywności” jest czerwony — to reguła modułu. */
function LeadCard({
  lead,
  draggable,
  dragging,
  compact,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  lead: Lead;
  draggable: boolean;
  dragging: boolean;
  compact?: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const rot = rottingTip(lead);
  const next = lead.nextActivity;
  const nextMeta = next ? EVENT_TYPE_META[next.type] : null;
  const NextIcon = nextMeta?.icon ?? CalendarClock;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      data-lead-card={lead.id}
      data-rotting={lead.rotting ? "1" : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      {...(rot ? tipAttrs({ title: lead.title, warnings: [rot] }) : tip(lead.clientLabel || lead.title))}
      className={cn(
        "cursor-pointer rounded-md border bg-background p-2 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // Bursztynowa krawędź = szansa gnije. Powód liczy backend (`rotReason`).
        lead.rotting && "border-l-4 border-l-amber-500",
        dragging && "opacity-50"
      )}
    >
      <p className={cn("truncate font-medium", compact ? "text-xs" : "text-sm")}>{lead.title}</p>
      <p className="truncate text-xs text-muted-foreground">{lead.clientLabel || "—"}</p>

      {!compact && lead.services?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {lead.services.map((s) => {
            const meta = LEAD_SERVICE_META[s];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <span key={s} className={pillClass(meta.tone, { compact: true })}>
                <Icon className="h-2.5 w-2.5" aria-hidden />
                {meta.label}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">
          {lead.estimatedMonthly != null ? `${formatCurrency(lead.estimatedMonthly)}/mies.` : "—"}
        </span>
        {lead.probability != null && (
          <span className="text-[11px] tabular-nums text-muted-foreground">{lead.probability}%</span>
        )}
      </div>
      {!compact && lead.estimatedSetup != null && lead.estimatedSetup > 0 && (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          wdrożenie {formatCurrency(lead.estimatedSetup)}
        </p>
      )}

      {!compact && (
        <div className="mt-1.5">
          {next ? (
            <span
              className={pillClass("sky", { compact: true })}
              data-testid={`lead-next-${lead.id}`}
            >
              <NextIcon className="h-2.5 w-2.5" aria-hidden />
              Następna: {fmtWhen(next.startAt)}
            </span>
          ) : !isClosedStage(lead.stage) ? (
            <span
              className={pillClass("red", { compact: true })}
              data-testid={`lead-no-next-${lead.id}`}
            >
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
              Brak następnej aktywności
            </span>
          ) : null}
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">
          {lead.expectedCloseDate ? `zamknięcie ${formatDate(lead.expectedCloseDate)}` : ""}
        </span>
        {lead.salespersonName ? (
          <span
            {...tip(`Opiekun: ${lead.salespersonName}`)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-muted-foreground"
          >
            {initials(lead.salespersonName)}
          </span>
        ) : (
          <span
            {...tip("Szansa bez opiekuna")}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Users className="h-3 w-3" aria-hidden />
          </span>
        )}
      </div>
    </div>
  );
}

export default LeadBoard;
