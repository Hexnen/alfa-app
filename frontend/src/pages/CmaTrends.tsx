import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BarChart3,
  Building2,
  Calendar,
  CameraOff,
  FileSpreadsheet,
  TrendingUp,
  Upload,
  UserRound,
  Video,
} from "lucide-react";
import {
  cmaApi,
  type CmaTrendDay,
  type CmaTrends as CmaTrendsData,
} from "@/lib/api";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

// Chart palette - validated with the dataviz palette validator
// (lightness band, chroma floor, CVD separation, >= 3:1 contrast on white).
const COLOR_ENTRIES = "#2a78d6"; // blue - zdarzenia
const COLOR_NO_IMAGE = "#e34948"; // red - brak obrazu
const COLOR_CAMERAS = "#4a3aa7"; // violet - kamery (linia)

const INK_PRIMARY = "#0f172a";
const INK_SECONDARY = "#64748b";
const INK_MUTED = "#94a3b8";
const GRIDLINE = "#e2e8f0";
const BASELINE = "#cbd5e1";
const GAP_FILL = "#f8fafc";
const HOVER_WASH = "#f1f5f9";

function nf(n: number): string {
  return n.toLocaleString("pl-PL");
}

// Dates come from the backend as "YYYY-MM-DD".
function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function longDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isNextDay(a: string, b: string): boolean {
  return addDays(a, 1) === b;
}

function percentLabel(count: number, total: number): string {
  if (!total) return "0%";
  const value = (count / total) * 100;
  return `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`;
}

function polishPlural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

// Split the day list into runs of consecutive dates. Days between runs
// are missing from the data (no reports) - NOT zero events.
function splitSegments(days: CmaTrendDay[]): {
  segments: CmaTrendDay[][];
  gaps: { from: string; to: string }[];
} {
  const segments: CmaTrendDay[][] = [];
  const gaps: { from: string; to: string }[] = [];
  let current: CmaTrendDay[] = [];
  for (const day of days) {
    const prev = current[current.length - 1];
    if (prev && !isNextDay(prev.date, day.date)) {
      segments.push(current);
      gaps.push({ from: addDays(prev.date, 1), to: addDays(day.date, -1) });
      current = [];
    }
    current.push(day);
  }
  if (current.length > 0) segments.push(current);
  return { segments, gaps };
}

// "Nice" y-axis scale: clean tick numbers, ~4 gridlines.
function niceScale(maxValue: number): { max: number; ticks: number[] } {
  if (maxValue <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const rawStep = maxValue / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = 10 * pow;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (rawStep <= m * pow) {
      step = m * pow;
      break;
    }
  }
  const top = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return { max: top, ticks };
}

// Bar with a 4px rounded data-end, square at the baseline.
function barPath(cx: number, top: number, width: number, height: number) {
  const r = Math.min(4, width / 2, height);
  const x0 = cx - width / 2;
  const bottom = top + height;
  return [
    `M${x0},${bottom}`,
    `V${top + r}`,
    `Q${x0},${top} ${x0 + r},${top}`,
    `H${x0 + width - r}`,
    `Q${x0 + width},${top} ${x0 + width},${top + r}`,
    `V${bottom}`,
    "Z",
  ].join(" ");
}

interface TooltipRow {
  value: string;
  label: string;
  color?: string;
}

interface SeriesSpec {
  label: string;
  color: string;
  value: (d: CmaTrendDay) => number;
}

type ChartColumn =
  | { kind: "day"; day: CmaTrendDay; x: number; w: number }
  | { kind: "gap"; x: number; w: number; from: string; to: string };

