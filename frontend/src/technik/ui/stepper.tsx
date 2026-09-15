import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { scrollFieldIntoView } from "../lib/keyboard";

/**
 * STEPPER ± — godziny protokołu (±0,5 h), kilometry (±1 km).
 *
 * Port `medici/frontend/src/components/ui/stepper.tsx`. Wygrywa z polem
 * liczbowym: dwa cele po 44 px i zero klawiatury (zasada „klik zamiast
 * pisania”). Klawiatura zostaje jako awaryjne wyjście — od tego jest
 * `editable`: 137 km nabijane plusem byłoby żartem, ale poprawka o 2 km
 * ma być dwoma tapnięciami, nie zaznaczaniem tekstu palcem.
 *
 * ```tsx
 * <Stepper label="Godziny" value={h} onChange={setH}
 *          step={0.5} min={0} max={24} format={(v) => `${v} h`} />
 * ```
 */
export function Stepper({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  label,
  format = (v) => String(v),
  className,
  disabled,
  editable = false,
  inputMode = "decimal",
  "data-testid": testId,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Etykieta dla czytnika ekranu (i przycisków „mniej/więcej”). */
  label: string;
  format?: (v: number) => string;
  className?: string;
  disabled?: boolean;
  /** Środek jest polem liczbowym, a nie tylko odczytem. */
  editable?: boolean;
  inputMode?: "decimal" | "numeric";
  "data-testid"?: string;
}) {
  /**
   * Tekst w trakcie pisania trzymamy osobno: `value` jest liczbą, więc „1,”
   * albo puste pole nie da się przez nią przepuścić bez kasowania tego, co
   * technik właśnie wpisuje.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (v: number) => {
    setDraft(null);
    onChange(clamp(v));
  };

  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border border-input bg-background p-1",
        disabled && "opacity-60",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => commit(value - step)}
        disabled={disabled || value <= min}
        aria-label={`${label}: mniej`}
        className="inline-flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-lg text-foreground transition-colors active:scale-[0.95] hover:bg-muted disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Minus className="h-5 w-5" aria-hidden />
      </button>

      {editable ? (
        <input
          type="text"
          aria-label={label}
          inputMode={inputMode}
          disabled={disabled}
          value={draft ?? format(value)}
          onFocus={(e) => {
            // Wejście w pole pokazuje samą liczbę — jednostka („h”, „km”)
            // nie ma się dopisywać do tego, co technik wpisze.
            setDraft(String(value).replace(".", ","));
            requestAnimationFrame(() => e.target.select());
            // Stepper stoi w kroku 1 protokołu na samym dole ekranu — bez tego
            // „Godziny” i „Kilometry” chowały się pod klawiaturą iPada.
            scrollFieldIntoView(e.currentTarget);
          }}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const n = Number(raw.replace(",", "."));
            if (raw.trim() === "") onChange(clamp(0));
            else if (Number.isFinite(n)) onChange(clamp(n));
          }}
          onBlur={() => setDraft(null)}
          className="h-11 w-[5.5rem] min-w-0 rounded-lg bg-transparent px-1 text-center text-base font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        />
      ) : (
        <output
          aria-live="polite"
          className="w-[5.5rem] px-1 text-center text-base font-medium tabular-nums"
        >
          {format(value)}
        </output>
      )}

      <button
        type="button"
        onClick={() => commit(value + step)}
        disabled={disabled || value >= max}
        aria-label={`${label}: więcej`}
        className="inline-flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-lg text-foreground transition-colors active:scale-[0.95] hover:bg-muted disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}
