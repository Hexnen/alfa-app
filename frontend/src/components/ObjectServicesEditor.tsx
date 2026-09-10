/**
 * USŁUGI OBIEKTU JAKO OKRESY — edytor listy zamiast czterech checkboxów.
 *
 * Checkbox („obiekt ma kamery”) nie umiał opowiedzieć historii: ta sama usługa
 * bywa świadczona w kilku odcinkach (kamery 2020–2022 i znów od 2024), a po
 * odhaczeniu pola nie zostawał ślad, że kiedykolwiek była. Dlatego lista okresów
 * z datą startu (wymaganą) i końca (opcjonalną); okres zakończony zostaje
 * widoczny — wyszarzony — i przestaje liczyć się do flag `hasX`, filtra listy
 * i analityki (reguła aktywności: `isServicePeriodEnded` w @/lib/utils, lustro
 * `flagsFromServices` z backendu).
 *
 * Komponent jest kontrolowany (`value`/`onChange` w kształcie `ObjectServiceInput[]`
 * z kontraktu API), ale trzyma WŁASNE klucze wierszy — dokładnie jak `patchRow`
 * w `components/warehouse/WarehouseDocumentForm.tsx:222-225, 640-765`. Bez tego
 * usunięcie wiersza ze środka przenosiłoby focus i zawartość inputów na sąsiada
 * (klucz po indeksie), a nowy wiersz nie miałby po czym zostać rozpoznany, dopóki
 * nie dostanie `id` z serwera.
 *
 * Ten sam edytor obsługuje kartotekę obiektu i formularz zlecenia (Część 3 planu),
 * stąd `compact` (gęstsza siatka do kroku „Zakres”) i `defaultStartDate` — zlecenie
 * podpowiada „Początek usługi” z sekcji Terminy zamiast dzisiejszej daty.
 *
 * Pigułka rodzaju to `pillClass` z `lib/calendar-labels.ts:275` — ten sam kształt
 * i te same tony, co statusy w kalendarzu, więc kolor nie znika w trybie ciemnym.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pillClass, type PillTone } from "@/lib/calendar-labels";
import type { ObjectServiceInput, ObjectServiceKind } from "@/lib/api";
import {
  cn,
  isServicePeriodEnded,
  isServicePeriodPlanned,
  objectServiceKeys,
  objectServiceLabels,
  todayIsoLocal,
} from "@/lib/utils";

/**
 * Tony pigułek rodzajów usług. Kamery „sky” jak serwis w kalendarzu, OFI
 * „emerald” (ochrona fizyczna liczy się zupełnie inaczej niż dozór z centrum),
 * SSWiN „amber”, wideorecepcja „violet” — cztery tony, które da się rozróżnić
 * także w trybie ciemnym (`PILL_TONE`).
 */
const SERVICE_TONE: Record<ObjectServiceKind, PillTone> = {
  kamery: "sky",
  sswin: "amber",
  wideorecepcja: "violet",
  ofi: "emerald",
};

/**
 * Wiersz roboczy: pola dat i liczby kamer trzymamy jako TEKST, bo w trakcie
 * pisania „” i „2026-1” są legalnymi stanami inputa, a `ObjectServiceInput`
 * dopuszcza tylko gotową wartość albo null.
 */
interface Row {
  key: number;
  id?: number;
  service: ObjectServiceKind;
  startDate: string;
  endDate: string;
  cameraCount: string;
  notes: string | null;
}

let rowKeySeq = 1;

function toRow(v: ObjectServiceInput): Row {
  return {
    key: rowKeySeq++,
    id: v.id,
    service: v.service,
    startDate: v.startDate ?? "",
    endDate: v.endDate ?? "",
    cameraCount: v.cameraCount == null ? "" : String(v.cameraCount),
    notes: v.notes ?? null,
  };
}

