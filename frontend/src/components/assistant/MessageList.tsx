import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Loader2, Sparkles } from "lucide-react";
import { MessageBubble, type MessageBubbleProps } from "./MessageBubble";
import { decideChanges, decideChoices, decideProposals, isTemplateSuggestion, textOf, toolCallCount, type ChatMessage } from "./parts";

/** Fallback, gdy backend nie zwróci persony (starsza wersja / błąd statusu). */
const DEFAULT_SUGGESTIONS = [
  "Zaplanuj serwis w Magazynie Centralnym w przyszły wtorek 9–11, Wojtek i Dominik",
  "Co ma Wojtek w przyszłym tygodniu?",
  "Dodaj urlop Dominika od poniedziałku do piątku",
];
/** Chip trybu „Podsumowanie dnia” — szablon do composera (luka zaznaczana do nadpisania). */
export const DAY_SUMMARY_LABEL = "Podsumuj dzisiejszy dzień";
export const DAY_SUMMARY_TEMPLATE = "Podsumowanie dnia: [co się dziś wydarzyło — kto co skończył, co przełożone, co dodatkowo]";
const isDaySummary = (s: string) => /podsumowanie dnia|podsumuj dzisiejszy/i.test(s);

const DEFAULT_INTRO =
  "Opisz wydarzenie po polsku — sprawdzę obiekt, techników i konflikty, a potem zaproponuję wpis do zatwierdzenia.";


export interface AssistantPersona {
  name: string;
  greeting: string;
  suggestions: string[];
}

export interface MessageListProps extends Omit<MessageBubbleProps, "message" | "streaming" | "decisions" | "changeDecisions" | "choices" | "isLast"> {
  messages: ChatMessage[];
  /** Status useChat: ready | submitted | streaming | error. */
  status: string;
  onSuggestion: (text: string) => void;
  /** Chip-szablon → tekst do composera (bez wysyłki). */
  onInsertSuggestion: (text: string) => void;
  configured: boolean;
  /** Osobowość z GET /assistant/status (nazwa, powitanie, chipy sugestii). */
  persona?: AssistantPersona | null;
  /** Limit kroków narzędzi w turze (GET /assistant/status.maxSteps; brak → 8). */
  maxSteps: number;
}

/** Licznik sekund od startu tury + podpowiedź o Stop po 20 s. */
function WaitingRow({ steps, maxSteps }: { steps: number; maxSteps: number }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl rounded-bl-sm border border-dashed bg-card px-3.5 py-2 text-xs text-muted-foreground" data-testid="assistant-waiting">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
      <span>{steps > 0 ? "Pracuję…" : "Czekam na odpowiedź…"}</span>
      <span className="tabular-nums opacity-70">{sec} s</span>
      {steps > 0 && (
        <span className="opacity-70">
          · Krok {Math.min(steps, maxSteps)}/{maxSteps}
        </span>
      )}
      {sec >= 20 && <span className="basis-full opacity-80">Trwa dłużej niż zwykle — możesz zatrzymać (Stop / Esc) i doprecyzować polecenie.</span>}
    </div>
  );
}

