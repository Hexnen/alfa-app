/**
 * Stan pusty — odpowiada na pytanie „nie ma wykresu, więc co mam zrobić?".
 *
 * Przy dziewięciu obiektach filtr potrafi wyzerować zbiór; wtedy zamiast
 * pustego prostokąta pokazujemy powód i najbliższą akcję.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 px-6 py-10 text-center",
        className
      )}
    >
      {Icon && <Icon className="h-8 w-8 text-slate-300" aria-hidden="true" />}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && (
        <p className="max-w-md text-sm text-slate-500">{description}</p>
      )}
      {actionLabel && actionHref && (
        <Link
          to={actionHref}
          className="mt-1 text-sm font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
