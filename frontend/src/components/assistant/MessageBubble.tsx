import { memo, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Brain,
  CalendarClock,
  CalendarSearch,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MapPin,
  PauseCircle,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  UserSearch,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantProposal } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Prose } from "./Prose";
import { ProposalCard, type ProposalCardProps } from "./ProposalCard";
import { ChoiceCard, type ChoiceCardProps } from "./ChoiceCard";
import { ObjectPeek } from "./ObjectPeek";
import { fmtRange } from "@/lib/calendar-labels";
import {
  ERROR_HINTS,
  choiceOf,
  conflictsBefore,
  errorOf,
  errorText,
  isAborted,
  isErrorPart,
  isReasoningPart,
  isTextPart,
  isToolPart,
  proposalOf,
  systemNoteOf,
  toolName,
  type ChatMessage,
  type ChoiceState,
  type ProposalDecisions,
  type ToolPart,
} from "./parts";

// ---------------------------------------------------------------------------
// Etykiety narzędzi (PL) per stan
// ---------------------------------------------------------------------------

interface ToolLabel {
  icon: LucideIcon;
  running: (input: Record<string, unknown>) => string;
  done: (output: Record<string, unknown>, input: Record<string, unknown>) => string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const arrLen = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const PLURAL = new Intl.PluralRules("pl-PL");
const plural = (n: number, one: string, few: string, many: string) => {
  const cat = PLURAL.select(n);
  return `${n} ${cat === "one" ? one : cat === "few" ? few : many}`;
};

const TOOL_LABELS: Record<string, ToolLabel> = {
  find_object: {
    icon: MapPin,
    running: (i) => `Szukam obiektu${str(i.query) ? ` „${str(i.query)}”` : ""}…`,
    done: (o) => {
      const objs = Array.isArray(o.objects) ? (o.objects as { name?: string }[]) : [];
      const count = typeof o.count === "number" ? o.count : objs.length;
      if (count === 0) return "Nie znaleziono obiektu";
      if (count === 1) return `Znaleziono obiekt: ${objs[0]?.name ?? "?"}`;
      return `Znaleziono ${plural(count, "obiekt", "obiekty", "obiektów")}${o.ambiguous ? " — wymaga wyboru" : ""}`;
    },
  },
  find_technician: {
    icon: UserSearch,
    running: (i) => `Szukam technika${str(i.query) ? ` „${str(i.query)}”` : ""}…`,
    done: (o) => {
      const t = Array.isArray(o.technicians) ? (o.technicians as { name?: string }[]) : [];
      if (t.length === 0) return "Nie znaleziono technika";
      if (t.length === 1) return `Technik: ${t[0].name ?? "?"}`;
      return `Znaleziono ${plural(t.length, "technika", "techników", "techników")}: ${t.map((x) => x.name).filter(Boolean).join(", ")}`;
    },
  },
  list_events: {
    icon: CalendarSearch,
    running: () => "Przeglądam kalendarz…",
    done: (o) => {
      const n = arrLen(o.events);
      if (n === 0) return "Brak wydarzeń w tym zakresie";
      return `Znaleziono ${plural(n, "wydarzenie", "wydarzenia", "wydarzeń")}${o.truncated ? " (lista skrócona)" : ""}`;
    },
  },
  check_conflicts: {
    icon: ShieldAlert,
    running: () => "Sprawdzam konflikty…",
    done: (o) => {
      const n = arrLen(o.conflicts);
      return n === 0 ? "Brak konfliktów" : `Uwaga: ${plural(n, "konflikt", "konflikty", "konfliktów")}`;
    },
  },
  find_free_slots: {
    icon: CalendarClock,
    running: () => "Szukam wolnych terminów…",
    done: (o) => {
      const n = arrLen(o.slots);
      return n === 0 ? (str(o.note) || "Brak wolnych terminów") : `Wolne terminy: ${plural(n, "propozycja", "propozycje", "propozycji")}`;
    },
  },
  ask_choice: {
    icon: Sparkles,
    running: () => "Przygotowuję pytanie…",
    done: () => "Pytanie do użytkownika",
  },
  propose_event: {
    icon: Sparkles,
    running: () => "Przygotowuję propozycję…",
    done: () => "Propozycja gotowa",
  },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

type FoundObject = { id?: number; name?: string; address?: string | null; city?: string | null };
type FreeSlot = { startAt: string; endAt: string; weekday?: string };

/** Rozwijane szczegóły wyniku narzędzia: lista obiektów (z podglądem) albo lista wolnych slotów. */
function toolDetails(name: string, output: Record<string, unknown>): { count: number; render: () => ReactElement } | null {
  if (name === "find_object") {
    const objs = (Array.isArray(output.objects) ? output.objects : []) as FoundObject[];
    if (objs.length === 0) return null;
    const dup = new Set<number>(Array.isArray(output.duplicateIds) ? (output.duplicateIds as number[]) : []);
    return {
      count: objs.length,
      render: () => (
        <ul className="ml-5 mt-0.5 space-y-0.5 text-xs" data-testid="found-objects">
          {objs.map((o, i) => {
            const addr = [o.address, o.city].filter(Boolean).join(", ");
            const label = (
              <>
                <span className="text-foreground">{o.name ?? "?"}</span>
                {addr && <span className="text-muted-foreground"> · {addr}</span>}
                {o.id != null && dup.has(o.id) && <span className="text-muted-foreground"> (duplikat)</span>}
              </>
            );
            return (
              <li key={o.id ?? i} className="truncate">
                {o.id != null ? <ObjectPeek objectId={o.id} title="Podgląd obiektu">{label}</ObjectPeek> : label}
              </li>
            );
          })}
        </ul>
      ),
    };
  }
  if (name === "find_free_slots") {
    const slots = (Array.isArray(output.slots) ? output.slots : []) as FreeSlot[];
    if (slots.length === 0) return null;
    return {
      count: slots.length,
      render: () => (
        <ul className="ml-5 mt-0.5 space-y-0.5 text-xs text-foreground" data-testid="free-slots">
          {slots.map((s, i) => (
            <li key={i}>
              {s.weekday ? `${s.weekday}, ` : ""}
              {fmtRange(s.startAt, s.endAt, false)}
            </li>
          ))}
        </ul>
      ),
    };
  }
  return null;
}

/** Jeden wiersz statusu narzędzia. */
function ToolRow({ part, live }: { part: ToolPart; live: boolean }) {
  const name = toolName(part);
  const meta = TOOL_LABELS[name];
  const Icon = meta?.icon ?? Sparkles;
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  const unfinished = part.state === "input-streaming" || part.state === "input-available";
  // Part bez wyniku w wiadomości, która już się nie streamuje (historia po Stop/
  // zerwanym połączeniu) — pokazujemy jako przerwany, nie wieczny spinner.
  const running = unfinished && live;
  const interrupted = unfinished && !live;
  const failed = interrupted || part.state === "output-error" || (part.state === "output-available" && typeof output.error === "string");

  let label: string;
  if (running) label = meta ? meta.running(input) : `Wywołuję ${name}…`;
  else if (interrupted) label = `${meta ? meta.running(input).replace(/…$/, "") : name} — przerwane`;
  else if (part.state === "output-error") label = part.errorText || `Błąd narzędzia ${name}`;
  else if (typeof output.error === "string") label = output.error;
  else label = meta ? meta.done(output, input) : `Zakończono ${name}`;

  const warn = name === "check_conflicts" && !failed && arrLen(output.conflicts) > 0;
  const details = !failed && part.state === "output-available" ? toolDetails(name, output) : null;
  const [open, setOpen] = useState(false);

  const row = (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        failed ? "text-red-600 dark:text-red-400" : warn ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
      )}
    >
      {running ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : failed ? (
        <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : warn ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      {details && (open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />)}
    </div>
  );
  if (!details) return row;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="-mx-1 min-h-10 rounded px-1 py-0.5 text-left hover:bg-accent lg:min-h-0"
        data-testid={`tool-details-${name}`}
      >
        {row}
      </button>
      {open && details.render()}
    </div>
  );
}

/** Zwinięte rozumowanie modelu. */
function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
        <Brain className="h-3.5 w-3.5" aria-hidden />
        {streaming ? "Myślę…" : "Rozumowanie"}
      </button>
      {open && <Prose text={text} className="mt-1 border-l-2 pl-2 italic" />}
    </div>
  );
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Ta wiadomość właśnie się streamuje. */
  streaming?: boolean;
  /** Decyzje użytkownika per toolCallId propozycji + skonsumowane chipy systemowe. */
  decisions: ProposalDecisions;
  onApprove: ProposalCardProps["onApprove"];
  onEdit: ProposalCardProps["onEdit"];
  onReject: ProposalCardProps["onReject"];
  onOpenEvent: ProposalCardProps["onOpenEvent"];
  onPreview?: ProposalCardProps["onPreview"];
  /** Stany kart pytań (ask_choice) per toolCallId. */
  choices: Map<string, ChoiceState>;
  onChoose: ChoiceCardProps["onChoose"];
  onCustomChoice: ChoiceCardProps["onCustom"];
  /** Blokada akcji na kartach (stream w toku / trwa zapis). */
  busy?: boolean;
  /** Ostatnia wiadomość asystenta była przerwana → „Kontynuuj”. */
  onContinue?: () => void;
  /** Błąd tury → „Ponów” (ostatnia wiadomość). */
  onRetry?: () => void;
  /** Czy to ostatnia wiadomość w czacie (akcje Kontynuuj/Ponów tylko dla niej). */
  isLast?: boolean;
}

