import type {
  AssistantBriefEvent,
  AssistantChangesOutput,
  AssistantChoiceOption,
  AssistantChoiceOutput,
  AssistantConflict,
  AssistantProposalOutput,
  AssistantResolvedChange,
  AssistantShowEventsGroupBy,
  AssistantShowEventsOutput,
} from "@/lib/api";

/**
 * Luźne typy partów UIMessage (ai@7). `ai` typuje je generycznie po narzędziach,
 * których front nie zna (są po stronie backendu) — więc pracujemy na kształcie:
 *  - text:         { type: "text", text }
 *  - reasoning:    { type: "reasoning", text }
 *  - tool-<n>:     { type: "tool-find_object", toolCallId, state, input?, output?, errorText? }
 *  - data-error:   { type: "data-error", data: { code?, message } }
 *  - data-system:  { type: "data-system", data: { kind, eventId?, text } } (notatka o decyzji użytkownika)
 *  - data-aborted: { type: "data-aborted", data?: { at?, reason? } } (tura przerwana: Stop / restart backendu)
 */
export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

export interface TextPart {
  type: "text";
  text: string;
  state?: "streaming" | "done";
}
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}
export interface ToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}
export interface DataErrorPart {
  type: "data-error";
  data?: { code?: string; message?: string } | string;
}
export type SystemKind = "saved" | "rejected" | "edited" | "applied";
export interface DataSystemPart {
  type: "data-system";
  data?:
    | { kind?: SystemKind; eventId?: number | null; title?: string | null; text?: string; toolCallId?: string | null; changeIndex?: number | null }
    | string;
}
export interface DataAbortedPart {
  type: "data-aborted";
  data?: { at?: string; reason?: string } | string;
}
/** Znacznik wiadomości dopisanej lokalnie przez POST /choose (bez modelu) — nie renderujemy go. */
export interface DataLocalPart {
  type: "data-local";
  data?: { source?: string; toolCallId?: string; optionIndex?: number } | string;
}
export type AnyPart = TextPart | ReasoningPart | ToolPart | DataErrorPart | DataSystemPart | DataAbortedPart | DataLocalPart | { type: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: AnyPart[];
}

export const isTextPart = (p: AnyPart): p is TextPart => p.type === "text";
export const isReasoningPart = (p: AnyPart): p is ReasoningPart => p.type === "reasoning";
export const isToolPart = (p: AnyPart): p is ToolPart => typeof p.type === "string" && p.type.startsWith("tool-");
export const isErrorPart = (p: AnyPart): p is DataErrorPart => p.type === "data-error";
export const isSystemPart = (p: AnyPart): p is DataSystemPart => p.type === "data-system";
export const isAbortedPart = (p: AnyPart): p is DataAbortedPart => p.type === "data-aborted";
export const isLocalPart = (p: AnyPart): p is DataLocalPart => p.type === "data-local";

export const toolName = (p: ToolPart): string => p.type.slice("tool-".length);

export function textOf(parts: AnyPart[] | undefined): string {
  return (parts || [])
    .filter(isTextPart)
    .map((p) => p.text)
    .join("");
}

/** Czy wiadomość asystenta została przerwana (Stop / zerwane połączenie / restart backendu). */
export const isAborted = (m: ChatMessage): boolean => m.role === "assistant" && (m.parts || []).some(isAbortedPart);

/** Liczba wywołań narzędzi w wiadomości (≈ kroki tury). */
export const toolCallCount = (m: ChatMessage | undefined): number => (m?.parts || []).filter(isToolPart).length;

export function errorOf(parts: AnyPart[] | undefined): { code?: string; message: string } | null {
  const errs = (parts || []).filter(isErrorPart);
  if (!errs.length) return null;
  const d = errs[errs.length - 1].data;
  if (typeof d === "string") return { message: d };
  return { code: d?.code, message: d?.message || "Błąd generacji odpowiedzi." };
}

