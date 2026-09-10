/**
 * Pulpit handlowca — pierwszy ekran dnia: „co zalega, co mam dziś, co gnije".
 *
 * Wszystkie liczby są cudze: kubełki aktywności liczy `splitActivities` na tych
 * samych danych, co ekran Aktywności, a lejek i wyniki przychodzą gotowe z
 * `GET /leads/stats/pipeline` (front niczego nie dolicza — inaczej pulpit i
 * kanban zaczęłyby się różnić o zaokrąglenia).
 *
 * Wykresy są ręcznym SVG z zestawu `components/analytics`; biblioteki wykresów
 * w repo nie ma i nie dokładamy jej dla jednego paska.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  Handshake,
  ListTodo,
  Plus,
  RefreshCw,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  CalendarEventDialog,
  type CalendarDialogMode,
  type CalendarEventPrefill,
} from "@/components/CalendarEventDialog";
import {
  ActivityList,
  splitActivities,
} from "@/components/sales/ActivityList";
import { SalesScopeToggle, useSalesScope } from "@/components/sales/SalesScopeToggle";
import {
  ChartCard,
  EmptyState,
  KpiRow,
  KpiTile,
  RankBar,
  plnFull,
} from "@/components/analytics";
import {
  calendarApi,
  leadsApi,
  type CalendarEvent,
  type Lead,
  type LeadPipelineStats,
  type LeadStage,
} from "@/lib/api";
import { SALES_CALENDAR } from "@/lib/calendar-config";
import { fmtRelative, pillClass, toDateStr } from "@/lib/calendar-labels";
import {
  LEAD_OPEN_STAGES,
  LEAD_STAGE_META,
  leadHref,
  lostReasonLabel,
  rottingTip,
  stagePillClass,
} from "@/lib/sales-labels";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Ile aktywności mieści się w agendzie, zanim odeślemy na pełną listę. */
const AGENDA_MAX = 10;

/** Kolory słupków lejka — te same rodziny, co pigułki etapów w `sales-labels`. */
const STAGE_COLOR: Record<LeadStage, string> = {
  nowy: "#0ea5e9",
  kontakt: "#6366f1",
  wizja: "#8b5cf6",
  oferta: "#f59e0b",
  negocjacje: "#f97316",
  wygrany: "#10b981",
  przegrany: "#ef4444",
};

const shift = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateStr(d);
};

/** Pierwszy dzień bieżącego miesiąca — granica „wygrane w tym miesiącu". */
const monthStart = (): string => {
  const d = new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
};

