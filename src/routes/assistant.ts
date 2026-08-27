/**
 * Asystent kalendarza (AI) — czat adminów z botem planującym wydarzenia.
 * Wzorzec: roleplay/src/routes/roleplay/turn.ts (Hono + Vercel AI SDK ai@7).
 *
 * Kontrakt:
 *  - baza jest źródłem prawdy: klient wysyła TYLKO ostatnią wiadomość ({ message }),
 *    historia jest odtwarzana z assistant_messages (UIMessage.parts przeżywają reload);
 *  - z wiadomości klienta zapisujemy WYŁĄCZNIE tekst (≤ 4000 znaków) — żadnych tool-partów z frontu;
 *  - bot NIGDY nie zapisuje wydarzeń — propose_event zwraca kartę, zapis robi front
 *    przez istniejący POST /calendar/events, po czym woła POST /chats/:id/system {kind,eventId};
 *  - POST /chats/:id/message streamuje UI Message Stream (SSE) z SDK — nie {success,data};
 *  - jedna tura na czat naraz (reserveTurn → 409 busy), twardy timeout 180 s, POST /chats/:id/stop;
 *  - tura żyje po stronie serwera (src/lib/ai/turnRunner.ts): rozłączenie klienta (F5, zamknięta karta)
 *    NIE przerywa generacji — chunki są buforowane w RAM, GET /chats/:id/stream odtwarza bufor i dołącza
 *    live (useChat resume; 204 gdy nic nie leci). Abort tylko przez POST /stop, DELETE czatu albo timeout;
 *  - przerwana tura zostaje w bazie jako wiadomość asystenta z partem `data-aborted`
 *    (a jej usage z sumy kroków jako finishReason "aborted");
 *  - montowane w src/routes/index.ts po requireAuth; dostęp wg assistant.access (requireAssistantAccess),
 *    GET /status dla każdego zalogowanego. Konfiguracja: src/lib/ai/assistantConfig.ts (DB → env → domyślne).
 *
 * Party data-* w wiadomościach (kontrakt z frontem — frontend/src/components/assistant/parts.ts):
 *  - data-error   { code, message }                                (asystent; koniec tury z błędem)
 *  - data-aborted { at, reason: "user"|"restart" }                  (asystent; tura przerwana)
 *  - data-system  { kind: "saved"|"rejected"|"edited"|"applied", eventId: number|null, title: string|null, text,
 *                   toolCallId?: string|null, changeIndex?: number|null }
 *                                                                   (rola system; decyzja usera o karcie —
 *                                                                    changeIndex = pozycja w paczce propose_changes)
 *  - data-local   { source: "choice", toolCallId, optionIndex, label }
 *                 | { source: "quick", eventId, kind, fromToolCallId?, label }
 *                                                                   (asystent; wiadomość wygenerowana LOKALNIE
 *                   przez POST /chats/:id/choose lub /quick-change — bez modelu; jej tool-part ma toolCallId
 *                   `local_*` i do modelu idzie ZAWSZE jako streszczenie tekstowe, nigdy jako tool-call)
 *
 * Zmiany istniejących wydarzeń (propose_changes): zatwierdzenie idzie przez POST /apply-changes
 * (serwer wykonuje przez src/lib/calendar-mutations.ts w transakcji per zmiana, activity_log
 * z dopiskiem „(przez asystenta)”, notatka data-system kind:"applied"). Wymaga edit do technical/kalendarz
 * i włączonego assistant.allow_modifications.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type ModelMessage,
  type StepResult,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { db, schema } from "../db/index.js";
import { CALENDAR_EVENT_STATUSES, CALENDAR_EVENT_TYPES, type User } from "../db/schema.js";
import { buildProviderOptions, makeChatClient, OPENROUTER, resolveApiKey } from "../lib/ai/provider.js";
import { getAssistantConfig, type AssistantConfig } from "../lib/ai/assistantConfig.js";
import { classifyError, describeError, type TurnErrorInfo } from "../lib/ai/errors.js";
import { assembleSystemPrompt, localToday, PROPOSAL_INTENT_RE } from "../lib/ai/calendarPrompt.js";
import { randomBytes } from "node:crypto";
import { buildCalendarActions, buildCalendarTools, zChoiceAction, type ChoiceAction, type ChoiceOption } from "../lib/ai/calendarTools.js";
import { estimateTokens, trimHistoryToBudget } from "../lib/ai/context.js";
import { findTechnicianForUser, listActiveTechnicians, loadEvent, type CalendarEventJson } from "../lib/calendar-queries.js";
import { ApiError } from "../lib/calendar-labels.js";
import { applyChange, CHANGES_MAX, zChange, type Change } from "../lib/ai/calendarChanges.js";
import { localNow } from "../lib/ai/freeSlots.js";
import { canEdit } from "../lib/auth/permissions.js";
import { getUser as getCtxUser, hasAssistantAccess } from "../middleware/auth.js";
import { releaseTurn, reserveTurn, runTurn, stopTurn, subscribeTurn, TURN_TIMEOUT_MS } from "../lib/ai/turnRunner.js";

const app = new Hono();

const NO_KEY_MESSAGE =
  "Brak klucza OpenRouter — ustaw go w Administracja → Asystent AI, przez OPENROUTER_API_KEY lub data/openrouter.key";
const DISABLED_MESSAGE = "Asystent jest wyłączony w administracji.";
const BUSY_MESSAGE = "Asystent jeszcze odpowiada w tym czacie — poczekaj na koniec albo zatrzymaj odpowiedź.";

/** Limity wejścia: body JSON (SSE-owe UIMessage z frontu ma kilkaset bajtów) i tekst jednej wiadomości. */
const BODY_LIMIT_BYTES = 64 * 1024;
const MESSAGE_MAX_CHARS = 4000;

app.use(
  "*",
  bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json({ success: false, code: "too_large", error: `Za duże żądanie (limit ${BODY_LIMIT_BYTES / 1024} KB)` }, 413),
  })
);

// Rezerwacja tury per czat: src/lib/ai/turnRunner.ts (reserveTurn/releaseTurn/runTurn/subscribeTurn/stopTurn).

// ---------------------------------------------------------------------------
// Helpery: wiadomości UI ↔ wiersze bazy
// ---------------------------------------------------------------------------

type MessageRow = typeof schema.assistantMessages.$inferSelect;

/** Part w bazie / w strumieniu — wąski typ strukturalny (UIMessage.parts jest unią zależną od generyków). */
type StoredPart = {
  type: string;
  text?: string;
  state?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  data?: unknown;
};

function partsOf(m: { parts?: unknown } | undefined): StoredPart[] {
  const raw = m?.parts;
  return Array.isArray(raw) ? (raw.filter((p) => p && typeof p === "object" && typeof (p as StoredPart).type === "string") as StoredPart[]) : [];
}

