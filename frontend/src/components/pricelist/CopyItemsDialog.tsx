import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { PriceListGroup } from "@/lib/api";

interface CopyItemsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Cennik źródłowy (pomijany na liście docelowych). */
  from: PriceListGroup;
  lists: PriceListGroup[];
  /** Liczba kopiowanych pozycji (zaznaczone albo wszystkie). */
  count: number;
  onSubmit: (toListId: number) => Promise<void>;
}

/** Wybór cennika docelowego dla kopiowanych pozycji. */
export function CopyItemsDialog({
  open,
  onClose,
  from,
  lists,
  count,
  onSubmit,
}: CopyItemsDialogProps) {
  const targets = lists.filter((l) => l.id !== from.id);
  const [toListId, setToListId] = useState<number | "">(targets[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!toListId) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit(Number(toListId));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd kopiowania pozycji");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kopiuj pozycje do innego cennika</DialogTitle>
          <DialogDescription>
            Skopiujemy {count}{" "}
            {count === 1 ? "pozycję" : count < 5 ? "pozycje" : "pozycji"} z
            cennika „{from.name}". Oryginały zostają na miejscu.
          </DialogDescription>
        </DialogHeader>

        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Brak innego cennika — utwórz najpierw kolejny cennik.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="copy-target">Cennik docelowy</Label>
            <select
              id="copy-target"
              value={toListId}
              onChange={(e) => setToListId(Number(e.target.value))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {targets.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.isDefault ? " (główny)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="text-sm font-medium text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={loading || targets.length === 0 || !toListId}
            data-testid="copy-items-confirm"
          >
            {loading ? "Kopiowanie…" : "Kopiuj"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
