/**
 * Dwustronny pasek rankingowy — odpowiada na pytanie „kto zarabia, a kto
 * dokłada?".
 *
 * `RankBar` mierzy od zera w prawo i nie umie pokazać ujemnego zysku;
 * tutaj zero jest w środku toru, straty rosną w lewo (czerwień), zyski
 * w prawo (zieleń). Obie strony skalujemy tym samym `absMax`, żeby linia
 * zera stała w miejscu we wszystkich wierszach — inaczej porównanie wierszy
 * traci sens.
 */
import { cn } from "@/lib/utils";
import { BASELINE, COLOR_LOSS, COLOR_PROFIT, NO_DATA } from "./palette";
import { DASH } from "./format";

export interface RankBarDivergingProps {
  label: string;
  subLabel?: string;
  /** `null` = zysk nieznany (brak danych kosztowych), a nie zero. */
  value: number | null;
  /** `max(|min|, |max|)` policzone na całym zbiorze wierszy. */
  absMax: number;
  valueLabel: string;
  detail?: string;
  mono?: boolean;
  onClick?: () => void;
  className?: string;
}

export function RankBarDiverging({
  label,
  subLabel,
  value,
  absMax,
  valueLabel,
  detail,
  mono,
  onClick,
  className,
}: RankBarDivergingProps) {
  const known = value !== null && Number.isFinite(value);
  const negative = known && value < 0;
  // Połowa toru to 50% szerokości; minimum 1% żeby drobne kwoty były widoczne.
  const half = known && absMax ? Math.min((Math.abs(value) / absMax) * 50, 50) : 0;
  const width = known && value !== 0 ? Math.max(half, 1) : 0;

  const row = (
    <>
      <div className="w-52 shrink-0 sm:w-64">
        <div
          className={cn(
            "truncate text-sm text-slate-700",
            mono && "font-mono font-medium text-slate-800"
          )}
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

      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        {known ? (
          <div
            className="absolute top-0 h-full rounded-full"
            style={{
              width: `${width}%`,
              backgroundColor: negative ? COLOR_LOSS : COLOR_PROFIT,
              ...(negative
                ? { right: "50%" }
                : { left: "50%" }),
            }}
          />
        ) : (
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage: `repeating-linear-gradient(45deg, ${NO_DATA} 0 3px, transparent 3px 6px)`,
            }}
          />
        )}
        {/* Reguła zera — cienka, recesywna, zawsze na wierzchu paska. */}
        <div
          className="absolute left-1/2 top-0 h-full w-px"
          style={{ backgroundColor: BASELINE }}
          aria-hidden="true"
        />
      </div>

      <div className="w-32 shrink-0 text-right">
        <div
          className={cn(
            "text-sm font-medium",
            !known
              ? "text-slate-400"
              : negative
                ? "text-red-600"
                : "text-slate-900"
          )}
        >
          {known ? valueLabel : DASH}
        </div>
        {detail && <div className="text-xs text-slate-500">{detail}</div>}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-50",
          className
        )}
      >
        {row}
      </button>
    );
  }

  return <div className={cn("flex items-center gap-3", className)}>{row}</div>;
}
