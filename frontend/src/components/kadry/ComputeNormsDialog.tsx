// Okno „Wylicz z Kodeksu pracy" — normy etatu na dwanaście miesięcy roku.
//
// Do tej pory normę wpisywało się ręcznie, raz w roku, z kalendarza znalezionego
// w internecie: dwanaście liczb, a każda jest MIANOWNIKIEM stawki godzinowej,
// więc pomyłka o jedną pozycję przesuwa kwoty całego miesiąca. Art. 130 k.p.
// daje na to przepis (40 h × pełne tygodnie + 8 h × dni robocze wystające −
// 8 h za święto poza niedzielą), a jedyną jego zmienną są ŚWIĘTA.
//
// Dlatego okno pokazuje DWIE rzeczy naraz i w tej kolejności:
//  1. porównanie „wpisana vs wyliczona" z zaznaczeniem, co zapisać,
//  2. listę dni wolnych, z której wzięła się ta druga kolumna.
// Bez punktu 2 wynik byłby liczbą z nikąd — a użytkownik pytał wprost, co się
// stanie, gdy w trakcie roku dojdzie nowe święto. Może je tu dopisać i od razu
// widzi, którym miesiącom zmienił się wymiar (znacznik „nowy wynik").
//
// Zapis dotyka wyłącznie normy etatu. Norma zlecenia (158) jest ustaleniem
// firmowym, nie wynikiem z ustawy, więc okno jej nie rusza.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CalendarDays, Loader2, Plus, Scale, Trash2 } from "lucide-react";
import {
  applyHrComputedNorms,
  createHrHoliday,
  deleteHrHoliday,
  getHrComputedNorms,
  type HrComputedNormRow,
  type HrHoliday,
} from "@/lib/api";
import { MONTH_NAMES } from "./shared";
import {
  EmptyRow,
  IconButton,
  KadryBadge,
  RowActions,
  SectionHeading,
  TEXT_TONE,
  THEAD_CLS,
} from "./ui";
import { Th } from "./parts";

/** „16.09.2026” — data w oknie czyta się po polsku, nie po ISO. */
const datePl = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
};

/** Różnica ze znakiem: „+8”, „−8”, „—” gdy nie ma z czym porównywać. */
const diffLabel = (row: HrComputedNormRow): string => {
  if (row.diff == null) return "—";
  if (row.diff === 0) return "0";
  return row.diff > 0 ? `+${row.diff}` : `−${Math.abs(row.diff)}`;
};

