import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  CalendarDays,
  Check,
  Download,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Paperclip,
  Pencil,
  Presentation,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { tip } from "@/components/ui/tooltip";
import { useAuth } from "@/auth/AuthProvider";
import { usePerms } from "@/auth/permissions";
import {
  CALENDAR_ATTACHMENT_ACCEPT,
  CALENDAR_ATTACHMENT_MAX_FILES,
  CALENDAR_ATTACHMENT_MAX_SIZE,
  calendarApi,
  type CalendarNote,
  type CalendarNoteAttachment,
} from "@/lib/api";
import { NOTE_MAX, fmtRelative, fmtShort, fmtTimestamp, initials, notesLabel } from "@/lib/calendar-labels";
import { mentionSuggestions, parseMentions, toDateStr } from "@/lib/note-mentions";
import { cn } from "@/lib/utils";

/** Badge „n notatek” — podgląd wydarzenia, karty asystenta. Nic nie renderuje przy 0. */
export function NotesBadge({ count, className }: { count?: number | null; className?: string }) {
  const n = Number(count ?? 0);
  if (!n || n < 1) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:text-amber-200",
        className
      )}
      data-testid="notes-badge"
      title={notesLabel(n)}
    >
      <StickyNote className="h-3 w-3" aria-hidden />
      {notesLabel(n)}
    </span>
  );
}

