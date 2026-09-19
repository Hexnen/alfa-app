// Elementy tabel modułu Kadry współdzielone przez podzakładki.
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
// Dymek aplikacji zamiast natywnego `title`: ten sam wygląd co podpowiedzi
// w kalendarzu (tło `popover`, `text-xs`, treść wieloliniowa) i to samo
// opóźnienie — natywny `title` czekał ~2 s i łamał linie po swojemu.
import { tip as tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOOLBAR_BTN_CLS } from "./ui";

/**
 * Przycisk rozwijający rzadziej używane filtry. Osiem list wyboru w jednym
 * pasku zawijało się na dwa rzędy i ucinało etykiety („Umowa:…"), a używane są
 * zwykle dwie: miesiąc i szukajka. Licznik na przycisku pilnuje, żeby schowany
 * filtr nie zawężał tabeli po cichu.
 */
export function MoreFiltersButton({
  open,
  onToggle,
  count,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  /** Ile ze schowanych filtrów jest aktywnych (0 = przycisk bez liczby). */
  count: number;
  testId?: string;
}) {
  return (
    <Button
      variant={count > 0 ? "secondary" : "outline"}
      size="sm"
      className={TOOLBAR_BTN_CLS}
      onClick={onToggle}
      data-testid={testId}
      aria-expanded={open}
      {...tooltip(
        count > 0
          ? `Dodatkowe filtry — aktywne: ${count}`
          : "Dodatkowe filtry: spółka, umowa, dział, kanał wypłaty…",
      )}
    >
      <SlidersHorizontal className="mr-1 h-4 w-4" />
      Filtry{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}

/**
 * Nagłówek kolumny z tooltipem (hover) opisującym, z czego liczy się wartość —
 * w Kadrach prawie każda kolumna jest wynikiem kalkulacji, więc opis „skąd to
 * się bierze" jest częścią tabeli, a nie dokumentacji obok niej.
 */
export function Th({
  tip,
  wrap,
  children,
  className,
}: {
  tip?: string;
  /**
   * Nagłówek może się złamać na dwie linie. Pełna nazwa kolumny („Premia /
   * potrącenie") bywa szersza niż jej dane — wtedy zawijamy nagłówek, zamiast
   * skracać go do „Premia/potr.", bo skrót trzeba odczytywać, a dwie linie nie.
   */
  wrap?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      {...(tip ? tooltip(tip) : {})}
      className={cn(
        "px-3 py-2 text-left font-medium align-bottom",
        wrap ? "whitespace-normal leading-tight" : "whitespace-nowrap",
        // Sam `cursor-help` mówi „jest wyjaśnienie" — podkreślenie kropkowane
        // dokładało w nagłówku drugą linię, która zlewała się z obramowaniem
        // tabeli i kłóciła się z podkreśleniem linków.
        tip && "cursor-help",
        className,
      )}
    >
      {children}
    </th>
  );
}

export type SortDir = "asc" | "desc";

/**
 * Klikalny nagłówek — strzałka pokazuje kolumnę i kierunek sortowania.
 * Tooltip „z czego się kalkuluje" zostaje: w Kadrach opis kolumny jest tak
 * samo potrzebny jak możliwość jej posortowania.
 */
export function SortTh<K extends string>({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  tip,
  wrap,
  align = "left",
  testIdPrefix,
  className,
}: {
  label: string;
  sortKey: K;
  sort: K;
  dir: SortDir;
  onSort: (key: K) => void;
  tip?: string;
  /** Nagłówek łamie się na dwie linie zamiast skracać nazwę — patrz `Th`. */
  wrap?: boolean;
  align?: "left" | "right";
  /** Prefiks `data-testid` przycisku, np. „hours-sort". */
  testIdPrefix?: string;
  className?: string;
}) {
  const active = sort === sortKey;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      {...(tip ? tooltip(tip) : {})}
      className={cn(
        "px-3 py-2 font-medium align-bottom",
        wrap ? "whitespace-normal leading-tight" : "whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        data-testid={testIdPrefix ? `${testIdPrefix}-${sortKey}` : undefined}
        className={cn(
          // `text-transform` i `letter-spacing` NIE dziedziczą się do <button>
          // (reset przeglądarki dla kontrolek formularza), więc nagłówek
          // sortowalny wychodził pisany małymi literami obok wersalikowego
          // nagłówka zwykłego — w jednej i tej samej tabeli. Wymuszamy
          // dziedziczenie, żeby oba wyglądały tak samo niezależnie od `<thead>`.
          "[text-transform:inherit] [letter-spacing:inherit]",
          "-mx-1 inline-flex items-center gap-1 rounded px-1 text-left transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse text-right",
          // Bez podkreślenia — jak w `Th`; o wyjaśnieniu mówi kursor.
          tip && "cursor-help",
          active ? "text-foreground" : "",
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-40")} />
      </button>
    </th>
  );
}
