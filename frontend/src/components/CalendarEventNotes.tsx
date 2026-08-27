import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, Loader2, Pencil, Send, Sparkles, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { useAuth } from "@/auth/AuthProvider";
import { calendarApi, type CalendarNote } from "@/lib/api";
import { NOTE_MAX, fmtRelative, fmtTimestamp, initials, notesLabel } from "@/lib/calendar-labels";
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
}

/**
 * Dziennik notatek wydarzenia. Zapis od razu przez osobne API — niezależnie od „Zapisz” dialogu.
 * Własne notatki (lub admin): edycja inline, usunięcie z potwierdzeniem.
 */
export function CalendarEventNotes({ eventId, initialNotes, canEdit, onCountChange, autoFocus }: CalendarEventNotesProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
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
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

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

  const canManage = (n: CalendarNote) => canEdit && (isAdmin || (user != null && n.userId === user.id));

  const submitAdd = async () => {
    const text = draft.trim();
    if (!text || adding) return;
    if (text.length > NOTE_MAX) {
      setError(`Notatka może mieć maks. ${NOTE_MAX} znaków.`);
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const res = await calendarApi.addNote(eventId, text);
      if (res.data) publish([...notes, res.data]);
      setDraft("");
      setSavedAt(Date.now());
      addRef.current?.focus();
    } catch (e) {
      setError(errMsg(e, "Nie udało się dodać notatki."));
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (n: CalendarNote) => {
    setEditingId(n.id);
    setEditDraft(n.text);
    setError(null);
  };

  const submitEdit = async () => {
    if (editingId == null || editBusy) return;
    const text = editDraft.trim();
    if (!text) {
      setError("Notatka nie może być pusta.");
      return;
    }
    setEditBusy(true);
    setError(null);
    try {
      const res = await calendarApi.updateNote(editingId, text);
      publish(notes.map((n) => (n.id === editingId ? (res.data ?? { ...n, text }) : n)));
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
                      <Textarea
                        ref={editRef}
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => onKey(e, () => void submitEdit(), () => setEditingId(null))}
                        rows={3}
                        maxLength={NOTE_MAX}
                        aria-label="Treść notatki"
                        data-testid="note-edit-input"
                      />
                      <div className="flex items-center gap-1.5">
                        <Button type="button" size="sm" className="h-8" disabled={editBusy || !editDraft.trim()} onClick={() => void submitEdit()} data-testid="note-edit-save">
                          {editBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                          Zapisz
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="h-8" disabled={editBusy} onClick={() => setEditingId(null)}>
                          <X className="mr-1 h-3.5 w-3.5" /> Anuluj
                        </Button>
                        <span className="ml-auto text-[11px] text-muted-foreground">Ctrl/Cmd+Enter</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="note-text">
                        {n.text}
                      </p>
                      {canManage(n) && (
                        <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0">
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
          <Textarea
            ref={addRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => onKey(e, () => void submitAdd())}
            rows={2}
            maxLength={NOTE_MAX}
            autoFocus={autoFocus}
            placeholder="Dodaj notatkę — przebieg, ustalenia z klientem, co zostało do zrobienia…"
            aria-label="Nowa notatka"
            className="min-h-0 resize-y border-0 px-1 py-1 shadow-none focus-visible:ring-0"
            data-testid="note-add-input"
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1">
            <span className="text-[11px] text-muted-foreground" aria-live="polite">
              {savedAt != null ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300" data-testid="note-saved">
                  <Check className="h-3 w-3" aria-hidden /> zapisano
                </span>
              ) : draftLen > 0 ? (
                <>
                  Zapis natychmiastowy, niezależnie od „Zapisz”.
                  {draftLen > NOTE_MAX * 0.8 && <span className="ml-1 tabular-nums">{draftLen}/{NOTE_MAX}</span>}
                </>
              ) : (
                "Ctrl/Cmd+Enter — dodaj"
              )}
            </span>
            <Button type="button" size="sm" className="h-8" disabled={adding || draftLen === 0} onClick={() => void submitAdd()} data-testid="note-add-submit">
              {adding ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
              Dodaj notatkę
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive" data-testid="note-error">
          {error}
        </p>
      )}

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
    </div>
  );
}
