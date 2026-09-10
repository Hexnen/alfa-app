/**
 * „Moje / Wszyscy" — zakres widoku dla całej sekcji Handlowy.
 *
 * Komponent jest tylko przełącznikiem; stan i jego trwałość mieszkają w hooku
 * `useSalesScope`, żeby Pulpit, Aktywności i Kontakty startowały na tym samym
 * ustawieniu (jeden klucz `alfa.handlowy.scope`, a nie klucz per ekran).
 *
 * Konto bez przypiętego handlowca (`salespeople.user_id`) nie ma czego filtrować
 * — hook zwraca wtedy `hidden: true`, a widok pokazuje wszystko.
 */
import { useCallback, useState } from "react";
import { Users, User } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Zakres widoku działu handlowego: portfel zalogowanego albo cała firma. */
export type SalesScope = "mine" | "all";

/**
 * Wspólny klucz zakresu dla wszystkich ekranów sekcji Handlowy (§5.11 planu).
 * Kalendarz handlowy trzyma jeszcze własny `alfa.handlowy.calendar.scope` —
 * przy okazji zmian w `CalendarPage` warto przepiąć go na ten hook.
 */
export const SALES_SCOPE_STORAGE_KEY = "alfa.handlowy.scope";

function readStored(key: string): SalesScope | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === "mine" || v === "all" ? v : null;
  } catch {
    // Prywatny tryb przeglądarki albo zablokowany storage — pamięć jest miła,
    // ale nie jest warunkiem działania ekranu.
    return null;
  }
}

export interface SalesScopeState {
  scope: SalesScope;
  setScope: (next: SalesScope) => void;
  /** Handlowiec zalogowanego konta — `null`, gdy konto nie ma własnego portfela. */
  salespersonId: number | null;
  /** `true` = nie ma czego przełączać, przełącznika nie pokazujemy. */
  hidden: boolean;
}

/**
 * Zakres „Moje / Wszyscy" dla ekranu handlowego.
 *
 * Domyślnie „Moje", gdy konto ma przypiętego handlowca — handlowiec wchodzi na
 * pulpit po to, żeby zobaczyć SWOJĄ robotę. Konto bez handlowca dostaje „Wszyscy"
 * na sztywno: filtr „moje" oznaczałby dla niego pusty zbiór (backend przy
 * `salespersonId=me` bez dopasowania zwraca zero wierszy, a nie wszystko).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useSalesScope(storageKey: string = SALES_SCOPE_STORAGE_KEY): SalesScopeState {
  const { user } = useAuth();
  const salespersonId = user?.salespersonId ?? null;
  const [stored, setStored] = useState<SalesScope | null>(() => readStored(storageKey));

  const setScope = useCallback(
    (next: SalesScope) => {
      setStored(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        /* prywatny tryb / brak storage — ignoruj */
      }
    },
    [storageKey]
  );

  // Wyliczane, a nie trzymane w stanie: konto dolatuje z `/api/auth/me` już po
  // pierwszym renderze, a efekt „popraw stan po zalogowaniu" gubiłby wybór.
  const scope: SalesScope = salespersonId == null ? "all" : (stored ?? "mine");
  return { scope, setScope, salespersonId, hidden: salespersonId == null };
}

/**
 * Przełącznik „Moje / Wszyscy”. Sam nie wie, co znaczy „moje” — strona ustawia
 * z niego filtr (w kalendarzu: przypisany handlowiec zalogowanego konta).
 * Konto bez przypiętego handlowca przełącznika nie dostaje (chowa go rodzic).
 */
export function SalesScopeToggle({
  value,
  onChange,
  className,
}: {
  value: SalesScope;
  onChange: (next: SalesScope) => void;
  className?: string;
}) {
  const opts: { key: SalesScope; label: string; icon: typeof Users; hint: string }[] = [
    { key: "mine", label: "Moje", icon: User, hint: "Tylko wydarzenia przypisane do mnie" },
    { key: "all", label: "Wszyscy", icon: Users, hint: "Wydarzenia całego działu handlowego" },
  ];
  return (
    <div
      className={cn("inline-flex rounded-full border bg-background p-0.5", className)}
      role="group"
      aria-label="Zakres: moje albo wszyscy"
      data-testid="sales-scope-toggle"
    >
      {opts.map((o) => {
        const active = value === o.key;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            data-testid={`sales-scope-${o.key}`}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            {...tip(o.hint)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6",
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
