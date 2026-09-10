/**
 * SZANSE SPRZEDAŻY — dwa widoki tego samego zbioru.
 *
 * „Lejek” (kanban) odpowiada na pytanie „gdzie stoi praca i co utknęło”:
 * kolumny = etapy, karta = szansa, przeciągnięcie = zmiana etapu. „Lista” to
 * ten sam zbiór w układzie roboczym — z filtrami, sortowaniem i paginacją po
 * stronie backendu (wzorzec `Objects.tsx`), do przeglądu i eksportu wzrokiem.
 *
 * Wybór widoku zostaje w `localStorage`, bo jedni handlowcy pracują tablicą,
 * a inni listą — i nie ma powodu, żeby po każdym wejściu wybierali od nowa.
 *
 * Zamknięcia mają własne dialogi: „przegrany” wymusza powód (inaczej statystyka
 * przegranych jest bezużyteczna), a „wygrany” prowadzi przez założenie
 * kontrahenta i obiektu — kanban nie zamyka szansy po cichu.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  List,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KpiRow, KpiTile } from "@/components/analytics";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { LeadBoard } from "@/components/sales/LeadBoard";
import { LeadConvertDialog } from "@/components/sales/LeadConvertDialog";
import { LeadDialog } from "@/components/sales/LeadDialog";
import { LeadLostDialog } from "@/components/sales/LeadLostDialog";
import { SalesScopeToggle, useSalesScope } from "@/components/sales/SalesScopeToggle";
import { usePerms } from "@/auth/permissions";
import {
  getSalespeople,
  leadsApi,
  salespersonName,
  type Lead,
  type LeadBoardColumn,
  type LeadLostReason,
  type LeadService,
  type LeadSortKey,
  type LeadSource,
  type LeadStage,
  type LeadsSummary,
  type Salesperson,
} from "@/lib/api";
import {
  LEAD_SERVICES,
  LEAD_SERVICE_META,
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  LEAD_STAGE_META,
  leadHref,
  fmtWhen,
  rottingTip,
  stagePillClass,
} from "@/lib/sales-labels";
import { fmtRelative, initials, pillClass } from "@/lib/calendar-labels";
import { tip } from "@/components/ui/tooltip";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

type ViewMode = "board" | "list";

const VIEW_KEY = "alfa.handlowy.leady.view";

const PAGE_SIZE = 50;

/** Domyślny kierunek kolumny — kwoty od największej, terminy od najbliższego. */
const DEFAULT_DIR: Record<LeadSortKey, "asc" | "desc"> = {
  title: "asc",
  stage: "asc",
  estimatedMonthly: "desc",
  expectedCloseDate: "asc",
  lastActivityAt: "desc",
  nextActivityAt: "asc",
  createdAt: "desc",
};

const SOURCES: LeadSource[] = ["polecenie", "www", "formularz", "telefon", "targi", "inne"];

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* prywatne okno — wybór po prostu nie przeżyje przeładowania */
  }
};

/** Pierwszy dzień bieżącego miesiąca (YYYY-MM-DD) — zakres kafelka „Wygrane”. */
const monthStart = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

