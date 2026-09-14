import { forwardRef, useRef, type ComponentProps } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * POLE TEKSTOWE Z „×” DO WYCZYSZCZENIA.
 *
 * Na tablecie poprawka wpisu to dziś: zaznacz wszystko palcem → skasuj. Z „×”
 * to jeden tap. Krzyżyk pojawia się DOPIERO, gdy jest co czyścić — inaczej
 * dwadzieścia pustych krzyżyków w protokole zjadałoby wzrok i miejsce.
 *
 * Zasady, których pilnujemy:
 *  - cel dotykowy 44 px (`w-11` na całą wysokość pola), a nie mikro-ikonka,
 *  - pole NIE zmienia wysokości ani układu, gdy krzyżyk się pojawia (miejsce
 *    rezerwuje stałe `pr-11`),
 *  - po wyczyszczeniu focus wraca do pola — technik pisze dalej bez drugiego
 *    tapnięcia, a klawiatura systemowa nie zjeżdża,
 *  - `onMouseDown` z `preventDefault`: bez tego tap najpierw zabiera focus polu
 *    i klawiatura mrugała.
 */
export interface ClearableInputProps extends Omit<ComponentProps<typeof Input>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Etykieta czytnika ekranu — domyślnie „Wyczyść”. */
  clearLabel?: string;
  /** Klasy pola (nie kontenera) — np. `text-base tabular-nums`. */
  className?: string;
  /** Klasy kontenera — gdy pole ma się rozciągać we flexie. */
  wrapperClassName?: string;
}

export const ClearableInput = forwardRef<HTMLInputElement, ClearableInputProps>(function ClearableInput(
  { value, onChange, clearLabel = "Wyczyść", className, wrapperClassName, disabled, ...props },
  ref,
) {
  const innerRef = useRef<HTMLInputElement>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
  };
  const showClear = !disabled && value.length > 0;

  return (
    <div className={cn("relative", wrapperClassName)}>
      <Input
        ref={setRefs}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn("pr-11", className)}
        {...props}
      />
      {showClear && (
        <button
          type="button"
          aria-label={clearLabel}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            innerRef.current?.focus();
          }}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground active:scale-95 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
});

export interface ClearableTextareaProps
  extends Omit<ComponentProps<typeof Textarea>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  clearLabel?: string;
  wrapperClassName?: string;
}

/**
 * To samo dla pola wielowierszowego — krzyżyk siedzi w prawym GÓRNYM rogu
 * (tekst rośnie w dół, więc róg jest jedynym miejscem, które nie ucieka),
 * a `pr-11` w pierwszej linii pilnuje, żeby nie zasłonił początku zdania.
 */
export const ClearableTextarea = forwardRef<HTMLTextAreaElement, ClearableTextareaProps>(
  function ClearableTextarea(
    { value, onChange, clearLabel = "Wyczyść", className, wrapperClassName, disabled, ...props },
    ref,
  ) {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    const setRefs = (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    };
    const showClear = !disabled && value.length > 0;

    return (
      <div className={cn("relative", wrapperClassName)}>
        <Textarea
          ref={setRefs}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn("pr-11", className)}
          {...props}
        />
        {showClear && (
          <button
            type="button"
            aria-label={clearLabel}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              innerRef.current?.focus();
            }}
            className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-tr-md text-muted-foreground active:scale-95 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    );
  },
);
