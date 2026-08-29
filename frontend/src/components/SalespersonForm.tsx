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
import type { HrEmployeeRef, Salesperson, SalespersonInput } from "@/lib/api";

interface SalespersonFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: SalespersonInput) => Promise<void>;
  salesperson?: Salesperson | null;
  /** Pracownicy z kadr do powiązania; pusta lista = pole pokazuje tylko „bez powiązania". */
  employees?: HrEmployeeRef[];
}

/** Formularz handlowca — ten sam układ, co formularz technika. */
export function SalespersonForm({
  open,
  onClose,
  onSubmit,
  salesperson,
  employees = [],
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
    employeeId: salesperson?.employeeId ?? null,
    notes: salesperson?.notes || "",
    active: salesperson?.active ?? true,
  });

  const setField = (name: keyof SalespersonInput, value: unknown) =>
    setFormData((p) => ({ ...p, [name]: value }));

  /**
   * Handlowiec z listy płac: koszt własny liczy się z jego wypłat w Kadrach,
   * więc ręczne pole kosztu jest zablokowane. Inaczej ten sam człowiek
   * kosztowałby firmę dwa razy — raz w Kadrach, raz w Analityce.
   */
  const onPayroll = formData.employeeId != null;

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
            <Label htmlFor="salesperson-employee">Pracownik w kadrach</Label>
            <select
              id="salesperson-employee"
              data-testid="salesperson-employee"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={formData.employeeId ?? ""}
              onChange={(e) =>
                setField("employeeId", e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">— bez powiązania (spoza listy płac) —</option>
              {employees
                .filter((e) => e.active || e.id === salesperson?.employeeId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                    {e.active ? "" : " (nieaktywny)"}
                  </option>
                ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Powiąż, jeśli handlowiec jest na liście płac — wtedy jego koszt
              bierze się z wypłat w Kadrach. Zostaw puste dla osoby na własnej
              działalności i wpisz koszt ręcznie.
            </p>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                {/* „zł netto" jak w pozostałych polach kwotowych aplikacji.
                    Przy osobie z Kadr pole jest zablokowane, a kwota bierze się
                    z wypłat powiększonych o narzut składek pracodawcy; mówi
                    o tym podpis pod polem. */}
                <Label htmlFor="salesperson-monthly-cost">
                  Koszt miesięczny (zł netto)
                </Label>
                {/* Puste pole to „nieuzupełniony”, więc `null`, a nie 0 zł. */}
                <Input
                  id="salesperson-monthly-cost"
                  data-testid="salesperson-monthly-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  disabled={onPayroll}
                  className="tabular-nums"
                  value={formData.monthlyCost ?? ""}
                  onChange={(e) =>
                    setField("monthlyCost", e.target.value === "" ? null : Number(e.target.value))
                  }
                />
                {onPayroll && (
                  <p className="text-xs text-muted-foreground">
                    Liczone z Kadr — z wypłat tej osoby powiększonych o narzut
                    składek pracodawcy.
                  </p>
                )}
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
