import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { PriceListGroup, Technician } from "@/lib/api";

interface AssignTechniciansDialogProps {
  open: boolean;
  onClose: () => void;
  list: PriceListGroup;
  /** Wszyscy technicy (z polem priceListId), do wyboru. */
  technicians: Technician[];
  /** Id techników już przypisanych do tego cennika. */
  assignedIds: number[];
  onSubmit: (technicianIds: number[]) => Promise<void>;
}

const techName = (t: Technician) =>
  `${t.firstName} ${t.lastName}`.trim() || `#${t.id}`;

/**
 * Multi-select techników korzystających z cennika (checkboxy + filtr), tak jak
 * wybór techników w kalendarzu. Zapis ustawia dokładny zbiór — odznaczeni
 * wracają na cennik główny.
 */
export function AssignTechniciansDialog({
  open,
  onClose,
  list,
  technicians,
  assignedIds,
  onSubmit,
}: AssignTechniciansDialogProps) {
  const [selected, setSelected] = useState<number[]>(assignedIds);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = technicians.filter((t) => t.active || selected.includes(t.id));
    if (!q) return pool;
    return pool.filter(
      (t) =>
        techName(t).toLowerCase().includes(q) ||
        (t.company || "").toLowerCase().includes(q)
    );
  }, [technicians, query, selected]);

  const toggle = (id: number) =>
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      await onSubmit(selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd zapisu przypisań");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Przypisz techników</DialogTitle>
          <DialogDescription>
            Zaznaczeni technicy korzystają z cennika „{list.name}". Odznaczenie
            przywraca technikowi cennik główny.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj technika lub firmy…"
        />

        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-1">
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Brak techników do wyboru.
            </p>
          ) : (
            visible.map((t) => {
              const otherList =
                t.priceListId !== null && t.priceListId !== list.id;
              return (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={selected.includes(t.id)}
                    onChange={() => toggle(t.id)}
                    data-testid={`assign-tech-${t.id}`}
                  />
                  <span className="flex-1">
                    <span className="font-medium">{techName(t)}</span>
                    {t.company && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t.company}
                      </span>
                    )}
                  </span>
                  {otherList && (
                    <span className="text-xs text-muted-foreground">
                      w innym cenniku
                    </span>
                  )}
                  {!t.active && (
                    <span className="text-xs text-muted-foreground">
                      archiwalny
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Zaznaczonych: {selected.length}
        </p>

        {error && <p className="text-sm font-medium text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            data-testid="assign-tech-save"
          >
            {loading ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
