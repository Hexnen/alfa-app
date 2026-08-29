/**
 * Nota pokrycia danymi — odpowiada na pytanie „na ilu obiektach ta liczba
 * właściwie stoi?".
 *
 * Koszt bywa `null` („nieuzupełniony"), co NIE znaczy 0 zł. Każda agregacja
 * marży liczona z takiej próbki jest prawdziwa tylko dla części obiektów
 * i ta linijka to pokazuje, zamiast pozwalać czytać wynik jako pewny.
 */
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CoverageProps {
  /** Ile rekordów ma uzupełniony koszt. */
  known: number;
  /** Ile jest wszystkich rekordów. */
  total: number;
  /** Dopełniacz liczby mnogiej: „obiektów", „spółek", „handlowców". */
  noun?: string;
  /** Docelowy filtr braków, np. `/objects?hasCost=0`. */
  href?: string;
  linkLabel?: string;
  /** Ikona ostrzeżenia — domyślnie ukryta, bo w kafelku KPI zabiera wiersz. */
  withIcon?: boolean;
  className?: string;
}

export function CoverageNote({
  known,
  total,
  noun = "obiektów",
  href,
  linkLabel = "uzupełnij",
  withIcon = false,
  className,
}: CoverageProps) {
  // Pełne pokrycie nie wymaga komentarza — nota ma się pojawiać tylko wtedy,
  // gdy naprawdę czegoś brakuje.
  if (total <= 0 || known >= total) return null;
  const share = Math.round((known / total) * 100);

  return (
    <p
      className={cn(
        "flex items-center gap-1 text-xs text-amber-600",
        className
      )}
    >
      {withIcon && <AlertTriangle className="h-3 w-3 shrink-0" />}
      <span>
        koszt uzupełniony dla {known} z {total} {noun} ({share}%)
      </span>
      {href && (
        <Link
          to={href}
          className="shrink-0 font-medium underline underline-offset-2 hover:text-amber-700"
        >
          {linkLabel}
        </Link>
      )}
    </p>
  );
}