const ERROR_LABELS: Record<string, string> = {
  no_key: "Brak klucza OpenRouter — ustaw OPENROUTER_API_KEY lub data/openrouter.key.",
  disabled: "Asystent jest wyłączony w ustawieniach administracyjnych.",
  quota: "Wyczerpany dzienny limit tur asystenta — spróbuj jutro.",
  too_long: "Wiadomość jest za długa — skróć ją.",
  too_large: "Wiadomość jest za duża — skróć ją.",
  unknown: "Generacja nie powiodła się — spróbuj ponownie.",
  insufficient: "Brak środków u dostawcy modelu.",
  rate_limit: "Limit zapytań u dostawcy — spróbuj za chwilę.",
  timeout: "Model nie odpowiedział w czasie — spróbuj ponownie.",
  server: "Dostawca modelu nie odpowiedział — spróbuj ponownie.",
  busy: "Asystent jeszcze kończy poprzednią odpowiedź w tym czacie — poczekaj chwilę.",
  steps: "Za dużo kroków narzędzi w jednej turze — doprecyzuj polecenie.",
  length: "Odpowiedź ucięta limitem tokenów — poproś o krótszą wersję.",
};

/** Krótka wskazówka „co teraz” po kodzie błędu (pod komunikatem). */
export const ERROR_HINTS: Record<string, string> = {
  rate_limit: "Zwykle mija po kilkudziesięciu sekundach — kliknij „Ponów”.",
  timeout: "Podziel polecenie na mniejsze kroki albo kliknij „Ponów”.",
  server: "Kliknij „Ponów”; jeśli błąd wraca — zmień model w Administracji.",
  busy: "Poczekaj na koniec odpowiedzi (albo zatrzymaj ją przyciskiem Stop).",
};

