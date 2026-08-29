import { useState, useEffect } from "react";
import { Loader2, MapPin } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { tip } from "./ui/tooltip";
import {
  adminCompanyApi,
  errStatus,
  getContractors,
  getSalespeople,
  salespersonName,
  getCompanies,
  type Company,
  type Salesperson,
  type Contractor,
  type ObjectRecord,
  type ObjectInput,
} from "@/lib/api";
import {
  objectTypeLabels,
  installationTypeLabels,
  statusLabels,
  departmentLabels,
  formatCurrency,
} from "@/lib/utils";

/**
 * Geokodowanie adresu obiektu. Najpierw backend (`/admin/company/geocode`) —
 * ma cache w `geo_cache` i własny User-Agent. Endpoint jest jednak zamknięty
 * dla adminów, więc pozostałym użytkownikom zostaje zapytanie prosto z
 * przeglądarki do Nominatim, tak jak robi to już `LocationPicker`.
 */
async function geocodeAddress(query: string): Promise<{ lat: number; lng: number; display?: string }> {
  try {
    return await adminCompanyApi.geocode({ query });
  } catch (e) {
    const status = errStatus(e);
    // 403 = nie admin, 404 = starszy backend bez geokodera. Inne błędy (np. „nie
    // znaleziono adresu”) są merytoryczne — nie ma po co pytać drugi raz.
    if (status !== 403 && status !== 404) throw e;
  }
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pl&countrycodes=pl&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geokoder nie odpowiedział");
  const hits = (await res.json()) as { lat: string; lon: string; display_name?: string }[];
  const hit = hits?.[0];
  if (!hit) throw new Error("Nie znaleziono tego adresu");
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), display: hit.display_name };
}

/** Współrzędna z inputa: pusty → null, żeby backend wiedział „wyczyść”. */
const parseCoord = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/**
 * Kwota kosztu z inputa. Pusty → `null`, czyli „nieuzupełniony” — i tylko `null`
 * potrafi wyczyścić koszt po stronie backendu (`undefined` wypada z JSON-a,
 * więc stara wartość by została). 0 zł to świadomy wpis, nie brak danych.
 */
const parseCost = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

interface ObjectFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ObjectInput) => Promise<void>;
  object?: ObjectRecord | null;
  preselectedContractorId?: number;
}

