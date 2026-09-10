/**
 * NOTATKI KARTOTEKI OBIEKTU — karta obok „Kalendarza” w `pages/ObjectDetails.tsx`.
 *
 * Dziennik ustaleń przypiętych do obiektu, a nie do pojedynczego wydarzenia:
 * warunki dojazdu, kontakt do ochrony, historia reklamacji. Wpisy powstają albo
 * tutaj, albo w kalendarzu (notatka wydarzenia z zaznaczonym „Zapisz też
 * w obiekcie”) — te drugie mają chip „z kalendarza” z linkiem do wydarzenia.
 *
 * Kopia jest NIEZALEŻNA od oryginału: edycja notatki w kalendarzu nie zmienia
 * tego, co stoi w kartotece (i odwrotnie). Dzięki temu kartoteka jest zapisem
 * tego, co wtedy ustalono, a nie ruchomym celem.
 *
 * Wzorce wizualne cytujemy z `components/CalendarEventNotes.tsx` (awatar
 * z inicjałami, czas względny z pełnym w dymku, edycja inline, Ctrl/Cmd+Enter,
 * usuwanie przez `AlertDialog`) — jeden idiom notatek w całej aplikacji.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Check, Loader2, Pencil, Send, StickyNote, Trash2, X } from "lucide-react";
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
import { ChartCard } from "@/components/analytics";
import { tip } from "@/components/ui/tooltip";
import { useAuth } from "@/auth/AuthProvider";
import { objectsApi, type ObjectNote, type ObjectNoteSource } from "@/lib/api";
import { NOTE_MAX, fmtRelative, fmtShort, fmtTimestamp, initials, notesLabel } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Deep link do wydarzenia źródłowego — ten sam kształt, co link „w kalendarzu”
 * na liście wydarzeń obiektu (`ObjectDetails.tsx`). Dział decyduje o module:
 * handlowy ma własny kalendarz pod `/handlowy/kalendarz`.
 */
function sourceHref(src: ObjectNoteSource): string {
  const base = src.eventDepartment === "handlowy" ? "/handlowy/kalendarz" : "/technical/kalendarz";
  return `${base}?event=${src.eventId}&date=${src.eventStartAt.slice(0, 10)}`;
}

export interface ObjectNotesProps {
  objectId: number;
  /** Uprawnienie edit do klucza `objects` — bez niego karta jest tylko do czytania. */
  canEdit: boolean;
  /**
   * Zmiana wartości wymusza przeładowanie listy. Rodzic podbija licznik po
   * zapisie wydarzenia w dialogu kalendarza — stamtąd też powstają notatki obiektu.
   */
  reloadKey?: number;
}

/**
 * Karta „Notatki” kartoteki obiektu: lista + kompozytor. Zapis natychmiastowy,
 * niezależny od formularza edycji obiektu. Edycja i usunięcie tylko dla autora
 * notatki albo admina.
 */
