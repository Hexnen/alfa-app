import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCog, Loader2, Play, RefreshCw, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  adminCalendarApi,
  backfillCount,
  type AdminCalendarBackfillResult,
  type AdminCalendarSettings,
  type AdminCalendarSettingsUpdate,
  type CalendarAutoRealization,
  type CalendarEventType,
  type CalendarSettingsField,
  type CalendarSettingsValues,
} from "@/lib/api";
import { EVENT_TYPE_META, EVENT_TYPE_ORDER, REALIZATION_TYPES } from "@/lib/calendar-labels";
import { ErrorBox, Field, SectionCard, Switch } from "@/components/admin-assistant/shared";
import { deepEq, errMsg, useFlash } from "@/components/admin-assistant/helpers";
import { cn } from "@/lib/utils";

/** Wartości używane, gdy backend jeszcze nie zwraca ustawień (kontrakt §1). */
const FALLBACK_VALUES: CalendarSettingsValues = {
  autoRealization: "on_create",
  realizationTypes: [...REALIZATION_TYPES],
  realizationSync: true,
};

const AUTO_OPTIONS: { key: CalendarAutoRealization; label: string; desc: string }[] = [
  {
    key: "on_create",
    label: "Przy zapisie wydarzenia",
    desc: "Realizacja (i szkic protokołu) powstaje od razu po utworzeniu wydarzenia objętego typu.",
  },
  {
    key: "on_done",
    label: "Po oznaczeniu jako wykonane",
    desc: "Wydarzenie planowane nie tworzy nic; realizacja powstaje dopiero przy statusie „wykonane”.",
  },
  {
    key: "off",
    label: "Nigdy (tylko ręcznie)",
    desc: "Automat wyłączony — realizację podpina się ręcznie w dialogu wydarzenia.",
  },
];

type Draft = Partial<CalendarSettingsValues>;

/**
 * Administracja → Kalendarz. Na razie jedna sekcja: reguły tworzenia realizacji
 * z wydarzeń kalendarza + narzędzie „Uzupełnij zaległe” (backfill).
 * Wzorzec strony (szkic → sticky pasek zapisu → sekcje) jak w AdminAssistant.
 */
