/**
 * Poziomy pasek rankingowy — odpowiada na pytanie „kto ma najwięcej?".
 *
 * Przy 3-9 wierszach (a tyle mamy: 9 obiektów, 5 spółek, 3 handlowców)
 * ranking poziomy czyta się lepiej niż kolumny: nazwy mieszczą się w pełnej
 * linii, a rzadkość danych nie wygląda na błąd.
 *
 * Język wizualny przepisany z `CmaTrends.tsx:545-600`.
 */
import { cn } from "@/lib/utils";
import { NO_DATA } from "./palette";
import { DASH } from "./format";

export interface RankBarProps {
  label: string;
  subLabel?: string;
  /** `null` = brak danych (np. nieuzupełniony koszt), a nie zero. */
  value: number | null;
  max: number;
  valueLabel: string;
  detail: string;
  color: string;
  /** Nazwa własna / numer — wtedy font monospace, jak w CMA. */
  mono?: boolean;
  onClick?: () => void;
  className?: string;
}

export function RankBar({
  label,
  subLabel,
  value,
  max,
  valueLabel,
  detail,
  color,
  mono,
  onClick,
  className,
}: RankBarProps) {
  const known = value !== null && Number.isFinite(value);
  // Minimum 1.5% szerokości, żeby wartość niezerowa nigdy nie zniknęła.
  const width = known && max ? Math.max((value / max) * 100, 1.5) : 0;

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
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        {known ? (
          <div
            className="h-full rounded-full"
            style={{ width: `${width}%`, backgroundColor: color }}
          />
        ) : (
          // Brak danych: pusta rynna w szarości, nie pasek zerowy —
          // zerowy pasek czytałby się jako „0 zł", a my po prostu nie wiemy.
          <div
            className="h-full w-full rounded-full opacity-40"
            style={{
              backgroundImage: `repeating-linear-gradient(45deg, ${NO_DATA} 0 3px, transparent 3px 6px)`,
            }}
          />
        )}
      </div>
      <div className="w-32 shrink-0 text-right">
        <div
          className={cn(
            "text-sm font-medium",
            known ? "text-slate-900" : "text-slate-400"
          )}
        >
          {known ? valueLabel : DASH}
        </div>
        <div className="text-xs text-slate-500">{detail}</div>
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

  return (
    <div className={cn("flex items-center gap-3", className)}>{row}</div>
  );
}
