// Przełącznik miesiąca modułu Kadry.
//
// Strzałki zostają (przewijanie o jeden to najczęstszy ruch), ale sama nazwa
// miesiąca jest teraz przyciskiem: rozliczenie robi się „w tył" — kadrowa
// wchodzi w czerwiec po kwotach sprzed trzech miesięcy i klikanie strzałką
// dziewięć razy było jedyną drogą. Popover daje siatkę 12 miesięcy ze
// strzałkami roku, a „Dziś" wraca do bieżącego miesiąca jednym kliknięciem.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { MONTH_NAMES } from "./shared";
import { TOOLBAR_BTN_CLS, TOOLBAR_ICON_BTN_CLS } from "./ui";

const MONTH_SHORT = [
  "sty",
  "lut",
  "mar",
  "kwi",
  "maj",
  "cze",
  "lip",
  "sie",
  "wrz",
  "paź",
  "lis",
  "gru",
];

export function MonthNav({
  year,
  month,
  onChange,
  className,
}: {
  year: number;
  month: number;
  /** Ustawia parę (rok, miesiąc) naraz — przejście przez granicę roku to jeden ruch. */
  onChange: (year: number, month: number) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Rok w siatce jest niezależny od wybranego: „grudzień 2025" wybiera się
  // przewijając rok w popoverze, a nie zmieniając najpierw miesiąc.
  const [gridYear, setGridYear] = useState(year);
  const boxRef = useRef<HTMLDivElement>(null);

  // Zamknięcie klikiem obok i Escape — popover jest lokalny (bez portalu),
  // więc sam musi posprzątać po sobie.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shift = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    onChange(y, m);
  };

  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;

  return (
    <div className={cn("relative flex items-center gap-1", className)} ref={boxRef}>
      <Button
        variant="outline"
        size="icon"
        className={TOOLBAR_ICON_BTN_CLS}
        onClick={() => shift(-1)}
        {...tip("Poprzedni miesiąc")}
        aria-label="Poprzedni miesiąc"
        data-testid="kadry-month-prev"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <button
        type="button"
        onClick={() => {
          setGridYear(year);
          setOpen((v) => !v);
        }}
        {...tip("Wybierz miesiąc")}
        data-testid="kadry-month-label"
        className={cn(
          "min-w-[132px] rounded-md px-2 text-center font-medium hover:bg-accent",
          // Ta sama wysokość, co przyciski strzałek i reszta paska (palec 40 px,
          // mysz 36 px) — wcześniej etykieta rozpychała rząd o dwa piksele.
          TOOLBAR_BTN_CLS,
        )}
      >
        {MONTH_NAMES[month - 1]} {year}
      </button>
      <Button
        variant="outline"
        size="icon"
        className={TOOLBAR_ICON_BTN_CLS}
        onClick={() => shift(1)}
        {...tip("Następny miesiąc")}
        aria-label="Następny miesiąc"
        data-testid="kadry-month-next"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      {/* „Dziś" jako ikona, nie podpis: stoi w pasku obok strzałek (też
          ikonowych), a w Wynagrodzeniach każde 60 px podpisu wypychało rząd
          filtrów do drugiej linii przy 1366 px. Dymek i `aria-label` niosą
          pełne zdanie. */}
      {!isCurrent && (
        <Button
          variant="ghost"
          size="icon"
          className={TOOLBAR_ICON_BTN_CLS}
          onClick={() => onChange(now.getFullYear(), now.getMonth() + 1)}
          {...tip("Wróć do bieżącego miesiąca")}
          aria-label="Wróć do bieżącego miesiąca"
          data-testid="kadry-month-today"
        >
          <CalendarDays className="h-4 w-4" />
        </Button>
      )}

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-[260px] rounded-md border bg-background p-2 shadow-md"
          data-testid="kadry-month-picker"
        >
          <div className="mb-2 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setGridYear((y) => y - 1)}
              aria-label="Poprzedni rok"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="font-medium tabular-nums">{gridYear}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setGridYear((y) => y + 1)}
              aria-label="Następny rok"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTH_SHORT.map((label, idx) => {
              const m = idx + 1;
              const selected = gridYear === year && m === month;
              const current =
                gridYear === now.getFullYear() && m === now.getMonth() + 1;
              return (
                <button
                  key={label}
                  type="button"
                  data-testid={`kadry-month-pick-${m}`}
                  onClick={() => {
                    onChange(gridYear, m);
                    setOpen(false);
                  }}
                  className={cn(
                    "rounded-md px-2 py-2 text-sm capitalize",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                    !selected && current && "font-semibold text-primary",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
