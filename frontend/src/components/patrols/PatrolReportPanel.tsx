/**
 * Panel boczny z raportem jednego podjazdu (v3, docs/PODJAZDY-RAPORTY.md → „Panel boczny v3”).
 * Nie-modalny: bez nakładki, lista obok zostaje klikalna, zmiana `eventId` podmienia
 * treść bez zamykania (stara treść zostaje przyciemniona do czasu wczytania nowej).
 * Desktop (≥1024 px): przyklejony do prawej krawędzi, szerokość z `width`, własne
 * przewijanie i lepki nagłówek. Węższe ekrany: pełnoekranowy arkusz wysuwany z prawej.
 * Portal do <body> — reguła druku w patrol-report.css drukuje tylko ten panel.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { PermLink } from "@/components/PermLink";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Printer,
  ReceiptText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ObjectPicker, type ObjectPickerFetcher } from "@/components/interventions/ObjectPicker";
import { patrolsApi, type InterventionPickObject, type PatrolEventDetail } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PatrolReport, ReportHeading } from "./PatrolReport";
import { errMsg, isTrue } from "./patrolHelpers";
import { statusOf, type StatusTone } from "./story";

/** Pasek koloru statusu przy lewej krawędzi panelu (te same odcienie co chip statusu). */
const STATUS_BAR: Record<StatusTone, string> = {
  late: "bg-rose-500",
  ok: "bg-emerald-500",
  hint: "bg-amber-400",
  warn: "bg-amber-400",
  video: "bg-violet-400",
  neutral: "bg-slate-300",
};

/** Stała modułu — picker trzyma fetcher w zależnościach efektu. */
const pickFetcher: ObjectPickerFetcher = (q) => patrolsApi.pickObjects(q);

interface Props {
  eventId: number;
  editable: boolean;
  /** Szerokość panelu na desktopie (px). */
  width: number;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  /** Poprzedni / następny wg kolejności listy; null = brak. */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** „3 z 25” — pozycja na liście (opcjonalnie). */
  position?: string | null;
  /** Po zmianie (obiekt, rozliczenie) lista odświeża wiersz. */
  onChanged: () => void;
  /** Przejście do raportu innego zdarzenia (sekcja „Inne zdarzenia na obiekcie”). */
  onOpenEvent?: (id: number) => void;
}

const iconBtn =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-35";

