import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EXTRA_LABELS,
  cameraLabel,
  capturedViaLabel,
  formatBytes,
  formatCoords,
  formatExtraValue,
  formatMeters,
  formatMime,
  formatTakenAt,
  haversineMeters,
  mapsLink,
  plNumber,
  takenAtEpoch,
  takenAtSourceNote,
  type AttachmentMeta,
} from "@/lib/photo-meta";

/**
 * PRZYCISK „i” PRZY ZDJĘCIU — pełne metadane, ale schowane.
 *
 * Notatka ma zostać notatką: zdjęcie i zdanie. Data wykonania, pinezka, model
 * telefonu i trzydzieści pól EXIF-u to dane ROZSTRZYGAJĄCE („kiedy to było
 * zrobione?”, „czy on w ogóle tam był?”) — potrzebne raz na sto zdjęć i wtedy
 * potrzebne natychmiast. Stąd kółko „i” w rogu miniatury: na desktopie panel
 * wychodzi na najechanie i na fokus z klawiatury, a kliknięcie go PRZYPINA
 * (można wejść myszą w link do map); na dotyku tapnięcie otwiera i zamyka.
 *
 * Bez `meta` przycisku NIE MA — puste kółko byłoby obietnicą bez pokrycia.
 *
 * Dlaczego nie `components/ui/tooltip.tsx`: tamta warstwa ma
 * `pointer-events: none` i w ogóle nie pokazuje się przy `pointer: coarse`,
 * czyli dokładnie tam, gdzie ten panel jest najbardziej potrzebny (tablet
 * technika). Radix-owego Popovera w projekcie nie ma, a dokładanie go dla
 * jednego przycisku to kolejne 15 kB — więc pozycjonowanie jest tu ręczne,
 * tym samym wzorcem co podgląd załącznika maila w `CalendarEventNotes`.
 */

/** Szerokość panelu. Mieści „4032 × 3024 · 2,4 MB · JPEG” bez zawijania. */
const PANEL_W = 268;
/** Ile czekamy z zamknięciem po zjechaniu myszą — tyle trwa skok na panel. */
const CLOSE_DELAY_MS = 140;
/** Od jakiej różnicy data wykonania przestaje być tym samym co data wpisu. */
const DIFFERENT_MIN = 10;

export function PhotoMetaInfo({
  meta,
  createdAt,
  objectLat,
  objectLng,
  tone = "light",
  big = false,
  className,
  label = "Dane zdjęcia",
}: {
  /** `null`/brak = zdjęcie bez metadanych; komponent nie renderuje nic. */
  meta: AttachmentMeta | null | undefined;
  /** Kiedy notatka trafiła do bazy — do dopisku „dodane …”. */
  createdAt?: Date | null;
  /** Pinezka obiektu ze zlecenia; bez niej znika linia „~120 m od obiektu”. */
  objectLat?: number | null;
  objectLng?: number | null;
  /** `dark` = przycisk na czarnym tle lightboxa. */
  tone?: "light" | "dark";
  /** `true` = cel dotykowy 44 px (panel technika). */
  big?: boolean;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const panelId = useId();

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
    setPinned(false);
  }, []);

  /** Pozycja liczona przy każdym otwarciu: miniatura potrafi przejechać scrollem. */
  const place = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - PANEL_W / 2), vw - PANEL_W - 8);
    // Panel idzie w tę stronę, w którą jest miejsce; przy dolnej krawędzi
    // ekranu wychodzi DO GÓRY (`translateY(-100%)` w stylu wrappera).
    const above = rect.bottom > vh * 0.55;
    setPos({ left, top: above ? rect.top - 6 : rect.bottom + 6, above });
  }, []);

  const show = useCallback(() => {
    cancelClose();
    place();
    setOpen(true);
  }, [place]);

  const scheduleClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  // Zamknięcie „z zewnątrz”: Escape, tapnięcie obok, przewinięcie strony.
  // `pointerdown` w fazie przechwytywania — inaczej klik w miniaturę pod
  // panelem zdążyłby otworzyć lightbox, zanim panel zniknie.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (btnRef.current?.contains(t) || panelRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  useEffect(() => cancelClose, []);

  if (!meta) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="photo-meta-button"
        data-open={open ? "1" : undefined}
        className={cn(
          "flex items-center justify-center focus-visible:outline-none",
          big ? "h-11 w-11" : "h-8 w-8",
          className,
        )}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") show();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") scheduleClose();
        }}
        onFocus={show}
        onBlur={(e) => {
          if (pinned) return;
          const next = e.relatedTarget as Node | null;
          if (next && panelRef.current?.contains(next)) return;
          setOpen(false);
        }}
        // Klik nie ma otwierać lightboxa ani kasować zdjęcia — przycisk stoi
        // NA miniaturze, więc każdą drogę w górę trzeba uciąć ręcznie.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open && pinned) {
            close();
            return;
          }
          show();
          setPinned(true);
        }}
      >
        <span
          className={cn(
            "flex items-center justify-center rounded-full shadow ring-1 transition-colors",
            big ? "h-8 w-8" : "h-6 w-6",
            tone === "dark"
              ? "bg-black/55 text-white ring-white/30"
              : "bg-background/90 text-muted-foreground ring-border",
            open && (tone === "dark" ? "bg-black/80" : "bg-background text-foreground"),
          )}
        >
          <Info className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden />
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[200]"
            style={{
              left: pos.left,
              top: pos.top,
              width: PANEL_W,
              transform: pos.above ? "translateY(-100%)" : undefined,
            }}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          >
            <MetaPanel
              ref={panelRef}
              id={panelId}
              meta={meta}
              createdAt={createdAt ?? null}
              objectLat={objectLat ?? null}
              objectLng={objectLng ?? null}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** Sam panel — bez pozycjonowania, żeby dało się go obejrzeć w izolacji. */
