/**
 * SEKCJA Z NAGŁÓWKIEM — wspólny klocek formularzy i kart szczegółów.
 *
 * Kształt (wersalikowy nagłówek `text-xs font-semibold uppercase tracking-wide`
 * z ikoną `h-3.5 w-3.5`, separator `border-t pt-3 first:border-t-0`) przyszedł
 * z dialogu wydarzenia w kalendarzu i mieszkał dotąd w
 * `components/offers/offersUi.tsx`. Wyniesiony tutaj, bo używa go już nie tylko
 * moduł Ofert, ale też formularz i kartoteka obiektu — a `offersUi` zostaje
 * miejscem na klocki WYŁĄCZNIE ofertowe (`ChoiceButton`, `ValueChip`) i tylko
 * reeksportuje `Section`, żeby dotychczasowe importy nie musiały się przenosić.
 *
 * Wygląd jest przeniesiony 1:1 — to przeprowadzka pliku, nie redesign.
 */
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

/**
 * Sekcja formularza z nagłówkiem; opcjonalnie zwijana, z podsumowaniem.
 *
 * Zwijalność wynika z propsów, a nie z osobnej flagi: sekcja jest składana
 * dokładnie wtedy, gdy woła się ją z parą `open` + `onToggle` (stan trzyma
 * rodzic, bo to on pamięta, które sekcje zostawił otwarte).
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
}: {
  icon: LucideIcon;
  title: string;
  /** Skrót treści pokazywany w nagłówku po zwinięciu sekcji. */
  summary?: ReactNode;
  /** Akcje wyrównane do prawej w linii nagłówka. */
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