export function PatrolReportPanel({
  eventId,
  editable,
  width,
  wide,
  onToggleWide,
  onClose,
  onPrev,
  onNext,
  position,
  onChanged,
  onOpenEvent,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);
  const [detail, setDetail] = useState<PatrolEventDetail | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"object" | "intervention" | null>(null);
  const [pickingObject, setPickingObject] = useState(false);

  const load = useCallback(async (id: number) => {
    const req = ++reqRef.current;
    setLoadingId(id);
    setError(null);
    try {
      const d = await patrolsApi.get(id);
      if (req !== reqRef.current) return;
      setDetail(d);
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(errMsg(e, "Nie udało się wczytać raportu"));
      setDetail(null);
    } finally {
      if (req === reqRef.current) setLoadingId(null);
    }
  }, []);

  useEffect(() => {
    void load(eventId);
  }, [eventId, load]);

  // Nowe zdarzenie w panelu → od góry, bez otwartego pickera i starych błędów.
  const shownId = detail?.id ?? null;
  const [prevShown, setPrevShown] = useState<number | null>(null);
  if (prevShown !== shownId) {
    setPrevShown(shownId);
    setActionError(null);
    setPickingObject(false);
  }
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [shownId]);

  const assignObject = async (o: InterventionPickObject | null) => {
    if (!detail) return;
    setBusy("object");
    setActionError(null);
    try {
      await patrolsApi.assignObject(detail.id, o?.id ?? null);
      setPickingObject(false);
      await load(detail.id);
      onChanged();
    } catch (e) {
      setActionError(errMsg(e, "Nie udało się przypisać obiektu"));
    } finally {
      setBusy(null);
    }
  };

  const createIntervention = async () => {
    if (!detail) return;
    setBusy("intervention");
    setActionError(null);
    try {
      await patrolsApi.createIntervention(detail.id);
      await load(detail.id);
      onChanged();
    } catch (e) {
      setActionError(errMsg(e, "Nie udało się utworzyć rozliczenia"));
    } finally {
      setBusy(null);
    }
  };

  const linked = detail?.object ?? null;
  const hasPatrol = detail ? isTrue(detail.hasPatrol) : false;
  const switching = loadingId != null && detail != null && detail.id !== loadingId;

  /** Obiekt w kartotece (na wydruku tylko nazwa). */
  const objectSlot = detail ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="podjazdy-report-object">
      <Building2 className={cn("h-4 w-4 shrink-0", linked ? "text-slate-400" : "text-amber-600")} aria-hidden />
      {pickingObject && editable ? (
        <div className="patrol-noprint flex min-w-[240px] flex-1 items-center gap-2">
          <ObjectPicker
            value={null}
            onChange={(o) => o && void assignObject(o)}
            disabled={busy === "object"}
            fetcher={pickFetcher}
            testid="podjazdy-object-picker"
            className="flex-1"
          />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPickingObject(false)} title="Anuluj">
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : linked ? (
        <>
          <PermLink to={`/objects/${linked.id}`} tab="objects" className="font-medium text-indigo-700 hover:underline">
            {linked.name}
          </PermLink>
          {editable && !detail.interventionId && (
            <button
              type="button"
              className="patrol-noprint inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-900"
              onClick={() => setPickingObject(true)}
              data-testid="podjazdy-object-change"
            >
              <Pencil className="h-3 w-3" /> Zmień
            </button>
          )}
        </>
      ) : (
        <>
          <span className="font-medium text-amber-800">nie dopasowano obiektu</span>
          {editable && (
            <Button
              size="sm"
              variant="outline"
              className="patrol-noprint h-6 border-amber-300 bg-white px-2 text-xs"
              onClick={() => setPickingObject(true)}
              data-testid="podjazdy-object-assign"
            >
              Wskaż obiekt
            </Button>
          )}
        </>
      )}
      {busy === "object" && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
    </div>
  ) : null;

  const style = { "--patrol-panel-w": `${width}px` } as CSSProperties;

  return createPortal(
    <aside
      className={cn(
        "patrol-print-root patrol-panel fixed inset-0 z-50 flex flex-col bg-white",
        "lg:left-auto lg:z-40 lg:w-[var(--patrol-panel-w)] lg:border-l lg:border-slate-200 lg:shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.18)]"
      )}
      style={style}
      role="complementary"
      aria-label="Raport z podjazdu"
      data-testid="podjazdy-report-panel"
      data-event-id={detail?.id ?? eventId}
    >
      {detail && (
        <span className={cn("patrol-noprint pointer-events-none absolute inset-y-0 left-0 z-20 w-[3px]", STATUS_BAR[statusOf(detail).tone])} aria-hidden data-testid="podjazdy-report-statusbar" />
      )}
      <div ref={scrollRef} className="patrol-print-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <header className="patrol-panel-head sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 pb-4 pt-2 backdrop-blur sm:px-6" data-testid="podjazdy-report-header">
          {loadingId != null && (
            <div className="patrol-noprint absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-indigo-100">
              <div className="h-full w-1/3 animate-pulse bg-indigo-500" />
            </div>
          )}
          {/* Pasek akcji */}
          <div className="patrol-noprint -mx-1.5 flex items-center gap-0.5">
            <button type="button" className={cn(iconBtn, "lg:hidden")} onClick={onClose} aria-label="Wróć do listy" data-testid="podjazdy-report-back">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button type="button" className={iconBtn} onClick={onPrev ?? undefined} disabled={!onPrev} title="Poprzedni (↑ / k)" aria-label="Poprzedni podjazd" data-testid="podjazdy-report-prev">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="button" className={iconBtn} onClick={onNext ?? undefined} disabled={!onNext} title="Następny (↓ / j)" aria-label="Następny podjazd" data-testid="podjazdy-report-next">
              <ChevronDown className="h-4 w-4" />
            </button>
            {position && (
              <span className="tnum ml-1 text-xs text-slate-400" data-testid="podjazdy-report-position">
                {position}
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {detail && hasPatrol && editable && !detail.interventionId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mr-1 h-7 px-2 text-xs"
                  onClick={() => void createIntervention()}
                  disabled={busy !== null || !linked}
                  title={linked ? "Dopisz podjazd do rejestru Grup interwencyjnych" : "Najpierw wskaż obiekt z kartoteki"}
                  data-testid="podjazdy-report-intervention"
                >
                  {busy === "intervention" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ReceiptText className="mr-1 h-3.5 w-3.5" />}
                  Utwórz rozliczenie
                </Button>
              )}
              {detail?.interventionId && (
                <PermLink
                  to="/cma/grupy-interwencyjne?panel=interwencje"
                  tab="cma/grupy-interwencyjne"
                  className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                  data-testid="podjazdy-report-intervention-link"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Rozliczony
                </PermLink>
              )}
              <button type="button" className={iconBtn} onClick={() => window.print()} disabled={!detail} title="Drukuj / PDF" aria-label="Drukuj / PDF" data-testid="podjazdy-report-print">
                <Printer className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={cn(iconBtn, "hidden lg:inline-flex")}
                onClick={onToggleWide}
                title={wide ? "Zwęź panel" : "Rozszerz panel"}
                aria-label={wide ? "Zwęź panel" : "Rozszerz panel"}
                aria-pressed={wide}
                data-testid="podjazdy-report-width"
              >
                {wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button type="button" className={cn(iconBtn, "hidden lg:inline-flex")} onClick={onClose} title="Zamknij (Esc)" aria-label="Zamknij" data-testid="podjazdy-report-close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          {detail && <ReportHeading detail={detail} />}
        </header>

        {actionError && (
          <div className="patrol-noprint border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 sm:px-6" data-testid="podjazdy-report-error">
            {actionError}
          </div>
        )}

        <div className={cn("px-4 py-5 transition-opacity sm:px-6", switching && "opacity-50")}>
          {!detail && loadingId != null ? (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Wczytywanie raportu…
            </div>
          ) : error ? (
            <div className="py-24 text-center text-sm text-red-700">{error}</div>
          ) : detail ? (
            <PatrolReport detail={detail} objectSlot={objectSlot} onOpenEvent={onOpenEvent} />
          ) : null}
        </div>
      </div>
    </aside>,
    document.body
  );
}
