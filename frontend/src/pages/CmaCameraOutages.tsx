import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  Building2,
  CameraOff,
  CheckCircle2,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileSpreadsheet,
  Minus,
  Plus,
  Search,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cmaApi,
  type CmaCameraOutages as CmaCameraOutagesData,
  type CmaOutageObject,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

type OutageFilter = "all" | "new" | "allOut";

// Delta of outages vs the previous report: new cameras minus recovered ones
function objectDelta(obj: CmaOutageObject): number {
  const newCount = obj.cameras.filter((cam) => cam.status === "new").length;
  return newCount - obj.resolved.length;
}

function nf(n: number): string {
  return n.toLocaleString("pl-PL");
}

function polishPlural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

// Dates come from the backend as "YYYY-MM-DD HH:MM:SS".
function cmaDatePart(value: string | null): string {
  if (!value || value.length < 10) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

function formatCmaDateTime(value: string | null): string {
  if (!value || value.length < 10) return "-";
  const time = value.slice(11, 16);
  return `${cmaDatePart(value)}${time ? ` ${time}` : ""}`;
}

// Range "pierwsze HH:MM – ostatnie HH:MM" (with dates when spanning days)
function formatOutageTimeRange(
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

// Day difference between two "YYYY-MM-DD HH:MM:SS" timestamps
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b || a.length < 10 || b.length < 10) return null;
  const da = new Date(`${a.slice(0, 10)}T00:00:00Z`).getTime();
  const db = new Date(`${b.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round(Math.abs(da - db) / 86_400_000);
}

function StatusBadge({ status }: { status: "new" | "still" }) {
  if (status === "new") {
    return (
      <Badge className="border-transparent bg-red-600 text-white hover:bg-red-600">
        NOWY
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-amber-500 text-white hover:bg-amber-500">
      NADAL
    </Badge>
  );
}

function DeltaLabel({ delta, hasOutages }: { delta: number; hasOutages: boolean }) {
  if (delta > 0) {
    return (
      <span className="text-sm font-semibold text-red-600 [font-variant-numeric:tabular-nums]">
        +{nf(delta)}
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span className="text-sm font-semibold text-green-600 [font-variant-numeric:tabular-nums]">
        −{nf(-delta)}
      </span>
    );
  }
  // No change but the outages persist - amber, not neutral
  return (
    <span
      className={cn(
        "text-sm font-semibold [font-variant-numeric:tabular-nums]",
        hasOutages ? "text-amber-600" : "text-slate-400"
      )}
    >
      ±0
    </span>
  );
}

// Full per-object breakdown shown when a row is expanded
function ObjectDetails({ obj }: { obj: CmaOutageObject }) {
  const resolvedOnly = obj.camerasOutCount === 0;

  return (
    <div className="space-y-3 border-t border-slate-200/70 px-3 pb-3 pt-3">
      {resolvedOnly ? (
        <span className="flex items-center gap-1.5 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />
          wróciły wszystkie kamery
        </span>
      ) : (
        <span className="block text-sm text-slate-600">
          <span className="font-semibold text-slate-900">
            {nf(obj.camerasOutCount)}
          </span>{" "}
          z {nf(obj.totalKnownCameras)}{" "}
          {polishPlural(obj.totalKnownCameras, "kamery", "kamer", "kamer")} bez
          obrazu
        </span>
      )}

      {obj.cameras.length > 0 && (
        <div className="space-y-2">
          {obj.cameras.map((camera) => (
            <div
              key={camera.videoChannel ?? "__brak__"}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm"
            >
              <StatusBadge status={camera.status} />
              <span className="font-mono font-medium text-slate-800">
                {camera.videoChannel || "Nieznany kanał"}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <span className="text-xs text-slate-500">
                  {formatOutageTimeRange(camera.firstAt, camera.lastAt)}
                </span>
                <Badge variant="outline">
                  {nf(camera.occurrences)}{" "}
                  {polishPlural(
                    camera.occurrences,
                    "zdarzenie",
                    "zdarzenia",
                    "zdarzeń"
                  )}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      )}

      {obj.resolved.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Ustąpiły ({nf(obj.resolved.length)})
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {obj.resolved.map((camera) => (
              <span
                key={camera.videoChannel ?? "__brak__"}
                className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-0.5 text-xs text-green-700"
              >
                <CheckCircle2 className="h-3 w-3" />
                <span className="font-mono line-through opacity-80">
                  {camera.videoChannel || "Nieznany kanał"}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Compact one-line summary row; the whole row toggles the details below it
function ObjectRow({
  obj,
  showDelta,
  expanded,
  onToggle,
}: {
  obj: CmaOutageObject;
  showDelta: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const resolvedOnly = obj.camerasOutCount === 0;
  return (
    <div
      className={cn(
        "rounded-md border",
        resolvedOnly
          ? "border-slate-200 bg-slate-50/50"
          : obj.allOut
            ? "border-red-200 bg-red-50/40"
            : "border-slate-200"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-slate-400 transition-transform",
              expanded && "rotate-90"
            )}
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm" title={obj.objectName}>
              <span
                className={cn(
                  "font-medium",
                  resolvedOnly ? "text-slate-600" : "text-slate-900"
                )}
              >
                {obj.objectName}
              </span>
              <span className="text-slate-600">
                : {nf(obj.camerasOutCount)}{" "}
                {polishPlural(obj.camerasOutCount, "kamera", "kamery", "kamer")}{" "}
                brak
              </span>
            </span>
            {obj.address && (
              <span className="block truncate text-xs text-slate-500">
                {obj.address}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {obj.allOut && (
            <Badge className="border-transparent bg-red-600 text-white hover:bg-red-600">
              <AlertTriangle className="mr-1 h-3 w-3" />
              WSZYSTKIE KAMERY
            </Badge>
          )}
          {showDelta && (
            <DeltaLabel
              delta={objectDelta(obj)}
              hasOutages={obj.camerasOutCount > 0}
            />
          )}
        </span>
      </button>
      {expanded && <ObjectDetails obj={obj} />}
    </div>
  );
}

export function CmaCameraOutages() {
  const { canEdit } = usePerms();
  const editable = canEdit("cma/braki-kamer");
  const [data, setData] = useState<CmaCameraOutagesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<OutageFilter>("all");
  const [search, setSearch] = useState("");
  // Objects with no current outages (only resolved ones) are hidden by default
  const [showResolved, setShowResolved] = useState(false);
  // Expansion state per object name; toggle-all fills/clears the whole set
  const [expandedObjects, setExpandedObjects] = useState<Set<string>>(
    () => new Set()
  );

  // Loading starts as true - the effect only runs once on mount.
  useEffect(() => {
    let cancelled = false;
    cmaApi
      .getCameraOutages()
      .then((res) => {
        if (!cancelled && res.data) setData(res.data);
      })
      .catch((err) => {
        console.error("Error fetching CMA camera outages:", err);
        if (!cancelled) {
          setError("Nie udało się pobrać zestawienia braków kamer.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredObjects = useMemo(() => {
    const objects = data?.objects ?? [];
    const term = search.trim().toLowerCase();
    return objects.filter((obj) => {
      if (filter === "new" && !obj.cameras.some((c) => c.status === "new")) {
        return false;
      }
      if (filter === "allOut" && !obj.allOut) return false;
      if (term && !obj.objectName.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [data, filter, search]);

  const activeObjects = filteredObjects.filter((o) => o.camerasOutCount > 0);
  const resolvedObjects = filteredObjects.filter(
    (o) => o.camerasOutCount === 0
  );
  const visibleObjects = showResolved
    ? [...activeObjects, ...resolvedObjects]
    : activeObjects;

  const allExpanded =
    visibleObjects.length > 0 &&
    visibleObjects.every((obj) => expandedObjects.has(obj.objectName));

  const toggleObject = (name: string) => {
    setExpandedObjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedObjects(new Set());
    } else {
      setExpandedObjects(new Set(visibleObjects.map((o) => o.objectName)));
    }
  };

  // Gap between the compared reports - a delta over a longer period is
  // flagged so "new/resolved" is not read as a day-to-day change.
  const comparisonGapDays =
    data?.previousReport && data.latestReport
      ? daysBetween(data.previousReport.dateTo, data.latestReport.dateFrom)
      : null;

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">CMA</h1>
        <p className="text-slate-500 mt-1">
          Centrum monitorowania alarmów - aktualne braki obrazu z kamer
        </p>
      </div>

      {loading ? (
        <div className="text-center py-8">Ładowanie...</div>
      ) : error ? (
        <div className="text-center py-8 text-red-600">{error}</div>
      ) : !data ? (
        /* Empty state - no reports imported yet */
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <CameraOff className="h-10 w-10 text-slate-300" />
            <div>
              <p className="font-medium text-slate-900">
                Brak zaimportowanych raportów
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Braki kamer pojawią się po zaimportowaniu pierwszego raportu z
                przeglądu kamer.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Report context */}
          <div className="space-y-1 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <FileSpreadsheet className="h-4 w-4 text-slate-400" />
              <span>
                Stan z raportu:{" "}
                <span className="font-medium text-slate-900">
                  {formatCmaDateTime(data.latestReport.dateFrom)}
                  {" – "}
                  {formatCmaDateTime(data.latestReport.dateTo)}
                </span>
              </span>
              <Link
                to={`/cma/raporty/${data.latestReport.id}`}
                className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                Zobacz raport
              </Link>
            </div>
            {data.previousReport ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <TrendingUp className="h-4 w-4 text-slate-400" />
                <span>
                  Porównanie z raportem:{" "}
                  {formatCmaDateTime(data.previousReport.dateFrom)}
                  {" – "}
                  {formatCmaDateTime(data.previousReport.dateTo)}
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <TrendingUp className="h-4 w-4 text-slate-400" />
                <span>
                  Brak wcześniejszego raportu do porównania - wszystkie braki
                  pokazane bez zmian względem poprzedniego okresu.
                </span>
              </div>
            )}
            {comparisonGapDays !== null && comparisonGapDays > 2 && (
              <p className="flex items-center gap-1.5 text-amber-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                poprzedni raport jest z{" "}
                {cmaDatePart(data.previousReport!.dateTo)} — delta obejmuje
                dłuższy okres
              </p>
            )}
          </div>

          {/* Stat tiles */}
          {summary && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                    <Building2 className="w-4 h-4" />
                    Obiekty z brakami
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-slate-900">
                    {nf(summary.objectsWithOutages)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                    <CameraOff className="w-4 h-4" />
                    Kamery bez obrazu
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-slate-900">
                    {nf(summary.camerasOut)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                    <Plus className="w-4 h-4" />
                    Przybyło
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">
                    {summary.newCameras > 0 ? "+" : ""}
                    {nf(summary.newCameras)}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {polishPlural(
                      summary.newCameras,
                      "nowa kamera bez obrazu",
                      "nowe kamery bez obrazu",
                      "nowych kamer bez obrazu"
                    )}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                    <Minus className="w-4 h-4" />
                    Ustąpiło
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {summary.resolvedCameras > 0 ? "−" : ""}
                    {nf(summary.resolvedCameras)}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {polishPlural(
                      summary.resolvedCameras,
                      "kamera wróciła",
                      "kamery wróciły",
                      "kamer wróciło"
                    )}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                    <AlertTriangle className="w-4 h-4" />
                    Obiekty całkiem bez obrazu
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className={cn(
                      "text-2xl font-bold",
                      summary.allOutObjects > 0
                        ? "text-red-600"
                        : "text-slate-900"
                    )}
                  >
                    {nf(summary.allOutObjects)}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Object list */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CameraOff className="h-5 w-5 text-indigo-600" />
                Braki kamer wg obiektów
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant={filter === "all" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("all")}
                  >
                    Wszystkie
                  </Button>
                  <Button
                    variant={filter === "new" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("new")}
                  >
                    Tylko nowe
                  </Button>
                  <Button
                    variant={filter === "allOut" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("allOut")}
                  >
                    Całkowite braki
                  </Button>
                </div>
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="Szukaj obiektu..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <span className="text-sm text-slate-500">
                  {nf(visibleObjects.length)}{" "}
                  {polishPlural(
                    visibleObjects.length,
                    "obiekt",
                    "obiekty",
                    "obiektów"
                  )}
                </span>
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={showResolved}
                    onChange={(e) => setShowResolved(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                  />
                  Pokaż obiekty bez braków ({nf(resolvedObjects.length)})
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={toggleAll}
                  disabled={visibleObjects.length === 0}
                >
                  {allExpanded ? (
                    <>
                      <ChevronsDownUp className="mr-2 h-4 w-4" />
                      Zwiń wszystkie
                    </>
                  ) : (
                    <>
                      <ChevronsUpDown className="mr-2 h-4 w-4" />
                      Rozwiń wszystkie
                    </>
                  )}
                </Button>
              </div>

              {/* Empty state - no outages in the newest report */}
              {summary && summary.camerasOut === 0 && (
                <div className="flex items-center justify-center gap-2 rounded-lg border border-green-200 bg-green-50 py-8 text-green-700">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">
                    Brak kamer bez obrazu w aktualnym raporcie
                  </span>
                </div>
              )}

              {visibleObjects.length === 0 ? (
                summary && summary.camerasOut === 0 ? null : (
                  <div className="py-8 text-center text-slate-500">
                    Brak obiektów spełniających wybrane kryteria.
                  </div>
                )
              ) : (
                <div className="space-y-1.5">
                  {activeObjects.map((obj) => (
                    <ObjectRow
                      key={obj.objectName}
                      obj={obj}
                      showDelta={data.previousReport !== null}
                      expanded={expandedObjects.has(obj.objectName)}
                      onToggle={() => toggleObject(obj.objectName)}
                    />
                  ))}
                  {showResolved && resolvedObjects.length > 0 && (
                    <>
                      {activeObjects.length > 0 && (
                        <div className="pt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                          Obiekty, w których braki ustąpiły
                        </div>
                      )}
                      {resolvedObjects.map((obj) => (
                        <ObjectRow
                          key={obj.objectName}
                          obj={obj}
                          showDelta={data.previousReport !== null}
                          expanded={expandedObjects.has(obj.objectName)}
                          onToggle={() => toggleObject(obj.objectName)}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-400">
                Liczba wszystkich kamer obiektu szacowana na podstawie historii
                zdarzeń.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
