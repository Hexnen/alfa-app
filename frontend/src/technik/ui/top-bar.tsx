import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * GÓRNY PASEK, 48 px — sticky kontekst „gdzie jestem”.
 *
 * Lewy górny róg jest celowo ubogi: to najdalszy punkt od kciuka trzymającego
 * tablet. Wszystko, co się klika, ląduje po prawej. „Wstecz” to wyjątek — gest
 * wyuczony systemowo, dublowany przez swipe przeglądarki.
 */
export function TopBar({
  title,
  subtitle,
  back,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** `true` = strzałka wstecz (historia), string = konkretna ścieżka. */
  back?: boolean | string;
  /** Akcje po prawej. */
  right?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex min-h-12 items-center gap-1 border-b bg-background/95 px-2 pt-safe backdrop-blur-sm",
        className,
      )}
    >
      {back && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Wstecz"
          onClick={() => (typeof back === "string" ? navigate(back) : navigate(-1))}
          className="h-11 w-11 shrink-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
      )}
      <div className={cn("min-w-0 flex-1", !back && "pl-2")}>
        <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">{right}</div>
    </header>
  );
}
