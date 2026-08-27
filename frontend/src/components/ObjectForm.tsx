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
  type Contractor,
  type ObjectRecord,
  type ObjectInput,
} from "@/lib/api";
import {
  objectTypeLabels,
  installationTypeLabels,
  statusLabels,
  departmentLabels,
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
              <Label htmlFor="monthlyValue">Wartosc miesieczna (PLN)</Label>
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
