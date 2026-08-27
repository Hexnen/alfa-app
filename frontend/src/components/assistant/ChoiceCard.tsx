import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleHelp, Eye, Loader2, PenLine, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantChoiceOption, AssistantChoiceOutput } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ObjectPeek } from "./ObjectPeek";
import { hasAction, optionHint, optionValue, stripIdFromLabel, type ChoiceState, type PreviewRange } from "./parts";

export interface ChoiceCardProps {
  toolCallId: string;
  choice: AssistantChoiceOutput;
  state?: ChoiceState;
  /** Blokada (stream / zapis). */
  busy?: boolean;
  /** Klik opcji → tekst wysyłany jako zwykła wiadomość użytkownika. */
  onChoose: (text: string) => void;
  /**
   * Klik opcji z gotową `action` (nie-multi) → karta od razu przez POST /choose,
   * bez pytania modelu. Brak propa → zwykłe `onChoose`.
   */
  onChooseAction?: (optionIndex: number, option: AssistantChoiceOption) => void | Promise<void>;
  /** „Inne…” → fokus w composerze. */
  onCustom: () => void;
  /** Hover/fokus opcji ze `startAt/endAt` → podświetlenie slotu na siatce (null = zdjęcie). */
  onPreview?: (range: PreviewRange | null, source: string) => void;
}

/**
 * Indeksy opcji wskazanych przez odpowiedź użytkownika (tekst kolejnej wiadomości).
 * Najpierw dopasowanie dokładne (value/label, także po przecinkach dla multi); gdy brak —
 * najdłuższa etykieta zawarta w odpowiedzi (żeby „Obiekt Testowy 42” nie zaznaczyło „Obiekt Testowy”).
 */
function selectedIndices(answer: string, options: AssistantChoiceOption[], multi: boolean): Set<number> {
  const norm = (s: string) => s.trim().toLowerCase();
  const a = norm(answer);
  const parts = multi ? a.split(/\s*,\s*/).filter(Boolean) : [a];
  const exact = new Set<number>();
  options.forEach((o, i) => {
    const v = norm(optionValue(o));
    const l = norm(o.label);
    if (parts.some((p) => p === v || p === l)) exact.add(i);
  });
  if (exact.size > 0) {
    if (multi) return exact;
    return new Set([Math.min(...exact)]);
  }
  let best = -1;
  let bestLen = 0;
  options.forEach((o, i) => {
    for (const cand of [norm(optionValue(o)), norm(o.label)]) {
      if (cand.length >= 3 && cand.length > bestLen && a.includes(cand)) {
        best = i;
        bestLen = cand.length;
      }
    }
  });
  return best >= 0 ? new Set([best]) : new Set();
}

const slotOf = (o: AssistantChoiceOption): PreviewRange | null =>
  o.startAt && o.endAt
    ? { startAt: o.startAt, endAt: o.endAt, technicianIds: o.technicianId != null ? [o.technicianId] : undefined, title: o.label, type: "slot" }
    : null;