// Categorical daily chart (bars + optional line overlay) drawn as inline SVG.
// The x axis only contains days that have data; a discontinuity is rendered
// as an explicit "brak danych" band - never a continuous line through the gap.
function DailyChart({
  segments,
  gaps,
  bar,
  line,
  tooltipRows,
  ariaLabel,
}: {
  segments: CmaTrendDay[][];
  gaps: { from: string; to: string }[];
  bar: SeriesSpec;
  line?: SeriesSpec;
  tooltipRows: (d: CmaTrendDay) => TooltipRow[];
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const W = 960;
  const H = 300;
  const ML = 56;
  const MR = 16;
  const MT = 28;
  const MB = 44;
  const GAP_W = 92;
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;

  const days = segments.flat();
  const gapCount = Math.max(segments.length - 1, 0);
  const slotW = (plotW - gapCount * GAP_W) / Math.max(days.length, 1);
  const barW = Math.min(24, slotW * 0.55);

  const maxValue = Math.max(
    ...days.map((d) => bar.value(d)),
    ...(line ? days.map((d) => line.value(d)) : [0]),
    0
  );
  const scale = niceScale(maxValue);
  const y = (v: number) => MT + plotH - (v / scale.max) * plotH;
  const baselineY = y(0);

  const columns: ChartColumn[] = [];
  let x = ML;
  segments.forEach((segment, si) => {
    if (si > 0) {
      const gap = gaps[si - 1];
      columns.push({
        kind: "gap",
        x,
        w: GAP_W,
        from: gap?.from ?? "",
        to: gap?.to ?? "",
      });
      x += GAP_W;
    }
    for (const day of segment) {
      columns.push({ kind: "day", day, x, w: slotW });
      x += slotW;
    }
  });

  const dayColumns = columns.filter((c) => c.kind === "day") as Extract<
    ChartColumn,
    { kind: "day" }
  >[];
  const maxBarDay = days.reduce(
    (best, d) => (bar.value(d) > bar.value(best) ? d : best),
    days[0]
  );

  const hoveredColumn = hover
    ? dayColumns.find((c) => c.day.date === hover) ?? null
    : null;
  const hoveredRows = hoveredColumn ? tooltipRows(hoveredColumn.day) : [];
  const tooltipW = 212;
  const tooltipH = 26 + hoveredRows.length * 17 + 6;
  let tooltipX = 0;
  let tooltipY = 0;
  if (hoveredColumn) {
    const cx = hoveredColumn.x + hoveredColumn.w / 2;
    tooltipX = cx + 14;
    if (tooltipX + tooltipW > W - MR) tooltipX = cx - 14 - tooltipW;
    tooltipY = MT + 2;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      className="select-none"
      onMouseLeave={() => setHover(null)}
    >
      {/* Gridlines (hairline, solid, recessive) + y ticks */}
      {scale.ticks.map((t) => (
        <g key={t}>
          {t > 0 && (
            <line
              x1={ML}
              x2={W - MR}
              y1={y(t)}
              y2={y(t)}
              stroke={GRIDLINE}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <text
            x={ML - 8}
            y={y(t) + 3.5}
            textAnchor="end"
            fontSize={11}
            fill={INK_SECONDARY}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {nf(t)}
          </text>
        </g>
      ))}

      {/* Data gap bands - missing days, explicitly marked */}
      {columns.map((col) =>
        col.kind === "gap" ? (
          <g key={`gap-${col.from}`}>
            <rect
              x={col.x + 6}
              y={MT}
              width={col.w - 12}
              height={plotH}
              fill={GAP_FILL}
            />
            <text
              x={col.x + col.w / 2}
              y={MT + plotH / 2 - 4}
              textAnchor="middle"
              fontSize={11}
              fill={INK_SECONDARY}
            >
              brak danych
            </text>
            <text
              x={col.x + col.w / 2}
              y={MT + plotH / 2 + 12}
              textAnchor="middle"
              fontSize={11}
              fill={INK_MUTED}
            >
              {col.from ? `${shortDate(col.from)}–${shortDate(col.to)}` : ""}
            </text>
            {/* Axis break marks */}
            <line
              x1={col.x + 2}
              x2={col.x + 10}
              y1={baselineY + 6}
              y2={baselineY - 6}
              stroke={INK_MUTED}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={col.x + col.w - 10}
              x2={col.x + col.w - 2}
              y1={baselineY + 6}
              y2={baselineY - 6}
              stroke={INK_MUTED}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ) : null
      )}

      {/* Hover column wash */}
      {hoveredColumn && (
        <rect
          x={hoveredColumn.x}
          y={MT}
          width={hoveredColumn.w}
          height={plotH}
          fill={HOVER_WASH}
        />
      )}

      {/* Bars */}
      {dayColumns.map((col) => {
        const value = bar.value(col.day);
        const h = Math.max((value / scale.max) * plotH, value > 0 ? 1.5 : 0);
        const cx = col.x + col.w / 2;
        return (
          <path
            key={`bar-${col.day.date}`}
            d={barPath(cx, baselineY - h, barW, h)}
            fill={bar.color}
            fillOpacity={hover === col.day.date ? 0.8 : 1}
          />
        );
      })}

      {/* Line overlay - broken per segment, never drawn across a gap */}
      {line &&
        segments.map((segment) => {
          const points = segment.map((day) => {
            const col = dayColumns.find((c) => c.day.date === day.date)!;
            return {
              cx: col.x + col.w / 2,
              cy: y(line.value(day)),
              date: day.date,
            };
          });
          return (
            <g key={`line-${segment[0].date}`}>
              {points.length > 1 && (
                <polyline
                  points={points.map((p) => `${p.cx},${p.cy}`).join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {points.map((p) => (
                <circle
                  key={p.date}
                  cx={p.cx}
                  cy={p.cy}
                  r={4}
                  fill={line.color}
                  stroke="#ffffff"
                  strokeWidth={2}
                />
              ))}
            </g>
          );
        })}

      {/* Direct label - only the maximum bar (selective labelling) */}
      {maxBarDay &&
        (() => {
          const col = dayColumns.find((c) => c.day.date === maxBarDay.date);
          if (!col) return null;
          const value = bar.value(maxBarDay);
          return (
            <text
              x={col.x + col.w / 2}
              y={y(value) - 7}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill={INK_PRIMARY}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {nf(value)}
            </text>
          );
        })()}

      {/* Baseline + x labels (DD.MM) */}
      <line
        x1={ML}
        x2={W - MR}
        y1={baselineY}
        y2={baselineY}
        stroke={BASELINE}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {dayColumns.map((col) => (
        <text
          key={`x-${col.day.date}`}
          x={col.x + col.w / 2}
          y={baselineY + 18}
          textAnchor="middle"
          fontSize={11}
          fill={hover === col.day.date ? INK_PRIMARY : INK_SECONDARY}
        >
          {shortDate(col.day.date)}
        </text>
      ))}

      {/* Hover / focus hit targets - full column, bigger than the mark */}
      {dayColumns.map((col) => (
        <rect
          key={`hit-${col.day.date}`}
          x={col.x}
          y={MT}
          width={col.w}
          height={plotH + MB - 8}
          fill="transparent"
          tabIndex={0}
          aria-label={`${longDate(col.day.date)}: ${tooltipRows(col.day)
            .map((r) => `${r.label} ${r.value}`)
            .join(", ")}`}
          onMouseEnter={() => setHover(col.day.date)}
          onFocus={() => setHover(col.day.date)}
          onBlur={() => setHover(null)}
          style={{ outline: "none", cursor: "default" }}
        />
      ))}

      {/* Tooltip - value leads, label follows */}
      {hoveredColumn && (
        <g pointerEvents="none">
          <rect
            x={tooltipX}
            y={tooltipY}
            width={tooltipW}
            height={tooltipH}
            rx={6}
            fill="#ffffff"
            stroke={GRIDLINE}
            strokeWidth={1}
          />
          <text
            x={tooltipX + 12}
            y={tooltipY + 18}
            fontSize={12}
            fontWeight={600}
            fill={INK_PRIMARY}
          >
            {longDate(hoveredColumn.day.date)}
          </text>
          {hoveredRows.map((row, i) => {
            const rowY = tooltipY + 35 + i * 17;
            return (
              <g key={row.label}>
                {row.color && (
                  <rect
                    x={tooltipX + 12}
                    y={rowY - 4.5}
                    width={12}
                    height={3}
                    rx={1.5}
                    fill={row.color}
                  />
                )}
                <text x={tooltipX + 30} y={rowY} fontSize={11.5}>
                  <tspan
                    fontWeight={600}
                    fill={INK_PRIMARY}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {row.value}
                  </tspan>
                  <tspan fill={INK_SECONDARY} dx={6}>
                    {row.label}
                  </tspan>
                </text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

function LegendSwatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-[3px]"
      style={{ backgroundColor: color }}
    />
  );
}

function LegendLine({ color }: { color: string }) {
  return (
    <svg width={20} height={10} aria-hidden="true">
      <line
        x1={0}
        x2={20}
        y1={5}
        y2={5}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={10} cy={5} r={3.5} fill={color} stroke="#ffffff" strokeWidth={1.5} />
    </svg>
  );
}

// Horizontal ranking row - same visual language as the distribution bars
// on the report details page.
function RankBar({
  label,
  subLabel,
  count,
  max,
  detail,
  color,
  mono,
}: {
  label: string;
  subLabel?: string;
  count: number;
  max: number;
  detail: string;
  color: string;
  mono?: boolean;
}) {
  const width = max ? Math.max((count / max) * 100, 1.5) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-52 shrink-0 sm:w-64">
        <div
          className={`truncate text-sm text-slate-700 ${
            mono ? "font-mono font-medium text-slate-800" : ""
          }`}
          title={label}
        >
          {label}
        </div>
        {subLabel && (
          <div className="truncate text-xs text-slate-500" title={subLabel}>
            {subLabel}
          </div>
        )}
      </div>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>
      <div className="w-32 shrink-0 text-right">
        <div className="text-sm font-medium text-slate-900">{nf(count)}</div>
        <div className="text-xs text-slate-500">{detail}</div>
      </div>
    </div>
  );
}

export function CmaTrends() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("cma/trendy");
  const [trends, setTrends] = useState<CmaTrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Loading starts as true - the effect only runs once on mount.
  useEffect(() => {
    let cancelled = false;
    cmaApi
      .getTrends()
      .then((res) => {
        if (!cancelled && res.data) setTrends(res.data);
      })
      .catch((err) => {
        console.error("Error fetching CMA trends:", err);
        if (!cancelled) {
          setError("Nie udało się pobrać danych trendów.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { segments, gaps } = useMemo(
    () => splitSegments(trends?.perDay ?? []),
    [trends]
  );

  const totals = useMemo(() => {
    const perDay = trends?.perDay ?? [];
    const entries = perDay.reduce((s, d) => s + d.entries, 0);
    const noImage = perDay.reduce((s, d) => s + d.noImage, 0);
    const operatorHandled = perDay.reduce((s, d) => s + d.operatorHandled, 0);
    return { entries, noImage, operatorHandled };
  }, [trends]);

  const maxTopObject = trends?.topObjects[0]?.noImage ?? 0;
  const maxTopCamera = trends?.topCameras[0]?.noImage ?? 0;

  return (
    <div className="space-y-6">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">CMA</h1>
        <p className="text-slate-500 mt-1">
          Centrum monitorowania alarmów - trendy z zaimportowanych raportów
        </p>
      </div>

      {loading ? (
        <div className="text-center py-8">Ładowanie...</div>
      ) : error ? (
        <div className="text-center py-8 text-red-600">{error}</div>
      ) : !trends || trends.reportCount === 0 ? (
        /* Empty state */
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <TrendingUp className="h-10 w-10 text-slate-300" />
            <div>
              <p className="font-medium text-slate-900">
                Brak zaimportowanych raportów
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Trendy pojawią się po zaimportowaniu pierwszego raportu z
                przeglądu kamer.
              </p>
            </div>
            <Button
              onClick={() => navigate("/cma/raporty")}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Upload className="mr-2 h-4 w-4" />
              Przejdź do importu raportów
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stat tiles */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                  <FileSpreadsheet className="w-4 h-4" />
                  Raporty
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-slate-900">
                  {nf(trends.reportCount)}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {nf(trends.perDay.length)}{" "}
                  {polishPlural(trends.perDay.length, "dzień", "dni", "dni")} z
                  danymi
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                  <Calendar className="w-4 h-4" />
                  Zakres danych
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-bold leading-7 text-slate-900">
                  {trends.range.from ? longDate(trends.range.from) : "-"}
                  {" – "}
                  {trends.range.to ? longDate(trends.range.to) : "-"}
                </div>
                {gaps.length > 0 && (
                  <p className="mt-1 text-xs text-amber-600">
                    przerwa:{" "}
                    {gaps
                      .map((g) => `${shortDate(g.from)}–${shortDate(g.to)}`)
                      .join(", ")}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                  <Video className="w-4 h-4" />
                  Zdarzenia łącznie
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-slate-900">
                  {nf(trends.entryCountTotal)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                  <CameraOff className="w-4 h-4" />
                  Brak obrazu
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">
                  {nf(totals.noImage)}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {percentLabel(totals.noImage, totals.entries)} zdarzeń
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                  <UserRound className="w-4 h-4" />
                  Obsłużone przez operatora
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-indigo-600">
                  {percentLabel(totals.operatorHandled, totals.entries)}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {nf(totals.operatorHandled)}{" "}
                  {polishPlural(
                    totals.operatorHandled,
                    "zdarzenie",
                    "zdarzenia",
                    "zdarzeń"
                  )}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Daily events chart */}
          {trends.perDay.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-indigo-600" />
                  Zdarzenia dziennie
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DailyChart
                  segments={segments}
                  gaps={gaps}
                  ariaLabel="Wykres słupkowy: liczba zdarzeń dziennie"
                  bar={{
                    label: "Zdarzenia",
                    color: COLOR_ENTRIES,
                    value: (d) => d.entries,
                  }}
                  tooltipRows={(d) => [
                    {
                      value: nf(d.entries),
                      label: "zdarzeń",
                      color: COLOR_ENTRIES,
                    },
                    {
                      value: nf(d.operatorHandled),
                      label: `obsłużonych (${percentLabel(
                        d.operatorHandled,
                        d.entries
                      )})`,
                    },
                  ]}
                />
              </CardContent>
            </Card>
          )}

          {/* Daily "no image" chart */}
          {trends.perDay.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CameraOff className="h-5 w-5 text-indigo-600" />
                  Brak obrazu dziennie
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* Legend - two series */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <LegendSwatch color={COLOR_NO_IMAGE} />
                    Zdarzenia „Brak obrazu”
                  </span>
                  <span className="flex items-center gap-1.5">
                    <LegendLine color={COLOR_CAMERAS} />
                    Kamery z brakiem obrazu
                  </span>
                </div>
                <DailyChart
                  segments={segments}
                  gaps={gaps}
                  ariaLabel="Wykres: zdarzenia Brak obrazu dziennie oraz liczba kamer z brakiem obrazu"
                  bar={{
                    label: "Brak obrazu",
                    color: COLOR_NO_IMAGE,
                    value: (d) => d.noImage,
                  }}
                  line={{
                    label: "Kamery",
                    color: COLOR_CAMERAS,
                    value: (d) => d.noImageCameras,
                  }}
                  tooltipRows={(d) => [
                    {
                      value: nf(d.noImage),
                      label: "zdarzeń „Brak obrazu”",
                      color: COLOR_NO_IMAGE,
                    },
                    {
                      value: nf(d.noImageCameras),
                      label: "kamer",
                      color: COLOR_CAMERAS,
                    },
                    {
                      value: nf(d.noImageObjects),
                      label: "obiektów",
                    },
                  ]}
                />

                {/* Table view - accessible twin of both daily charts */}
                <details className="pt-2">
                  <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-700">
                    Pokaż dane dzienne w tabeli
                  </summary>
                  <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-3 py-2 font-medium">Dzień</th>
                          <th className="px-3 py-2 text-right font-medium">
                            Zdarzenia
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Brak obrazu
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Kamery
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Obiekty
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Obsłużone
                          </th>
                        </tr>
                      </thead>
                      <tbody className="[font-variant-numeric:tabular-nums]">
                        {trends.perDay.map((d) => (
                          <tr
                            key={d.date}
                            className="border-t border-slate-100"
                          >
                            <td className="px-3 py-1.5 text-slate-700">
                              {longDate(d.date)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-700">
                              {nf(d.entries)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-700">
                              {nf(d.noImage)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-700">
                              {nf(d.noImageCameras)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-700">
                              {nf(d.noImageObjects)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-700">
                              {nf(d.operatorHandled)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </CardContent>
            </Card>
          )}

          {/* Rankings */}
          <div className="grid gap-6 xl:grid-cols-2">
            {trends.topObjects.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-indigo-600" />
                    Najczęstszy brak obrazu — obiekty
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {trends.topObjects.map((obj) => (
                    <RankBar
                      key={obj.objectName}
                      label={obj.objectName}
                      count={obj.noImage}
                      max={maxTopObject}
                      detail={`${percentLabel(
                        obj.noImage,
                        totals.noImage
                      )} wszystkich`}
                      color={COLOR_NO_IMAGE}
                    />
                  ))}
                </CardContent>
              </Card>
            )}
            {trends.topCameras.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CameraOff className="h-5 w-5 text-indigo-600" />
                    Najczęstszy brak obrazu — kamery
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {trends.topCameras.map((cam) => (
                    <RankBar
                      key={`${cam.objectName}|${cam.videoChannel ?? ""}`}
                      label={cam.videoChannel || "Nieznany kanał"}
                      subLabel={cam.objectName}
                      count={cam.noImage}
                      max={maxTopCamera}
                      detail={
                        cam.firstDate && cam.lastDate
                          ? cam.firstDate === cam.lastDate
                            ? shortDate(cam.firstDate)
                            : `${shortDate(cam.firstDate)}–${shortDate(
                                cam.lastDate
                              )}`
                          : "-"
                      }
                      color={COLOR_NO_IMAGE}
                      mono
                    />
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