/** Tekst wiadomości UI (party text) — content fallback w bazie. */
function uiText(m: { parts?: unknown } | undefined): string {
  return partsOf(m)
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

export type SystemNoteKind = "saved" | "rejected" | "edited" | "applied";
export type SystemNoteData = {
  kind: SystemNoteKind;
  eventId: number | null;
  title: string | null;
  text: string;
  toolCallId?: string | null;
  /** Pozycja w paczce propose_changes (decyzje per karta zmiany). */
  changeIndex?: number | null;
};

/** Zapis notatki systemowej (role=system, part data-system) + odświeżenie czatu. */
function insertSystemNote(chatId: number, data: SystemNoteData): MessageRow {
  const row = db
    .insert(schema.assistantMessages)
    .values({ chatId, role: "system", content: data.text, parts: [{ type: "data-system", data }] })
    .returning()
    .get();
  touchChat(chatId);
  return row;
}

/** Tekst notatki systemowej: part data-system → party text → content (stare wiersze). */
function systemText(m: Pick<MessageRow, "parts" | "content">): string {
  const sys = partsOf(m).find((p) => p.type === "data-system");
  const fromData = sys && typeof (sys.data as SystemNoteData | undefined)?.text === "string" ? (sys.data as SystemNoteData).text : "";
  return (fromData || uiText(m) || m.content || "").trim();
}

/** Wiersz bazy → wiadomość UI (fallback: content jako jedyny part tekstowy). */
function uiMessageOf(m: Pick<MessageRow, "id" | "role" | "parts" | "content">): UIMessage {
  const parts = partsOf(m);
  return {
    id: String(m.id),
    role: m.role,
    parts: (parts.length ? parts : [{ type: "text", text: m.content || "" }]) as UIMessage["parts"],
  };
}

/** Skrót wyniku narzędzia do historii ("[narzędzie list_events: 12 wyników]") — zamiast pełnego JSON-a. */
function summarizeToolPart(p: StoredPart): string {
  const name = p.toolName || p.type.replace(/^tool-/, "");
  const out = p.output as Record<string, unknown> | undefined;
  if (p.state === "output-error" || (out && typeof out.error === "string")) return `[narzędzie ${name}: błąd]`;
  if (out && typeof out === "object") {
    if (name === "propose_changes") {
      const n = Array.isArray(out.changes) ? out.changes.length : 0;
      return `[narzędzie propose_changes: paczka ${n} zmian pokazana użytkownikowi do zatwierdzenia]`;
    }
    if (name === "show_events") {
      // Karta z listą pokazana użytkownikowi — model nie ma powtarzać listy w tekście.
      const evs = (Array.isArray(out.events) ? out.events : []) as { id?: number; title?: string | null }[];
      const items = evs.slice(0, 12).map((e) => `#${e.id} „${e.title ?? ""}”`).join(", ");
      return `[karta z listą ${evs.length} wydarzeń: ${items}${evs.length > 12 ? ", …" : ""}]`;
    }
    const list = Object.values(out).find((v) => Array.isArray(v)) as unknown[] | undefined;
    if (list) return `[narzędzie ${name}: ${list.length} wyników]`;
    if (name === "propose_event") return "[narzędzie propose_event: karta propozycji pokazana użytkownikowi]";
    if (name === "ask_choice") return "[narzędzie ask_choice: pytanie z przyciskami pokazane użytkownikowi]";
  }
  return `[narzędzie ${name}: ok]`;
}

/** Szybkie akcje z karty show_events (POST /chats/:id/quick-change). */
export type QuickChangeKind = "done" | "cancel" | "confirm" | "restore" | "delete" | "assign_me";
const QUICK_LABELS: Record<QuickChangeKind, string> = {
  done: "Wykonane",
  cancel: "Anulowanie",
  confirm: "Potwierdzenie",
  restore: "Przywrócenie",
  delete: "Usunięcie",
  assign_me: "Przypisz mnie",
};
const QUICK_VERBS: Record<QuickChangeKind, string> = {
  done: "oznaczył jako wykonane",
  cancel: "anulował",
  confirm: "potwierdził",
  restore: "przywrócił",
  delete: "usunął",
  assign_me: "przypisał siebie do",
};

/**
 * Part data-local: wiadomość asystenta wygenerowana LOKALNIE (bez modelu):
 *  - source "choice" — klik opcji ask_choice z action (POST /chats/:id/choose);
 *  - source "quick"  — szybka akcja z karty show_events (POST /chats/:id/quick-change).
 */
export type LocalNoteData =
  | { source: "choice"; toolCallId: string; optionIndex: number; label: string }
  | { source: "quick"; eventId: number; kind: QuickChangeKind; fromToolCallId?: string; label: string };

/** Streszczenie karty z wiadomości lokalnej — model widzi wybór użytkownika, nie tool-call `local_*`. */
function summarizeLocalToolPart(p: StoredPart, local: LocalNoteData): string {
  const name = p.toolName || p.type.replace(/^tool-/, "");
  const out = p.output as Record<string, unknown> | undefined;
  const label = local?.label ?? "";
  if (local?.source === "quick") {
    return `[Użytkownik szybką akcją ${QUICK_VERBS[local.kind] ?? local.kind} #${local.eventId} — karta zmiany czeka na zatwierdzenie]`;
  }
  if (name === "propose_changes") {
    const first = (Array.isArray(out?.changes) ? out!.changes[0] : undefined) as { eventId?: number } | undefined;
    return `[wybór użytkownika: ${label} → propozycja zmiany${first?.eventId != null ? ` #${first.eventId}` : ""} pokazana do zatwierdzenia]`;
  }
  const title = (out?.proposal as { title?: string } | undefined)?.title ?? "";
  return `[wybór użytkownika: ${label} → propozycja wydarzenia „${title}” pokazana do zatwierdzenia]`;
}

/**
 * Wiadomość UI → wiadomości modelu.
 *  - system (notatki po zatwierdzeniu/odrzuceniu karty) → user z prefiksem [SYSTEM]
 *    (OpenRouter/DeepSeek nie lubią roli system w środku rozmowy);
 *  - asystent: party niepełne (tool bez outputu, data-*, reasoning) wypadają. Pełne tool-party
 *    (input+output) idą TYLKO z ostatniej wiadomości asystenta (`keepTools`); starsze zastępuje
 *    jednozdaniowe streszczenie tekstowe — wyniki list_events/find_object potrafią mieć tysiące
 *    tokenów i jechałyby w każdej turze do końca czatu (wzór: roleplay stripToolTurnParts).
 */
export async function toModelMessages(m: UIMessage, row: Pick<MessageRow, "parts" | "content"> | null, keepTools: boolean): Promise<ModelMessage[]> {
  if (m.role === "system") {
    const text = row ? systemText(row) : uiText(m);
    return text ? [{ role: "user", content: `[SYSTEM] ${text}` }] : [];
  }
  const all = partsOf(m);
  // Wiadomość lokalna (/choose): tool-call `local_*` nie istnieje po stronie modelu — ZAWSZE streszczenie, nawet jako ostatnia.
  const local = all.find((p) => p.type === "data-local");
  if (m.role === "assistant" && (!keepTools || local)) {
    const lines: string[] = [];
    for (const p of all) {
      if (p.type === "text" && p.text?.trim()) lines.push(p.text.trim());
      else if (p.type.startsWith("tool-") && (p.state === "output-available" || p.state === "output-error")) {
        lines.push(local ? summarizeLocalToolPart(p, local.data as LocalNoteData) : summarizeToolPart(p));
      }
    }
    const text = lines.join("\n");
    return text ? [{ role: "assistant", content: text }] : [];
  }
  const parts = all.filter((p) => {
    if (p.type === "text") return Boolean(p.text?.trim());
    if (p.type.startsWith("tool-")) return p.state === "output-available" || p.state === "output-error";
    return false; // reasoning, data-*, step-start — bez wartości dla kolejnych tur
  });
  if (parts.length === 0) return [];
  return convertToModelMessages([{ role: m.role, parts } as UIMessage], { ignoreIncompleteToolCalls: true });
}

function getOwnedChat(id: number, user: User) {
  if (!Number.isInteger(id)) return undefined;
  return db
    .select()
    .from(schema.assistantChats)
    .where(and(eq(schema.assistantChats.id, id), eq(schema.assistantChats.userId, user.id)))
    .get();
}

function loadMessages(chatId: number): MessageRow[] {
  return db
    .select()
    .from(schema.assistantMessages)
    .where(eq(schema.assistantMessages.chatId, chatId))
    .orderBy(asc(schema.assistantMessages.createdAt), asc(schema.assistantMessages.id))
    .all();
}

function touchChat(chatId: number, title?: string) {
  db.update(schema.assistantChats)
    .set({ updatedAt: sql`(datetime('now'))`, ...(title ? { title } : {}) })
    .where(eq(schema.assistantChats.id, chatId))
    .run();
}

/** Part `data-aborted` + wiersz asystenta „bez odpowiedzi” — wspólne dla Stop i naprawy po restarcie. */
function abortedParts(reason: "user" | "restart"): StoredPart[] {
  return [{ type: "data-aborted", data: { at: new Date().toISOString(), reason } }];
}
const ABORTED_TEXT: Record<"user" | "restart", string> = {
  user: "Odpowiedź przerwana",
  restart: "Odpowiedź przerwana (restart)",
};

/**
 * Czaty osierocone restartem backendu (ostatnia wiadomość = user, brak odpowiedzi) dostają
 * wiadomość asystenta z data-aborted — inaczej czat wygląda na „bez odpowiedzi” i front nie
 * pokaże „Kontynuuj”. Wołane raz przy starcie (src/index.ts).
 */
export function repairOrphanedTurns(): number {
  const m = schema.assistantMessages;
  const orphans = db
    .select({ chatId: m.chatId })
    .from(m)
    .where(
      sql`${m.id} IN (SELECT max(id) FROM assistant_messages GROUP BY chat_id) AND ${m.role} = 'user'`
    )
    .all();
  if (orphans.length === 0) return 0;
  db.transaction((tx) => {
    for (const { chatId } of orphans) {
      tx.insert(m).values({ chatId, role: "assistant", content: ABORTED_TEXT.restart, parts: abortedParts("restart") }).run();
    }
  });
  console.log(`[assistant] domknięto ${orphans.length} tur osieroconych restartem`);
  return orphans.length;
}

// ---------------------------------------------------------------------------
// Status / czaty
// ---------------------------------------------------------------------------

/**
 * Status dla drawera — dostępny dla KAŻDEGO zalogowanego (front chowa przycisk po `allowed`).
 * allowed nie zależy od enabled: admin || (access=calendar_editors && edycja kalendarza).
 */
app.get("/status", (c) => {
  const user = getCtxUser(c);
  const { key, source } = resolveApiKey();
  const cfg = getAssistantConfig();
  const enabled = cfg.values.enabled;
  const configured = enabled && Boolean(key);
  const reason = !enabled ? "Asystent wyłączony w administracji" : !key ? NO_KEY_MESSAGE : undefined;
  return c.json({
    success: true,
    data: {
      configured,
      enabled,
      allowed: hasAssistantAccess(user),
      /** Technik odpowiadający użytkownikowi (front: „Przypisz mnie” na kartach wydarzeń); null = brak dopasowania. */
      technicianId: findTechnicianForUser(user)?.id ?? null,
      model: cfg.values.model,
      keySource: source,
      ...(reason ? { reason } : {}),
      persona: { name: cfg.values.personaName, greeting: cfg.values.greeting, suggestions: cfg.values.suggestions },
      access: cfg.values.access,
      envKey: OPENROUTER.envKey,
      /** Limit kroków narzędzi w turze (front: „Krok n/max”). */
      maxSteps: cfg.values.maxSteps,
      /** Limit znaków jednej wiadomości (front: licznik w composerze). */
      messageMaxChars: MESSAGE_MAX_CHARS,
      /** Twardy timeout tury w ms (front: hint po dłuższym czekaniu). */
      turnTimeoutMs: TURN_TIMEOUT_MS,
    },
  });
});

/**
 * Liczba tur użytkownika dzisiaj (dzień lokalny procesu = Europe/Warsaw) — do dziennego limitu.
 * Liczona z WIADOMOŚCI usera, nie z assistant_usage: tura przerwana Stopem zanim model
 * odpowiedział też się liczy (inaczej limit dałoby się obejść abortem).
 */
function turnsToday(userId: number): number {
  const m = schema.assistantMessages;
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(m)
    .innerJoin(schema.assistantChats, eq(schema.assistantChats.id, m.chatId))
    .where(
      and(
        eq(schema.assistantChats.userId, userId),
        eq(m.role, "user"),
        sql`date(${m.createdAt}, 'localtime') = date('now', 'localtime')`
      )
    )
    .get();
  return row?.n ?? 0;
}

app.get("/chats", (c) => {
  const user = getCtxUser(c);
  const rows = db
    .select({
      id: schema.assistantChats.id,
      title: schema.assistantChats.title,
      updatedAt: schema.assistantChats.updatedAt,
    })
    .from(schema.assistantChats)
    .where(eq(schema.assistantChats.userId, user.id))
    .orderBy(desc(schema.assistantChats.updatedAt), desc(schema.assistantChats.id))
    .limit(100)
    .all();
  return c.json({ success: true, data: rows });
});

app.post("/chats", async (c) => {
  const user = getCtxUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "Nowy czat";
  const row = db.insert(schema.assistantChats).values({ userId: user.id, title }).returning().get();
  return c.json({ success: true, data: { id: row.id, title: row.title, updatedAt: row.updatedAt } }, 201);
});

app.delete("/chats/:id", (c) => {
  const chat = getOwnedChat(Number(c.req.param("id")), getCtxUser(c));
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  stopTurn(chat.id, "chat deleted");
  db.delete(schema.assistantChats).where(eq(schema.assistantChats.id, chat.id)).run();
  return c.json({ success: true, data: { id: chat.id } });
});

app.get("/chats/:id/messages", (c) => {
  const chat = getOwnedChat(Number(c.req.param("id")), getCtxUser(c));
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  return c.json({ success: true, data: loadMessages(chat.id).map(uiMessageOf) });
});

/**
 * Zatrzymanie bieżącej tury (Stop w UI). Od wprowadzenia runnera rozłączenie klienta nie przerywa
 * generacji — Stop MUSI wołać ten endpoint. Idempotentne: brak tury → stopped:false.
 */
app.post("/chats/:id/stop", (c) => {
  const chat = getOwnedChat(Number(c.req.param("id")), getCtxUser(c));
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  return c.json({ success: true, data: { stopped: stopTurn(chat.id) } });
});

/**
 * Resume streamu tury (useChat resume / prepareReconnectToStreamRequest): replay bufora trwającej
 * generacji od zera + live ogon — po F5 w trakcie tury albo z drugiej karty. Nic nie leci → 204.
 */
app.get("/chats/:id/stream", (c) => {
  const chat = getOwnedChat(Number(c.req.param("id")), getCtxUser(c));
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const stream = subscribeTurn(chat.id);
  if (!stream) return c.body(null, 204);
  return createUIMessageStreamResponse({ stream });
});

/**
 * Notatka systemowa po decyzji użytkownika o karcie propozycji. Front NIE przysyła tekstu —
 * serwer buduje go sam (model nie ma dostać dowolnego „[SYSTEM] …” z klienta).
 * Body: { kind: "saved"|"rejected"|"edited", eventId?: number, title?: string, toolCallId?: string, changeIndex?: number }.
 *  - saved/edited (karta propose_event): eventId wymagany, wydarzenie musi istnieć (nieusunięte) i być
 *    utworzone przez usera; tytuł bierzemy z bazy (body.title tylko dla rejected — tytuł odrzuconej karty).
 *  - changeIndex (karta propose_changes): rejected = odrzucenie pozycji; edited = pozycja zapisana ręcznie
 *    w dialogu (istniejące wydarzenie — bez warunku createdBy). kind "applied" zapisuje WYŁĄCZNIE
 *    serwer w /apply-changes (klient nie może udawać zapisu).
 * Odpowiedź: wiadomość UI z partem { type:"data-system", data:{ kind, eventId, title, text, toolCallId, changeIndex } }.
 */
app.post("/chats/:id/system", async (c) => {
  const user = getCtxUser(c);
  const chat = getOwnedChat(Number(c.req.param("id")), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; eventId?: unknown; title?: unknown; toolCallId?: unknown; changeIndex?: unknown };
  const kind = body.kind as SystemNoteKind;
  if (kind !== "saved" && kind !== "rejected" && kind !== "edited") {
    return c.json({ success: false, error: "Pole kind: oczekiwano saved | rejected | edited" }, 400);
  }
  const bodyTitle = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  // Id wywołania propose_event/propose_changes — front dopasowuje decyzję do karty po nim (tytuły kart mogą się powtarzać).
  const toolCallId = typeof body.toolCallId === "string" && body.toolCallId.trim() ? body.toolCallId.trim().slice(0, 64) : null;
  const changeIndex = Number.isInteger(body.changeIndex) && (body.changeIndex as number) >= 0 && (body.changeIndex as number) < CHANGES_MAX ? (body.changeIndex as number) : null;
  const isChange = changeIndex != null;
  let eventId: number | null = null;
  let title: string | null = bodyTitle || null;
  if (kind === "saved" || kind === "edited") {
    const id = Number(body.eventId);
    if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, error: "Pole eventId jest wymagane" }, 400);
    const ev = db
      .select({ id: schema.calendarEvents.id, title: schema.calendarEvents.title, createdBy: schema.calendarEvents.createdBy })
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.id, id), isNull(schema.calendarEvents.deletedAt)))
      .get();
    if (!ev) return c.json({ success: false, error: `Wydarzenie #${id} nie istnieje` }, 400);
    if (!isChange && ev.createdBy !== user.id) return c.json({ success: false, error: `Wydarzenie #${id} nie zostało utworzone przez Ciebie` }, 400);
    eventId = ev.id;
    title = ev.title;
  } else if (body.eventId != null) {
    const id = Number(body.eventId);
    if (Number.isInteger(id) && id > 0) eventId = id;
  }
  const quoted = title ? ` „${title}”` : "";
  const text =
    kind === "saved"
      ? `Wydarzenie #${eventId}${quoted} zapisane w kalendarzu.`
      : kind === "edited"
        ? isChange
          ? `Wydarzenie #${eventId}${quoted} zapisane po ręcznej edycji zmiany nr ${changeIndex + 1} (dane mogą różnić się od karty).`
          : `Wydarzenie #${eventId}${quoted} zapisane w kalendarzu po ręcznej edycji propozycji (dane mogą różnić się od karty).`
        : isChange
          ? `Użytkownik odrzucił zmianę nr ${changeIndex + 1}${quoted ? `:${quoted}` : ""}.`
          : `Użytkownik odrzucił propozycję${quoted}.`;
  const row = insertSystemNote(chat.id, { kind, eventId, title, text, toolCallId, changeIndex });
  return c.json({ success: true, data: uiMessageOf(row) });
});

