/**
 * Wykres rozrzutu z kwadrantami — odpowiada na pytanie „które obiekty dużo
 * przynoszą, a mimo to na nich tracimy?".
 *
 * Oś X: przychód miesięczny. Oś Y: marża %. Promień bąbla: koszt wdrożenia
 * (czyli ile już w obiekt włożyliśmy). Prawy dolny kwadrant jest podbarwiony,
 * bo to jedyny róg, który wymaga decyzji.
 *
 * UWAGA dla wołającego: renderuj dopiero przy `rows.length >= SCATTER_MIN_ROWS`
 * (5). Przy czterech punktach kwadranty wyglądają jak zepsuty wykres — komponent
 * sam się przed tym broni, ale strona nie powinna nawet rezerwować na niego karty.
 */
import { useMemo } from "react";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { linScale, niceScale, SCATTER_MIN_ROWS } from "./scale";
import {
  BASELINE,
  COLOR_LOSS,
  COLOR_PROFIT,
  GRIDLINE,
  INK_MUTED,
  INK_SECONDARY,
} from "./palette";
import { pct, plnCompact, plnFull } from "./format";

export interface ScatterRow {
  id: string;
  label: string;
  /** Przychód miesięczny (oś X). */
  revenue: number;
  /** Marża w punktach procentowych (oś Y). `null` = brak danych kosztowych. */
  marginPct: number | null;
  /** Koszt wdrożenia — promień bąbla. `null` = nieznany, bąbel minimalny. */
  setupCost?: number | null;
}

export interface ScatterQuadrantProps {
  rows: ScatterRow[];
  /** Zdanie po polsku opisujące, co pokazuje wykres. */
  ariaLabel: string;
  xLabel?: string;
  yLabel?: string;
  onPointClick?: (row: ScatterRow) => void;
  className?: string;
}

const W = 760;
const H = 360;
const ML = 52;
const MR = 16;
const MT = 14;
const MB = 42;

