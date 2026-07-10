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
import type { PriceItem, PriceItemInput } from "@/lib/api";

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
  const [formData, setFormData] = useState<PriceItemInput>({
    name: item?.name || "",
    unit: item?.unit || "MB",
    price: item?.price ?? "",
    position: item?.position,
    active: item?.active ?? true,
  });

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
          <div className="space-y-2">
            <Label htmlFor="price-name">Nazwa usługi *</Label>
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
                onChange={(e) =>
                  setFormData((p) => ({ ...p, unit: e.target.value }))
                }
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
