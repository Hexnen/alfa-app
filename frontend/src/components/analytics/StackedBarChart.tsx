/**
 * Poziomy słupek skumulowany — odpowiada na pytanie „ile każdy z nich
 * przynosi i ile z tego zjada koszt?".
 *
 * Wiersze, nie kolumny: polskie nazwy spółek są długie, a obrócona oś
 * kategorii to podatek od czytelności. Długość paska to przychód, a podział
 * wewnątrz paska JEST marżą — nie trzeba drugiego wykresu obok.
 *
 * Przypadek straty jest zaprojektowany, nie przypadkowy: gdy suma segmentów
 * przekracza przychód, w miejscu przychodu stoi kreskowana linia, a nadwyżka
 * rysuje się w czerwieni straty i wystaje poza tę linię.
 */
import { useMemo } from "react";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Legend, LegendItem } from "./Legend";
import { hBarPath, niceScale } from "./scale";
import {
  BASELINE,
  COLOR_LOSS,
  GRIDLINE,
  INK_MUTED,
  INK_PRIMARY,
  INK_SECONDARY,
  NO_DATA,
} from "./palette";
import { DASH, plnCompact } from "./format";

export interface StackedSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface StackedRow {
  id: string;
  label: string;
  subLabel?: string;
  segments: StackedSegment[];
  /** Przychód — długość odniesienia paska i pozycja linii przychodu. */
  total: number;
  /** Dopisek pod etykietą, np. „brak danych kosztowych". */
  note?: string;
}

export interface StackedBarChartProps {
  rows: StackedRow[];
  formatValue: (value: number) => string;
  /** Zdanie po polsku opisujące, co pokazuje wykres. */
  ariaLabel: string;
  /** Formater etykiet osi — domyślnie skrócone kwoty. */
  formatTick?: (value: number) => string;
  onRowClick?: (row: StackedRow) => void;
  className?: string;
}

const W = 760;
const LABEL_W = 208;
const VALUE_W = 104;
const ROW_H = 36;
const BAR_H = 16;
const MT = 10;
const AXIS_H = 26;
const SEG_GAP = 2;

