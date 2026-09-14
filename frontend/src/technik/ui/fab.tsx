import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

/**
 * FAB — jedna akcja tworząca na ekranie.
 *
 * 56 px w prawym dolnym rogu, uniesiony nad tab bar (56 px), nad bezpieczny
 * obszar, a przy otwartej klawiaturze nad nią (`--kb`). Tab bar w panelu jest
 * zawsze, więc odsunięcie od dołu jest jedno dla wszystkich szerokości.
 */
export interface FabProps extends ComponentProps<"button"> {
  /** Etykieta — obowiązkowa, bo sama ikona nie niesie znaczenia. */
  label: string;
  /** Pokazuje etykietę obok ikony (pigułka) zamiast samego koła. */
  extended?: boolean;
  asChild?: boolean;
}

export function Fab({ label, extended = false, className, children, asChild, ...props }: FabProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type="button"
      aria-label={label}
      className={cn(
        "fixed right-4 z-40 inline-flex select-none items-center justify-center gap-2 rounded-full",
        "bg-primary text-primary-foreground shadow-lg shadow-black/20",
        "transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "[&_svg]:h-6 [&_svg]:w-6",
        "bottom-[calc(3.5rem+1rem+var(--kb,0px)+env(safe-area-inset-bottom,0px))]",
        extended ? "h-14 px-5 text-base font-medium" : "h-14 w-14",
        className,
      )}
      {...props}
    >
      {children}
      {extended && <span>{label}</span>}
    </Comp>
  );
}