/** Liczba kamer z pola tekstowego; puste = „nie policzono” (null), NIE zero. */
function parseCameraCount(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toInput(r: Row): ObjectServiceInput {
  return {
    ...(r.id != null ? { id: r.id } : {}),
    service: r.service,
    startDate: r.startDate,
    endDate: r.endDate.trim() === "" ? null : r.endDate,
    // Liczba kamer ma sens tylko przy kamerach — przy pozostałych usługach
    // backend i tak ją zignoruje, więc nie wysyłamy śmiecia.
    cameraCount: r.service === "kamery" ? parseCameraCount(r.cameraCount) : null,
    notes: r.notes,
  };
}

/** Komunikat błędu wiersza albo null, gdy wiersz jest w porządku. */
function rowError(r: Row): string | null {
  if (!r.startDate.trim()) return "Podaj datę rozpoczęcia usługi.";
  if (r.endDate.trim() && r.endDate < r.startDate) {
    return "Data zakończenia jest wcześniejsza niż data rozpoczęcia.";
  }
  if (r.service === "kamery" && r.cameraCount.trim() !== "") {
    const n = Number(r.cameraCount);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return "Liczba kamer musi być liczbą całkowitą nie mniejszą niż 0.";
    }
  }
  return null;
}

export interface ObjectServicesEditorProps {
  /** Lista okresów w kształcie body zapisu (pełna podmiana po stronie backendu). */
  value: ObjectServiceInput[];
  onChange: (next: ObjectServiceInput[]) => void;
  disabled?: boolean;
  /** Gęstsza siatka bez etykiet pól — do kroku „Zakres” w formularzu zlecenia. */
  compact?: boolean;
  /**
   * Data startu podstawiana w NOWO dodanym wierszu. Formularz zlecenia poda tu
   * „Początek usługi” z sekcji Terminy; domyślnie dziś.
   */
  defaultStartDate?: string;
  /** Woła się przy każdej zmianie poprawności — formularz blokuje nim „Zapisz”. */
  onValidityChange?: (valid: boolean) => void;
}

