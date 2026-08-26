import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lekkie menu kontekstowe (prawy przycisk myszy) pozycjonowane na
 * współrzędnych ekranu. Zamyka się na Escape, klik/prawy klik poza menu,
 * scroll i zmianę rozmiaru okna. Stylistyka jak inne popovery w aplikacji.
 */
export interface ContextMenuItem {
  key: string;
  label: ReactNode;
  icon?: LucideIcon;
  /** Drugorzędny tekst po prawej (np. nazwa obiektu, skrót klawiszowy). */
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Wyróżnienie pozycji destrukcyjnej (czerwone). */
  destructive?: boolean;
  /** Pozycja-separator (ignoruje pozostałe pola). */
  separator?: boolean;
}

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Opcjonalny nagłówek (np. tytuł wydarzenia / data). */
  header?: ReactNode;
  /** Ikona nagłówka (np. typ wydarzenia). */
  headerIcon?: LucideIcon;
  /** Kolor ikony nagłówka (CSS color). */
  headerIconColor?: string;
  /** Podtytuł nagłówka (np. zakres dat). */
  subheader?: ReactNode;
  className?: string;
}

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  header,
  headerIcon: HeaderIcon,
  headerIconColor,
  subheader,
  className,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Dosuń menu do krawędzi viewportu, żeby nie wychodziło poza ekran.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
    setPos({ left, top });
  }, [open, x, y, items.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("contextmenu", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("contextmenu", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, onClose]);

  // Fokus na pierwszej aktywnej pozycji (nawigacja klawiaturą).
  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  const moveFocus = (dir: 1 | -1) => {
    const btns = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = btns[(i + dir + btns.length) % btns.length];
    next?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={typeof header === "string" ? header : undefined}
      data-testid="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(-1);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const btns = ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          const target = btns && (e.key === "Home" ? btns[0] : btns[btns.length - 1]);
          target?.focus({ preventScroll: true });
        }
      }}
      className={cn(
        "alfa-pop fixed z-[60] min-w-[13rem] max-w-[18rem] overflow-hidden rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
        className
      )}
    >
      {header && (
        <div className="mb-1 flex items-start gap-2 border-b px-2 pb-1.5 pt-1">
          {HeaderIcon && (
            <HeaderIcon
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              style={headerIconColor ? { color: headerIconColor } : undefined}
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground">{header}</div>
            {subheader && (
              <div className="truncate text-[11px] tabular-nums text-muted-foreground">
                {subheader}
              </div>
            )}
          </div>
        </div>
      )}
      {items.map((it) =>
        it.separator ? (
          <div key={it.key} role="separator" className="-mx-1 my-1 h-px bg-border" />
        ) : (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onSelect?.();
            }}
            className={cn(
              "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none transition-colors",
              "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              it.destructive && "text-destructive hover:text-destructive focus-visible:text-destructive"
            )}
          >
            {it.icon && <it.icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && (
              <span className="ml-2 max-w-[9rem] shrink truncate text-[11px] text-muted-foreground">
                {it.hint}
              </span>
            )}
          </button>
        )
      )}
    </div>
  );
}
