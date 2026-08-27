/**
 * Zapisane zestawy filtrów kalendarza — przycisk „Zestawy” + popover.
 *
 * Cały stan zestawów (lista, aktywny, tryb zapisu/zmiany nazwy) żyje TUTAJ; strona
 * Calendar.tsx podaje tylko bieżące filtry (`current`) i callback `onApply`, więc
 * integracja to import + jeden blok w toolbarze.
 *
 * Zachowanie:
 *  - klik w zestaw → `onApply` (Calendar zapisuje filtry do `alfa.calendar.filters` jak dotąd),
 *  - „Zapisz bieżące jako…” — prompt INLINE w popoverze (nie window.prompt), z opcjonalnym
 *    zapisem widoku i weekendów,
 *  - „Nadpisz” — dla aktywnego zestawu (zachowuje to, co zestaw już zapisywał: widok/weekendy),
 *  - gwiazdka = domyślny; domyślny wczytuje się przy pierwszym wejściu w sesji, ale TYLKO gdy
 *    użytkownik nie ma jeszcze własnych filtrów w localStorage (nie nadpisujemy ręcznych ustawień),
 *  - aktywny zestaw + wskaźnik „zmieniony” (z „Przywróć”) — porównanie bieżących filtrów z zapisanymi;
 *    zdjęcie wszystkich filtrów („Wyczyść filtry”) zdejmuje też wskazanie aktywnego zestawu,
 *  - skrót klawiszowy: F.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark,
  BookmarkPlus,
  Check,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Star,
  Trash2,
  X,
} from "lucide-react";
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
import {
  CALENDAR_FILTER_SET_LIMIT,
  CALENDAR_FILTER_SET_NAME_MAX,
  calendarFilterSetsApi,
  type CalendarBilling,
  type CalendarEventStatus,
  type CalendarEventType,
  type CalendarFilterSet,
  type CalendarFilterSetFilters,
} from "@/lib/api";
import { BILLING_META, EVENT_STATUS_META, EVENT_TYPE_META, techShort } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

/** Klucz z Calendar.tsx — czytamy go tylko po to, by wiedzieć, czy user ma już własne filtry. */
const FILTERS_STORAGE_KEY = "alfa.calendar.filters";
/** Ostatnio użyty zestaw (żeby po F5 wskaźnik był poprawny). */
const ACTIVE_SET_STORAGE_KEY = "alfa.calendar.filterSet";
/** Strażnik „domyślny wczytany raz na sesję karty”. */
const AUTOLOAD_GUARD_KEY = "alfa.calendar.filterSet.autoloaded";

/** Widoki kalendarza — etykiety do skrótu zestawu (klucze jak VIEWS w Calendar.tsx). */
const VIEW_LABELS: Record<string, string> = {
  dayGridMonth: "Miesiąc",
  timeGridWeek: "Tydzień",
  timeGridDay: "Dzień",
  listWeek: "Lista",
  board: "Tablica",
};

const TRISTATE_LABELS: Record<string, { with: string; without: string }> = {
  protocol: { with: "z protokołem", without: "bez protokołu" },
  realization: { with: "z realizacją", without: "bez realizacji" },
};

/** Bieżący stan filtrów kalendarza (widok i weekendy zawsze podane — zapis jest opcjonalny). */
export interface CurrentCalendarFilters {
  types: CalendarEventType[];
  statuses: CalendarEventStatus[];
  billings: (CalendarBilling | "none")[];
  technicianIds: number[];
  protocol: "" | "with" | "without";
  realization: "" | "with" | "without";
  view: string;
  weekends: boolean;
}

export interface FilterSetsProps {
  current: CurrentCalendarFilters;
  /** Wczytanie zestawu — Calendar ustawia stan filtrów (i opcjonalnie widok/weekendy). */
  onApply: (filters: CalendarFilterSetFilters) => void;
  technicians: { id: number; firstName: string; lastName: string }[];
  className?: string;
}

