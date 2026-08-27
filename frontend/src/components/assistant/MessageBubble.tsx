import { memo, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Brain,
  CalendarClock,
  CalendarSearch,
  Check,
  CalendarCog,
  FileSearch,
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
import type { AssistantChoiceOption, AssistantProposal, AssistantQuickChangeKind } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Prose } from "./Prose";
import { ProposalCard, type ProposalCardProps } from "./ProposalCard";
import { ChoiceCard, type ChoiceCardProps } from "./ChoiceCard";
import { ChangeCard, type ChangeCardProps } from "./ChangeCard";
import { ObjectPeek } from "./ObjectPeek";
import { EventListCard, EventListRows, type EventListActions, type EventListRowsProps } from "./EventListCard";
import { fmtRange } from "@/lib/calendar-labels";
import {
  ERROR_HINTS,
  changesOf,
  choiceOf,
  conflictsBefore,
  errorOf,
  errorText,
  eventsOf,
  showEventsOf,
  isAborted,
  isErrorPart,
  isLocalPart,
  isReasoningPart,
  isTextPart,
  isToolPart,
  proposalOf,
  systemNoteOf,
  toolName,
  type ChangeDecisions,
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

/** Surowy błąd walidacji wejścia narzędzia z SDK (historia sprzed „miękkiej” walidacji) — nie pokazujemy stacka. */
const INVALID_INPUT_RE = /AI_InvalidToolInputError|Type validation failed|Invalid input for tool/i;

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
  search_events: {
    icon: CalendarSearch,
    running: (i) => `Szukam wydarzenia${str(i.query) ? ` „${str(i.query)}”` : ""}…`,
    done: (o) => {
      const n = arrLen(o.events);
      if (n === 0) return "Nie znaleziono wydarzenia";
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
  get_event: {
    icon: FileSearch,
    running: (i) => `Pobieram wydarzenie${typeof i.eventId === "number" ? ` #${i.eventId}` : ""}…`,
    done: (o) => {
      const ev = asRecord(o.event);
      const t = str(ev.title) || str(o.title);
      return t ? `Wydarzenie: ${t}` : "Pobrano wydarzenie";
    },
  },
  propose_changes: {
    icon: CalendarCog,
    running: () => "Przygotowuję zmiany…",
    done: (o) => {
      const n = arrLen(o.changes);
      return n === 0 ? "Brak zmian do zatwierdzenia" : `Zmiany gotowe: ${plural(n, "pozycja", "pozycje", "pozycji")}`;
    },
  },
  show_events: {
    icon: CalendarSearch,
    running: () => "Przygotowuję listę wydarzeń…",
    done: (o) => {
      const n = typeof o.count === "number" ? o.count : arrLen(o.events);
      return n === 0 ? "Brak wydarzeń do pokazania" : `Pokazuję ${plural(n, "wydarzenie", "wydarzenia", "wydarzeń")}`;
    },
  },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

type FoundObject = { id?: number; name?: string; address?: string | null; city?: string | null };
type FreeSlot = { startAt: string; endAt: string; weekday?: string };

/** Sprzężenie z kalendarzem dla rozwijanej listy wydarzeń w wierszu narzędzia (list_events / search_events). */
interface ToolRowLinks {
  onOpenEvent: (id: number) => void;
  onPreview?: EventListRowsProps["onPreview"];
}

/** Rozwijane szczegóły wyniku narzędzia: lista obiektów (z podglądem), lista wolnych slotów albo lista wydarzeń. */
function toolDetails(name: string, output: Record<string, unknown>, part: ToolPart, links: ToolRowLinks): { count: number; render: () => ReactElement } | null {
  if (name === "list_events" || name === "search_events") {
    const events = eventsOf(part);
    if (events.length === 0) return null;
    return {
      count: events.length,
      render: () => (
        <EventListRows
          events={events}
          source={`events:${part.toolCallId}`}
          onOpenEvent={links.onOpenEvent}
          onPreview={links.onPreview}
          className="mt-1 rounded-md border"
        />
      ),
    };
  }
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
function ToolRow({ part, live, links }: { part: ToolPart; live: boolean; links: ToolRowLinks }) {
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

  // Błąd walidacji parametrów (stary strumień: AI_InvalidToolInputError ze stackiem; nowy: {error:"Nieprawidłowe parametry…"})
  // → krótka etykieta, szczegóły w title. Model dostaje błąd jako wynik i poprawia wywołanie w kolejnym kroku.
  const invalidInput =
    (part.state === "output-error" && INVALID_INPUT_RE.test(part.errorText || "")) ||
    (typeof output.error === "string" && /^Nieprawidłowe parametry/.test(output.error));
  let label: string;
  let title: string | undefined;
  if (running) label = meta ? meta.running(input) : `Wywołuję ${name}…`;
  else if (interrupted) label = `${meta ? meta.running(input).replace(/…$/, "") : name} — przerwane`;
  else if (invalidInput) {
    label = "Nieprawidłowe parametry — asystent poprawia";
    title = (part.state === "output-error" ? part.errorText : (output.error as string)) || undefined;
  } else if (part.state === "output-error") label = part.errorText || `Błąd narzędzia ${name}`;
  else if (typeof output.error === "string") label = output.error;
  else label = meta ? meta.done(output, input) : `Zakończono ${name}`;

  const warn = name === "check_conflicts" && !failed && arrLen(output.conflicts) > 0;
  const details = !failed && part.state === "output-available" ? toolDetails(name, output, part, links) : null;
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
      <span className="min-w-0 truncate" title={title}>
        {label}
      </span>
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

const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}/;
const TABLE_ROW_RE = /^\s*\|/;

/**
 * Wykrywa tabelę markdown (wiersz `| …` + wiersz separatora `|---`). Zwraca krótkie zdanie
 * sprzed tabeli (≤ 200 znaków, bez wierszy tabeli) jako `lead` i resztę (tabela + dalszy tekst)
 * jako `rest`; null, gdy tabeli nie ma.
 */
function splitAtTable(text: string): { lead: string; rest: string } | null {
  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (TABLE_ROW_RE.test(lines[i]) && TABLE_SEP_RE.test(lines[i + 1])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const before = lines.slice(0, at).join("\n").trim();
  const lead = before && before.length <= 200 && !before.split("\n").some((l) => TABLE_ROW_RE.test(l)) ? before : "";
  const rest = lead ? lines.slice(at).join("\n") : text;
  return { lead, rest };
}

/** Wydarzenia z wyników list_events/search_events w wiadomości (unikalne id, wg startAt, potem id). */
function listedEvents(parts: ChatMessage["parts"]) {
  const byId = new Map<number, ReturnType<typeof eventsOf>[number]>();
  for (const p of parts) {
    if (!isToolPart(p) || !/^tool-(list_events|search_events)$/.test(String(p.type))) continue;
    for (const e of eventsOf(p)) if (e.id != null && !byId.has(e.id)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => {
    const sa = a.startAt ?? "";
    const sb = b.startAt ?? "";
    return sa < sb ? -1 : sa > sb ? 1 : (a.id ?? 0) - (b.id ?? 0);
  });
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
  /** Decyzje per pozycja kart zmian (`propose_changes`). */
  changeDecisions: ChangeDecisions;
  onApplyChanges: ChangeCardProps["onApply"];
  onEditChange: ChangeCardProps["onEdit"];
  onRejectChange: ChangeCardProps["onReject"];
  onApprove: ProposalCardProps["onApprove"];
  onEdit: ProposalCardProps["onEdit"];
  onReject: ProposalCardProps["onReject"];
  onOpenEvent: ProposalCardProps["onOpenEvent"];
  onPreview?: ProposalCardProps["onPreview"];
  /** Stany kart pytań (ask_choice) per toolCallId. */
  choices: Map<string, ChoiceState>;
  onChoose: ChoiceCardProps["onChoose"];
  /** Opcja z gotową `action` → karta od razu (POST /choose); toolCallId karty `ask_choice`. */
  onChooseAction?: (toolCallId: string, optionIndex: number, option: AssistantChoiceOption) => void | Promise<void>;
  onCustomChoice: ChoiceCardProps["onCustom"];
  /** Karta listy wydarzeń: „Wykonane” / „Anuluj” → POST /quick-change (drawer). */
  onQuickChange?: EventListActions["onQuickChange"];
  /** Karta listy wydarzeń: „Przesuń…” → zwykła wiadomość do modelu. */
  onSendText?: (text: string) => void;
  /** Użytkownik ma edit do technical/kalendarz (szybkie akcje na liście wydarzeń). */
  canEdit?: boolean;
  /** Technik bieżącego użytkownika („Przypisz mnie” na liście wydarzeń); null = brak. */
  technicianId?: number | null;
  /** eventId → szybka akcja wykonana w tej sesji (przycisk oznaczony jako wykonany). */
  quickDone?: ReadonlyMap<number, AssistantQuickChangeKind>;
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
  changeDecisions,
  onApplyChanges,
  onEditChange,
  onRejectChange,
  onApprove,
  onEdit,
  onReject,
  onOpenEvent,
  onPreview,
  choices,
  onChoose,
  onChooseAction,
  onCustomChoice,
  onQuickChange,
  onSendText,
  canEdit = false,
  technicianId = null,
  quickDone,
  busy,
  onContinue,
  onRetry,
  isLast = false,
}: MessageBubbleProps) {
  const parts = m.parts || [];
  const isUser = m.role === "user";
  const [bulk, setBulk] = useState<"idle" | "running">("idle");
  const toolLinks: ToolRowLinks = { onOpenEvent, onPreview };
  const eventActions: EventListActions | undefined =
    onQuickChange && onSendText ? { canEdit, busy, quickDone, technicianId, onQuickChange, onSendText } : undefined;

  // Wiadomości systemowe („Wydarzenie #12 zapisane”) — dyskretny separator;
  // ukryty, gdy decyzję widać już na karcie propozycji.
  if (m.role === "system") {
    if (decisions.consumedSystemIds.has(m.id) || changeDecisions.consumedSystemIds.has(m.id)) return null;
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
  // `data-local` = znacznik wiadomości dopisanej przez POST /choose (bez modelu) — nie liczy się jako treść i nie jest renderowany.
  const hasContent = parts.some((p) => !isErrorPart(p) && (!isTextPart(p) || p.text.trim()) && p.type !== "data-aborted" && p.type !== "data-system" && p.type !== "data-local");
  if (!hasContent && !err && !streaming && !aborted) return null;

  // Ostatni tekstowy part dostaje domykanie markdownu / kursor.
  let lastTextIdx = -1;
  // Tekst, po którym w tej samej wiadomości idzie jeszcze narzędzie, to narracja
  // kroku pośredniego („Sprawdzam kolizje…”) — wyciszony, jedna linia.
  let lastToolIdx = -1;
  const isLocalMessage = parts.some(isLocalPart);
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
              // Wiadomość lokalna (POST /choose, /quick-change) ma tekst PRZED kartą celowo — nie zwijamy.
              if (i < lastToolIdx && !isLive && !isLocalMessage) {
                // Tekst PRZED narzędziem w tej samej wiadomości = odpowiedź „z pamięci” / narracja
                // kroku pośredniego. Pytanie do użytkownika („?”) zostaje w całości (wyciszone);
                // krótka wstawka („Sprawdzam.”) jako jedna linia; wszystko inne zwijamy pod
                // „pokaż tekst” — deterministycznie, bez liczenia na prompt. Nic nie ucinamy.
                const oneLine = p.text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
                if (oneLine.includes("?")) {
                  return (
                    <div key={i} className="text-muted-foreground" data-testid="assistant-interim-text">
                      <Prose text={p.text} streaming={false} />
                    </div>
                  );
                }
                if (oneLine.length <= 30) {
                  return (
                    <p key={i} className="text-xs text-muted-foreground" data-testid="assistant-interim-text">
                      {oneLine}
                    </p>
                  );
                }
                return (
                  <details key={i} className="text-xs text-muted-foreground" data-testid="assistant-interim-text">
                    <summary className="cursor-pointer select-none">
                      {oneLine.slice(0, 80)}… <span className="underline">pokaż tekst</span>
                    </summary>
                    <div className="mt-1">
                      <Prose text={p.text} streaming={false} />
                    </div>
                  </details>
                );
              }
              // Tabela markdown z wydarzeniami w tekście końcowym → wiersze z wyników
              // list_events/search_events (karta jest zestawieniem), tekst zwinięty.
              if (!isLive) {
                const split = splitAtTable(p.text);
                if (split) {
                  const hasCard = parts.some((x) => isToolPart(x) && showEventsOf(x) != null);
                  const events = hasCard ? [] : listedEvents(parts);
                  return (
                    <div key={i} className="flex flex-col gap-1.5">
                      {split.lead && <Prose text={split.lead} streaming={false} />}
                      {events.length > 0 && (
                        <div className="rounded-lg border bg-background shadow-sm" data-testid="assistant-table-fallback">
                          <EventListRows
                            events={events}
                            source={`events:table:${m.id}`}
                            onOpenEvent={onOpenEvent}
                            onPreview={onPreview}
                            actions={eventActions ? { ...eventActions, suggest: false } : undefined}
                          />
                        </div>
                      )}
                      <details className="text-xs text-muted-foreground" data-testid="assistant-table-text">
                        <summary className="cursor-pointer select-none underline">pokaż tekst</summary>
                        <div className="mt-1">
                          <Prose text={split.rest} streaming={false} />
                        </div>
                      </details>
                    </div>
                  );
                }
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
              const chg = changesOf(p);
              if (chg && chg.needsConfirmation !== false) {
                return (
                  <ChangeCard
                    key={p.toolCallId || i}
                    toolCallId={p.toolCallId}
                    changes={chg.changes}
                    note={chg.note}
                    decisions={changeDecisions.byItem}
                    busy={busy || bulk === "running"}
                    onApply={onApplyChanges}
                    onEdit={onEditChange}
                    onReject={onRejectChange}
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
                    onChooseAction={onChooseAction ? (idx, o) => onChooseAction(p.toolCallId, idx, o) : undefined}
                    onCustom={onCustomChoice}
                    onPreview={onPreview}
                  />
                );
              }
              const shown = showEventsOf(p);
              if (shown) {
                return <EventListCard key={p.toolCallId || i} toolCallId={p.toolCallId} output={shown} onOpenEvent={onOpenEvent} onPreview={onPreview} actions={eventActions} />;
              }
              return <ToolRow key={p.toolCallId || i} part={p} live={streaming} links={toolLinks} />;
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
