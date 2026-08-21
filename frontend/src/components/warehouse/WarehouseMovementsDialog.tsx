import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  warehouseApi,
  type WarehouseItem,
  type WarehouseMovement,
} from "@/lib/api";
import {
  DOC_TYPE_META,
  fmtDateTime,
  fmtQty,
} from "./warehouseShared";

interface WarehouseMovementsDialogProps {
  open: boolean;
  onClose: () => void;
  item: WarehouseItem | null;
}

/** Historia ruchów magazynowych jednego towaru. */
export function WarehouseMovementsDialog({
  open,
  onClose,
  item,
}: WarehouseMovementsDialogProps) {
  const [movements, setMovements] = useState<WarehouseMovement[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!item) return;
    setLoading(true);
    try {
      const res = await warehouseApi.getMovements({
        itemId: item.id,
        limit: 200,
      });
      setMovements(res.data || []);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd wczytywania historii ruchów"
      );
    } finally {
      setLoading(false);
    }
  }, [item]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Historia ruchów{item ? ` — ${item.name}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Dokument</th>
                <th className="px-3 py-2 font-medium">Magazyn</th>
                <th className="px-3 py-2 text-right font-medium">Zmiana</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    Ładowanie…
                  </td>
                </tr>
              ) : movements.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    Brak ruchów magazynowych dla tego towaru.
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDateTime(m.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {m.docType && DOC_TYPE_META[m.docType] && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${DOC_TYPE_META[m.docType].badge}`}
                          >
                            {m.docType}
                          </span>
                        )}
                        <span>{m.docNumber || "szkic"}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">{m.warehouseName}</td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        m.quantityDelta > 0
                          ? "text-emerald-600"
                          : m.quantityDelta < 0
                            ? "text-red-600"
                            : ""
                      }`}
                    >
                      {m.quantityDelta > 0 ? "+" : ""}
                      {fmtQty(m.quantityDelta)} {m.itemUnit}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Zamknij
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