export function MessageList({ messages, status, onSuggestion, onInsertSuggestion, configured, busy, persona, maxSteps, ...handlers }: MessageListProps) {
  const personaName = persona?.name?.trim() || "Asystent";
  const greeting = persona?.greeting?.trim() || DEFAULT_INTRO;
  const suggestions = persona?.suggestions?.length ? persona.suggestions : DEFAULT_SUGGESTIONS;
  const decisions = useMemo(() => decideProposals(messages), [messages]);
  const changeDecisions = useMemo(() => decideChanges(messages), [messages]);
  // Chip „Podsumuj dzisiejszy dzień” zawsze obecny — chyba że persona ma już własny wariant.
  const hasDaySummary = suggestions.some(isDaySummary);
  const choices = useMemo(() => decideChoices(messages), [messages]);
  const streaming = status === "streaming";
  const submitted = status === "submitted";
  const last = messages[messages.length - 1];
  const lastAssistant = last?.role === "assistant" ? last : undefined;
  const steps = streaming ? toolCallCount(lastAssistant) : 0;

  // Auto-przewijanie, gdy użytkownik jest przy dole.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // Live-region dla czytników: gotowy tekst odpowiedzi po zakończeniu tury (nie cały log).
  // Stan pochodny liczony w renderze (wzorzec „adjusting state on prop change”), bez efektu.
  const [announce, setAnnounce] = useState("");
  const [prevStatus, setPrevStatus] = useState(status);
  if (prevStatus !== status) {
    const was = prevStatus;
    setPrevStatus(status);
    if ((was === "streaming" || was === "submitted") && status === "ready" && lastAssistant) {
      const t = textOf(lastAssistant.parts).trim();
      const cards = (lastAssistant.parts || []).filter((p) => p.type === "tool-propose_event").length;
      const changes = (lastAssistant.parts || []).filter((p) => p.type === "tool-propose_changes").length;
      const q = (lastAssistant.parts || []).filter((p) => p.type === "tool-ask_choice").length;
      const extra = [cards ? `${cards === 1 ? "propozycja do zatwierdzenia" : `${cards} propozycje do zatwierdzenia`}` : "", changes ? "zmiany do zatwierdzenia" : "", q ? "pytanie z opcjami" : ""].filter(Boolean).join(", ");
      setAnnounce([t.slice(0, 400), extra].filter(Boolean).join(". ") || "Asystent odpowiedział.");
    } else if (status === "error") {
      setAnnounce("Błąd odpowiedzi asystenta.");
    }
  }

  const visible = messages.filter((m) => m.role !== "system" || (m.parts || []).length > 0);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      role="log"
      aria-label="Wiadomości asystenta"
    >
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {visible.length === 0 && !submitted && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium">{personaName}</p>
            <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{greeting}</p>
          </div>
          <div className="flex w-full flex-col gap-1.5" aria-label="Sugestie">
            {suggestions.map((s) => {
              const tpl = isTemplateSuggestion(s);
              const day = isDaySummary(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!configured}
                  onClick={() => (day ? onInsertSuggestion(tpl ? s : DAY_SUMMARY_TEMPLATE) : tpl ? onInsertSuggestion(s) : onSuggestion(s))}
                  title={tpl || day ? "Wstawia szablon do pola wiadomości" : undefined}
                  className="min-h-10 rounded-full border bg-card px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
                  data-testid={day ? "suggestion-day-summary" : undefined}
                >
                  {day && <ClipboardList className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-primary" aria-hidden />}
                  {s}
                  {(tpl || day) && <span className="ml-1 text-muted-foreground">(uzupełnij)</span>}
                </button>
              );
            })}
            {!hasDaySummary && (
              <button
                type="button"
                disabled={!configured}
                onClick={() => onInsertSuggestion(DAY_SUMMARY_TEMPLATE)}
                title="Wstawia szablon do pola wiadomości — opisz, co się dziś wydarzyło, a asystent przygotuje zmiany w kalendarzu"
                className="min-h-10 rounded-full border border-dashed border-primary/50 bg-primary/5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
                data-testid="suggestion-day-summary"
              >
                <ClipboardList className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-primary" aria-hidden />
                {DAY_SUMMARY_LABEL}
                <span className="ml-1 text-muted-foreground">(uzupełnij)</span>
              </button>
            )}
          </div>
        </div>
      )}
      {visible.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          streaming={streaming && m === last && m.role === "assistant"}
          decisions={decisions}
          changeDecisions={changeDecisions}
          choices={choices}
          busy={busy || streaming || submitted}
          isLast={m === last}
          {...handlers}
        />
      ))}
      {(submitted || (streaming && steps > 0 && !textOf(lastAssistant?.parts).trim())) && <WaitingRow steps={steps} maxSteps={maxSteps} />}
    </div>
  );
}