// ---------------------------------------------------------------------------
// Wybór opcji ask_choice z `action` — karta bez tury modelu (POST /chats/:id/choose)
// ---------------------------------------------------------------------------

/** Prefiks toolCallId kart wystawionych lokalnie (bez modelu) — `local_` + 12 znaków hex (≤ 64, jak w apply-changes). */
const LOCAL_CALL_PREFIX = "local_";
function localCallId(): string {
  return `${LOCAL_CALL_PREFIX}${randomBytes(6).toString("hex")}`;
}

/**
 * Aktywna karta ask_choice o danym toolCallId: part `tool-ask_choice` (output-available) w wiadomości asystenta,
 * po której NIE ma już żadnej wiadomości usera (inaczej karta jest odpowiedziana → null → fallback).
 * Zwraca też `answered`, żeby odróżnić „brak karty” (404) od „karta nieaktywna” (fallback).
 */
function findActiveChoice(chatId: number, toolCallId: string): { options: ChoiceOption[]; answered: boolean } | null {
  const msgs = loadMessages(chatId);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const p = partsOf(m).find((x) => x.type === "tool-ask_choice" && x.toolCallId === toolCallId && x.state === "output-available");
    if (!p) continue;
    const out = p.output as { options?: unknown } | undefined;
    const options = Array.isArray(out?.options) ? (out!.options as ChoiceOption[]) : [];
    const answered = msgs.slice(i + 1).some((x) => x.role === "user");
    return { options, answered };
  }
  return null;
}