export function HandlowyLeady() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("handlowy/leady");
  // Zakres „Moje / Wszyscy” jest WSPÓLNY dla całej sekcji Handlowy (jeden klucz
  // `alfa.handlowy.scope`), więc przełącznik na Leadach ustawia to samo, co na
  // Pulpicie, w Aktywnościach i w Kalendarzu.
  const { scope, setScope, salespersonId: mySalespersonId, hidden: scopeHidden } = useSalesScope();

  const [view, setView] = useState<ViewMode>(() =>
    readStored(VIEW_KEY) === "list" ? "list" : "board"
  );

  const [error, setError] = useState<string | null>(null);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);

  // --- filtry (wspólne dla obu widoków tam, gdzie backend je przyjmuje) ---
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<LeadStage | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "all">("all");
  const [serviceFilter, setServiceFilter] = useState<LeadService | "all">("all");
  const [salespersonFilter, setSalespersonFilter] = useState<number | "none" | "all">("all");
  const [onlyRotting, setOnlyRotting] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);

  const [sort, setSort] = useState<LeadSortKey>("lastActivityAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // --- dane ---
  const [columns, setColumns] = useState<LeadBoardColumn[]>([]);
  const [items, setItems] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [listSummary, setListSummary] = useState<LeadsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [kpi, setKpi] = useState<{
    open: LeadsSummary | null;
    wonCount: number;
    wonMonthly: number;
    rotting: number;
    noNext: number;
  }>({ open: null, wonCount: 0, wonMonthly: 0, rotting: 0, noNext: 0 });

  // --- dialogi ---
  const [formOpen, setFormOpen] = useState(false);
  const [formLead, setFormLead] = useState<Lead | null>(null);
  const [formStage, setFormStage] = useState<LeadStage | undefined>(undefined);
  const [formNonce, setFormNonce] = useState(0);
  const [lostLead, setLostLead] = useState<Lead | null>(null);
  const [convertLead, setConvertLead] = useState<Lead | null>(null);

  useEffect(() => writeStored(VIEW_KEY, view), [view]);

  useEffect(() => {
    getSalespeople(true)
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  /** „Moje” = `salespersonId=me`; backend bez dopasowania zwraca pusty zbiór. */
  const scopeParam = scope === "mine" && mySalespersonId ? ("me" as const) : undefined;
  const listSalesperson = scopeParam
    ? scopeParam
    : salespersonFilter === "all"
      ? undefined
      : salespersonFilter === "none"
        ? ("none" as const)
        : [salespersonFilter];

  const filtersKey = [
    search,
    stageFilter,
    sourceFilter,
    serviceFilter,
    String(salespersonFilter),
    scope,
    onlyRotting ? "1" : "",
    includeClosed ? "1" : "",
    sort,
    dir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const loadKpi = useCallback(async () => {
    try {
      const [openRes, pipeRes] = await Promise.all([
        leadsApi.list({ salespersonId: listSalesperson, pageSize: 1 }),
        leadsApi.pipeline({
          salespersonId: scopeParam ? "me" : undefined,
          from: monthStart(),
        }),
      ]);
      setKpi({
        open: openRes.data?.summary ?? null,
        wonCount: pipeRes.data?.won.count ?? 0,
        wonMonthly: pipeRes.data?.won.monthly ?? 0,
        rotting: pipeRes.data?.rotting ?? 0,
        noNext: pipeRes.data?.noNextActivity ?? 0,
      });
    } catch {
      /* KPI to nagłówek, nie treść — brak liczb nie może wywalić ekranu */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await leadsApi.board({
        salespersonId: scopeParam ? "me" : salespersonFilter === "all" || salespersonFilter === "none" ? undefined : [salespersonFilter],
        q: search || undefined,
        service: serviceFilter === "all" ? undefined : serviceFilter,
      });
      setColumns(res.data?.columns ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać lejka.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await leadsApi.list({
        q: search || undefined,
        stage: stageFilter === "all" ? undefined : [stageFilter],
        source: sourceFilter === "all" ? undefined : sourceFilter,
        service: serviceFilter === "all" ? undefined : serviceFilter,
        salespersonId: listSalesperson,
        rotting: onlyRotting || undefined,
        includeClosed: includeClosed || undefined,
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
      setListSummary(res.data?.summary ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać listy szans.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, page]);

  const reload = useCallback(async () => {
    await Promise.all([view === "board" ? loadBoard() : loadList(), loadKpi()]);
  }, [view, loadBoard, loadList, loadKpi]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: LeadSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    stageFilter !== "all" ||
    sourceFilter !== "all" ||
    serviceFilter !== "all" ||
    salespersonFilter !== "all" ||
    onlyRotting ||
    includeClosed;

  const clearFilters = () => {
    setSearchInput("");
    setStageFilter("all");
    setSourceFilter("all");
    setServiceFilter("all");
    setSalespersonFilter("all");
    setOnlyRotting(false);
    setIncludeClosed(false);
  };

  /**
   * Drop karty na inną kolumnę. Zamknięcia idą przez dialogi (powód / konwersja),
   * a zwykła zmiana etapu jest optymistyczna: karta przeskakuje od razu, a przy
   * błędzie wraca tam, skąd ją wzięto.
   */
  const moveLead = async (lead: Lead, stage: LeadStage) => {
    if (!editable) return;
    if (stage === "przegrany") {
      setLostLead(lead);
      return;
    }
    if (stage === "wygrany") {
      setConvertLead(lead);
      return;
    }
    const snapshot = columns;
    setColumns((cols) =>
      cols.map((col) => {
        if (col.stage === lead.stage) {
          return { ...col, count: Math.max(0, col.count - 1), items: col.items.filter((l) => l.id !== lead.id) };
        }
        if (col.stage === stage) {
          return { ...col, count: col.count + 1, items: [{ ...lead, stage }, ...col.items] };
        }
        return col;
      })
    );
    try {
      await leadsApi.setStage(lead.id, { stage });
      setError(null);
      await reload();
    } catch (e) {
      setColumns(snapshot);
      setError(e instanceof Error ? e.message : "Nie udało się zmienić etapu.");
    }
  };

  const confirmLost = async (reason: LeadLostReason, note: string | null) => {
    if (!lostLead) return;
    await leadsApi.setStage(lostLead.id, { stage: "przegrany", lostReason: reason, lostNote: note });
    setLostLead(null);
    await reload();
  };

  const openCreate = (stage?: LeadStage) => {
    setFormLead(null);
    setFormStage(stage);
    setFormNonce((n) => n + 1);
    setFormOpen(true);
  };

  const summaryLine = useMemo(() => {
    const s = view === "list" ? listSummary : null;
    if (!s) return null;
    const parts = [`${s.count} ${s.count === 1 ? "szansa" : "szans"}`];
    parts.push(`abonament ${formatCurrency(s.monthly)}/mies.`);
    if (s.setup > 0) parts.push(`wdrożenie ${formatCurrency(s.setup)}`);
    parts.push(`ważony ${formatCurrency(s.weightedMonthly)}/mies.`);
    parts.push("kwoty netto (bez VAT)");
    return parts.join(" · ");
  }, [view, listSummary]);

  const SortHeader = ({
    label,
    sortKey,
    align = "left",
  }: {
    label: string;
    sortKey: LeadSortKey;
    align?: "left" | "right";
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-2 py-3 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`leady-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leady</h1>
          <p className="text-sm text-muted-foreground">
            Szanse sprzedaży — lejek, wartość i następne kroki
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!scopeHidden && <SalesScopeToggle value={scope} onChange={setScope} />}
          <div className="inline-flex rounded-md border bg-background p-0.5" role="group" aria-label="Widok">
            {(
              [
                ["board", "Lejek", Columns3],
                ["list", "Lista", List],
              ] as [ViewMode, string, typeof List][]
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                data-testid={`leady-view-${key}`}
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors",
                  view === key
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          {editable && (
            <Button onClick={() => openCreate()} data-testid="leady-new">
              <Plus className="mr-2 h-4 w-4" />
              Nowa szansa
            </Button>
          )}
        </div>
      </div>

      {!editable && <ReadOnlyBanner />}

      <KpiRow>
        <KpiTile
          label="Otwarte szanse"
          value={kpi.open?.count ?? 0}
          sub="etapy od Nowy do Negocjacji"
          data-testid="leady-kpi-open"
        />
        <KpiTile
          label="Abonament w lejku"
          value={formatCurrency(kpi.open?.monthly ?? 0)}
          sub="suma MRR otwartych szans"
          data-testid="leady-kpi-monthly"
        />
        <KpiTile
          label="Ważony abonament"
          value={formatCurrency(kpi.open?.weightedMonthly ?? 0)}
          sub="MRR × prawdopodobieństwo"
          tip="Szansa bez uzupełnionego P% liczy się jak zero — lejek nie obiecuje pieniędzy, których nikt nie oszacował."
          data-testid="leady-kpi-weighted"
        />
        <KpiTile
          label="Wdrożenia w lejku"
          value={formatCurrency(kpi.open?.setup ?? 0)}
          sub="jednorazowe, poza abonamentem"
        />
        <KpiTile
          label="Wygrane w tym miesiącu"
          value={kpi.wonCount}
          sub={`${formatCurrency(kpi.wonMonthly)}/mies.`}
          tone={kpi.wonCount > 0 ? "good" : "neutral"}
          data-testid="leady-kpi-won"
        />
        <KpiTile
          label="Wymagają uwagi"
          value={kpi.rotting}
          sub={`bez następnej aktywności: ${kpi.noNext}`}
          tone={kpi.rotting > 0 ? "warn" : "good"}
          tip="Szansa gnije, gdy nie ma zaplanowanego następnego kroku albo od tygodnia nic się w niej nie dzieje."
          data-testid="leady-kpi-rotting"
        />
      </KpiRow>

      {/* Filtry: szukajka i usługa działają w OBU widokach (backend przyjmuje je
          też dla kanbanu); reszta zawęża tylko listę. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj szansy, klienta, miasta…"
            data-testid="leady-filter-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select
          value={serviceFilter}
          onValueChange={(v) => setServiceFilter(v as LeadService | "all")}
        >
          <SelectTrigger className="w-[180px]" data-testid="leady-filter-service">
            <SelectValue placeholder="Usługa" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie usługi</SelectItem>
            {LEAD_SERVICES.map((s) => (
              <SelectItem key={s} value={s}>
                {LEAD_SERVICE_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {scope === "all" && (
          <Select
            value={salespersonFilter === "all" ? "all" : String(salespersonFilter)}
            onValueChange={(v) =>
              setSalespersonFilter(v === "all" ? "all" : v === "none" ? "none" : Number(v))
            }
          >
            <SelectTrigger className="w-[190px]" data-testid="leady-filter-salesperson">
              <SelectValue placeholder="Handlowiec" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Wszyscy handlowcy</SelectItem>
              <SelectItem value="none">Bez opiekuna</SelectItem>
              {salespeople.map((sp) => (
                <SelectItem key={sp.id} value={String(sp.id)}>
                  {salespersonName(sp)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {view === "list" && (
          <>
            <Select value={stageFilter} onValueChange={(v) => setStageFilter(v as LeadStage | "all")}>
              <SelectTrigger className="w-[170px]" data-testid="leady-filter-stage">
                <SelectValue placeholder="Etap" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie etapy</SelectItem>
                {LEAD_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_STAGE_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as LeadSource | "all")}
            >
              <SelectTrigger className="w-[200px]" data-testid="leady-filter-source">
                <SelectValue placeholder="Źródło" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie źródła</SelectItem>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={onlyRotting}
                data-testid="leady-filter-rotting"
                onCheckedChange={(v) => setOnlyRotting(v === true)}
              />
              Tylko wymagające uwagi
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={includeClosed}
                data-testid="leady-filter-closed"
                onCheckedChange={(v) => setIncludeClosed(v === true)}
              />
              Pokaż zamknięte
            </label>
          </>
        )}

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="leady-filters-clear">
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}
        {summaryLine && (
          <p className="ml-auto text-sm text-muted-foreground" data-testid="leady-summary">
            {summaryLine}
          </p>
        )}
      </div>

      {error && (
        <p
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="leady-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {view === "board" ? (
        <LeadBoard
          columns={columns}
          editable={editable}
          loading={loading}
          onOpen={(lead) => navigate(leadHref(lead.id))}
          onMove={moveLead}
          onCreate={editable ? (stage) => openCreate(stage) : undefined}
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-2">
              {loading ? (
                <div className="py-8 text-center text-muted-foreground">Ładowanie…</div>
              ) : items.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  {filtersActive ? "Brak szans dla wybranych filtrów" : "Brak szans sprzedaży"}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <SortHeader label="Tytuł" sortKey="title" />
                        <th className="px-2 py-3 text-left font-medium">Klient</th>
                        <SortHeader label="Etap" sortKey="stage" />
                        <th className="px-2 py-3 text-left font-medium">Handlowiec</th>
                        <SortHeader label="Abonament" sortKey="estimatedMonthly" align="right" />
                        <th className="px-2 py-3 text-right font-medium">Wdrożenie</th>
                        <th className="px-2 py-3 text-right font-medium">P%</th>
                        <SortHeader label="Zamknięcie" sortKey="expectedCloseDate" />
                        <SortHeader label="Następna aktywność" sortKey="nextActivityAt" />
                        <SortHeader label="Ostatni kontakt" sortKey="lastActivityAt" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((lead) => {
                        const rot = rottingTip(lead);
                        return (
                          <tr
                            key={lead.id}
                            className={cn(
                              "border-b hover:bg-muted/50",
                              lead.rotting && "border-l-4 border-l-amber-500"
                            )}
                            data-testid={`leady-row-${lead.id}`}
                          >
                            <td className="px-2 py-3">
                              <button
                                className="text-left font-medium text-primary hover:underline"
                                onClick={() => navigate(leadHref(lead.id))}
                              >
                                {lead.title}
                              </button>
                              {rot && (
                                <span
                                  {...tip(rot)}
                                  className="ml-1.5 inline-flex align-middle text-amber-600 dark:text-amber-400"
                                >
                                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                                  <span className="sr-only">Szansa wymaga uwagi</span>
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-3">{lead.clientLabel || "—"}</td>
                            <td className="px-2 py-3">
                              <span className={stagePillClass(lead.stage)}>
                                {LEAD_STAGE_META[lead.stage]?.label ?? lead.stage}
                              </span>
                            </td>
                            <td className="px-2 py-3">
                              {lead.salespersonName ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase text-muted-foreground">
                                    {initials(lead.salespersonName)}
                                  </span>
                                  {lead.salespersonName}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-right tabular-nums">
                              {lead.estimatedMonthly != null ? (
                                formatCurrency(lead.estimatedMonthly)
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-right tabular-nums">
                              {lead.estimatedSetup != null ? (
                                formatCurrency(lead.estimatedSetup)
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-right tabular-nums">
                              {lead.probability != null ? (
                                `${lead.probability}%`
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-3 tabular-nums">
                              {lead.expectedCloseDate ? (
                                formatDate(lead.expectedCloseDate)
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-3">
                              {lead.nextActivity ? (
                                <span className={pillClass("sky", { compact: true })}>
                                  {fmtWhen(lead.nextActivity.startAt)}
                                </span>
                              ) : (
                                <span className={pillClass("red", { compact: true })}>
                                  Brak następnej
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-muted-foreground">
                              {lead.lastActivityAt ? fmtRelative(lead.lastActivityAt) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2" data-testid="leady-pagination">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" /> Poprzednia
              </Button>
              <span className="text-sm text-muted-foreground">
                Strona {page} z {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Następna <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}

      {formOpen && (
        <LeadDialog
          key={`${formLead?.id ?? "new"}-${formNonce}`}
          open={formOpen}
          mode={formLead ? "edit" : "create"}
          lead={formLead}
          defaultStage={formStage}
          defaultSalespersonId={mySalespersonId}
          onClose={() => setFormOpen(false)}
          onSaved={() => void reload()}
        />
      )}

      {lostLead && (
        <LeadLostDialog
          open
          leadTitle={lostLead.title}
          onClose={() => setLostLead(null)}
          onConfirm={confirmLost}
        />
      )}

      {convertLead && (
        <LeadConvertDialog
          open
          lead={convertLead}
          onClose={() => setConvertLead(null)}
          onConverted={() => {
            setConvertLead(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

export default HandlowyLeady;
