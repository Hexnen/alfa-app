// Podzakładka Kadry → Normy: normy godzin na 12 miesięcy roku.
//
// Dwie zmiany względem pierwszej wersji:
//  • dwanaście przycisków „Zapisz" zastąpił autozapis po wyjściu z pola
//    (ptaszek jak w edycji inline godzin) — norma to jedna liczba, a nie
//    formularz, więc osobne zatwierdzanie było ceremonią bez treści,
//  • nawigacja chodzi po ROKU, nie po miesiącu: tabela i tak pokazuje cały
//    rok, a przełącznik miesiąca sugerował, że zmienia to, co widać.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Scale,
  TriangleAlert,
} from "lucide-react";
import {
  getHrComputedNorms,
  getHrNorms,
  saveHrNorm,
  type HrMonthNorm,
} from "@/lib/api";
import { tip } from "@/components/ui/tooltip";
import { Th } from "./parts";
import {
  KadryBadge,
  TEXT_TONE,
  THEAD_CLS,
  TOOLBAR_BTN_CLS,
  TOOLBAR_ICON_BTN_CLS,
} from "./ui";
import { MONTH_NAMES } from "./shared";
import { ComputeNormsDialog } from "./ComputeNormsDialog";
import { KadryHelp } from "./KadryHelp";

type NormField = "workNorm" | "contractNorm";

