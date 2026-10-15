/**
 * CMA → Podjazdy: zdarzenia z raportów z podjazdów (system monitoringu), które
 * przychodzą mailem albo są wgrywane ręcznie. Lista paginowana po stronie
 * backendu (wzorzec Obiektów: SortHeader, filtersKey, debounce 300 ms), kafelki
 * statystyk dla CAŁEGO wyniku filtrowania i raport per podjazd w panelu bocznym
 * (`?podjazd=<id>` w URL — link da się wysłać dalej). Panel jest nie-modalny:
 * na desktopie lista zwęża się obok niego, wybrany wiersz jest podświetlony,
 * ↑/↓ lub k/j przechodzą po kolejnych (także przez strony paginacji), Esc zamyka.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Car,
  CheckCircle2,
  ChevronsUpDown,
  HelpCircle,
  Loader2,
  Search,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  patrolsApi,
  type PatrolEventKind,
  type PatrolEventRow,
  type PatrolImportResult,
  type PatrolReportImport,
  type PatrolSortKey,
  type PatrolStats,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { PatrolReportPanel } from "@/components/patrols/PatrolReportPanel";
import {
  DASH,
  DEFAULT_KINDS,
  KIND_META,
  KIND_ORDER,
  errMsg,
  eventKindOf,
  extraAnomalies,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  fmtTime,
  isTrue,
  pluralEvents,
  pluralPatrols,
  travelInfo,
} from "@/components/patrols/patrolHelpers";

const PAGE_SIZE = 25;

/** Teksty rosnąco, daty i liczby od największych. */
const DEFAULT_DIR: Record<PatrolSortKey, "asc" | "desc"> = {
  startedAt: "desc",
  objectName: "asc",
  crew: "asc",
  travelMin: "desc",
  delayMin: "desc",
  arrivedAt: "desc",
  city: "asc",
  operator: "asc",
};

const EMPTY_STATS: PatrolStats = { count: 0, late: 0, avgTravelMin: null, crews: [] };

/** Anomalie danych — bez tego, co już mówi chip dojazdu (spóźnienie, brak przyjazdu, sprzeczne godziny). */
const dataAnomalies = (r: PatrolEventRow) => extraAnomalies(r.anomalies, travelInfo(r));

