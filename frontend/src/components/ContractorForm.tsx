import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { NIPField } from "./NIPField";
import { getSalespeople, salespersonName } from "@/lib/api";
import type {
  CompanyData,
  Contractor,
  ContractorInput,
  Salesperson,
} from "@/lib/api";

interface ContractorFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ContractorInput) => Promise<void>;
  contractor?: Contractor | null;
}

export function ContractorForm({
  open,
  onClose,
  onSubmit,
  contractor,
}: ContractorFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<ContractorInput>({
    name: contractor?.name || "",
    nip: contractor?.nip || "",
    address: contractor?.address || "",
    city: contractor?.city || "",
    postalCode: contractor?.postalCode || "",
    phone: contractor?.phone || "",
    email: contractor?.email || "",
    contactPerson: contractor?.contactPerson || "",
    notes: contractor?.notes || "",
    regon: contractor?.regon || "",
    krs: contractor?.krs || "",
    vatStatus: contractor?.vatStatus || "",
    vatCheckedAt: contractor?.vatCheckedAt || "",
    salespersonId: contractor?.salespersonId ?? null,
  });
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);

  useEffect(() => {
    if (!open) return;
    getSalespeople()
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      console.error("Error submitting form:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  /**
   * Wstawia dane z wykazu MF. Pola wypełnione ręcznie nadpisujemy tylko wtedy,
   * gdy rejestr faktycznie coś zwrócił — pusty rekord nie może wyczyścić formularza.
   */
  const applyCompany = (company: CompanyData) => {
    setFormData((prev) => ({
      ...prev,
      name: company.name || prev.name,
      nip: company.nip || prev.nip,
      address: company.address || prev.address,
      city: company.city || prev.city,
      postalCode: company.postalCode || prev.postalCode,
      regon: company.regon || prev.regon,
      krs: company.krs || prev.krs,
      vatStatus: company.statusVat || "",
      vatCheckedAt: company.date,
    }));
  };

  const vatVariant =
    formData.vatStatus === "Czynny"
      ? "success"
      : formData.vatStatus === "Zwolniony"
      ? "warning"
      : "destructive";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {contractor ? "Edytuj kontrahenta" : "Nowy kontrahent"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            {/* NIP na górze: wpisanie go podpowiada resztę danych z wykazu MF. */}
            <NIPField
              value={formData.nip}
              onChange={(nip) => setFormData((prev) => ({ ...prev, nip }))}
              onCompanyFound={applyCompany}
              // W trybie edycji kontrahent znalazłby sam siebie jako „już istnieje”.
              checkExisting={!contractor}
              id="contractor-nip"
            />
            <div className="space-y-2">
              <Label htmlFor="name">Nazwa firmy *</Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Adres</Label>
              <Input
                id="address"
                name="address"
                value={formData.address}
                onChange={handleChange}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">Miasto</Label>
                <Input
                  id="city"
                  name="city"
                  value={formData.city}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="postalCode">Kod pocztowy</Label>
                <Input
                  id="postalCode"
                  name="postalCode"
                  value={formData.postalCode}
                  onChange={handleChange}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Telefon</Label>
                <Input
                  id="phone"
                  name="phone"
                  value={formData.phone}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleChange}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="contractor-salesperson">Handlowiec (opiekun klienta)</Label>
              <Select
                value={formData.salespersonId ? String(formData.salespersonId) : "none"}
                onValueChange={(value) =>
                  setFormData((p) => ({
                    ...p,
                    salespersonId: value === "none" ? null : parseInt(value),
                  }))
                }
              >
                <SelectTrigger id="contractor-salesperson" data-testid="contractor-salesperson">
                  <SelectValue placeholder="Bez opiekuna" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Bez opiekuna</SelectItem>
                  {salespeople
                    .filter((sp) => sp.active || sp.id === formData.salespersonId)
                    .map((sp) => (
                      <SelectItem key={sp.id} value={String(sp.id)}>
                        {salespersonName(sp)}
                        {!sp.active ? " (archiwalny)" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Obiekty tego klienta dziedziczą opiekuna, dopóki nie wskażesz przy nich kogoś innego.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactPerson">Osoba kontaktowa</Label>
              <Input
                id="contactPerson"
                name="contactPerson"
                value={formData.contactPerson}
                onChange={handleChange}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="regon">REGON</Label>
                <Input
                  id="regon"
                  name="regon"
                  value={formData.regon}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="krs">KRS</Label>
                <Input
                  id="krs"
                  name="krs"
                  value={formData.krs}
                  onChange={handleChange}
                />
              </div>
            </div>
            {formData.vatStatus && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={vatVariant}>VAT: {formData.vatStatus}</Badge>
                {formData.vatCheckedAt && (
                  <span>sprawdzono w wykazie MF {formData.vatCheckedAt}</span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="notes">Uwagi</Label>
              <Textarea
                id="notes"
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows={3}
              />
            </div>
          </div>
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
