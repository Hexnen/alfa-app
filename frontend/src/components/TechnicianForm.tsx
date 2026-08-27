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
import type { Technician, TechnicianInput, TechnicianType } from "@/lib/api";

interface TechnicianFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: TechnicianInput) => Promise<void>;
  technician?: Technician | null;
}

export function TechnicianForm({
  open,
  onClose,
  onSubmit,
  technician,
}: TechnicianFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<TechnicianInput>({
    firstName: technician?.firstName || "",
    lastName: technician?.lastName || "",
    phone: technician?.phone || "",
    email: technician?.email || "",
    company: technician?.company || "",
    nip: technician?.nip || "",
    type: technician?.type || "internal",
    notes: technician?.notes || "",
    active: technician?.active ?? true,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu technika");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {technician ? "Edytuj technika" : "Nowy technik"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tech-first-name">Imię</Label>
              <Input
                id="tech-first-name"
                value={formData.firstName}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, firstName: e.target.value }))
                }
                placeholder="np. Dominik"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tech-last-name">Nazwisko *</Label>
              <Input
                id="tech-last-name"
                value={formData.lastName}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, lastName: e.target.value }))
                }
                placeholder="np. Jaworski"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tech-type">Typ</Label>
              <select
                id="tech-type"
                value={formData.type}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    type: e.target.value as TechnicianType,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="internal">Wewnętrzny</option>
                <option value="external">Zewnętrzny</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tech-phone">Telefon</Label>
              <Input
                id="tech-phone"
                value={formData.phone || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, phone: e.target.value }))
                }
                placeholder="np. 600 100 200"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tech-email">E-mail</Label>
            <Input
              id="tech-email"
              type="email"
              value={formData.email || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, email: e.target.value }))
              }
              placeholder="np. jan@firma.pl"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tech-company">Firma</Label>
              <Input
                id="tech-company"
                value={formData.company || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, company: e.target.value }))
                }
                placeholder="np. Serwis-Tech sp. z o.o."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tech-nip">NIP</Label>
              <Input
                id="tech-nip"
                value={formData.nip || ""}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, nip: e.target.value }))
                }
                placeholder="np. 1234567890"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tech-notes">Notatka</Label>
            <Textarea
              id="tech-notes"
              value={formData.notes || ""}
              onChange={(e) =>
                setFormData((p) => ({ ...p, notes: e.target.value }))
              }
              rows={2}
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
            <Button type="submit" disabled={loading || !formData.lastName.trim()}>
              {loading
                ? "Zapisywanie…"
                : technician
                  ? "Zapisz zmiany"
                  : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
