import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import {
  priceItemKind,
  PRICE_ITEM_KIND_LABEL,
  type PriceItem,
  type PriceItemInput,
  type PriceItemKind,
} from "@/lib/api";

/** Co daje rodzaj pozycji — pokazujemy wprost, bo od tego zależy automat. */
const KIND_HINT: Record<PriceItemKind, string> = {
  service:
    "Usługi dają stawki: pozycja w RBH/godz. wycenia godziny realizacji, pozycja w KM — kilometry.",
  material:
    "Materiały dopasowują się do pozycji z protokołu — z nich liczy się kwota „Materiały” w realizacji.",
};

/** Jednostki, które w praktyce oznaczają towar — podpowiedź przy nowej pozycji. */
const MATERIAL_UNITS = new Set(["SZT", "KPL", "MB", "M", "M2", "KG"]);

/** Podpowiedź rodzaju z jednostki (ta sama reguła, co migracja istniejących pozycji). */
const guessKind = (unit: string): PriceItemKind =>
  MATERIAL_UNITS.has(unit.trim().toUpperCase()) ? "material" : "service";

interface PriceItemFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: PriceItemInput) => Promise<void>;
  item?: PriceItem | null;
}

export function PriceItemForm({
  open,
  onClose,
  onSubmit,
  item,
}: PriceItemFormProps) {
  const [loading, setLoading] = useState(false);
  const initialUnit = item?.unit || "MB";
  const [formData, setFormData] = useState<PriceItemInput>({
    name: item?.name || "",
    unit: initialUnit,
    price: item?.price ?? "",
    position: item?.position,
    active: item?.active ?? true,
    kind: item ? priceItemKind(item) : guessKind(initialUnit),
  });
  /**
   * Rodzaju nie zgadujemy w kółko: podpowiedź z jednostki działa tylko dla
   * nowej pozycji i tylko dopóki człowiek sam nie kliknie w segment.
   */
  const [kindTouched, setKindTouched] = useState(false);

  const kind: PriceItemKind = formData.kind ?? "service";
  const setKind = (k: PriceItemKind) => {
    setKindTouched(true);
    setFormData((p) => ({ ...p, kind: k }));
  };
  const handleUnitChange = (unit: string) =>
    setFormData((p) => ({
      ...p,
      unit,
      kind: item || kindTouched ? p.kind : guessKind(unit),
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu pozycji");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {item ? "Edytuj pozycję cennika" : "Nowa pozycja cennika"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Rodzaj decyduje, jak automat realizacji użyje tej pozycji. */}
          <div className="space-y-2">
            <Label>Rodzaj *</Label>
            <div
              role="radiogroup"
              aria-label="Rodzaj pozycji cennika"
              data-testid="price-kind"
              className="inline-flex rounded-lg border bg-muted/40 p-0.5"
            >
              {(Object.keys(PRICE_ITEM_KIND_LABEL) as PriceItemKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  data-testid={`price-kind-${k}`}
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                    kind === k
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  {...tip(KIND_HINT[k])}
                >
                  {PRICE_ITEM_KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{KIND_HINT[kind]}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="price-name">
              {kind === "material" ? "Nazwa materiału *" : "Nazwa usługi *"}
            </Label>
            <Input
              id="price-name"
              value={formData.name}
              onChange={(e) =>
                setFormData((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="np. KABEL UTP KAT 5E."
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="price-unit">J.M. *</Label>
              <Input
                id="price-unit"
                value={formData.unit}
                onChange={(e) => handleUnitChange(e.target.value)}
                placeholder="MB / RBH / KM"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="price-price">Cena netto *</Label>
              <Input
                id="price-price"
                type="number"
                step="0.01"
                min="0"
                value={formData.price}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, price: e.target.value }))
                }
                placeholder="0,00"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="price-position">LP.</Label>
              <Input
                id="price-position"
                type="number"
                min="0"
                value={formData.position ?? ""}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    position: e.target.value
                      ? parseInt(e.target.value)
                      : undefined,
                  }))
                }
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={formData.active ?? true}
              onChange={(e) =>
                setFormData((p) => ({ ...p, active: e.target.checked }))
              }
              className="h-4 w-4 accent-primary"
            />
            Aktywna
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              type="submit"
              disabled={loading || !formData.name.trim() || !formData.unit.trim()}
            >
              {loading ? "Zapisywanie…" : item ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
