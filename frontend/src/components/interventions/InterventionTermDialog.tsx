/**
 * Formularz warunków grupy interwencyjnej na obiekcie.
 *
 * Obiekt może mieć WIELE wierszy — to historia zmian firm, więc „zakończenie”
 * współpracy to data w polu „Do”, a nie kasowanie wiersza. Kwoty puste zostają
 * puste (`null` = nikt nie uzupełnił, a nie 0 zł), backend odrzuci śmieci i
 * nakładające się okresy tego samego obiektu (409).
 *
 * Obiektu nie da się zmienić w edycji ani przy wejściu z karty obiektu —
 * przeniesienie warunków na inny obiekt osierociłoby zapisane interwencje.
 */
import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AttachmentList } from "@/components/AttachmentList";
import { AttachmentUploader, usePendingAttachments } from "@/components/AttachmentUploader";
import {
  interventionsApi,
  type InterventionAttachment,
  type InterventionCompany,
  type InterventionPickObject,
  type InterventionTerm,
  type InterventionTermInput,
} from "@/lib/api";
import { ObjectPicker } from "./ObjectPicker";
import { errMsg, numField, parseAmountField, parseIntField, todayIso } from "./helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = nowy wiersz warunków. */
  term: InterventionTerm | null;
  /** Wejście z karty obiektu — obiekt jest z góry ustalony i zablokowany. */
  fixedObject?: InterventionPickObject | null;
  onSaved: (term: InterventionTerm) => void;
}

const termObject = (t: InterventionTerm): InterventionPickObject => ({
  id: t.objectId,
  name: t.objectName,
  address: t.objectAddress,
  city: t.objectCity,
  contractorName: t.contractorName,
});

