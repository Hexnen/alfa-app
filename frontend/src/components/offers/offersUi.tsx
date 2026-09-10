/**
 * Wspólne klocki wizualne modułu Ofert — te same kształty, których używa dialog
 * wydarzenia w kalendarzu: przycisk wyboru z siatki i chip wartości. Trzymane
 * osobno od `offersShared.ts`, bo tamten plik jest bez JSX.
 *
 * `Section` mieszkała tu do czasu, aż zaczęły jej używać także formularz
 * i kartoteka obiektu — teraz stoi w `components/ui/section.tsx` (klocek ogólny,
 * nie ofertowy), a tutaj zostaje sam reeksport, żeby importy modułu Ofert nie
 * musiały się przenosić.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export { Section } from "@/components/ui/section";

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