export function StackedBarChart({
  rows,
  formatValue,
  ariaLabel,
  formatTick = plnCompact,
  onRowClick,
  className,
}: StackedBarChartProps) {
  const x0 = LABEL_W;
  const x1 = W - VALUE_W;
  const plotW = x1 - x0;
  const H = MT + rows.length * ROW_H + AXIS_H;
  const axisY = MT + rows.length * ROW_H;

  const scale = useMemo(() => {
    // Skala jest wspólna dla wszystkich wierszy — inaczej porównanie spółek
    // nic nie znaczy. Górą jest maksimum z przychodu ORAZ sumy kosztów, żeby
    // nadwyżka straty miała się gdzie zmieścić.
    const peak = rows.reduce((acc, r) => {
      const sum = r.segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0);
      return Math.max(acc, r.total, sum);
    }, 0);
    return niceScale(peak);
  }, [rows]);

  const toX = (v: number) => x0 + (scale.max ? (v / scale.max) * plotW : 0);

  const legendItems = useMemo(() => {
    const seen = new Map<string, StackedSegment>();
    for (const r of rows) for (const s of r.segments) if (!seen.has(s.key)) seen.set(s.key, s);
    return [...seen.values()];
  }, [rows]);

  const hasLoss = rows.some(
    (r) => r.segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0) > r.total
  );

  if (rows.length === 0) return null;

  return (
    <div className={cn("space-y-3", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
        className="select-none"
      >
        <defs>
          {/* Szrafura stanu „nie wiemy" — tekstura, a nie sam kolor, żeby
              brak danych był rozpoznawalny też przy daltonizmie i w druku. */}
          <pattern
            id="analytics-nodata"
            width={6}
            height={6}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={6} height={6} fill="#ffffff" />
            <rect width={3} height={6} fill={NO_DATA} opacity={0.45} />
          </pattern>
          <clipPath id="analytics-stacked-labels">
            <rect x={0} y={0} width={LABEL_W - 12} height={H} />
          </clipPath>
        </defs>

        {/* Siatka pionowa — cienka, ciągła, recesywna. */}
        {scale.ticks.map((t) => (
          <line
            key={t}
            x1={toX(t)}
            x2={toX(t)}
            y1={MT}
            y2={axisY}
            stroke={t === 0 ? BASELINE : GRIDLINE}
            strokeWidth={1}
          />
        ))}
        {scale.ticks.map((t, i) => (
          <text
            key={`t-${t}`}
            x={toX(t)}
            y={axisY + 15}
            textAnchor={i === 0 ? "start" : "middle"}
            fontSize={10}
            fill={INK_MUTED}
          >
            {formatTick(t)}
          </text>
        ))}

        {rows.map((row, i) => {
          const y = MT + i * ROW_H;
          const barY = y + (ROW_H - BAR_H) / 2;
          const positive = row.segments.filter((s) => s.value > 0);
          const sum = positive.reduce((s, seg) => s + seg.value, 0);
          const overflow = sum > row.total + 1e-6;
          const unknown = positive.length === 0;

          // Rozbicie segmentów na kawałki po obu stronach linii przychodu —
          // to, co wychodzi poza przychód, jest stratą i musi być czerwone
          // niezależnie od barwy segmentu.
          const pieces: {
            key: string;
            from: number;
            to: number;
            color: string;
            label: string;
            value: number;
          }[] = [];
          let cursor = 0;
          for (const seg of positive) {
            const end = cursor + seg.value;
            const inside = Math.min(end, row.total);
            if (inside > cursor) {
              pieces.push({
                key: `${seg.key}-in`,
                from: cursor,
                to: inside,
                color: seg.color,
                label: seg.label,
                value: seg.value,
              });
            }
            if (end > row.total) {
              pieces.push({
                key: `${seg.key}-over`,
                from: Math.max(cursor, row.total),
                to: end,
                color: COLOR_LOSS,
                label: `${seg.label} ponad przychód`,
                value: seg.value,
              });
            }
            cursor = end;
          }

          const tip = tipAttrs({
            title: row.label,
            rows: [
              { label: "Przychód", text: formatValue(row.total) },
              ...positive.map((s) => ({
                label: s.label,
                text: formatValue(s.value),
              })),
              ...(unknown ? [{ text: row.note ?? "brak danych kosztowych" }] : []),
            ],
          });

          return (
            <g
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "cursor-pointer" : undefined}
            >
              <rect
                x={0}
                y={y}
                width={W}
                height={ROW_H}
                className="fill-transparent hover:fill-slate-50"
                {...tip}
              />

              <g clipPath="url(#analytics-stacked-labels)">
                <text
                  x={0}
                  y={row.subLabel || row.note ? y + 15 : y + 22}
                  fontSize={12}
                  fill={INK_PRIMARY}
                >
                  {row.label}
                </text>
                {(row.subLabel || row.note) && (
                  <text
                    x={0}
                    y={y + 27}
                    fontSize={10}
                    fill={row.note ? "#d97706" : INK_SECONDARY}
                  >
                    {row.note ?? row.subLabel}
                  </text>
                )}
              </g>

              {unknown ? (
                // Koszt nieuzupełniony: rysujemy pełny przychód szrafurą, bo
                // podziału nie znamy. Zerowy koszt wyglądałby jak 100% marży.
                <path
                  d={hBarPath(x0, barY, toX(row.total) - x0, BAR_H)}
                  fill="url(#analytics-nodata)"
                  stroke={BASELINE}
                  strokeWidth={1}
                />
              ) : (
                pieces.map((p, pi) => {
                  const px = toX(p.from);
                  const raw = toX(p.to) - px;
                  const last = pi === pieces.length - 1;
                  const width = last ? raw : Math.max(raw - SEG_GAP, 0.5);
                  return (
                    <path
                      key={p.key}
                      d={hBarPath(px, barY, width, BAR_H, last)}
                      fill={p.color}
                    />
                  );
                })
              )}

              {/* Linia przychodu — widoczna tylko wtedy, gdy koszt ją przebija. */}
              {overflow && (
                <line
                  x1={toX(row.total)}
                  x2={toX(row.total)}
                  y1={barY - 4}
                  y2={barY + BAR_H + 4}
                  stroke={INK_PRIMARY}
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
              )}

              <text
                x={W - 2}
                y={y + ROW_H / 2 + 4}
                textAnchor="end"
                fontSize={12}
                fontWeight={500}
                fill={unknown ? INK_MUTED : INK_PRIMARY}
              >
                {unknown ? DASH : formatValue(row.total)}
              </text>
            </g>
          );
        })}

        <line
          x1={x0}
          x2={x0}
          y1={MT}
          y2={axisY}
          stroke={BASELINE}
          strokeWidth={1}
        />
      </svg>

      <Legend>
        {legendItems.map((s) => (
          <LegendItem key={s.key} color={s.color} label={s.label} />
        ))}
        {hasLoss && (
          <LegendItem color={COLOR_LOSS} label="koszt ponad przychód" />
        )}
        {rows.some((r) => r.segments.every((s) => s.value <= 0)) && (
          <LegendItem color={NO_DATA} label="brak danych kosztowych" />
        )}
      </Legend>
    </div>
  );
}