export function ComputeNormsDialog({
  year,
  open,
  editable,
  onOpenChange,
  onApplied,
}: {
  year: number;
  open: boolean;
  /** Bez prawa edycji okno jest podglądem: bez zapisu i bez zmian w słowniku świąt. */
  editable: boolean;
  onOpenChange: (open: boolean) => void;
  /** Po zapisie: rodzic dociąga normy i przelicza miesiąc (maks godziny). */
  onApplied: () => void;
}) {
  const [months, setMonths] = useState<HrComputedNormRow[]>([]);
  const [holidays, setHolidays] = useState<HrHoliday[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  // Miesiące, którym wymiar zmienił się po ostatniej zmianie w słowniku świąt —
  // bez tego dopisanie dnia wolnego wyglądałoby na operację bez skutku.
  const [recomputed, setRecomputed] = useState<number[]>([]);
  const [newDate, setNewDate] = useState("");
  const [newName, setNewName] = useState("");
  const [addingHoliday, setAddingHoliday] = useState(false);
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const previousRef = useRef<Map<number, number> | null>(null);

  /**
   * `markChanges` = odświeżenie PO zmianie słownika (porównujemy z poprzednim
   * wynikiem). Przy pierwszym wczytaniu nie ma czego porównywać, a domyślne
   * zaznaczenie ustawia się tylko wtedy — inaczej dopisanie święta kasowałoby
   * ręczne odznaczenia użytkownika.
   */
  const load = useCallback(
    async (markChanges: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getHrComputedNorms(year);
        const data = res.data;
        if (!data) return;
        if (markChanges && previousRef.current) {
          const prev = previousRef.current;
          const changed = data.months.filter(
            (m) => prev.get(m.month) !== m.computed,
          );
          setRecomputed(changed.map((m) => m.month));
          // Miesiąc, któremu wymiar właśnie się zmienił, dopisujemy do
          // zaznaczenia: dopisanie święta po to się robi, żeby ten miesiąc
          // zapisać. Reszty zaznaczenia nie ruszamy — ręczne odznaczenia
          // użytkownika mają przetrwać odświeżenie.
          const toAdd = changed
            .filter((m) => m.differs && !m.closed)
            .map((m) => m.month);
          if (toAdd.length > 0) {
            setSelected((prevSel) => [
              ...prevSel,
              ...toAdd.filter((m) => !prevSel.includes(m)),
            ]);
          }
        } else {
          setRecomputed([]);
          setSelected(
            data.months.filter((m) => m.differs && !m.closed).map((m) => m.month),
          );
        }
        previousRef.current = new Map(data.months.map((m) => [m.month, m.computed]));
        setMonths(data.months);
        setHolidays(data.holidays);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Nie udało się wyliczyć norm",
        );
      } finally {
        setLoading(false);
      }
    },
    [year],
  );

  useEffect(() => {
    if (!open) return;
    previousRef.current = null;
    setMessage(null);
    setHolidayError(null);
    setNewDate("");
    setNewName("");
    void load(false);
  }, [open, load]);

  const byDate = useMemo(
    () => new Map(holidays.map((h) => [h.date, h])),
    [holidays],
  );

  const toggle = (month: number) =>
    setSelected((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month],
    );

  const selectable = months.filter((m) => !m.closed);
  const allSelected =
    selectable.length > 0 && selectable.every((m) => selected.includes(m.month));

  const addHoliday = async () => {
    if (!newDate || newName.trim().length < 2) {
      setHolidayError("Podaj datę i nazwę dnia wolnego");
      return;
    }
    setAddingHoliday(true);
    setHolidayError(null);
    try {
      await createHrHoliday({ date: newDate, name: newName.trim() });
      setNewDate("");
      setNewName("");
      await load(true);
    } catch (err) {
      setHolidayError(
        err instanceof Error ? err.message : "Nie udało się dodać święta",
      );
    } finally {
      setAddingHoliday(false);
    }
  };

  const removeHoliday = async (h: HrHoliday) => {
    setHolidayError(null);
    try {
      await deleteHrHoliday(h.id);
      await load(true);
    } catch (err) {
      setHolidayError(
        err instanceof Error ? err.message : "Nie udało się usunąć święta",
      );
    }
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await applyHrComputedNorms({ year, months: selected });
      setMessage(res.message ?? "Normy zapisane");
      const data = res.data;
      if (data) {
        previousRef.current = new Map(data.months.map((m) => [m.month, m.computed]));
        setMonths(data.months);
        setHolidays(data.holidays);
        setRecomputed([]);
        setSelected(
          data.months.filter((m) => m.differs && !m.closed).map((m) => m.month),
        );
      }
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się zapisać norm");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="kadry-normy-compute-dialog"
      >
        <DialogHeader>
          <DialogTitle>Wymiar czasu pracy z Kodeksu pracy — {year}</DialogTitle>
          <DialogDescription>
            Wymiar liczy się według artykułu 130 Kodeksu pracy: czterdzieści
            godzin za każdy pełny tydzień miesiąca, osiem godzin za każdy dzień od
            poniedziałku do piątku pozostały po pełnych tygodniach, minus osiem
            godzin za każde święto przypadające w dniu innym niż niedziela
            (święto w sobotę również obniża wymiar). Zapis zmienia wyłącznie
            normę dla umów o pracę — norma dla zleceń zostaje bez zmian.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-destructive" data-testid="kadry-normy-compute-error">
            {error}
          </p>
        )}
        {message && (
          <p
            className={cn("text-sm", TEXT_TONE.good)}
            role="status"
            data-testid="kadry-normy-compute-message"
          >
            {message}
          </p>
        )}

        {/* --- Porównanie dwunastu miesięcy --- */}
        <div className="space-y-2">
          <SectionHeading
            icon={Scale}
            title="Normy miesięcy"
            summary={
              loading
                ? "Liczenie…"
                : `${months.filter((m) => m.differs).length} z 12 różni się od wpisanej`
            }
            action={
              editable && selectable.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelected(allSelected ? [] : selectable.map((m) => m.month))
                  }
                  data-testid="kadry-normy-compute-toggle-all"
                >
                  {allSelected ? "Odznacz wszystkie" : "Zaznacz wszystkie"}
                </Button>
              ) : undefined
            }
          />
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead className={THEAD_CLS}>
                <tr>
                  <Th className="w-10" />
                  <Th tip={`Miesiąc roku ${year}`}>Miesiąc</Th>
                  <Th
                    className="text-right"
                    wrap
                    tip="Norma zapisana w zakładce Normy. Pusto = miesiąc nie ma własnego wpisu i liczy się z domyślnych 160 godzin"
                  >
                    Wpisana norma
                  </Th>
                  <Th
                    className="text-right"
                    wrap
                    tip="Wymiar wyliczony z artykułu 130 Kodeksu pracy dla świąt z listy poniżej"
                  >
                    Wyliczona norma
                  </Th>
                  <Th
                    className="text-right"
                    tip="Wyliczona minus wpisana — o tyle godzin zmieni się norma po zapisie"
                  >
                    Różnica
                  </Th>
                </tr>
              </thead>
              <tbody>
                {months.length === 0 && (
                  <EmptyRow
                    colSpan={5}
                    loading={loading}
                    icon={Scale}
                    title="Brak wyliczenia"
                    description="Nie udało się policzyć wymiaru czasu pracy dla tego roku."
                  />
                )}
                {months.map((m) => {
                  const checked = selected.includes(m.month);
                  const changedNow = recomputed.includes(m.month);
                  return (
                    <tr
                      key={m.month}
                      className={cn(
                        "border-b last:border-b-0",
                        changedNow && "bg-primary/5",
                      )}
                      data-testid={`kadry-normy-compute-row-${m.month}`}
                    >
                      <td className="px-3 py-2">
                        <span
                          {...(m.closed
                            ? tip(
                                "Miesiąc zamknięty — otwórz go ponownie w zakładce Wynagrodzenia, żeby zapisać normę",
                              )
                            : !editable
                              ? tip("Brak prawa edycji zakładki Normy")
                              : {})}
                          className="inline-flex"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={m.closed || !editable}
                            onCheckedChange={() => toggle(m.month)}
                            aria-label={`Zapisz normę — ${MONTH_NAMES[m.month - 1]}`}
                            data-testid={`kadry-normy-compute-check-${m.month}`}
                          />
                        </span>
                      </td>
                      <td className="px-3 py-2 font-medium">
                        {MONTH_NAMES[m.month - 1]}
                        {m.closed && (
                          <KadryBadge
                            tone="nieaktywny"
                            compact
                            className="ml-2 font-normal"
                            hint="Miesiąc zamknięty — zapis go pominie"
                          >
                            zamknięty
                          </KadryBadge>
                        )}
                        {changedNow && (
                          <KadryBadge
                            tone="info"
                            compact
                            className="ml-2 font-normal"
                            hint="Wymiar tego miesiąca zmienił się po ostatniej zmianie w liście świąt"
                          >
                            nowy wynik
                          </KadryBadge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.current == null ? (
                          <span
                            className="text-muted-foreground"
                            {...tip(
                              "Miesiąc nie ma zapisanej normy — liczy się domyślne 160 godzin",
                            )}
                          >
                            brak wpisu
                          </span>
                        ) : (
                          `${m.current} h`
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right font-medium tabular-nums"
                        {...tip(
                          `${m.fullWeeks} pełnych tygodni po 40 godzin + ${m.extraWorkdays} dni roboczych po 8 godzin = ${m.baseHours} godzin` +
                            (m.holidays.length > 0
                              ? `, minus ${m.holidays.length * 8} godzin za dni wolne: ${m.holidays
                                  .map(
                                    (d) =>
                                      `${datePl(d)} ${byDate.get(d)?.name ?? ""}`.trim(),
                                  )
                                  .join(", ")}`
                              : ", bez świąt obniżających wymiar"),
                        )}
                      >
                        {m.computed} h
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          m.diff != null && m.diff !== 0 && TEXT_TONE.warn,
                          m.diff === 0 && TEXT_TONE.muted,
                        )}
                      >
                        {diffLabel(m)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* --- Święta, z których wzięło się wyliczenie --- */}
        <div className="space-y-2">
          <SectionHeading
            icon={CalendarDays}
            title="Dni ustawowo wolne w roku"
            summary={`${holidays.length} dni, w tym ${holidays.filter((h) => h.reduces).length} obniżających wymiar`}
          />
          {holidayError && (
            <p
              className="text-sm text-destructive"
              data-testid="kadry-normy-holiday-error"
            >
              {holidayError}
            </p>
          )}
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead className={THEAD_CLS}>
                <tr>
                  <Th>Data</Th>
                  <Th>Dzień tygodnia</Th>
                  <Th>Nazwa</Th>
                  <Th>Pochodzenie</Th>
                  <Th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {holidays.length === 0 && (
                  <EmptyRow
                    colSpan={5}
                    loading={loading}
                    icon={CalendarDays}
                    title="Brak dni wolnych w tym roku"
                    description="Święta ustawowe zasieją się same przy pierwszym otwarciu roku."
                  />
                )}
                {holidays.map((h) => (
                  <tr
                    key={h.id}
                    className="group border-b last:border-b-0 hover:bg-accent/50"
                    data-testid={`kadry-normy-holiday-${h.date}`}
                  >
                    <td className="px-3 py-2 tabular-nums">{datePl(h.date)}</td>
                    <td
                      className={cn(
                        "px-3 py-2",
                        !h.reduces && "text-muted-foreground",
                      )}
                    >
                      {h.dayName}
                      {!h.reduces && (
                        <span
                          className="ml-2 text-xs"
                          {...tip(
                            "Święto w niedzielę nie obniża wymiaru czasu pracy — niedziela i tak jest dniem wolnym",
                          )}
                        >
                          bez wpływu na wymiar
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{h.name}</td>
                    <td className="px-3 py-2">
                      <KadryBadge
                        tone={h.source === "statutory" ? "info" : "pula"}
                        compact
                        hint={
                          h.source === "statutory"
                            ? "Święto z ustawy o dniach wolnych od pracy — wpisane automatycznie, nie da się go usunąć"
                            : "Dzień wolny dodany ręcznie w tym oknie"
                        }
                      >
                        {h.source === "statutory" ? "ustawowe" : "własne"}
                      </KadryBadge>
                    </td>
                    <td className="px-3 py-2">
                      <RowActions>
                        <IconButton
                          icon={Trash2}
                          danger
                          disabled={h.source === "statutory" || !editable}
                          label={
                            h.source === "statutory"
                              ? "Święta ustawowego nie można usunąć"
                              : !editable
                                ? "Brak prawa edycji zakładki Normy"
                                : `Usuń dzień wolny ${datePl(h.date)}`
                          }
                          onClick={() => void removeHoliday(h)}
                          testId={`kadry-normy-holiday-delete-${h.date}`}
                        />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {editable && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="kadry-normy-holiday-date"
                >
                  Data dnia wolnego
                </label>
                <Input
                  id="kadry-normy-holiday-date"
                  type="date"
                  className="h-9 w-40"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  data-testid="kadry-normy-holiday-date"
                />
              </div>
              <div className="space-y-1">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="kadry-normy-holiday-name"
                >
                  Nazwa dnia wolnego
                </label>
                <Input
                  id="kadry-normy-holiday-name"
                  className="h-9 w-64"
                  placeholder="np. Wigilia Bożego Narodzenia"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addHoliday();
                    }
                  }}
                  data-testid="kadry-normy-holiday-name"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                disabled={addingHoliday}
                onClick={() => void addHoliday()}
                {...tip(
                  "Dopisz dzień wolny — normy przeliczą się od razu, a miesiące ze zmienionym wymiarem dostaną znacznik",
                )}
                data-testid="kadry-normy-holiday-add"
              >
                {addingHoliday ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-4 w-4" />
                )}
                Dodaj święto
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Zamknij
          </Button>
          {editable && (
            <Button
              disabled={saving || loading || selected.length === 0}
              onClick={() => void apply()}
              data-testid="kadry-normy-compute-save"
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Zapisz wybrane ({selected.length})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