export const MessageBubble = memo(function MessageBubble({
  message: m,
  streaming = false,
  decisions,
  onApprove,
  onEdit,
  onReject,
  onOpenEvent,
  onPreview,
  choices,
  onChoose,
  onCustomChoice,
  busy,
  onContinue,
  onRetry,
  isLast = false,
}: MessageBubbleProps) {
  const parts = m.parts || [];
  const isUser = m.role === "user";
  const [bulk, setBulk] = useState<"idle" | "running">("idle");

  // Wiadomości systemowe („Wydarzenie #12 zapisane”) — dyskretny separator;
  // ukryty, gdy decyzję widać już na karcie propozycji.
  if (m.role === "system") {
    if (decisions.consumedSystemIds.has(m.id)) return null;
    const note = systemNoteOf(m);
    const t = note?.text?.trim() ?? "";
    if (!t) return null;
    return (
      <div className="flex justify-center px-2 py-0.5">
        <span className="rounded-full border bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground" data-testid="assistant-system-chip">
          {t}
        </span>
      </div>
    );
  }

  if (isUser) {
    const t = parts.filter(isTextPart).map((p) => p.text).join("");
    return (
      <div className="ml-auto flex max-w-[88%] flex-col items-end">
        <div className="w-fit rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
          <Prose text={t} className="asst-prose-onprimary" />
        </div>
      </div>
    );
  }

  const err = errorOf(parts);
  const aborted = isAborted(m);
  const hasContent = parts.some((p) => !isErrorPart(p) && (!isTextPart(p) || p.text.trim()) && p.type !== "data-aborted" && p.type !== "data-system");
  if (!hasContent && !err && !streaming && !aborted) return null;

  // Ostatni tekstowy part dostaje domykanie markdownu / kursor.
  let lastTextIdx = -1;
  // Tekst, po którym w tej samej wiadomości idzie jeszcze narzędzie, to narracja
  // kroku pośredniego („Sprawdzam kolizje…”) — wyciszony, jedna linia.
  let lastToolIdx = -1;
  parts.forEach((p, i) => {
    if (isTextPart(p)) lastTextIdx = i;
    if (isToolPart(p)) lastToolIdx = i;
  });

  // Karty propozycji bez decyzji w tej wiadomości — „Zatwierdź wszystkie” gdy >1.
  const pendingProposals: { id: string; proposal: AssistantProposal }[] = [];
  for (const p of parts) {
    if (!isToolPart(p)) continue;
    const out = proposalOf(p);
    if (out?.proposal && out.needsConfirmation !== false && !decisions.byCard.has(p.toolCallId)) {
      pendingProposals.push({ id: p.toolCallId, proposal: out.proposal });
    }
  }
  const approveAll = async () => {
    setBulk("running");
    try {
      for (const { id, proposal } of pendingProposals) {
        // Sekwencyjnie: każda karta dostaje własną notatkę systemową i toast.
        await onApprove(id, proposal);
      }
    } catch {
      /* błąd pokaże karta, która go zgłosiła (jej własny stan) — tu tylko kończymy pętlę */
    } finally {
      setBulk("idle");
    }
  };
  const hint = err?.code ? ERROR_HINTS[err.code] : undefined;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {hasContent || streaming ? (
        <div className="flex w-full flex-col gap-1.5 rounded-2xl rounded-bl-sm border bg-card px-3.5 py-2.5 text-sm leading-relaxed">
          {parts.map((p, i) => {
            if (isTextPart(p)) {
              if (!p.text.trim()) return null;
              const isLive = streaming && i === lastTextIdx;
              if (i < lastToolIdx && !isLive) {
                const oneLine = p.text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
                return (
                  <p key={i} className="truncate text-xs text-muted-foreground" title={oneLine} data-testid="assistant-interim-text">
                    {oneLine}
                  </p>
                );
              }
              return <Prose key={i} text={p.text} streaming={isLive} />;
            }
            if (isReasoningPart(p)) {
              if (!p.text.trim()) return null;
              return <ReasoningRow key={i} text={p.text} streaming={streaming && i === parts.length - 1} />;
            }
            if (isToolPart(p)) {
              const out = proposalOf(p);
              if (out?.proposal && out.needsConfirmation !== false) {
                return (
                  <ProposalCard
                    key={p.toolCallId || i}
                    toolCallId={p.toolCallId}
                    proposal={out.proposal}
                    conflicts={conflictsBefore(parts, i)}
                    decision={decisions.byCard.get(p.toolCallId)}
                    busy={busy || bulk === "running"}
                    onApprove={onApprove}
                    onEdit={onEdit}
                    onReject={onReject}
                    onOpenEvent={onOpenEvent}
                    onPreview={onPreview}
                  />
                );
              }
              const ch = choiceOf(p);
              if (ch) {
                return (
                  <ChoiceCard
                    key={p.toolCallId || i}
                    toolCallId={p.toolCallId}
                    choice={ch}
                    state={choices.get(p.toolCallId)}
                    busy={busy}
                    onChoose={onChoose}
                    onCustom={onCustomChoice}
                    onPreview={onPreview}
                  />
                );
              }
              return <ToolRow key={p.toolCallId || i} part={p} live={streaming} />;
            }
            return null;
          })}
          {pendingProposals.length > 1 && (
            <div className="flex items-center gap-2 pt-0.5">
              <Button size="sm" variant="secondary" className="h-10 lg:h-8" disabled={busy || bulk === "running"} onClick={() => void approveAll()} data-testid="proposal-approve-all">
                {bulk === "running" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
                Zatwierdź wszystkie ({pendingProposals.length})
              </Button>
            </div>
          )}
          {streaming && !parts.some((p) => (isTextPart(p) && p.text.trim()) || isToolPart(p)) && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Piszę…
            </span>
          )}
        </div>
      ) : null}
      {aborted && !streaming && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="assistant-aborted">
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5">
            <PauseCircle className="h-3.5 w-3.5" aria-hidden /> Odpowiedź przerwana
          </span>
          {isLast && onContinue && (
            <Button size="sm" variant="outline" className="h-10 text-xs lg:h-7" disabled={busy} onClick={onContinue}>
              Kontynuuj
            </Button>
          )}
        </div>
      )}
      {err && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">
            {errorText(err)}
            {hint && <span className="block opacity-80">{hint}</span>}
          </span>
          {isLast && onRetry && (
            <Button size="sm" variant="outline" className="h-10 shrink-0 text-xs lg:h-7" disabled={busy} onClick={onRetry}>
              <RotateCcw className="mr-1 h-3 w-3" aria-hidden /> Ponów
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
