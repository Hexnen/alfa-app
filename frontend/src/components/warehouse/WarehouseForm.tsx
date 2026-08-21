import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { WarehouseDef, WarehouseDefInput, WarehouseType } from "@/lib/api";
import { WAREHOUSE_TYPE_META } from "./warehouseShared";

interface WarehouseFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: WarehouseDefInput) => Promise<void>;
  warehouse?: WarehouseDef | null;
  /** Pełna lista magazynów — do wyboru magazynu nadrzędnego. */
  warehouses: WarehouseDef[];
}

export function WarehouseForm({
  open,
  onClose,
  onSubmit,
  warehouse,
  warehouses,
}: WarehouseFormProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: warehouse?.name || "",
    code: warehouse?.code || "",
    type: (warehouse?.type || "main") as WarehouseType,
    parentId: warehouse?.parentId != null ? String(warehouse.parentId) : "",
  });

  // Nadrzędny może być tylko magazyn bez własnego rodzica (max 2 poziomy)
  // i oczywiście nie edytowany magazyn we własnej osobie.
  const parentCandidates = warehouses.filter(
    (w) => !w.isArchived && w.parentId == null && w.id !== warehouse?.id
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      window.alert("Podaj nazwę magazynu.");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        type: form.type,
        parentId: form.parentId ? Number(form.parentId) : null,
      });
      onClose();
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd zapisu magazynu"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {warehouse ? "Edytuj magazyn" : "Nowy magazyn"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wh-name">Nazwa *</Label>
            <Input
              id="wh-name"
              value={form.name}
              onChange={(e) =>
                setForm((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="np. Bus serwisowy 1"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wh-code">Kod</Label>
              <Input
                id="wh-code"
                value={form.code}
                onChange={(e) =>
                  setForm((p) => ({ ...p, code: e.target.value }))
                }
                placeholder="np. BUS1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wh-type">Typ</Label>
              <select
                id="wh-type"
                value={form.type}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    type: e.target.value as WarehouseType,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {(
                  Object.keys(WAREHOUSE_TYPE_META) as WarehouseType[]
                ).map((t) => (
                  <option key={t} value={t}>
                    {WAREHOUSE_TYPE_META[t].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wh-parent">Magazyn nadrzędny</Label>
            <select
              id="wh-parent"
              value={form.parentId}
              onChange={(e) =>
                setForm((p) => ({ ...p, parentId: e.target.value }))
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— brak —</option>
              {parentCandidates.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                  {w.code ? ` (${w.code})` : ""}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie…" : warehouse ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