export function ScatterQuadrant({
  rows,
  ariaLabel,
  xLabel = "Przychód miesięczny",
  yLabel = "Marża %",
  onPointClick,
  className,
}: ScatterQuadrantProps) {
  const points = useMemo(
    () => rows.filter((r) => r.marginPct !== null && Number.isFinite(r.marginPct)),
    [rows]
  );
  const missing = rows.length - points.length;

  const geom = useMemo(() => {
    const x = niceScale(Math.max(...points.map((p) => p.revenue), 0));
    const margins = points.map((p) => p.marginPct as number);
    const rawLo = Math.min(0, ...margins);
    const rawHi = Math.max(10, ...margins);
    const lo = Math.floor(rawLo / 5) * 5 - 5;
    const hi = Math.ceil(rawHi / 5) * 5 + 5;
    const step = Math.max(5, Math.round((hi - lo) / 4 / 5) * 5);
    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
    const maxSetup = Math.max(...points.map((p) => p.setupCost ?? 0), 0);
    return { x, lo, hi, ticks, maxSetup };
  }, [points]);

  if (points.length < SCATTER_MIN_ROWS) {
    return (
      <p className={cn("py-6 text-center text-sm text-slate-500", className)}>
        Za mało danych na wykres rozrzutu — potrzeba co najmniej{" "}
        {SCATTER_MIN_ROWS} obiektów z uzupełnionym kosztem (jest {points.length}).
      </p>
    );
  }

  const x0 = ML;
  const x1 = W - MR;
  const y0 = MT;
  const y1 = H - MB;
  const toX = (v: number) => linScale(v, 0, geom.x.max, x0, x1);
  const toY = (v: number) => linScale(v, geom.lo, geom.hi, y1, y0);
  const zeroY = toY(0);
  const midX = toX(geom.x.max / 2);

  return (
    <div className={cn("space-y-2", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
        className="select-none"
      >
        {/* Kwadrant „duży przychód, ujemna marża" — jedyny róg, w którym
            trzeba coś zrobić, więc jedyny podbarwiony. */}
        {zeroY < y1 && (
          <>
            <rect
              x={midX}
              y={zeroY}
              width={x1 - midX}
              height={y1 - zeroY}
              fill="#fef2f2"
            />
            <text
              x={x1 - 8}
              y={y1 - 8}
              textAnchor="end"
              fontSize={11}
              fill="#b91c1c"
            >
              duży przychód, ujemna marża
            </text>
          </>
        )}

        {/* Siatka pozioma + etykiety marży */}
        {geom.ticks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={x0}
              x2={x1}
              y1={toY(t)}
              y2={toY(t)}
              stroke={GRIDLINE}
              strokeWidth={1}
            />
            <text
              x={x0 - 8}
              y={toY(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill={INK_MUTED}
            >
              {pct(t)}
            </text>
          </g>
        ))}

        {/* Linia odniesienia marży zerowej — próg opłacalności. */}
        <line
          x1={x0}
          x2={x1}
          y1={zeroY}
          y2={zeroY}
          stroke={INK_SECONDARY}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />

        {/* Skrajne działki wyrównane do brzegu — wyśrodkowane wychodziłyby
            poza viewBox i urywały się przy prawej krawędzi karty. */}
        {geom.x.ticks.map((t, i) => (
          <text
            key={`x-${t}`}
            x={toX(t)}
            y={y1 + 16}
            textAnchor={
              i === 0
                ? "start"
                : i === geom.x.ticks.length - 1
                  ? "end"
                  : "middle"
            }
            fontSize={10}
            fill={INK_MUTED}
          >
            {plnCompact(t)}
          </text>
        ))}

        <line x1={x0} x2={x1} y1={y1} y2={y1} stroke={BASELINE} strokeWidth={1} />
        <line x1={x0} x2={x0} y1={y0} y2={y1} stroke={BASELINE} strokeWidth={1} />

        {points.map((p) => {
          const margin = p.marginPct as number;
          // Promień po pierwiastku, bo oko czyta pole, nie średnicę.
          const r =
            geom.maxSetup > 0
              ? 5 + 11 * Math.sqrt((p.setupCost ?? 0) / geom.maxSetup)
              : 6;
          return (
            <circle
              key={p.id}
              cx={toX(p.revenue)}
              cy={toY(margin)}
              r={Math.max(r, 5)}
              fill={margin < 0 ? COLOR_LOSS : COLOR_PROFIT}
              fillOpacity={0.75}
              // 2px biała obwódka rozdziela nachodzące na siebie bąble.
              stroke="#ffffff"
              strokeWidth={2}
              strokeDasharray={p.setupCost == null ? "2 2" : undefined}
              className={onPointClick ? "cursor-pointer" : undefined}
              onClick={onPointClick ? () => onPointClick(p) : undefined}
              {...tipAttrs({
                title: p.label,
                rows: [
                  { label: xLabel, text: plnFull(p.revenue) },
                  { label: yLabel, text: pct(margin, 1) },
                  {
                    label: "Koszt wdrożenia",
                    text: p.setupCost == null ? "nieuzupełniony" : plnFull(p.setupCost),
                  },
                ],
              })}
            />
          );
        })}

        <text x={x1} y={H - 6} textAnchor="end" fontSize={11} fill={INK_SECONDARY}>
          {xLabel}
        </text>
        <text
          x={-(y0 + y1) / 2}
          y={12}
          transform="rotate(-90)"
          textAnchor="middle"
          fontSize={11}
          fill={INK_SECONDARY}
        >
          {yLabel}
        </text>
      </svg>

      {missing > 0 && (
        <p className="text-xs text-amber-600">
          {missing} pozycji nie ma na wykresie — marża nieznana przy
          nieuzupełnionym koszcie.
        </p>
      )}
    </div>
  );
}