export function errorText(e: { code?: string; message: string }): string {
  // Backend zwykle wysyła gotowe PL zdanie; etykieta po kodzie tylko gdy message puste/surowe.
  if (e.message && /[ąęółśżźćń]/i.test(e.message)) return e.message;
  if (e.code && ERROR_LABELS[e.code]) return ERROR_LABELS[e.code];
  const t = e.message.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

/**
 * Błąd transportu useChat (Error z treścią odpowiedzi HTTP) → kod + komunikat.
 * 409 {code:"busy"} przy równoległej turze; JSON `{error, code}` z backendu; inaczej surowy tekst.
 */
export function classifyChatError(err: Error | undefined): { code?: string; message: string } {
  const raw = err?.message ?? "";
  try {
    const j = JSON.parse(raw) as { code?: string; error?: string; message?: string };
    if (j && typeof j === "object") return { code: j.code, message: j.error || j.message || raw };
  } catch {
    /* nie JSON */
  }
  if (/"code"\s*:\s*"busy"|\bbusy\b|\b409\b/i.test(raw)) return { code: "busy", message: ERROR_LABELS.busy };
  if (/too_long|too_large|\b413\b/i.test(raw)) return { code: "too_long", message: ERROR_LABELS.too_long };
  if (/"code"\s*:\s*"quota"/i.test(raw)) return { code: "quota", message: ERROR_LABELS.quota };
  if (/\b429\b|rate.?limit/i.test(raw)) return { code: "rate_limit", message: ERROR_LABELS.rate_limit };
  if (/timeout|timed out/i.test(raw)) return { code: "timeout", message: ERROR_LABELS.timeout };
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return { code: "network", message: "Brak połączenia z serwerem — sprawdź sieć i kliknij „Ponów”." };
  return { message: raw || "Błąd połączenia z asystentem." };
}

/** Wynik propozycji z tool-parta `propose_event` (albo null gdy to nie propozycja). */
export function proposalOf(p: ToolPart): AssistantProposalOutput | null {
  if (toolName(p) !== "propose_event" || p.state !== "output-available") return null;
  const out = p.output as AssistantProposalOutput | undefined;
  if (!out || typeof out !== "object" || !out.proposal) return null;
  return out;
}

/**
 * Wynik `propose_changes` (albo null). Pozycje normalizujemy: `index` z backendu albo pozycja
 * w tablicy, `diff`/`warnings` zawsze tablice — dalej nie trzeba sprawdzać kształtu.
 */
export function changesOf(p: ToolPart): (AssistantChangesOutput & { changes: AssistantResolvedChange[] }) | null {
  if (toolName(p) !== "propose_changes" || p.state !== "output-available") return null;
  const out = p.output as AssistantChangesOutput | undefined;
  if (!out || typeof out !== "object" || !Array.isArray(out.changes) || out.changes.length === 0) return null;
  const changes = out.changes.map((c, i) => ({
    ...c,
    index: typeof c?.index === "number" ? c.index : i,
    kind: (c?.kind ?? "update") as AssistantResolvedChange["kind"],
    diff: Array.isArray(c?.diff) ? c.diff.filter((d) => d && typeof d.field === "string") : [],
    warnings: Array.isArray(c?.warnings) ? c.warnings.filter((w): w is string => typeof w === "string" && w.trim() !== "") : [],
    error: typeof c?.error === "string" && c.error.trim() ? c.error : null,
  }));
  return { ...out, changes };
}

/** Wynik pytania z tool-parta `ask_choice` (albo null). */
export function choiceOf(p: ToolPart): AssistantChoiceOutput | null {
  if (toolName(p) !== "ask_choice" || p.state !== "output-available") return null;
  const out = p.output as AssistantChoiceOutput | undefined;
  if (!out || typeof out !== "object" || !Array.isArray(out.options) || out.options.length === 0) return null;
  return out;
}

/** Narzędzia, których wynik zawiera tablicę `events` w kształcie `AssistantBriefEvent`. */
const EVENT_LIST_TOOLS = new Set(["show_events", "list_events", "search_events"]);

/**
 * Lista wydarzeń z wyniku `show_events` / `list_events` / `search_events` (albo pusta tablica —
 * inne narzędzie, błąd, brak wyniku). Odrzucamy elementy bez numerycznego `id`.
 */
export function eventsOf(p: ToolPart): AssistantBriefEvent[] {
  if (!EVENT_LIST_TOOLS.has(toolName(p)) || p.state !== "output-available") return [];
  const out = p.output;
  if (!out || typeof out !== "object") return [];
  const o = out as { events?: unknown; error?: unknown };
  if (typeof o.error === "string" || !Array.isArray(o.events)) return [];
  return o.events.filter((e): e is AssistantBriefEvent => Boolean(e) && typeof e === "object" && typeof (e as { id?: unknown }).id === "number");
}

const GROUP_BY = new Set<AssistantShowEventsGroupBy>(["day", "technician", "object", "type"]);

/** Wynik `show_events` znormalizowany do karty (albo null — inne narzędzie / błąd / brak wyniku). */
export function showEventsOf(p: ToolPart): AssistantShowEventsOutput | null {
  if (toolName(p) !== "show_events" || p.state !== "output-available") return null;
  const out = p.output;
  if (!out || typeof out !== "object") return null;
  const o = out as Partial<AssistantShowEventsOutput> & { error?: unknown };
  if (typeof o.error === "string") return null;
  const events = eventsOf(p);
  return {
    events,
    title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : null,
    note: typeof o.note === "string" && o.note.trim() ? o.note.trim() : null,
    count: typeof o.count === "number" ? o.count : events.length,
    suggestActions: Boolean(o.suggestActions),
    missing: Array.isArray(o.missing) ? o.missing.filter((x): x is number => typeof x === "number") : undefined,
    groupBy: GROUP_BY.has(o.groupBy as AssistantShowEventsGroupBy) ? (o.groupBy as AssistantShowEventsGroupBy) : null,
    range: o.range && typeof o.range === "object" && typeof o.range.from === "string" && typeof o.range.to === "string" ? { from: o.range.from, to: o.range.to } : null,
  };
}

/** Tekst wysyłany po kliknięciu opcji ask_choice (value ma pierwszeństwo nad label). */
export const optionValue = (o: AssistantChoiceOption): string => (o.value?.trim() ? o.value.trim() : o.label);

/** Opcja z gotową akcją (klik → POST /choose, karta bez pytania modelu). */
export const hasAction = (o: AssistantChoiceOption): boolean => Boolean(o.action && typeof o.action === "object" && "kind" in o.action);

const pad2 = (n: number) => String(n).padStart(2, "0");
/** „2025-08-31T08:00” / ISO → lokalne pola bez błędów strefy dla samych dat. */
const parseLoose = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Krótki zakres do hintu opcji: „10.08–14.08” (całodniowe, koniec exclusive), „31.08 08:00–10:00”
 * (ten sam dzień), „31.08 08:00–01.09 10:00” (różne dni).
 */
export function fmtShortRange(startAt: string, endAt: string, allDay?: boolean): string {
  const s = parseLoose(startAt);
  const e = parseLoose(endAt);
  if (!s || !e) return "";
  const dm = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (allDay) {
    const last = new Date(e);
    last.setDate(last.getDate() - 1);
    if (last < s) last.setTime(s.getTime());
    return dm(s) === dm(last) ? dm(s) : `${dm(s)}–${dm(last)}`;
  }
  return dm(s) === dm(e) ? `${dm(s)} ${hm(s)}–${hm(e)}` : `${dm(s)} ${hm(s)}–${dm(e)} ${hm(e)}`;
}

/** Skrót wyniku akcji („→ 10.08–14.08”) z `actionPreview`; pusty string, gdy nie da się nic pokazać. */
export function actionPreviewHint(o: AssistantChoiceOption): string {
  const p = o.actionPreview;
  if (!p || typeof p !== "object") return "";
  let range: { startAt?: string; endAt?: string; allDay?: boolean } | null = null;
  if ("after" in p || "before" in p || "diff" in p) {
    const r = p as AssistantResolvedChange;
    range = r.after ?? null;
  } else {
    range = p as { startAt?: string; endAt?: string; allDay?: boolean };
  }
  if (!range?.startAt || !range?.endAt) return "";
  const s = fmtShortRange(range.startAt, range.endAt, Boolean(range.allDay));
  return s ? `→ ${s}` : "";
}

/**
 * Hint wyświetlany pod etykietą: własny `hint`; bez niego skrót akcji; oba, gdy łącznie mieści się w 160 znakach.
 */
export function optionHint(o: AssistantChoiceOption): string {
  const hint = o.hint?.trim() ?? "";
  const short = hasAction(o) ? actionPreviewHint(o) : "";
  if (!hint) return short;
  if (!short) return hint;
  const both = `${hint} · ${short}`;
  return both.length <= 160 ? both : hint;
}

/**
 * Etykieta opcji bez identyfikatorów z bazy („Magazyn (#12)”, „Wojtek [id 3]”, „Obiekt, id: 7”)
 * — id trafia do osobnego badge'a. Skracamy tylko końcówkę etykiety.
 */
export function stripIdFromLabel(label: string): string {
  return label.replace(/\s*[([]?\s*(?:#|id[:\s]*)\s*\d+\s*[)\]]?\s*$/i, "").trim() || label;
}

/** Stan karty wyboru: odpowiedź użytkownika (tekst kolejnej wiadomości usera) albo aktywność. */
export interface ChoiceState {
  /** Tekst wiadomości użytkownika wysłanej po tej karcie (null = jeszcze bez odpowiedzi). */
  answer: string | null;
  /** Ostatnia nieodpowiedziana karta w czacie — tylko ona przyjmuje kliknięcia. */
  active: boolean;
}

/**
 * Mapuje toolCallId karty `ask_choice` → stan. Karta jest „odpowiedziana”, gdy po jej
 * wiadomości istnieje kolejna wiadomość użytkownika; aktywna jest wyłącznie OSTATNIA
 * nieodpowiedziana karta (wcześniejsze — wyłączone).
 */
export function decideChoices(messages: ChatMessage[]): Map<string, ChoiceState> {
  const map = new Map<string, ChoiceState>();
  let pending: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const t = textOf(m.parts).trim();
      for (const id of pending) map.set(id, { answer: t, active: false });
      pending = [];
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const p of m.parts || []) {
      if (isToolPart(p) && choiceOf(p)) {
        map.set(p.toolCallId, { answer: null, active: false });
        pending.push(p.toolCallId);
      }
    }
  }
  const last = pending[pending.length - 1];
  if (last) map.set(last, { answer: null, active: true });
  return map;
}

/** Konflikty z ostatniego `check_conflicts` w tej samej wiadomości (przed danym partem). */
export function conflictsBefore(parts: AnyPart[], idx: number): AssistantConflict[] {
  for (let i = idx - 1; i >= 0; i--) {
    const p = parts[i];
    if (isToolPart(p) && toolName(p) === "check_conflicts" && p.state === "output-available") {
      const out = p.output as { conflicts?: AssistantConflict[] } | undefined;
      return Array.isArray(out?.conflicts) ? out.conflicts : [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Notatki systemowe (decyzje użytkownika) i dopasowanie do kart propozycji
// ---------------------------------------------------------------------------

/** Znormalizowana notatka systemowa — z parta `data-system` albo (starszy backend) z tekstu. */
export interface SystemNote {
  kind: SystemKind;
  eventId: number | null;
  title: string | null;
  text: string;
  toolCallId?: string | null;
  changeIndex?: number | null;
}

export const SAVED_RE = /^Wydarzenie(?:\s+#(\d+))?\s+zapisane(?:\s+po edycji)?(?::\s*(.*))?$/s;
export const REJECTED_RE = /^Użytkownik odrzucił propozycję(?::\s*(.*))?$/s;

/** Tytuł z tekstu „…zapisane: Tytuł (zakres)” — bez nawiasu z zakresem na końcu. */
const titleFromText = (rest: string | undefined): string | null => {
  if (!rest) return null;
  const t = rest.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return t || null;
};

export function systemNoteOf(m: ChatMessage): SystemNote | null {
  if (m.role !== "system") return null;
  const parts = m.parts || [];
  const text = textOf(parts).trim();
  const ds = parts.find(isSystemPart);
  if (ds && ds.data && typeof ds.data === "object" && ds.data.kind) {
    const d = ds.data;
    const t = d.text?.trim() || text;
    const parsed = SAVED_RE.exec(t);
    return {
      kind: d.kind as SystemKind,
      eventId: d.eventId ?? (parsed?.[1] ? Number(parsed[1]) : null),
      title: d.title?.trim() || titleFromText(parsed?.[2] ?? REJECTED_RE.exec(t)?.[1]),
      text: t,
      toolCallId: d.toolCallId ?? null,
      changeIndex: typeof d.changeIndex === "number" ? d.changeIndex : null,
    };
  }
  if (!text) return null;
  const saved = SAVED_RE.exec(text);
  if (saved) {
    return {
      kind: /po edycji/.test(text) ? "edited" : "saved",
      eventId: saved[1] ? Number(saved[1]) : null,
      title: titleFromText(saved[2]),
      text,
    };
  }
  const rej = REJECTED_RE.exec(text);
  if (rej) return { kind: "rejected", eventId: null, title: titleFromText(rej[1]), text };
  return { kind: "saved", eventId: null, title: null, text } as SystemNote & { kind: "saved" };
}

/** Stan decyzji użytkownika dla karty propozycji (ustalany po wiadomościach systemowych). */
export type ProposalDecision = { status: "saved"; eventId: number | null; edited?: boolean } | { status: "rejected" };

export interface ProposalDecisions {
  /** toolCallId propozycji → decyzja. */
  byCard: Map<string, ProposalDecision>;
  /** Id wiadomości systemowych „skonsumowanych” przez kartę (chip ukryty — decyzja widać na karcie). */
  consumedSystemIds: Set<string>;
}

const normTitle = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Mapuje toolCallId propozycji → decyzja. Wiele kart w jednej wiadomości: notatkę
 * dopasowujemy po toolCallId, potem po tytule (data-system.title albo tytuł z tekstu); gdy brak dopasowania —
 * do OSTATNIEJ nierozstrzygniętej karty (zachowanie starego formatu).
 */
export function decideProposals(messages: ChatMessage[]): ProposalDecisions {
  const byCard = new Map<string, ProposalDecision>();
  const consumedSystemIds = new Set<string>();
  const pending: { id: string; title: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const note = systemNoteOf(m);
      if (!note || pending.length === 0) continue;
      // Notatki kart zmian (changeIndex / applied) rozstrzyga decideChanges — nie „zjadamy” ich tutaj.
      if (note.changeIndex != null || note.kind === "applied") continue;
      const nt = normTitle(note.title);
      let idx = note.toolCallId ? pending.findIndex((c) => c.id === note.toolCallId) : -1;
      if (idx < 0 && nt) {
        for (let i = pending.length - 1; i >= 0; i--) {
          const pt = pending[i].title;
          if (pt === nt || (pt && nt.startsWith(pt)) || (pt && pt.startsWith(nt))) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) idx = pending.length - 1;
      const [target] = pending.splice(idx, 1);
      if (note.kind === "rejected") byCard.set(target.id, { status: "rejected" });
      else byCard.set(target.id, { status: "saved", eventId: note.eventId, edited: note.kind === "edited" });
      consumedSystemIds.add(m.id);
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const p of m.parts || []) {
      if (!isToolPart(p)) continue;
      const out = proposalOf(p);
      if (out?.proposal) pending.push({ id: p.toolCallId, title: normTitle(out.proposal.title) });
    }
  }
  return { byCard, consumedSystemIds };
}

// ---------------------------------------------------------------------------
// Karty zmian (`propose_changes`) — decyzje per pozycja (toolCallId + changeIndex)
// ---------------------------------------------------------------------------

/** Decyzja użytkownika dla JEDNEJ pozycji karty zmian. */
export type ChangeDecision = { status: "applied"; eventId: number | null; edited?: boolean } | { status: "rejected" };

export interface ChangeDecisions {
  /** `${toolCallId}:${changeIndex}` → decyzja. */
  byItem: Map<string, ChangeDecision>;
  /** Id wiadomości systemowych „skonsumowanych” przez kartę (chip ukryty). */
  consumedSystemIds: Set<string>;
}

export const changeKey = (toolCallId: string, index: number) => `${toolCallId}:${index}`;

/**
 * Mapuje pozycje kart `propose_changes` → decyzja. Dopasowanie WYŁĄCZNIE po toolCallId +
 * changeIndex (notatki `applied` / `rejected` / `edited` z changeIndex). Gdy notatka `applied`
 * nie ma toolCallId (starszy backend) — trafia do ostatniej karty, która ma pozycję o tym indeksie
 * bez decyzji.
 */
export function decideChanges(messages: ChatMessage[]): ChangeDecisions {
  const byItem = new Map<string, ChangeDecision>();
  const consumedSystemIds = new Set<string>();
  const cards: { id: string; indexes: number[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const note = systemNoteOf(m);
      if (!note || note.changeIndex == null || cards.length === 0) continue;
      let cardId = note.toolCallId && cards.some((c) => c.id === note.toolCallId) ? note.toolCallId : null;
      if (!cardId) {
        for (let i = cards.length - 1; i >= 0; i--) {
          const c = cards[i];
          if (c.indexes.includes(note.changeIndex) && !byItem.has(changeKey(c.id, note.changeIndex))) {
            cardId = c.id;
            break;
          }
        }
      }
      if (!cardId) continue;
      const key = changeKey(cardId, note.changeIndex);
      if (note.kind === "rejected") byItem.set(key, { status: "rejected" });
      else byItem.set(key, { status: "applied", eventId: note.eventId, edited: note.kind === "edited" });
      consumedSystemIds.add(m.id);
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const p of m.parts || []) {
      if (!isToolPart(p)) continue;
      const out = changesOf(p);
      if (out) cards.push({ id: p.toolCallId, indexes: out.changes.map((c) => c.index) });
    }
  }
  return { byItem, consumedSystemIds };
}

/** Zakres do podświetlenia na siatce kalendarza (karta propozycji / opcja ze slotem). */
export interface PreviewRange {
  startAt: string;
  endAt: string;
  allDay?: boolean;
  technicianIds?: number[];
  conflictIds?: number[];
  /** Tytuł „widmowego” wydarzenia (domyślnie „Propozycja”). */
  title?: string;
  type?: string;
  /** Karta zmian: poprzedni termin (rysowany szaro, „skąd”); `startAt/endAt` to termin docelowy. */
  before?: { startAt: string; endAt: string; allDay?: boolean; eventId?: number | null };
  /** Karta zmian: id modyfikowanego wydarzenia (siatka wycisza jego oryginał). */
  eventId?: number | null;
}

/** Chip z luką do uzupełnienia („[technik]”, „…”) → wstaw do composera zamiast wysyłać. */
export const isTemplateSuggestion = (s: string) => /\[[^\]]*\]|…|\.\.\.$/.test(s);

/** Etykieta czatu w historii (tytuł nadany przez backend albo numer). */
export const chatLabel = (c: { id: number; title: string | null }) => c.title?.trim() || `Czat #${c.id}`;
