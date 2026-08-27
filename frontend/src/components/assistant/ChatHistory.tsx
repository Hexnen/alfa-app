import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, History, Loader2, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { AssistantChat } from "@/lib/api";
import { fmtRelative } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { chatLabel } from "./parts";


export interface ChatHistoryProps {
  chats: AssistantChat[];
  /** Aktywny czat (null = nowy, jeszcze niezapisany). */
  chatId: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => Promise<void>;
  disabled?: boolean;
}

/**
 * Historia czatów: popover z listą (tytuł do 2 linii + „kiedy”), usuwanie przez AlertDialog.
 * Zastępuje <select> — tytuły były obcinane do jednej linii bez daty.
 */
export function ChatHistory({ chats, chatId, onSelect, onDelete, disabled }: ChatHistoryProps) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<AssistantChat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const current = chats.find((c) => c.id === chatId) ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    const btn = btnRef.current;
    if (!el || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    el.style.width = `${w}px`;
    el.style.left = `${left}px`;
    el.style.top = `${r.bottom + 6}px`;
    el.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 16)}px`;
  }, [open, chats]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLButtonElement>("[data-current=true]")?.focus({ preventScroll: true });
  }, [open]);

  const runDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await onDelete(confirm.id);
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Historia czatów${current ? `: ${chatLabel(current)}` : ""}`}
        title="Historia czatów"
        className="inline-flex h-10 max-w-[9rem] items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs hover:bg-accent disabled:opacity-50 lg:h-8 sm:max-w-[11rem]"
        data-testid="chat-history-toggle"
      >
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{current ? chatLabel(current) : "Nowy czat"}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Historia czatów"
            className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl"
            data-testid="chat-history"
          >
            <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Historia czatów</div>
            <ul className="min-h-0 flex-1 overflow-y-auto py-1">
              {chats.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Brak zapisanych czatów.</li>}
              {chats.map((c) => {
                const cur = c.id === chatId;
                return (
                  <li key={c.id} className="flex items-stretch gap-0.5 px-1">
                    <button
                      type="button"
                      data-current={cur ? "true" : undefined}
                      onClick={() => {
                        onSelect(c.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex min-h-10 min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        cur && "bg-accent/60"
                      )}
                    >
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{cur && <Check className="h-3.5 w-3.5 text-primary" aria-hidden />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 break-words leading-snug">{chatLabel(c)}</span>
                        <span className="block text-[11px] text-muted-foreground">{fmtRelative(c.updatedAt)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirm(c)}
                      aria-label={`Usuń czat: ${chatLabel(c)}`}
                      title="Usuń czat"
                      className="flex w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-8"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body
        )}
      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && !deleting && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć czat?</AlertDialogTitle>
            <AlertDialogDescription>
              „{confirm ? chatLabel(confirm) : ""}” zostanie usunięty wraz z całą historią rozmowy. Zapisane wydarzenia w kalendarzu pozostają.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Anuluj</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" disabled={deleting} onClick={(e) => { e.preventDefault(); void runDelete(); }}>
                {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />}
                Usuń
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