export function ObjectForm({
  open,
  onClose,
  onSubmit,
  object,
  preselectedContractorId,
}: ObjectFormProps) {
  const [loading, setLoading] = useState(false);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [formData, setFormData] = useState<ObjectInput>({
    contractorId: object?.contractorId || preselectedContractorId || 0,
    name: object?.name || "",
    address: object?.address || "",
    city: object?.city || "",
    type: object?.type || "monitoring",
    installationType: object?.installationType || "new",
    status: object?.status || "pending",
    department: object?.department || "sales",
    monthlyValue: object?.monthlyValue || undefined,
    monthlyCost: object?.monthlyCost ?? null,
    setupCost: object?.setupCost ?? null,
    salespersonId: object?.salespersonId ?? null,
    companyId: object?.companyId ?? null,
    notes: object?.notes || "",
    latitude: object?.latitude ?? null,
    longitude: object?.longitude ?? null,
  });
  /** Stan przycisku „Ustal z adresu” + komunikat pod polami współrzędnych. */
  const [geocoding, setGeocoding] = useState(false);
  const [geoNote, setGeoNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      getContractors({ pageSize: 1000 }).then((res) => {
        setContractors(res.data);
      });
      // Archiwalnych nie proponujemy, ale zostawiamy tego, który już jest przypisany.
      getSalespeople()
        .then((res) => setSalespeople(res.data ?? []))
        .catch(() => setSalespeople([]));
      getCompanies()
        .then((res) => setCompanies(res.data ?? []))
        .catch(() => setCompanies([]));
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.contractorId) {
      alert("Wybierz kontrahenta");
      return;
    }
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
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "number" ? (value ? parseFloat(value) : undefined) : value,
    }));
  };

  const handleSelectChange = (name: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [name]: name === "contractorId" ? parseInt(value) : value,
    }));
  };

  const addressLine = [formData.address, formData.city].map((s) => (s || "").trim()).filter(Boolean).join(", ");

  /**
   * Podpowiedź pod parą „wartość / koszt”. Pusty koszt to brak danych, a nie 0 zł
   * — wtedy marży nie da się policzyć i mówimy o tym wprost.
   */
  const marginHint = (() => {
    const value = formData.monthlyValue;
    const cost = formData.monthlyCost;
    if (cost === null || cost === undefined) return "Marża: — (uzupełnij koszt)";
    if (value === null || value === undefined) return "Marża: — (uzupełnij wartość miesięczną)";
    const profit = value - cost;
    const pct = value > 0 ? Math.round((profit / value) * 100) : null;
    let text = `Marża: ${formatCurrency(profit)}${pct !== null ? ` (${pct}%)` : ""}`;
    const setup = formData.setupCost;
    if (setup !== null && setup !== undefined && profit > 0) {
      text += ` · zwrot instalacji: ${Math.ceil(setup / profit)} mies.`;
    }
    return text;
  })();

  const runGeocode = async () => {
    if (!addressLine) return;
    setGeocoding(true);
    setGeoNote(null);
    try {
      const hit = await geocodeAddress(addressLine);
      setFormData((prev) => ({ ...prev, latitude: hit.lat, longitude: hit.lng }));
      setGeoNote(hit.display ? `Znaleziono: ${hit.display}` : "Współrzędne ustalone.");
    } catch (error) {
      setGeoNote(error instanceof Error ? error.message : "Nie udało się ustalić współrzędnych");
    } finally {
      setGeocoding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {object ? "Edytuj obiekt" : "Nowy obiekt"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="contractorId">Kontrahent *</Label>
              <Select
                value={formData.contractorId?.toString() || ""}
                onValueChange={(value) =>
                  handleSelectChange("contractorId", value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Wybierz kontrahenta" />
                </SelectTrigger>
                <SelectContent>
                  {contractors.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()}>
                      {c.name} ({c.nip})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Nazwa obiektu *</Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="address">Adres</Label>
                <Input
                  id="address"
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">Miasto</Label>
                <Input
                  id="city"
                  name="city"
                  value={formData.city}
                  onChange={handleChange}
                />
              </div>
            </div>

            {/* Współrzędne — z nich liczy się dystans biuro → obiekt (kilometry
                w realizacjach). Puste = automat ustali je sam przy kalkulacji. */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="latitude">Szerokość (lat)</Label>
                  <Input
                    id="latitude"
                    name="latitude"
                    data-testid="object-latitude"
                    type="number"
                    step="0.000001"
                    className="w-40 tabular-nums"
                    placeholder="np. 52.406374"
                    value={formData.latitude ?? ""}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, latitude: parseCoord(e.target.value) }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="longitude">Długość (lng)</Label>
                  <Input
                    id="longitude"
                    name="longitude"
                    data-testid="object-longitude"
                    type="number"
                    step="0.000001"
                    className="w-40 tabular-nums"
                    placeholder="np. 16.925168"
                    value={formData.longitude ?? ""}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, longitude: parseCoord(e.target.value) }))
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="object-geocode"
                  disabled={geocoding || !addressLine}
                  onClick={() => void runGeocode()}
                  {...tip(
                    addressLine
                      ? `Zapytaj geokoder o współrzędne dla: ${addressLine}`
                      : "Najpierw wpisz adres albo miasto"
                  )}
                >
                  {geocoding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <MapPin className="mr-2 h-4 w-4" aria-hidden />
                  )}
                  Ustal z adresu
                </Button>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="object-geo-note">
                {geoNote ??
                  "Z tych współrzędnych automat liczy kilometry biuro → obiekt. Puste pola uzupełni sam przy pierwszej kalkulacji."}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="type">Typ ochrony *</Label>
                <Select
                  value={formData.type}
                  onValueChange={(value) => handleSelectChange("type", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(objectTypeLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="installationType">Typ instalacji *</Label>
                <Select
                  value={formData.installationType}
                  onValueChange={(value) =>
                    handleSelectChange("installationType", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(installationTypeLabels).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value) => handleSelectChange("status", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="department">Dzial</Label>
                <Select
                  value={formData.department}
                  onValueChange={(value) =>
                    handleSelectChange("department", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(departmentLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="object-company">Spółka</Label>
              <Select
                value={formData.companyId ? String(formData.companyId) : "none"}
                onValueChange={(value) =>
                  setFormData((p) => ({
                    ...p,
                    companyId: value === "none" ? null : parseInt(value),
                  }))
                }
              >
                <SelectTrigger id="object-company" data-testid="object-company">
                  <SelectValue placeholder="Bez spółki" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Bez spółki</SelectItem>
                  {companies
                    .filter((co) => co.active || co.id === formData.companyId)
                    .map((co) => (
                      <SelectItem key={co.id} value={String(co.id)}>
                        {co.name}
                        {!co.active ? " (archiwalna)" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Spółka grupy obsługująca obiekt — ten sam słownik, co w kadrach.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="object-salesperson">Handlowiec</Label>
              <Select
                value={formData.salespersonId ? String(formData.salespersonId) : "inherit"}
                onValueChange={(value) =>
                  setFormData((p) => ({
                    ...p,
                    salespersonId: value === "inherit" ? null : parseInt(value),
                  }))
                }
              >
                <SelectTrigger id="object-salesperson" data-testid="object-salesperson">
                  <SelectValue placeholder="Opiekun kontrahenta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Jak u kontrahenta</SelectItem>
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
                Puste = obiekt dziedziczy opiekuna przypisanego kontrahentowi.
              </p>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="monthlyValue">Wartość miesięczna (PLN)</Label>
                  <Input
                    id="monthlyValue"
                    name="monthlyValue"
                    type="number"
                    step="0.01"
                    value={formData.monthlyValue || ""}
                    onChange={handleChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="monthlyCost">Koszt miesięczny (PLN)</Label>
                  {/* `?? ""` zamiast `|| ""` — 0 zł to świadomy wpis („obiekt nic
                      nie kosztuje”), a `|| ""` zamieniałby go w puste pole. */}
                  <Input
                    id="monthlyCost"
                    name="monthlyCost"
                    data-testid="object-monthly-cost"
                    type="number"
                    step="0.01"
                    min="0"
                    className="tabular-nums"
                    value={formData.monthlyCost ?? ""}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, monthlyCost: parseCost(e.target.value) }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="setupCost">Koszt instalacji / wdrożenia (PLN, jednorazowo)</Label>
                <Input
                  id="setupCost"
                  name="setupCost"
                  data-testid="object-setup-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  className="tabular-nums"
                  value={formData.setupCost ?? ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, setupCost: parseCost(e.target.value) }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground" data-testid="object-margin-hint">
                {marginHint}
              </p>
            </div>
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
