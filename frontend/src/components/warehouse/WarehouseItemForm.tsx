import { useState } from "react";
import { ImageOff, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { WarehouseItem, WarehouseItemInput } from "@/lib/api";
import { COMMON_UNITS, resizeImageToDataUrl } from "./warehouseShared";

interface WarehouseItemFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: WarehouseItemInput) => Promise<void>;
  item?: WarehouseItem | null;
  /** Istniejące kategorie do podpowiedzi (datalist). */
  categories: string[];
}

const CUSTOM_UNIT = "__custom__";

export function WarehouseItemForm({
  open,
  onClose,
  onSubmit,
  item,
  categories,
}: WarehouseItemFormProps) {
  const [loading, setLoading] = useState(false);
  const initialUnit = item?.unit || "szt";
  const isKnownUnit = COMMON_UNITS.includes(initialUnit);
  const [unitChoice, setUnitChoice] = useState(
    isKnownUnit ? initialUnit : CUSTOM_UNIT
  );
  const [customUnit, setCustomUnit] = useState(isKnownUnit ? "" : initialUnit);
  const [form, setForm] = useState({
    name: item?.name || "",
    sku: item?.sku || "",
    category: item?.category || "",
    barcode: item?.barcode || "",
    minStock: item?.minStock != null ? String(item.minStock) : "",
    isAsset: item?.isAsset ?? false,
    description: item?.description || "",
  });
  const [photoData, setPhotoData] = useState<string | null>(
    item?.photoData || null
  );
  const [photoBusy, setPhotoBusy] = useState(false);

  const unit = unitChoice === CUSTOM_UNIT ? customUnit.trim() : unitChoice;

  const handlePhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      setPhotoData(await resizeImageToDataUrl(file, 800));
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd wczytywania zdjęcia"
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !unit) {
      window.alert("Podaj nazwę i jednostkę towaru.");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        unit,
        sku: form.sku.trim() || undefined,
        category: form.category.trim() || undefined,
        barcode: form.barcode.trim() || undefined,
        minStock: form.minStock.trim() ? Number(form.minStock) : null,
        isAsset: form.isAsset,
        description: form.description.trim() || undefined,
        photoData,
      });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu towaru");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? "Edytuj towar" : "Nowy towar"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wi-name">Nazwa *</Label>
            <Input
              id="wi-name"
              value={form.name}
              onChange={(e) =>
                setForm((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="np. Kamera IP 4 Mpx"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-unit">Jednostka *</Label>
              <select
                id="wi-unit"
                value={unitChoice}
                onChange={(e) => setUnitChoice(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {COMMON_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
                <option value={CUSTOM_UNIT}>inna…</option>
              </select>
              {unitChoice === CUSTOM_UNIT && (
                <Input
                  value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value)}
                  placeholder="np. rolka"
                  required
                />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="wi-sku">SKU</Label>
              <Input
                id="wi-sku"
                value={form.sku}
                onChange={(e) =>
                  setForm((p) => ({ ...p, sku: e.target.value }))
                }
                placeholder="np. KAM-4MP-01"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-category">Kategoria</Label>
              <Input
                id="wi-category"
                list="wi-category-list"
                value={form.category}
                onChange={(e) =>
                  setForm((p) => ({ ...p, category: e.target.value }))
                }
                placeholder="np. Kamery"
              />
              <datalist id="wi-category-list">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wi-barcode">Kod kreskowy</Label>
              <Input
                id="wi-barcode"
                value={form.barcode}
                onChange={(e) =>
                  setForm((p) => ({ ...p, barcode: e.target.value }))
                }
                placeholder="np. 5901234567890"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-min-stock">Stan minimalny</Label>
              <Input
                id="wi-min-stock"
                type="number"
                min="0"
                step="any"
                value={form.minStock}
                onChange={(e) =>
                  setForm((p) => ({ ...p, minStock: e.target.value }))
                }
                placeholder="np. 5"
              />
            </div>
            <label className="flex items-center gap-2 pt-7 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.isAsset}
                onChange={(e) =>
                  setForm((p) => ({ ...p, isAsset: e.target.checked }))
                }
                className="h-4 w-4 accent-primary"
              />
              Sprzęt zwrotny (do zwrotu)
            </label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wi-description">Opis</Label>
            <Textarea
              id="wi-description"
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Zdjęcie</Label>
            <div className="flex items-center gap-3">
              {photoData ? (
                <img
                  src={photoData}
                  alt="Zdjęcie towaru"
                  className="h-16 w-16 rounded-md border object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                  <ImageOff className="h-6 w-6" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                  <Upload className="h-4 w-4" />
                  {photoBusy ? "Przetwarzanie…" : "Wybierz zdjęcie"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {photoData && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setPhotoData(null)}
                  >
                    <X className="h-3 w-3" /> Usuń zdjęcie
                  </button>
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || photoBusy}>
              {loading ? "Zapisywanie…" : item ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
