import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, Undo2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TOASTY — jedyny kanał potwierdzeń po akcjach natychmiastowych.
 *
 * „Rozpocznij” i „Zakończ” zapisują się od razu, bez pytania; bezpiecznikiem
 * jest krótki komunikat, a przy akcjach odwracalnych przycisk „Cofnij”. To
 * szybsze niż dialog potwierdzenia przy każdym tapnięciu u klienta.
 *
 * Stos siedzi na dole na ŚRODKU, nad tab barem i nad klawiaturą (`--kb`):
 * prawy dolny róg zajmuje pasek akcji, a górę — sticky nagłówek.
 */

export type ToastKind = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Ikona przycisku akcji; domyślnie strzałka „cofnij”. */
  icon?: LucideIcon;
}

export interface ToastOptions {
  message: ReactNode;
  kind?: ToastKind;
  /** Czas życia w ms; `0` = zostaje aż do zamknięcia ręcznego. */
  duration?: number;
  action?: ToastAction;
}

interface ToastItem extends Required<Omit<ToastOptions, "action">> {
  id: number;
  action?: ToastAction;
}

interface ToastCtx {
  /** Podnosi toast, zwraca jego id. */
  toast: (opts: ToastOptions) => number;
  /** Skrót na „zrobione + Cofnij” (5 s). */
  toastUndo: (message: ReactNode, onUndo: () => void) => number;
  /** Skrót na błąd (8 s — trzeba zdążyć przeczytać). */
  toastError: (message: ReactNode) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const ICONS: Record<ToastKind, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback(
    ({ message, kind = "info", duration, action }: ToastOptions) => {
      const id = nextId.current++;
      const ttl = duration ?? (action ? 5000 : kind === "error" ? 8000 : 4000);
      setItems((prev) => [...prev.slice(-3), { id, message, kind, duration: ttl, action }]);
      if (ttl > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ttl),
        );
      }
      return id;
    },
    [dismiss],
  );

  const toastUndo = useCallback(
    (message: ReactNode, onUndo: () => void) =>
      toast({
        message,
        kind: "success",
        duration: 5000,
        action: { label: "Cofnij", onClick: onUndo },
      }),
    [toast],
  );

  const toastError = useCallback(
    (message: ReactNode) => toast({ message, kind: "error", duration: 8000 }),
    [toast],
  );

  // Sprzątanie timerów przy odmontowaniu providera (HMR w dev).
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastCtx>(
    () => ({ toast, toastUndo, toastError, dismiss }),
    [toast, toastUndo, toastError, dismiss],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastStack items={items} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast poza ToastProvider");
  return c;
}

function ToastActionButton({ action, onDone }: { action: ToastAction; onDone: () => void }) {
  const Icon = action.icon ?? Undo2;
  return (
    <button
      type="button"
      onClick={() => {
        onDone();
        action.onClick();
      }}
      className="inline-flex min-h-9 shrink-0 select-none items-center gap-1.5 rounded-lg bg-secondary px-3 text-sm font-medium text-secondary-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {action.label}
    </button>
  );
}

function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed left-1/2 z-[70] flex w-[min(30rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col gap-2",
        // Nad tab barem (56 px), nad safe area i nad klawiaturą.
        "bottom-[calc(3.5rem+0.75rem+var(--kb,0px)+env(safe-area-inset-bottom,0px))]",
      )}
    >
      {items.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-center gap-3 rounded-xl border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg",
              t.kind === "error" && "border-destructive/50",
              t.kind === "success" && "border-emerald-500/40",
            )}
          >
            <Icon
              className={cn(
                "h-4 w-4 shrink-0",
                t.kind === "error" && "text-destructive",
                t.kind === "success" && "text-emerald-600",
                t.kind === "info" && "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action && <ToastActionButton action={t.action} onDone={() => onDismiss(t.id)} />}
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Zamknij powiadomienie"
              className="inline-flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg text-muted-foreground active:scale-95 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
