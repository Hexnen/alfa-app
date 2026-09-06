import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Building2, CalendarDays, Check, ExternalLink, Loader2, MapPin, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { calendarApi, getObject, type CalendarEvent, type ObjectWithDetails } from "@/lib/api";
import { eventTypeLabel, fmtRange } from "@/lib/calendar-labels";
import { cn, objectServicesLabel, statusLabels } from "@/lib/utils";

/**
 * Podgląd obiektu bez opuszczania czatu: klik w nazwę (karta ask_choice, wynik find_object,
 * karta propozycji) otwiera mini-kartę — nazwa, adres, kontrahent, typ/status, najbliższe
 * 3 wydarzenia + „Otwórz kartę obiektu” (/objects/:id) i opcjonalnie „Wybierz ten”.
 * Desktop: fixed popover dosunięty do krawędzi (jak EventPreview w Calendar.tsx);
 * mobile (<768px): dolny arkusz.
 */
export interface ObjectPeekProps {
  objectId: number;
  /** Treść wyzwalacza (domyślnie nazwa obiektu). */
  children: ReactNode;
  className?: string;
  /** W karcie ask_choice: „Wybierz ten”. */
  onSelect?: () => void;
  selectDisabled?: boolean;
  title?: string;
}

const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

export function ObjectPeek({ objectId, children, className, onSelect, selectDisabled, title }: ObjectPeekProps) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title ?? "Podgląd obiektu"}
        aria-haspopup="dialog"
        aria-expanded={open != null}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(open ? null : e.currentTarget.getBoundingClientRect());
        }}
        className={cn("inline-flex min-w-0 items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:decoration-solid", className)}
        data-testid="object-peek-trigger"
      >
        {children}
      </button>
      {open && (
        <ObjectPeekPopover
          objectId={objectId}
          rect={open}
          onClose={() => {
            setOpen(null);
            btnRef.current?.focus({ preventScroll: true });
          }}
          onSelect={onSelect}
          selectDisabled={selectDisabled}
        />
      )}
    </>
  );
}

const todayLocal = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function ObjectPeekPopover({
  objectId,
  rect,
  onClose,
  onSelect,
  selectDisabled,
}: {
  objectId: number;
  rect: DOMRect;
  onClose: () => void;
  onSelect?: () => void;
  selectDisabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const mobile = isMobile();
  const [obj, setObj] = useState<ObjectWithDetails | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getObject(objectId)
      .then((r) => {
        if (!alive) return;
        if (!r.data) throw new Error("Nie znaleziono obiektu.");
        setObj(r.data);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Nie udało się wczytać obiektu."));
    calendarApi
      .objectEvents(objectId)
      .then((r) => {
        if (!alive) return;
        const today = todayLocal();
        const list = (r.data ?? [])
          .filter((e) => !e.deletedAt && e.endAt >= today)
          .sort((a, b) => a.startAt.localeCompare(b.startAt))
          .slice(0, 3);
        setEvents(list);
      })
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [objectId]);

  // Pozycja: prawo od wyzwalacza → lewo → pod spodem; dosunięcie do krawędzi okna.
  // Ustawiana bezpośrednio na elemencie (bez setState w efekcie → bez kaskady renderów).
  useLayoutEffect(() => {
    if (mobile) return;
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    let left = rect.left + rect.width + 8;
    let top = rect.top;
    if (left + width > window.innerWidth - pad) left = rect.left - width - 8;
    if (left < pad) {
      left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
      top = rect.top + rect.height + 6;
    }
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [rect, mobile, obj, events]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    // Esc: zamyka tylko podgląd — `preventDefault` sygnalizuje drawerowi, że klawisz jest obsłużony.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Przewinięcie listy czatu (lub strony) odkleja popover od wyzwalacza — zamykamy.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    // Resize na mobile = klawiatura ekranowa; nie zamykamy arkusza.
    const onResize = () => {
      if (!isMobile()) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus({ preventScroll: true });
  }, [obj]);

  const goto = () => {
    onClose();
    navigate(`/objects/${objectId}`);
  };

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-label={obj ? `Podgląd obiektu: ${obj.name}` : "Podgląd obiektu"}
      data-testid="object-peek"
      style={mobile ? undefined : { left: rect.left, top: rect.top }}
      className={cn(
        "z-[60] rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl",
        mobile ? "fixed inset-x-2 bottom-2 pb-[env(safe-area-inset-bottom)]" : "fixed w-80"
      )}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{obj?.name ?? (error ? "Obiekt" : "Wczytywanie…")}</div>
          {obj && (
            <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
              {/* Skład usług zamiast dawnego „typu ochrony” — „brak usług”
                  zamiast pustej plakietki, żeby luka w kartotece była widoczna. */}
              <span className="rounded-full border px-1.5 py-px">{objectServicesLabel(obj, "brak usług")}</span>
              <span className="rounded-full border px-1.5 py-px">{statusLabels[obj.status] ?? obj.status}</span>
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Zamknij podgląd" className="flex h-10 w-10 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground lg:h-6 lg:w-6">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="space-y-1.5 px-3 py-2 text-xs">
        {error ? (
          <div className="text-red-700 dark:text-red-300">{error}</div>
        ) : !obj ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Wczytywanie…
          </div>
        ) : (
          <>
            <div className="flex items-start gap-1.5">
              <MapPin className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>{[obj.address, obj.city].filter(Boolean).join(", ") || <span className="text-muted-foreground">brak adresu</span>}</span>
            </div>
            <div className="flex items-start gap-1.5">
              <User className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>{obj.contractor?.name ?? <span className="text-muted-foreground">brak kontrahenta</span>}</span>
            </div>
            <div className="flex items-start gap-1.5">
              <CalendarDays className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                {events == null ? (
                  <span className="text-muted-foreground">Wczytuję wydarzenia…</span>
                ) : events.length === 0 ? (
                  <span className="text-muted-foreground">Brak nadchodzących wydarzeń</span>
                ) : (
                  <ul className="space-y-0.5">
                    {events.map((e) => (
                      <li key={e.id} className="truncate">
                        <span className="text-muted-foreground">{fmtRange(e.startAt, e.endAt, e.allDay)}</span> · {eventTypeLabel(e.type)}: {e.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
        {onSelect && (
          <Button size="sm" className="h-10 text-xs lg:h-7" data-primary disabled={selectDisabled} onClick={() => { onClose(); onSelect(); }}>
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden /> Wybierz ten
          </Button>
        )}
        <Button size="sm" variant={onSelect ? "outline" : "default"} className="h-10 text-xs lg:h-7" data-primary={onSelect ? undefined : true} onClick={goto}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden /> Otwórz kartę obiektu
        </Button>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
