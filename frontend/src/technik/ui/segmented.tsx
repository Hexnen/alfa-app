import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Krótka etykieta na wąskim ekranie (pełna zostaje dla czytnika ekranu). */
  shortLabel?: string;
  disabled?: boolean;
}

/**
 * SEGMENTY — wybór jednego z co najwyżej sześciu. Przyciski mają 44 px i
 * etykietę tekstową: ikona nigdy nie jest jedynym nośnikiem znaczenia.
 *
 * Klawiatura: strzałki / Home / End jak w natywnej grupie radio — tablet
 * z podpiętą klawiaturą ma działać bez myszy.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
  size = "default",
  full = true,
}: {
  /** Etykieta grupy dla czytnika ekranu (np. „Zakres dni”). */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  /** `sm` = 36 px — tylko tam, gdzie na pewno jest mysz. */
  size?: "default" | "sm";
  full?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (idx - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const opt = options[next];
    if (opt.disabled) return;
    onChange(opt.value);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-stretch gap-1 rounded-xl bg-muted p-1",
        full && "flex w-full",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.shortLabel ? o.label : undefined}
            disabled={o.disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex flex-1 select-none items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium",
              "transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "default" ? "min-h-11" : "min-h-9",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
            <span className="truncate">
              {o.shortLabel ? (
                <>
                  <span className="sm:hidden">{o.shortLabel}</span>
                  <span className="hidden sm:inline">{o.label}</span>
                </>
              ) : (
                o.label
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
