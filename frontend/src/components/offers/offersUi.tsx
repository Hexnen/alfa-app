/**
 * Wspólne klocki wizualne modułu Ofert — te same kształty, których używa dialog
 * wydarzenia w kalendarzu: sekcja z nagłówkiem, przycisk wyboru z siatki i chip
 * wartości. Trzymane osobno od `offersShared.ts`, bo tamten plik jest bez JSX.
 */
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Sekcja formularza z nagłówkiem; opcjonalnie zwijana, z podsumowaniem. */
export function Section({
  icon: Icon,
  title,
  summary,
  action,
  open,
  onToggle,
  children,
  id,
}: {
  icon: LucideIcon;
  title: string;
  summary?: ReactNode;
  action?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  id: string;
}) {
  const collapsible = typeof open === "boolean" && !!onToggle;
  const head = (
    <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {title}
      {collapsible && !open && summary && (
        <span className="ml-1 truncate font-normal normal-case tracking-normal text-foreground/80">
          — {summary}
        </span>
      )}
    </span>
  );
  return (
    <section aria-labelledby={`${id}-h`} className="border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        {collapsible ? (
          <button
            type="button"
            id={`${id}-h`}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={onToggle}
            className="-mx-1 flex min-w-0 flex-1 items-center justify-between rounded px-1 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {head}
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        ) : (
          <div id={`${id}-h`} className="py-1">
            {head}
          </div>
        )}
        {action}
      </div>
      {(!collapsible || open) && (
        <div id={`${id}-body`} className="mt-2 space-y-3">
          {children}
        </div>
      )}
    </section>
  );
}

/** Przycisk wyboru z siatki — jak typ i status wydarzenia w kalendarzu. */
export function ChoiceButton({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}

/** Chip wartości liczbowej — kształt jak chipy długości trwania w kalendarzu. */
export function ValueChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
