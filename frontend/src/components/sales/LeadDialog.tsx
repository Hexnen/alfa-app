/**
 * Formularz szansy sprzedaży — jeden dialog dla „nowej” i „edycji”.
 *
 * Układ idzie za pytaniami, które handlowiec i tak zadaje po kolei: co to za
 * temat (tytuł, etap, źródło) → dla kogo (kontrahent z kartoteki ALBO prospekt
 * bez kartoteki) → gdzie (rodzaj obiektu, adres, pinezka) → za ile (usługi,
 * abonament, wdrożenie, prawdopodobieństwo, termin) → kto prowadzi.
 *
 * Klient jest przełącznikiem, a nie dwoma zestawami pól naraz: dopóki nie ma
 * kartoteki, dane klienta żyją w polach `prospect*` i przenoszą się do
 * kontrahenta dopiero przy konwersji (`LeadConvertDialog`).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Banknote,
  Building2,
  Handshake,
  Loader2,
  MapPin,
  NotebookPen,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/ui/section";
import { LocationPicker } from "@/components/LocationPicker";
import {
  getContractorCatalog,
  getSalespeople,
  leadsApi,
  salespersonName,
  type ContractorCatalogEntry,
  type Lead,
  type LeadInput,
  type LeadService,
  type LeadSource,
  type LeadStage,
  type Salesperson,
} from "@/lib/api";
import { parseCoords } from "@/lib/maps-url";
import { OBJECT_KINDS } from "@/lib/orderIntakeSteps";
import {
  LEAD_SERVICES,
  LEAD_SERVICE_META,
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  LEAD_STAGE_META,
} from "@/lib/sales-labels";
import { pillClass } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

export type LeadDialogMode = "create" | "edit";

const SOURCES: LeadSource[] = ["polecenie", "www", "formularz", "telefon", "targi", "inne"];

const numOrNull = (v: string): number | null => {
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const intOrNull = (v: string): number | null => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

export function LeadDialog({
  open,
  mode,
  lead,
  defaultStage,
  defaultSalespersonId,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: LeadDialogMode;
  /** Szansa do edycji; null = nowa. */
  lead: Lead | null;
  /** Etap kolumny, z której wołano „+” na kanbanie. */
  defaultStage?: LeadStage;
  /** Handlowiec zalogowanego konta — nowa szansa trafia domyślnie do niego. */
  defaultSalespersonId?: number | null;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}) {
  const [title, setTitle] = useState(lead?.title ?? "");
  const [stage, setStage] = useState<LeadStage>(lead?.stage ?? defaultStage ?? "nowy");
  const [source, setSource] = useState<LeadSource | "none">(lead?.source ?? "none");
  const [clientMode, setClientMode] = useState<"contractor" | "prospect">(
    lead?.contractorId ? "contractor" : "prospect"
  );
  const [contractorId, setContractorId] = useState<number | null>(lead?.contractorId ?? null);
  const [prospectName, setProspectName] = useState(lead?.prospectName ?? "");
  const [prospectNip, setProspectNip] = useState(lead?.prospectNip ?? "");
  const [prospectPhone, setProspectPhone] = useState(lead?.prospectPhone ?? "");
  const [prospectEmail, setProspectEmail] = useState(lead?.prospectEmail ?? "");
  const [objectKind, setObjectKind] = useState(lead?.objectKind ?? "");
  const [address, setAddress] = useState(lead?.address ?? "");
  const [city, setCity] = useState(lead?.city ?? "");
  const [mapsUrl, setMapsUrl] = useState(lead?.mapsUrl ?? "");
  const [services, setServices] = useState<LeadService[]>(lead?.services ?? []);
  const [monthly, setMonthly] = useState(
    lead?.estimatedMonthly != null ? String(lead.estimatedMonthly) : ""
  );
  const [setup, setSetup] = useState(lead?.estimatedSetup != null ? String(lead.estimatedSetup) : "");
  const [probability, setProbability] = useState(
    lead?.probability != null ? String(lead.probability) : ""
  );
  const [closeDate, setCloseDate] = useState(lead?.expectedCloseDate ?? "");
  const [salespersonId, setSalespersonId] = useState<number | null>(
    lead?.salespersonId ?? defaultSalespersonId ?? null
  );
  const [notes, setNotes] = useState(lead?.notes ?? "");
  const [mapOpen, setMapOpen] = useState(false);

  const [catalog, setCatalog] = useState<ContractorCatalogEntry[]>([]);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    getContractorCatalog()
      .then((res) => setCatalog(res.data ?? []))
      .catch(() => setCatalog([]));
    getSalespeople(true)
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
  }, [open]);

  const toggleService = (s: LeadService) =>
    setServices((list) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]));

  const coords = useMemo(() => (mapsUrl ? parseCoords(mapsUrl) : null), [mapsUrl]);

  const clientSummary =
    clientMode === "contractor"
      ? catalog.find((c) => c.id === contractorId)?.name ?? "Kontrahent z kartoteki"
      : prospectName || "Prospekt bez kartoteki";

  const submit = async () => {
    if (!title.trim()) {
      setError("Szansa musi mieć tytuł — po nim rozpoznaje się ją na kanbanie.");
      return;
    }
    setBusy(true);
    setError(null);
    const payload: LeadInput = {
      title: title.trim(),
      stage,
      source: source === "none" ? null : source,
      // Prospekt i kontrahent wykluczają się wzajemnie — zapis czyści drugą stronę,
      // żeby karta nie pokazywała dwóch różnych klientów naraz.
      contractorId: clientMode === "contractor" ? contractorId : null,
      prospectName: clientMode === "prospect" ? prospectName.trim() || null : null,
      prospectNip: clientMode === "prospect" ? prospectNip.trim() || null : null,
      prospectPhone: clientMode === "prospect" ? prospectPhone.trim() || null : null,
      prospectEmail: clientMode === "prospect" ? prospectEmail.trim() || null : null,
      objectKind: objectKind || null,
      address: address.trim() || null,
      city: city.trim() || null,
      mapsUrl: mapsUrl.trim() || null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      services,
      estimatedMonthly: numOrNull(monthly),
      estimatedSetup: numOrNull(setup),
      probability: intOrNull(probability),
      expectedCloseDate: closeDate || null,
      salespersonId,
      notes: notes.trim() || null,
    };
    try {
      const res =
        mode === "create" || !lead
          ? await leadsApi.create(payload)
          : await leadsApi.update(lead.id, payload);
      if (!res.data) throw new Error("Backend nie zwrócił zapisanej szansy.");
      onSaved(res.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zapisać szansy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-3xl"
        data-testid="lead-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Handshake className="h-4 w-4" aria-hidden />
            {mode === "create" ? "Nowa szansa" : "Edycja szansy"}
          </DialogTitle>
          <DialogDescription>
            Kwoty netto (bez VAT). Abonament to główna metryka lejka — wdrożenie liczy się osobno.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Section icon={Handshake} title="Szansa" id="lead-form-basic">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="lead-title">Tytuł</Label>
                <Input
                  id="lead-title"
                  data-testid="lead-form-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Np. Monitoring — Wspólnota Kwiatowa 12"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-stage">Etap</Label>
                <Select value={stage} onValueChange={(v) => setStage(v as LeadStage)}>
                  <SelectTrigger id="lead-stage" data-testid="lead-form-stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_STAGES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {LEAD_STAGE_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-source">Źródło</Label>
                <Select value={source} onValueChange={(v) => setSource(v as LeadSource | "none")}>
                  <SelectTrigger id="lead-source" data-testid="lead-form-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nieznane</SelectItem>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {LEAD_SOURCE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-salesperson">Handlowiec</Label>
                <Select
                  value={salespersonId == null ? "none" : String(salespersonId)}
                  onValueChange={(v) => setSalespersonId(v === "none" ? null : Number(v))}
                >
                  <SelectTrigger id="lead-salesperson" data-testid="lead-form-salesperson">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Bez opiekuna</SelectItem>
                    {salespeople.map((sp) => (
                      <SelectItem key={sp.id} value={String(sp.id)}>
                        {salespersonName(sp)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Section>

          <Section
            icon={Users}
            title="Klient"
            id="lead-form-client"
            summary={clientSummary}
            action={
              <div className="flex gap-1.5">
                {(
                  [
                    ["contractor", "Z kartoteki", Users],
                    ["prospect", "Prospekt", UserPlus],
                  ] as ["contractor" | "prospect", string, typeof Users][]
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setClientMode(key)}
                    aria-pressed={clientMode === key}
                    data-testid={`lead-form-client-${key}`}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
                      clientMode === key
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            {clientMode === "contractor" ? (
              <div className="space-y-1.5">
                <Label htmlFor="lead-contractor">Kontrahent</Label>
                <Select
                  value={contractorId == null ? "none" : String(contractorId)}
                  onValueChange={(v) => setContractorId(v === "none" ? null : Number(v))}
                >
                  <SelectTrigger id="lead-contractor" data-testid="lead-form-contractor">
                    <SelectValue placeholder="Wybierz kontrahenta…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Bez kontrahenta</SelectItem>
                    {catalog.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                        {c.nip ? ` — ${c.nip}` : ""}
                        {!c.active ? " (archiwalny)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="lead-prospect-name">Nazwa klienta</Label>
                  <Input
                    id="lead-prospect-name"
                    data-testid="lead-form-prospect-name"
                    value={prospectName}
                    onChange={(e) => setProspectName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-prospect-nip">NIP (opcjonalnie)</Label>
                  <Input
                    id="lead-prospect-nip"
                    inputMode="numeric"
                    value={prospectNip}
                    onChange={(e) => setProspectNip(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-prospect-phone">Telefon</Label>
                  <Input
                    id="lead-prospect-phone"
                    value={prospectPhone}
                    onChange={(e) => setProspectPhone(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-prospect-email">E-mail</Label>
                  <Input
                    id="lead-prospect-email"
                    type="email"
                    value={prospectEmail}
                    onChange={(e) => setProspectEmail(e.target.value)}
                  />
                </div>
              </div>
            )}
          </Section>

          <Section icon={Building2} title="Obiekt" id="lead-form-object">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="lead-object-kind">Rodzaj obiektu</Label>
                <Select value={objectKind || "none"} onValueChange={(v) => setObjectKind(v === "none" ? "" : v)}>
                  <SelectTrigger id="lead-object-kind" data-testid="lead-form-object-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nieokreślony</SelectItem>
                    {OBJECT_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-city">Miasto</Label>
                <Input
                  id="lead-city"
                  data-testid="lead-form-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="lead-address">Adres</Label>
                <Input
                  id="lead-address"
                  data-testid="lead-form-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
            </div>
          </Section>

          {/* Mapa montuje się dopiero po rozwinięciu — Leaflet w zamkniętej
              sekcji kosztowałby tyle samo, a nikt by go nie oglądał. */}
          <Section
            icon={MapPin}
            title="Pinezka"
            id="lead-form-map"
            open={mapOpen}
            onToggle={() => setMapOpen((o) => !o)}
            summary={mapsUrl ? "ustawiona" : "brak"}
          >
            <LocationPicker
              value={mapsUrl}
              initialAddress={address}
              onChange={(url) => setMapsUrl(url)}
              onAddress={(addr, cityName) => {
                setAddress(addr);
                if (cityName) setCity(cityName);
              }}
            />
          </Section>

          <Section icon={Banknote} title="Wartość" id="lead-form-value">
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Usługi</Label>
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_SERVICES.map((s) => {
                    const meta = LEAD_SERVICE_META[s];
                    const on = services.includes(s);
                    const Icon = meta.icon;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleService(s)}
                        aria-pressed={on}
                        data-testid={`lead-form-service-${s}`}
                        className={cn(
                          pillClass(on ? meta.tone : "muted"),
                          "border transition-colors",
                          on ? "border-transparent" : "border-dashed opacity-70 hover:opacity-100"
                        )}
                      >
                        <Icon className="h-3 w-3" aria-hidden />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="lead-monthly">Abonament (zł/mies.)</Label>
                  <Input
                    id="lead-monthly"
                    data-testid="lead-form-monthly"
                    inputMode="decimal"
                    className="tabular-nums"
                    value={monthly}
                    onChange={(e) => setMonthly(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-setup">Wdrożenie (zł)</Label>
                  <Input
                    id="lead-setup"
                    data-testid="lead-form-setup"
                    inputMode="decimal"
                    className="tabular-nums"
                    value={setup}
                    onChange={(e) => setSetup(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-probability">Szansa (%)</Label>
                  <Input
                    id="lead-probability"
                    data-testid="lead-form-probability"
                    inputMode="numeric"
                    className="tabular-nums"
                    value={probability}
                    onChange={(e) => setProbability(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-close">Przewidywane zamknięcie</Label>
                  <Input
                    id="lead-close"
                    data-testid="lead-form-close"
                    type="date"
                    value={closeDate}
                    onChange={(e) => setCloseDate(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </Section>

          <Section icon={NotebookPen} title="Notatka" id="lead-form-notes">
            <Textarea
              rows={4}
              data-testid="lead-form-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ustalenia, potrzeby klienta, konkurencja… (obsługiwany prosty markdown)"
            />
          </Section>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="lead-form-submit">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Zapisz
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LeadDialog;
