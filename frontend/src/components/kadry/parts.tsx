// Elementy tabel modułu Kadry współdzielone przez podzakładki.
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Nagłówek kolumny z tooltipem (hover) opisującym, z czego liczy się wartość —
 * w Kadrach prawie każda kolumna jest wynikiem kalkulacji, więc opis „skąd to
 * się bierze" jest częścią tabeli, a nie dokumentacji obok niej.
 */
export function Th({
  tip,
  children,
  className,
}: {
  tip?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      title={tip}
      className={cn(
        "whitespace-nowrap px-3 py-2 text-left font-medium",
        tip && "cursor-help underline decoration-dotted underline-offset-4",
        className,
      )}
    >
      {children}
    </th>
  );
}

export type SortDir = "asc" | "desc";

/**
 * Klikalny nagłówek — strzałka pokazuje kolumnę i kierunek sortowania.
 * Tooltip „z czego się kalkuluje" zostaje: w Kadrach opis kolumny jest tak
 * samo potrzebny jak możliwość jej posortowania.
 */
export function SortTh<K extends string>({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  tip,
  align = "left",
  testIdPrefix,
  className,
}: {
  label: string;
  sortKey: K;
  sort: K;
  dir: SortDir;
  onSort: (key: K) => void;
  tip?: string;
  align?: "left" | "right";
  /** Prefiks `data-testid` przycisku, np. „hours-sort". */
  testIdPrefix?: string;
  className?: string;
}) {
  const active = sort === sortKey;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      title={tip}
      className={cn(
        "whitespace-nowrap px-3 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        data-testid={testIdPrefix ? `${testIdPrefix}-${sortKey}` : undefined}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          tip && "cursor-help underline decoration-dotted underline-offset-4",
          active ? "text-foreground" : "",
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5 no-underline", !active && "opacity-40")} />
      </button>
    </th>
  );
}