export function ObjectServicesEditor({
  value,
  onChange,
  disabled = false,
  compact = false,
  defaultStartDate,
  onValidityChange,
}: ObjectServicesEditorProps) {
  const [rows, setRows] = useState<Row[]>(() => value.map(toRow));
  /**
   * Ostatnia lista, którą sami wypuściliśmy w górę — porównywana po TREŚCI, nie
   * po referencji: rodzic zwykle odsyła nam z powrotem to samo (`value={form.services ?? []}`
   * to nowa tablica przy każdym renderze), a przepisanie wierszy przy każdym
   * naciśnięciu klawisza nadałoby im nowe klucze i wyrzuciło kursor z pola daty.
   */
  const emittedJson = useRef<string>(JSON.stringify(value));
  /** Klucz wiersza, którego pole „Od” ma dostać focus po dodaniu. */
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const startRefs = useRef(new Map<number, HTMLInputElement | null>());

  // Zmiana Z ZEWNĄTRZ (wczytany obiekt, reset formularza) — tylko wtedy wiersze
  // budujemy od nowa.
  const valueJson = JSON.stringify(value);
  useEffect(() => {
    if (emittedJson.current === valueJson) return;
    emittedJson.current = valueJson;
    setRows((JSON.parse(valueJson) as ObjectServiceInput[]).map(toRow));
  }, [valueJson]);

  const commit = useCallback(
    (next: Row[]) => {
      setRows(next);
      const out = next.map(toInput);
      emittedJson.current = JSON.stringify(out);
      onChange(out);
    },
    [onChange]
  );

  const patchRow = (key: number, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = (service: ObjectServiceKind) => {
    const row: Row = {
      key: rowKeySeq++,
      service,
      startDate: defaultStartDate?.trim() || todayIsoLocal(),
      endDate: "",
      cameraCount: "",
      notes: null,
    };
    commit([...rows, row]);
    setFocusKey(row.key);
  };

  const removeRow = (key: number) => commit(rows.filter((r) => r.key !== key));

  // Focus dopiero po tym, jak React dołoży wiersz do DOM-u — inaczej ref jeszcze
  // nie istnieje i „dodaj” zostawiałoby kursor na przycisku.
  useEffect(() => {
    if (focusKey == null) return;
    startRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, rows]);

  const errors = useMemo(() => rows.map(rowError), [rows]);
  const valid = errors.every((e) => e === null);
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const today = todayIsoLocal();
  const fieldLabel = "mb-0.5 block text-[11px] font-medium text-muted-foreground";

  return (
    <div className="space-y-2" data-testid="object-services-editor">
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Brak usług. Dodaj okres przyciskiem poniżej — start jest wymagany, koniec
          zostaw pusty, gdy usługa trwa.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => {
            const period = {
              service: row.service,
              startDate: row.startDate,
              endDate: row.endDate || null,
            };
            const ended = isServicePeriodEnded(period, today);
            const planned = isServicePeriodPlanned(period, today);
            const err = errors[i];
            return (
              <div
                key={row.key}
                data-testid={`object-service-row-${i}`}
                className={cn(
                  "rounded-md border px-2 py-2",
                  // Zakończony okres zostaje w kartotece, ale ma nie krzyczeć —
                  // ta sama konwencja, co wyszarzone wiersze w karcie obiektu.
                  ended && "opacity-60"
                )}
              >
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex min-w-[8.5rem] items-center gap-1.5 self-center">
                    <span className={pillClass(SERVICE_TONE[row.service], { compact })}>
                      {objectServiceLabels[row.service]}
                    </span>
                    {ended && (
                      <span className={pillClass("muted", { compact: true })}>
                        zakończona
                      </span>
                    )}
                    {planned && (
                      <span className={pillClass("indigo", { compact: true })}>
                        zaplanowana
                      </span>
                    )}
                  </div>

                  <div className="w-[9.5rem]">
                    {!compact && <span className={fieldLabel}>Od *</span>}
                    <Input
                      type="date"
                      ref={(el) => {
                        startRefs.current.set(row.key, el);
                      }}
                      data-testid={`object-service-start-${i}`}
                      aria-label={`Początek usługi: ${objectServiceLabels[row.service]}`}
                      className={cn("tabular-nums", compact && "h-8")}
                      value={row.startDate}
                      disabled={disabled}
                      onChange={(e) => patchRow(row.key, { startDate: e.target.value })}
                    />
                  </div>

                  <div className="w-[9.5rem]">
                    {!compact && <span className={fieldLabel}>Do</span>}
                    <Input
                      type="date"
                      data-testid={`object-service-end-${i}`}
                      aria-label={`Koniec usługi: ${objectServiceLabels[row.service]}`}
                      className={cn("tabular-nums", compact && "h-8")}
                      value={row.endDate}
                      disabled={disabled}
                      onChange={(e) => patchRow(row.key, { endDate: e.target.value })}
                    />
                  </div>

                  {row.service === "kamery" && (
                    <div className="w-[10rem]">
                      {!compact && <span className={fieldLabel}>Kamery</span>}
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        // Puste pole to „usługa jest, ale nikt kamer nie policzył”,
                        // a nie zero — placeholder mówi to wprost, bo od tej liczby
                        // zależy waga obiektu przy podziale kosztu centrum.
                        placeholder="nie policzono"
                        data-testid={`object-service-cameras-${i}`}
                        aria-label="Liczba kamer w tym okresie"
                        className={cn("tabular-nums", compact && "h-8")}
                        value={row.cameraCount}
                        disabled={disabled}
                        onChange={(e) => patchRow(row.key, { cameraCount: e.target.value })}
                      />
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
                    data-testid={`object-service-remove-${i}`}
                    aria-label={`Usuń okres usługi: ${objectServiceLabels[row.service]}`}
                    disabled={disabled}
                    onClick={() => removeRow(row.key)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {err && (
                  <p
                    className="mt-1 text-xs text-destructive"
                    data-testid={`object-service-error-${i}`}
                  >
                    {err}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {objectServiceKeys.map((k) => (
          <Button
            key={k}
            type="button"
            variant="outline"
            size="sm"
            data-testid={`object-service-add-${k}`}
            disabled={disabled}
            onClick={() => addRow(k)}
          >
            <Plus className="mr-1 h-4 w-4" />
            {objectServiceLabels[k]}
          </Button>
        ))}
      </div>
    </div>
  );
}
