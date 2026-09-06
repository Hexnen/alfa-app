/**
 * Miernik marży — odpowiada na pytanie „czy ta marża jest zdrowa?".
 *
 * Dywizy CSS zamiast SVG: mierniki siedzą w komórkach tabeli i w kafelkach
 * KPI, gdzie osobny `viewBox` na każdą komórkę to niepotrzebny koszt.
 * Progi: poniżej 0 czerwony (dokładamy), 0-15 bursztynowy (na styk),
 * powyżej 15 zielony.
 */
import { cn } from "@/lib/utils";
import { COLOR_LOSS, COLOR_PROFIT, NO_DATA } from "./palette";
import { DASH, pct } from "./format";

export type MarginGaugeSize = "sm" | "md" | "lg";

const SIZES: Record<MarginGaugeSize, { track: string; label: string; bar: string }> = {
  sm: { track: "h-1.5 w-14", label: "text-[11px] w-10", bar: "gap-1.5" },
  md: { track: "h-2 w-24", label: "text-xs w-12", bar: "gap-2" },
  lg: { track: "h-2.5 flex-1", label: "text-sm w-16", bar: "gap-3" },
};

export interface MarginGaugeProps {
  /** Marża w punktach procentowych. `null` = nieznana (brak danych kosztowych). */
  value: number | null;
  size?: MarginGaugeSize;
  className?: string;
}

export function MarginGauge({ value, size = "md", className }: MarginGaugeProps) {
  const s = SIZES[size];
  const known = value !== null && Number.isFinite(value);
  const negative = known && value < 0;
  const color = !known
    ? NO_DATA
    : negative
      ? COLOR_LOSS
      : value <= 15
        ? "#d97706"
        : COLOR_PROFIT;
  // Tor mierzy 0-100. Ujemna marża nie ma na nim miejsca, więc rysujemy ją
  // jako czerwony pasek od lewej z |wartością| — kierunek czyta się z koloru
  // i ze znaku przy liczbie, a nie z samej długości.
  const width = known ? Math.min(Math.abs(value), 100) : 0;

  return (
    <div
      className={cn("flex items-center", s.bar, className)}
      role="img"
      aria-label={
        known
          ? `Marża ${pct(value)}`
          : "Marża nieznana — brak danych kosztowych"
      }
    >
      <div
        className={cn(
          "overflow-hidden rounded-full",
          s.track,
          negative ? "bg-red-50" : "bg-slate-100"
        )}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>
      <span
        className={cn(
          "shrink-0 text-right font-medium tabular-nums",
          s.label,
          !known ? "text-slate-400" : negative ? "text-red-600" : "text-slate-700"
        )}
      >
        {known ? pct(value) : DASH}
      </span>
    </div>
  );
}
