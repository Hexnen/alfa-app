import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import type { Salesperson, SalespersonInput } from "@/lib/api";

interface SalespersonFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: SalespersonInput) => Promise<void>;
  salesperson?: Salesperson | null;
}

/** Formularz handlowca — ten sam układ, co formularz technika. */
export function SalespersonForm({
  open,
  onClose,
  onSubmit,
  salesperson,
}: SalespersonFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<SalespersonInput>({
    firstName: salesperson?.firstName || "",
    lastName: salesperson?.lastName || "",
    phone: salesperson?.phone || "",
    email: salesperson?.email || "",
    region: salesperson?.region || "",
    monthlyCost: salesperson?.monthlyCost ?? null,
    commissionRate: salesperson?.commissionRate ?? null,
    notes: salesperson?.notes || "",
    active: salesperson?.active ?? true,
  });

  const setField = (name: keyof SalespersonInput, value: unknown) =>
    setFormData((p) => ({ ...p, [name]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu handlowca");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {salesperson ? "Edytuj handlowca" : "Nowy handlowiec"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="salesperson-first-name">Imię</Label>
              <Input
                id="salesperson-first-name"
                value={formData.firstName}
                onChange={(e) => setField("firstName", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="salesperson-last-name">Nazwisko *</Label>
              <Input
                id="salesperson-last-name"
                data-testid="salesperson-last-name"
                value={formData.lastName}
                onChange={(e) => setField("lastName", e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="salesperson-phone">Telefon</Label>
              <Input
                id="salesperson-phone"
                value={formData.phone}
                onChange={(e) => setField("phone", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="salesperson-email">E-mail</Label>
              <Input
                id="salesperson-email"
                type="email"
                value={formData.email}
                onChange={(e) => setField("email", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="salesperson-region">Region / obszar</Label>
            <Input
              id="salesperson-region"
              placeholder="np. Małopolska, klienci sieciowi"
              value={formData.region}
              onChange={(e) => setField("region", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="salesperson-monthly-cost">Koszt miesięczny (PLN)</Label>
                {/* Puste pole to „nieuzupełniony”, więc `null`, a nie 0 zł. */}
                <Input
                  id="salesperson-monthly-cost"
                  data-testid="salesperson-monthly-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  className="tabular-nums"
                  value={formData.monthlyCost ?? ""}
                  onChange={(e) =>
                    setField("monthlyCost", e.target.value === "" ? null : Number(e.target.value))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salesperson-commission">Prowizja (%)</Label>
                <Input
                  id="salesperson-commission"
                  data-testid="salesperson-commission"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  className="tabular-nums"
                  value={formData.commissionRate ?? ""}
                  onChange={(e) =>
                    setField("commissionRate", e.target.value === "" ? null : Number(e.target.value))
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Wynagrodzenie, auto, telefon — używane w Analityce do liczenia zysku portfela.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="salesperson-notes">Notatki</Label>
            <Textarea
              id="salesperson-notes"
              rows={3}
              value={formData.notes}
              onChange={(e) => setField("notes", e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={formData.active ?? true}
              onChange={(e) => setField("active", e.target.checked)}
            />
            Aktualny (odznacz, żeby przenieść do archiwum)
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie..." : "Zapisz"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