/** ⚠ przy wierszu: anomalia danych z raportu, treść w tooltipie. */
function AnomalyMark({ row }: { row: PatrolEventRow }) {
  const a = dataAnomalies(row);
  if (a.length === 0) return null;
  return (
    <span title={`Niespójne dane w raporcie:\n${a.join("\n")}`} className="inline-flex shrink-0 text-amber-600" aria-label="Niespójne dane w raporcie">
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

/** Druga linia wiersza: miasto · załoga · znaczniki (rodzaj, bez obiektu, ⚠ anomalia, ✓ rozliczony). */
function RowMeta({ row, withCrew }: { row: PatrolEventRow; withCrew?: boolean }) {
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
      {row.city && <span className="truncate">{row.city}</span>}
      {withCrew && (row.crew || row.hintCrew) && (
        <>
          {row.city && <span className="text-slate-300">·</span>}
          <span className="truncate text-slate-600">
            <CrewText row={row} />
          </span>
        </>
      )}
      <KindBadge row={row} />
      {row.objectId == null && (
        <span className="rounded bg-amber-50 px-1 py-px font-medium text-amber-800 ring-1 ring-inset ring-amber-200" data-testid="podjazdy-badge-unmatched">
          bez obiektu
        </span>
      )}
      <AnomalyMark row={row} />
      {row.interventionId != null && (
        <span title="Rozliczony w Grupach interwencyjnych" className="inline-flex text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}

/** Szerokość panelu raportu na desktopie (px): zwykła / rozszerzona; wybór w localStorage. */
const PANEL_W = { normal: 580, wide: 720 } as const;
const PANEL_WIDE_KEY = "podjazdy-panel-wide";
const readWide = () => {
  try {
    return localStorage.getItem(PANEL_WIDE_KEY) === "1";
  } catch {
    return false;
  }
};

/** Skróty panelu nie działają, gdy użytkownik pisze w polu formularza. */
const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || !!el.closest('[role="listbox"],[role="menu"],[role="dialog"]');
};

const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** Znacznik rodzaju na liście — tylko dla tego, co nie jest zwykłym podjazdem. */
function KindBadge({ row, className }: { row: PatrolEventRow; className?: string }) {
  const kind = eventKindOf(row);
  if (kind === "patrol" || kind === "alarm") return null;
  return (
    <span
      className={cn("whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium ring-1", KIND_META[kind].badge, className)}
      data-testid={kind === "patrol_hint" ? "podjazdy-badge-hint" : "podjazdy-badge-video"}
      title={kind === "patrol_hint" ? row.hintText ?? "Wzmianka o patrolu w notatce operatora" : undefined}
    >
      {KIND_META[kind].short}
    </span>
  );
}

/** Załoga z danych albo — przy możliwym podjeździe — z notatki, ze znakiem zapytania. */
function CrewText({ row }: { row: PatrolEventRow }) {
  if (row.crew) return <>{row.crew}</>;
  if (row.hintCrew)
    return (
      <span className="italic text-amber-800" title="Załoga wyczytana z notatki operatora">
        {row.hintCrew}?
      </span>
    );
  return <>{DASH}</>;
}

/**
 * Jeden krótki chip dojazdu (kolor = znaczenie): czerwony spóźnienie, szary w limicie,
 * bursztynowy domysł/błąd danych. Domysły z notatki tylko jako „?” z tooltipem.
 */
function TravelCell({ row, withDelay }: { row: PatrolEventRow; withDelay?: boolean }) {
  const base = "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset";
  if (!isTrue(row.hasPatrol)) {
    const kind = eventKindOf(row);
    if (kind === "patrol_hint")
      return (
        <span className={cn(base, "bg-amber-50 text-amber-800 ring-amber-200")} title={row.hintArrivedAt ? `Wg notatki operatora przyjazd ok. ${fmtTime(row.hintArrivedAt)} — domysł` : "Wzmianka o patrolu w notatce — domysł"}>
          {row.hintArrivedAt ? `ok. ${fmtTime(row.hintArrivedAt)}` : "patrol"}
          <HelpCircle className="h-3 w-3" aria-hidden />
        </span>
      );
    return <span className="text-xs text-slate-400">{kind === "video_patrol" ? "wideopatrol" : "bez wyjazdu"}</span>;
  }
  const info = travelInfo(row);
  const limit = info.limit != null ? `limit ${info.limit} min` : "brak limitu";
  if (info.verdict === "invalid")
    return (
      <span className={cn(base, "bg-amber-50 text-amber-800 ring-amber-200")} title={`Przyjazd zapisany przed wyjazdem — czas dojazdu niewiarygodny (${limit})`} data-verdict="invalid">
        błędne godziny
      </span>
    );
  if (info.verdict === "unknown" || info.travel == null)
    return (
      <span
        className={cn(base, "bg-slate-50 text-slate-500 ring-slate-200")}
        title={row.hintArrivedAt ? `Brak godziny przyjazdu w danych; wg notatki ok. ${fmtTime(row.hintArrivedAt)} (domysł). ${limit}` : `Brak godziny przyjazdu w danych (${limit})`}
        data-verdict="unknown"
      >
        brak przyjazdu
        {row.hintArrivedAt && <HelpCircle className="h-3 w-3 text-amber-600" aria-hidden />}
      </span>
    );
  const late = info.verdict === "late";
  return (
    <span
      className={cn(base, late ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-slate-50 text-slate-700 ring-slate-200")}
      title={`Dojazd ${fmtMinutes(info.travel)}, ${limit}${late && info.delay != null ? ` — spóźnienie ${fmtMinutes(info.delay)}` : ""}`}
      data-verdict={info.verdict}
    >
      {fmtMinutes(info.travel)}
      {withDelay && late && info.delay != null && info.delay > 0 && <span className="font-semibold">+{fmtMinutes(info.delay)}</span>}
    </span>
  );
}

function DelayCell({ row }: { row: PatrolEventRow }) {
  const info = travelInfo(row);
  if (info.verdict === "late") {
    return (
      <span className="font-semibold tabular-nums text-rose-700">
        {info.delay != null && info.delay > 0 ? `+${fmtMinutes(info.delay)}` : "spóźniony"}
      </span>
    );
  }
  if (info.verdict === "ontime") return <span className="text-xs text-emerald-700">w limicie</span>;
  return <span className="text-slate-400">{DASH}</span>;
}

export function CmaPatrols() {
  const { canEdit } = usePerms();
  const editable = canEdit("cma/podjazdy");
  const fileRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();

  const openId = Number(params.get("podjazd")) || null;
  const objectIdParam = Number(params.get("objectId")) || undefined;

  const [rows, setRows] = useState<PatrolEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<PatrolStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  /** Strona, z której pochodzą bieżące `rows` (nawigacja panelu przez granicę strony). */
  const [rowsPage, setRowsPage] = useState(1);
  const pendingNav = useRef<{ page: number; which: "first" | "last" } | null>(null);
  const [wide, setWide] = useState(readWide);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PatrolImportResult | null>(null);
  const [lastImport, setLastImport] = useState<PatrolReportImport | null>(null);

  // Filtry: tekst i daty z debounce, selecty od razu.
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
  const [crew, setCrew] = useState("all");
  const [status, setStatus] = useState<"all" | "late" | "ontime">("all");
  const [matched, setMatched] = useState<"all" | "yes" | "no">("all");
  const [kinds, setKinds] = useState<PatrolEventKind[]>(DEFAULT_KINDS);
  const [sort, setSort] = useState<PatrolSortKey>("startedAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  // Lista załóg do selecta — zbieramy z kolejnych odpowiedzi, żeby wybrana załoga
  // nie znikała z listy, gdy filtr zawęzi statystyki do niej samej.
  const [crewOptions, setCrewOptions] = useState<string[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);
  useEffect(() => {
    const t = setTimeout(() => setPeriod({ from: day(fromInput), to: day(toInput) }), 300);
    return () => clearTimeout(t);
  }, [fromInput, toInput]);

  const kindsKey = kinds.join(",");
  const kindsDefault = kindsKey === DEFAULT_KINDS.join(",");
  const filtersKey = [q, period.from, period.to, crew, status, matched, kindsKey, objectIdParam, sort, dir].join("|");
  const [prevKey, setPrevKey] = useState(filtersKey);
  if (prevKey !== filtersKey) {
    setPrevKey(filtersKey);
    setPage(1);
  }

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await patrolsApi.list({
        q: q || undefined,
        from: period.from,
        to: period.to,
        crew: crew === "all" ? undefined : crew,
        status,
        matched,
        kinds: kindsKey ? (kindsKey.split(",") as PatrolEventKind[]) : undefined,
        objectId: objectIdParam,
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(res.items);
      setRowsPage(page);
      setTotal(res.total);
      // „Następny” na ostatnim wierszu strony → po wczytaniu kolejnej otwórz jej pierwszy wiersz.
      const pend = pendingNav.current;
      if (pend && pend.page === page) {
        pendingNav.current = null;
        const target = pend.which === "first" ? res.items[0] : res.items[res.items.length - 1];
        if (target) {
          setParams(
            (prev) => {
              const sp = new URLSearchParams(prev);
              sp.set("podjazd", String(target.id));
              return sp;
            },
            { replace: true }
          );
        }
      }
      setStats(res.stats);
      setCrewOptions((prev) => {
        const next = new Set(prev);
        res.stats.crews.forEach((c) => c.crew && next.add(c.crew));
        return next.size === prev.length ? prev : [...next].sort((a, b) => a.localeCompare(b, "pl"));
      });
    } catch (e) {
      setLoadError(errMsg(e, "Nie udało się wczytać podjazdów"));
      setRows([]);
      setTotal(0);
      setStats(EMPTY_STATS);
    } finally {
      setLoading(false);
    }
  }, [q, period.from, period.to, crew, status, matched, kindsKey, objectIdParam, sort, dir, page, setParams]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const fetchLastImport = useCallback(async () => {
    try {
      const list = await patrolsApi.reports();
      setLastImport(list[0] ?? null);
    } catch {
      setLastImport(null);
    }
  }, []);
  useEffect(() => {
    void fetchLastImport();
  }, [fetchLastImport]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: PatrolSortKey) => {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(DEFAULT_DIR[key]);
    }
  };

  const filtersActive =
    qInput !== "" ||
    fromInput !== "" ||
    toInput !== "" ||
    crew !== "all" ||
    status !== "all" ||
    matched !== "all" ||
    !kindsDefault ||
    objectIdParam !== undefined;

  const setParam = (key: string, value: string | null) => {
    const sp = new URLSearchParams(params);
    if (value == null) sp.delete(key);
    else sp.set(key, value);
    setParams(sp, { replace: key !== "podjazd" });
  };

  /* Panel: poprzedni / następny wg bieżącej kolejności listy, także przez strony. */
  const openIdx = openId != null && rowsPage === page ? rows.findIndex((r) => r.id === openId) : -1;
  const openRow = (id: number) => setParam("podjazd", String(id));
  const goPrev =
    openIdx > 0
      ? () => openRow(rows[openIdx - 1].id)
      : openIdx === 0 && page > 1
        ? () => {
            pendingNav.current = { page: page - 1, which: "last" };
            setPage(page - 1);
          }
        : null;
  const goNext =
    openIdx >= 0 && openIdx < rows.length - 1
      ? () => openRow(rows[openIdx + 1].id)
      : openIdx === rows.length - 1 && openIdx >= 0 && page < totalPages
        ? () => {
            pendingNav.current = { page: page + 1, which: "first" };
            setPage(page + 1);
          }
        : null;
  const position = openIdx >= 0 ? `${(page - 1) * PAGE_SIZE + openIdx + 1} z ${total}` : null;
  const closePanel = () => setParam("podjazd", null);
  const toggleWide = () =>
    setWide((w) => {
      try {
        localStorage.setItem(PANEL_WIDE_KEY, w ? "0" : "1");
      } catch {
        /* prywatne okno — szerokość tylko na tę sesję */
      }
      return !w;
    });

  // Skróty: ↑/k poprzedni, ↓/j następny, Esc zamyka. Ref → jeden listener na otwarcie panelu.
  const navRef = useRef({ goPrev, goNext, closePanel });
  useEffect(() => {
    navRef.current = { goPrev, goNext, closePanel };
  });
  const panelOpen = openId != null;
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      const nav = navRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        nav.closePanel();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        if (!nav.goNext) return;
        e.preventDefault();
        nav.goNext();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        if (!nav.goPrev) return;
        e.preventDefault();
        nav.goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  // Wybrany wiersz zawsze widoczny na liście (nawigacja klawiszami / przyciskami).
  useEffect(() => {
    if (openId == null) return;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-id="${openId}"]`)].find((x) => x.offsetParent !== null);
    el?.scrollIntoView({ block: "nearest" });
  }, [openId, rows]);

  const panelWidth = wide ? PANEL_W.wide : PANEL_W.normal;

  const clearFilters = () => {
    setQInput("");
    setFromInput("");
    setToInput("");
    setCrew("all");
    setStatus("all");
    setMatched("all");
    setKinds(DEFAULT_KINDS);
    if (objectIdParam !== undefined) setParam("objectId", null);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editable) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await patrolsApi.importFile(file);
      setImportResult(res);
      await Promise.all([fetchRows(), fetchLastImport()]);
    } catch (err) {
      setImportError(errMsg(err, "Nie udało się wgrać raportu"));
    } finally {
      setImporting(false);
    }
  };

  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    className,
  }: {
    label: string;
    sortKey: PatrolSortKey;
    align?: "left" | "right";
    className?: string;
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={cn("font-semibold", align === "right" && "text-right", className)}>
        <button
          type="button"
          data-testid={`podjazdy-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-slate-900",
            align === "right" && "flex-row-reverse",
            active ? "text-slate-900" : "text-slate-500"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
        </button>
      </TableHead>
    );
  };

  const latePct = stats.count > 0 ? Math.round((stats.late / stats.count) * 100) : null;
  const topCrews = [...stats.crews].sort((a, b) => b.count - a.count).slice(0, 3);
  const onlyPatrols = kinds.every((k) => k === "patrol" || k === "patrol_hint");
  const noun = onlyPatrols ? pluralPatrols : pluralEvents;
  /** Klik w chip przełącza rodzaj; ostatniego nie da się odznaczyć (pusta lista = nic). */
  const toggleKind = (k: PatrolEventKind) =>
    setKinds((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      return next.length === 0 ? prev : KIND_ORDER.filter((x) => next.includes(x));
    });
  const kindCount = (k: PatrolEventKind) => stats.kinds?.[k];
  const countHint = stats.kinds
    ? kinds
        .filter((k) => (stats.kinds?.[k] ?? 0) > 0)
        .map((k) => `${KIND_META[k].label.toLowerCase()} ${stats.kinds?.[k]}`)
        .join(" · ")
    : "";

  return (
    <div
      className={cn("space-y-3", panelOpen && "lg:pr-[var(--patrol-panel-w)]")}
      style={{ "--patrol-panel-w": `${panelWidth}px` } as React.CSSProperties}
    >
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} data-testid="podjazdy-upload-input" />

      {/* Pasek górny: zwarta linia statystyk (cały wynik filtrów) + wgrywanie raportu */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="tnum flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-0.5 text-sm text-slate-600" data-testid="podjazdy-stats">
          <span className="whitespace-nowrap" data-testid="podjazdy-stat-count" title={countHint || undefined}>
            <b className="font-semibold text-slate-900">{stats.count.toLocaleString("pl-PL")}</b> {noun(stats.count)}
            {kinds.length > 1 && countHint && !panelOpen && <span className="text-slate-400"> ({countHint})</span>}
          </span>
          <span className="whitespace-nowrap" data-testid="podjazdy-stat-late">
            <b className={cn("font-semibold", stats.late > 0 ? "text-rose-700" : "text-slate-900")}>{stats.late.toLocaleString("pl-PL")}</b> spóźnionych
            {latePct != null && <span className="text-slate-400"> ({latePct}%)</span>}
          </span>
          <span className="whitespace-nowrap" data-testid="podjazdy-stat-avg">
            śr. dojazd <b className="font-semibold text-slate-900">{stats.avgTravelMin != null ? fmtMinutes(stats.avgTravelMin) : DASH}</b>
          </span>
          {topCrews.length > 0 && !panelOpen && (
            <>
                  <span data-testid="podjazdy-stat-crews" title={stats.crews.map((c) => `${c.crew}: ${c.count}`).join("\n")}>
                najczęściej <b className="font-semibold text-slate-900">{topCrews[0].crew}</b> <span className="text-slate-400">({topCrews[0].count})</span>
              </span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-slate-400 sm:inline" data-testid="podjazdy-last-import" title="Raporty przychodzą mailem z systemu monitoringu albo wgrywa się je ręcznie.">
            {lastImport
              ? `ostatni raport ${fmtDateTime(lastImport.receivedAt ?? lastImport.createdAt)} · ${lastImport.source === "mail" ? "z poczty" : "ręcznie"}`
              : "raporty przychodzą mailem"}
          </span>
          {editable && (
            <Button
              size="sm"
              className="h-8 bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              data-testid="podjazdy-upload"
            >
              {importing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
              Wgraj raport
            </Button>
          )}
        </div>
      </div>

      {importError && (
        <Alert variant="destructive" className="border-red-300 bg-red-50" data-testid="podjazdy-upload-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Błąd importu</AlertTitle>
          <AlertDescription className="flex items-start justify-between gap-4">
            <span>{importError}</span>
            <button onClick={() => setImportError(null)} className="shrink-0 text-red-600 hover:text-red-800" title="Zamknij">
              <X className="h-4 w-4" />
            </button>
          </AlertDescription>
        </Alert>
      )}
      {importResult && (
        <div
          className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900"
          data-testid="podjazdy-upload-result"
        >
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>
              Wgrano raport: {importResult.eventsTotal} {pluralEvents(importResult.eventsTotal)} — nowych{" "}
              {importResult.eventsNew}, zaktualizowanych {importResult.eventsUpdated}; w tym {importResult.patrols}{" "}
              {pluralPatrols(importResult.patrols)}.
            </span>
          </span>
          <button onClick={() => setImportResult(null)} className="shrink-0 text-emerald-700 hover:text-emerald-950" title="Zamknij">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Rodzaj + filtry: jeden zawijany rząd */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Rodzaj zdarzenia" data-testid="podjazdy-filter-kind">
          {KIND_ORDER.map((k) => {
            const on = kinds.includes(k);
            const c = kindCount(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleKind(k)}
                aria-pressed={on}
                data-testid={`podjazdy-filter-kind-${k}`}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 ring-inset transition-colors",
                  on ? KIND_META[k].chip : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"
                )}
              >
                {KIND_META[k].label}
                {c != null && <span className={cn("tabular-nums", on ? "text-white/80" : "text-slate-400")}>{c}</span>}
              </button>
            );
          })}
        </div>
        <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" aria-hidden />
        <div className="relative w-full sm:w-52">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Szukaj obiektu, adresu…"
            className="h-8 pl-8 text-sm"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            data-testid="podjazdy-filter-search"
          />
        </div>
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <Input type="date" lang="pl-PL" className="h-8 w-[8.75rem] px-2 text-sm" value={fromInput} onChange={(e) => setFromInput(e.target.value)} title="Od dnia" aria-label="Od dnia" data-testid="podjazdy-filter-from" />
          <span>–</span>
          <Input type="date" lang="pl-PL" className="h-8 w-[8.75rem] px-2 text-sm" value={toInput} onChange={(e) => setToInput(e.target.value)} title="Do dnia" aria-label="Do dnia" data-testid="podjazdy-filter-to" />
        </div>
        <Select value={crew} onValueChange={setCrew}>
          <SelectTrigger className="h-8 w-[168px] text-sm" data-testid="podjazdy-filter-crew">
            <SelectValue placeholder="Załoga" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie załogi</SelectItem>
            {crewOptions.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="h-8 w-[136px] text-sm" data-testid="podjazdy-filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Każdy dojazd</SelectItem>
            <SelectItem value="late">Spóźnione</SelectItem>
            <SelectItem value="ontime">W limicie</SelectItem>
          </SelectContent>
        </Select>
        <Select value={matched} onValueChange={(v) => setMatched(v as typeof matched)}>
          <SelectTrigger className="h-8 w-[136px] text-sm" data-testid="podjazdy-filter-matched">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Każdy obiekt</SelectItem>
            <SelectItem value="yes">Z kartoteki</SelectItem>
            <SelectItem value="no">Bez obiektu</SelectItem>
          </SelectContent>
        </Select>
        {objectIdParam !== undefined && (
          <span className="inline-flex h-8 items-center gap-1 rounded-md bg-indigo-50 px-2.5 text-xs font-medium text-indigo-800 ring-1 ring-inset ring-indigo-200">
            Obiekt #{objectIdParam}
            <button onClick={() => setParam("objectId", null)} aria-label="Usuń filtr obiektu" data-testid="podjazdy-filter-object-clear">
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        {filtersActive && (
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearFilters} data-testid="podjazdy-filters-clear">
            <X className="mr-1 h-3.5 w-3.5" />
            Wyczyść
          </Button>
        )}
      </div>

      {loadError && (
        <Alert variant="destructive" className="border-red-300 bg-red-50" data-testid="podjazdy-load-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {loading && rows.length === 0 ? (
        <div className="py-16 text-center text-slate-500">Ładowanie...</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white py-16 text-center" data-testid="podjazdy-empty">
          {filtersActive ? (
            <p className="text-slate-500">Brak zdarzeń dla wybranych filtrów</p>
          ) : (
            <>
              <Car className="mx-auto h-12 w-12 text-slate-300" />
              <h2 className="mt-4 text-lg font-semibold text-slate-900">Brak podjazdów</h2>
              <p className="mt-1 text-sm text-slate-500">
                Zdarzenia pojawią się po pierwszym raporcie z podjazdów — z poczty albo wgranym ręcznie.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className={cn("overflow-hidden rounded-lg border border-slate-200 bg-white", loading && "opacity-60")}>
          {/* Desktop: tabela (przy otwartym panelu — zwarte wiersze jak na telefonie) */}
          <div className={cn("hidden md:block", panelOpen && "lg:hidden")}>
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <SortHeader label="Data" sortKey="startedAt" />
                  <SortHeader label="Obiekt" sortKey="objectName" />
                  <TableHead className="font-semibold text-slate-500">Zdarzenie</TableHead>
                  <SortHeader label="Załoga" sortKey="crew" />
                  <SortHeader label="Dojazd" sortKey="travelMin" />
                  <SortHeader label="Spóźnienie" sortKey="delayMin" align="right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => openRow(r.id)}
                    data-id={r.id}
                    data-testid="podjazdy-row"
                  >
                    <TableCell className="whitespace-nowrap py-2">
                      <div className="text-sm font-medium tabular-nums text-slate-900">{fmtDate(r.startedAt)}</div>
                      <div className="text-xs tabular-nums text-slate-500">
                        {fmtTime(r.startedAt)}
                        {r.dayPart ? ` · ${r.dayPart}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[300px] py-2">
                      <div className="truncate font-medium text-slate-900" title={r.objectName ?? ""}>
                        {r.objectName?.replace(/\s{2,}/g, " ") || DASH}
                      </div>
                      <RowMeta row={r} />
                    </TableCell>
                    <TableCell className="max-w-[240px] py-2">
                      <div className="truncate text-sm text-slate-700" title={r.alarmText ?? ""}>
                        {r.alarmText || DASH}
                      </div>
                      <div className="truncate text-xs text-slate-500">{r.eventType}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap py-2 text-sm text-slate-700">
                      <CrewText row={r} />
                    </TableCell>
                    <TableCell className="py-2">
                      <TravelCell row={r} />
                    </TableCell>
                    <TableCell className="py-2 text-right text-sm">
                      <DelayCell row={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Telefon i desktop z otwartym panelem: zwarte dwulinijkowe wiersze */}
          <ul className={cn("divide-y divide-slate-100 md:hidden", panelOpen && "lg:block")}>
            {rows.map((r) => {
              const selected = r.id === openId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-start gap-3 px-3 py-2 text-left transition-colors",
                      selected ? "bg-indigo-50 shadow-[inset_3px_0_0_0_theme(colors.indigo.600)]" : "hover:bg-slate-50 active:bg-slate-100"
                    )}
                    onClick={() => openRow(r.id)}
                    aria-current={selected ? "true" : undefined}
                    data-selected={selected ? "true" : undefined}
                    data-id={r.id}
                    data-testid="podjazdy-card"
                  >
                    <div className="w-12 shrink-0 pt-px" title={r.dayPart ?? undefined}>
                      <div className="text-[13px] font-medium tabular-nums text-slate-900">{fmtDate(r.startedAt).slice(0, 5)}</div>
                      <div className="text-xs tabular-nums text-slate-500">{fmtTime(r.startedAt)}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm font-medium leading-5 text-slate-900" title={r.objectName ?? ""}>
                        {r.objectName?.replace(/\s{2,}/g, " ") || DASH}
                      </div>
                      <RowMeta row={r} withCrew />
                    </div>
                    <div className="shrink-0 pt-px">
                      <TravelCell row={r} withDelay />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-200 p-3 sm:p-4" data-testid="podjazdy-pagination">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Poprzednia
              </Button>
              <span className="text-sm text-slate-500">
                Strona {page} z {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                Następna
              </Button>
            </div>
          )}
        </div>
      )}

      {openId != null && (
        <PatrolReportPanel
          eventId={openId}
          editable={editable}
          width={panelWidth}
          wide={wide}
          onToggleWide={toggleWide}
          onClose={closePanel}
          onPrev={goPrev}
          onNext={goNext}
          position={position}
          onChanged={() => void fetchRows()}
          onOpenEvent={openRow}
        />
      )}
    </div>
  );
}
