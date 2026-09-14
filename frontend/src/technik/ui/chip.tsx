import type { ComponentProps, ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * CHIP — podstawowy element wyboru na dotyku (filtry, skróty dat, wybory
 * jedno- i wielokrotne). 44 px wysokości, zawsze z etykietą TEKSTOWĄ.
 *
 * W panelu technika chipy zastępują arkusze dolne: przy rękawicy i mokrym
 * ekranie jedno widoczne pole wyboru bije okno, które trzeba najpierw otworzyć.
 */
export interface ChipProps extends Omit<ComponentProps<"button">, "children"> {
  selected?: boolean;
  children: ReactNode;
  /** Wariant kolorystyczny zaznaczenia. */
  tone?: "primary" | "neutral" | "destructive";
  /** Znacznik ✓ przy zaznaczeniu (przydatne przy wyborze wielokrotnym). */
  showCheck?: boolean;
}

export function Chip({
  selected = false,
  tone = "primary",
  showCheck = false,
  className,
  children,
  ...props
}: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-11 select-none items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium",
        "transition-colors active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        selected
          ? tone === "destructive"
            ? "border-destructive bg-destructive/10 text-destructive"
            : tone === "neutral"
              ? "border-foreground/30 bg-muted text-foreground"
              : "border-primary bg-primary/10 text-primary"
          : "border-input bg-background text-foreground hover:bg-muted",
        className,
      )}
      {...props}
    >
      {showCheck && selected && <Check className="size-4 shrink-0" aria-hidden />}
      {children}
    </button>
  );
}

/** Kontener chipów — zawijanie z odstępem ≥8 px. */
export function ChipGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap gap-2", className)} {...props} />;
}