export function InterventionTermDialog({ open, onClose, term, fixedObject, onSaved }: Props) {
  const isNew = !term;
  const [object, setObject] = useState<InterventionPickObject | null>(
    term ? termObject(term) : (fixedObject ?? null)
  );
  const [companyId, setCompanyId] = useState<string>(term ? String(term.companyId) : "");
  const [startDate, setStartDate] = useState(term?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(term?.endDate ?? "");
  const [calloutFee, setCalloutFee] = useState(numField(term?.calloutFee));
  const [subscriptionFee, setSubscriptionFee] = useState(numField(term?.subscriptionFee));
  const [freeCallouts, setFreeCallouts] = useState(numField(term?.freeCallouts));
  const [hourlyStandbyFee, setHourlyStandbyFee] = useState(numField(term?.hourlyStandbyFee));
  const [notes, setNotes] = useState(term?.notes ?? "");
  const [attachments, setAttachments] = useState<InterventionAttachment[]>(term?.attachments ?? []);
  const [companies, setCompanies] = useState<InterventionCompany[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = usePendingAttachments({ scopeSuffix: "na wiersz warunków" });

  // Firmy pobiera samo okno — jest też otwierane z karty obiektu, gdzie nikt
  // słownika firm nie trzyma. Archiwalne zostają na liście tylko wtedy, gdy to
  // one są wybrane w edytowanym wierszu.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    interventionsApi
      .listCompanies({ status: "all" })
      .then((res) => {
        if (!cancelled) setCompanies(res.data?.items ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e, "Nie udało się pobrać listy firm."));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const companyOptions = companies.filter((c) => c.active || String(c.id) === companyId);
  const objectLocked = !isNew || !!fixedObject;

  const deleteAttachment = async (a: { id: number; fileName: string }) => {
    if (busy || !term) return;
    if (!window.confirm(`Usunąć załącznik „${a.fileName}”? Pliku nie da się przywrócić.`)) return;
    try {
      await interventionsApi.deleteTermAttachment(term.id, a.id);
      setAttachments((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    }
  };

  const save = async () => {
    if (!term && !object) {
      setError("Wybierz obiekt.");
      return;
    }
    if (!companyId) {
      setError("Wybierz firmę.");
      return;
    }
    if (!startDate) {
      setError("Data „Od” jest wymagana.");
      return;
    }
    if (endDate && endDate < startDate) {
      setError("Data „Do” nie może być wcześniejsza niż „Od”.");
      return;
    }
    const amounts = {
      calloutFee: parseAmountField(calloutFee),
      subscriptionFee: parseAmountField(subscriptionFee),
      hourlyStandbyFee: parseAmountField(hourlyStandbyFee),
    };
    const free = parseIntField(freeCallouts);
    if (Object.values(amounts).includes("INVALID")) {
      setError("Kwoty muszą być liczbami nieujemnymi (przecinek albo kropka).");
      return;
    }
    if (free === "INVALID") {
      setError("Liczba darmowych podjazdów musi być całkowita i nieujemna.");
      return;
    }

    const body: InterventionTermInput = {
      companyId: Number(companyId),
      startDate,
      endDate: endDate || null,
      calloutFee: amounts.calloutFee as number | null,
      subscriptionFee: amounts.subscriptionFee as number | null,
      freeCallouts: free,
      hourlyStandbyFee: amounts.hourlyStandbyFee as number | null,
      notes: notes.trim() || null,
    };

    setBusy(true);
    setError(null);
    try {
      let latest: InterventionTerm;
      if (term) {
        const res = await interventionsApi.updateTerm(term.id, body);
        latest = res.data ?? term;
      } else {
        const res = await interventionsApi.createTerm({ ...body, objectId: object!.id });
        if (!res.data) throw new Error("Backend nie zwrócił zapisanych warunków.");
        latest = res.data;
      }
      if (queue.pending.length) {
        const up = await interventionsApi.addTermAttachments(
          latest.id,
          queue.pending.map((p) => p.file)
        );
        queue.clearPending();
        if (up.data) latest = up.data;
      }
      onSaved(latest);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać warunków."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,46rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="interwencje-warunki-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{isNew ? "Nowe warunki na obiekcie" : "Edycja warunków"}</DialogTitle>
          <DialogDescription>
            Puste kwoty zostają puste — „nieuzupełnione” to nie 0 zł. Zakończenie współpracy zapisujemy datą „Do”.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Obiekt</Label>
          <ObjectPicker
            value={object}
            onChange={setObject}
            disabled={objectLocked || busy}
            testid="interwencje-warunki-obiekt"
          />
          {objectLocked && (
            <p className="text-[11px] text-muted-foreground">
              Obiektu nie da się zmienić — dodaj nowy wiersz warunków na właściwym obiekcie.
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="interwencje-warunki-firma">Firma</Label>
            <Select value={companyId} onValueChange={setCompanyId} disabled={busy}>
              <SelectTrigger id="interwencje-warunki-firma" data-testid="interwencje-warunki-firma">
                <SelectValue placeholder="Wybierz firmę interwencyjną" />
              </SelectTrigger>
              <SelectContent>
                {companyOptions.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                    {!c.active ? " (archiwalna)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-od">Od</Label>
            <Input
              id="interwencje-warunki-od"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={busy}
              data-testid="interwencje-warunki-od"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-do">Do (wypowiedzenie)</Label>
            <Input
              id="interwencje-warunki-do"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={busy}
              data-testid="interwencje-warunki-do"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-darmowe">Darmowe podjazdy / mies.</Label>
            <Input
              id="interwencje-warunki-darmowe"
              inputMode="numeric"
              value={freeCallouts}
              onChange={(e) => setFreeCallouts(e.target.value)}
              placeholder="np. 2"
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-warunki-darmowe"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-podjazd">Kwota podjazdu (zł netto)</Label>
            <Input
              id="interwencje-warunki-podjazd"
              inputMode="decimal"
              value={calloutFee}
              onChange={(e) => setCalloutFee(e.target.value)}
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-warunki-podjazd"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-abonament">Abonament mies. (zł netto)</Label>
            <Input
              id="interwencje-warunki-abonament"
              inputMode="decimal"
              value={subscriptionFee}
              onChange={(e) => setSubscriptionFee(e.target.value)}
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-warunki-abonament"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-warunki-postoj">Godzina postoju (zł netto)</Label>
            <Input
              id="interwencje-warunki-postoj"
              inputMode="decimal"
              value={hourlyStandbyFee}
              onChange={(e) => setHourlyStandbyFee(e.target.value)}
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-warunki-postoj"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="interwencje-warunki-notatki">Notatki</Label>
          <Textarea
            id="interwencje-warunki-notatki"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            disabled={busy}
            data-testid="interwencje-warunki-notatki"
          />
        </div>

        {/* --- Umowa na obiekt --- */}
        <div className="space-y-2 rounded-md border p-3">
          <AttachmentUploader
            queue={queue}
            existingCount={attachments.length}
            disabled={busy}
            label="Umowa na obiekt"
            testid="interwencje-warunki-att"
          />
          <AttachmentList
            attachments={attachments}
            onDelete={term ? (a) => void deleteAttachment(a) : undefined}
            deleteDisabled={busy}
            emptyText={
              queue.pending.length === 0
                ? "Brak plików. Przeciągnij je tutaj albo kliknij „Dodaj pliki”."
                : undefined
            }
            testid="interwencje-warunki-att-list"
          />
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="interwencje-warunki-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="interwencje-warunki-zapisz">
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {busy ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
