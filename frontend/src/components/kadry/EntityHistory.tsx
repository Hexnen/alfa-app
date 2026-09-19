/**
 * Historia zmian JEDNEGO wpisu Kadr.
 *
 * Dwa warianty tego samego zapytania (`GET /hr/activity/entity/:type/:id`):
 *  - `icon` — mała ikonka zegara w kolumnie akcji tabeli; otwiera dialog
 *    z osią czasu. Dane ciągną się DOPIERO po kliknięciu, więc tabela ze stoma
 *    wierszami nie robi stu zapytań.
 *  - `section` — zwinięta sekcja „Historia” w dialogu edycji; ładuje się przy
 *    pierwszym rozwinięciu.
 *
 * `period` („2026-09”) zawęża wynik do miesiąca. Jest konieczny dla wypłat:
 * tam `entityId` to id UMOWY (wiersz `hr_payroll` powstaje dopiero przy zapisie
 * miesiąca), więc bez okresu wpis pokazywałby historię wszystkich miesięcy.
 */
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Section } from "@/components/ui/section";
import { tip } from "@/components/ui/tooltip";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { usePerms } from "@/auth/permissions";
import {
  getHrEntityActivity,
  type HrActivityEntityType,
  type HrActivityEntry,
  type HrPortalKey,
} from "@/lib/api";
import {
  describeHrActivity,
  hrEntryDetail,
  hrFieldLabel,
  hrFieldValue,
  hrPeriodLabel,
} from "./history-labels";

interface Props {
  entityType: HrActivityEntityType;
  entityId: number;
  /** Miesiąc „2026-09” — zawęża wpisy (obowiązkowy dla `hr_payroll`). */
  period?: string | null;
  /** Podpis w nagłówku dialogu / sekcji (np. nazwisko i obiekt). */
  title?: string;
  variant?: "icon" | "section";
  /** Tylko `variant="icon"`: dodatkowe klasy przycisku. */
  className?: string;
  /**
   * Sekcja działowa, z której pytamy („Godziny działu”). Podana znaczy też, że
   * uprawnieniem jest klucz sekcji, a nie „kadry/historia" — kierownik działu
   * widzi historię swojego wpisu godzin, choć dziennika Kadr nie ma.
   */
  portal?: HrPortalKey | null;
}

/** Oś czasu Kadr — te same etykiety w obu wariantach. */
function Timeline({ entries }: { entries: HrActivityEntry[] }) {
  return (
    <ActivityTimeline
      entries={entries}
      describe={(e) => describeHrActivity(e as HrActivityEntry)}
      fieldLabel={hrFieldLabel}
      formatValue={hrFieldValue}
      entryDetail={(e) => hrEntryDetail(e as HrActivityEntry)}
      emptyText="Brak zapisanych zmian tego wpisu."
    />
  );
}

/**
 * Wspólne ładowanie — `enabled` włącza je dopiero po otwarciu.
 *
 * Wynik trzymamy razem z KLUCZEM wpisu (`typ:id:okres`), a nie w osobnym stanie
 * czyszczonym efektem: dzięki temu pokazanie innego wiersza w tym samym dialogu
 * nie wymaga `setState` w efekcie (i cyklu renderów ze starymi danymi na ekranie).
 */
