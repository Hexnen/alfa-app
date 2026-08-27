import { useState } from "react";
import { Wand2 } from "lucide-react";
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
import { Link } from "react-router-dom";
import { ProtocolBadge } from "./CalendarEventBadges";
import { AutofillDialog, AutofillHint } from "./realization/AutofillDialog";
import {
  BILLING_META,
  protocolHref,
  REALIZATION_BILLING_ORDER,
  REALIZATION_WORK_TYPE_META,
  REALIZATION_WORK_TYPE_ORDER,
} from "@/lib/calendar-labels";
import { tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  AutofillSuggestion,
  Realization,
  RealizationInput,
} from "@/lib/api";

/** Pola realizacji, które automat może podstawić do formularza. */
const AUTOFILLABLE = [
  "actualHours",
  "amountHours",
  "amountMaterial",
  "actualKm",
  "amountKm",
  "hourlyCost",
  "caretaker",
] as const;
type AutofillableField = (typeof AUTOFILLABLE)[number];

interface RealizationFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: RealizationInput) => Promise<void>;
  realization?: Realization | null;
  defaultDate: string; // YYYY-MM-DD proponowana data dla nowego wpisu
  technicians?: string[]; // podpowiedzi dla pól Opiekun / Wykonawca
  /**
   * Automat zapisał pola po swojej stronie — rodzic musi odświeżyć wiersz i
   * podmienić `updatedAt` (inaczej ręczny zapis poleci z nieaktualną wersją).
   */
  onAutofilled?: (updated: Realization, fields: string[]) => void;
}

