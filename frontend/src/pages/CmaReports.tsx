import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Cctv,
  ChevronsUpDown,
  FileSpreadsheet,
  Loader2,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cmaApi, type CmaReport, type CmaReportSortKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

function formatCmaDateTime(value: string | null): string {
  // Backend dates come as "YYYY-MM-DD HH:MM:SS".
  if (!value || value.length < 10) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  const time = value.slice(11, 16);
  return `${d}.${m}.${y}${time ? ` ${time}` : ""}`;
}

/** Lista chodzi po stronach — tyle samo raportów na stronę, co dotąd. */
const PAGE_SIZE = 20;

/** Domyślny kierunek sortowania kolumny — daty i liczniki ludzie czytają od najnowszych/największych. */
const DEFAULT_DIR: Record<CmaReportSortKey, "asc" | "desc"> = {
  title: "asc",
  fileName: "asc",
  dateFrom: "desc",
  dateTo: "desc",
  entryCount: "desc",
  importedAt: "desc",
};

export function CmaReports() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("cma/raporty");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [reports, setReports] = useState<CmaReport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Filtry tekstowe trzymamy osobno od tych wysyłanych do API — wpisywanie w pole
  // nie może strzelać żądaniem na każdą literę (debounce niżej).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [range, setRange] = useState<{ min?: number; max?: number }>({});

  const [sort, setSort] = useState<CmaReportSortKey>("importedAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  // Debounce pól tekstowych (szukajka, zakres dat i widełki zdarzeń — pole typu
  // `date` też wysyła zmiany w trakcie wpisywania roku).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const t = setTimeout(() => {
      // Backend przyjmuje wyłącznie pełne „YYYY-MM-DD" — niedokończona data
      // po prostu nie nakłada filtru.
      const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
      setPeriod({ from: day(fromInput), to: day(toInput) });
    }, 300);
    return () => clearTimeout(t);
  }, [fromInput, toInput]);

  useEffect(() => {
    const t = setTimeout(() => {
      const num = (v: string) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : undefined;
      };
      setRange({ min: num(minInput), max: num(maxInput) });
    }, 300);
    return () => clearTimeout(t);
  }, [minInput, maxInput]);

  /**
   * Każda zmiana filtra albo sortowania wraca na pierwszą stronę — inaczej po
   * zawężeniu listy użytkownik ląduje na nieistniejącej stronie. Przestawiamy
   * w trakcie renderu (a nie w efekcie), żeby nie poszło zbędne żądanie o starą
   * stronę z nowym filtrem.
   */
  const filtersKey = [
    search,
    period.from ?? "",
    period.to ?? "",
    range.min ?? "",
    range.max ?? "",
    sort,
    dir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const response = await cmaApi.getReports({
        search: search || undefined,
        dateFrom: period.from,
        dateTo: period.to,
        minEntries: range.min,
        maxEntries: range.max,
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setReports(response.data);
      setTotal(response.total);
      setTotalPages(response.totalPages);
    } catch (error) {
      console.error("Error fetching CMA reports:", error);
    } finally {
      setLoading(false);
    }
  }, [search, period.from, period.to, range.min, range.max, sort, dir, page]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: CmaReportSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    fromInput !== "" ||
    toInput !== "" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearchInput("");
    setFromInput("");
    setToInput("");
    setMinInput("");
    setMaxInput("");
  };

  const handleFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!editable) return;
    const file = event.target.files?.[0];
    // Allow re-selecting the same file next time.
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportError(null);
    try {
      const response = await cmaApi.importReport(file);
      await fetchReports();
      if (response.data) {
        navigate(`/cma/raporty/${response.data.id}`);
      }
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "Nie udało się zaimportować raportu"
      );
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (report: CmaReport) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Czy na pewno chcesz usunąć raport "${report.title}"? Tej operacji nie można cofnąć.`
      )
    ) {
      return;
    }
    try {
      await cmaApi.deleteReport(report.id);
      fetchReports();
    } catch (error) {
      console.error("Error deleting CMA report:", error);
    }
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
  }: {
    label: string;
    sortKey: CmaReportSortKey;
    align?: "left" | "right";
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead
        className={cn("font-semibold", align === "right" && "text-right")}
      >
        <button
          type="button"
          data-testid={`cma-raporty-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-slate-900",
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

  // Kartoteka pusta i BEZ filtrów = ekran powitalny z importem; z filtrami pasek
  // musi zostać, inaczej nie da się cofnąć zawężenia, które schowało wszystko.
  const showFilters = filtersActive || loading || reports.length > 0;

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <input
        ref={fileInputRef}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Import error */}
      {importError && (
        <Alert variant="destructive" className="border-red-300 bg-red-50">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Błąd importu</AlertTitle>
          <AlertDescription className="flex items-start justify-between gap-4">
            <span>{importError}</span>
            <button
              onClick={() => setImportError(null)}
              className="shrink-0 text-red-600 hover:text-red-800"
              title="Zamknij"
            >
              <X className="w-4 h-4" />
            </button>
          </AlertDescription>
        </Alert>
      )}

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Szukaj raportu lub pliku..."
              className="pl-10"
              data-testid="cma-raporty-filter-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          {/* Jeden filtr okresu zamiast dwóch osobnych na daty: pokazujemy raporty,
              których zakres ZACHODZI na podany przedział. Ten sam dzień w obu polach
              = „raport obejmujący dzień", samo drugie pole = „zaczęte do dnia". */}
          <div className="flex items-center gap-1 text-sm text-slate-500">
            <span>Zakres dat od</span>
            <Input
              type="date"
              className="w-[150px]"
              data-testid="cma-raporty-filter-from"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
            />
            <span>do</span>
            <Input
              type="date"
              className="w-[150px]"
              data-testid="cma-raporty-filter-to"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-1 text-sm text-slate-500">
            <span>Zdarzeń od</span>
            <Input
              type="number"
              min="0"
              step="10"
              inputMode="numeric"
              className="w-24 tabular-nums"
              data-testid="cma-raporty-filter-min"
              value={minInput}
              onChange={(e) => setMinInput(e.target.value)}
            />
            <span>do</span>
            <Input
              type="number"
              min="0"
              step="10"
              inputMode="numeric"
              className="w-24 tabular-nums"
              data-testid="cma-raporty-filter-max"
              value={maxInput}
              onChange={(e) => setMaxInput(e.target.value)}
            />
          </div>

          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="cma-raporty-filters-clear"
            >
              <X className="mr-1 h-4 w-4" />
              Wyczyść filtry
            </Button>
          )}

          <p
            className="ml-auto text-sm text-slate-500"
            data-testid="cma-raporty-summary"
          >
            {/* Liczymy CAŁY wynik filtrowania, a nie wczytaną stronę. */}
            {total} {total === 1 ? "raport" : "raportów"}
          </p>
        </div>
      )}

      {/* Reports list */}
      {loading ? (
        <div className="text-center py-16 text-slate-500">Ładowanie...</div>
      ) : reports.length === 0 && filtersActive ? (
        <div className="rounded-lg border border-slate-200 bg-white py-16 text-center text-slate-500">
          Brak raportów dla wybranych filtrów
        </div>
      ) : reports.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 py-16 text-center">
          <Cctv className="w-12 h-12 mx-auto text-slate-300" />
          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            Brak zaimportowanych raportów
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Zaimportuj plik .xls lub .xlsx z raportem z przeglądu kamer, aby
            zobaczyć zestawienie zdarzeń.
          </p>
          {editable && (
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              variant="outline"
              className="mt-4"
            >
              <Upload className="w-4 h-4 mr-2" />
              Importuj pierwszy raport
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {editable && (
            <div className="flex items-center justify-end gap-3 border-b border-slate-200 px-4 py-2">
              <Button
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {importing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importowanie...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Importuj raport
                  </>
                )}
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <SortHeader label="Raport" sortKey="title" />
                <SortHeader label="Plik" sortKey="fileName" />
                <SortHeader label="Zakres od" sortKey="dateFrom" />
                <SortHeader label="Zakres do" sortKey="dateTo" />
                <SortHeader label="Zdarzenia" sortKey="entryCount" align="right" />
                <SortHeader label="Zaimportowano" sortKey="importedAt" />
                {editable && (
                  <TableHead className="font-semibold text-right">
                    Akcje
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow
                  key={report.id}
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => navigate(`/cma/raporty/${report.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <FileSpreadsheet className="w-5 h-5 shrink-0 text-emerald-600" />
                      <div className="font-medium text-slate-900">
                        {report.title}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell
                    className="max-w-[240px] truncate text-xs text-slate-500"
                    title={report.fileName}
                  >
                    {report.fileName}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700 whitespace-nowrap">
                    {formatCmaDateTime(report.dateFrom)}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700 whitespace-nowrap">
                    {formatCmaDateTime(report.dateTo)}
                  </TableCell>
                  <TableCell className="text-right font-medium text-slate-900">
                    {report.entryCount.toLocaleString("pl-PL")}
                  </TableCell>
                  <TableCell className="text-sm text-slate-500 whitespace-nowrap">
                    {formatCmaDateTime(report.importedAt)}
                  </TableCell>
                  {editable && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(report);
                        }}
                        className="text-slate-600 hover:text-red-600"
                        title="Usuń raport"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div
              className="flex items-center justify-between border-t border-slate-200 p-4"
              data-testid="cma-raporty-pagination"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Poprzednia
              </Button>
              <span className="text-sm text-slate-500">
                Strona {page} z {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Następna
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
