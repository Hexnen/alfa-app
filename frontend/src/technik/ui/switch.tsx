import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * PRZEŁĄCZNIK — jedyny w panelu, na razie pod powiadomieniami.
 *
 * Własny, a nie z `components/ui`: CRM nie ma żadnego switcha, a dokładanie
 * Radiksa dla jednego wiersza w „Więcej” byłoby droższe niż te dwadzieścia
 * linii. `role="switch"` + `aria-checked` dają czytnikowi ekranu dokładnie ten
 * sam komunikat co komponent z biblioteki.
 *
 * Suwak ma 52×32 px, ale klikalny jest CAŁY wiersz w liście — palec w rękawicy
 * nie trafia w 32-pikselowy pasek.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  busy,
  label,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Trwa zapis — kółko zamiast gałki, przełącznik nieczynny. */
  busy?: boolean;
  /** Opis dla czytnika ekranu (wiersz obok niesie tekst wizualnie). */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-8 w-[3.25rem] shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "pointer-events-none flex h-7 w-7 items-center justify-center rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0",
        )}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
      </span>
    </button>
  );
}
