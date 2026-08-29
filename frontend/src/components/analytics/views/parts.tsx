/**
 * Drobne komponenty wspólne dla trzech widoków analityki: stany zastępcze
 * zasobu, onboarding braku kosztów i nagłówek sortowania tabeli.
 *
 * Osobny plik od `./shared`, bo tam mieszka logika (hooki, komparatory,
 * formuły) — plik mieszający jedno z drugim psuje fast refresh.
 */
import { ArrowDown, ArrowUp, ChevronsUpDown, Coins } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/analytics";
import type { LoadState } from "./shared";

/**
 * Ekran zastępczy dla stanów innych niż „mamy dane”. Ponowną próbę robi
 * przycisk „Odśwież” z paska narzędzi — nie dublujemy go w każdej karcie.
 */
export function ResourceNotice({
  state,
}: {
  state: Exclude<LoadState, "ready">;
}) {
  if (state === "loading") {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Ładowanie danych…
        </CardContent>
      </Card>
    );
  }
  if (state === "forbidden") {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <p className="text-sm font-medium text-slate-700">
            Brak uprawnień do tego widoku
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            O dostęp poproś administratora systemu.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-10 text-center">
        <p className="text-sm font-medium text-slate-700">
          Nie udało się wczytać danych
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Spróbuj ponownie przyciskiem „Odśwież” nad zakładkami.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Onboarding pierwszego dnia: dopóki nikt nie wpisał ani jednego kosztu,
 * wykresy zysku i marży nie mają czego rysować. Ściana zer wyglądałaby jak
 * awaria, a marża 100% jak sukces — więc zamiast wykresu mówimy wprost,
 * czego brakuje i gdzie to uzupełnić.
 */
export function NoCostEmpty({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Coins}
      title="Brak danych kosztowych"
      description={`Żaden obiekt nie ma jeszcze uzupełnionego kosztu miesięcznego, więc ${what} nie da się policzyć.`}
      actionLabel="Uzupełnij koszty obiektów"
      actionHref="/objects?hasCost=0"
    />
  );
}

/**
 * Nagłówek klikalny — idiom przepisany z `Objects.tsx:300-330`. Tam sortowanie
 * idzie do API; tutaj wszystkie wiersze są już w pamięci, więc stan sortowania
 * trzyma widok, a układ i strzałki zostają te same.
 */
export function SortHeader({
  label,
  sortKey,
  active,
  dir,
  align = "left",
  onToggle,
  tip,
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
  onToggle: (key: string) => void;
  tip?: string;
}) {
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      title={tip}
      className={cn(
        "py-3 px-2 font-medium",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
      </button>
    </th>
  );
}
