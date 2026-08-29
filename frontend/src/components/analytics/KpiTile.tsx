/**
 * Kafelek KPI — odpowiada na pytanie „jedna liczba: ile?".
 *
 * Kształt (Card > CardContent > wersalikowa etykieta / duża wartość / opis)
 * jest przepisany z `Kadry.tsx:580-596`, żeby analityka wyglądała jak
 * natywna część aplikacji, a nie jak wklejony widget.
 */
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CoverageNote, type CoverageProps } from "./CoverageNote";

export type KpiTone = "neutral" | "good" | "warn" | "bad";

const TONE_CLASS: Record<KpiTone, string> = {
  neutral: "",
  good: "text-emerald-700",
  warn: "text-amber-600",
  bad: "text-red-600",
};

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: KpiTone;
  /** Tekst dymka natywnego (`title`) — jak w kafelkach Kadr. */
  tip?: string;
  /**
   * Pokrycie danymi kosztowymi. Gdy część obiektów ma koszt `null`, wartość
   * kafelka jest policzona z niepełnej próbki i trzeba to powiedzieć wprost —
   * inaczej „marża 100%" wygląda jak sukces, a znaczy „nie znamy kosztu".
   */
  coverage?: CoverageProps;
  className?: string;
  onClick?: () => void;
}

export function KpiTile({
  label,
  value,
  sub,
  tone = "neutral",
  tip,
  coverage,
  className,
  onClick,
}: KpiTileProps) {
  return (
    <Card
      title={tip}
      onClick={onClick}
      className={cn(
        tip && "cursor-help",
        onClick && "cursor-pointer transition-colors hover:bg-slate-50",
        className
      )}
    >
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {/* <div>, nie <p>: `value` bywa komponentem blokowym (np. MarginGauge),
            a zagnieżdżony <div> w <p> to nieprawidłowy HTML — React zgłasza to
            błędem w konsoli przy każdym renderze kafelka. */}
        <div className={cn("mt-1 text-xl font-bold", TONE_CLASS[tone])}>{value}</div>
        {sub != null && <p className="text-xs text-muted-foreground">{sub}</p>}
        {coverage && <CoverageNote {...coverage} className="mt-1" />}
      </CardContent>
    </Card>
  );
}
