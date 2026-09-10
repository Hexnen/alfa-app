/**
 * Aktywności handlowca — „co mam dziś zrobić i czego nie zrobiłem".
 *
 * To nie jest drugi kalendarz, tylko lista zadań zbudowana na tych samych
 * danych: jedno zapytanie o szeroki zakres (−90 / +60 dni) i podział na kubełki
 * po stronie klienta (`splitActivities`). Dzięki temu przełączenie „Moje /
 * Wszyscy" albo filtra typu nie wymaga kolejnej rundy do backendu.
 *
 * Wydarzenie otwiera ten sam `CalendarEventDialog`, co kalendarz — z
 * `config={SALES_CALENDAR}`, więc dostajemy notatki, załączniki, serie i sekcję
 * „Szansa i kontakt" bez linijki kodu tutaj.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ListTodo, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  CalendarEventDialog,
  type CalendarDialogMode,
  type CalendarEventPrefill,
} from "@/components/CalendarEventDialog";
import {
  ActivityList,
  splitActivities,
  type ActivityGroup,
} from "@/components/sales/ActivityList";
import { SalesScopeToggle, useSalesScope } from "@/components/sales/SalesScopeToggle";
import { calendarApi, type CalendarEvent, type CalendarEventType } from "@/lib/api";
import { SALES_CALENDAR } from "@/lib/calendar-config";
import { DEPARTMENT_TYPE_ORDER, EVENT_TYPE_META, toDateStr } from "@/lib/calendar-labels";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Ile dni wstecz i w przód ciągniemy jednym zapytaniem (§5.7 planu). */
const PAST_DAYS = 90;
const FUTURE_DAYS = 60;

const shift = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateStr(d);
};

const SECTIONS: { key: Exclude<ActivityGroup, "done">; title: string; hint: string }[] = [
  { key: "overdue", title: "Zaległe", hint: "Termin minął, a status wciąż nie jest „wykonane”" },
  { key: "today", title: "Dziś", hint: "Zaplanowane na dzisiaj (i trwające od wcześniej)" },
  { key: "upcoming", title: "Nadchodzące", hint: "Najbliższe 7 dni" },
];