type Sortable = string | number;
const sorted = <T extends Sortable>(a: readonly T[] | undefined): T[] =>
  [...(a ?? [])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/** Kanoniczna postać samych filtrów (bez widoku/weekendów) — do porównań. */
const filtersKey = (f: Partial<CalendarFilterSetFilters>): string =>
  JSON.stringify({
    types: sorted(f.types),
    statuses: sorted(f.statuses),
    billings: sorted(f.billings),
    technicianIds: sorted(f.technicianIds),
    protocol: f.protocol ?? "",
    realization: f.realization ?? "",
  });

const EMPTY_KEY = filtersKey({});
const isEmptyFilters = (f: Partial<CalendarFilterSetFilters>) => filtersKey(f) === EMPTY_KEY;

/** Czy bieżące filtry są dokładnie tym, co zapisano w zestawie (widok/weekendy tylko jeśli zapisane). */
function matchesCurrent(set: CalendarFilterSet, current: CurrentCalendarFilters): boolean {
  if (filtersKey(set.filters) !== filtersKey(current)) return false;
  if (set.filters.view !== undefined && set.filters.view !== current.view) return false;
  if (set.filters.weekends !== undefined && set.filters.weekends !== current.weekends) return false;
  return true;
}

const joinMax = (items: string[], max = 2): string =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max}`;

/** Druga linia w wierszu listy: „Serwis, Montaż · Zaplanowane · JK, AB · Miesiąc”. */
function describeFilters(
  f: CalendarFilterSetFilters,
  technicians: { id: number; firstName: string; lastName: string }[]
): string {
  const parts: string[] = [];
  if (f.types?.length) parts.push(joinMax(f.types.map((t) => EVENT_TYPE_META[t]?.label ?? t)));
  if (f.statuses?.length) parts.push(joinMax(f.statuses.map((s) => EVENT_STATUS_META[s]?.label ?? s)));
  if (f.billings?.length)
    parts.push(joinMax(f.billings.map((b) => (b === "none" ? "bez rozliczenia" : BILLING_META[b]?.label ?? b))));
  if (f.technicianIds?.length) {
    const names = f.technicianIds.map((id) => {
      const t = technicians.find((x) => x.id === id);
      return t ? techShort(t) : `#${id}`;
    });
    parts.push(joinMax(names));
  }
  if (f.protocol) parts.push(TRISTATE_LABELS.protocol[f.protocol]);
  if (f.realization) parts.push(TRISTATE_LABELS.realization[f.realization]);
  if (f.view) parts.push(VIEW_LABELS[f.view] ?? f.view);
  if (f.weekends !== undefined) parts.push(f.weekends ? "z weekendami" : "bez weekendów");
  return parts.length ? parts.join(" · ") : "bez filtrów";
}

/** Czy w tym załadowaniu strony podjęto już decyzję o wczytaniu domyślnego zestawu. */
let autoloadHandled = false;

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
};

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeActiveId(id: number | null) {
  try {
    if (id == null) window.localStorage.removeItem(ACTIVE_SET_STORAGE_KEY);
    else window.localStorage.setItem(ACTIVE_SET_STORAGE_KEY, String(id));
  } catch {
    /* prywatny tryb — ignoruj */
  }
}

