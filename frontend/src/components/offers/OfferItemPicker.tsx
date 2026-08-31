/**
 * Wyszukiwarka pozycji do oferty — JEDNO pole nad dwoma katalogami: magazynem
 * i usługami.
 *
 * Celowo nie jest to picker magazynowy z `WarehouseDocumentForm`: tam szuka się
 * wyłącznie towaru, a przy składaniu oferty sprzęt i robocizna dokładają się
 * naprzemiennie („kamera, montaż kamery, kamera…”). Rozdzielenie ich na dwie
 * kontrolki zmuszałoby do ciągłego przełączania kontekstu.
 */
import { useMemo, useRef, useState } from "react";
import { Package, Wrench } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { Service, WarehouseItem } from "@/lib/api";
import { fmtPln, fmtQty } from "./offersShared";

export interface PickedItem {
  source: "warehouse" | "service";
  warehouseItemId?: number;
  serviceId?: number;
  name: string;
  unit: string;
}

interface OfferItemPickerProps {
  items: WarehouseItem[];
  services: Service[];
  /** Stany magazynowe (suma po magazynach) — podpowiedź „na stanie N". */
  stockByItem: Map<number, number>;
  onPick: (picked: PickedItem) => void;
  disabled?: boolean;
  placeholder?: string;
}

const MAX_SUGGESTIONS = 8;

export function OfferItemPicker({
  items,
  services,
  stockByItem,
  onPick,
  disabled = false,
  placeholder = "Dodaj pozycję — szukaj w magazynie i usługach…",
}: OfferItemPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matchedItems = items
      .filter((i) => !i.isArchived)
      .filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.sku ?? "").toLowerCase().includes(q) ||
          (i.manufacturer ?? "").toLowerCase().includes(q)
      )
      .slice(0, MAX_SUGGESTIONS);
    const matchedServices = services
      .filter((s) => s.active)
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
    // Sprzęt najpierw: oferta zwykle zaczyna się od tego, co klient dostaje,
    // a robocizna dokłada się do konkretnej pozycji sprzętowej.
    return [
      ...matchedItems.map((i) => ({ type: "warehouse" as const, item: i })),
      ...matchedServices.map((s) => ({ type: "service" as const, service: s })),
    ].slice(0, MAX_SUGGESTIONS * 2);
  }, [query, items, services]);

  const pick = (picked: PickedItem) => {
    onPick(picked);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Krótka zwłoka: bez niej blur zamyka listę, zanim klik zdąży wybrać.
          blurTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-background shadow-lg">
          {suggestions.map((s) =>
            s.type === "warehouse" ? (
              <button
                key={`w-${s.item.id}`}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) window.clearTimeout(blurTimer.current);
                  pick({
                    source: "warehouse",
                    warehouseItemId: s.item.id,
                    name: s.item.name,
                    unit: s.item.unit,
                  });
                }}
              >
                <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">
                  {s.item.name}
                  {s.item.manufacturer && (
                    <span className="text-muted-foreground"> · {s.item.manufacturer}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {s.item.effectiveSalePrice !== null
                    ? fmtPln(s.item.effectiveSalePrice)
                    : "bez ceny"}{" "}
                  · na stanie {fmtQty(stockByItem.get(s.item.id) ?? 0)}
                </span>
              </button>
            ) : (
              <button
                key={`s-${s.service.id}`}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) window.clearTimeout(blurTimer.current);
                  pick({
                    source: "service",
                    serviceId: s.service.id,
                    name: s.service.name,
                    unit: s.service.unit,
                  });
                }}
              >
                <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{s.service.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {fmtPln(s.service.price)} / {s.service.unit}
                </span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