export function HandlowyAktywnosci() {
  const { canEdit } = usePerms();
  // Edycję wydarzeń handlowych daje kalendarz ALBO leady — dokładnie ta sama
  // reguła, co po stronie backendu (`canEditDepartment`).
  const editable = SALES_CALENDAR.editTabs.some((t) => canEdit(t));
  const { scope, setScope, salespersonId, hidden: scopeHidden } = useSalesScope();

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<Set<CalendarEventType>>(new Set());
  const [tab, setTab] = useState<"todo" | "done">("todo");

  // --- Dialog wydarzenia (ten sam mechanizm co w kalendarzu: nonce = remount) ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<CalendarDialogMode>("create");
  const [dialogEvent, setDialogEvent] = useState<CalendarEvent | null>(null);
  const [dialogPrefill, setDialogPrefill] = useState<CalendarEventPrefill | null>(null);
  const [dialogNonce, setDialogNonce] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await calendarApi.getEvents({
        department: "handlowy",
        from: shift(-PAST_DAYS),
        to: shift(FUTURE_DAYS),
        ...(scope === "mine" && salespersonId != null ? { salespersonId: [salespersonId] } : {}),
      });
      setEvents(res.data ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nie udało się wczytać aktywności.");
    } finally {
      setLoading(false);
    }
  }, [scope, salespersonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => (typeFilter.size ? events.filter((e) => typeFilter.has(e.type)) : events),
    [events, typeFilter]
  );
  const buckets = useMemo(() => splitActivities(filtered), [filtered]);

  const openCreate = useCallback(
    (prefill?: CalendarEventPrefill) => {
      if (!editable) return;
      setDialogMode("create");
      setDialogEvent(null);
      setDialogPrefill(prefill ?? null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  const openEvent = useCallback(
    (ev: CalendarEvent) => {
      setDialogMode(editable && !ev.deletedAt ? "edit" : "view");
      setDialogEvent(ev);
      setDialogPrefill(null);
      setDialogNonce((n) => n + 1);
      setDialogOpen(true);
    },
    [editable]
  );

  const toggleType = (t: CalendarEventType) =>
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const rowActions = editable
    ? { onDone: () => void load(), onPostpone: () => void load() }
    : {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Aktywności</h1>
          <p className="text-sm text-muted-foreground">
            Zaległe, dzisiejsze i nadchodzące zadania handlowca
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!scopeHidden && <SalesScopeToggle value={scope} onChange={setScope} />}
          <Button
            variant="outline"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            {...tip("Odśwież listę")}
            data-testid="aktywnosci-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            <span className="sr-only">Odśwież</span>
          </Button>
          {editable && (
            <Button onClick={() => openCreate()} data-testid="aktywnosci-new">
              <Plus className="mr-2 h-4 w-4" />
              Nowa aktywność
            </Button>
          )}
        </div>
      </div>

      {!editable && <ReadOnlyBanner />}

      {/* Chipy typów — lista działu handlowego, nigdy pełne EVENT_TYPE_ORDER. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtr typów aktywności">
        {DEPARTMENT_TYPE_ORDER.handlowy.map((t) => {
          const m = EVENT_TYPE_META[t];
          const active = typeFilter.has(t);
          const Icon = m.icon;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={active}
              data-testid={`aktywnosci-filter-type-${t}`}
              onClick={() => toggleType(t)}
              {...tip(active ? `Ukryj: ${m.label}` : `${typeFilter.size === 0 ? "Pokaż tylko" : "Pokaż też"}: ${m.label}`)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? cn(m.chipActive, "shadow-sm")
                  : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {m.label}
            </button>
          );
        })}
        {typeFilter.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTypeFilter(new Set())}
            data-testid="aktywnosci-filters-clear"
          >
            Wyczyść filtry
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="aktywnosci-error">
          {error}
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "todo" | "done")}>
        <TabsList>
          <TabsTrigger value="todo" data-testid="aktywnosci-tab-todo">
            Do zrobienia ({buckets.overdue.length + buckets.today.length + buckets.upcoming.length})
          </TabsTrigger>
          <TabsTrigger value="done" data-testid="aktywnosci-tab-done">
            Wykonane ({buckets.done.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "todo" ? (
        <div className="space-y-5">
          {SECTIONS.map((s) => (
            <section key={s.key} className="space-y-2" data-testid={`aktywnosci-section-${s.key}`}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground" {...tip(s.hint)}>
                {s.title}
                <span className="ml-1.5 font-normal normal-case tracking-normal">({buckets[s.key].length})</span>
              </h2>
              <ActivityList
                events={buckets[s.key]}
                grouping={s.key}
                onOpen={openEvent}
                {...rowActions}
                testIdPrefix={`aktywnosci-${s.key}`}
              />
            </section>
          ))}
        </div>
      ) : (
        <section className="space-y-2" data-testid="aktywnosci-section-done">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Wykonane w ostatnich 30 dniach
            <span className="ml-1.5 font-normal normal-case tracking-normal">({buckets.done.length})</span>
          </h2>
          <ActivityList
            events={buckets.done}
            grouping="done"
            onOpen={openEvent}
            testIdPrefix="aktywnosci-done"
          />
        </section>
      )}

      {!loading && events.length === 0 && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListTodo className="h-4 w-4" aria-hidden />
          Brak aktywności w zakresie ostatnich {PAST_DAYS} i najbliższych {FUTURE_DAYS} dni.
        </p>
      )}

      <CalendarEventDialog
        key={dialogNonce}
        config={SALES_CALENDAR}
        open={dialogOpen}
        mode={dialogMode}
        event={dialogEvent}
        prefill={dialogPrefill}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
        onDeleted={() => void load()}
        onPlanNext={(prefill) => {
          setDialogOpen(false);
          openCreate(prefill);
        }}
      />
    </div>
  );
}
