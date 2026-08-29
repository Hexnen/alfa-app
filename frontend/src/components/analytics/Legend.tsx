/**
 * Legenda wykresów — przepisana z `CmaTrends.tsx:516`.
 *
 * Tożsamość serii nigdy nie może być niesiona samym kolorem, więc przy dwóch
 * i więcej seriach legenda jest obowiązkowa. Tekst zostaje w tuszu (slate),
 * kolor niesie tylko próbka.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function LegendSwatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={{ backgroundColor: color }}
    />
  );
}

export interface LegendItemProps {
  color: string;
  label: ReactNode;
  /** Wartość przy etykiecie — legenda robi wtedy za mini-tabelę. */
  value?: ReactNode;
}

export function LegendItem({ color, label, value }: LegendItemProps) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
      <LegendSwatch color={color} />
      <span>{label}</span>
      {value != null && (
        <span className="font-medium text-slate-900">{value}</span>
      )}
    </span>
  );
}

export function Legend({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>
      {children}
    </div>
  );
}
