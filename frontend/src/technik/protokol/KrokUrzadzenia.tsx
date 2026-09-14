import { useEffect, useRef, useState } from "react";
import { History, Package, Plus, Trash2 } from "lucide-react";
import type { ProtocolItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "../ui/chip";
import { ClearableInput } from "../ui/clearable-input";
import { Panel } from "../ui/panel";
import { scrollFieldIntoView } from "../lib/keyboard";
import { recentDeviceNames } from "../lib/devices";
import { cleanItems, countLabel, DEFAULT_UNIT, EMPTY_ITEM, unitOptions } from "../lib/protocol";
import type { StepProps } from "./types";

/**
 * KROK 3 — CO ZOSTAŁO NA OBIEKCIE.
 *
 * Karta urządzenia jest zwarta (nazwa w pełnej szerokości, pod nią linia
 * „nr seryjny · ilość · jednostka”), żeby trzy pozycje mieściły się na jednym
 * ekranie 390 px. Nad listą stoją nazwy ostatnio montowanego sprzętu z tego
 * tabletu — najtańszy sposób, żeby nie wystukiwać „Kamera Hikvision DS-…”
 * po raz dziesiąty w tygodniu.
 */
export function KrokUrzadzenia({ form, update, readOnly }: StepProps) {
  /** Ostatnio używane nazwy czytamy RAZ — to ściągawka, nie strumień danych. */
  const [recent] = useState<string[]>(() => recentDeviceNames());
  /** Indeks pozycji, w której po dodaniu ma stanąć kursor (stan, nie ref — to
   *  wpływa na render wiersza). */
  const [focusIdx, setFocusIdx] = useState<number | null>(null);

  const items = form.items;
  const filled = cleanItems(items).length;

  const addItem = (name = "") => {
    // Indeks liczymy POZA aktualizatorem stanu: w trybie ścisłym React woła go
    // dwa razy, a efekt uboczny w czystej funkcji to proszenie się o kłopoty.
    setFocusIdx(items.length);
    update((prev) => ({ ...prev, items: [...prev.items, { ...EMPTY_ITEM, name }] }));
  };

  const setItem = (idx: number, patch: Partial<ProtocolItem>) =>
    update((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));

  const removeItem = (idx: number) =>
    update((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));

  return (
    <div className="space-y-3" data-testid="protokol-panel-urzadzenia">
      <Panel
        icon={Package}
        title="Zamontowane urządzenia"
        action={
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {countLabel(filled, "pozycja", "pozycje", "pozycji")}
          </span>
        }
        footer={
          !readOnly && (
            <Button
              variant="outline"
              className="h-12 w-full text-base"
              data-testid="protokol-dodaj-urzadzenie"
              onClick={() => addItem()}
            >
              <Plus className="mr-2 h-5 w-5" />
              Dodaj urządzenie
            </Button>
          )
        }
      >
        {/* Podpowiedzi z tego tabletu — jeden tap zakłada pozycję z nazwą. */}
        {!readOnly && recent.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Ostatnio montowane
            </p>
            <div className="flex flex-wrap gap-2" data-testid="device-recent">
              {recent.map((name) => (
                <Chip
                  key={name}
                  tone="neutral"
                  className="max-w-full"
                  onClick={() => addItem(name)}
                >
                  <Plus className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{name}</span>
                </Chip>
              ))}
            </div>
          </div>
        )}

        {items.length === 0 ? (
          /* Pusta lista to jedno zdanie, nie duży EmptyState: „brak urządzeń”
             jest normalnym wynikiem serwisu i nie ma czego celebrować. */
          <p className="text-sm text-muted-foreground">
            Nic nie zamontowano. Dodaj urządzenie, jeśli coś zostało na obiekcie.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <DeviceRow
                key={idx}
                idx={idx}
                item={item}
                readOnly={readOnly}
                autoFocus={focusIdx === idx}
                onFocused={() => setFocusIdx(null)}
                onChange={(patch) => setItem(idx, patch)}
                onRemove={() => removeItem(idx)}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function DeviceRow({
  idx,
  item,
  readOnly,
  autoFocus,
  onFocused,
  onChange,
  onRemove,
}: {
  idx: number;
  item: ProtocolItem;
  readOnly: boolean;
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (patch: Partial<ProtocolItem>) => void;
  onRemove: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const unitValue = item.unit?.trim() || DEFAULT_UNIT;

  // Po „Dodaj urządzenie” kursor siada w nazwie — technik pisze od razu,
  // bez szukania świeżego wiersza palcem na dole listy.
  useEffect(() => {
    if (!autoFocus) return;
    const el = nameRef.current;
    onFocused();
    if (!el) return;
    el.focus();
    scrollFieldIntoView(el);
  }, [autoFocus, onFocused]);

  return (
    <li className="rounded-lg border bg-background p-2">
      <div className="flex items-center gap-1.5">
        <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
          {idx + 1}
        </span>
        <ClearableInput
          ref={nameRef}
          aria-label={`Nazwa urządzenia ${idx + 1}`}
          value={item.name}
          disabled={readOnly}
          onChange={(v) => onChange({ name: v })}
          onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
          placeholder="Nazwa urządzenia"
          clearLabel={`Wyczyść nazwę urządzenia ${idx + 1}`}
          wrapperClassName="min-w-0 flex-1"
          className="h-11 text-base"
        />
        {!readOnly && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Usuń urządzenie ${idx + 1}`}
            className="h-11 w-11 shrink-0 text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="h-5 w-5" />
          </Button>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 pl-[1.375rem]">
        <ClearableInput
          aria-label={`Numer seryjny urządzenia ${idx + 1}`}
          value={item.serial}
          disabled={readOnly}
          onChange={(v) => onChange({ serial: v })}
          onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
          placeholder="Nr seryjny"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          clearLabel={`Wyczyść numer seryjny urządzenia ${idx + 1}`}
          wrapperClassName="min-w-0 flex-1"
          className="h-11 text-base"
        />
        <Input
          aria-label={`Ilość urządzenia ${idx + 1}`}
          value={item.qty}
          disabled={readOnly}
          inputMode="decimal"
          onChange={(e) => onChange({ qty: e.target.value })}
          onFocus={(e) => scrollFieldIntoView(e.currentTarget)}
          placeholder="Ilość"
          className="h-11 w-16 shrink-0 px-2 text-center text-base tabular-nums"
        />
        {/*
          Jednostka z listy zamiast wolnego tekstu — na papierze mają wyglądać
          tak samo. Natywny `<select>` jest CELOWY: na tablecie otwiera systemowy
          picker (Select Radixa dopiero od `lg`), a wartość spoza listy zostaje
          jako dodatkowa opcja.
        */}
        <select
          aria-label={`Jednostka urządzenia ${idx + 1}`}
          value={unitValue}
          disabled={readOnly}
          onChange={(e) => onChange({ unit: e.target.value })}
          className="h-11 w-[4.75rem] shrink-0 rounded-md border border-input bg-background px-2 text-base disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {unitOptions(unitValue).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}
