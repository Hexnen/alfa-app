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
import { Badge } from "./ui/badge";
import { NIPField } from "./NIPField";
import type { Company, CompanyData, CompanyInput } from "@/lib/api";

interface CompanyFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CompanyInput) => Promise<void>;
  company?: Company | null;
}

export function CompanyForm({ open, onClose, onSubmit, company }: CompanyFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<CompanyInput>({
    name: company?.name || "",
    fullName: company?.fullName || "",
    nip: company?.nip || "",
    regon: company?.regon || "",
    krs: company?.krs || "",
    address: company?.address || "",
    postalCode: company?.postalCode || "",
    city: company?.city || "",
    vatStatus: company?.vatStatus || "",
    vatCheckedAt: company?.vatCheckedAt || "",
    notes: company?.notes || "",
    active: company?.active ?? true,
  });

  /** „Wstaw dane” z wykazu VAT MF — ten sam walidator, co przy kontrahentach. */
  const applyCompany = (mf: CompanyData) => {
    setFormData((p) => ({
      ...p,
      nip: mf.nip,
      fullName: mf.name,
      regon: mf.regon,
      krs: mf.krs,
      address: mf.address,
      postalCode: mf.postalCode,
      city: mf.city,
      vatStatus: mf.statusVat ?? "",
      vatCheckedAt: mf.date,
    }));
  };

  const setField = (name: keyof CompanyInput, value: unknown) =>
    setFormData((p) => ({ ...p, [name]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu spółki");
    } finally {
      setLoading(false);
    }
  };

  /** Zmiana nazwy dotyka też kadr — ostrzegamy, zanim ktoś ją zmieni w locie. */
  const renaming = !!company && formData.name.trim() !== company.name;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{company ? "Edytuj spółkę" : "Nowa spółka"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="company-name">Nazwa (skrót jak w kadrach) *</Label>
            <Input
              id="company-name"
              data-testid="company-name"
              placeholder="np. ALFA S, GUARD 21"
              value={formData.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
            {renaming && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Zmiana nazwy przepisze też wiersze w kadrach (umowy i wynagrodzenia biura),
                które wskazują na „{company?.name}”.
              </p>
            )}
          </div>

          {/* NIP z walidacją sumy kontrolnej i pobraniem danych z wykazu VAT MF. */}
          <NIPField
            value={formData.nip ?? ""}
            onChange={(nip) => setField("nip", nip)}
            onCompanyFound={applyCompany}
            checkExisting={false}
            id="company-nip"
          />

          <div className="space-y-2">
            <Label htmlFor="company-full-name">Pełna nazwa</Label>
            <Input
              id="company-full-name"
              placeholder="np. ALFA GROUP Sp. z o.o."
              value={formData.fullName}
              onChange={(e) => setField("fullName", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="company-address">Ulica i numer</Label>
              <Input
                id="company-address"
                value={formData.address}
                onChange={(e) => setField("address", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-postal">Kod pocztowy</Label>
              <Input
                id="company-postal"
                value={formData.postalCode}
                onChange={(e) => setField("postalCode", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-city">Miejscowość</Label>
              <Input
                id="company-city"
                value={formData.city}
                onChange={(e) => setField("city", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="company-regon">REGON</Label>
              <Input
                id="company-regon"
                value={formData.regon}
                onChange={(e) => setField("regon", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-krs">KRS</Label>
              <Input
                id="company-krs"
                value={formData.krs}
                onChange={(e) => setField("krs", e.target.value)}
              />
            </div>
          </div>

          {formData.vatStatus && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge
                variant={
                  formData.vatStatus === "Czynny"
                    ? "success"
                    : formData.vatStatus === "Zwolniony"
                      ? "warning"
                      : "destructive"
                }
              >
                VAT: {formData.vatStatus}
              </Badge>
              {formData.vatCheckedAt && <span>sprawdzono w wykazie MF {formData.vatCheckedAt}</span>}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="company-notes">Notatki</Label>
            <Textarea
              id="company-notes"
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
            Aktualna (odznacz, żeby przenieść do archiwum)
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
