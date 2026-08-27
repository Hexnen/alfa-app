import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertTriangle, Clock, Loader2, MessageSquarePlus, SendHorizontal, Sparkles, Square, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { usePerms } from "@/auth/permissions";
import {
  assistantApi,
  calendarApi,
  systemNoteText,
  type AssistantApplyResult,
  type AssistantChangeKind,
  type AssistantChat,
  type AssistantProposal,
  type AssistantResolvedChange,
  type CalendarEventStatus,
  type CalendarEventType,
  type AssistantStatus,
  type AssistantSystemNote,
  type CalendarEvent,
  type CalendarEventInput,
} from "@/lib/api";
import type { CalendarEventPrefill } from "@/components/CalendarEventDialog";
import { cn } from "@/lib/utils";
import { ChatHistory } from "./ChatHistory";
import { MessageList } from "./MessageList";
import { classifyChatError, textOf, type ChatMessage, type PreviewRange } from "./parts";
import type { ChangeCardProps } from "./ChangeCard";
import "./assistant.css";

/** Zakres podświetlany na siatce (karta propozycji / opcja ze slotem); `focus` = „Pokaż w kalendarzu”. */
export type AssistantPreview = (PreviewRange & { focus?: boolean }) | null;

/** Rodzaj zmiany zgłaszany rodzicowi po zapisie ("created" = propozycja nowego wydarzenia). */
export type AssistantEventChangeKind = "created" | AssistantChangeKind;

export interface AssistantDrawerProps {
  onClose: () => void;
  /**
   * Po zapisie/zmianie wydarzenia (Zatwierdź / Edytuj→Zapisz / zastosowana zmiana) — rodzic
   * odświeża kalendarz i pokazuje toast. `ev` może być null (np. usunięcie bez zwróconego eventu).
   */
  onEventsChanged: (ev: CalendarEvent | null, kind: AssistantEventChangeKind, title?: string) => void;
  /** Edytuj → rodzic otwiera CalendarEventDialog (create + prefill) i woła `onSaved` po zapisie. */
  onEditProposal: (prefill: CalendarEventPrefill, onSaved: (ev: CalendarEvent) => void) => void;
  /** Edytuj zmianę istniejącego wydarzenia → dialog w trybie edit (event scalony z patchem). */
  onEditEvent: (event: CalendarEvent, onSaved: (ev: CalendarEvent) => void) => void;
  onOpenEvent: (id: number) => void;
  /** Sprzężenie z siatką: „widmowy” event dla propozycji / slotu; null zdejmuje. */
  onPreviewRange?: (range: AssistantPreview) => void;
}

const STORAGE_KEY = "alfa.assistant.chatId";
const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_CHARS = 4000;
const readStoredChat = (): number | null => {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const storeChat = (id: number | null) => {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* prywatny tryb */
  }
};

const isDesktop = () => window.matchMedia("(min-width: 1024px)").matches;

