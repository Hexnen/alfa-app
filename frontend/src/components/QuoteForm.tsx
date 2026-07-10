import { useMemo, useState } from "react";
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
import { Printer, Plus, Trash2 } from "lucide-react";
import { printQuote } from "@/lib/quotePrint";
import type { Quote, QuoteInput, QuoteItem } from "@/lib/api";

interface QuoteFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: QuoteInput) => Promise<void>;
  quote: Quote;
}

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});

const num = (v: string) => {
  const n = parseFloat((v || "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

export function QuoteForm({ open, onClose, onSubmit, quote }: QuoteFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<QuoteInput>({
    date: quote.date,
    site: quote.site,
    address: quote.address,
    items: quote.items.length
      ? quote.items
      : [{ name: "", qty: "", unit: "", price: "" }],
  });

  const total = useMemo(
    () =>
      (formData.items || []).reduce((a, i) => a + num(i.qty) * num(i.price), 0),
    [formData.items]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu wyceny");
    } finally {
      setLoading(false);
    }
  };

  const setItem = (idx: number, field: keyof QuoteItem, value: string) =>
    setFormData((p) => ({
      ...p,
      items: (p.items || []).map((it, i) =>
        i === idx ? { ...it, [field]: value } : it
      ),
    }));

  const addItem = () =>
    setFormData((p) => ({
      ...p,
      items: [...(p.items || []), { name: "", qty: "", unit: "SZT", price: "" }],
    }));

  const removeItem = (idx: number) =>
    setFormData((p) => ({
      ...p,
      items: (p.items || []).filter((_, i) => i !== idx),
    }));

  const handlePrint = () =>
    printQuote({ ...quote, ...formData, items: formData.items || [] } as Quote);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-4 pr-6">
            <span>Wycena {quote.number}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePrint}
            >
              <Printer className="h-4 w-4 mr-2" />
              Drukuj / PDF
            </Button>
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="space-y-2 sm:col-span-1">
              <Label>Data *</Label>
              <Input
                type="date"
                value={formData.date}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, date: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Obiekt</Label>
              <Input
                value={formData.site}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, site: e.target.value }))
                }
                placeholder="np. Toyota Cygan Blizne Łaszczyńskiego"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Adres</Label>
            <Input
              value={formData.address}
              onChange={(e) =>
                setFormData((p) => ({ ...p, address: e.target.value }))
              }
              placeholder="np. Warszawska 13, Blizne Łaszczyńskiego"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Pozycje (usługi / sprzęt)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="h-4 w-4 mr-1" />
                Pozycja
              </Button>
            </div>
            <div className="space-y-2">
              {(formData.items || []).map((it, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                    {idx + 1}.
                  </span>
                  <Input
                    className="flex-1"
                    placeholder="Usługa / sprzęt"
                    value={it.name}
                    onChange={(e) => setItem(idx, "name", e.target.value)}
                  />
                  <Input
                    className="w-20"
                    placeholder="Ilość"
                    inputMode="decimal"
                    value={it.qty}
                    onChange={(e) => setItem(idx, "qty", e.target.value)}
                  />
                  <Input
                    className="w-20"
                    placeholder="J.M."
                    value={it.unit}
                    onChange={(e) => setItem(idx, "unit", e.target.value)}
                  />
                  <Input
                    className="w-24"
                    placeholder="Cena"
                    inputMode="decimal"
                    value={it.price}
                    onChange={(e) => setItem(idx, "price", e.target.value)}
                  />
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                    {num(it.qty) * num(it.price) > 0
                      ? pln.format(num(it.qty) * num(it.price))
                      : "—"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                    onClick={() => removeItem(idx)}
                    title="Usuń pozycję"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <div className="rounded-md bg-muted px-4 py-2 text-sm font-semibold tabular-nums">
              Razem (netto): {pln.format(total)}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie…" : "Zapisz"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
