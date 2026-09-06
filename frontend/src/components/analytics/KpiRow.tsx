/**
 * Rząd kafelków KPI — nagłówek liczbowy strony analitycznej.
 * Siatka jest ta sama co w Kadrach, żeby kafelki układały się identycznie
 * na wszystkich szerokościach.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface KpiRowProps {
  children: ReactNode;
  className?: string;
}

export function KpiRow({ children, className }: KpiRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6",
        className
      )}
    >
      {children}
    </div>
  );
}