function useEntityHistory(
  entityType: HrActivityEntityType,
  entityId: number,
  period: string | null | undefined,
  enabled: boolean,
  /** Sekcja działowa („Godziny działu”) — bez niej backend odmówi jej 403. */
  portal: HrPortalKey | null,
) {
  const key = `${entityType}:${entityId}:${period ?? ""}:${portal ?? ""}`;
  const [state, setState] = useState<{
    key: string;
    entries: HrActivityEntry[] | null;
    error: string | null;
    /** Kursor następnej strony albo null — wtedy „Pokaż więcej" znika. */
    nextCursor: string | null;
    loadingMore: boolean;
  }>({ key, entries: null, error: null, nextCursor: null, loadingMore: false });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const res = await getHrEntityActivity(entityType, entityId, { period, portal });
        if (alive) {
          setState({
            key,
            entries: res.data?.items ?? [],
            error: null,
            nextCursor: res.data?.nextCursor ?? null,
            loadingMore: false,
          });
        }
      } catch (e) {
        if (!alive) return;
        setState({
          key,
          entries: [],
          error: e instanceof Error ? e.message : "Nie udało się pobrać historii",
          nextCursor: null,
          loadingMore: false,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, key, entityType, entityId, period, portal]);

  /**
   * Kolejna strona. Potrzebna zwłaszcza w wierszu PŁACOWYM: tam `entityId` to
   * umowa, a wpisy są per miesiąc, więc historia jednego miesiąca bywa głębiej
   * niż pierwsza strona dziennika tej umowy.
   */
  const loadMore = async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore) return;
    setState((p) => ({ ...p, loadingMore: true }));
    try {
      const res = await getHrEntityActivity(entityType, entityId, { period, cursor, portal });
      setState((p) =>
        // Odpowiedź z innego wpisu (przełączono wiersz w trakcie) nie ma prawa
        // dokleić się do bieżącej listy.
        p.key !== key
          ? p
          : {
              ...p,
              entries: [...(p.entries ?? []), ...(res.data?.items ?? [])],
              nextCursor: res.data?.nextCursor ?? null,
              loadingMore: false,
            },
      );
    } catch (e) {
      setState((p) => ({
        ...p,
        loadingMore: false,
        error: e instanceof Error ? e.message : "Nie udało się pobrać historii",
      }));
    }
  };

  // Dane z poprzedniego wpisu nie mają prawa mrugnąć pod nowym nagłówkiem.
  const fresh = state.key === key;
  return {
    entries: fresh ? state.entries : null,
    error: fresh ? state.error : null,
    nextCursor: fresh ? state.nextCursor : null,
    loadingMore: state.loadingMore,
    loadMore,
  };
}

export function EntityHistory({
  entityType,
  entityId,
  period,
  title,
  variant = "icon",
  className,
  portal = null,
}: Props) {
  const { canView } = usePerms();
  const [open, setOpen] = useState(false);
  const { entries, error, nextCursor, loadingMore, loadMore } = useEntityHistory(
    entityType,
    entityId,
    period,
    open,
    portal,
  );
  const periodText = hrPeriodLabel(period ?? null);
  const heading = [title, periodText].filter(Boolean).join(" — ");

  /** „Pokaż więcej" — wspólne dla ikonki i sekcji. */
  const moreButton = nextCursor ? (
    <div className="px-4 pb-2 pt-1 text-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loadingMore}
        onClick={() => void loadMore()}
        data-testid="kadry-entity-history-more"
      >
        {loadingMore ? "Wczytywanie…" : "Pokaż więcej"}
      </Button>
    </div>
  ) : null;

  // Dziennik niesie kwoty wynagrodzeń — ma własny klucz uprawnień, ten sam, co
  // po stronie backendu (`guard()` w src/routes/hr-activity.ts). Bez niego nie
  // rysujemy ani ikonki, ani sekcji: klik kończyłby się 403.
  if (!portal && !canView("kadry/historia")) return null;

  if (variant === "section") {
    return (
      <Section
        id={`hr-history-${entityType}-${entityId}`}
        icon={History}
        title={`Historia${entries ? ` (${entries.length})` : ""}`}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      >
        {error ? (
          <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
        ) : entries === null ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Wczytywanie…
          </p>
        ) : (
          <>
            <Timeline entries={entries} />
            {moreButton}
          </>
        )}
      </Section>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        // 32 px — ta sama wysokość co `IconButton` w wierszu tabeli Kadr;
        // 28 px odstawało od ołówka i kosza obok.
        className={className ?? "h-8 w-8"}
        data-testid="kadry-entity-history"
        {...tip("Historia zmian")}
        aria-label="Historia zmian"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <History className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-lg"
          onClick={(e) => e.stopPropagation()}
          data-testid="kadry-entity-history-dialog"
        >
          <DialogHeader>
            <DialogTitle>Historia zmian</DialogTitle>
            <DialogDescription>{heading || "Wpis modułu Kadry"}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            {error ? (
              <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
            ) : entries === null ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                Wczytywanie…
              </p>
            ) : (
              <>
                <Timeline entries={entries} />
                {moreButton}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