export function NormsTab({
  year,
  month,
  norms,
  editable,
  onYearChange,
  onSaved,
}: {
  year: number;
  /** Bieżący miesiąc modułu — jego wiersz jest podświetlony. */
  month: number;
  norms: HrMonthNorm[];
  editable: boolean;
  onYearChange: (year: number) => void;
  /** Po zapisie: rodzic dociąga normy i przelicza miesiąc (maks godziny). */
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [computeOpen, setComputeOpen] = useState(false);
  // Wymiar z Kodeksu pracy dla każdego miesiąca — tabela sama z siebie nie
  // powie, że wpisane 176 h to pomyłka. Wczytywany w tle; gdy się nie uda,
  // znaczników po prostu nie ma i nic się nie psuje.
  const [computed, setComputed] = useState<Record<number, number>>({});
  const skipBlurRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
    },
    [],
  );
  // Zmiana roku czyści brudnopisy — inaczej wartość wpisana w 2026 pokazałaby
  // się w wierszu 2025 (klucz brudnopisu to sam miesiąc).
  useEffect(() => {
    setDrafts({});
    setErrors({});
  }, [year]);

  const loadComputed = useCallback(() => {
    let cancelled = false;
    void getHrComputedNorms(year)
      .then((res) => {
        if (cancelled || !res.data) return;
        setComputed(
          Object.fromEntries(res.data.months.map((m) => [m.month, m.computed])),
        );
      })
      .catch(() => {
        if (!cancelled) setComputed({});
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  useEffect(() => loadComputed(), [loadComputed]);

  const key = (m: number, field: NormField) => `${m}:${field}`;

  const stored = (m: number, field: NormField) => {
    const row = norms.find((n) => n.month === m);
    return row ? String(row[field]) : "";
  };

  const shown = (m: number, field: NormField) =>
    drafts[key(m, field)] ?? stored(m, field);

  /**
   * Zapis JEDNEJ komórki. Endpoint przyjmuje obie normy naraz, więc drugą
   * dokładamy z ekranu (brudnopis albo zapisana wartość) — inaczej wpisanie
   * normy pracy zerowałoby normę zlecenia.
   */
  const commit = async (m: number, field: NormField, value: string) => {
    const k = key(m, field);
    if (value.trim() === stored(m, field).trim()) {
      setDrafts((p) => {
        const next = { ...p };
        delete next[k];
        return next;
      });
      return;
    }
    const other: NormField = field === "workNorm" ? "contractNorm" : "workNorm";
    const payload = {
      year,
      month: m,
      workNorm: field === "workNorm" ? value : shown(m, other),
      contractNorm: field === "contractNorm" ? value : shown(m, other),
    };
    setSaving((p) => ({ ...p, [k]: true }));
    setErrors((p) => {
      const next = { ...p };
      delete next[k];
      return next;
    });
    try {
      await saveHrNorm(payload);
      setDrafts((p) => {
        const next = { ...p };
        delete next[k];
        return next;
      });
      setSavedAt((p) => ({ ...p, [k]: Date.now() }));
      timersRef.current.push(
        window.setTimeout(
          () =>
            setSavedAt((p) => {
              const next = { ...p };
              delete next[k];
              return next;
            }),
          2000,
        ),
      );
      onSaved();
    } catch (err) {
      setErrors((p) => ({
        ...p,
        [k]: err instanceof Error ? err.message : "Błąd zapisu normy",
      }));
    } finally {
      setSaving((p) => {
        const next = { ...p };
        delete next[k];
        return next;
      });
    }
  };

  /**
   * Rok bez norm liczy się z wartości domyślnych (160/158) — a te prawie nigdy
   * nie są prawdziwe dla wszystkich dwunastu miesięcy. Przepisywanie 24 liczb
   * z poprzedniego roku ręcznie było pierwszą rzeczą w styczniu.
   */
  const copyPrevYear = async () => {
    setCopying(true);
    setCopyError(null);
    try {
      const prev = await getHrNorms(year - 1);
      const rows = prev.data ?? [];
      if (rows.length === 0) {
        setCopyError(`Rok ${year - 1} też nie ma zapisanych norm`);
        return;
      }
      for (const r of rows) {
        await saveHrNorm({
          year,
          month: r.month,
          workNorm: r.workNorm,
          contractNorm: r.contractNorm,
        });
      }
      onSaved();
    } catch (err) {
      setCopyError(
        err instanceof Error ? err.message : "Nie udało się skopiować norm",
      );
    } finally {
      setCopying(false);
    }
  };

  const status = (k: string) => {
    if (saving[k])
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    // Ptaszek „zapisano" w tym samym zielonym co `InlineSavedTick` — z wariantem
    // ciemnym, bo goły `text-emerald-600` gaśnie w ciemnym motywie. Bez podpisu,
    // bo mieści się w 16 px obok pola; znaczenie niesie `aria-label`.
    if (savedAt[k])
      return (
        <Check
          className={cn("h-4 w-4", TEXT_TONE.good)}
          role="status"
          aria-label="Zapisano"
        />
      );
    return null;
  };

  const cell = (m: number, field: NormField, placeholder: string) => {
    const k = key(m, field);
    return (
      <td className="px-3 py-2 text-right align-top">
        <div className="flex items-center justify-end gap-1">
          <Input
            className={cn(
              "h-8 w-24 text-right tabular-nums",
              errors[k] && "border-destructive",
            )}
            inputMode="decimal"
            readOnly={!editable}
            data-testid={`kadry-normy-${field}-${m}`}
            value={shown(m, field)}
            onChange={(e) =>
              setDrafts((p) => ({ ...p, [k]: e.target.value }))
            }
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (!editable) return;
              if (skipBlurRef.current === k) {
                skipBlurRef.current = null;
                return;
              }
              void commit(m, field, e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                skipBlurRef.current = k;
                setDrafts((p) => {
                  const next = { ...p };
                  delete next[k];
                  return next;
                });
                e.currentTarget.blur();
              }
            }}
            placeholder={placeholder}
          />
          <span className="w-4">{status(k)}</span>
        </div>
        {errors[k] && (
          <p className="text-right text-[11px] text-destructive">{errors[k]}</p>
        )}
      </td>
    );
  };

  const now = new Date();

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* Nawigacja po roku — tabela pokazuje cały rok, więc przełącznik
            miesiąca nie miał tu czym sterować. */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className={TOOLBAR_ICON_BTN_CLS}
            onClick={() => onYearChange(year - 1)}
            aria-label="Poprzedni rok"
            {...tip(`Pokaż normy roku ${year - 1}`)}
            data-testid="kadry-normy-year-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[90px] text-center font-medium tabular-nums">
            {year}
          </span>
          <Button
            variant="outline"
            size="icon"
            className={TOOLBAR_ICON_BTN_CLS}
            onClick={() => onYearChange(year + 1)}
            aria-label="Następny rok"
            {...tip(`Pokaż normy roku ${year + 1}`)}
            data-testid="kadry-normy-year-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {year !== now.getFullYear() && (
            <Button
              variant="ghost"
              size="sm"
              className={TOOLBAR_BTN_CLS}
              onClick={() => onYearChange(now.getFullYear())}
              {...tip(`Wróć do bieżącego roku (${now.getFullYear()})`)}
            >
              Dziś
            </Button>
          )}
        </div>
        {/* Norma etatu nie jest uznaniowa — wynika z artykułu 130 Kodeksu pracy.
            Okno pokazuje ją obok wpisanej i pozwala zapisać wybrane miesiące. */}
        <Button
          variant="outline"
          size="sm"
          className={TOOLBAR_BTN_CLS}
          onClick={() => setComputeOpen(true)}
          {...tip(
            "Policz normę godzin etatu dla wszystkich miesięcy roku według artykułu 130 Kodeksu pracy i zobacz listę dni wolnych, z której wyszła",
          )}
          data-testid="kadry-normy-compute-open"
        >
          <Scale className="mr-1 h-4 w-4" />
          Wylicz z Kodeksu pracy
        </Button>
        {editable && norms.length === 0 && (
          <Button
            variant="outline"
            disabled={copying}
            onClick={copyPrevYear}
            data-testid="kadry-normy-copy-prev"
          >
            {copying ? "Kopiowanie…" : `Skopiuj normy z roku ${year - 1}`}
          </Button>
        )}
        {copyError && <p className="text-sm text-destructive">{copyError}</p>}
        <KadryHelp tab="normy" className="ml-auto" />
      </div>
      <Card>
        <CardContent className="p-0">
          <table className="w-full max-w-2xl text-sm">
            <thead className={THEAD_CLS}>
              <tr>
                <Th tip={`Miesiąc roku ${year}`}>Miesiąc</Th>
                <Th
                  tip="Norma godzin dla umów o pracę — limit maks godzin, gdy pracownik nie ma indywidualnych GODZIN MAKS"
                  className="text-right"
                >
                  Norma — umowa o pracę
                </Th>
                <Th
                  tip="Norma godzin dla zleceń — limit maks godzin wierszy zleceniowych (w arkuszu stałe 158)"
                  className="text-right"
                >
                  Norma — zlecenie
                </Th>
              </tr>
            </thead>
            <tbody>
              {MONTH_NAMES.map((name, idx) => {
                const m = idx + 1;
                const row = norms.find((n) => n.month === m);
                const current = m === month;
                // Wpisana norma rozjechana z wymiarem z Kodeksu pracy. Sam
                // brak wiersza nie jest jeszcze pomyłką (miesiąc leci na
                // domyślnych 160 h), więc znacznik dotyczy wyłącznie wpisów.
                const fromCode = computed[m];
                const mismatch =
                  row != null && fromCode != null && row.workNorm !== fromCode;
                return (
                  <tr
                    key={m}
                    className={cn("border-b", current && "bg-primary/5")}
                    data-testid={`kadry-normy-row-${m}`}
                  >
                    <td className="px-3 py-2 font-medium">
                      {name}
                      {current && (
                        <KadryBadge
                          tone="info"
                          compact
                          className="ml-2 font-normal"
                          hint="Miesiąc wybrany w module — z tej normy liczą się teraz maks godziny"
                        >
                          bieżący
                        </KadryBadge>
                      )}
                      {!row && (
                        <KadryBadge
                          tone="nieaktywny"
                          compact
                          className="ml-2 font-normal"
                          hint="Brak zapisanej normy — liczy się wartość domyślna (160 h praca / 158 h zlecenie)"
                        >
                          domyślne
                        </KadryBadge>
                      )}
                      {mismatch && (
                        // Dymek wisi na `span`, nie na samej ikonie: `tip()`
                        // podpina zdarzenia myszy i fokusu typowane pod HTML,
                        // a `svg` z lucide ich nie przyjmuje.
                        <span
                          className="ml-2 inline-flex align-middle"
                          role="img"
                          aria-label={`Wpisana norma różni się od wyliczonej z Kodeksu pracy: ${fromCode} h`}
                          data-testid={`kadry-normy-mismatch-${m}`}
                          {...tip(
                            `Wyliczona z Kodeksu pracy: ${fromCode} h. Otwórz „Wylicz z Kodeksu pracy”, żeby zobaczyć rachunek i zapisać.`,
                          )}
                        >
                          <TriangleAlert
                            className={cn("h-3.5 w-3.5", TEXT_TONE.warn)}
                            aria-hidden
                          />
                        </span>
                      )}
                    </td>
                    {cell(m, "workNorm", "160")}
                    {cell(m, "contractNorm", "158")}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Brak zapisanej normy = domyślnie 160 h (praca) / 158 h (zlecenie). Zapis
        następuje po wyjściu z pola; Esc cofa wpis.
      </p>
      <ComputeNormsDialog
        year={year}
        open={computeOpen}
        editable={editable}
        onOpenChange={setComputeOpen}
        onApplied={() => {
          onSaved();
          loadComputed();
        }}
      />
    </>
  );
}