/** Prawy drawer „Asystent” — na desktopie kolumna obok kalendarza, na mobile pełny ekran. */
export function AssistantDrawer({ onClose, onEventsChanged, onEditProposal, onEditEvent, onOpenEvent, onPreviewRange }: AssistantDrawerProps) {
  const { isAdmin } = usePerms();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [chats, setChats] = useState<AssistantChat[]>([]);
  /** null = „Nowy czat” (jeszcze niezapisany — tworzony przy pierwszej wiadomości). */
  const [chatId, setChatId] = useState<number | null>(null);
  /** Klucz sesji: zmiana = remount ChatSession (przełączenie czatu / nowy czat), NIE po utworzeniu draftu. */
  const [sessionKey, setSessionKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  const selectChat = useCallback(
    (id: number | null) => {
      setChatId(id);
      setSessionKey((k) => k + 1);
      storeChat(id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id == null) next.delete("chat");
          else next.set("chat", String(id));
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [st, list] = await Promise.all([assistantApi.status(), assistantApi.listChats()]);
      setStatus(st);
      setChats(list);
      const fromUrl = Number(searchParams.get("chat"));
      const wanted = [fromUrl, readStoredChat()].find((id) => id && list.some((c) => c.id === id)) ?? list[0]?.id ?? null;
      setChatId(wanted);
      storeChat(wanted);
      setLoaded(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Nie udało się wczytać asystenta.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams tylko przy pierwszym wczytaniu
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const newChat = () => selectChat(null);

  const deleteChat = async (id: number) => {
    await assistantApi.deleteChat(id);
    const rest = chats.filter((c) => c.id !== id);
    setChats(rest);
    if (id === chatId) selectChat(rest[0]?.id ?? null);
  };

  /** Draft → prawdziwy czat (po pierwszej wiadomości): bez remountu sesji. */
  const onChatCreated = useCallback(
    (c: AssistantChat) => {
      setChats((cs) => [c, ...cs.filter((x) => x.id !== c.id)]);
      setChatId(c.id);
      storeChat(c.id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("chat", String(c.id));
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const refreshChats = useCallback(() => {
    void assistantApi.listChats().then(setChats).catch(() => undefined);
  }, []);

  // Wysokość na desktopie: sticky kolumna — liczona z offsetu komórki siatki w dokumencie
  // (niezależnie od przewinięcia), żeby composer nie wypadał poza ekran przy 1440×900.
  // Komórka (rodzic) nie jest sticky, więc jej pozycja + scrollY = stały offset drawera.
  useLayoutEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (!isDesktop()) {
        el.style.height = "";
        return;
      }
      const cellTop = (el.parentElement ?? el).getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(320, window.innerHeight - cellTop - 16)}px`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // Jeden handler Esc: podgląd obiektu / historia (same się zamykają i robią preventDefault)
  // → Stop w trakcie tury → zamknięcie drawera.
  const escRef = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[data-testid="object-peek"], [data-testid="chat-history"], [role="alertdialog"]')) return;
      if (escRef.current?.()) {
        e.preventDefault();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Mobile: drawer zasłania stronę → aria-modal + pułapka fokusu (Tab krąży w drawerze).
  const [modal, setModal] = useState(() => !isDesktop());
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setModal(!mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !asideRef.current) return;
      const focusables = Array.from(
        asideRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !asideRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  // Zdejmij widmo z siatki przy zamknięciu drawera.
  useEffect(() => () => onPreviewRange?.(null), [onPreviewRange]);

  const configured = (status?.configured ?? true) && status?.enabled !== false;

  return (
    <aside
      ref={asideRef}
      className={cn(
        "asst-drawer-in fixed inset-0 z-50 flex h-[100dvh] flex-col bg-background pb-[env(safe-area-inset-bottom)]",
        "lg:sticky lg:inset-auto lg:top-4 lg:z-auto lg:h-[calc(100vh-5rem)] lg:self-start lg:rounded-lg lg:border lg:bg-card lg:pb-0 lg:shadow-sm"
      )}
      role="dialog"
      aria-modal={modal ? "true" : "false"}
      aria-label="Asystent kalendarza"
      data-testid="assistant-drawer"
    >
      {/* Nagłówek */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold">{status?.persona?.name?.trim() || "Asystent"}</h2>
        <div className="ml-auto flex items-center gap-1">
          <ChatHistory chats={chats} chatId={chatId} onSelect={selectChat} onDelete={deleteChat} disabled={!loaded} />
          <Button variant="ghost" size="icon" className="h-10 w-10 lg:h-8 lg:w-8" onClick={newChat} disabled={!loaded || chatId == null} aria-label="Nowy czat" title="Nowy czat">
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-10 w-10 lg:h-8 lg:w-8" onClick={onClose} aria-label="Zamknij asystenta">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {status && !configured && (
        <div role="alert" className="flex items-start gap-1.5 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {status.reason ? (
              status.reason
            ) : (
              <>
                Asystent nie jest skonfigurowany — brak klucza OpenRouter. Ustaw <code>OPENROUTER_API_KEY</code> lub plik <code>data/openrouter.key</code>.
              </>
            )}
            {isAdmin && (
              <>
                {" "}
                <Link to="/admin/asystent" className="font-medium underline underline-offset-2" onClick={onClose}>
                  Skonfiguruj w Administracji
                </Link>
              </>
            )}
          </span>
        </div>
      )}

      {loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm">
          <AlertTriangle className="h-5 w-5 text-red-500" aria-hidden />
          <p className="text-red-700 dark:text-red-300">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Ponów
          </Button>
        </div>
      ) : !loaded ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Wczytywanie…
        </div>
      ) : (
        <ChatSession
          key={sessionKey}
          initialChatId={chatId}
          configured={configured}
          persona={status?.persona ?? null}
          maxSteps={status?.maxSteps && status.maxSteps > 0 ? status.maxSteps : DEFAULT_MAX_STEPS}
          maxChars={status?.messageMaxChars && status.messageMaxChars > 0 ? status.messageMaxChars : DEFAULT_MAX_CHARS}
          escRef={escRef}
          onChatCreated={onChatCreated}
          onEventsChanged={onEventsChanged}
          onEditProposal={onEditProposal}
          onEditEvent={onEditEvent}
          onOpenEvent={onOpenEvent}
          onPreviewRange={onPreviewRange}
          onTitleMaybeChanged={refreshChats}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sesja jednego czatu (useChat) — remount przez key={sessionKey}
// ---------------------------------------------------------------------------

const autoGrow = (el: HTMLTextAreaElement) => {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
};

function ChatSession({
  initialChatId,
  configured,
  persona,
  maxSteps,
  maxChars,
  escRef,
  onChatCreated,
  onEventsChanged,
  onEditProposal,
  onEditEvent,
  onOpenEvent,
  onPreviewRange,
  onTitleMaybeChanged,
}: {
  initialChatId: number | null;
  configured: boolean;
  persona: AssistantStatus["persona"] | null;
  maxSteps: number;
  maxChars: number;
  escRef: React.MutableRefObject<(() => boolean) | null>;
  onChatCreated: (c: AssistantChat) => void;
  onEventsChanged: AssistantDrawerProps["onEventsChanged"];
  onEditProposal: AssistantDrawerProps["onEditProposal"];
  onEditEvent: AssistantDrawerProps["onEditEvent"];
  onOpenEvent: (id: number) => void;
  onPreviewRange?: (range: AssistantPreview) => void;
  onTitleMaybeChanged: () => void;
}) {
  // Id czatu w ref: draft (null) dostaje id dopiero przy pierwszej wysyłce — bez remountu.
  const chatIdRef = useRef<number | null>(initialChatId);
  // Id z momentu montażu: po utworzeniu draftu rodzic zmienia `initialChatId`, ale
  // klucz useChat i wczytanie historii NIE mogą się zmienić (nowy klucz = zerwany stream).
  const [mountChatId] = useState(initialChatId);
  const creatingRef = useRef<Promise<AssistantChat> | null>(null);
  const ensureChat = useCallback(async (): Promise<number> => {
    if (chatIdRef.current != null) return chatIdRef.current;
    // Guard na podwójne wywołanie (StrictMode / szybki dwuklik): jedna obietnica.
    if (!creatingRef.current) creatingRef.current = assistantApi.createChat();
    try {
      const c = await creatingRef.current;
      chatIdRef.current = c.id;
      onChatCreated(c);
      return c.id;
    } finally {
      creatingRef.current = null;
    }
  }, [onChatCreated]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: assistantApi.messageUrl(chatIdRef.current ?? 0),
        credentials: "same-origin",
        // Backend jest źródłem prawdy historii — wysyłamy tylko ostatnią wiadomość;
        // draft czatu tworzymy dopiero tutaj.
        prepareSendMessagesRequest: async ({ messages }) => {
          const id = await ensureChat();
          return { api: assistantApi.messageUrl(id), body: { message: messages[messages.length - 1] } };
        },
      }),
    [ensureChat]
  );

  const { messages, sendMessage, status, stop, setMessages, error, clearError } = useChat({
    id: `assistant-${mountChatId ?? "draft"}`,
    transport,
    onFinish: () => onTitleMaybeChanged(),
  });

  // Historia z DB (z parts, więc karty propozycji przeżywają reload). Draft → pusta.
  const [loading, setLoading] = useState(mountChatId != null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (mountChatId == null) return;
    let alive = true;
    assistantApi
      .messages(mountChatId)
      .then((ms) => {
        if (alive) setMessages(ms as UIMessage[]);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : "Nie udało się wczytać historii.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mountChatId, setMessages]);

  const busy = status === "submitted" || status === "streaming";
  // Na dotyku Enter = nowa linia (wysyłka przyciskiem) — krótszy placeholder.
  const finePointer = useMemo(() => window.matchMedia("(pointer: fine)").matches, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  /** Tekst wpisany w trakcie tury — wysyłany po jej zakończeniu. */
  const [queued, setQueued] = useState<string | null>(null);

  const setComposer = useCallback((text: string) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = text;
    autoGrow(el);
    setChars(text.length);
  }, []);

  /** Licznik znaków — widoczny od 80% limitu; powyżej limitu wysyłka zablokowana. */
  const [chars, setChars] = useState(0);
  const tooLong = chars > maxChars;

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || !configured || loading || t.length > maxChars) return;
      if (busy) {
        // Nie odrzucaj po cichu — kolejkuj do końca tury.
        setQueued(t);
        setComposer("");
        return;
      }
      clearError();
      void sendMessage({ text: t });
      setComposer("");
    },
    [busy, configured, loading, maxChars, sendMessage, clearError, setComposer]
  );

  // Kolejka: po zakończeniu tury wyślij oczekujący tekst.
  useEffect(() => {
    if (busy || queued == null) return;
    const t = queued;
    setQueued(null);
    if (status === "ready") {
      clearError();
      void sendMessage({ text: t });
    } else {
      setComposer(t);
    }
  }, [busy, queued, status, sendMessage, clearError, setComposer]);

  /** Stop = zerwanie streamu (useChat) + przerwanie generowania po stronie serwera. */
  const stopTurn = useCallback(() => {
    void stop();
    if (chatIdRef.current != null) void assistantApi.stop(chatIdRef.current);
  }, [stop]);

  // Esc w trakcie tury = Stop (zgłaszane do wspólnego handlera w drawerze).
  useEffect(() => {
    escRef.current = () => {
      if (!busy) return false;
      stopTurn();
      return true;
    };
    return () => {
      escRef.current = null;
    };
  }, [busy, stopTurn, escRef]);

  // Fokus do composera po otwarciu (desktop; na dotyku nie wywołujemy klawiatury).
  useEffect(() => {
    if (!loading && configured && finePointer) inputRef.current?.focus({ preventScroll: true });
  }, [loading, configured, finePointer]);

  /** Lokalna notatka systemowa (bez zapisu — gdy backend już ją zapisał, np. apply-changes). */
  const pushSystemLocal = useCallback(
    (note: AssistantSystemNote) => {
      const text = note.text ?? systemNoteText(note);
      const msg: UIMessage = {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        parts: [
          {
            type: "data-system",
            data: { kind: note.kind, eventId: note.eventId ?? null, title: note.title ?? null, text, toolCallId: note.toolCallId ?? null, changeIndex: note.changeIndex ?? null },
          },
          { type: "text", text },
        ] as UIMessage["parts"],
      };
      setMessages((ms) => [...ms, msg]);
    },
    [setMessages]
  );

  const appendSystem = useCallback(
    async (note: AssistantSystemNote) => {
      const id = chatIdRef.current;
      if (id == null) return;
      await assistantApi.system(id, note);
      pushSystemLocal(note);
    },
    [pushSystemLocal]
  );

  const toInput = (p: AssistantProposal): CalendarEventInput => ({
    type: p.type,
    title: p.title,
    description: p.description ?? null,
    location: p.location ?? null,
    startAt: p.startAt,
    endAt: p.endAt,
    allDay: Boolean(p.allDay),
    status: p.status ?? "planned",
    objectId: p.objectId ?? null,
    orderId: p.orderId ?? null,
    realizationId: p.realizationId ?? null,
    technicianIds: p.technicianIds ?? [],
    recurrence: p.recurrence ?? null,
  });

  const afterSaved = useCallback(
    async (ev: CalendarEvent, proposalTitle: string, kind: "saved" | "edited", toolCallId: string) => {
      onEventsChanged(ev, "created");
      // toolCallId karty (+ tytuł propozycji jako fallback) — po nim front dopasowuje decyzję do karty.
      await appendSystem({ kind, eventId: ev.id, title: proposalTitle, toolCallId });
    },
    [onEventsChanged, appendSystem]
  );

  const onApprove = useCallback(
    async (id: string, p: AssistantProposal) => {
      setSaving(true);
      try {
        const res = await calendarApi.create(toInput(p));
        if (!res.data) throw new Error("Brak danych wydarzenia w odpowiedzi.");
        await afterSaved(res.data, p.title, "saved", id);
      } finally {
        setSaving(false);
      }
    },
    [afterSaved]
  );

  const onEdit = useCallback(
    (id: string, p: AssistantProposal) => {
      onEditProposal(
        {
          type: p.type,
          title: p.title,
          startAt: p.startAt,
          endAt: p.endAt,
          allDay: Boolean(p.allDay),
          objectId: p.objectId ?? null,
          location: p.location ?? null,
          description: p.description ?? null,
          technicianIds: p.technicianIds ?? [],
          status: p.status,
        },
        (ev) => void afterSaved(ev, p.title, "edited", id)
      );
    },
    [onEditProposal, afterSaved]
  );

  const onReject = useCallback(
    async (id: string, p: AssistantProposal) => {
      await appendSystem({ kind: "rejected", title: p.title, toolCallId: id });
      inputRef.current?.focus();
    },
    [appendSystem]
  );

  // --- Karta zmian (propose_changes) ---------------------------------------------------------
  const changeTitle = (c: AssistantResolvedChange) => c.after?.title || c.before?.title || c.summary || undefined;

  /** Zatwierdź pozycje → backend wykonuje i zapisuje notatki `applied`; my dokładamy je lokalnie + toast. */
  const onApplyChanges = useCallback<ChangeCardProps["onApply"]>(
    async (toolCallId, indexes) => {
      const id = chatIdRef.current;
      if (id == null) throw new Error("Brak czatu.");
      // Pozycje z listy wiadomości — potrzebne do tytułów/kind w toastach.
      const byIndex = new Map<number, AssistantResolvedChange>();
      for (const m of messages as unknown as ChatMessage[]) {
        for (const p of m.parts || []) {
          if (p.type === "tool-propose_changes" && "toolCallId" in p && p.toolCallId === toolCallId && "output" in p) {
            const out = p.output as { changes?: AssistantResolvedChange[] } | undefined;
            (out?.changes ?? []).forEach((c, i) => byIndex.set(typeof c.index === "number" ? c.index : i, c));
          }
        }
      }
      setSaving(true);
      try {
        const results: AssistantApplyResult[] = await assistantApi.applyChanges(id, toolCallId, indexes);
        for (const r of results) {
          if (!r.ok) continue;
          const c = byIndex.get(r.index);
          const title = r.event?.title ?? (c ? changeTitle(c) : undefined);
          pushSystemLocal({ kind: "applied", eventId: r.event?.id ?? (c?.eventId ?? undefined), title, toolCallId, changeIndex: r.index });
          onEventsChanged(r.event ?? null, c?.kind ?? "update", title);
        }
        return results;
      } finally {
        setSaving(false);
      }
    },
    [messages, pushSystemLocal, onEventsChanged]
  );

  const onRejectChange = useCallback<ChangeCardProps["onReject"]>(
    async (toolCallId, c) => {
      await appendSystem({ kind: "rejected", title: changeTitle(c), toolCallId, changeIndex: c.index, eventId: c.eventId ?? undefined });
      inputRef.current?.focus();
    },
    [appendSystem]
  );

  /**
   * Edytuj: create → dialog tworzenia z prefill (jak propozycja); update/status → pełny event z API
   * scalony z `after` (patch) i dialog edycji. Po zapisie w dialogu notatka `edited` z changeIndex.
   */
  const onEditChange = useCallback<ChangeCardProps["onEdit"]>(
    (toolCallId, c) => {
      const afterEdit = (ev: CalendarEvent) => {
        onEventsChanged(ev, c.kind === "create" ? "created" : c.kind, ev.title);
        void appendSystem({ kind: "edited", eventId: ev.id, title: ev.title, toolCallId, changeIndex: c.index });
      };
      const a = c.after ?? {};
      if (c.kind === "create") {
        const raw = c.change && c.change.kind === "create" ? c.change.event : undefined;
        onEditProposal(
          {
            type: (a.type ?? raw?.type) as CalendarEventType | undefined,
            title: a.title ?? raw?.title,
            startAt: a.startAt ?? raw?.startAt,
            endAt: a.endAt ?? raw?.endAt,
            allDay: Boolean(a.allDay ?? raw?.allDay),
            objectId: a.objectId ?? raw?.objectId ?? null,
            location: a.location ?? raw?.location ?? null,
            description: a.description ?? raw?.description ?? null,
            technicianIds: a.technicianIds ?? raw?.technicianIds ?? [],
            status: (a.status ?? raw?.status) as CalendarEventStatus | undefined,
          },
          afterEdit
        );
        return;
      }
      const evId = c.eventId ?? c.before?.id ?? a.id;
      if (evId == null) return;
      void calendarApi
        .getEvent(evId)
        .then((res) => {
          const ev = res.data;
          if (!ev) throw new Error("Nie znaleziono wydarzenia.");
          const techIds = a.technicianIds;
          const merged: CalendarEvent = {
            ...ev,
            type: (a.type as CalendarEventType | undefined) ?? ev.type,
            title: a.title ?? ev.title,
            startAt: a.startAt ?? ev.startAt,
            endAt: a.endAt ?? ev.endAt,
            allDay: a.allDay ?? ev.allDay,
            status: (a.status as CalendarEventStatus | undefined) ?? ev.status,
            objectId: a.objectId !== undefined ? a.objectId : ev.objectId,
            objectName: a.objectName !== undefined ? a.objectName : ev.objectName,
            location: a.location !== undefined ? a.location : ev.location,
            description: a.description !== undefined ? a.description : ev.description,
            technicians: techIds
              ? techIds.map((tid, i) => ev.technicians.find((t) => t.id === tid) ?? { id: tid, firstName: a.technicians?.find((t) => t.id === tid)?.name ?? a.technicianNames?.[i] ?? `#${tid}`, lastName: "" })
              : ev.technicians,
          };
          onEditEvent(merged, afterEdit);
        })
        .catch((e: unknown) => {
          // Brak dostępu do karty — sygnalizujemy przez toast rodzica (kind update, bez eventu).
          onEventsChanged(null, "update", e instanceof Error ? e.message : "Nie udało się wczytać wydarzenia.");
        });
    },
    [onEditProposal, onEditEvent, onEventsChanged, appendSystem]
  );

  // Karta ask_choice: klik opcji = zwykła wiadomość użytkownika; „Inne…” = fokus w composerze.
  const onChoose = useCallback((text: string) => send(text), [send]);
  const onCustomChoice = useCallback(() => inputRef.current?.focus(), []);
  const onInsertSuggestion = useCallback(
    (text: string) => {
      setComposer(text);
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Zaznacz pierwszą lukę „[…]”, żeby od razu ją nadpisać.
      const m = /\[[^\]]*\]/.exec(text);
      if (m) el.setSelectionRange(m.index, m.index + m[0].length);
    },
    [setComposer]
  );

  // Przerwana odpowiedź → „Kontynuuj”; błąd → „Ponów” (ostatnia wiadomość użytkownika).
  const onContinue = useCallback(() => send("Kontynuuj"), [send]);
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return textOf(messages[i].parts as ChatMessage["parts"]).trim();
    return "";
  }, [messages]);
  const onRetry = useCallback(() => {
    if (!lastUserText) return;
    clearError();
    // Przy błędzie transportu (409/sieć) wiadomość zwykle nie została zapisana — usuwamy ją
    // z widoku, żeby nie dublować; backend jest źródłem prawdy po odświeżeniu.
    setMessages((ms) => {
      const copy = [...ms];
      while (copy.length && copy[copy.length - 1].role !== "user") copy.pop();
      if (copy.length && copy[copy.length - 1].role === "user") copy.pop();
      return copy;
    });
    void sendMessage({ text: lastUserText });
  }, [lastUserText, clearError, setMessages, sendMessage]);

  // Widmo na siatce: kilka źródeł (karty, hover opcji) — ostatnie zgłoszenie wygrywa,
  // zdjęcie tylko przez to samo źródło (żeby hover opcji nie skasował karty i odwrotnie).
  const previewSrc = useRef<string | null>(null);
  const previewByCard = useRef<Map<string, PreviewRange>>(new Map());
  const onPreview = useCallback(
    (range: (PreviewRange & { focus?: boolean }) | null, source: string) => {
      if (!onPreviewRange) return;
      const isCard = !source.startsWith("choice:");
      if (range) {
        if (isCard && !range.focus) previewByCard.current.set(source, range);
        previewSrc.current = source;
        onPreviewRange(range);
        return;
      }
      if (isCard) previewByCard.current.delete(source);
      if (previewSrc.current !== source && !isCard) return;
      // Wróć do ostatniej karty bez decyzji (jeśli jest), inaczej zdejmij.
      const cards = [...previewByCard.current.entries()];
      const fallback = cards.length ? cards[cards.length - 1] : null;
      previewSrc.current = fallback?.[0] ?? null;
      onPreviewRange(fallback ? fallback[1] : null);
    },
    [onPreviewRange]
  );

  const chatError = error && status === "error" ? classifyChatError(error) : null;
  const lastMsg = messages[messages.length - 1] as ChatMessage | undefined;
  const lastMsgHasError = Boolean(lastMsg && lastMsg.role === "assistant" && (lastMsg.parts || []).some((p) => p.type === "data-error"));

  return (
    <>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Wczytywanie historii…
        </div>
      ) : loadError ? (
        <div role="alert" className="m-3 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {loadError}
        </div>
      ) : (
        <MessageList
          messages={messages as unknown as ChatMessage[]}
          status={status}
          configured={configured}
          persona={persona}
          maxSteps={maxSteps}
          busy={saving}
          onSuggestion={send}
          onInsertSuggestion={onInsertSuggestion}
          onApprove={onApprove}
          onEdit={onEdit}
          onReject={onReject}
          onApplyChanges={onApplyChanges}
          onEditChange={onEditChange}
          onRejectChange={onRejectChange}
          onOpenEvent={onOpenEvent}
          onPreview={onPreviewRange ? onPreview : undefined}
          onChoose={onChoose}
          onCustomChoice={onCustomChoice}
          onContinue={onContinue}
          onRetry={onRetry}
        />
      )}
      {chatError && !lastMsgHasError && (
        <div role="alert" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300" data-testid="assistant-turn-error">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">
            {chatError.message}
            {chatError.code === "busy" && <span className="block opacity-80">Poczekaj na koniec odpowiedzi, potem wyślij ponownie.</span>}
          </span>
          {chatError.code !== "busy" && lastUserText && (
            <Button size="sm" variant="outline" className="h-10 shrink-0 text-xs lg:h-7" onClick={onRetry}>
              Ponów
            </Button>
          )}
        </div>
      )}
      {queued != null && (
        <div className="mx-3 mb-1.5 flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1 text-xs text-muted-foreground" data-testid="assistant-queued">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Wyślę po zakończeniu: „{queued}”</span>
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:underline"
            onClick={() => {
              setComposer(queued);
              setQueued(null);
              inputRef.current?.focus();
            }}
          >
            Cofnij
          </button>
        </div>
      )}

      {/* Composer */}
      <form
        className="relative flex shrink-0 items-end gap-2 border-t bg-background px-3 py-2 lg:rounded-b-lg"
        onSubmit={(e) => {
          e.preventDefault();
          send(inputRef.current?.value ?? "");
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          enterKeyHint="send"
          disabled={!configured || loading}
          placeholder={
            !configured
              ? "Asystent nieskonfigurowany"
              : busy
                ? "Możesz pisać — wyślę po zakończeniu odpowiedzi"
                : finePointer
                  ? "Napisz, co zaplanować… (Enter wysyła, Shift+Enter nowa linia)"
                  : "Napisz, co zaplanować…"
          }
          aria-label="Wiadomość do asystenta"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:text-sm"
          onInput={(e) => {
            autoGrow(e.currentTarget);
            setChars(e.currentTarget.value.length);
          }}
          aria-invalid={tooLong || undefined}
          aria-describedby={chars >= maxChars * 0.8 ? "asst-chars" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              send(e.currentTarget.value);
            }
          }}
        />
        {chars >= maxChars * 0.8 && (
          <span
            id="asst-chars"
            className={cn("absolute bottom-[3.25rem] right-3 rounded bg-background/90 px-1 text-[11px] tabular-nums", tooLong ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}
            aria-live="polite"
            data-testid="assistant-chars"
          >
            {chars}/{maxChars}
            {tooLong && " — za długo"}
          </span>
        )}
        {busy ? (
          <Button type="button" variant="destructive" size="sm" className="h-10" onClick={stopTurn} aria-label="Zatrzymaj odpowiedź (Esc)" title="Zatrzymaj (Esc)">
            <Square className="mr-1 h-3.5 w-3.5" aria-hidden /> Stop
          </Button>
        ) : (
          <Button type="submit" size="sm" className="h-10 w-10 p-0" disabled={!configured || loading || tooLong} aria-label="Wyślij">
            <SendHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </form>
    </>
  );
}