export function ObjectNotes({ objectId, canEdit, reloadKey = 0 }: ObjectNotesProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [notes, setNotes] = useState<ObjectNote[]>([]);
  const [loading, setLoading] = useState(true);
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

  const load = useCallback(() => {
    let cancelled = false;
    objectsApi
      .notes(objectId)
      .then((res) => {
        if (!cancelled) setNotes(res.data ?? []);
      })
      .catch(() => {
        // Starszy backend bez notatek obiektu — pusta lista, karta nadal się renderuje.
        if (!cancelled) setNotes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objectId]);

  useEffect(() => load(), [load, reloadKey]);

  // „zapisano” gaśnie po chwili (jak w notatkach wydarzenia).
  useEffect(() => {
    if (savedAt == null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2500);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  useEffect(() => {
    if (editingId != null) editRef.current?.focus();
  }, [editingId]);

  const canManage = (n: ObjectNote) => canEdit && (isAdmin || (user != null && n.userId === user.id));

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
      const res = await objectsApi.addNote(objectId, text);
      // Najnowsze na górze — tak samo jak zwraca GET.
      if (res.data) setNotes((prev) => [res.data as ObjectNote, ...prev]);
      setDraft("");
      setSavedAt(Date.now());
      addRef.current?.focus();
    } catch (e) {
      setError(errMsg(e, "Nie udało się dodać notatki."));
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (n: ObjectNote) => {
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
      const res = await objectsApi.updateNote(editingId, text);
      setNotes((prev) => prev.map((n) => (n.id === editingId ? (res.data ?? { ...n, text }) : n)));
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
      await objectsApi.deleteNote(deleteId);
      setNotes((prev) => prev.filter((n) => n.id !== deleteId));
      setDeleteId(null);
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć notatki."));
    } finally {
      setDeleteBusy(false);
    }
  };

  /** Ctrl/Cmd+Enter = wyślij, Escape = anuluj edycję. */
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
    <ChartCard
      title={
        <span className="flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          Notatki
        </span>
      }
      description={
        loading
          ? "wczytywanie…"
          : `${notesLabel(notes.length)} · ustalenia przypięte do kartoteki obiektu`
      }
    >
      <div className="space-y-3" data-testid="object-notes" data-count={notes.length}>
        {loading ? (
          <p className="flex items-center gap-1.5 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Wczytywanie notatek…
          </p>
        ) : notes.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center"
            data-testid="object-notes-empty"
          >
            <StickyNote className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Brak notatek</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Ustalenia z klientem, warunki dojazdu, kontakty na miejscu — zapisane tutaj zostają przy
              obiekcie. Notatki z kalendarza można kopiować do kartoteki przy ich dodawaniu.
            </p>
          </div>
        ) : (
          <ol className="space-y-1" aria-label="Notatki obiektu">
            {notes.map((n) => {
              const editing = editingId === n.id;
              const edited = n.updatedAt && n.updatedAt !== n.createdAt;
              const who = n.userLabel || "—";
              return (
                <li
                  key={n.id}
                  className={cn(
                    "group flex gap-2.5 rounded-md py-1.5 pr-1 transition-colors",
                    editing ? "bg-muted/50" : "hover:bg-muted/40"
                  )}
                  data-testid="object-note-item"
                  data-note-id={n.id}
                >
                  <div className="flex flex-col items-center">
                    <span
                      aria-hidden
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                    >
                      {initials(n.userLabel)}
                    </span>
                    <div className="mt-1 w-px flex-1 bg-border" />
                  </div>
                  <div className="min-w-0 flex-1 pb-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm">
                        <span className="truncate font-medium">{who}</span>
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
                          data-testid="object-note-edit-input"
                        />
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            className="h-8"
                            disabled={editBusy || !editDraft.trim()}
                            onClick={() => void submitEdit()}
                            data-testid="object-note-edit-save"
                          >
                            {editBusy ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="mr-1 h-3.5 w-3.5" />
                            )}
                            Zapisz
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-8"
                            disabled={editBusy}
                            onClick={() => setEditingId(null)}
                          >
                            <X className="mr-1 h-3.5 w-3.5" /> Anuluj
                          </Button>
                          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl/Cmd+Enter</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{n.text}</p>
                          {n.source && (
                            <Link
                              to={sourceHref(n.source)}
                              className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-px text-[10px] font-medium text-amber-800 hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200"
                              data-testid="object-note-source"
                              data-event-id={n.source.eventId}
                              {...tip(
                                `Z wydarzenia „${n.source.eventTitle}” (${fmtShort(n.source.eventStartAt)}) — otwórz w kalendarzu`
                              )}
                            >
                              <CalendarDays className="h-3 w-3" aria-hidden />
                              z kalendarza · {fmtShort(n.source.eventStartAt, true)}
                            </Link>
                          )}
                        </div>
                        {canManage(n) && (
                          <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              aria-label="Edytuj notatkę"
                              onClick={() => startEdit(n)}
                              data-testid="object-note-edit"
                              {...tip("Edytuj")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              aria-label="Usuń notatkę"
                              onClick={() => setDeleteId(n.id)}
                              data-testid="object-note-delete"
                              {...tip("Usuń")}
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
          <div className="rounded-md border bg-background p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
            <Textarea
              ref={addRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => onKey(e, () => void submitAdd())}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Dodaj notatkę — ustalenia, kontakt na miejscu, uwagi do obiektu…"
              aria-label="Nowa notatka obiektu"
              className="min-h-0 resize-y border-0 px-1 py-1 shadow-none focus-visible:ring-0"
              data-testid="object-note-input"
            />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" aria-live="polite">
                {savedAt != null ? (
                  <span
                    className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"
                    data-testid="object-note-saved"
                  >
                    <Check className="h-3 w-3" aria-hidden /> zapisano
                  </span>
                ) : draftLen > 0 ? (
                  <>
                    Zapis natychmiastowy.
                    {draftLen > NOTE_MAX * 0.8 && (
                      <span className="ml-1 tabular-nums">
                        {draftLen}/{NOTE_MAX}
                      </span>
                    )}
                  </>
                ) : null}
              </span>
              <Button
                type="button"
                size="sm"
                className="ml-auto h-8 shrink-0"
                disabled={adding || draftLen === 0}
                onClick={() => void submitAdd()}
                data-testid="object-note-submit"
                {...tip("Ctrl/Cmd+Enter — dodaj")}
              >
                {adding ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                {adding ? "Wysyłanie…" : "Dodaj"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive" data-testid="object-note-error">
            {error}
          </p>
        )}

        <AlertDialog open={deleteId != null} onOpenChange={(o) => !o && !deleteBusy && setDeleteId(null)}>
          <AlertDialogContent className="motion-reduce:animate-none">
            <AlertDialogHeader>
              <AlertDialogTitle>Usunąć notatkę?</AlertDialogTitle>
              <AlertDialogDescription>
                Notatka zniknie z kartoteki obiektu. Wpis o usunięciu zostanie w historii. Kopia w kalendarzu
                (jeśli notatka stamtąd pochodzi) zostaje nietknięta.
              </AlertDialogDescription>
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
                data-testid="object-note-delete-confirm"
              >
                {deleteBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                Usuń
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ChartCard>
  );
}