function NoteAvatar({ note }: { note: CalendarNote }) {
  if (note.source === "assistant") {
    return (
      <span
        aria-hidden
        title="Asystent"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300"
      >
        <Sparkles className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
    >
      {initials(note.userLabel || (note.source === "system" ? "System" : "?"))}
    </span>
  );
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// ---------------------------------------------------------------------------
// Wzmianki dat („@piątek”, „@15.09”) — chipy w treści, autouzupełnianie, podgląd
// ---------------------------------------------------------------------------

/** Klik we wzmiankę / link „w kalendarzu”: `eventId` = kafelek notatki, inaczej sam dzień. */
type OpenMention = (date: string, eventId: number | null) => void;

/** Kotwica wzmianek: dzisiejsza data lokalna (backend liczy w strefie warszawskiej). */
const mentionToday = () => toDateStr(new Date());

const WEEKDAY_SHORT = new Intl.DateTimeFormat("pl-PL", { weekday: "short" });

/** „pt 11.09” — krótka etykieta dnia na chipie / linku. */
function dayChipLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAY_SHORT.format(d).replace(".", "")} ${fmtShort(date, true)}`;
}

interface ResolvedMention {
  raw: string;
  key: string;
  start: number;
  end: number;
  date: string;
  /** Kafelek `notatka` powstały z tej wzmianki (null = jeszcze nie ma). */
  eventId: number | null;
}

/**
 * Wzmianki w treści notatki: pozycje z lokalnego parsera, a data i `eventId` — o ile
 * backend je przysłał — z `note.mentions` (kanoniczne rozstrzygnięcie po stronie serwera).
 */
function resolveMentions(note: CalendarNote, today: string): ResolvedMention[] {
  const fromApi = new Map((note.mentions ?? []).map((m) => [m.key, m]));
  return parseMentions(note.text ?? "", today).map((m) => {
    const api = fromApi.get(m.key);
    return { raw: m.raw, key: m.key, start: m.start, end: m.end, date: api?.date ?? m.date, eventId: api?.eventId ?? null };
  });
}

const MENTION_CHIP =
  "mx-px inline-flex items-baseline gap-1 rounded-full bg-amber-500/15 px-1.5 py-px align-baseline text-[11px] font-medium text-amber-800 dark:text-amber-200";

function MentionChip({ mention, onOpen }: { mention: ResolvedMention; onOpen?: OpenMention }) {
  const label = `${mention.raw} · ${dayChipLabel(mention.date)}`;
  if (!onOpen) {
    return (
      <span className={MENTION_CHIP} data-testid="note-mention" data-mention-key={mention.key}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(mention.date, mention.eventId)}
      className={cn(
        MENTION_CHIP,
        "hover:bg-amber-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
      data-testid="note-mention"
      data-mention-key={mention.key}
      data-event-id={mention.eventId ?? undefined}
      title={mention.eventId ? "Otwórz kafelek notatki w kalendarzu" : "Pokaż ten dzień w kalendarzu"}
    >
      {label}
    </button>
  );
}

/** Treść notatki z klikalnymi chipami wzmianek dat. */
function NoteText({ note, onOpenMention }: { note: CalendarNote; onOpenMention?: OpenMention }) {
  const text = note.text ?? "";
  const mentions = resolveMentions(note, mentionToday());
  if (mentions.length === 0) {
    return (
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="note-text">
        {text}
      </p>
    );
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((m, i) => {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    parts.push(<MentionChip key={`m-${i}-${m.key}`} mention={m} onOpen={onOpenMention} />);
    cursor = m.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="note-text">
      {parts}
    </p>
  );
}

/** Linki „w kalendarzu: 11.09” — kafelki `notatka` tej notatki (ze wzmianek i ręczne). */
function NoteLinkedEvents({ note, onOpenMention }: { note: CalendarNote; onOpenMention?: OpenMention }) {
  const fromMentions = (note.mentions ?? []).filter((m) => m.eventId != null);
  const covered = new Set(fromMentions.map((m) => m.eventId as number));
  const extra = (note.linkedEventIds ?? []).filter((id) => !covered.has(id));
  if (fromMentions.length === 0 && extra.length === 0) return null;
  const item = (key: string, label: string, date: string | null, eventId: number) =>
    onOpenMention ? (
      <button
        key={key}
        type="button"
        onClick={() => onOpenMention(date ?? "", eventId)}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-px text-[10px] font-medium text-amber-800 hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200"
        data-testid="note-linked-event"
        data-event-id={eventId}
        title="Otwórz kafelek notatki w kalendarzu"
      >
        <CalendarDays className="h-3 w-3" aria-hidden />
        {label}
      </button>
    ) : (
      <span
        key={key}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:text-amber-200"
        data-testid="note-linked-event"
        data-event-id={eventId}
      >
        <CalendarDays className="h-3 w-3" aria-hidden />
        {label}
      </span>
    );
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1" data-testid="note-linked-events">
      {fromMentions.map((m) =>
        item(`m-${m.eventId}`, `w kalendarzu: ${fmtShort(m.date, true)}`, m.date, m.eventId as number)
      )}
      {extra.map((id) => item(`e-${id}`, "w kalendarzu", null, id))}
    </span>
  );
}

const MENTION_PREFIX_RE = /(?:^|[^\p{L}\p{N}_@])@([\p{L}]*)$/u;

interface SuggestState {
  items: ReturnType<typeof mentionSuggestions>;
  /** Pozycja „@” w tekście i pozycja kursora, między którymi wstawiamy token. */
  start: number;
  end: number;
  active: number;
}

/**
 * Pole treści notatki z autouzupełnianiem po „@” (dziś/jutro/pojutrze/dni tygodnia)
 * i podglądem „Utworzy kafelki: …”. Poza tym zwykła `Textarea` — skróty rodzica
 * (Ctrl/Cmd+Enter, Escape) działają jak wcześniej.
 */
function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  rows,
  maxLength,
  placeholder,
  ariaLabel,
  className,
  autoFocus,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  autoFocus?: boolean;
  testId?: string;
}) {
  const today = useMemo(() => mentionToday(), []);
  const [sug, setSug] = useState<SuggestState | null>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;

  const refresh = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const m = MENTION_PREFIX_RE.exec(el.value.slice(0, caret));
    if (!m) {
      setSug(null);
      return;
    }
    const items = mentionSuggestions(m[1], today).slice(0, 8);
    if (items.length === 0) {
      setSug(null);
      return;
    }
    setSug({ items, start: caret - m[1].length - 1, end: caret, active: 0 });
  };

  const insert = (token: string) => {
    if (!sug) return;
    const next = `${value.slice(0, sug.start)}@${token} ${value.slice(sug.end)}`;
    const caret = sug.start + token.length + 2;
    setSug(null);
    onChange(next);
    window.requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (sug && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setSug((s) => (s ? { ...s, active: (s.active + dir + s.items.length) % s.items.length } : s));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        insert(sug.items[sug.active].token);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSug(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const preview = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of parseMentions(value, today)) if (!seen.has(m.key)) seen.set(m.key, m.label);
    return [...seen.values()];
  }, [value, today]);

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => refresh(e.currentTarget)}
        onClick={(e) => refresh(e.currentTarget)}
        onBlur={() => window.setTimeout(() => setSug(null), 120)}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={className}
        data-testid={testId}
      />
      {sug && (
        <ul
          role="listbox"
          aria-label="Podpowiedzi dat"
          className="absolute left-1 z-30 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          data-testid="mention-suggestions"
        >
          {sug.items.map((s, i) => (
            <li
              key={s.token}
              role="option"
              aria-selected={i === sug.active}
              onMouseEnter={() => setSug((prev) => (prev ? { ...prev, active: i } : prev))}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(s.token);
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1",
                i === sug.active && "bg-accent text-accent-foreground"
              )}
              data-testid="mention-suggestion"
              data-token={s.token}
            >
              <span className="font-medium">@{s.token}</span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
      {preview.length > 0 && (
        <p className="mt-1 px-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="note-mentions-preview">
          Utworzy kafelki: {preview.join(", ")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Załączniki — pomocnicze
// ---------------------------------------------------------------------------

/** Rozszerzenia dopuszczane przez backend (poza image/*). */
const ALLOWED_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "csv", "txt", "rtf",
]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "tif", "tiff"]);

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

const isImageFile = (f: File) => f.type.startsWith("image/") || IMAGE_EXT.has(extOf(f.name));
const isAllowedFile = (f: File) => isImageFile(f) || ALLOWED_EXT.has(extOf(f.name));

function fmtFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Ikona chipa wg typu pliku. */
function attachmentIcon(mime: string, fileName: string) {
  const ext = extOf(fileName);
  if (mime === "application/pdf" || ext === "pdf" || mime.startsWith("text/") || ["doc", "docx", "odt", "rtf", "txt"].includes(ext)) {
    return FileText;
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime === "text/csv" || ["xls", "xlsx", "ods", "csv"].includes(ext)) {
    return FileSpreadsheet;
  }
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["ppt", "pptx", "odp"].includes(ext)) {
    return Presentation;
  }
  return FileIcon;
}

/** PDF i obrazki przeglądarka otworzy w nowej karcie; reszta = pobranie. */
const opensInline = (a: CalendarNoteAttachment) => a.kind === "image" || a.mime === "application/pdf" || extOf(a.fileName) === "pdf";
const downloadUrl = (a: CalendarNoteAttachment) => `${a.url}${a.url.includes("?") ? "&" : "?"}download=1`;

interface PendingFile {
  key: string;
  file: File;
  /** Object URL miniatury (tylko obrazki) — zwalniany przy usunięciu / wysyłce / odmontowaniu. */
  previewUrl: string | null;
}

let pendingSeq = 0;

/**
 * Waliduje pliki wg limitów backendu. Zwraca przyjęte pliki i listę polskich komunikatów o odrzuconych.
 * Używane przez kompozytor i drop z dialogu (przez `ref.addFiles`).
 */
function partitionAttachmentFiles(
  incoming: File[],
  alreadyCount: number
): { accepted: File[]; messages: string[] } {
  const accepted: File[] = [];
  const messages: string[] = [];
  const tooBig: string[] = [];
  const badType: string[] = [];
  let overflow = 0;
  for (const f of incoming) {
    if (!isAllowedFile(f)) {
      badType.push(f.name);
      continue;
    }
    if (f.size > CALENDAR_ATTACHMENT_MAX_SIZE) {
      tooBig.push(f.name);
      continue;
    }
    if (alreadyCount + accepted.length >= CALENDAR_ATTACHMENT_MAX_FILES) {
      overflow++;
      continue;
    }
    accepted.push(f);
  }
  if (badType.length) {
    messages.push(
      `Niedozwolony typ pliku: ${badType.join(", ")}. Dozwolone: obrazy, PDF, dokumenty Office/OpenDocument, CSV, TXT, RTF.`
    );
  }
  if (tooBig.length) {
    messages.push(`Plik przekracza 5 MB: ${tooBig.join(", ")}.`);
  }
  if (overflow > 0) {
    messages.push(`Maks. ${CALENDAR_ATTACHMENT_MAX_FILES} plików w jednej notatce — pominięto ${overflow}.`);
  }
  return { accepted, messages };
}

/** Uchwyt dla rodzica (drop na cały dialog → pliki lądują w kompozytorze; szkic przy „Zapisz”). */
export interface CalendarEventNotesHandle {
  /** Dodaje pliki do kompozytora (z walidacją) i ustawia fokus w polu opisu. */
  addFiles: (files: File[]) => void;
  /** Czy w kompozytorze czeka niewysłany szkic (niepusty tekst lub choć jeden plik). */
  hasDraft: () => boolean;
  /** Skrót szkicu do komunikatu: czy jest tekst i ile plików. */
  draftSummary: () => { text: boolean; files: number };
  /** Wysyła szkic tą samą ścieżką co „Dodaj notatkę”. Rzuca, gdy wysyłka się nie uda. */
  submitDraft: () => Promise<void>;
  /** Czyści kompozytor (tekst, pliki, zwolnienie miniatur). */
  discardDraft: () => void;
}

export interface CalendarEventNotesProps {
  eventId: number;
  /** Notatki znane z GET /calendar/events/:id (unikamy drugiego zapytania). */
  initialNotes?: CalendarNote[] | null;
  /** Czy użytkownik może dodawać (uprawnienie edit do kalendarza). */
  canEdit: boolean;
  /** Powiadomienie o zmianie liczby notatek (odświeżenie licznika w nagłówku sekcji / kalendarzu). */
  onCountChange?: (count: number, notes: CalendarNote[]) => void;
  /** Autofokus pola dodawania (tryb view, gdy lista pusta). */
  autoFocus?: boolean;
  /**
   * Informacja dla rodzica, czy w kompozytorze czeka szkic (tekst lub pliki) — nagłówek
   * zwiniętej sekcji pokazuje wtedy badge „szkic”. Przy odmontowaniu zgłasza `false`.
   */
  onDraftChange?: (hasDraft: boolean) => void;
  /**
   * Klik we wzmiankę daty w treści (`@piątek`) albo w link „w kalendarzu”. Bez tego
   * propa chipy są nieklikalne (nadal pokazują rozstrzygniętą datę).
   */
  onOpenMention?: OpenMention;
  /**
   * Obiekt wydarzenia — odblokowuje „Zapisz też w obiekcie” (kopia notatki
   * w kartotece). Bez niego (wydarzenie bez obiektu) kontrolki się nie pojawiają;
   * poza `objectId` potrzebne jest jeszcze uprawnienie edit do klucza `objects`.
   */
  objectId?: number | null;
  /** Nazwa obiektu — do treści modalu informacyjnego. */
  objectName?: string | null;
  /** Uchwyt imperatywny (React 19: `ref` jako zwykły prop). */
  ref?: Ref<CalendarEventNotesHandle>;
}

/**
 * Dziennik notatek wydarzenia. Zapis od razu przez osobne API — niezależnie od „Zapisz” dialogu.
 * Własne notatki (lub admin): edycja inline, usunięcie z potwierdzeniem.
 * Załączniki: wybór z dysku / drop (przez `ref.addFiles`), multipart przy wysyłce.
 *
 * Kopia w kartotece obiektu (`objectId` + edit do klucza `objects`): toggle
 * „Zapisz też w obiekcie” w kompozytorze albo „Do obiektu” na gotowej notatce.
 * Obie ścieżki prowadzą przez ten sam modal informacyjny — kopia jest trwała,
 * niezależna od oryginału i widoczna dla wszystkich z dostępem do obiektów.
 */
export function CalendarEventNotes({
  eventId,
  initialNotes,
  canEdit,
  onCountChange,
  autoFocus,
  onDraftChange,
  onOpenMention,
  objectId,
  objectName,
  ref,
}: CalendarEventNotesProps) {
  const { user } = useAuth();
  const { canEdit: canEditTab, canView: canViewTab } = usePerms();
  const isAdmin = user?.role === "admin";
  /** Kopiowanie do kartoteki: wydarzenie ma obiekt i mamy edit do klucza `objects`. */
  const canCopyToObject = objectId != null && canEditTab("objects");
  /** Sam chip „w obiekcie” z linkiem wystarczy podejrzeć — do tego starczy view. */
  const canSeeObject = objectId != null && canViewTab("objects");
  const [notes, setNotes] = useState<CalendarNote[]>(() => initialNotes ?? []);
  const [loading, setLoading] = useState(!initialNotes);
  // Rodzic dociąga notatki po otwarciu (GET /events/:id) — synchronizacja w trakcie renderu, bez efektu.
  const [prevInitial, setPrevInitial] = useState(initialNotes);
  if (initialNotes !== prevInitial) {
    setPrevInitial(initialNotes);
    if (initialNotes) {
      setNotes(initialNotes);
      setLoading(false);
    }
  }
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteAtt, setDeleteAtt] = useState<{ noteId: number; att: CalendarNoteAttachment } | null>(null);
  const [deleteAttBusy, setDeleteAttBusy] = useState(false);
  const [lightbox, setLightbox] = useState<CalendarNoteAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** Czy nowa notatka ma trafić także do kartoteki obiektu. Reset po wysyłce. */
  const [copyToObject, setCopyToObject] = useState(false);
  /**
   * Otwarty modal informacyjny: `composer` = pierwsze włączenie toggla,
   * `{ noteId }` = kopiowanie istniejącej notatki. `null` = zamknięty.
   */
  const [copyInfo, setCopyInfo] = useState<"composer" | { noteId: number } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const addRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Aktualna lista pending do zwolnienia object URL-i przy odmontowaniu. */
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pending;

  const publish = useCallback(
    (next: CalendarNote[]) => {
      setNotes(next);
      onCountChange?.(next.length, next);
    },
    [onCountChange]
  );

  // Ładowanie, gdy rodzic nie dał notatek (np. tryb view otwarty z listy albo starszy GET bez `notes`).
  const hasInitial = !!initialNotes;
  useEffect(() => {
    if (hasInitial) return;
    let cancelled = false;
    calendarApi
      .notes(eventId)
      .then((res) => {
        if (!cancelled) publish(res.data ?? []);
      })
      .catch(() => {
        /* starszy backend bez notatek — lista pusta, pole dodawania nadal działa */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, hasInitial, publish]);

  // „zapisano” gaśnie po chwili
  useEffect(() => {
    if (savedAt == null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2500);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  useEffect(() => {
    if (editingId != null) editRef.current?.focus();
  }, [editingId]);

  // Zwolnienie miniatur przy odmontowaniu (zamknięcie dialogu z niewysłanymi plikami).
  useEffect(
    () => () => {
      for (const p of pendingRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    },
    []
  );

  const canManage = (n: CalendarNote) => canEdit && (isAdmin || (user != null && n.userId === user.id));

  /** Dodaje pliki do kompozytora z walidacją; komunikaty o odrzuconych trafiają do `error`. */
  const addFiles = useCallback(
    (incoming: File[]) => {
      if (!canEdit || adding || incoming.length === 0) return;
      const { accepted, messages } = partitionAttachmentFiles(incoming, pendingRef.current.length);
      if (accepted.length) {
        const next = accepted.map<PendingFile>((file) => ({
          key: `${Date.now()}-${++pendingSeq}`,
          file,
          previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
        }));
        setPending((p) => [...p, ...next]);
      }
      setError(messages.length ? messages.join(" ") : null);
      // Fokus w polu opisu — użytkownik od razu dopisuje komentarz do plików.
      window.requestAnimationFrame(() => addRef.current?.focus());
    },
    [canEdit, adding]
  );

  const removePending = (key: string) => {
    setPending((p) => {
      const item = p.find((x) => x.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return p.filter((x) => x.key !== key);
    });
  };

  const clearPending = () => {
    for (const p of pendingRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPending([]);
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    // Reset, żeby ten sam plik dało się wybrać ponownie po usunięciu z listy.
    e.target.value = "";
    addFiles(list);
  };

  /**
   * Wysyłka szkicu. `rethrow` — wołający (dialog przy „Zapisz”) musi wiedzieć o błędzie,
   * żeby nie zapisać wydarzenia; komunikat i tak zostaje w kompozytorze.
   */
  const submitAdd = async (opts?: { rethrow?: boolean }) => {
    const text = draft.trim();
    const files = pending.map((p) => p.file);
    if (!text && files.length === 0) return;
    if (adding) {
      if (opts?.rethrow) throw new Error("Notatka jest właśnie wysyłana.");
      return;
    }
    if (text.length > NOTE_MAX) {
      const msg = `Notatka może mieć maks. ${NOTE_MAX} znaków.`;
      setError(msg);
      if (opts?.rethrow) throw new Error(msg);
      return;
    }
    // Kartoteka obiektu przechowuje treść, nie pliki — sama paczka załączników
    // nie miałaby tam czego pokazać (backend odrzuca to samym komunikatem).
    const copy = canCopyToObject && copyToObject;
    if (copy && !text) {
      const msg = "Do obiektu można skopiować tylko notatkę z treścią.";
      setError(msg);
      if (opts?.rethrow) throw new Error(msg);
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const res = files.length
        ? await calendarApi.addNoteWithFiles(eventId, text, files, { copyToObject: copy })
        : await calendarApi.addNote(eventId, text, { copyToObject: copy });
      if (res.data) publish([...notes, res.data]);
      setDraft("");
      clearPending();
      setCopyToObject(false);
      setSavedAt(Date.now());
      addRef.current?.focus();
    } catch (e) {
      setError(errMsg(e, "Nie udało się dodać notatki."));
      if (opts?.rethrow) throw e;
    } finally {
      setAdding(false);
    }
  };

  /** Porzucenie szkicu (rodzic: „Odrzuć notatkę” przy zapisie wydarzenia). */
  const discardDraft = () => {
    setDraft("");
    clearPending();
    setCopyToObject(false);
    setError(null);
  };

  // Uchwyt budowany co render — dzięki temu `hasDraft`/`submitDraft` widzą aktualny szkic.
  useImperativeHandle(ref, () => ({
    addFiles,
    hasDraft: () => draft.trim().length > 0 || pending.length > 0,
    draftSummary: () => ({ text: draft.trim().length > 0, files: pending.length }),
    submitDraft: () => submitAdd({ rethrow: true }),
    discardDraft,
  }));

  // Sygnał „jest szkic” dla rodzica (badge przy zwiniętej sekcji). Callback trzymamy w refie,
  // żeby zmiana identyczności propa nie wywoływała efektu.
  const draftCbRef = useRef(onDraftChange);
  draftCbRef.current = onDraftChange;
  const hasDraftNow = draft.trim().length > 0 || pending.length > 0;
  useEffect(() => {
    draftCbRef.current?.(hasDraftNow);
  }, [hasDraftNow]);
  useEffect(() => () => draftCbRef.current?.(false), []);

  const startEdit = (n: CalendarNote) => {
    setEditingId(n.id);
    setEditDraft(n.text);
    setError(null);
  };

  const submitEdit = async () => {
    if (editingId == null || editBusy) return;
    const text = editDraft.trim();
    const current = notes.find((n) => n.id === editingId);
    // Notatka z samymi załącznikami może mieć pusty tekst.
    if (!text && !(current?.attachments?.length ?? 0)) {
      setError("Notatka nie może być pusta.");
      return;
    }
    setEditBusy(true);
    setError(null);
    try {
      const res = await calendarApi.updateNote(editingId, text);
      publish(
        notes.map((n) =>
          n.id === editingId ? (res.data ? { ...n, ...res.data, attachments: res.data.attachments ?? n.attachments } : { ...n, text }) : n
        )
      );
      setEditingId(null);
      setSavedAt(Date.now());
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać notatki."));
    } finally {
      setEditBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deleteId == null) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await calendarApi.deleteNote(deleteId);
      publish(notes.filter((n) => n.id !== deleteId));
      setDeleteId(null);
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć notatki."));
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDeleteAttachment = async () => {
    if (!deleteAtt) return;
    setDeleteAttBusy(true);
    setError(null);
    try {
      await calendarApi.deleteNoteAttachment(deleteAtt.att.id);
      // Lokalnie usuwamy załącznik, a lista odświeża się z serwera (liczniki, historia).
      publish(
        notes.map((n) =>
          n.id === deleteAtt.noteId ? { ...n, attachments: (n.attachments ?? []).filter((a) => a.id !== deleteAtt.att.id) } : n
        )
      );
      setDeleteAtt(null);
      calendarApi
        .notes(eventId)
        .then((res) => {
          if (res.data) publish(res.data);
        })
        .catch(() => {
          /* stan lokalny już zaktualizowany */
        });
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    } finally {
      setDeleteAttBusy(false);
    }
  };

  /**
   * Potwierdzenie modalu „Notatka w kartotece obiektu”. Dla kompozytora tylko
   * włącza toggle (kopia powstanie przy wysyłce), dla istniejącej notatki od razu
   * woła backend — operacja jest idempotentna, więc powtórka nic nie psuje.
   */
  const confirmCopyInfo = async () => {
    if (copyInfo === "composer") {
      setCopyToObject(true);
      setCopyInfo(null);
      return;
    }
    if (copyInfo == null || copyBusy) return;
    const noteId = copyInfo.noteId;
    setCopyBusy(true);
    setError(null);
    try {
      const res = await calendarApi.copyNoteToObject(noteId);
      const objectNoteId = res.data?.id ?? null;
      publish(notes.map((n) => (n.id === noteId ? { ...n, objectNoteId } : n)));
      setCopyInfo(null);
    } catch (e) {
      setError(errMsg(e, "Nie udało się skopiować notatki do obiektu."));
      setCopyInfo(null);
    } finally {
      setCopyBusy(false);
    }
  };

  /** Ctrl/Cmd+Enter = wyślij; zatrzymujemy propagację, żeby dialog nie zapisał całego formularza. */
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void, cancel?: () => void) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === "Escape" && cancel) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const draftLen = draft.trim().length;
  const canSubmit = !adding && (draftLen > 0 || pending.length > 0);

  const renderAttachments = (n: CalendarNote) => {
    const atts = n.attachments ?? [];
    if (atts.length === 0) return null;
    const images = atts.filter((a) => a.kind === "image");
    const files = atts.filter((a) => a.kind !== "image");
    const manage = canManage(n);
    const removeBtn = (a: CalendarNoteAttachment, className?: string) =>
      manage ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDeleteAtt({ noteId: n.id, att: a });
          }}
          className={cn(
            "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
          aria-label={`Usuń załącznik ${a.fileName}`}
          title="Usuń załącznik"
          data-testid="attachment-delete"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null;
    return (
      <div className="mt-1.5 space-y-1.5" data-testid="note-attachments" data-count={atts.length}>
        {images.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Obrazy">
            {images.map((a) => (
              <li key={a.id} className="group/att relative">
                <button
                  type="button"
                  onClick={() => setLightbox(a)}
                  className="block h-24 w-24 overflow-hidden rounded-md border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-28 sm:w-28"
                  title={`${a.fileName} · ${fmtFileSize(a.size)}`}
                  data-testid="attachment-image"
                >
                  <img
                    src={a.url}
                    alt={a.fileName}
                    width={a.width ?? undefined}
                    height={a.height ?? undefined}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform group-hover/att:scale-[1.03]"
                  />
                </button>
                {removeBtn(a, "absolute right-1 top-1 opacity-80 sm:opacity-0 sm:group-hover/att:opacity-100 sm:focus-visible:opacity-100")}
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Pliki">
            {files.map((a) => {
              const Icon = attachmentIcon(a.mime, a.fileName);
              const inline = opensInline(a);
              return (
                <li key={a.id} className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs">
                  <a
                    href={inline ? a.url : downloadUrl(a)}
                    target={inline ? "_blank" : undefined}
                    rel={inline ? "noopener noreferrer" : undefined}
                    download={inline ? undefined : a.fileName}
                    className="flex min-w-0 items-center gap-1.5 py-1 hover:underline"
                    title={inline ? "Otwórz w nowej karcie" : "Pobierz"}
                    data-testid="attachment-file"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{a.fileName}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(a.size)}</span>
                    {inline ? (
                      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <Download className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </a>
                  {removeBtn(a, "ml-0.5 h-5 w-5 ring-0 shadow-none bg-transparent")}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="event-notes" data-count={notes.length}>
      {loading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Wczytywanie notatek…
        </p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="notes-empty">
          Brak notatek. {canEdit ? "Dopisz ustalenia, przebieg prac albo uwagi — każda notatka ma autora i czas." : ""}
        </p>
      ) : (
        <ol className="space-y-1" aria-label="Notatki">
          {notes.map((n) => {
            const editing = editingId === n.id;
            const edited = n.updatedAt && n.updatedAt !== n.createdAt;
            const who = n.source === "assistant" ? n.userLabel || "Asystent" : n.userLabel || (n.source === "system" ? "System" : "—");
            const hasText = !!n.text?.trim();
            return (
              <li
                key={n.id}
                className={cn(
                  "group flex gap-2.5 rounded-md py-1.5 pr-1 transition-colors",
                  editing ? "bg-muted/50" : "hover:bg-muted/40"
                )}
                data-testid="event-note"
                data-note-id={n.id}
                data-source={n.source}
              >
                <div className="flex flex-col items-center">
                  <NoteAvatar note={n} />
                  <div className="mt-1 w-px flex-1 bg-border" />
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      <span className="truncate font-medium">{who}</span>
                      {n.source === "assistant" && (
                        <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          asystent
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <time dateTime={n.createdAt} title={fmtTimestamp(n.createdAt)} className="whitespace-nowrap">
                        {fmtRelative(n.createdAt)}
                      </time>
                      {edited && (
                        <span title={`Zmieniono ${fmtTimestamp(n.updatedAt)}`} className="whitespace-nowrap">
                          · edytowano
                        </span>
                      )}
                    </span>
                  </div>
                  {editing ? (
                    <div className="mt-1 space-y-1.5">
                      <MentionTextarea
                        textareaRef={editRef}
                        value={editDraft}
                        onChange={setEditDraft}
                        onKeyDown={(e) => onKey(e, () => void submitEdit(), () => setEditingId(null))}
                        rows={3}
                        maxLength={NOTE_MAX}
                        ariaLabel="Treść notatki"
                        testId="note-edit-input"
                      />
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          disabled={editBusy || (!editDraft.trim() && !(n.attachments?.length ?? 0))}
                          onClick={() => void submitEdit()}
                          data-testid="note-edit-save"
                        >
                          {editBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                          Zapisz
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="h-8" disabled={editBusy} onClick={() => setEditingId(null)}>
                          <X className="mr-1 h-3.5 w-3.5" /> Anuluj
                        </Button>
                        <span className="ml-auto text-[11px] text-muted-foreground">Ctrl/Cmd+Enter</span>
                      </div>
                      {renderAttachments(n)}
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {hasText && <NoteText note={n} onOpenMention={onOpenMention} />}
                        {renderAttachments(n)}
                        <NoteLinkedEvents note={n} onOpenMention={onOpenMention} />
                        {canSeeObject && n.objectNoteId != null && (
                          <Link
                            to={`/objects/${objectId}`}
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/40 px-1.5 py-px text-[10px] font-medium text-emerald-800 hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-200"
                            data-testid="note-in-object"
                            {...tip(
                              objectName
                                ? `Kopia tej notatki jest w kartotece obiektu „${objectName}” — otwórz`
                                : "Kopia tej notatki jest w kartotece obiektu — otwórz"
                            )}
                          >
                            <Check className="h-3 w-3" aria-hidden />
                            w obiekcie
                          </Link>
                        )}
                      </div>
                      {/* Kopiowanie do kartoteki nie wymaga autorstwa notatki (liczy się
                          edit do klucza `objects`), więc pasek akcji pokazujemy też
                          wtedy, gdy jedyną dostępną akcją jest „Do obiektu”. */}
                      {(canManage(n) || (canCopyToObject && n.objectNoteId == null && hasText)) && (
                        <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0">
                          {canCopyToObject && n.objectNoteId == null && hasText && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              aria-label="Skopiuj notatkę do kartoteki obiektu"
                              onClick={() => setCopyInfo({ noteId: n.id })}
                              data-testid="note-copy-to-object"
                              {...tip("Do obiektu — zapisz kopię w kartotece")}
                            >
                              <Building2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canManage(n) && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground"
                                aria-label="Edytuj notatkę"
                                title="Edytuj"
                                onClick={() => startEdit(n)}
                                data-testid="note-edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                aria-label="Usuń notatkę"
                                title="Usuń"
                                onClick={() => setDeleteId(n.id)}
                                data-testid="note-delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canEdit && (
        <div className="rounded-md border bg-background p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring" data-testid="note-add">
          <MentionTextarea
            textareaRef={addRef}
            value={draft}
            onChange={setDraft}
            onKeyDown={(e) => onKey(e, () => void submitAdd())}
            rows={2}
            maxLength={NOTE_MAX}
            autoFocus={autoFocus}
            placeholder={
              pending.length
                ? "Opis do załączników (opcjonalnie)…"
                : "Dodaj notatkę — przebieg, ustalenia… data po „@” (np. @piątek) tworzy kafelek w kalendarzu"
            }
            ariaLabel="Nowa notatka"
            className="min-h-0 resize-y border-0 px-1 py-1 shadow-none focus-visible:ring-0"
            testId="note-add-input"
          />

          {pending.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1.5 px-1" aria-label="Pliki do wysłania" data-testid="note-pending-files">
              {pending.map((p) => (
                <li
                  key={p.key}
                  className="flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-1.5 pr-1 text-xs"
                  data-testid="note-pending-file"
                >
                  {p.previewUrl ? (
                    <img src={p.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    (() => {
                      const Icon = attachmentIcon(p.file.type, p.file.name);
                      return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
                    })()
                  )}
                  <span className="max-w-[10rem] truncate" title={p.file.name}>
                    {p.file.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(p.file.size)}</span>
                  <button
                    type="button"
                    onClick={() => removePending(p.key)}
                    disabled={adding}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Usuń ${p.file.name}`}
                    title="Usuń z listy"
                    data-testid="note-pending-remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* „Zapisz też w obiekcie” — tylko gdy jest do czego kopiować i wolno.
              Pierwsze włączenie prowadzi przez modal, bo kopia jest trwała
              i widoczna dla wszystkich z dostępem do obiektów. */}
          {canCopyToObject && (
            <div className="mt-1 flex items-center gap-1.5 px-1">
              <Checkbox
                id={`note-copy-object-${eventId}`}
                checked={copyToObject}
                disabled={adding}
                onCheckedChange={(v) => {
                  // Wyłączenie bez pytania; włączenie dopiero po przeczytaniu modalu.
                  if (v === true) setCopyInfo("composer");
                  else setCopyToObject(false);
                }}
                data-testid="note-copy-to-object-toggle"
              />
              <label
                htmlFor={`note-copy-object-${eventId}`}
                className="inline-flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted-foreground"
              >
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                Zapisz też w obiekcie
                {objectName && <span className="max-w-[12rem] truncate font-medium">„{objectName}”</span>}
              </label>
              <button
                type="button"
                onClick={() => setCopyInfo("composer")}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Co to znaczy „Zapisz też w obiekcie”?"
                data-testid="note-copy-to-object-info"
                {...tip("Co się stanie po zaznaczeniu?")}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={CALENDAR_ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={onFileInput}
              data-testid="note-file-input"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" aria-live="polite">
              {savedAt != null ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300" data-testid="note-saved">
                  <Check className="h-3 w-3" aria-hidden /> zapisano
                </span>
              ) : draftLen > 0 || pending.length > 0 ? (
                <>
                  Zapis natychmiastowy, niezależnie od „Zapisz”.
                  {draftLen > NOTE_MAX * 0.8 && <span className="ml-1 tabular-nums">{draftLen}/{NOTE_MAX}</span>}
                </>
              ) : null}
            </span>
            {/* Podpowiedzi (skrót, drop plików) tylko w hoverze — pasek pod polem zostaje czysty. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground"
                disabled={adding || pending.length >= CALENDAR_ATTACHMENT_MAX_FILES}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Dodaj załącznik"
                title={`Dodaj załącznik · pliki można też upuścić na okno (maks. ${CALENDAR_ATTACHMENT_MAX_FILES} plików po 5 MB)`}
                data-testid="note-attach"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={() => void submitAdd()}
                title="Ctrl/Cmd+Enter — dodaj"
                data-testid="note-add-submit"
              >
                {adding ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                {adding ? "Wysyłanie…" : "Dodaj notatkę"}
              </Button>
            </span>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive" data-testid="note-error">
          {error}
        </p>
      )}

      {/* Modal informacyjny — jeden dla obu ścieżek: włączenia toggla w kompozytorze
          i kopiowania istniejącej notatki. Tłumaczy skutki, bo kopia jest trwała. */}
      <Dialog open={copyInfo != null} onOpenChange={(o) => !o && !copyBusy && setCopyInfo(null)}>
        <DialogContent className="sm:max-w-md" data-testid="note-copy-to-object-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              Notatka w kartotece obiektu
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-left">
                <p>
                  Notatka zostanie zapisana także w karcie obiektu{" "}
                  <span className="font-medium text-foreground">„{objectName ?? `#${objectId}`}”</span>, w sekcji
                  Notatki.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>zobaczy ją każdy, kto ma dostęp do obiektów;</li>
                  <li>kopia będzie oznaczona źródłem — tym wydarzeniem;</li>
                  <li>
                    późniejsza edycja notatki w kalendarzu <span className="font-medium">nie zmieni</span> kopii
                    w obiekcie (i odwrotnie).
                  </li>
                </ul>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={copyBusy} onClick={() => setCopyInfo(null)}>
              Anuluj
            </Button>
            <Button
              type="button"
              disabled={copyBusy}
              onClick={() => void confirmCopyInfo()}
              data-testid="note-copy-to-object-confirm"
            >
              {copyBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
              Rozumiem, dodaj do obiektu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId != null} onOpenChange={(o) => !o && !deleteBusy && setDeleteId(null)}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć notatkę?</AlertDialogTitle>
            <AlertDialogDescription>Notatka zniknie z dziennika wydarzenia. Wpis o usunięciu zostanie w historii.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="note-delete-confirm"
            >
              {deleteBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteAtt != null} onOpenChange={(o) => !o && !deleteAttBusy && setDeleteAtt(null)}>
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć załącznik?</AlertDialogTitle>
            <AlertDialogDescription>
              Plik „{deleteAtt?.att.fileName}” zostanie trwale usunięty z notatki.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAttBusy}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteAttBusy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteAttachment();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="attachment-delete-confirm"
            >
              {deleteAttBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lightbox — podgląd obrazka w pełnym rozmiarze */}
      <Dialog open={lightbox != null} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent
          className="flex max-h-[95vh] w-[min(96vw,64rem)] max-w-none flex-col gap-2 p-3 motion-reduce:animate-none sm:p-4"
          data-testid="attachment-lightbox"
        >
          <DialogTitle className="truncate pr-8 text-sm font-medium">{lightbox?.fileName}</DialogTitle>
          <DialogDescription className="sr-only">Podgląd załącznika</DialogDescription>
          {lightbox && (
            <>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-muted/40">
                <img
                  src={lightbox.url}
                  alt={lightbox.fileName}
                  width={lightbox.width ?? undefined}
                  height={lightbox.height ?? undefined}
                  className="max-h-[80vh] max-w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {lightbox.width && lightbox.height ? `${lightbox.width}×${lightbox.height} · ` : ""}
                  {fmtFileSize(lightbox.size)}
                </span>
                <Button asChild size="sm" variant="outline" className="h-8">
                  <a href={downloadUrl(lightbox)} download={lightbox.fileName}>
                    <Download className="mr-1 h-3.5 w-3.5" /> Pobierz
                  </a>
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