/** Karta pytania `ask_choice`: przyciski-opcje (label + hint), „Inne…”, multi → checkboxy + Dalej. */
export function ChoiceCard({ toolCallId, choice, state, busy = false, onChoose, onChooseAction, onCustom, onPreview }: ChoiceCardProps) {
  const answered = state?.answer != null;
  const multi = Boolean(choice.multi);
  /** Indeks opcji, której akcja (POST /choose) właśnie trwa — karta zablokowana, spinner na opcji. */
  const [acting, setActing] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = Boolean(state?.active) && !busy && acting == null;
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const answer = state?.answer ?? "";
  const selected = useMemo(() => (answered ? selectedIndices(answer, choice.options, multi) : new Set<number>()), [answered, answer, choice.options, multi]);
  const chosen = (i: number) => (answered ? selected.has(i) : multi && picked.has(i));
  const anyMatch = selected.size > 0;

  const togglePick = (i: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  /** Wybór pojedynczej opcji: z akcją → onChooseAction (karta od razu), inaczej zwykła wiadomość. */
  const choose = (i: number) => {
    const o = choice.options[i];
    if (!o) return;
    if (!multi && onChooseAction && hasAction(o)) {
      if (acting != null) return;
      setActing(i);
      Promise.resolve()
        .then(() => onChooseAction(i, o))
        .catch(() => undefined)
        .finally(() => {
          if (mounted.current) setActing(null);
        });
      return;
    }
    onChoose(optionValue(o));
  };
  const pick = (i: number) => {
    if (multi) togglePick(i);
    else choose(i);
  };

  // Klawiatura 1–9 wybiera opcję (gdy fokus poza polem tekstowym) — tylko aktywna karta.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || n > choice.options.length) return;
      e.preventDefault();
      pick(n - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick zależy tylko od multi/options/onChoose/onChooseAction/acting
  }, [active, multi, choice.options, onChoose, onChooseAction, acting]);

  const submitMulti = () => {
    const vals = [...picked].sort((a, b) => a - b).map((i) => optionValue(choice.options[i]));
    if (vals.length) onChoose(vals.join(", "));
  };

  const hasSlots = active && Boolean(onPreview) && choice.options.some((o) => slotOf(o));
  const previewSrc = `choice:${toolCallId}`;
  const hover = (o: AssistantChoiceOption | null) => {
    if (!hasSlots || !onPreview) return;
    onPreview(o ? slotOf(o) : null, previewSrc);
  };
  // Zdejmij podświetlenie slotu, gdy karta przestaje być aktywna / znika.
  useEffect(() => {
    if (!hasSlots || !onPreview) return;
    return () => onPreview(null, previewSrc);
  }, [hasSlots, onPreview, previewSrc]);

  return (
    <div
      className={cn("rounded-lg border bg-background text-sm shadow-sm", answered && "opacity-90")}
      role="group"
      aria-label={`Pytanie: ${choice.question}`}
      data-testid="assistant-choice"
      data-active={active ? "true" : "false"}
      data-toolcall={toolCallId}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div id={`choice-q-${toolCallId}`} className="font-medium leading-snug">
          {choice.question}
        </div>
      </div>
      <div
        className="flex flex-col gap-1.5 px-3 py-2"
        role={multi ? "group" : "radiogroup"}
        aria-labelledby={`choice-q-${toolCallId}`}
        onMouseLeave={() => hover(null)}
      >
        {choice.options.map((o, i) => {
          const sel = chosen(i);
          const disabled = !active;
          const hint = optionHint(o);
          const label = stripIdFromLabel(o.label);
          const idBadge = o.objectId ?? o.technicianId;
          const slot = slotOf(o);
          const instant = !multi && hasAction(o);
          const isActing = acting === i;
          return (
            <div key={i} className="flex items-stretch gap-1">
              <button
                type="button"
                role={multi ? "checkbox" : "radio"}
                aria-checked={sel}
                disabled={disabled}
                onClick={() => pick(i)}
                onMouseEnter={() => slot && hover(o)}
                onFocus={() => slot && hover(o)}
                onBlur={() => slot && hover(null)}
                className={cn(
                  "flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors lg:min-h-0",
                  sel ? "border-primary bg-primary/10" : "bg-card",
                  active && "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  disabled && !sel && "opacity-60",
                  disabled && "cursor-default"
                )}
                data-testid="assistant-choice-option"
                data-slot={slot ? `${slot.startAt}/${slot.endAt}` : undefined}
                data-action={instant ? o.action?.kind : undefined}
                aria-busy={isActing || undefined}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] font-medium",
                    sel ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                    multi && "rounded-sm"
                  )}
                  aria-hidden
                >
                  {isActing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sel ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate">{label}</span>
                    {instant && (
                      <span className="inline-flex shrink-0" title="Karta od razu, bez pytania modelu" data-testid="assistant-choice-instant">
                        <Zap className="h-3 w-3 text-primary" aria-hidden />
                        <span className="sr-only">Karta od razu, bez pytania modelu</span>
                      </span>
                    )}
                    {idBadge != null && (
                      <span
                        className="shrink-0 rounded border px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                        title={o.objectId != null ? "Id obiektu" : "Id technika"}
                      >
                        #{idBadge}
                      </span>
                    )}
                  </span>
                  {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
                </span>
              </button>
              {o.objectId != null && (
                <ObjectPeek
                  objectId={o.objectId}
                  title="Podgląd obiektu"
                  className="min-w-10 shrink-0 justify-center rounded-md border px-2 text-muted-foreground no-underline hover:bg-accent hover:text-foreground lg:min-w-0"
                  onSelect={active ? () => choose(i) : undefined}
                  selectDisabled={!active}
                >
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">Podgląd obiektu {label}</span>
                </ObjectPeek>
              )}
            </div>
          );
        })}
      </div>
      {(multi || choice.allowCustom || answered || active) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2 text-xs">
          {answered ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {anyMatch ? "Wybrano" : `Odpowiedź: ${answer.length > 80 ? `${answer.slice(0, 80)}…` : answer}`}
            </span>
          ) : (
            <>
              {multi && (
                <Button size="sm" className="h-10 text-xs lg:h-7" disabled={!active || picked.size === 0} onClick={submitMulti}>
                  <Check className="mr-1 h-3.5 w-3.5" aria-hidden /> Dalej
                  {picked.size > 0 && ` (${picked.size})`}
                </Button>
              )}
              {choice.allowCustom && (
                <Button size="sm" variant="ghost" className="h-10 text-xs text-muted-foreground lg:h-7" disabled={!active} onClick={onCustom}>
                  <PenLine className="mr-1 h-3.5 w-3.5" aria-hidden /> Inne…
                </Button>
              )}
              {active && <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">Klawisze 1–{Math.min(9, choice.options.length)}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
