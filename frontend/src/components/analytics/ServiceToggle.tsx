/**
 * Przełącznik linii usługowej: ZDV / OFI / Oba.
 *
 * Firma sprzedaje dwie zupełnie różne rzeczy — zdalny dozór wizyjny (kamery,
 * SSWiN, wideorecepcja, obsługiwane z centrum monitorowania) i ochronę fizyczną
 * (ludzie na obiekcie). Wspólne kafelki opisują średnią z obu, a średnia z dwóch
 * modeli biznesowych nie opisuje żadnego z nich: OFI ma inny koszt osobowy, inną
 * marżę i inny sens „pokrycia danymi".
 *
 * Segmentowana grupa przycisków, a nie `Select`: opcje są trzy i wybór ma być
 * widoczny bez klikania — użytkownik musi wiedzieć, na co patrzy, ZANIM przeczyta
 * liczby. Idiom (`rounded-full` + `bg-primary` na aktywnym) jest ten sam, co
 * pigułki filtrów w Kalendarzu.
 *
 * UWAGA na czytanie liczb: LICZBA OBIEKTÓW nie jest rozłączna — obiekt z OFI i
 * kamerami policzy się w obu przekrojach. PRZYCHÓD już tak: od rozbicia
 * abonamentu (wrzesień 2026) obiekt wchodzi do przekroju tylko tą częścią
 * kwoty, która do danej linii należy, więc „ZDV" plus „OFI" daje dokładnie tyle,
 * co „Oba".
 */
import { Camera, Layers, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalyticsService } from "@/lib/api";
import { SERVICE_LABELS } from "./service";

const OPTIONS: Array<{
  key: AnalyticsService;
  icon: typeof Camera;
  tip: string;
}> = [
  {
    key: "zdv",
    icon: Camera,
    tip:
      "Zdalny dozór wizyjny: obiekty z kamerami, SSWiN-em albo wideorecepcją.\n" +
      "Przychód = abonament ZDW plus dzierżawa sprzętu.\n" +
      "Koszt osobowy = wyłącznie udział w puli centrum monitorowania.",
  },
  {
    key: "ofi",
    icon: Shield,
    tip:
      "Ochrona fizyczna: obiekty z OFI.\n" +
      "Przychód = abonament OFI.\n" +
      "Koszt osobowy = wyłącznie wypłaty za godziny przepracowane na obiekcie.",
  },
  {
    key: "all",
    icon: Layers,
    tip:
      "Obie linie razem — pełny obraz firmy.\n" +
      "Obiekt z OFI i kamerami należy do OBU przekrojów (licznik obiektów się dubluje),\n" +
      "ale jego abonament jest rozbity, więc przychód „ZDV” plus „OFI” równa się tej liczbie.",
  },
];

export interface ServiceToggleProps {
  value: AnalyticsService;
  onChange: (value: AnalyticsService) => void;
}

export function ServiceToggle({ value, onChange }: ServiceToggleProps) {
  return (
    <div
      className="inline-flex rounded-full border bg-background p-0.5"
      role="group"
      aria-label="Linia usługowa"
    >
      {OPTIONS.map((o) => {
        const active = value === o.key;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            data-testid={`analytics-service-${o.key}`}
            aria-pressed={active}
            title={o.tip}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {SERVICE_LABELS[o.key]}
          </button>
        );
      })}
    </div>
  );
}
