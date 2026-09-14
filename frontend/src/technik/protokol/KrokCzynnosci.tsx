import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ListChecks, X } from "lucide-react";
import { Chip } from "../ui/chip";
import { ClearableTextarea } from "../ui/clearable-input";
import { Field, Panel } from "../ui/panel";
import { scrollFieldIntoView } from "../lib/keyboard";
import {
  activityLines,
  isActivityPicked,
  removeActivityAt,
  setActivityNotes,
  splitActivities,
  toggleActivity,
} from "../lib/activities";
import { countLabel } from "../lib/protocol";
import type { StepProps } from "./types";

/** Ile chipów ze słownika widać od razu (reszta pod „Więcej”). */
const VISIBLE_CHIPS = 6;

/**
 * KROK 2 — CO ZOSTAŁO ZROBIONE.
 *
 * Chipy ze słownika stoją NAD polem (pod nim siedziałyby za klawiaturą), a to,
 * co technik wybrał, zamienia się od razu w ponumerowaną listę — bo tak
 * czynności wyglądają na gotowym protokole i tak je czyta biuro. Textarea jest
 * tylko na to, czego w słowniku nie ma.
 */
export function KrokCzynnosci({
  form,
  set,
  readOnly,
  dictionary,
}: StepProps & { dictionary: string[] }) {
  const { picked, notes } = splitActivities(form.activities, dictionary);
  // Licznik liczy CZYNNOŚCI, a nie linie: pusta linia wpisana Enterem nie jest
  // jeszcze niczym wykonanym.
  const total = picked.length + activityLines(notes).length;
  /** Czy pozycja słownika stoi już na liście — także jako linia z dopiskiem. */
  const isPicked = (a: string) => isActivityPicked(picked, dictionary, a);

  /**
   * Słownik potrafi mieć dwadzieścia pozycji, a każda to całe zdanie — na
   * 390 px to dwadzieścia wierszy chipów i krok, przez który trzeba się
   * przewijać, zanim zobaczy się cokolwiek innego. Domyślnie pokazujemy
   * pierwszą szóstkę (plus wszystko, co już wybrane), resztę na tapnięcie.
   */
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? dictionary
    : dictionary.filter((a, i) => i < VISIBLE_CHIPS || isPicked(a));
  const hidden = dictionary.length - visible.length;

  return (
    <div className="space-y-3" data-testid="protokol-panel-czynnosci">
      <Panel
        icon={ListChecks}
        title="Wykonane czynności"
        action={
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {countLabel(total, "czynność", "czynności", "czynności")}
          </span>
        }
      >
        {/* Słownik z panelu admina. Brak słownika = brak rzędu chipów; protokół
            musi dać się wypełnić także wtedy, gdy admin nic nie ustawił. */}
        {dictionary.length > 0 && !readOnly && (
          <div className="flex flex-wrap gap-2" data-testid="activity-chips">
            {visible.map((a) => (
              <Chip
                key={a}
                selected={isPicked(a)}
                showCheck
                className="max-w-full"
                onClick={() => set("activities", toggleActivity(form.activities, dictionary, a))}
              >
                <span className="truncate">{a}</span>
              </Chip>
            ))}
            {(hidden > 0 || expanded) && (
              <Chip
                tone="neutral"
                data-testid="activity-more"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />
                    Mniej
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                    Więcej ({hidden})
                  </>
                )}
              </Chip>
            )}
          </div>
        )}

        {picked.length > 0 ? (
          <ol className="space-y-1.5" data-testid="activity-list">
            {picked.map((line, idx) => (
              <li
                key={`${line}-${idx}`}
                className="flex items-start gap-2 rounded-lg border bg-background p-2 pl-2.5"
              >
                <span className="mt-0.5 w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm leading-snug">{line}</span>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Usuń czynność: ${line}`}
                    onClick={() =>
                      set("activities", removeActivityAt(form.activities, dictionary, idx))
                    }
                    className="-my-1 -mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground active:scale-95 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            {dictionary.length > 0 && !readOnly
              ? "Stuknij czynności ze słownika albo opisz je niżej własnymi słowami."
              : "Opisz niżej, co zostało zrobione na obiekcie."}
          </p>
        )}

        <Field label="Uwagi / inne czynności" htmlFor="p-activities">
          <AutoGrowTextarea
            id="p-activities"
            value={notes}
            disabled={readOnly}
            onChange={(v) => set("activities", setActivityNotes(form.activities, dictionary, v))}
            placeholder="Co jeszcze zostało zrobione, co wymaga uwagi biura…"
          />
        </Field>
      </Panel>
    </div>
  );
}

/**
 * Textarea rosnąca z treścią — uwagi bywają jednym zdaniem i bywają dziesięcioma,
 * a przewijanie wewnątrz małego pola na dotyku walczy z przewijaniem strony.
 */
function AutoGrowTextarea({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 88)}px`;
  }, [value]);

  return (
    <ClearableTextarea
      id={id}
      ref={ref}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={onChange}
      onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
      rows={3}
      clearLabel="Wyczyść uwagi"
      className="resize-none overflow-hidden text-base leading-relaxed"
    />
  );
}
