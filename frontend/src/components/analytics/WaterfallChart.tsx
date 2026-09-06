/**
 * Wodospad — odpowiada na pytanie „gdzie po drodze znika przychód?".
 *
 * Pięć kroków: przychód → −koszt obiektów → −koszt handlowca → −prowizja →
 * zysk. Każdy słupek startuje tam, gdzie skończył poprzedni, a linie łączące
 * pokazują, że to jedna kwota przepuszczona przez kolejne potrącenia.
 */
import { useMemo } from "react";
import { tipAttrs } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { barPath, linScale, niceScale } from "./scale";
import {
  BASELINE,
  COLOR_COST,
  COLOR_LOSS,
  COLOR_PROFIT,
  COLOR_REVENUE,
  GRIDLINE,
  INK_MUTED,
  INK_PRIMARY,
  INK_SECONDARY,
} from "./palette";
import { plnCompact, plnFull, signedPln } from "./format";

export interface WaterfallStep {
  key: string;
  label: string;
  /** Wartość ze znakiem: dodatnia dodaje, ujemna odejmuje. */
  value: number;
  /** Nadpisanie barwy — domyślnie przychód/koszt po znaku. */
  color?: string;
}

export interface WaterfallChartProps {
  steps: WaterfallStep[];
  /** Słupek zamykający — liczony od zera, nie od poprzedniego kroku. */
  total: { label: string; value: number };
  /** Zdanie po polsku opisujące, co pokazuje wykres. */
  ariaLabel: string;
  formatValue?: (value: number) => string;
  className?: string;
}

const W = 760;
const H = 320;
const ML = 60;
const MR = 16;
const MT = 26;
const MB = 46;
const BAR_W = 58;

export function WaterfallChart({
  steps,
  total,
  ariaLabel,
  formatValue = plnFull,
  className,
}: WaterfallChartProps) {
  const bars = useMemo(() => {
    const out: {
      key: string;
      label: string;
      value: number;
      from: number;
      to: number;
      color: string;
      isTotal: boolean;
    }[] = [];
    let running = 0;
    for (const s of steps) {
      const from = running;
      running += s.value;
      out.push({
        key: s.key,
        label: s.label,
        value: s.value,
        from,
        to: running,
        color: s.color ?? (s.value < 0 ? COLOR_COST : COLOR_REVENUE),
        isTotal: false,
      });
    }
    out.push({
      key: "__total__",
      label: total.label,
      value: total.value,
      from: 0,
      to: total.value,
      color: total.value < 0 ? COLOR_LOSS : COLOR_PROFIT,
      isTotal: true,
    });
    return out;
  }, [steps, total]);

  const domain = useMemo(() => {
    const values = bars.flatMap((b) => [b.from, b.to, 0]);
    const hi = Math.max(...values);
    const lo = Math.min(...values);
    const top = niceScale(hi).max;
    // Ujemna oś powstaje tylko wtedy, gdy naprawdę schodzimy pod zero —
    // pusty dolny pas na wykresie zawsze rentownym byłby kłamstwem o skali.
    const bottom = lo < 0 ? -niceScale(-lo).max : 0;
    const ticks = niceScale(hi).ticks.filter((t) => t <= top);
    const negTicks =
      bottom < 0
        ? niceScale(-bottom)
            .ticks.filter((t) => t > 0)
            .map((t) => -t)
        : [];
    return { top, bottom, ticks: [...negTicks.reverse(), ...ticks] };
  }, [bars]);

  const x0 = ML;
  const x1 = W - MR;
  const y0 = MT;
  const y1 = H - MB;
  const toY = (v: number) => linScale(v, domain.bottom, domain.top, y1, y0);
  const zeroY = toY(0);
  const slot = (x1 - x0) / bars.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      className={cn("select-none", className)}
    >
      {domain.ticks.map((t) => (
        <g key={t}>
          <line
            x1={x0}
            x2={x1}
            y1={toY(t)}
            y2={toY(t)}
            stroke={t === 0 ? BASELINE : GRIDLINE}
            strokeWidth={1}
          />
          <text
            x={x0 - 8}
            y={toY(t) + 3}
            textAnchor="end"
            fontSize={10}
            fill={INK_MUTED}
          >
            {plnCompact(t)}
          </text>
        </g>
      ))}

      {bars.map((b, i) => {
        const cx = x0 + slot * i + slot / 2;
        const top = Math.min(toY(b.from), toY(b.to));
        const height = Math.max(Math.abs(toY(b.to) - toY(b.from)), 2);
        const next = bars[i + 1];
        // Krok zamykający liczy się od zera, więc łącznik do niego prowadzi
        // od poziomu bieżącej sumy — a ta jest równa jego wartości.
        const connectorY = toY(b.to);
        const labelY = b.value < 0 ? top + height + 14 : top - 8;

        return (
          <g key={b.key}>
            <path
              d={barPath(cx, top, BAR_W, height)}
              fill={b.color}
              {...tipAttrs({
                title: b.label,
                rows: [
                  {
                    text: b.isTotal ? formatValue(b.value) : signedPln(b.value),
                  },
                  ...(b.isTotal
                    ? []
                    : [{ label: "Po tym kroku", text: formatValue(b.to) }]),
                ],
              })}
            />

            {next && (
              <line
                x1={cx + BAR_W / 2}
                x2={cx + slot - BAR_W / 2}
                y1={connectorY}
                y2={connectorY}
                stroke={BASELINE}
                strokeWidth={1}
                strokeDasharray="3 2"
              />
            )}

            <text
              x={cx}
              y={labelY}
              textAnchor="middle"
              fontSize={11}
              fontWeight={b.isTotal ? 600 : 400}
              fill={INK_PRIMARY}
            >
              {b.isTotal ? formatValue(b.value) : signedPln(b.value)}
            </text>

            {/* Etykieta kategorii łamana na dwie linie — polskie nazwy
                kroków nie mieszczą się w jednym slocie. */}
            {wrapLabel(b.label).map((line, li) => (
              <text
                key={li}
                x={cx}
                y={y1 + 16 + li * 12}
                textAnchor="middle"
                fontSize={11}
                fill={INK_SECONDARY}
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}

      <line x1={x0} x2={x1} y1={zeroY} y2={zeroY} stroke={BASELINE} strokeWidth={1} />
    </svg>
  );
}

/** Dzieli etykietę na maksymalnie dwie linie po ~14 znakach. */
function wrapLabel(label: string): string[] {
  if (label.length <= 14) return [label];
  const words = label.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > 14 && current) {
      lines.push(current);
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}
