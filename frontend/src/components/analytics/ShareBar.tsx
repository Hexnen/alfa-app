/**
 * Pasek udziałów (100% w poziomie) — odpowiada na pytanie „z czego składa się
 * całość?" (np. struktura kosztów, podział przychodu na spółki).
 *
 * Świadomie zamiast pierścienia/donuta: przy 3-6 kategoriach pasek jest
 * czytelniejszy (porównujemy długości, nie kąty), zajmuje jeden wiersz
 * zamiast kwadratu i to ułamek kodu. Kategorie poza pierwszą szóstką
 * zwijamy do „Pozostałe" — dziewiąta barwa nigdy nie jest generowana.
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Legend, LegendItem } from "./Legend";
import { INK_MUTED, NO_DATA } from "./palette";
import { DASH, pct } from "./format";

export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface ShareBarProps {
  segments: ShareSegment[];
  /** Zdanie opisujące, co pokazuje pasek — czytnik ekranu dostaje to zamiast grafiki. */
  ariaLabel: string;
  /** Ile kategorii pokazać osobno, reszta ląduje w „Pozostałe". */
  maxSegments?: number;
  /** Formater wartości w legendzie; domyślnie sam procent. */
  formatValue?: (value: number) => string;
  /** Co pokazać, gdy nie ma z czego liczyć udziałów. */
  emptyLabel?: string;
  className?: string;
}

export function ShareBar({
  segments,
  ariaLabel,
  maxSegments = 6,
  formatValue,
  emptyLabel = "brak danych",
  className,
}: ShareBarProps) {
  const { shown, total } = useMemo(() => {
    const positive = segments.filter(
      (s) => Number.isFinite(s.value) && s.value > 0
    );
    const sorted = [...positive].sort((a, b) => b.value - a.value);
    const sum = sorted.reduce((acc, s) => acc + s.value, 0);
    if (sorted.length <= maxSegments) return { shown: sorted, total: sum };
    const head = sorted.slice(0, maxSegments - 1);
    const restValue = sorted
      .slice(maxSegments - 1)
      .reduce((acc, s) => acc + s.value, 0);
    return {
      shown: [
        ...head,
        {
          key: "__rest__",
          label: "Pozostałe",
          value: restValue,
          color: INK_MUTED,
        },
      ],
      total: sum,
    };
  }, [segments, maxSegments]);

  if (total <= 0) {
    return (
      <div className={cn("space-y-2", className)}>
        <div
          role="img"
          aria-label={`${ariaLabel} — ${emptyLabel}`}
          className="h-3 w-full overflow-hidden rounded-full"
          style={{
            backgroundImage: `repeating-linear-gradient(45deg, ${NO_DATA} 0 3px, transparent 3px 6px)`,
            opacity: 0.4,
          }}
        />
        <p className="text-xs text-slate-500">
          {emptyLabel} {DASH}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {/* flex-grow zamiast szerokości w %: przerwy 2px między wypełnieniami
          nie rozjeżdżają wtedy sumy do ponad 100%. */}
      <div
        role="img"
        aria-label={ariaLabel}
        className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
        style={{ gap: 2 }}
      >
        {shown.map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              flexGrow: s.value,
              flexBasis: 0,
              backgroundColor: s.color,
            }}
            title={`${s.label}: ${pct((s.value / total) * 100)}`}
          />
        ))}
      </div>

      <Legend>
        {shown.map((s) => (
          <LegendItem
            key={s.key}
            color={s.color}
            label={s.label}
            value={
              formatValue
                ? `${formatValue(s.value)} · ${pct((s.value / total) * 100)}`
                : pct((s.value / total) * 100)
            }
          />
        ))}
      </Legend>
    </div>
  );
}