export function AdminCalendar() {
  const [settings, setSettings] = useState<AdminCalendarSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, flash] = useFlash();

  // Backfill
  const [from, setFrom] = useState("");
  const [backfillBusy, setBackfillBusy] = useState<"dry" | "apply" | null>(null);
  const [backfill, setBackfill] = useState<AdminCalendarBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const load = useCallback(async () => {
    const s = await adminCalendarApi.settings();
    setSettings(s);
    setDraft({});
  }, []);

  useEffect(() => {
    load().catch((e) => setLoadError(errMsg(e, "Nie udało się wczytać ustawień kalendarza")));
  }, [load]);

  const values: CalendarSettingsValues = useMemo(
    () => ({ ...FALLBACK_VALUES, ...(settings?.values ?? {}) }),
    [settings]
  );
  const val = <K extends CalendarSettingsField>(k: K): CalendarSettingsValues[K] =>
    (k in draft ? draft[k] : values[k]) as CalendarSettingsValues[K];
  const setField = <K extends CalendarSettingsField>(k: K, v: CalendarSettingsValues[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (deepEq(values[k], v)) delete next[k];
      else (next as Record<K, CalendarSettingsValues[K]>)[k] = v;
      return next;
    });
  const isDirty = (k: CalendarSettingsField) => k in draft;
  const dirtyCount = Object.keys(draft).length;
  const source = (k: CalendarSettingsField) => settings?.sources?.[k];

  const typesValue = val("realizationTypes");
  const toggleType = (t: CalendarEventType) =>
    setField(
      "realizationTypes",
      typesValue.includes(t) ? typesValue.filter((x) => x !== t) : [...typesValue, t]
    );

  // Ostrzeżenie przeglądarki przy wyjściu z niezapisanymi zmianami.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const save = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      const s = await adminCalendarApi.updateSettings(draft as AdminCalendarSettingsUpdate);
      setSettings(s);
      setDraft({});
      flash("Ustawienia zapisane.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać ustawień"));
    } finally {
      setSaving(false);
    }
  };

  const runBackfill = async (dryRun: boolean) => {
    setBackfillBusy(dryRun ? "dry" : "apply");
    setBackfillError(null);
    try {
      const res = await adminCalendarApi.backfillRealizations({
        dryRun,
        from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
      });
      setBackfill(res);
      if (!dryRun) flash(`Utworzono realizacje: ${backfillCount(res.created)}.`);
    } catch (e) {
      setBackfill(null);
      setBackfillError(errMsg(e, "Nie udało się uruchomić uzupełniania"));
    } finally {
      setBackfillBusy(null);
      setConfirmApply(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <ErrorBox>{loadError}</ErrorBox>
        <Button
          variant="outline"
          onClick={() =>
            load()
              .then(() => setLoadError(null))
              .catch((e) => setLoadError(errMsg(e, "Błąd")))
          }
        >
          <RefreshCw className="mr-1 h-4 w-4" /> Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie ustawień…
        </div>
      </div>
    );
  }

  const auto = val("autoRealization");
  const candidates = backfill ? backfillCount(backfill.candidates) : 0;
  /** Typy do wyboru: z backendu (meta.allowedTypes) albo wszystkie poza urlopem. */
  const allowedTypes = settings.meta?.allowedTypes?.length
    ? settings.meta.allowedTypes
    : EVENT_TYPE_ORDER.filter((t) => t !== "urlop");

  return (
    <div className="space-y-6 pb-24">
      <PageHeader />

      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && (
        <div
          className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
          role="status"
        >
          {notice}
        </div>
      )}

      <SectionCard
        id="realizacje"
        title="Realizacje z kalendarza"
        description="Wydarzenia serwisowe automatycznie trafiają do rejestru Realizacji (i dostają szkic protokołu). Zmiany działają od razu — bez restartu."
      >
        <Field
          id="cal-auto-realization"
          label="Kiedy powstaje realizacja"
          source={source("autoRealization")}
          dirty={isDirty("autoRealization")}
        >
          <div className="space-y-2" role="radiogroup" aria-label="Kiedy powstaje realizacja">
            {AUTO_OPTIONS.map((o) => {
              const active = auto === o.key;
              return (
                <label
                  key={o.key}
                  data-testid={`auto-realization-${o.key}`}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
                    active ? "border-primary bg-primary/5" : "hover:bg-accent/40"
                  )}
                >
                  <input
                    type="radio"
                    name="autoRealization"
                    className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={active}
                    onChange={() => setField("autoRealization", o.key)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </Field>

        <Field
          id="cal-realization-types"
          label="Typy wydarzeń objęte automatem"
          source={source("realizationTypes")}
          dirty={isDirty("realizationTypes")}
          description="Urlop nigdy nie tworzy realizacji. Biuro i przygotowanie są odznaczone domyślnie — to prace bez rozliczenia."
        >
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {allowedTypes.map((t) => {
              const meta = EVENT_TYPE_META[t];
              if (!meta) return null;
              const Icon = meta.icon;
              const checked = typesValue.includes(t);
              return (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleType(t)}
                    aria-label={meta.label}
                    data-testid={`realization-type-${t}`}
                  />
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {meta.label}
                </label>
              );
            })}
          </div>
        </Field>

        <Field
          id="cal-realization-sync"
          label="Synchronizuj zmiany wydarzenia z realizacją"
          source={source("realizationSync")}
          dirty={isDirty("realizationSync")}
          description="Data, obiekt, rodzaj, wykonawcy i godziny wędrują z wydarzenia do realizacji. Kwoty i rabat pozostają nietknięte, a realizacje zafakturowane są pomijane."
          inline
        >
          <Switch
            id="cal-realization-sync"
            checked={val("realizationSync")}
            onChange={(v) => setField("realizationSync", v)}
            label="Synchronizuj zmiany wydarzenia z realizacją"
          />
        </Field>

        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Zasady, których automat nie łamie</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Kwoty (robocizna, materiały, KM, rabat) ustawiasz wyłącznie w module Realizacje.</li>
            <li>Realizacja zafakturowana nie jest już aktualizowana — zmiana wydarzenia trafia tylko do historii.</li>
            <li>Anulowanie wydarzenia usuwa realizację tylko wtedy, gdy jest pusta i nierozliczona.</li>
            <li>Jedno wydarzenie ↔ jedna realizacja; podpięcie zajętej realizacji zostanie odrzucone.</li>
          </ul>
        </div>
      </SectionCard>

      <SectionCard
        id="backfill"
        title="Uzupełnij zaległe"
        description="Tworzy realizacje dla wcześniejszych wydarzeń objętych typów, które jeszcze ich nie mają. Zacznij od podglądu."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cal-backfill-from" className="text-sm font-medium">
              Od daty (opcjonalnie)
            </Label>
            <Input
              id="cal-backfill-from"
              type="date"
              value={from}
              className="w-44"
              data-testid="backfill-from"
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            data-testid="backfill-dry"
            disabled={backfillBusy != null}
            onClick={() => void runBackfill(true)}
          >
            {backfillBusy === "dry" ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-1 h-4 w-4" />
            )}
            Podgląd (bez zapisu)
          </Button>
          <Button
            type="button"
            data-testid="backfill-apply"
            disabled={backfillBusy != null || !backfill || candidates === 0}
            onClick={() => setConfirmApply(true)}
            title={backfill ? undefined : "Najpierw uruchom podgląd"}
          >
            <Play className="mr-1 h-4 w-4" /> Utwórz realizacje
          </Button>
        </div>

        {backfillError && <ErrorBox>{backfillError}</ErrorBox>}
        {backfill && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="backfill-result">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Kandydaci: <strong className="tabular-nums">{candidates}</strong>
              </span>
              {backfill.created != null && (
                <span>
                  Utworzono: <strong className="tabular-nums">{backfillCount(backfill.created)}</strong>
                </span>
              )}
              <span className="text-muted-foreground">
                Pominięte: <span className="tabular-nums">{backfillCount(backfill.skipped)}</span>
              </span>
            </div>
            {Array.isArray(backfill.candidates) && backfill.candidates.length > 0 && (
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {backfill.candidates.map((it) => (
                  <li key={it.eventId} className="truncate">
                    <span className="tabular-nums">{it.startAt.slice(0, 10)}</span> · {it.title}
                    {it.site ? ` · ${it.site}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SectionCard>

      {dirtyCount > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:left-64"
          role="region"
          aria-label="Niezapisane zmiany"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">Niezapisane zmiany</span>{" "}
              <span className="text-muted-foreground">
                ({dirtyCount} {dirtyCount === 1 ? "pole" : dirtyCount < 5 ? "pola" : "pól"})
              </span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft({})} disabled={saving}>
                Odrzuć
              </Button>
              <Button type="button" data-testid="calendar-settings-save" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Zapisz
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmApply} onOpenChange={(o) => !o && setConfirmApply(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Utworzyć {candidates} realizacji?</AlertDialogTitle>
            <AlertDialogDescription>
              Dla każdego wydarzenia powstanie realizacja z zerowymi kwotami oraz szkic protokołu. Operacji nie da się
              cofnąć jednym kliknięciem — istniejące realizacje nie zostaną ruszone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runBackfill(false)}>Utwórz</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <CalendarCog className="h-6 w-6" /> Kalendarz
      </h1>
      <p className="text-sm text-muted-foreground">
        Reguły przenoszenia wydarzeń kalendarza do rejestru Realizacji: kiedy realizacja powstaje, jakich typów dotyczy i
        czy edycja wydarzenia ją aktualizuje.
      </p>
    </div>
  );
}