/**
 * POST /chats/:id/choose { toolCallId, optionIndex, optionLabel? }
 * Klik opcji ask_choice z `action`: bez modelu, od razu zapis pary wiadomości (user: wybór; asystent: tekst
 * „Wybrano: …” + karta tool-propose_changes / tool-propose_event z toolCallId `local_*` + part data-local).
 * Akcja jest przeliczana ŚWIEŻO tymi samymi funkcjami co narzędzia (buildCalendarActions z aktualną cfg).
 * Każdy przypadek, w którym karty nie da się wystawić (opcja bez action, karta już odpowiedziana, akcja
 * niepoprawna na aktualnym stanie bazy, propose_changes wyłączone) → { fallback: true } — front wysyła zwykłą
 * wiadomość (tura modelu). 404 tylko gdy nie ma takiej karty/opcji w czacie; 409 busy gdy trwa tura.
 * BEZ wiersza assistant_usage — usage liczy tury modelu, a tu modelu nie ma (decyzja z kontraktu).
 * Działa także przy assistant.enabled=false (nie ma modelu; uprawnienia jak /message — router requireAssistantAccess).
 */
app.post("/chats/:id/choose", async (c) => {
  const user = getCtxUser(c);
  const chat = getOwnedChat(Number(c.req.param("id")), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { toolCallId?: unknown; optionIndex?: unknown; optionLabel?: unknown };
  const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId.trim().slice(0, 64) : "";
  if (!toolCallId) return c.json({ success: false, error: "Pole toolCallId jest wymagane" }, 400);
  const optionIndex = Number(body.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return c.json({ success: false, error: "Pole optionIndex jest wymagane" }, 400);

  const turn = reserveTurn(chat.id);
  if (!turn) return c.json({ success: false, code: "busy", error: BUSY_MESSAGE }, 409);
  try {
    const fallback = () => c.json({ success: true, data: { fallback: true as const } });
    const found = findActiveChoice(chat.id, toolCallId);
    if (!found) return c.json({ success: false, error: "Nie znaleziono karty ask_choice o podanym toolCallId w tym czacie" }, 404);
    const option = found.options[optionIndex];
    if (!option) return c.json({ success: false, error: `Opcja ${optionIndex} poza kartą (0–${found.options.length - 1})` }, 404);
    if (found.answered || !option.action) return fallback();
    const parsedAction = zChoiceAction.safeParse(option.action);
    if (!parsedAction.success) return fallback();
    const action: ChoiceAction = parsedAction.data;

    const conf = getAssistantConfig().values;
    const actions = buildCalendarActions(conf);
    let toolPart: StoredPart;
    if (action.kind === "change") {
      if (!conf.allowModifications || conf.disabledTools.includes("propose_changes")) return fallback();
      const output = actions.resolveChangesPreview([action.change]);
      if (output.changes[0]?.error) return fallback();
      toolPart = { type: "tool-propose_changes", toolCallId: localCallId(), state: "output-available", input: { changes: [action.change] }, output };
    } else {
      const output = actions.buildEventProposal(action.event);
      if ("error" in output) return fallback();
      toolPart = { type: "tool-propose_event", toolCallId: localCallId(), state: "output-available", input: action.event, output };
    }

    const label = option.label;
    const optionValue = (option.value ?? option.label).trim().slice(0, MESSAGE_MAX_CHARS);
    const assistantText = `Wybrano: ${label}.`;
    const localData: LocalNoteData = { source: "choice", toolCallId, optionIndex, label };
    const assistantParts: StoredPart[] = [{ type: "text", text: assistantText }, toolPart, { type: "data-local", data: localData }];
    const isFirst = !loadMessages(chat.id).some((m) => m.role === "user");
    const { userRow, assistantRow } = db.transaction((tx) => {
      const userRow = tx
        .insert(schema.assistantMessages)
        .values({ chatId: chat.id, role: "user", content: optionValue, parts: [{ type: "text", text: optionValue }] })
        .returning()
        .get();
      const assistantRow = tx
        .insert(schema.assistantMessages)
        .values({ chatId: chat.id, role: "assistant", content: assistantText, parts: assistantParts })
        .returning()
        .get();
      return { userRow, assistantRow };
    });
    touchChat(chat.id, isFirst && chat.title === "Nowy czat" ? optionValue.slice(0, 60) : undefined);
    console.log(`[assistant] czat ${chat.id} (${user.email}): wybór lokalny „${label}” → ${toolPart.type} ${toolPart.toolCallId}`);
    return c.json({ success: true, data: { userMessage: uiMessageOf(userRow), assistantMessage: uiMessageOf(assistantRow) } });
  } finally {
    releaseTurn(chat.id, turn);
  }
});

// ---------------------------------------------------------------------------
// Szybka akcja z karty show_events — karta zmiany bez tury modelu (POST /chats/:id/quick-change)
// ---------------------------------------------------------------------------

const QUICK_KINDS: readonly QuickChangeKind[] = ["done", "cancel", "confirm", "restore", "delete", "assign_me"];
const QUICK_NOTE_MAX = 1000;
/** Change.reason ma limit 300 (zChange) — dłuższa notatka jest przycinana. */
const REASON_MAX = 300;

/**
 * Szybka akcja → pozycja Change (jak w propose_changes). `assign_me` = update technicianIds
 * (pełna lista + technik użytkownika); zwraca `{ error }`, gdy użytkownik nie jest technikiem,
 * wydarzenie nie istnieje albo już jest przypisany.
 */
function quickChangeOf(kind: QuickChangeKind, eventId: number, note: string | undefined, user: User): Change | { error: string } {
  const reason = note ? note.slice(0, REASON_MAX) : undefined;
  if (kind === "assign_me") {
    const me = findTechnicianForUser(user);
    if (!me) return { error: "Twoje konto nie odpowiada żadnemu technikowi z listy — przypisz technika ręcznie" };
    const ev = loadEvent(db, eventId);
    if (!ev || ev.deletedAt) return { error: `Wydarzenie #${eventId} nie istnieje` };
    const current = ev.technicians.map((t) => t.id);
    if (current.includes(me.id)) return { error: `${me.name} jest już przypisany do „${ev.title}”` };
    return { kind: "update", eventId, patch: { technicianIds: [...current, me.id] }, ...(reason ? { reason } : {}) };
  }
  switch (kind) {
    case "done":
      return { kind: "status", eventId, status: "done", ...(note ? { note } : {}) };
    case "confirm":
      return { kind: "status", eventId, status: "confirmed" };
    case "cancel":
      return { kind: "cancel", eventId, ...(reason ? { reason } : {}) };
    case "restore":
      return { kind: "restore", eventId };
    case "delete":
      return { kind: "delete", eventId, ...(reason ? { reason } : {}) };
  }
}

/**
 * POST /chats/:id/quick-change { eventId, kind: "done"|"cancel"|"confirm"|"restore"|"delete", note?, fromToolCallId? }
 * Klik szybkiej akcji na karcie show_events: bez modelu, zapis pary wiadomości (user: „Szybka akcja: …”;
 * asystent: tekst + karta tool-propose_changes z toolCallId `local_*` + part data-local {source:"quick"}).
 * Zatwierdzenie karty idzie zwykłą drogą (POST /apply-changes). Wymaga allowModifications (403);
 * propose_changes wyłączone → { fallback: true } (front wysyła zwykłą wiadomość); zmiana niewykonalna
 * (np. już wykonane) → 400 code "invalid" z powodem; 409 busy gdy trwa tura.
 */
app.post("/chats/:id/quick-change", async (c) => {
  const user = getCtxUser(c);
  const chat = getOwnedChat(Number(c.req.param("id")), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { eventId?: unknown; kind?: unknown; note?: unknown; fromToolCallId?: unknown };
  const eventId = Number(body.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) return c.json({ success: false, error: "Pole eventId jest wymagane" }, 400);
  const kind = body.kind as QuickChangeKind;
  if (!QUICK_KINDS.includes(kind)) return c.json({ success: false, error: `Pole kind: oczekiwano ${QUICK_KINDS.join(" | ")}` }, 400);
  if (body.note != null && typeof body.note !== "string") return c.json({ success: false, error: "Pole note: oczekiwano tekstu" }, 400);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > QUICK_NOTE_MAX) return c.json({ success: false, error: `Pole note: maks. ${QUICK_NOTE_MAX} znaków` }, 400);
  const fromToolCallId = typeof body.fromToolCallId === "string" && body.fromToolCallId.trim() ? body.fromToolCallId.trim().slice(0, 64) : undefined;

  const conf = getAssistantConfig().values;
  if (!conf.allowModifications) return c.json({ success: false, code: "forbidden", error: "Asystent nie ma włączonych modyfikacji" }, 403);
  if (conf.disabledTools.includes("propose_changes")) return c.json({ success: true, data: { fallback: true as const } });

  const turn = reserveTurn(chat.id);
  if (!turn) return c.json({ success: false, code: "busy", error: BUSY_MESSAGE }, 409);
  try {
    const change = quickChangeOf(kind, eventId, note || undefined, user);
    if ("error" in change) return c.json({ success: false, code: "invalid", error: change.error }, 400);
    const output = buildCalendarActions(conf).resolveChangesPreview([change]);
    const resolved = output.changes[0];
    if (resolved?.error) return c.json({ success: false, code: "invalid", error: resolved.error }, 400);
    const title =
      resolved?.before?.title ??
      db.select({ title: schema.calendarEvents.title }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).get()?.title ??
      `#${eventId}`;

    const label = QUICK_LABELS[kind];
    const userText = `Szybka akcja: ${label} — ${title}`.slice(0, MESSAGE_MAX_CHARS);
    const assistantText = `Szybka akcja: ${label} — „${title}”.`;
    const toolPart: StoredPart = { type: "tool-propose_changes", toolCallId: localCallId(), state: "output-available", input: { changes: [change] }, output };
    const localData: LocalNoteData = { source: "quick", eventId, kind, ...(fromToolCallId ? { fromToolCallId } : {}), label };
    const assistantParts: StoredPart[] = [{ type: "text", text: assistantText }, toolPart, { type: "data-local", data: localData }];
    const isFirst = !loadMessages(chat.id).some((m) => m.role === "user");
    const { userRow, assistantRow } = db.transaction((tx) => {
      const userRow = tx
        .insert(schema.assistantMessages)
        .values({ chatId: chat.id, role: "user", content: userText, parts: [{ type: "text", text: userText }] })
        .returning()
        .get();
      const assistantRow = tx
        .insert(schema.assistantMessages)
        .values({ chatId: chat.id, role: "assistant", content: assistantText, parts: assistantParts })
        .returning()
        .get();
      return { userRow, assistantRow };
    });
    touchChat(chat.id, isFirst && chat.title === "Nowy czat" ? userText.slice(0, 60) : undefined);
    console.log(`[assistant] czat ${chat.id} (${user.email}): szybka akcja ${kind} #${eventId} → ${toolPart.toolCallId}`);
    return c.json({ success: true, data: { userMessage: uiMessageOf(userRow), assistantMessage: uiMessageOf(assistantRow) } });
  } finally {
    releaseTurn(chat.id, turn);
  }
});

// ---------------------------------------------------------------------------
// Zatwierdzanie zmian z propose_changes (apply-changes / apply-change)
// ---------------------------------------------------------------------------

/** Paczka zmian z zapisanej wiadomości asystenta: part tool-propose_changes o danym toolCallId (z wynikiem). */
function findChangesCall(chatId: number, toolCallId: string): { changes: Change[]; count: number } | null {
  for (const m of loadMessages(chatId)) {
    if (m.role !== "assistant") continue;
    const p = partsOf(m).find((x) => x.type === "tool-propose_changes" && x.toolCallId === toolCallId && x.state === "output-available");
    if (!p) continue;
    const parsed = z.object({ changes: z.array(zChange).min(1).max(CHANGES_MAX) }).safeParse(p.input);
    if (!parsed.success) return null;
    return { changes: parsed.data.changes, count: parsed.data.changes.length };
  }
  return null;
}

type ApplyResult = { index: number; ok: true; eventId: number; event: CalendarEventJson; summary: string } | { index: number; ok: false; error: string };

/**
 * Wykonuje wybrane pozycje paczki (każda we WŁASNEJ transakcji — błąd jednej nie cofa innych),
 * po każdej udanej dopisuje notatkę data-system kind:"applied". Zwraca wyniki per index.
 */
function applyChangeBatch(chatId: number, user: User, toolCallId: string, indexes: number[], overrides: Record<number, Change>): ApplyResult[] {
  const call = findChangesCall(chatId, toolCallId);
  if (!call) throw new ApiError(404, "Nie znaleziono paczki zmian o podanym toolCallId w tym czacie");
  const cfg = getAssistantConfig().values;
  const today = localNow().slice(0, 10);
  const results: ApplyResult[] = [];
  for (const index of indexes) {
    if (index < 0 || index >= call.count) {
      results.push({ index, ok: false, error: `Pozycja ${index} poza paczką (0–${call.count - 1})` });
      continue;
    }
    const change = overrides[index] ?? call.changes[index];
    try {
      const { eventId, event, resolved } = applyChange(change, index, { cfg, today }, { user });
      const text = `Zastosowano zmianę nr ${index + 1} — ${resolved.summary} (wydarzenie #${eventId} „${event.title}”).`;
      insertSystemNote(chatId, { kind: "applied", eventId, title: event.title, text, toolCallId, changeIndex: index });
      results.push({ index, ok: true, eventId, event, summary: resolved.summary });
    } catch (e) {
      const error = e instanceof ApiError ? e.message : describeError(e);
      if (!(e instanceof ApiError)) console.error(`[assistant] apply-changes czat ${chatId} idx ${index}:`, e);
      results.push({ index, ok: false, error });
    }
  }
  return results;
}

/** Uprawnienia do zapisu zmian: dostęp do asystenta (router) + edycja kalendarza + przełącznik admina. */
function assertCanApply(c: Parameters<typeof getCtxUser>[0], user: User): Response | null {
  if (!getAssistantConfig().values.allowModifications) return c.json({ success: false, error: "Modyfikowanie wydarzeń przez asystenta jest wyłączone w administracji" }, 403);
  if (!canEdit(user, "technical/kalendarz")) return c.json({ success: false, error: "Brak uprawnień do edycji kalendarza" }, 403);
  return null;
}

/** Parsuje overrides { [index]: Change } — nieprawidłowy Change → 400. */
function parseOverrides(raw: unknown): Record<number, Change> | string {
  const out: Record<number, Change> = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) return "Pole overrides: oczekiwano obiektu { [index]: Change }";
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) return `Pole overrides: nieprawidłowy indeks „${k}”`;
    const parsed = zChange.safeParse(v);
    if (!parsed.success) return `Pole overrides[${k}]: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    out[idx] = parsed.data;
  }
  return out;
}

/**
 * POST /apply-changes { chatId, toolCallId, indexes: number[], overrides?: { [index]: Change } }
 * → { results: [{ index, ok, eventId?, event?, summary?, error? }] }. Zmiana z overrides zastępuje
 * pozycję z paczki (po edycji w dialogu). Każda pozycja to osobna transakcja.
 */
app.post("/apply-changes", async (c) => {
  const user = getCtxUser(c);
  const denied = assertCanApply(c, user);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { chatId?: unknown; toolCallId?: unknown; indexes?: unknown; overrides?: unknown };
  const chat = getOwnedChat(Number(body.chatId), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId.trim().slice(0, 64) : "";
  if (!toolCallId) return c.json({ success: false, error: "Pole toolCallId jest wymagane" }, 400);
  if (!Array.isArray(body.indexes) || body.indexes.length === 0 || body.indexes.length > CHANGES_MAX || !body.indexes.every((i) => Number.isInteger(i) && (i as number) >= 0)) {
    return c.json({ success: false, error: `Pole indexes: tablica 1–${CHANGES_MAX} indeksów` }, 400);
  }
  const indexes = [...new Set(body.indexes as number[])];
  const overrides = parseOverrides(body.overrides);
  if (typeof overrides === "string") return c.json({ success: false, error: overrides }, 400);
  try {
    const results = applyChangeBatch(chat.id, user, toolCallId, indexes, overrides);
    return c.json({ success: true, data: { results } });
  } catch (e) {
    if (e instanceof ApiError) return c.json({ success: false, error: e.message }, e.status);
    throw e;
  }
});

/**
 * POST /apply-change { chatId, toolCallId, changeIndex, change?: Change } — pojedyncza pozycja
 * (wygodne po edycji w dialogu). → { event, eventId, summary } albo 400 z błędem tej zmiany.
 */
app.post("/apply-change", async (c) => {
  const user = getCtxUser(c);
  const denied = assertCanApply(c, user);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { chatId?: unknown; toolCallId?: unknown; changeIndex?: unknown; change?: unknown };
  const chat = getOwnedChat(Number(body.chatId), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);
  const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId.trim().slice(0, 64) : "";
  if (!toolCallId) return c.json({ success: false, error: "Pole toolCallId jest wymagane" }, 400);
  const index = Number(body.changeIndex);
  if (!Number.isInteger(index) || index < 0) return c.json({ success: false, error: "Pole changeIndex jest wymagane" }, 400);
  const overrides = parseOverrides(body.change != null ? { [index]: body.change } : null);
  if (typeof overrides === "string") return c.json({ success: false, error: overrides }, 400);
  try {
    const [r] = applyChangeBatch(chat.id, user, toolCallId, [index], overrides);
    if (!r.ok) return c.json({ success: false, error: r.error }, 400);
    return c.json({ success: true, data: { eventId: r.eventId, event: r.event, summary: r.summary } });
  } catch (e) {
    if (e instanceof ApiError) return c.json({ success: false, error: e.message }, e.status);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Tura asystenta (streaming)
// ---------------------------------------------------------------------------

/** Wynik narzędzia kończący turę: karta propozycji / pytanie z przyciskami (NIE {error}). */
function isTerminalResult(toolName: string, output: unknown): boolean {
  const o = output as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return false;
  if (toolName === "propose_event" || toolName === "propose_changes") return o.needsConfirmation === true;
  if (toolName === "ask_choice") return o.awaitingUserChoice === true;
  return false;
}

/** Tekst kroku kończy się pytaniem do użytkownika (po zdjęciu markdownu/białych znaków). */
export function endsWithQuestion(text: string): boolean {
  return /\?[\s*_`)\]]*$/.test(text.trim());
}