export function HandlowyPulpit() {
  const { canEdit } = usePerms();
  // Zakładka pulpitu jest do czytania; planowanie aktywności wymaga tego samego
  // prawa, co kalendarz handlowy (kalendarz ALBO leady) — jak na backendzie.
  const editable = SALES_CALENDAR.editTabs.some((t) => canEdit(t));
  const { scope, setScope, salespersonId, hidden: scopeHidden } = useSalesScope();
  const spFilter = scope === "mine" && salespersonId != null ? [salespersonId] : undefined;

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [pipeline, setPipeline] = useState<LeadPipelineStats | null>(null);
  const [monthWon, setMonthWon] = useState<LeadPipelineStats["won"] | null>(null);
  const [last30, setLast30] = useState<LeadPipelineStats | null>(null);
  const [rotting, setRotting] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<CalendarDialogMode>("create");
  const [dialogEvent, setDialogEvent] = useState<CalendarEvent | null>(null);
  const [dialogPrefill, setDialogPrefill] = useState<CalendarEventPrefill | null>(null);
  const [dialogNonce, setDialogNonce] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [evRes, pipeRes, monthRes, d30Res, rotRes] = await Promise.all([
        calendarApi.getEvents({
          department: "handlowy",
          from: shift(-90),
          to: shift(14),
          ...(spFilter ? { salespersonId: spFilter } : {}),
        }),
        leadsApi.pipeline({ ...(spFilter ? { salespersonId: spFilter } : {}) }),
        leadsApi.pipeline({ ...(spFilter ? { salespersonId: spFilter } : {}), from: monthStart() }),
        leadsApi.pipeline({ ...(spFilter ? { salespersonId: spFilter } : {}), from: shift(-30) }),
        leadsApi.list({
          rotting: true,
          sort: "lastActivityAt",
          dir: "asc",
          pageSize: 10,
          ...(spFilter ? { salespersonId: spFilter } : {}),
        }),
      ]);
      setEvents(evRes.data ?? []);
      setPipeline(pipeRes.data ?? null);
      setMonthWon(monthRes.data?.won ?? null);
      setLast30(d30Res.data ?? null);
      setRotting(rotRes.data?.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nie udało się wczytać pulpitu.");
    } finally {
      setLoading(false);
    }
    // `spFilter` to świeża tablica przy każdym renderze — zależnością jest jej treść.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, salespersonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const buckets = useMemo(() => splitActivities(events), [events]);

  /** Lejek to WYŁĄCZNIE etapy otwarte — wygrane i przegrane są wynikiem, nie kolejką. */
  const funnel = useMemo(() => {
    const byStage = pipeline?.byStage ?? [];
    return LEAD_OPEN_STAGES.map((stage) => {
      const row = byStage.find((r) => r.stage === stage);
      return { stage, count: row?.count ?? 0, monthly: row?.monthly ?? 0, setup: row?.setup ?? 0 };
    });
  }, [pipeline]);

  const openCount = funnel.reduce((s, r) => s + r.count, 0);
  const openMonthly = funnel.reduce((s, r) => s + r.monthly, 0);
  const funnelMax = funnel.reduce((m, r) => Math.max(m, r.monthly), 0);

  const openCreate = useCallback(
    (prefill?: CalendarEventPrefill) => {
      if (!editable) return;
      setDialogMode("create");
      setDialogEvent(null);
      setDialogPrefill(prefill ?? null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  const openEvent = useCallback(
    (ev: CalendarEvent) => {
      setDialogMode(editable && !ev.deletedAt ? "edit" : "view");
      setDialogEvent(ev);
      setDialogPrefill(null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  const topLostReasons = (last30?.lost.byReason ?? []).slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pulpit</h1>
          <p className="text-sm text-muted-foreground">
            Agenda dnia, zaległości i stan lejka sprzedaży
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!scopeHidden && <SalesScopeToggle value={scope} onChange={setScope} />}
          <Button
            variant="outline"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            {...tip("Odśwież pulpit")}
            data-testid="pulpit-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            <span className="sr-only">Odśwież</span>
          </Button>
          {editable && (
            <Button onClick={() => openCreate()} data-testid="pulpit-new-activity">
              <Plus className="mr-2 h-4 w-4" />
              Nowa aktywność
            </Button>
          )}
        </div>
      </div>

      {!editable && <ReadOnlyBanner />}

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="pulpit-error">
          {error}
        </p>
      )}

      <KpiRow>
        <KpiTile
          label="Zaległe"
          value={buckets.overdue.length}
          tone={buckets.overdue.length > 0 ? "bad" : "good"}
          sub="aktywności po terminie"
          tip="Wydarzenia, którym minął termin, a status wciąż nie jest „wykonane”"
          data-testid="pulpit-kpi-overdue"
        />
        <KpiTile
          label="Dziś"
          value={buckets.today.length}
          sub="w agendzie na dzisiaj"
          tip="Aktywności zaplanowane na dziś (i trwające od wcześniej)"
          data-testid="pulpit-kpi-today"
        />
        <KpiTile
          label="Otwarte szanse"
          value={openCount}
          sub={`w tym ${pipeline?.noNextActivity ?? 0} bez następnego kroku`}
          tone={(pipeline?.noNextActivity ?? 0) > 0 ? "warn" : "neutral"}
          tip="Szanse na etapach od „Nowy” do „Negocjacje”"
          data-testid="pulpit-kpi-open"
        />
        <KpiTile
          label="MRR w lejku"
          value={plnFull(openMonthly)}
          sub="abonament netto / mies."
          tip="Suma szacowanego abonamentu miesięcznego otwartych szans (netto)"
          data-testid="pulpit-kpi-mrr"
        />
        <KpiTile
          label="Wygrane w tym miesiącu"
          value={plnFull(monthWon?.monthly ?? 0)}
          sub={`${monthWon?.count ?? 0} ${(monthWon?.count ?? 0) === 1 ? "szansa" : "szans"} · wdrożenia ${plnFull(monthWon?.setup ?? 0)}`}
          tone={(monthWon?.count ?? 0) > 0 ? "good" : "neutral"}
          tip="Szanse przeniesione na etap „Wygrany” od pierwszego dnia bieżącego miesiąca"
          data-testid="pulpit-kpi-won-month"
        />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Agenda na dziś --- */}
        <Card data-testid="pulpit-agenda">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />
              Agenda na dziś
            </CardTitle>
            <Link
              to="/handlowy/aktywnosci"
              className="text-sm font-medium text-primary hover:underline"
              data-testid="pulpit-agenda-more"
            >
              Wszystkie aktywności
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {buckets.overdue.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-destructive" data-testid="pulpit-agenda-overdue-note">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Zaległych: {buckets.overdue.length} — zacznij od nich.
              </p>
            )}
            <ActivityList
              events={buckets.today.slice(0, AGENDA_MAX)}
              grouping="today"
              compact
              onOpen={openEvent}
              {...(editable ? { onDone: () => void load(), onPostpone: () => void load() } : {})}
              testIdPrefix="pulpit-agenda"
              emptyText="Na dziś nic nie zaplanowano — dobry moment, żeby umówić następny krok."
            />
            {buckets.today.length > AGENDA_MAX && (
              <p className="text-xs text-muted-foreground">
                …i jeszcze {buckets.today.length - AGENDA_MAX}. Pełna lista w zakładce Aktywności.
              </p>
            )}
          </CardContent>
        </Card>

        {/* --- Wymagają uwagi (szanse gnijące) --- */}
        <Card data-testid="pulpit-attention">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
              Wymagają uwagi
            </CardTitle>
            <Link
              to="/handlowy/leady"
              className="text-sm font-medium text-primary hover:underline"
              data-testid="pulpit-attention-more"
            >
              Wszystkie szanse
            </Link>
          </CardHeader>
          <CardContent>
            {rotting.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground" data-testid="pulpit-attention-empty">
                Żadna szansa nie czeka bez następnego kroku. Tak ma być.
              </p>
            ) : (
              <ul className="divide-y rounded-md border" data-testid="pulpit-attention-list">
                {rotting.map((lead) => (
                  <li key={lead.id} className="flex items-center gap-2 px-2.5 py-2" data-testid={`pulpit-attention-row-${lead.id}`}>
                    <span
                      className="h-8 w-1 shrink-0 rounded-full bg-amber-500"
                      {...tip(rottingTip(lead) ?? "Szansa wymaga uwagi")}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={leadHref(lead.id)}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {lead.title}
                      </Link>
                      <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <span className={stagePillClass(lead.stage, { compact: true })}>
                          {LEAD_STAGE_META[lead.stage].label}
                        </span>
                        <span className="truncate">{lead.clientLabel}</span>
                        <span aria-hidden>·</span>
                        <span {...tip("Ostatni kontakt (aktywność, notatka, zmiana etapu)")}>
                          {fmtRelative(lead.lastActivityAt)}
                        </span>
                      </div>
                    </div>
                    {lead.estimatedMonthly != null && (
                      <span className={pillClass("muted", { compact: true })}>
                        {plnFull(lead.estimatedMonthly)}/mies.
                      </span>
                    )}
                    {editable && (
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`pulpit-attention-plan-${lead.id}`}
                        {...tip("Zaplanuj następny krok dla tej szansy")}
                        onClick={() =>
                          openCreate({
                            leadId: lead.id,
                            assigneeIds: lead.salespersonId != null ? [lead.salespersonId] : [],
                          })
                        }
                      >
                        Zaplanuj
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Lejek --- */}
        <ChartCard
          title="Lejek"
          description="Abonament miesięczny (netto) i liczba szans na etapach otwartych"
          isEmpty={openCount === 0}
          empty={
            <EmptyState
              icon={Handshake}
              title="Lejek jest pusty"
              description="Dodaj pierwszą szansę, żeby zobaczyć, ile pieniędzy stoi na którym etapie."
              actionLabel="Przejdź do szans"
              actionHref="/handlowy/leady"
            />
          }
          tableData={{
            headers: ["Etap", "Szans", "MRR (zł)", "Wdrożenia (zł)"],
            rows: funnel.map((r) => [
              LEAD_STAGE_META[r.stage].label,
              r.count,
              Math.round(r.monthly),
              Math.round(r.setup),
            ]),
          }}
        >
          <div className="space-y-1" data-testid="pulpit-funnel">
            {funnel.map((r) => (
              <RankBar
                key={r.stage}
                label={LEAD_STAGE_META[r.stage].label}
                subLabel={`${r.count} ${r.count === 1 ? "szansa" : "szans"}`}
                value={r.monthly}
                max={funnelMax}
                valueLabel={plnFull(r.monthly)}
                detail={r.setup > 0 ? `wdrożenia ${plnFull(r.setup)}` : "bez wdrożeń"}
                color={STAGE_COLOR[r.stage]}
              />
            ))}
          </div>
        </ChartCard>

        {/* --- Wygrane / przegrane --- */}
        <Card data-testid="pulpit-results">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="h-4 w-4 text-muted-foreground" aria-hidden />
              Wygrane / przegrane (30 dni)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3" data-testid="pulpit-won-30">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Wygrane</p>
                <p className="mt-1 text-xl font-bold text-emerald-700">{last30?.won.count ?? 0}</p>
                <p className="text-xs text-muted-foreground">
                  {plnFull(last30?.won.monthly ?? 0)} / mies.
                </p>
              </div>
              <div className="rounded-md border p-3" data-testid="pulpit-lost-30">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Przegrane</p>
                <p className="mt-1 text-xl font-bold text-red-600">{last30?.lost.count ?? 0}</p>
                <p className="text-xs text-muted-foreground">
                  {(last30?.won.count ?? 0) + (last30?.lost.count ?? 0) > 0
                    ? `skuteczność ${Math.round(
                        ((last30?.won.count ?? 0) /
                          ((last30?.won.count ?? 0) + (last30?.lost.count ?? 0))) *
                          100
                      )}%`
                    : "brak zamkniętych szans"}
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Najczęstsze powody przegranej
              </p>
              {topLostReasons.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Nic nie przepadło w ostatnich 30 dniach.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1" data-testid="pulpit-lost-reasons">
                  {topLostReasons.map((r) => (
                    <li key={r.reason} className="flex items-center justify-between gap-2 text-sm">
                      <span>{lostReasonLabel(r.reason)}</span>
                      <span className={pillClass("red", { compact: true })}>{r.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListTodo className="h-3.5 w-3.5" aria-hidden />
              Gnijących szans: {pipeline?.rotting ?? 0} · bez następnej aktywności:{" "}
              {pipeline?.noNextActivity ?? 0}
            </p>
          </CardContent>
        </Card>
      </div>

      <CalendarEventDialog
        key={dialogNonce}
        config={SALES_CALENDAR}
        open={dialogOpen}
        mode={dialogMode}
        event={dialogEvent}
        prefill={dialogPrefill}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
        onDeleted={() => void load()}
        onPlanNext={(prefill) => {
          setDialogOpen(false);
          openCreate(prefill);
        }}
      />
    </div>
  );
}
