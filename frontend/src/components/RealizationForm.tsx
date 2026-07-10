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
import type { Realization, RealizationInput, RealizationKind } from "@/lib/api";

interface RealizationFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: RealizationInput) => Promise<void>;
  realization?: Realization | null;
  defaultDate: string; // YYYY-MM-DD proponowana data dla nowego wpisu
  technicians?: string[]; // podpowiedzi dla pól Opiekun / Wykonawca
}

export function RealizationForm({
  open,
  onClose,
  onSubmit,
  realization,
  defaultDate,
  technicians = [],
}: RealizationFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<RealizationInput>({
    date: realization?.date || defaultDate,
    site: realization?.site || "",
    kind: realization?.kind || "service",
    amountHours: realization?.amountHours ?? "",
    amountMaterial: realization?.amountMaterial ?? "",
    amountKm: realization?.amountKm ?? "",
    discount: realization?.discount ?? "",
    note: realization?.note || "",
    invoiced: realization?.invoiced || false,
    invoicedAt: realization?.invoicedAt || "",
    caretaker: realization?.caretaker || "",
    contractor1: realization?.contractor1 || "",
    contractor2: realization?.contractor2 || "",
    actualHours: realization?.actualHours ?? "",
    actualKm: realization?.actualKm ?? "",
    hourlyCost: realization?.hourlyCost ?? "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu realizacji");
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {realization ? "Edytuj realizację" : "Nowa realizacja"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {technicians.length > 0 && (
            <datalist id="technicians-list">
              {technicians.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">Data *</Label>
              <Input
                id="date"
                name="date"
                type="date"
                value={formData.date}
                onChange={handleChange}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kind">Typ</Label>
              <select
                id="kind"
                name="kind"
                value={formData.kind}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    kind: e.target.value as RealizationKind,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="service">Serwis płatny</option>
                <option value="warranty">Serwis gwarancyjny / bezpłatny</option>
                <option value="installation">Montaż</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="site">Obiekt *</Label>
            <Input
              id="site"
              name="site"
              value={formData.site}
              onChange={handleChange}
              placeholder="np. STE Nasienna"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="amountHours">Kwota za godziny</Label>
              <Input
                id="amountHours"
                name="amountHours"
                type="number"
                step="0.01"
                min="0"
                value={formData.amountHours}
                onChange={handleChange}
                placeholder="0,00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amountMaterial">Materiały</Label>
              <Input
                id="amountMaterial"
                name="amountMaterial"
                type="number"
                step="0.01"
                min="0"
                value={formData.amountMaterial}
                onChange={handleChange}
                placeholder="0,00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amountKm">Kwota za KM</Label>
              <Input
                id="amountKm"
                name="amountKm"
                type="number"
                step="0.01"
                min="0"
                value={formData.amountKm}
                onChange={handleChange}
                placeholder="0,00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="discount">Rabat</Label>
              <Input
                id="discount"
                name="discount"
                type="number"
                step="0.01"
                min="0"
                value={formData.discount}
                onChange={handleChange}
                placeholder="0,00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">Adnotacja</Label>
            <Textarea
              id="note"
              name="note"
              value={formData.note || ""}
              onChange={handleChange}
              rows={2}
              placeholder="np. wymiana kamery"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="caretaker">Opiekun</Label>
              <Input
                id="caretaker"
                name="caretaker"
                list="technicians-list"
                value={formData.caretaker || ""}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contractor1">Wykonawca 1</Label>
              <Input
                id="contractor1"
                name="contractor1"
                list="technicians-list"
                value={formData.contractor1 || ""}
                onChange={handleChange}
                placeholder="np. D. Jaworski"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contractor2">Wykonawca 2</Label>
              <Input
                id="contractor2"
                name="contractor2"
                list="technicians-list"
                value={formData.contractor2 || ""}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="actualHours">Faktyczne godziny</Label>
              <Input
                id="actualHours"
                name="actualHours"
                type="number"
                step="0.25"
                min="0"
                value={formData.actualHours}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actualKm">Faktyczne KM</Label>
              <Input
                id="actualKm"
                name="actualKm"
                type="number"
                step="1"
                min="0"
                value={formData.actualKm}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hourlyCost">Koszt godzinowy</Label>
              <Input
                id="hourlyCost"
                name="hourlyCost"
                type="number"
                step="0.01"
                min="0"
                value={formData.hourlyCost}
                onChange={handleChange}
                placeholder="0,00"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 items-end gap-4">
            <label className="flex h-10 items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={formData.invoiced}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, invoiced: e.target.checked }))
                }
                className="h-4 w-4 accent-primary"
              />
              Zafakturowano
            </label>
            {formData.invoiced && (
              <div className="space-y-2">
                <Label htmlFor="invoicedAt">Data faktury</Label>
                <Input
                  id="invoicedAt"
                  name="invoicedAt"
                  type="date"
                  value={formData.invoicedAt || ""}
                  onChange={handleChange}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || !formData.site.trim()}>
              {loading
                ? "Zapisywanie…"
                : realization
                  ? "Zapisz zmiany"
                  : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