/**
 * Krok terminalny: model odpowiedział bez narzędzi ALBO wśród wyników jest karta propozycji /
 * pytanie z przyciskami ALBO tekst kroku kończy się pytaniem do użytkownika (pytanie KOŃCZY turę —
 * dalsze kroki „nad” pytaniem produkowały bezsensowne wywołania i zjadały limit kroków).
 * Wspólny dla stopWhen i wykrywania „fałszywego” limitu kroków.
 * Uwaga: propose_event z {error} (np. kolizja) NIE jest terminalny — model ma poprawić dane.
 */
function isTerminalStep(step: StepResult<ToolSet> | undefined): boolean {
  if (!step) return false;
  if (step.toolCalls.length === 0) return true;
  if (step.toolResults.some((r) => isTerminalResult(r.toolName, r.output))) return true;
  return endsWithQuestion(step.text);
}

type TurnUsage = { promptTokens: number; completionTokens: number; reasoningTokens: number; steps: number; toolCalls: number };
const ZERO_USAGE: TurnUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, steps: 0, toolCalls: 0 };

function usageOfSteps(steps: readonly StepResult<ToolSet>[]): TurnUsage {
  return steps.reduce<TurnUsage>(
    (a, s) => ({
      promptTokens: a.promptTokens + (s.usage.inputTokens ?? 0),
      completionTokens: a.completionTokens + (s.usage.outputTokens ?? 0),
      reasoningTokens: a.reasoningTokens + (s.usage.outputTokenDetails?.reasoningTokens ?? 0),
      steps: a.steps + 1,
      toolCalls: a.toolCalls + s.toolCalls.length,
    }),
    ZERO_USAGE
  );
}

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    steps: a.steps + b.steps,
    toolCalls: a.toolCalls + b.toolCalls,
  };
}

