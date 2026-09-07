import { Fragment, useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Building2,
  Calendar,
  CameraOff,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  FileSpreadsheet,
  FilterX,
  Loader2,
  Mail,
  Search,
  UserRound,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cmaApi,
  cmaMailApi,
  type CmaCameraIssueObject,
  type CmaCameraIssues,
  type CmaReport,
  type CmaEntrySortKey,
  type CmaReportEntry,
  type CmaReportStats,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

const ENTRIES_PAGE_SIZE = 50;

/**
 * Domyślny kierunek sortowania kolumny listy zdarzeń. Zdarzenia raportu czyta się
 * chronologicznie („co się działo tej doby"), więc czasy startują rosnąco — tak samo,
 * jak lista wyglądała przed dodaniem sortowania; teksty alfabetycznie.
 */
const ENTRY_DEFAULT_DIR: Record<CmaEntrySortKey, "asc" | "desc"> = {
  generatedAt: "asc",
  objectName: "asc",
  patrolName: "asc",
  endType: "asc",
  userName: "asc",
  videoChannel: "asc",
  startedAt: "asc",
  endedAt: "asc",
};
const END_TYPES_VISIBLE = 8;
const AUTO_END_LABEL = "Zakończone automatycznie";

// Dates come from the backend as "YYYY-MM-DD HH:MM:SS".
function cmaDatePart(value: string | null): string {
  if (!value || value.length < 10) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

function cmaTimePart(value: string | null): string {
  if (!value || value.length < 19) return "-";
  return value.slice(11, 19);
}

function formatCmaDateTime(value: string | null): string {
  if (!value || value.length < 10) return "-";
  const time = value.slice(11, 16);
  return `${cmaDatePart(value)}${time ? ` ${time}` : ""}`;
}

function polishPlural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

const DEFAULT_ISSUE_CLASSIFICATION = "Brak obrazu";
const ISSUES_VIEW_PARAM = "brak-obrazu";

/** Kolumny, po których da się sortować listę „Problemy z kamerami”. */
type IssueSortKey =
  | "objectName"
  | "totalCount"
  | "cameras"
  | "firstAt"
  | "lastAt";

/**
 * Domyślny kierunek sortowania kolumny — liczniki od największej wartości,
 * nazwy alfabetycznie, daty tak, jak się o nie pyta: „od kiedy to trwa”
 * (najstarsze pierwsze) i „co się działo ostatnio” (najnowsze pierwsze).
 */
const ISSUE_DEFAULT_DIR: Record<IssueSortKey, "asc" | "desc"> = {
  objectName: "asc",
  totalCount: "desc",
  cameras: "desc",
  firstAt: "asc",
  lastAt: "desc",
};

/** Liczba z pola tekstowego — śmieci traktujemy jak brak filtra. */
function parseCount(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Daty obiektu = skrajne daty jego kamer. Format „YYYY-MM-DD HH:MM:SS”
 * porównuje się leksykalnie, więc nie ma po co budować obiektów Date.
 */
function issueFirstAt(obj: CmaCameraIssueObject): string | null {
  let min: string | null = null;
  for (const c of obj.cameras) {
    if (c.firstAt && (min === null || c.firstAt < min)) min = c.firstAt;
  }
  return min;
}

function issueLastAt(obj: CmaCameraIssueObject): string | null {
  let max: string | null = null;
  for (const c of obj.cameras) {
    if (c.lastAt && (max === null || c.lastAt > max)) max = c.lastAt;
  }
  return max;
}

// Range "pierwsze HH:MM – ostatnie HH:MM" (with dates when spanning days)
function formatIssueTimeRange(
  firstAt: string | null,
  lastAt: string | null
): string {
  if (!firstAt || !lastAt) return "-";
  const time = (v: string) => v.slice(11, 16);
  const sameDay = firstAt.slice(0, 10) === lastAt.slice(0, 10);
  if (sameDay) {
    return `pierwsze ${time(firstAt)} – ostatnie ${time(lastAt)}`;
  }
  return `pierwsze ${cmaDatePart(firstAt)} ${time(firstAt)} – ostatnie ${cmaDatePart(lastAt)} ${time(lastAt)}`;
}

function percentLabel(count: number, total: number): string {
  if (!total) return "0%";
  const value = (count / total) * 100;
  return `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`;
}

type EndTypeGroup = "01" | "02" | "03" | "04" | "05" | "none" | "other";

function endTypeGroup(endType: string | null): EndTypeGroup {
  if (endType === null) return "none";
  if (endType.startsWith("01")) return "01";
  if (endType.startsWith("02")) return "02";
  if (endType.startsWith("03")) return "03";
  if (endType.startsWith("04")) return "04";
  if (endType.startsWith("05")) return "05";
  return "other";
}

const endTypeBarColors: Record<EndTypeGroup, string> = {
  "01": "bg-red-500",
  "02": "bg-green-500",
  "03": "bg-blue-500",
  "04": "bg-purple-500",
  "05": "bg-amber-500",
  none: "bg-slate-300",
  other: "bg-slate-400",
};

function EndTypeBadge({ endType }: { endType: string | null }) {
  const group = endTypeGroup(endType);
  if (group === "none") {
    return (
      <Badge className="border-transparent bg-slate-200 text-slate-600 hover:bg-slate-200">
        auto
      </Badge>
    );
  }
  if (group === "other") {
    return (
      <Badge variant="outline" className="max-w-[240px]" title={endType ?? ""}>
        <span className="truncate">{endType}</span>
      </Badge>
    );
  }
  return (
    <Badge
      className={cn(
        "max-w-[240px] border-transparent text-white",
        endTypeBarColors[group],
        "hover:opacity-90"
      )}
      title={endType ?? ""}
    >
      <span className="truncate">{endType}</span>
    </Badge>
  );
}

function DistributionBar({
  label,
  count,
  total,
  barColor,
}: {
  label: string;
  count: number;
  total: number;
  barColor: string;
}) {
  const width = total ? Math.max((count / total) * 100, 0.5) : 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-52 shrink-0 truncate text-sm text-slate-700 sm:w-64"
        title={label}
      >
        {label}
      </div>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn("h-full rounded-full", barColor)}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="w-32 shrink-0 text-right text-sm text-slate-600">
        <span className="font-medium text-slate-900">
          {count.toLocaleString("pl-PL")}
        </span>{" "}
        ({percentLabel(count, total)})
      </div>
    </div>
  );
}

export function CmaReportDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("cma/raporty");
  const reportId = id ? parseInt(id, 10) : NaN;

  const [report, setReport] = useState<CmaReport | null>(null);
  const [stats, setStats] = useState<CmaReportStats | null>(null);
  const [loading, setLoading] = useState(true);

  const [entries, setEntries] = useState<CmaReportEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [entriesTotal, setEntriesTotal] = useState(0);
  const [entriesTotalPages, setEntriesTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [objectFilter, setObjectFilter] = useState("all");
  const [endTypeFilter, setEndTypeFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  // „Kto zamknął zdarzenie": all | operator (jest nazwisko) | auto (brak nazwiska).
  const [handledFilter, setHandledFilter] = useState("all");
  // Kanałów w raporcie są setki, więc opcje selecta bierzemy z backendu — zawężone
  // tymi samymi filtrami, co lista (statystyki raportu ich nie mają).
  const [channelOptions, setChannelOptions] = useState<string[]>([]);
  const [entrySort, setEntrySort] = useState<CmaEntrySortKey>("generatedAt");
  const [entryDir, setEntryDir] = useState<"asc" | "desc">(
    ENTRY_DEFAULT_DIR.generatedAt
  );

  const [showAllEndTypes, setShowAllEndTypes] = useState(false);

  // View toggle kept in the URL so it survives a refresh
  const [searchParams, setSearchParams] = useSearchParams();
  const view =
    searchParams.get("view") === ISSUES_VIEW_PARAM ? "issues" : "overview";

  const setView = (next: "overview" | "issues") => {
    setSearchParams(
      (params) => {
        if (next === "issues") {
          params.set("view", ISSUES_VIEW_PARAM);
        } else {
          params.delete("view");
        }
        return params;
      },
      { replace: true }
    );
  };

  // Camera issues view ("Brak obrazu") - fetched lazily on first visit
  const [issuesData, setIssuesData] = useState<CmaCameraIssues | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issueClassification, setIssueClassification] = useState(
    DEFAULT_ISSUE_CLASSIFICATION
  );
  const [noImageObjectCount, setNoImageObjectCount] = useState<number | null>(
    null
  );

  // Filtry i sortowanie listy problemów — liczone po stronie klienta na tym,
  // co przyszło z API dla wybranej klasyfikacji (bez debounce'u: nie ma
  // żądania do odciążenia). NIE dotykają `issuesData`: wysyłka e-mailem idzie
  // przez backend z samą klasyfikacją, więc serwis dostaje pełne zestawienie
  // niezależnie od tego, co użytkownik sobie tutaj zawęził.
  const [issueSearch, setIssueSearch] = useState("");
  const [issueMinCount, setIssueMinCount] = useState("");
  const [issueMaxCount, setIssueMaxCount] = useState("");
  const [issueSort, setIssueSort] = useState<IssueSortKey>("totalCount");
  const [issueDir, setIssueDir] = useState<"asc" | "desc">(
    ISSUE_DEFAULT_DIR.totalCount
  );

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleIssueSort = (key: IssueSortKey) => {
    if (issueSort === key) {
      setIssueDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setIssueSort(key);
    setIssueDir(ISSUE_DEFAULT_DIR[key]);
  };

  const issueFiltersActive =
    issueSearch !== "" || issueMinCount !== "" || issueMaxCount !== "";

  const clearIssueFilters = () => {
    setIssueSearch("");
    setIssueMinCount("");
    setIssueMaxCount("");
  };

  // Sending the issue list via e-mail
  const [issuesSending, setIssuesSending] = useState(false);
  const [issuesSendResult, setIssuesSendResult] = useState<string | null>(null);
  const [issuesSendError, setIssuesSendError] = useState<string | null>(null);

  const handleSendIssues = async () => {
    if (!editable) return;
    if (!reportId) return;
    setIssuesSending(true);
    setIssuesSendResult(null);
    setIssuesSendError(null);
    try {
      const res = await cmaMailApi.sendIssues(reportId, {
        classification: issueClassification,
      });
      setIssuesSendResult(
        res.message || "Wysłano zestawienie e-mailem."
      );
    } catch (error) {
      setIssuesSendError(
        error instanceof Error && error.message
          ? error.message
          : "Nie udało się wysłać zestawienia e-mailem."
      );
    } finally {
      setIssuesSending(false);
    }
  };

  useEffect(() => {
    if (view !== "issues" || !reportId) return;
    let cancelled = false;
    setIssuesLoading(true);
    setIssuesError(null);
    cmaApi
      .getCameraIssues(reportId, issueClassification)
      .then((res) => {
        if (cancelled || !res.data) return;
        setIssuesData(res.data);
        if (res.data.classification === DEFAULT_ISSUE_CLASSIFICATION) {
          setNoImageObjectCount(res.data.issues.length);
        }
      })
      .catch((error) => {
        console.error("Error fetching CMA camera issues:", error);
        if (!cancelled) {
          setIssuesError(
            "Nie udało się pobrać zestawienia problemów z kamerami."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIssuesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reportId, issueClassification]);

  useEffect(() => {
    if (!reportId) return;
    setLoading(true);
    cmaApi
      .getReport(reportId)
      .then((res) => {
        if (res.data) {
          setReport(res.data.report);
          setStats(res.data.stats);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [reportId]);

  // Szukajka z debounce'em — wpisywanie nie może strzelać żądaniem na każdą literę.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /**
   * Każda zmiana filtra albo sortowania wraca na pierwszą stronę — inaczej po
   * zawężeniu listy użytkownik ląduje na nieistniejącej stronie. Przestawiamy
   * w trakcie renderu (a nie w efekcie), żeby nie poszło zbędne żądanie o starą
   * stronę z nowym filtrem.
   */
  const filtersKey = [
    search,
    objectFilter,
    endTypeFilter,
    userFilter,
    channelFilter,
    handledFilter,
    entrySort,
    entryDir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const fetchEntries = useCallback(async () => {
    if (!reportId) return;
    setEntriesLoading(true);
    try {
      const response = await cmaApi.getReportEntries(reportId, {
        page,
        pageSize: ENTRIES_PAGE_SIZE,
        search: search || undefined,
        objectName: objectFilter !== "all" ? objectFilter : undefined,
        endType: endTypeFilter !== "all" ? endTypeFilter : undefined,
        userName: userFilter !== "all" ? userFilter : undefined,
        videoChannel: channelFilter !== "all" ? channelFilter : undefined,
        handled:
          handledFilter === "operator" || handledFilter === "auto"
            ? handledFilter
            : undefined,
        sort: entrySort,
        dir: entryDir,
      });
      setEntries(response.data);
      setEntriesTotal(response.total);
      setEntriesTotalPages(response.totalPages);
      // Wybrany kanał zostaje na liście, nawet gdy reszta filtrów go wycięła —
      // inaczej select pokazywałby pustkę i nie dało się go cofnąć.
      setChannelOptions(
        channelFilter !== "all" && !response.channels.includes(channelFilter)
          ? [channelFilter, ...response.channels]
          : response.channels
      );
      setExpandedId(null);
    } catch (error) {
      console.error("Error fetching CMA report entries:", error);
    } finally {
      setEntriesLoading(false);
    }
  }, [
    reportId,
    page,
    search,
    objectFilter,
    endTypeFilter,
    userFilter,
    channelFilter,
    handledFilter,
    entrySort,
    entryDir,
  ]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const hasActiveFilters =
    searchInput !== "" ||
    objectFilter !== "all" ||
    endTypeFilter !== "all" ||
    userFilter !== "all" ||
    channelFilter !== "all" ||
    handledFilter !== "all";

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setObjectFilter("all");
    setEndTypeFilter("all");
    setUserFilter("all");
    setChannelFilter("all");
    setHandledFilter("all");
  };

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleEntrySort = (key: CmaEntrySortKey) => {
    if (entrySort === key) {
      setEntryDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setEntrySort(key);
    setEntryDir(ENTRY_DEFAULT_DIR[key]);
  };

  if (loading) {
    return <div className="text-center py-8">Ładowanie...</div>;
  }

  if (!report) {
    return (
      <div className="text-center py-8 space-y-4">
        <p>Raport nie znaleziony</p>
        <Button variant="outline" onClick={() => navigate("/cma/raporty")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Wróć do listy raportów
        </Button>
      </div>
    );
  }

  const autoEnded = stats ? stats.entryCount - stats.operatorHandled : 0;
  const sortedEndTypes = stats
    ? [...stats.byEndType].sort((a, b) => b.count - a.count)
    : [];
  const visibleEndTypes = showAllEndTypes
    ? sortedEndTypes
    : sortedEndTypes.slice(0, END_TYPES_VISIBLE);
  const hiddenEndTypesCount = sortedEndTypes.length - END_TYPES_VISIBLE;
  const topObjects = stats ? stats.byObject.slice(0, 10) : [];

  // Filtry i sortowanie robimy na kopii listy — `issuesData` zostaje nietknięte,
  // bo to ono jest podstawą wysyłki e-mailem (a właściwie: backend liczy ją
  // jeszcze raz z samej klasyfikacji, więc filtry ekranu nic w mailu nie zmienią).
  const issueTerm = issueSearch.trim().toLowerCase();
  const issueMin = parseCount(issueMinCount);
  const issueMax = parseCount(issueMaxCount);
  const issueMul = issueDir === "asc" ? 1 : -1;

  const issueObjects = (issuesData?.issues ?? [])
    .filter((obj) => {
      if (issueMin !== undefined && obj.totalCount < issueMin) return false;
      if (issueMax !== undefined && obj.totalCount > issueMax) return false;
      if (
        issueTerm &&
        ![obj.objectName, obj.address]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(issueTerm))
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const compare = (): number => {
        if (issueSort === "objectName") {
          return a.objectName.localeCompare(b.objectName, "pl") * issueMul;
        }
        if (issueSort === "firstAt" || issueSort === "lastAt") {
          const pick = (o: CmaCameraIssueObject) =>
            issueSort === "firstAt" ? issueFirstAt(o) : issueLastAt(o);
          const av = pick(a);
          const bv = pick(b);
          // Obiekty bez dat lądują na końcu w OBU kierunkach (NULLS LAST) —
          // inaczej „sortuj po najwcześniejszym” zaczynałoby się od pustych.
          if (!av || !bv) {
            if (!av && !bv) return 0;
            return av ? -1 : 1;
          }
          return av < bv ? -1 * issueMul : av > bv ? issueMul : 0;
        }
        const value = (o: CmaCameraIssueObject) =>
          issueSort === "totalCount" ? o.totalCount : o.cameras.length;
        return (value(a) - value(b)) * issueMul;
      };
      return compare() || a.objectName.localeCompare(b.objectName, "pl");
    });

  const issueEventTotal = issueObjects.reduce((sum, o) => sum + o.totalCount, 0);
  const issueCameraTotal = issueObjects.reduce(
    (sum, o) => sum + o.cameras.length,
    0
  );

  /**
   * Nagłówek klikalny — lista problemów to karty, a nie tabela, więc nagłówki
   * siedzą w pasku nad nią; strzałka pokazuje kolumnę i kierunek sortowania.
   */
  const IssueSortHeader = ({
    label,
    sortKey,
    title,
  }: {
    label: string;
    sortKey: IssueSortKey;
    title?: string;
  }) => {
    const activeCol = issueSort === sortKey;
    const Icon = !activeCol
      ? ChevronsUpDown
      : issueDir === "asc"
        ? ArrowUp
        : ArrowDown;
    return (
      <button
        type="button"
        data-testid={`cma-problemy-sort-${sortKey}`}
        onClick={() => toggleIssueSort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs uppercase tracking-wide transition-colors hover:text-slate-900",
          activeCol ? "text-slate-900" : "text-slate-500"
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
      </button>
    );
  };

  /**
   * Przycisk sortowania listy zdarzeń. Osobno od nagłówka, bo dwie kolumny niosą po
   * dwie sortowalne wartości (czas zdarzenia + czas obchodu, obchód + kanał wideo).
   */
  const EntrySortButton = ({
    label,
    sortKey,
    title,
    className,
  }: {
    label: string;
    sortKey: CmaEntrySortKey;
    title?: string;
    className?: string;
  }) => {
    const activeCol = entrySort === sortKey;
    const Icon = !activeCol
      ? ChevronsUpDown
      : entryDir === "asc"
        ? ArrowUp
        : ArrowDown;
    return (
      <button
        type="button"
        data-testid={`cma-zdarzenia-sort-${sortKey}`}
        onClick={() => toggleEntrySort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-slate-900",
          activeCol ? "text-slate-900" : "text-slate-500",
          className
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
      </button>
    );
  };

  /** Nagłówek kolumny z jednym kluczem sortowania. */
  const EntrySortHeader = ({
    label,
    sortKey,
  }: {
    label: string;
    sortKey: CmaEntrySortKey;
  }) => (
    <TableHead className="font-semibold">
      <EntrySortButton label={label} sortKey={sortKey} />
    </TableHead>
  );

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {/* Header */}
      <div className="flex items-start gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/cma/raporty")}
          title="Wróć do listy raportów"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-slate-900">{report.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-500">
            <span className="flex items-center gap-1.5">
              <FileSpreadsheet className="w-4 h-4" />
              {report.fileName}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              {formatCmaDateTime(report.dateFrom)}
              {" – "}
              {formatCmaDateTime(report.dateTo)}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Zaimportowano: {formatCmaDateTime(report.importedAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500 mb-2">
                <Video className="w-4 h-4" />
                Zdarzenia
              </CardTitle>
              <div className="text-2xl font-bold text-slate-900">
                {stats.entryCount.toLocaleString("pl-PL")}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500 mb-2">
                <Building2 className="w-4 h-4" />
                Obiekty
              </CardTitle>
              <div className="text-2xl font-bold text-slate-900">
                {stats.objectCount.toLocaleString("pl-PL")}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500 mb-2">
                <UserRound className="w-4 h-4" />
                Obsłużone przez operatora
              </CardTitle>
              <div className="text-2xl font-bold text-indigo-600">
                {stats.operatorHandled.toLocaleString("pl-PL")}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {stats.userCount.toLocaleString("pl-PL")} operatorów (
                {percentLabel(stats.operatorHandled, stats.entryCount)}{" "}
                zdarzeń)
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500 mb-2">
                <Clock className="w-4 h-4" />
                Zakończone automatycznie
              </CardTitle>
              <div className="text-2xl font-bold text-slate-600">
                {autoEnded.toLocaleString("pl-PL")}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {percentLabel(autoEnded, stats.entryCount)} zdarzeń
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <Button
          variant={view === "overview" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("overview")}
        >
          <BarChart3 className="mr-2 h-4 w-4" />
          Przegląd
        </Button>
        <Button
          variant={view === "issues" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("issues")}
        >
          <CameraOff className="mr-2 h-4 w-4" />
          Brak obrazu
          {noImageObjectCount !== null && (
            <Badge
              variant="secondary"
              className={cn(
                "ml-2 px-1.5",
                view === "issues" && "bg-white/20 text-white hover:bg-white/20"
              )}
            >
              {noImageObjectCount.toLocaleString("pl-PL")}
            </Badge>
          )}
        </Button>
      </div>

      {/* End type distribution */}
      {view === "overview" && stats && sortedEndTypes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-indigo-600" />
              Rodzaje zakończenia
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {visibleEndTypes.map((item) => (
              <DistributionBar
                key={item.endType ?? "__none__"}
                label={item.endType ?? AUTO_END_LABEL}
                count={item.count}
                total={stats.entryCount}
                barColor={endTypeBarColors[endTypeGroup(item.endType)]}
              />
            ))}
            {hiddenEndTypesCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-500"
                onClick={() => setShowAllEndTypes((v) => !v)}
              >
                {showAllEndTypes ? (
                  <>
                    <ChevronDown className="mr-2 h-4 w-4 rotate-180" />
                    Pokaż mniej
                  </>
                ) : (
                  <>
                    <ChevronDown className="mr-2 h-4 w-4" />
                    Pokaż pozostałe ({hiddenEndTypesCount})
                  </>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Most active objects */}
      {view === "overview" && stats && topObjects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-indigo-600" />
              Najaktywniejsze obiekty
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topObjects.map((item) => (
              <DistributionBar
                key={item.objectName}
                label={item.objectName}
                count={item.count}
                total={stats.entryCount}
                barColor="bg-indigo-500"
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Entries */}
      {view === "overview" && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Video className="h-5 w-5 text-indigo-600" />
            Zdarzenia
            <span className="ml-1 text-sm font-normal text-slate-500">
              ({entriesTotal.toLocaleString("pl-PL")})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Szukaj w zdarzeniach..."
                data-testid="cma-zdarzenia-filter-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={objectFilter} onValueChange={setObjectFilter}>
              <SelectTrigger
                className="w-64"
                data-testid="cma-zdarzenia-filter-object"
              >
                <SelectValue placeholder="Obiekt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie obiekty</SelectItem>
                {stats?.byObject.map((item) => (
                  <SelectItem key={item.objectName} value={item.objectName}>
                    {item.objectName} ({item.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={endTypeFilter} onValueChange={setEndTypeFilter}>
              <SelectTrigger
                className="w-72"
                data-testid="cma-zdarzenia-filter-endtype"
              >
                <SelectValue placeholder="Rodzaj zakończenia" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie rodzaje</SelectItem>
                {sortedEndTypes
                  .filter((item) => item.endType !== "")
                  .map((item) => (
                    <SelectItem
                      key={item.endType ?? "__none__"}
                      value={item.endType ?? "__none__"}
                    >
                      {item.endType ?? AUTO_END_LABEL} ({item.count})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {/* Operatorów w raporcie jest kilku — listę mamy w statystykach raportu. */}
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger
                className="w-56"
                data-testid="cma-zdarzenia-filter-user"
              >
                <SelectValue placeholder="Operator" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszyscy operatorzy</SelectItem>
                {stats?.byUser.map((item) => (
                  <SelectItem key={item.userName} value={item.userName}>
                    {item.userName} ({item.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Kanały bierzemy z odpowiedzi listy — zawężają się razem z resztą filtrów. */}
            <Select value={channelFilter} onValueChange={setChannelFilter}>
              <SelectTrigger
                className="w-56"
                data-testid="cma-zdarzenia-filter-channel"
              >
                <SelectValue placeholder="Kanał wideo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie kanały</SelectItem>
                {channelOptions.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {channel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={handledFilter} onValueChange={setHandledFilter}>
              <SelectTrigger
                className="w-56"
                data-testid="cma-zdarzenia-filter-handled"
              >
                <SelectValue placeholder="Obsługa" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Obsłużone i automatyczne</SelectItem>
                <SelectItem value="operator">
                  Tylko obsłużone przez operatora
                </SelectItem>
                <SelectItem value="auto">
                  Tylko zakończone automatycznie
                </SelectItem>
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                data-testid="cma-zdarzenia-filters-clear"
              >
                <FilterX className="mr-2 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          {/* Entries table */}
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="w-8" />
                  <TableHead className="font-semibold">
                    <div className="flex items-center gap-3">
                      <EntrySortButton label="Czas" sortKey="generatedAt" />
                      {/* Wpis niesie też czas obchodu (widoczny po rozwinięciu wiersza). */}
                      <EntrySortButton
                        label="obchód"
                        sortKey="startedAt"
                        title="Sortuj po czasie rozpoczęcia obchodu"
                        className="text-xs font-normal"
                      />
                    </div>
                  </TableHead>
                  <EntrySortHeader label="Obiekt" sortKey="objectName" />
                  <TableHead className="font-semibold">
                    <div className="flex items-center gap-3">
                      <EntrySortButton
                        label="Wideo-obchód / zdarzenie"
                        sortKey="patrolName"
                      />
                      <EntrySortButton
                        label="kanał"
                        sortKey="videoChannel"
                        title="Sortuj po kanale wideo"
                        className="text-xs font-normal"
                      />
                    </div>
                  </TableHead>
                  <EntrySortHeader
                    label="Rodzaj zakończenia"
                    sortKey="endType"
                  />
                  <EntrySortHeader label="Operator" sortKey="userName" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entriesLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-8 text-center text-slate-500"
                    >
                      Ładowanie zdarzeń...
                    </TableCell>
                  </TableRow>
                ) : entries.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-8 text-center text-slate-500"
                    >
                      {hasActiveFilters
                        ? "Brak zdarzeń dla wybranych filtrów"
                        : "Brak zdarzeń w raporcie."}
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry) => {
                    const isExpanded = expandedId === entry.id;
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() =>
                            setExpandedId(isExpanded ? null : entry.id)
                          }
                        >
                          <TableCell className="pr-0 text-slate-400">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <div className="font-medium text-slate-900">
                              {cmaTimePart(entry.generatedAt)}
                            </div>
                            <div className="text-xs text-slate-500">
                              {cmaDatePart(entry.generatedAt)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-slate-900">
                              {entry.objectName}
                            </div>
                            {entry.address && (
                              <div className="text-xs text-slate-500">
                                {entry.address}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm text-slate-700">
                              {entry.patrolName || "-"}
                            </div>
                            {entry.videoChannel && (
                              <div className="text-xs text-slate-500">
                                Kanał: {entry.videoChannel}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <EndTypeBadge endType={entry.endType} />
                          </TableCell>
                          <TableCell className="text-sm text-slate-700">
                            {entry.userName || "-"}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
                            <TableCell colSpan={6} className="px-6 py-4">
                              <div className="space-y-4">
                                <div>
                                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                                    Opis nieprawidłowości
                                  </div>
                                  <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
                                    {entry.description || "Brak opisu"}
                                  </p>
                                </div>
                                <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                  <div>
                                    <div className="text-xs text-slate-500">
                                      Urządzenie wideo
                                    </div>
                                    <div className="font-medium text-slate-700">
                                      {entry.videoDevice || "-"}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-slate-500">
                                      Kanał
                                    </div>
                                    <div className="font-medium text-slate-700">
                                      {entry.videoChannel || "-"}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-slate-500">
                                      Start obchodu
                                    </div>
                                    <div className="font-medium text-slate-700">
                                      {formatCmaDateTime(entry.startedAt)}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-slate-500">
                                      Koniec obchodu
                                    </div>
                                    <div className="font-medium text-slate-700">
                                      {formatCmaDateTime(entry.endedAt)}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {entriesTotalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || entriesLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Poprzednia
              </Button>
              <span className="text-sm text-slate-500">
                Strona {page} z {entriesTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page === entriesTotalPages || entriesLoading}
                onClick={() =>
                  setPage((p) => Math.min(entriesTotalPages, p + 1))
                }
              >
                Następna
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Camera issues view */}
      {view === "issues" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CameraOff className="h-5 w-5 text-indigo-600" />
              Problemy z kamerami
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {/* Klasyfikacja nie jest filtrem ekranu, tylko zakresem danych:
                  zmiana wysyła nowe żądanie i decyduje, co pójdzie e-mailem.
                  Dlatego „Wyczyść filtry” jej nie rusza. */}
              <Select
                value={issueClassification}
                onValueChange={(value) => {
                  setIssueClassification(value);
                  setIssuesSendResult(null);
                  setIssuesSendError(null);
                }}
              >
                <SelectTrigger
                  className="w-72"
                  data-testid="cma-problemy-filter-classification"
                >
                  <SelectValue placeholder="Klasyfikacja" />
                </SelectTrigger>
                <SelectContent>
                  {(issuesData?.classifications.length
                    ? issuesData.classifications
                    : [
                        {
                          classification: DEFAULT_ISSUE_CLASSIFICATION,
                          count: 0,
                        },
                      ]
                  ).map((item) => (
                    <SelectItem
                      key={item.classification}
                      value={item.classification}
                    >
                      {item.classification} ({item.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendIssues}
                  disabled={issuesSending}
                >
                  {issuesSending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Wysyłanie...
                    </>
                  ) : (
                    <>
                      <Mail className="mr-2 h-4 w-4" />
                      Wyślij e-mailem
                    </>
                  )}
                </Button>
              )}
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  placeholder="Szukaj po nazwie lub adresie..."
                  value={issueSearch}
                  onChange={(e) => setIssueSearch(e.target.value)}
                  className="pl-10"
                  data-testid="cma-problemy-filter-search"
                />
              </div>
              <div className="flex items-center gap-1 text-sm text-slate-500">
                <span>Zdarzeń od</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  className="w-24 tabular-nums"
                  data-testid="cma-problemy-filter-min"
                  value={issueMinCount}
                  onChange={(e) => setIssueMinCount(e.target.value)}
                />
                <span>do</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  className="w-24 tabular-nums"
                  data-testid="cma-problemy-filter-max"
                  value={issueMaxCount}
                  onChange={(e) => setIssueMaxCount(e.target.value)}
                />
              </div>
              {issueFiltersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearIssueFilters}
                  data-testid="cma-problemy-filters-clear"
                >
                  <FilterX className="mr-1 h-4 w-4" />
                  Wyczyść filtry
                </Button>
              )}
              {/* Licznik pokazuje to, co widać po filtrach — a nie całe
                  zestawienie, które i tak w całości idzie e-mailem. */}
              {!issuesLoading && !issuesError && issuesData && (
                <span className="text-sm text-slate-500">
                  {issueObjects.length.toLocaleString("pl-PL")}{" "}
                  {polishPlural(
                    issueObjects.length,
                    "obiekt",
                    "obiekty",
                    "obiektów"
                  )}
                  , {issueEventTotal.toLocaleString("pl-PL")}{" "}
                  {polishPlural(
                    issueEventTotal,
                    "zdarzenie",
                    "zdarzenia",
                    "zdarzeń"
                  )}
                  , {issueCameraTotal.toLocaleString("pl-PL")}{" "}
                  {polishPlural(issueCameraTotal, "kamera", "kamery", "kamer")}
                </span>
              )}
            </div>

            {issuesSendResult && (
              <p className="flex items-center gap-1.5 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {issuesSendResult}
              </p>
            )}
            {issuesSendError && (
              <p className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {issuesSendError}
              </p>
            )}

            {issuesLoading ? (
              <div className="py-8 text-center text-slate-500">
                Ładowanie zestawienia...
              </div>
            ) : issuesError ? (
              <div className="py-8 text-center text-red-600">
                {issuesError}
              </div>
            ) : issueObjects.length === 0 ? (
              <div className="py-8 text-center text-slate-500">
                {issueFiltersActive
                  ? "Brak obiektów dla wybranych filtrów"
                  : "Brak zdarzeń tej klasyfikacji w raporcie."}
              </div>
            ) : (
              <div className="space-y-3">
                {/* Nagłówki sortowania — lista jest kartami, więc pasek
                    zastępuje wiersz nagłówkowy tabeli. */}
                <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 pb-2">
                  <IssueSortHeader label="Obiekt" sortKey="objectName" />
                  <IssueSortHeader label="Zdarzenia" sortKey="totalCount" />
                  <IssueSortHeader label="Kamery" sortKey="cameras" />
                  <IssueSortHeader
                    label="Pierwsze zdarzenie"
                    sortKey="firstAt"
                    title="Najwcześniejsze zdarzenie spośród kamer obiektu"
                  />
                  <IssueSortHeader
                    label="Ostatnie zdarzenie"
                    sortKey="lastAt"
                    title="Najpóźniejsze zdarzenie spośród kamer obiektu"
                  />
                </div>
                {issueObjects.map((obj) => (
                  <div
                    key={obj.objectName}
                    className="rounded-lg border border-slate-200 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-900">
                          {obj.objectName}
                        </div>
                        {obj.address && (
                          <div className="text-xs text-slate-500">
                            {obj.address}
                          </div>
                        )}
                        {/* Zakres dat obiektu — kryterium sortowania musi być
                            widoczne bez wczytywania się w listę kamer. */}
                        <div className="text-xs text-slate-500">
                          {formatIssueTimeRange(
                            issueFirstAt(obj),
                            issueLastAt(obj)
                          )}
                        </div>
                      </div>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {obj.cameras.length.toLocaleString("pl-PL")}{" "}
                          {polishPlural(
                            obj.cameras.length,
                            "kamera",
                            "kamery",
                            "kamer"
                          )}
                        </Badge>
                        <Badge className="border-transparent bg-indigo-600 text-white hover:bg-indigo-600">
                          {obj.totalCount.toLocaleString("pl-PL")}{" "}
                          {polishPlural(
                            obj.totalCount,
                            "zdarzenie",
                            "zdarzenia",
                            "zdarzeń"
                          )}
                        </Badge>
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {obj.cameras.map((camera) => (
                        <div
                          key={camera.videoChannel ?? "__brak__"}
                          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm"
                        >
                          <span className="font-mono font-medium text-slate-800">
                            {camera.videoChannel || "Nieznany kanał"}
                          </span>
                          {camera.videoDevice && (
                            <span className="text-xs text-slate-500">
                              {camera.videoDevice}
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-3">
                            <span className="text-xs text-slate-500">
                              {formatIssueTimeRange(
                                camera.firstAt,
                                camera.lastAt
                              )}
                            </span>
                            <Badge variant="outline">
                              {camera.count.toLocaleString("pl-PL")}
                            </Badge>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