export function FilterSets({ current, onApply, technicians, className }: FilterSetsProps) {
  const [sets, setSets] = useState<CalendarFilterSet[]>([]);
  const [activeId, setActiveId] = useState<number | null>(() => {
    const raw = readStored(ACTIVE_SET_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null); // null = formularz zamknięty
  const [saveView, setSaveView] = useState(false);
  const [saveWeekends, setSaveWeekends] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CalendarFilterSet | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // onApply w refie — auto-wczytanie domyślnego (efekt montażu) nie ma zależeć od tożsamości callbacka.
  const onApplyRef = useRef(onApply);
  useEffect(() => {
    onApplyRef.current = onApply;
  }, [onApply]);

  const activeSet = useMemo(() => sets.find((s) => s.id === activeId) ?? null, [sets, activeId]);
  // „Wyczyść filtry” (albo ręczne zdjęcie wszystkiego) zdejmuje wskazanie aktywnego zestawu.
  const shown = activeSet && !(isEmptyFilters(current) && !isEmptyFilters(activeSet.filters)) ? activeSet : null;
  const dirty = !!shown && !matchesCurrent(shown, current);

  useEffect(() => {
    storeActiveId(shown?.id ?? null);
  }, [shown]);

  // Pierwsze wczytanie listy + ewentualne zastosowanie domyślnego zestawu.
  useEffect(() => {
    let cancelled = false;
    // Stan localStorage sprzed montażu: brak filtrów = user nic nie ustawił.
    const hadFilters = !!readStored(FILTERS_STORAGE_KEY);
    const hadActive = !!readStored(ACTIVE_SET_STORAGE_KEY);
    calendarFilterSetsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const rows = res.data || [];
        setSets(rows);
        // Decyzję o domyślnym podejmujemy DOPIERO tutaj: StrictMode montuje efekty dwa razy,
        // a pierwszy przebieg jest anulowany — strażnik zdjęty za wcześnie zjadłby autoload.
        if (autoloadHandled) return;
        autoloadHandled = true;
        let already = true;
        try {
          already = window.sessionStorage.getItem(AUTOLOAD_GUARD_KEY) === "1";
          window.sessionStorage.setItem(AUTOLOAD_GUARD_KEY, "1");
        } catch {
          already = true;
        }
        if (already || hadFilters || hadActive) return;
        const def = rows.find((s) => s.isDefault);
        if (!def) return;
        onApplyRef.current(def.filters);
        setActiveId(def.id);
      })
      .catch(() => {
        /* brak uprawnień / offline — przycisk po prostu pokaże pustą listę */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pozycjonowanie popovera (styl bezpośrednio na elemencie — bez setState w efekcie).
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    const btn = btnRef.current;
    if (!el || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(400, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    el.style.width = `${w}px`;
    el.style.left = `${left}px`;
    el.style.top = `${r.bottom + 6}px`;
    el.style.maxHeight = `${Math.max(200, window.innerHeight - r.bottom - 16)}px`;
  }, [open, sets, saveName, renaming, error]);

  // Klik poza / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.("[role='alertdialog']")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirmDelete) return; // AlertDialog zamyka się sam
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, confirmDelete]);

  // Skrót „F” — otwiera/zamyka popover (nie w polach tekstowych, nie przy otwartym dialogu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (isTypingTarget(e.target)) return;
      if (!open && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const filtersOf = (withView: boolean, withWeekends: boolean): CalendarFilterSetFilters => ({
    types: current.types,
    statuses: current.statuses,
    billings: current.billings,
    technicianIds: current.technicianIds,
    protocol: current.protocol,
    realization: current.realization,
    ...(withView ? { view: current.view } : {}),
    ...(withWeekends ? { weekends: current.weekends } : {}),
  });

  /** Wspólna obsługa mutacji: blokada, komunikat błędu, odświeżenie listy. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać zmiany"));
    } finally {
      setBusy(false);
    }
  };

  const apply = (s: CalendarFilterSet) => {
    onApply(s.filters);
    setActiveId(s.id);
    setOpen(false);
  };

  const restore = () => {
    if (shown) onApply(shown.filters);
  };

  const openSaveForm = () => {
    setError(null);
    setSaveName(shown ? `${shown.name} (kopia)` : "");
    setSaveView(!!shown?.filters.view);
    setSaveWeekends(shown?.filters.weekends !== undefined);
    window.setTimeout(() => nameRef.current?.focus(), 0);
  };

  const submitSave = () =>
    run(async () => {
      const name = (saveName ?? "").trim();
      if (!name) {
        setError("Podaj nazwę zestawu");
        return;
      }
      const res = await calendarFilterSetsApi.create({
        name,
        filters: filtersOf(saveView, saveWeekends),
      });
      const row = res.data!;
      setSets((prev) => [...prev, row]);
      setActiveId(row.id);
      setSaveName(null);
    });

  const overwrite = () =>
    run(async () => {
      if (!shown) return;
      const res = await calendarFilterSetsApi.update(shown.id, {
        filters: filtersOf(shown.filters.view !== undefined, shown.filters.weekends !== undefined),
      });
      const row = res.data!;
      setSets((prev) => prev.map((s) => (s.id === row.id ? row : s)));
    });

  const submitRename = () =>
    run(async () => {
      if (!renaming) return;
      const name = renaming.name.trim();
      if (!name) {
        setError("Nazwa nie może być pusta");
        return;
      }
      const res = await calendarFilterSetsApi.update(renaming.id, { name });
      const row = res.data!;
      setSets((prev) => prev.map((s) => (s.id === row.id ? row : s)));
      setRenaming(null);
    });

  const makeDefault = (s: CalendarFilterSet) =>
    run(async () => {
      const res = await calendarFilterSetsApi.setDefault(s.id);
      setSets(res.data || []);
    });

  const doDelete = () =>
    run(async () => {
      if (!confirmDelete) return;
      await calendarFilterSetsApi.remove(confirmDelete.id);
      setSets((prev) => prev.filter((s) => s.id !== confirmDelete.id));
      if (activeId === confirmDelete.id) setActiveId(null);
      setConfirmDelete(null);
    });

  const atLimit = sets.length >= CALENDAR_FILTER_SET_LIMIT;

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Zestawy filtrów${shown ? `: ${shown.name}${dirty ? " (zmieniony)" : ""}` : ""}`}
        title="Zapisane zestawy filtrów (F)"
        className={cn(
          "inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8",
          shown && "border-primary/40 bg-primary/5"
        )}
        data-testid="filter-sets-toggle"
      >
        <Bookmark className={cn("h-4 w-4 shrink-0 text-muted-foreground", shown && "text-primary")} aria-hidden />
        <span className="hidden md:inline">Zestawy</span>
        {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />}
      </button>

      {shown && (
        <span
          className="hidden min-w-0 items-center gap-1 text-xs text-muted-foreground lg:inline-flex"
          data-testid="filter-sets-indicator"
        >
          <span className="min-w-0 max-w-[16rem] truncate">
            Zestaw: <span className="font-medium text-foreground">{shown.name}</span>
            {dirty && <span className="text-amber-600 dark:text-amber-400"> · zmieniony</span>}
          </span>
          {dirty && (
            <button
              type="button"
              onClick={restore}
              title={`Przywróć filtry zapisane w zestawie „${shown.name}”`}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="filter-sets-restore"
            >
              <RotateCcw className="h-3 w-3" aria-hidden /> Przywróć
            </button>
          )}
        </span>
      )}

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Zestawy filtrów"
            className="alfa-pop fixed z-[60] flex flex-col overflow-hidden rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl"
            data-testid="filter-sets-popover"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Zestawy filtrów
                <span className="ml-1 font-normal normal-case">
                  ({sets.length}/{CALENDAR_FILTER_SET_LIMIT})
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setOpen(false)}
                aria-label="Zamknij zestawy filtrów"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <ul className="min-h-0 flex-1 overflow-y-auto py-1">
              {sets.length === 0 && (
                <li className="px-3 py-3 text-xs text-muted-foreground">
                  Brak zapisanych zestawów. Ustaw filtry i kliknij „Zapisz bieżące jako…”.
                </li>
              )}
              {sets.map((s) => {
                const cur = s.id === shown?.id;
                return (
                  <li key={s.id} className="flex items-stretch gap-0.5 px-1">
                    {renaming?.id === s.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submitRename();
                        }}
                      >
                        <input
                          autoFocus
                          value={renaming.name}
                          maxLength={CALENDAR_FILTER_SET_NAME_MAX}
                          onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Nowa nazwa zestawu"
                        />
                        <Button type="submit" size="icon" className="h-8 w-8" disabled={busy} aria-label="Zapisz nazwę">
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setRenaming(null)}
                          aria-label="Anuluj zmianę nazwy"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => apply(s)}
                          className={cn(
                            "flex min-h-10 min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            cur && "bg-accent/60"
                          )}
                          data-testid="filter-set-item"
                        >
                          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                            {cur ? (
                              <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                            ) : s.isDefault ? (
                              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-hidden />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1">
                              <span className="min-w-0 truncate font-medium">{s.name}</span>
                              {cur && s.isDefault && (
                                <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" aria-hidden />
                              )}
                              {cur && dirty && (
                                <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">
                                  · zmieniony
                                </span>
                              )}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {describeFilters(s.filters, technicians)}
                            </span>
                          </span>
                        </button>
                        {cur && dirty && (
                          <button
                            type="button"
                            onClick={() => void overwrite()}
                            disabled={busy}
                            aria-label={`Nadpisz zestaw „${s.name}” bieżącymi filtrami`}
                            title="Nadpisz bieżącymi filtrami"
                            className="flex w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            data-testid="filter-set-overwrite"
                          >
                            <Save className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void makeDefault(s)}
                          disabled={busy || s.isDefault}
                          aria-label={`Ustaw „${s.name}” jako domyślny zestaw`}
                          title={s.isDefault ? "Domyślny zestaw" : "Ustaw jako domyślny"}
                          className={cn(
                            "flex w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            s.isDefault && "text-amber-500 disabled:opacity-100"
                          )}
                          data-testid="filter-set-default"
                        >
                          <Star className={cn("h-3.5 w-3.5", s.isDefault && "fill-amber-400")} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setRenaming({ id: s.id, name: s.name });
                          }}
                          aria-label={`Zmień nazwę zestawu „${s.name}”`}
                          title="Zmień nazwę"
                          className="flex w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid="filter-set-rename"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(s)}
                          aria-label={`Usuń zestaw „${s.name}”`}
                          title="Usuń zestaw"
                          className="flex w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid="filter-set-delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            {error && (
              <p className="border-t px-3 py-2 text-xs text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="border-t p-2">
              {saveName === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={openSaveForm}
                    disabled={atLimit}
                    title={
                      atLimit
                        ? `Limit ${CALENDAR_FILTER_SET_LIMIT} zestawów — usuń któryś, by dodać nowy`
                        : "Zapisz bieżącą kombinację filtrów pod nazwą"
                    }
                    data-testid="filter-sets-save-open"
                  >
                    <BookmarkPlus className="mr-1 h-3.5 w-3.5" aria-hidden /> Zapisz bieżące jako…
                  </Button>
                  {shown && dirty && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => void overwrite()}
                      disabled={busy}
                      title={`Nadpisz „${shown.name}” bieżącymi filtrami`}
                    >
                      <Save className="mr-1 h-3.5 w-3.5" aria-hidden /> Nadpisz „{shown.name}”
                    </Button>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Skrót: <kbd className="alfa-kbd">F</kbd>
                  </span>
                </div>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitSave();
                  }}
                >
                  <input
                    ref={nameRef}
                    value={saveName}
                    maxLength={CALENDAR_FILTER_SET_NAME_MAX}
                    placeholder="Nazwa zestawu, np. Serwisy Wojtka"
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setSaveName(null);
                      }
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Nazwa nowego zestawu filtrów"
                    data-testid="filter-sets-name"
                  />
                  <p className="text-[11px] text-muted-foreground">{describeFilters(filtersOf(saveView, saveWeekends), technicians)}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={saveView}
                        onChange={(e) => setSaveView(e.target.checked)}
                        className="h-3.5 w-3.5 accent-primary"
                        data-testid="filter-sets-save-view"
                      />
                      zapisz też widok ({VIEW_LABELS[current.view] ?? current.view})
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={saveWeekends}
                        onChange={(e) => setSaveWeekends(e.target.checked)}
                        className="h-3.5 w-3.5 accent-primary"
                        data-testid="filter-sets-save-weekends"
                      />
                      zapisz też weekendy ({current.weekends ? "widoczne" : "ukryte"})
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="submit" size="sm" className="h-8 text-xs" disabled={busy} data-testid="filter-sets-save">
                      {busy ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
                      )}
                      Zapisz
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setSaveName(null)}
                    >
                      Anuluj
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body
        )}

      <AlertDialog open={confirmDelete != null} onOpenChange={(o) => !o && !busy && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć zestaw filtrów?</AlertDialogTitle>
            <AlertDialogDescription>
              „{confirmDelete?.name}” zniknie z listy. Bieżące filtry kalendarza zostają bez zmian.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Anuluj</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void doDelete();
                }}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                )}
                Usuń
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