/** Odcina chunk `error` SDK — błąd idzie do frontu RAZ, jako part data-error (persystowany). */
function withoutErrorChunks(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, ctl) {
        if (chunk.type !== "error") ctl.enqueue(chunk);
      },
    })
  );
}

app.post("/chats/:id/message", async (c) => {
  const user = getCtxUser(c);
  const chat = getOwnedChat(Number(c.req.param("id")), user);
  if (!chat) return c.json({ success: false, error: "Nie znaleziono czatu" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { message?: UIMessage; messages?: UIMessage[] };
  // Baza jest źródłem prawdy: klient przysyła tylko NOWĄ wiadomość; fallback dla pełnej listy — ostatnia.
  const raw: UIMessage | undefined =
    body.message ?? (Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined);
  const incomingText = uiText(raw);
  if (!raw || raw.role !== "user" || !incomingText) {
    return c.json({ success: false, error: "Wymagana nowa wiadomość użytkownika (message)." }, 400);
  }
  if (incomingText.length > MESSAGE_MAX_CHARS) {
    return c.json({ success: false, code: "too_long", error: `Wiadomość ma ${incomingText.length} znaków — limit ${MESSAGE_MAX_CHARS}.` }, 400);
  }
  // Z klienta trafia do bazy WYŁĄCZNIE tekst — żadnych tool-/data-partów (mogłyby podszyć się pod wyniki narzędzi).
  const incoming: UIMessage = { id: raw.id || `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: incomingText }] };

  // Rezerwacja tury PRZED zapisem wiadomości — równoległy POST dostaje 409 bez śladu w bazie.
  const turn = reserveTurn(chat.id);
  if (!turn) return c.json({ success: false, code: "busy", error: BUSY_MESSAGE }, 409);

  try {
    // Dopisz wiadomość użytkownika od razu — nie zginie nawet przy zerwanym streamie.
    const history = loadMessages(chat.id);
    db.insert(schema.assistantMessages)
      .values({ chatId: chat.id, role: "user", content: incomingText, parts: incoming.parts as unknown })
      .run();
    // Tytuł czatu z pierwszej wiadomości użytkownika.
    const isFirst = !history.some((m) => m.role === "user");
    touchChat(chat.id, isFirst && chat.title === "Nowy czat" ? incomingText.slice(0, 60) : undefined);

    const storedUi = history.map(uiMessageOf);
    const originalMessages: UIMessage[] = [...storedUi, incoming];

    /** Zapis odpowiedzi asystenta (parts + content) po zakończeniu streamu — wspólny dla obu ścieżek. */
    const persistAssistant = (responseMessage: UIMessage) => {
      const parts = partsOf(responseMessage);
      if (parts.length === 0) return;
      const aborted = parts.find((p) => p.type === "data-aborted");
      const content =
        uiText(responseMessage) || (aborted ? ABORTED_TEXT[((aborted.data as { reason?: "user" | "restart" })?.reason) ?? "user"] : "");
      try {
        db.insert(schema.assistantMessages).values({ chatId: chat.id, role: "assistant", content, parts }).run();
        touchChat(chat.id);
      } catch (e) {
        // Czat usunięty w trakcie tury (FK) — odpowiedź nie ma już dokąd trafić.
        console.error(`[assistant] czat ${chat.id}: nie zapisano odpowiedzi — ${describeError(e)}`);
      }
    };

    /**
     * Runner konsumuje stream niezależnie od widzów (onEnd → persist wykona się ZAWSZE, także gdy
     * klient się rozłączył) i zwalnia slot po końcu; odpowiedź to subskrypcja bufora — ta sama,
     * którą po F5 dostaje GET /chats/:id/stream (resume).
     */
    const respond = (stream: ReadableStream<UIMessageChunk>) => {
      runTurn(chat.id, turn, stream);
      const live = subscribeTurn(chat.id);
      if (!live) return c.json({ success: false, error: "Tura zakończyła się przed podpięciem streamu." }, 500);
      return createUIMessageStreamResponse({ stream: live });
    };

    const { key: apiKey } = resolveApiKey();
    const cfg: AssistantConfig = getAssistantConfig();
    const { values: conf } = cfg;
    const quotaHit = conf.dailyTurnLimit > 0 && turnsToday(user.id) > conf.dailyTurnLimit;
    if (!conf.enabled || !apiKey || quotaHit) {
      // Wyłączony w administracji / brak klucza / limit dzienny: ten sam kształt strumienia (data-error)
      // — front pokaże czerwony box. Wiadomość użytkownika już zapisana (jak dotąd), model nie jest wołany.
      const errorData = !conf.enabled
        ? { code: "disabled", message: DISABLED_MESSAGE }
        : !apiKey
          ? { code: "no_key", message: NO_KEY_MESSAGE }
          : { code: "quota", message: `Wyczerpano dzienny limit ${conf.dailyTurnLimit} tur asystenta — spróbuj jutro.` };
      const stream = createUIMessageStream({
        originalMessages,
        execute: ({ writer }) => {
          writer.write({ type: "start" });
          writer.write({ type: "data-error", data: errorData });
          writer.write({ type: "finish" });
        },
        onEnd: ({ responseMessage }) => persistAssistant(responseMessage),
      });
      return respond(stream);
    }

    // Kontekst: system prompt (dzisiaj, technicy, słowniki) + historia przycięta do budżetu.
    const system = assembleSystemPrompt({
      ...localToday(),
      user: { displayName: user.displayName || user.email },
      currentUser: (() => {
        const t = findTechnicianForUser(user);
        return t ? { name: t.name, technicianId: t.id } : null;
      })(),
      technicians: listActiveTechnicians(),
      types: CALENDAR_EVENT_TYPES,
      statuses: CALENDAR_EVENT_STATUSES,
      rules: conf,
    });
    // Pełne tool-party tylko z ostatniej wiadomości asystenta; starsze → streszczenia (koszt).
    const lastAssistantIdx = history.map((m) => m.role).lastIndexOf("assistant");
    const chunks: ModelMessage[][] = [];
    for (let i = 0; i < originalMessages.length; i++) {
      chunks.push(await toModelMessages(originalMessages[i], history[i] ?? null, i === lastAssistantIdx));
    }
    const trimmed = trimHistoryToBudget({ history: chunks, fixedTokens: estimateTokens(system), limit: conf.historyTokenBudget });
    if (trimmed.dropped > 0) {
      console.log(`[assistant] czat ${chat.id}: -${trimmed.dropped} najstarszych wiadomości (okno ~${trimmed.totalTokens} tok)`);
    }

    const model = conf.model;
    const MAX_STEPS = conf.maxSteps;
    const client = makeChatClient(apiKey, conf.baseUrl);
    const tools = buildCalendarTools(user, conf);
    const startedAt = turn.startedAt;
    // Tura żyje po stronie serwera (turnRunner) — rozłączenie klienta niczego nie przerywa;
    // abort tylko przez POST /stop, DELETE czatu albo timeout runnera.
    const signal = turn.abort.signal;
    let turnError: TurnErrorInfo | null = null;
    let usage: TurnUsage = ZERO_USAGE;
    let lastFinish: string | null = null;
    console.log(`[assistant] tura czat ${chat.id} (${user.email}): ${model}`);

    /** Jedna generacja (główna albo retry po zapowiedzi propozycji bez narzędzia). */
    const generate = (messages: ModelMessage[], label: string) =>
      streamText({
        model: client.chatModel(model),
        system,
        messages,
        tools,
        // Koniec tury: wyczerpany budżet kroków, krok bez wywołań narzędzi (model odpowiedział)
        // ALBO krok z kartą propose_event / ask_choice — karta jest końcowym produktem tury. Bez tego SDK
        // wymusza KOLEJNY krok „nad wynikiem narzędzia", w którym model zmyśla potwierdzenie zapisu.
        // propose_event z {error} nie kończy tury — model ma poprawić dane (isTerminalStep).
        stopWhen: [stepCountIs(MAX_STEPS), ({ steps }) => isTerminalStep(steps[steps.length - 1])],
        onStepFinish: ({ toolCalls, usage: u }) => {
          console.log(
            `[assistant] czat ${chat.id}${label}: krok +${Date.now() - startedAt} ms · narzędzia: ${toolCalls.map((t) => t.toolName).join(", ") || "—"} · ${u.inputTokens ?? 0}+${u.outputTokens ?? 0} tok`
          );
        },
        temperature: conf.temperature,
        maxOutputTokens: conf.maxOutputTokens,
        providerOptions: buildProviderOptions(cfg),
        abortSignal: signal,
        onError: ({ error }) => {
          turnError = classifyError(error);
          console.error(`[assistant] tura czat ${chat.id}${label}: błąd [${turnError.code}] — ${turnError.message}`);
        },
        onAbort: ({ steps }) => {
          // Kill w trakcie kroku → krok bez usage; sumujemy to, co się dokończyło.
          usage = addUsage(usage, usageOfSteps(steps));
          lastFinish = "aborted";
        },
        onFinish: ({ steps, totalUsage, finishReason }) => {
          usage = addUsage(usage, {
            promptTokens: totalUsage.inputTokens ?? 0,
            completionTokens: totalUsage.outputTokens ?? 0,
            reasoningTokens: totalUsage.outputTokenDetails?.reasoningTokens ?? 0,
            steps: steps.length,
            toolCalls: steps.reduce((a, s) => a + s.toolCalls.length, 0),
          });
          lastFinish = finishReason;
        },
      });

    /** Jeden wiersz assistant_usage na turę (także przerwaną — finishReason "aborted"). */
    const recordUsage = () => {
      const ms = Date.now() - startedAt;
      const finishReason = lastFinish ?? (signal.aborted ? "aborted" : turnError ? "error" : "other");
      // Kill w trakcie pierwszego kroku → zero dokończonych kroków, a prompt POSZEDŁ do providera
      // i kosztuje: szacujemy go z kontekstu (wzór: roleplay onAbort), żeby statystyki nie kłamały zerem.
      if (finishReason === "aborted" && usage.promptTokens === 0) {
        usage = { ...usage, promptTokens: estimateTokens(system) + trimmed.totalTokens };
      }
      console.log(
        `[assistant] tura czat ${chat.id}: ${finishReason} · ${usage.steps} kroków · ${usage.toolCalls} narzędzi · ` +
          `${usage.promptTokens}+${usage.completionTokens} tok · ${ms} ms`
      );
      try {
        db.insert(schema.assistantUsage)
          .values({ chatId: chat.id, userId: user.id, model, ...usage, finishReason, ms })
          .run();
      } catch (e) {
        console.error(`[assistant] czat ${chat.id}: nie zapisano usage — ${describeError(e)}`);
      }
    };

    const stream = createUIMessageStream({
      originalMessages,
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        try {
          let result = generate(trimmed.history, "");
          writer.merge(withoutErrorChunks(result.toUIMessageStream({ sendReasoning: true, sendStart: false, sendFinish: false, onError: (e) => describeError(e) })));
          let [finishReason, steps] = await Promise.all([result.finishReason, result.steps]);

          // Retry: model „składa propozycję” słowami, bez propose_event — jednorazowo dokładamy [SYSTEM]
          // i kontynuujemy o jeden krok (z pełną historią tej tury: response.messages).
          const last = steps[steps.length - 1];
          if (finishReason === "stop" && last && last.toolCalls.length === 0 && !turnError && PROPOSAL_INTENT_RE.test(last.text) && !signal.aborted) {
            console.log(`[assistant] czat ${chat.id}: zapowiedź propozycji bez narzędzia — retry z [SYSTEM]`);
            const { messages: responseMessages } = await result.response;
            result = generate(
              [
                ...trimmed.history,
                ...responseMessages,
                { role: "user", content: "[SYSTEM] Nie opisuj zamiaru — wywołaj teraz propose_event z kompletem danych (albo ask_choice, jeśli czegoś brakuje)." },
              ],
              " (retry)"
            );
            writer.merge(withoutErrorChunks(result.toUIMessageStream({ sendReasoning: true, sendStart: false, sendFinish: false, onError: (e) => describeError(e) })));
            [finishReason, steps] = await Promise.all([result.finishReason, result.steps]);
          }

          const err = turnError as TurnErrorInfo | null;
          if (finishReason === "error" || err) {
            writer.write({ type: "data-error", data: err ?? { code: "unknown", message: "Generacja nie powiodła się (błąd po stronie API)." } });
          } else if (finishReason === "length") {
            writer.write({ type: "data-error", data: { code: "length", message: "Odpowiedź została ucięta limitem tokenów — poproś o krótszą wersję." } });
          } else if (steps.length >= MAX_STEPS && !isTerminalStep(steps[steps.length - 1])) {
            writer.write({
              type: "data-error",
              data: { code: "steps", message: `Przekroczono limit ${MAX_STEPS} kroków narzędzi w jednej turze — doprecyzuj polecenie.` },
            });
          }
        } catch (e) {
          // Przerwanie (Stop / usunięcie czatu / timeout) albo błąd generacji — treść niesie data-error.
          const err = (turnError as TurnErrorInfo | null) ?? (signal.aborted ? null : classifyError(e));
          if (turn.stoppedBy === "timeout") {
            writer.write({ type: "data-error", data: { code: "timeout", message: `Tura przekroczyła limit ${TURN_TIMEOUT_MS / 1000} s i została przerwana — spróbuj ponownie albo uprość polecenie.` } });
          } else if (err) {
            writer.write({ type: "data-error", data: err });
          } else {
            writer.write({ type: "data-aborted", data: abortedParts("user")[0].data });
          }
        } finally {
          recordUsage();
        }
        writer.write({ type: "finish" });
      },
      onEnd: ({ responseMessage }) => persistAssistant(responseMessage),
    });

    return respond(stream);
  } catch (e) {
    // Błąd PRZED startem runnera (np. w assembleSystemPrompt) — slot zwalniamy sami; po runTurn sprząta runner.
    if (!turn.started) releaseTurn(chat.id, turn);
    throw e;
  }
});

export default app;
