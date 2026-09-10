/**
 * Wygrana szansa → kontrahent + obiekt (`POST /leads/:id/convert`).
 *
 * To jedyne miejsce w aplikacji, gdzie z lejka powstaje kartoteka, więc dialog
 * pokazuje OBA byty naraz: po lewej klient (z kartoteki albo nowy), po prawej
 * obiekt. Wszystko jest wstępnie wypełnione danymi szansy — handlowiec ma
 * potwierdzić, a nie przepisywać.
 *
 * Backend zakłada obiekt w dziale handlowym ze statusem „oczekujący” (technicy
 * dostają go po weryfikacji) i przepina do kontrahenta osoby kontaktowe szansy.
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, Loader2, Trophy, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  getContractorCatalog,
  leadsApi,
  type ContractorCatalogEntry,
  type Lead,
  type LeadConvertResult,
} from "@/lib/api";
import { validateNIP } from "@/lib/nip";
import { cn } from "@/lib/utils";

/** Tryb klienta: istniejący kontrahent z kartoteki albo świeżo zakładany. */
type ClientMode = "existing" | "new";

const numOrNull = (v: string): number | null => {
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function LeadConvertDialog({
  open,
  lead,
  onClose,
  onConverted,
}: {
  open: boolean;
  lead: Lead;
  onClose: () => void;
  /** Rodzic odświeża lejek/kartę i linkuje do świeżego obiektu. */
  onConverted: (result: LeadConvertResult) => void;
}) {
  const [mode, setMode] = useState<ClientMode>(lead.contractorId ? "existing" : "new");
  const [catalog, setCatalog] = useState<ContractorCatalogEntry[]>([]);
  const [contractorId, setContractorId] = useState<number | null>(lead.contractorId);
  const [cName, setCName] = useState(lead.prospectName ?? lead.title);
  const [cNip, setCNip] = useState(lead.prospectNip ?? "");
  const [cAddress, setCAddress] = useState(lead.address ?? "");
  const [cCity, setCCity] = useState(lead.city ?? "");
  const [cPostal, setCPostal] = useState("");
  const [cPhone, setCPhone] = useState(lead.prospectPhone ?? "");
  const [cEmail, setCEmail] = useState(lead.prospectEmail ?? "");

  const [oName, setOName] = useState(lead.title);
  const [oAddress, setOAddress] = useState(lead.address ?? "");
  const [oCity, setOCity] = useState(lead.city ?? "");
  const [oMonthlyZdw, setOMonthlyZdw] = useState(
    lead.estimatedMonthly != null ? String(lead.estimatedMonthly) : ""
  );
  const [oMonthlyOfi, setOMonthlyOfi] = useState("");
  const [oCameraCount, setOCameraCount] = useState("");
  const [oInstallation, setOInstallation] = useState<"new" | "takeover">("new");
  const services = lead.services ?? [];
  const [hasCameras, setHasCameras] = useState(services.includes("kamery"));
  const [hasSswin, setHasSswin] = useState(services.includes("sswin"));
  const [hasVideo, setHasVideo] = useState(services.includes("wideorecepcja"));
  const [hasOfi, setHasOfi] = useState(services.includes("ofi") || services.includes("ochrona"));
  const [markWon, setMarkWon] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    getContractorCatalog()
      .then((res) => setCatalog(res.data ?? []))
      .catch(() => setCatalog([]));
  }, [open]);

  // NIP sprawdzamy sumą kontrolną PRZED wysyłką — backend odrzuca błędny, a
  // wtedy przepadałby cały wypełniony formularz.
  const nipOk = useMemo(() => cNip.trim() === "" || validateNIP(cNip), [cNip]);

  const problems: string[] = [];
  if (!oName.trim()) problems.push("Obiekt musi mieć nazwę.");
  if (mode === "existing" && contractorId == null) problems.push("Wskaż kontrahenta z kartoteki.");
  if (mode === "new" && !cName.trim()) problems.push("Nowy kontrahent musi mieć nazwę.");
  if (mode === "new" && !cNip.trim()) problems.push("Nowy kontrahent musi mieć NIP — kartoteka stoi na NIP-ie.");
  if (mode === "new" && cNip.trim() && !nipOk) problems.push("NIP ma błędną sumę kontrolną.");

  const submit = async () => {
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await leadsApi.convert(lead.id, {
        contractorId: mode === "existing" ? contractorId : null,
        contractor:
          mode === "new"
            ? {
                name: cName.trim(),
                nip: cNip.trim() || null,
                address: cAddress.trim() || null,
                city: cCity.trim() || null,
                postalCode: cPostal.trim() || null,
                phone: cPhone.trim() || null,
                email: cEmail.trim() || null,
              }
            : undefined,
        object: {
          name: oName.trim(),
          address: oAddress.trim() || null,
          city: oCity.trim() || null,
          mapsUrl: lead.mapsUrl,
          monthlyZdw: numOrNull(oMonthlyZdw),
          monthlyOfi: numOrNull(oMonthlyOfi),
          hasCameras,
          hasSswin,
          hasVideoReception: hasVideo,
          hasOfi,
          cameraCount: numOrNull(oCameraCount),
          installationType: oInstallation,
        },
        markWon,
      });
      if (!res.data) throw new Error("Backend nie zwrócił wyniku konwersji.");
      onConverted(res.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się przekształcić szansy.");
    } finally {
      setBusy(false);
    }
  };

  const modeBtn = (key: ClientMode, label: string, Icon: typeof Users) => (
    <button
      key={key}
      type="button"
      onClick={() => setMode(key)}
      data-testid={`lead-convert-mode-${key}`}
      aria-pressed={mode === key}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
        mode === key ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="lead-convert-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-emerald-600" aria-hidden />
            Szansa wygrana — zakładamy klienta i obiekt
          </DialogTitle>
          <DialogDescription>
            „{lead.title}” — obiekt powstanie w dziale handlowym ze statusem „oczekujący”, a osoby
            kontaktowe szansy przejdą do kartoteki klienta.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Section
            icon={Users}
            title="Klient"
            id="lead-convert-client"
            action={
              <div className="flex gap-1.5">
                {modeBtn("existing", "Z kartoteki", Users)}
                {modeBtn("new", "Nowy kontrahent", UserPlus)}
              </div>
            }
          >
            {mode === "existing" ? (
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-contractor">Kontrahent</Label>
                <Select
                  value={contractorId == null ? "" : String(contractorId)}
                  onValueChange={(v) => setContractorId(Number(v))}
                >
                  <SelectTrigger id="lead-convert-contractor" data-testid="lead-convert-contractor">
                    <SelectValue placeholder="Wybierz kontrahenta…" />
                  </SelectTrigger>
                  <SelectContent>
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
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="lead-convert-cname">Nazwa</Label>
                  <Input
                    id="lead-convert-cname"
                    data-testid="lead-convert-cname"
                    value={cName}
                    onChange={(e) => setCName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-cnip">NIP</Label>
                  <Input
                    id="lead-convert-cnip"
                    data-testid="lead-convert-cnip"
                    value={cNip}
                    inputMode="numeric"
                    onChange={(e) => setCNip(e.target.value)}
                    className={cn(!nipOk && "border-destructive")}
                  />
                  {!nipOk && (
                    <p className="text-xs text-destructive">Błędna suma kontrolna NIP-u.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-cpostal">Kod pocztowy</Label>
                  <Input
                    id="lead-convert-cpostal"
                    value={cPostal}
                    onChange={(e) => setCPostal(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-caddress">Adres</Label>
                  <Input
                    id="lead-convert-caddress"
                    value={cAddress}
                    onChange={(e) => setCAddress(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-ccity">Miasto</Label>
                  <Input
                    id="lead-convert-ccity"
                    value={cCity}
                    onChange={(e) => setCCity(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-cphone">Telefon</Label>
                  <Input
                    id="lead-convert-cphone"
                    value={cPhone}
                    onChange={(e) => setCPhone(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lead-convert-cemail">E-mail</Label>
                  <Input
                    id="lead-convert-cemail"
                    type="email"
                    value={cEmail}
                    onChange={(e) => setCEmail(e.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Kontrahent z tym samym NIP-em już w kartotece? Backend użyje istniejącego zamiast
                  zakładać duplikat.
                </p>
              </div>
            )}
          </Section>

          <Section icon={Building2} title="Obiekt" id="lead-convert-object">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="lead-convert-oname">Nazwa obiektu</Label>
                <Input
                  id="lead-convert-oname"
                  data-testid="lead-convert-oname"
                  value={oName}
                  onChange={(e) => setOName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-oaddress">Adres</Label>
                <Input
                  id="lead-convert-oaddress"
                  value={oAddress}
                  onChange={(e) => setOAddress(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-ocity">Miasto</Label>
                <Input
                  id="lead-convert-ocity"
                  value={oCity}
                  onChange={(e) => setOCity(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-zdw">Abonament ZDW (zł/mies.)</Label>
                <Input
                  id="lead-convert-zdw"
                  data-testid="lead-convert-zdw"
                  inputMode="decimal"
                  className="tabular-nums"
                  value={oMonthlyZdw}
                  onChange={(e) => setOMonthlyZdw(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-ofi">Abonament OFI (zł/mies.)</Label>
                <Input
                  id="lead-convert-ofi"
                  inputMode="decimal"
                  className="tabular-nums"
                  value={oMonthlyOfi}
                  onChange={(e) => setOMonthlyOfi(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-cameras">Liczba kamer</Label>
                <Input
                  id="lead-convert-cameras"
                  inputMode="numeric"
                  className="tabular-nums"
                  value={oCameraCount}
                  onChange={(e) => setOCameraCount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-convert-installation">Rodzaj instalacji</Label>
                <Select
                  value={oInstallation}
                  onValueChange={(v) => setOInstallation(v as "new" | "takeover")}
                >
                  <SelectTrigger id="lead-convert-installation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">Nowa instalacja</SelectItem>
                    <SelectItem value="takeover">Przejęcie istniejącej</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Usługi na obiekcie</Label>
                <div className="flex flex-wrap gap-4">
                  {(
                    [
                      ["Kamery", hasCameras, setHasCameras, "cameras"],
                      ["SSWiN", hasSswin, setHasSswin, "sswin"],
                      ["Wideorecepcja", hasVideo, setHasVideo, "video"],
                      ["OFI / ochrona", hasOfi, setHasOfi, "ofi"],
                    ] as [string, boolean, (v: boolean) => void, string][]
                  ).map(([label, val, set, key]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={val}
                        data-testid={`lead-convert-svc-${key}`}
                        onCheckedChange={(v) => set(v === true)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={markWon}
              data-testid="lead-convert-markwon"
              onCheckedChange={(v) => setMarkWon(v === true)}
            />
            Oznacz szansę jako wygraną
          </label>

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
          <Button onClick={submit} disabled={busy} data-testid="lead-convert-submit">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Utwórz klienta i obiekt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LeadConvertDialog;
