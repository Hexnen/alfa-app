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
import type { CameraModel, CameraModelInput, CameraModelType } from "@/lib/api";

interface CameraModelFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CameraModelInput) => Promise<void>;
  item?: CameraModel | null;
}

const typeOptions: { value: CameraModelType; label: string }[] = [
  { value: "bullet", label: "Tubowa" },
  { value: "dome", label: "Kopułkowa" },
  { value: "ptz", label: "PTZ" },
  { value: "pano", label: "360°" },
  { value: "lpr", label: "LPR (tablice)" },
];

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function CameraModelForm({
  open,
  onClose,
  onSubmit,
  item,
}: CameraModelFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<CameraModelInput>({
    name: item?.name || "",
    manufacturer: item?.manufacturer || "",
    type: item?.type || "bullet",
    resolution: item?.resolution || "",
    lens: item?.lens || "",
    irRange: item?.irRange || "",
    power: item?.power || "",
    interface: item?.interface || "",
    protocol: item?.protocol || "",
    fov: item?.fov ?? 90,
    range: item?.range ?? 20,
    height: item?.height ?? 3,
    color: item?.color || "#38bdf8",
    notes: item?.notes || "",
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
      alert(error instanceof Error ? error.message : "Błąd zapisu szablonu");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {item ? "Edytuj szablon kamery" : "Nowy szablon kamery"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cm-name">Nazwa / model *</Label>
              <Input
                id="cm-name"
                value={formData.name}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, name: e.target.value }))
                }
                placeholder="np. DS-2CD2143G2-I"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-manufacturer">Producent</Label>
              <Input
                id="cm-manufacturer"
                value={formData.manufacturer}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, manufacturer: e.target.value }))
                }
                placeholder="np. Hikvision"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cm-type">Typ</Label>
              <select
                id="cm-type"
                className={selectClass}
                value={formData.type}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    type: e.target.value as CameraModelType,
                  }))
                }
              >
                {typeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-resolution">Rozdzielczość</Label>
              <Input
                id="cm-resolution"
                value={formData.resolution}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, resolution: e.target.value }))
                }
                placeholder="np. 4MP"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cm-fov">FOV (°)</Label>
              <Input
                id="cm-fov"
                type="number"
                value={formData.fov}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, fov: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-range">Zasięg (m)</Label>
              <Input
                id="cm-range"
                type="number"
                value={formData.range}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, range: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-height">Wys. montażu (m)</Label>
              <Input
                id="cm-height"
                type="number"
                step="0.1"
                value={formData.height}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, height: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-color">Kolor na mapie</Label>
              <Input
                id="cm-color"
                type="color"
                className="h-10 p-1"
                value={formData.color}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, color: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cm-lens">Obiektyw</Label>
              <Input
                id="cm-lens"
                value={formData.lens}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, lens: e.target.value }))
                }
                placeholder="np. 2.8mm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-irRange">Zasięg IR</Label>
              <Input
                id="cm-irRange"
                value={formData.irRange}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, irRange: e.target.value }))
                }
                placeholder="np. 30m"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-power">Zasilanie</Label>
              <Input
                id="cm-power"
                value={formData.power}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, power: e.target.value }))
                }
                placeholder="np. PoE"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-interface">Interfejs</Label>
              <Input
                id="cm-interface"
                value={formData.interface}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, interface: e.target.value }))
                }
                placeholder="np. IP"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cm-protocol">Protokół</Label>
              <Input
                id="cm-protocol"
                value={formData.protocol}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, protocol: e.target.value }))
                }
                placeholder="np. ONVIF"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cm-notes">Uwagi</Label>
            <Input
              id="cm-notes"
              value={formData.notes}
              onChange={(e) =>
                setFormData((p) => ({ ...p, notes: e.target.value }))
              }
            />
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
            Aktywny
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || !formData.name.trim()}>
              {loading ? "Zapisywanie…" : item ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