export function RealizationForm({
  open,
  onClose,
  onSubmit,
  realization,
  defaultDate,
  technicians = [],
  onAutofilled,
}: RealizationFormProps) {
  const [loading, setLoading] = useState(false);
  const [autofillOpen, setAutofillOpen] = useState(false);
  /** Sugestie automatu (po zastosowaniu) — źródło adnotacji pod polami. */
  const [hints, setHints] = useState<Partial<Record<string, AutofillSuggestion>>>({});
  const [formData, setFormData] = useState<RealizationInput>({
    date: realization?.date || defaultDate,
    site: realization?.site || "",
    workType: realization?.workType || "serwis",
    billing: realization?.billing || "paid",
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

  /**
   * Automat zapisał wartości po stronie API — przenosimy je do otwartego
   * formularza (żeby ręczny zapis ich nie cofnął) i zapamiętujemy źródła.
   */
  const handleAutofilled = (updated: Realization, applied: AutofillSuggestion[]) => {
    const fields = applied.map((s) => s.field);
    setFormData((prev) => {
      const next = { ...prev };
      for (const f of AUTOFILLABLE) {
        if (!fields.includes(f)) continue;
        const v = updated[f as AutofillableField];
        (next as Record<string, unknown>)[f] = v ?? "";
      }
      return next;
    });
    setHints((prev) => {
      const next = { ...prev };
      for (const s of applied) next[s.field] = s;
      return next;
    });
    onAutofilled?.(updated, fields);
  };

  /**
   * Realizacja z kalendarza — rodzaj i typ przyszły z wydarzenia i wrócą tam przy
   * każdej jego edycji (src/lib/calendar-realizations.ts), więc mówimy to wprost.
   */
  const fromEvent = !!realization?.calendarEventId;
  const sourceMatchesEvent =
    fromEvent &&
    formData.workType === realization!.workType &&
    formData.billing === realization!.billing;

  /** Adnotacja źródła pod polem — tylko dla pól, które automat faktycznie ruszył. */
  const hint = (field: string) => {
    const s = hints[field];
    return s ? <AutofillHint suggestion={s} applied /> : null;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {realization ? "Edytuj realizację" : "Nowa realizacja"}
            {/* Protokół realizacji — ta sama pigułka co w tabeli i kalendarzu. */}
            {realization?.protocol && (
              <Link
                to={protocolHref(realization.protocol.id)}
                data-testid="realization-form-protocol-link"
                className="inline-flex rounded-full font-normal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProtocolBadge
                  event={{ type: "serwis", status: "done", protocol: realization.protocol }}
                />
              </Link>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Automat — dostępny dopiero dla zapisanej realizacji (potrzebuje jej id). */}
        {realization && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2">
            <p className="min-w-40 flex-1 text-xs text-muted-foreground">
              Godziny z kalendarza, materiały z protokołu, kilometry z kalkulacji biuro → obiekt. Automat proponuje,
              Ty zatwierdzasz.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="realization-autofill-open"
              onClick={() => setAutofillOpen(true)}
              {...tip(
                realization.invoiced
                  ? "Realizacja zafakturowana — automat pokaże wyliczenia, ale nic nie zapisze"
                  : "Policz godziny, materiały i kilometry z kalendarza, protokołu i cennika"
              )}
            >
              <Wand2 className="mr-1 h-4 w-4" aria-hidden />
              Uzupełnij automatycznie
            </Button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {technicians.length > 0 && (
            <datalist id="technicians-list">
              {technicians.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <div className="space-y-2">
            <Label htmlFor="date">Data *</Label>
            <Input
              id="date"
              name="date"
              type="date"
              className="sm:max-w-56"
              value={formData.date}
              onChange={handleChange}
              required
            />
          </div>

          {/* Dwa niezależne wymiary: CO robiono (rodzaj) i ZA ILE (typ rozliczenia). */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Rodzaj</Label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Rodzaj prac">
                {REALIZATION_WORK_TYPE_ORDER.map((t) => {
                  const meta = REALIZATION_WORK_TYPE_META[t];
                  const active = formData.workType === t;
                  const Icon = meta.icon;
                  return (
                    <button
                      key={t}
                      type="button"
                      data-testid={`realization-form-worktype-${t}`}
                      aria-pressed={active}
                      onClick={() => setFormData((p) => ({ ...p, workType: t }))}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active ? meta.chipActive : meta.chip
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Typ</Label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Typ rozliczenia">
                {REALIZATION_BILLING_ORDER.map((b) => {
                  const meta = BILLING_META[b];
                  const active = formData.billing === b;
                  const Icon = meta.icon;
                  return (
                    <button
                      key={b}
                      type="button"
                      data-testid={`realization-form-billing-${b}`}
                      aria-pressed={active}
                      onClick={() => setFormData((p) => ({ ...p, billing: b }))}
                      {...tip(`${meta.label} — ${meta.hint}`)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active ? meta.chipActive : meta.chip
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {fromEvent && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="realization-form-kind-source"
            >
              {sourceMatchesEvent ? (
                <>
                  Rodzaj i typ pochodzą z wydarzenia kalendarza #{realization!.calendarEventId} —
                  edycja wydarzenia nadpisze je z powrotem.
                </>
              ) : (
                <>
                  Zmieniono względem wydarzenia #{realization!.calendarEventId} (
                  {REALIZATION_WORK_TYPE_META[realization!.workType]?.label},{" "}
                  {BILLING_META[realization!.billing]?.label}) — kolejna edycja wydarzenia przywróci
                  jego wartości.
                </>
              )}
            </p>
          )}

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
              {hint("amountHours")}
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
              {hint("amountMaterial")}
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
              {hint("amountKm")}
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
              {hint("caretaker")}
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
              {hint("actualHours")}
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
              {hint("actualKm")}
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
              {hint("hourlyCost")}
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

      {/* Dialog automatu — nad formularzem, żeby zastosowane wartości od razu
          wpadły do otwartych pól. */}
      {realization && autofillOpen && (
        <AutofillDialog
          open={autofillOpen}
          realization={realization}
          onClose={() => setAutofillOpen(false)}
          onApplied={handleAutofilled}
        />
      )}
    </Dialog>
  );
}
