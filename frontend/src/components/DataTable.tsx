import { useEffect, useRef } from "react";
import { Grid, html } from "gridjs";
import "gridjs/dist/theme/mermaid.css";

interface Column {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formatter?: (cell: any, row: any) => string;
}

interface DataTableProps {
  columns: Column[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  search?: boolean;
  pagination?: boolean | { limit: number };
  sort?: boolean;
  className?: string;
}

export function DataTable({
  columns,
  data,
  search = true,
  pagination = { limit: 10 },
  sort = true,
  className = "",
}: DataTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Grid | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const gridColumns = columns.map((col) => ({
      id: col.id,
      name: col.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: col.formatter
        ? (cell: any, row: any) => html(col.formatter!(cell, row))
        : undefined,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gridData: any[][] = data.map((row) =>
      columns.map((col) => row[col.id])
    );

    if (gridRef.current) {
      gridRef.current.updateConfig({
        data: gridData,
      }).forceRender();
    } else {
      gridRef.current = new Grid({
        columns: gridColumns,
        data: gridData,
        search,
        pagination,
        sort,
        language: {
          search: {
            placeholder: "Szukaj...",
          },
          pagination: {
            previous: "Poprzednia",
            next: "Nastepna",
            showing: "Wyswietlono",
            of: "z",
            to: "do",
            results: "wynikow",
          },
          noRecordsFound: "Brak danych",
          error: "Wystapil blad podczas pobierania danych",
        },
        className: {
          table: "min-w-full",
          th: "text-left font-medium",
          td: "py-2",
        },
      }).render(containerRef.current);
    }

    return () => {
      if (gridRef.current) {
        gridRef.current.destroy();
        gridRef.current = null;
      }
    };
  }, [columns, data, search, pagination, sort]);

  return <div ref={containerRef} className={className} />;
}