function MetaPanel({
  ref,
  id,
  meta,
  createdAt,
  objectLat,
  objectLng,
}: {
  ref: Ref<HTMLDivElement>;
  id: string;
  meta: AttachmentMeta;
  createdAt: Date | null;
  objectLat: number | null;
  objectLng: number | null;
}) {
  const [details, setDetails] = useState(false);
  const taken = formatTakenAt(meta.takenAt);
  const takenNote = takenAtSourceNote(meta.takenAtSource);
  const added = differentAdded(meta, createdAt);
  const source = capturedViaLabel(meta.capturedVia);
  const camera = cameraLabel(meta.camera);
  const lens = meta.camera?.lens ?? "";
  const orig = origLine(meta.orig);
  const extras = Object.entries(meta.extra ?? {});
  const distance =
    meta.gps && objectLat != null && objectLng != null
      ? haversineMeters(meta.gps.lat, meta.gps.lng, objectLat, objectLng)
      : null;

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label="Dane zdjęcia"
      data-testid="photo-meta-panel"
      className="max-h-[70vh] overflow-y-auto overscroll-contain rounded-lg border bg-popover p-2.5 text-xs leading-snug text-popover-foreground shadow-lg"
    >
      {taken && (
        <Row title="Zrobione" testId="photo-meta-taken">
          <span className="font-medium text-foreground">{taken}</span>
          {takenNote && <span className="text-muted-foreground"> · {takenNote}</span>}
          {added && (
            <span className="block text-muted-foreground" data-testid="photo-meta-added">
              dodane {added}
            </span>
          )}
        </Row>
      )}

      {source && (
        <Row title="Źródło" testId="photo-meta-source">
          {source}
        </Row>
      )}

      {meta.gps && (
        <Row title="Miejsce" testId="photo-meta-place">
          <span className="tabular-nums">{formatCoords(meta.gps.lat, meta.gps.lng)}</span>
          {meta.gps.accuracyM != null && (
            <span className="text-muted-foreground"> · ±{plNumber(Math.round(meta.gps.accuracyM))} m</span>
          )}
          {meta.gps.altitudeM != null && (
            <span className="text-muted-foreground"> · {plNumber(Math.round(meta.gps.altitudeM))} m n.p.m.</span>
          )}
          {distance != null && (
            <span className="block text-muted-foreground" data-testid="photo-meta-distance">
              ~{formatMeters(distance)} od obiektu
            </span>
          )}
          <a
            href={mapsLink(meta.gps.lat, meta.gps.lng)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 flex w-fit items-center gap-1 font-medium text-primary underline decoration-primary/40 underline-offset-2"
            data-testid="photo-meta-maps"
          >
            Otwórz w mapach
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </Row>
      )}

      {(camera || lens) && (
        <Row title="Urządzenie" testId="photo-meta-device">
          {camera}
          {lens && <span className="block text-muted-foreground">{lens}</span>}
        </Row>
      )}

      {orig && (
        <Row title="Oryginał" testId="photo-meta-orig">
          <span className="tabular-nums">{orig}</span>
        </Row>
      )}

      {extras.length > 0 && (
        <div className="mt-1.5 border-t pt-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDetails((v) => !v);
            }}
            aria-expanded={details}
            data-testid="photo-meta-details-toggle"
            className="flex w-full items-center gap-1 rounded text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", !details && "-rotate-90")}
              aria-hidden
            />
            Szczegóły ({extras.length})
          </button>
          {details && (
            <dl className="mt-1 space-y-0.5" data-testid="photo-meta-details">
              {extras.map(([key, value]) => {
                const text = formatExtraValue(key, value);
                if (!text) return null;
                return (
                  <div key={key} className="flex gap-2">
                    <dt className="min-w-0 flex-1 truncate text-muted-foreground">
                      {EXTRA_LABELS[key] ?? key}
                    </dt>
                    <dd className="shrink-0 text-right tabular-nums">{text}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1.5 last:mb-0" data-testid={testId}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="break-words">{children}</div>
    </div>
  );
}

/** „4032 × 3024 · 2,4 MB · JPEG” — tylko z tego, co faktycznie jest. */
function origLine(orig: AttachmentMeta["orig"]): string {
  if (!orig) return "";
  const parts: string[] = [];
  if (orig.width && orig.height) parts.push(`${orig.width} × ${orig.height}`);
  if (orig.size) parts.push(formatBytes(orig.size));
  const mime = formatMime(orig.mime);
  if (mime) parts.push(mime);
  return parts.join(" · ");
}

/**
 * „17.09, 14:20” — data DODANIA notatki, ale tylko wtedy, gdy różni się od
 * daty wykonania o więcej niż kwadrans roboczy. Przy zdjęciu prosto z aparatu
 * byłaby powtórzeniem linijki wyżej.
 */
function differentAdded(meta: AttachmentMeta, createdAt: Date | null): string {
  if (!createdAt || Number.isNaN(createdAt.getTime())) return "";
  const taken = takenAtEpoch(meta);
  if (taken == null) return "";
  if (Math.abs(createdAt.getTime() - taken) <= DIFFERENT_MIN * 60_000) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(createdAt.getDate())}.${p(createdAt.getMonth() + 1)}, ${p(createdAt.getHours())}:${p(createdAt.getMinutes())}`;
}
