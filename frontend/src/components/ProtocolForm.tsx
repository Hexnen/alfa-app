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
import { Printer, Plus, Trash2, PenLine, Wand2 } from "lucide-react";
import { printProtocol } from "@/lib/protocolPrint";
import { SignatureDialog } from "./SignatureDialog";
import {
  PrefillHint,
  ProtocolPrefillDialog,
} from "./protocol/ProtocolPrefillDialog";
import type {
  Protocol,
  ProtocolInput,
  ProtocolItem,
  ProtocolPrefillApplied,
  ProtocolSuggestion,
  ProtocolWorkType,
} from "@/lib/api";

interface ProtocolFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ProtocolInput) => Promise<void>;
  onSign: (signaturePng: string, signerName: string) => Promise<void>;
  onUnsign: () => Promise<void>;
  protocol: Protocol;
  /** false = podgląd (uprawnienie tylko do odczytu) — bez uzupełniania z danych. */
  editable?: boolean;
  /** Protokół zapisany przez „Uzupełnij z danych" — lista na stronie może się odświeżyć. */
  onPrefilled?: (updated: Protocol) => void;
}

export function ProtocolForm({
  open,
  onClose,
  onSubmit,
  onSign,
  onUnsign,
  protocol,
  editable = true,
  onPrefilled,
}: ProtocolFormProps) {
  const [loading, setLoading] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [prefillOpen, setPrefillOpen] = useState(false);
  /** Pola uzupełnione w tej sesji formularza → adnotacja „z kalendarza/obiektu/…". */
  const [hints, setHints] = useState<Record<string, ProtocolSuggestion>>({});
  const [formData, setFormData] = useState<ProtocolInput>({
    workDate: protocol.workDate,
    workType: protocol.workType,
    actualHours: protocol.actualHours || "",
    actualKm: protocol.actualKm || "",
    contractor: protocol.contractor || "",
    salesperson: protocol.salesperson || "",
    clientName: protocol.clientName || "",
    clientNip: protocol.clientNip || "",
    clientCity: protocol.clientCity || "",
    installationAddress: protocol.installationAddress || "",
    contact: protocol.contact || "",
    activities: protocol.activities || "",
    items: protocol.items.length
      ? protocol.items
      : [{ name: "", serial: "", unit: "", qty: "" }],
    status: protocol.status,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Błąd zapisu protokołu");
    } finally {
      setLoading(false);
    }
  };

  const setField = (name: keyof ProtocolInput, value: unknown) =>
    setFormData((p) => ({ ...p, [name]: value }));

  const setItem = (idx: number, field: keyof ProtocolItem, value: string) =>
    setFormData((p) => ({
      ...p,
      items: p.items.map((it, i) =>
        i === idx ? { ...it, [field]: value } : it
      ),
    }));

  const addItem = () =>
    setFormData((p) => ({
      ...p,
      items: [...p.items, { name: "", serial: "", unit: "", qty: "" }],
    }));

  const removeItem = (idx: number) =>
    setFormData((p) => ({ ...p, items: p.items.filter((_, i) => i !== idx) }));

  /**
   * Protokół podpisany albo zatwierdzony jest nietykalny (backend odrzuca prefill 400),
   * więc przycisk „Uzupełnij z danych" pokazujemy tylko dla szkicu i tylko z prawem edycji.
   */
  const sealed =
    protocol.status === "final" || !!protocol.signaturePng || !!protocol.signedAt;
  const canPrefill = editable && !sealed;

  /** Podstawia do formularza WYŁĄCZNIE pola, które backend faktycznie zapisał. */
  const applyPrefill = (
    updated: ProtocolPrefillApplied,
    applied: ProtocolSuggestion[]
  ) => {
    setFormData((p) => {
      const next: ProtocolInput = { ...p };
      const raw = updated as unknown as Record<string, unknown>;
      for (const s of applied) {
        if (s.field === "items") next.items = updated.items;
        else if (s.field === "actualHours") next.actualHours = updated.actualHours;
        else if (s.field === "actualKm") next.actualKm = updated.actualKm;
        else if (s.field === "workType") next.workType = updated.workType;
        else if (typeof raw[s.field] === "string") {
          (next as unknown as Record<string, unknown>)[s.field] = raw[s.field];
        }
      }
      return next;
    });
    setHints((h) => ({
      ...h,
      ...Object.fromEntries(applied.map((s) => [s.field, s])),
    }));
    onPrefilled?.(updated);
  };

  /** Adnotacja „skąd to jest" pod polem uzupełnionym automatem. */
  const hint = (field: string) =>
    hints[field] ? <PrefillHint suggestion={hints[field]} /> : null;

  const handlePrint = () =>
    printProtocol({
      ...protocol,
      ...formData,
      actualHours: Number(formData.actualHours) || 0,
      actualKm: Number(formData.actualKm) || 0,
      items: formData.items,
    } as Protocol);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-4 pr-6">
            <span>Protokół końcowy {protocol.number}</span>
            <div className="flex items-center gap-2">
              {canPrefill && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="protocol-prefill-open"
                  title="Podstaw dane z kalendarza, obiektu, kontrahenta i cennika"
                  onClick={() => setPrefillOpen(true)}
                >
                  <Wand2 className="h-4 w-4 mr-2" />
                  Uzupełnij z danych
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrint}
              >
                <Printer className="h-4 w-4 mr-2" />
                Drukuj / PDF
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label>Data wykonania *</Label>
              <Input
                type="date"
                value={formData.workDate}
                onChange={(e) => setField("workDate", e.target.value)}
                required
              />
              {hint("workDate")}
            </div>
            <div className="space-y-2">
              <Label>Typ prac</Label>
              <select
                value={formData.workType}
                onChange={(e) =>
                  setField("workType", e.target.value as ProtocolWorkType)
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="serwis">Serwis</option>
                <option value="montaz">Montaż</option>
                <option value="wizja">Wizja lokalna</option>
                <option value="inne">Inne</option>
              </select>
              {hint("workType")}
            </div>
            <div className="space-y-2">
              <Label>Faktyczne godziny</Label>
              <Input
                type="number"
                step="0.25"
                min="0"
                value={formData.actualHours}
                onChange={(e) => setField("actualHours", e.target.value)}
              />
              {hint("actualHours")}
            </div>
            <div className="space-y-2">
              <Label>Przejechane km</Label>
              <Input
                type="number"
                step="1"
                min="0"
                value={formData.actualKm}
                onChange={(e) => setField("actualKm", e.target.value)}
              />
              {hint("actualKm")}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Wykonawca</Label>
              <Input
                value={formData.contractor || ""}
                onChange={(e) => setField("contractor", e.target.value)}
              />
              {hint("contractor")}
            </div>
            <div className="space-y-2">
              <Label>Handlowiec</Label>
              <Input
                value={formData.salesperson || ""}
                onChange={(e) => setField("salesperson", e.target.value)}
              />
              {hint("salesperson")}
            </div>
          </div>

          <div className="rounded-md border p-4 space-y-4">
            <div className="text-sm font-semibold">Zleceniodawca</div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Nazwa</Label>
                <Input
                  value={formData.clientName || ""}
                  onChange={(e) => setField("clientName", e.target.value)}
                />
                {hint("clientName")}
              </div>
              <div className="space-y-2">
                <Label>NIP</Label>
                <Input
                  value={formData.clientNip || ""}
                  onChange={(e) => setField("clientNip", e.target.value)}
                />
                {hint("clientNip")}
              </div>
              <div className="space-y-2">
                <Label>Miejscowość</Label>
                <Input
                  value={formData.clientCity || ""}
                  onChange={(e) => setField("clientCity", e.target.value)}
                />
                {hint("clientCity")}
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Adres montażu</Label>
                <Input
                  value={formData.installationAddress || ""}
                  onChange={(e) =>
                    setField("installationAddress", e.target.value)
                  }
                />
                {hint("installationAddress")}
              </div>
              <div className="space-y-2">
                <Label>Kontakt</Label>
                <Input
                  value={formData.contact || ""}
                  onChange={(e) => setField("contact", e.target.value)}
                />
                {hint("contact")}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Wykonane czynności / uwagi</Label>
            <Textarea
              value={formData.activities || ""}
              onChange={(e) => setField("activities", e.target.value)}
              rows={4}
            />
            {hint("activities")}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Urządzenia / materiały</Label>
              <div className="flex items-center gap-2">
                {hint("items")}
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4 mr-1" />
                  Pozycja
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {formData.items.map((it, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="w-6 text-right text-xs text-muted-foreground">
                    {idx + 1}.
                  </span>
                  <Input
                    className="flex-1"
                    placeholder="Nazwa urządzenia / model"
                    value={it.name}
                    onChange={(e) => setItem(idx, "name", e.target.value)}
                  />
                  <Input
                    className="w-36"
                    placeholder="Nr seryjny"
                    value={it.serial}
                    onChange={(e) => setItem(idx, "serial", e.target.value)}
                  />
                  <Input
                    className="w-20"
                    placeholder="J.M."
                    value={it.unit}
                    onChange={(e) => setItem(idx, "unit", e.target.value)}
                  />
                  <Input
                    className="w-20"
                    placeholder="Ilość"
                    value={it.qty}
                    onChange={(e) => setItem(idx, "qty", e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                    onClick={() => removeItem(idx)}
                    title="Usuń pozycję"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={formData.status === "final"}
              onChange={(e) =>
                setField("status", e.target.checked ? "final" : "draft")
              }
              className="h-4 w-4 accent-primary"
            />
            Zatwierdzony (gotowy do podpisu)
          </label>

          <div className="rounded-md border p-4">
            <div className="mb-2 text-sm font-semibold">Podpis zleceniodawcy</div>
            {protocol.signaturePng ? (
              <div className="flex flex-wrap items-center gap-4">
                <img
                  src={protocol.signaturePng}
                  alt="Podpis zleceniodawcy"
                  className="h-16 rounded border bg-white px-2"
                />
                <div className="text-sm">
                  <div className="font-medium">
                    {protocol.signerName || "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {protocol.signedAt
                      ? new Date(protocol.signedAt).toLocaleString("pl-PL")
                      : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    if (window.confirm("Usunąć podpis z protokołu?")) {
                      onUnsign().catch((error) =>
                        alert(
                          error instanceof Error
                            ? error.message
                            : "Nie można usunąć podpisu"
                        )
                      );
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Usuń podpis
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSignOpen(true)}
                >
                  <PenLine className="h-4 w-4 mr-2" />
                  Podpisz
                </Button>
                <span className="text-xs text-muted-foreground">
                  Zapisz najpierw zmiany — podpis pieczętuje aktualną treść
                  protokołu.
                </span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Zapisywanie…" : "Zapisz"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <SignatureDialog
        open={signOpen}
        onClose={() => setSignOpen(false)}
        onSave={onSign}
        defaultSignerName={formData.clientName || formData.contact || ""}
      />

      {prefillOpen && (
        <ProtocolPrefillDialog
          open={prefillOpen}
          protocol={protocol}
          onClose={() => setPrefillOpen(false)}
          onApplied={applyPrefill}
        />
      )}
    </Dialog>
  );
}
