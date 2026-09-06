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
import { COMPANY_FALLBACK_VALUES, type Company, type CompanyData, type CompanyInput } from "@/lib/api";

/** Narzuty składek pracodawcy obowiązujące globalnie (Administracja → Firma). */
export interface EmployerMarkupGlobals {
  uop: number;
  zua: number;
  zza: number;
}

const DEFAULT_MARKUP_GLOBALS: EmployerMarkupGlobals = {
  uop: COMPANY_FALLBACK_VALUES.employerMarkupUop,
  zua: COMPANY_FALLBACK_VALUES.employerMarkupZlecenieZua,
  zza: COMPANY_FALLBACK_VALUES.employerMarkupZlecenieZza,
};

interface CompanyFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CompanyInput) => Promise<void>;
  company?: Company | null;
  /** Wartości globalne — pokazujemy je jako placeholder w polach narzutów. */
  globalMarkups?: EmployerMarkupGlobals;
}

/** Pole narzutu w formularzu przyjmuje tekst — puste znaczy „dziedzicz globalne”. */
const markupToInput = (v: number | null | undefined) => (v == null ? "" : String(v));

export function CompanyForm({
  open,
  onClose,
  onSubmit,
  company,
  globalMarkups = DEFAULT_MARKUP_GLOBALS,
}: CompanyFormProps) {
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

  // Narzuty trzymamy jako tekst, bo pusty input ma znaczenie („użyj globalnego”),
  // a liczba tego nie wyrazi.
  const [markups, setMarkups] = useState({
    uop: markupToInput(company?.employerMarkupUop),
    zua: markupToInput(company?.employerMarkupZlecenieZua),
    zza: markupToInput(company?.employerMarkupZlecenieZza),
  });
  const [markupError, setMarkupError] = useState<string | null>(null);

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

  /** "" → null (dziedzicz globalne); liczba musi mieścić się w 1–3. */
  const parseMarkup = (raw: string): number | null | "error" => {
    const t = raw.trim().replace(",", ".");
    if (!t) return null;
    const n = parseFloat(t);
    if (!Number.isFinite(n) || n < 1 || n > 3) return "error";
    return n;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const uop = parseMarkup(markups.uop);
    const zua = parseMarkup(markups.zua);
    const zza = parseMarkup(markups.zza);
    if (uop === "error" || zua === "error" || zza === "error") {
      setMarkupError(
        "Narzut musi być liczbą od 1 do 3 (1 = koszt równy wypłacie). Zostaw pole puste, żeby użyć wartości globalnej."
      );
      return;
    }
    setMarkupError(null);
    setLoading(true);
    try {
      await onSubmit({
        ...formData,
        employerMarkupUop: uop,
        employerMarkupZlecenieZua: zua,
        employerMarkupZlecenieZza: zza,
      });
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

          {/* Nadpisania narzutów składek — puste pole dziedziczy wartość globalną
              z Administracja → Firma → Składki pracodawcy. */}
          <div className="space-y-2 rounded-md border p-3">
            <div>
              <Label className="text-sm font-medium">Składki pracodawcy (opcjonalnie)</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Mnożnik, którym z wypłaty netto szacujemy pełny koszt zatrudnienia w tej spółce.
                <strong> Puste = wartość globalna</strong> z Administracja → Firma.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="company-markup-uop" className="text-xs">
                  Umowa o pracę
                </Label>
                <Input
                  id="company-markup-uop"
                  data-testid="company-markup-uop"
                  type="number"
                  step="0.01"
                  min="1"
                  max="3"
                  className="tabular-nums"
                  placeholder={String(globalMarkups.uop)}
                  value={markups.uop}
                  onChange={(e) => setMarkups((p) => ({ ...p, uop: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="company-markup-zua" className="text-xs">
                  Zlecenie ZUA
                </Label>
                <Input
                  id="company-markup-zua"
                  data-testid="company-markup-zua"
                  type="number"
                  step="0.01"
                  min="1"
                  max="3"
                  className="tabular-nums"
                  placeholder={String(globalMarkups.zua)}
                  value={markups.zua}
                  onChange={(e) => setMarkups((p) => ({ ...p, zua: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="company-markup-zza" className="text-xs">
                  Zlecenie ZZA
                </Label>
                <Input
                  id="company-markup-zza"
                  data-testid="company-markup-zza"
                  type="number"
                  step="0.01"
                  min="1"
                  max="3"
                  className="tabular-nums"
                  placeholder={String(globalMarkups.zza)}
                  value={markups.zza}
                  onChange={(e) => setMarkups((p) => ({ ...p, zza: e.target.value }))}
                />
              </div>
            </div>
            {markupError && <p className="text-xs text-destructive">{markupError}</p>}
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
