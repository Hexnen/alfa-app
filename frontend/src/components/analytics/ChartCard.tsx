/**
 * Karta wykresu — jednolita rama dla wszystkich wykresów w analityce.
 *
 * Bliźniak tabelaryczny (`<details>Pokaż dane w tabeli</details>`) siedzi
 * w opakowaniu, a nie w każdym wykresie z osobna. To celowe: dzięki temu nie
 * da się strukturalnie wypuścić wykresu bez dostępnej tabeli.
 * `CmaTrends.tsx:847` robi to ręcznie i przy kolejnym wykresie łatwo o tym
 * zapomnieć.
 */
import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface ChartTableData {
  headers: string[];
  rows: (string | number)[][];
}

export interface ChartCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Kontrolki wyrównane do prawej w nagłówku (filtry, przełączniki). */
  controls?: ReactNode;
  children: ReactNode;
  /** Dane bliźniaka tabelarycznego — obowiązkowe dla każdego wykresu. */
  tableData?: ChartTableData;
  tableLabel?: string;
  /** Co pokazać zamiast wykresu, gdy nie ma danych. */
  empty?: ReactNode;
  /** Nadpisanie detekcji pustki (domyślnie: brak wierszy w `tableData`). */
  isEmpty?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function ChartCard({
  title,
  description,
  controls,
  children,
  tableData,
  tableLabel = "Pokaż dane w tabeli",
  empty,
  isEmpty,
  className,
  bodyClassName,
}: ChartCardProps) {
  const noData = isEmpty ?? (tableData ? tableData.rows.length === 0 : false);
  const showEmpty = noData && empty != null;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {controls && <div className="shrink-0">{controls}</div>}
      </CardHeader>
      <CardContent className={cn("space-y-3", bodyClassName)}>
        {showEmpty ? empty : children}

        {!showEmpty && tableData && tableData.rows.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-700">
              {tableLabel}
            </summary>
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    {tableData.headers.map((h, i) => (
                      <th
                        key={h}
                        className={cn(
                          "px-3 py-2 font-medium",
                          i > 0 && "text-right"
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.rows.map((row, ri) => (
                    <tr key={ri} className="border-t border-slate-100">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className={cn(
                            "px-3 py-2",
                            ci === 0
                              ? "text-slate-700"
                              : "text-right tabular-nums text-slate-900"
                          )}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
