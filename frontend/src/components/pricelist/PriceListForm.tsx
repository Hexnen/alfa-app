import { useState } from "react";
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
import type { PriceListGroup, PriceListGroupInput } from "@/lib/api";

interface PriceListFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: PriceListGroupInput) => Promise<void>;
  /** null = nowy cennik. */
  list?: PriceListGroup | null;
  /** Tryb duplikatu — nazwa jest wstępnie wypełniona „… (kopia)". */
  duplicateOf?: PriceListGroup | null;
}

/** Dialog tworzenia / edycji cennika (nazwa, opis, aktywność). */
export function PriceListForm({
  open,
  onClose,
  onSubmit,
  list,
  duplicateOf,
}: PriceListFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<PriceListGroupInput>({
    name: duplicateOf ? `${duplicateOf.name} (kopia)`.slice(0, 80) : list?.name || "",
    description: duplicateOf?.description ?? list?.description ?? "",
    active: list?.active ?? true,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSubmit(formData);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu cennika");
    } finally {
      setLoading(false);
    }
  };

  const title = duplicateOf
    ? "Duplikuj cennik"
    : list
      ? "Edytuj cennik"
      : "Nowy cennik";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {duplicateOf && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              Skopiujemy wszystkie pozycje z cennika{" "}
              <strong>{duplicateOf.name}</strong> ({duplicateOf.itemCount} poz.).
              Przypisania techników nie są kopiowane.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="pl-name">Nazwa cennika *</Label>
            <Input
              id="pl-name"
              value={formData.name}
              maxLength={80}
              onChange={(e) =>
                setFormData((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="np. Cennik dla podwykonawców"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pl-description">Opis</Label>
            <Textarea
              id="pl-description"
              value={formData.description || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
              placeholder="Do czego służy ten cennik"
            />
          </div>

          {!duplicateOf && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={formData.active ?? true}
                disabled={list?.isDefault}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, active: e.target.checked }))
                }
                className="h-4 w-4 accent-primary"
              />
              Aktywny
              {list?.isDefault && (
                <span className="text-xs font-normal text-muted-foreground">
                  (cennik główny musi być aktywny)
                </span>
              )}
            </label>
          )}

          {error && (
            <p className="text-sm font-medium text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || !formData.name.trim()}>
              {loading
                ? "Zapisywanie…"
                : duplicateOf
                  ? "Duplikuj"
                  : list
                    ? "Zapisz zmiany"
                    : "Utwórz"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
