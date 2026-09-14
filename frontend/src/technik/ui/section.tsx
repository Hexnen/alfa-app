import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * SEKCJA Z NAGŁÓWKIEM — wspólny klocek ekranu zlecenia i protokołu:
 * wersalikowy nagłówek `text-xs` z ikoną, separator poza pierwszą sekcją.
 *
 * Zwijalność wynika z propsów, a nie z osobnej flagi: sekcja jest składana
 * dokładnie wtedy, gdy dostanie parę `open` + `onToggle` (stan trzyma rodzic,
 * bo to on pamięta, co technik zostawił otwarte). Przycisk nagłówka ma
 * `min-h-11` — zwijanie to zwykły cel dotykowy.
 */
export function Section({
  icon: Icon,
  title,
  summary,
  action,
  open,
  onToggle,
  children,
  id,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  /** Skrót treści pokazywany w nagłówku po zwinięciu. */
  summary?: ReactNode;
  /** Akcje wyrównane do prawej w linii nagłówka. */
  action?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  id: string;
  className?: string;
}) {
  const collapsible = typeof open === "boolean" && !!onToggle;
  const head = (
    <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      {title}
      {collapsible && !open && summary && (
        <span className="ml-1 truncate font-normal normal-case tracking-normal text-foreground/80">
          — {summary}
        </span>
      )}
    </span>
  );

  return (
    <section
      aria-labelledby={`${id}-h`}
      className={cn("border-t pt-3 first:border-t-0 first:pt-0", className)}
    >
      <div className="flex items-center justify-between gap-2">
        {collapsible ? (
          <button
            type="button"
            id={`${id}-h`}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={onToggle}
            className="-mx-2 flex min-h-11 min-w-0 flex-1 items-center justify-between rounded-lg px-2 text-left active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
