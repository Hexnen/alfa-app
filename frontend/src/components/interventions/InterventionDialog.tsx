/**
 * Formularz jednego podjazdu grupy interwencyjnej.
 *
 * Firmy ani kwot się tu nie wybiera — bierze je backend z warunków
 * obowiązujących na obiekcie w dniu zdarzenia (`resolveTermFor`). Front tylko
 * podpowiada, które to warunki, żeby nikt nie zapisywał podjazdu w dniu, w
 * którym obiekt nie ma umowy; gdy warunków nie ma, backend odrzuca zapis 400,
 * a komunikat ląduje nad przyciskami.
 */
import { useEffect, useState } from "react";
import { Info, Loader2, Save } from "lucide-react";
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
import { AttachmentList } from "@/components/AttachmentList";
import { AttachmentUploader, usePendingAttachments } from "@/components/AttachmentUploader";
import {
  interventionsApi,
  type Intervention,
  type InterventionAttachment,
  type InterventionInput,
  type InterventionPickObject,
  type InterventionTerm,
} from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ObjectPicker } from "./ObjectPicker";
import { errMsg, nowLocalDateTime, numField, parseAmountField } from "./helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = nowa interwencja. */
  intervention: Intervention | null;
  /** Wejście z karty obiektu — obiekt jest z góry ustalony i zablokowany. */
  fixedObject?: InterventionPickObject | null;
  /** Podpowiedź z filtra listy — pole jest wypełnione, ale wolno je zmienić. */
  initialObject?: InterventionPickObject | null;
  onSaved: (intervention: Intervention) => void;
}

const interventionObject = (i: Intervention): InterventionPickObject => ({
  id: i.objectId,
  name: i.objectName,
  address: null,
  city: i.objectCity,
  contractorName: null,
});

/** `datetime-local` daje czasem sekundy — backend chce `YYYY-MM-DDTHH:mm`. */
const trimSeconds = (v: string) => (v.length > 16 ? v.slice(0, 16) : v);

export function InterventionDialog({
  open,
  onClose,
  intervention,
  fixedObject,
  initialObject,
  onSaved,
}: Props) {
  const isNew = !intervention;
  const [object, setObject] = useState<InterventionPickObject | null>(
    intervention ? interventionObject(intervention) : (fixedObject ?? initialObject ?? null)
  );
  const [happenedAt, setHappenedAt] = useState(
    intervention ? trimSeconds(intervention.happenedAt) : nowLocalDateTime()
  );
  const [reason, setReason] = useState(intervention?.reason ?? "");
  const [reportedBy, setReportedBy] = useState(intervention?.reportedBy ?? "");
  const [standbyHours, setStandbyHours] = useState(numField(intervention?.standbyHours));
  const [notes, setNotes] = useState(intervention?.notes ?? "");
  const [attachments, setAttachments] = useState<InterventionAttachment[]>(intervention?.attachments ?? []);
  const [terms, setTerms] = useState<InterventionTerm[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = usePendingAttachments({ scopeSuffix: "na interwencję" });
  const objectId = object?.id ?? null;

  // Warunki obiektu — tylko po to, żeby pokazać, na czyich zasadach podjazd
  // zostanie rozliczony. Źródłem prawdy zostaje backend.
  useEffect(() => {
    if (!open || objectId === null) {
      setTerms(null);
      return;
    }
    let cancelled = false;
    interventionsApi
      .listObjectTerms(objectId)
      .then((res) => {
        if (!cancelled) setTerms(res.data?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setTerms([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, objectId]);

  const day = happenedAt.slice(0, 10);
  const matchedTerm =
    terms && day
      ? (terms.find((t) => t.startDate <= day && (t.endDate ?? "9999-12-31") >= day) ?? null)
      : null;

  const deleteAttachment = async (a: { id: number; fileName: string }) => {
    if (busy || !intervention) return;
    if (!window.confirm(`Usunąć załącznik „${a.fileName}”? Pliku nie da się przywrócić.`)) return;
    try {
      await interventionsApi.deleteInterventionAttachment(intervention.id, a.id);
      setAttachments((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    }
  };

  const save = async () => {
    if (!object) {
      setError("Wybierz obiekt.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimSeconds(happenedAt))) {
      setError("Podaj datę i godzinę podjazdu.");
      return;
    }
    const hours = parseAmountField(standbyHours);
    if (hours === "INVALID") {
      setError("Godziny postoju muszą być liczbą nieujemną (przecinek albo kropka).");
      return;
    }

    const body: InterventionInput = {
      objectId: object.id,
      happenedAt: trimSeconds(happenedAt),
      reason: reason.trim() || null,
      reportedBy: reportedBy.trim() || null,
      standbyHours: hours,
      notes: notes.trim() || null,
    };

    setBusy(true);
    setError(null);
    try {
      let latest: Intervention;
      if (intervention) {
        const res = await interventionsApi.updateIntervention(intervention.id, body);
        latest = res.data ?? intervention;
      } else {
        const res = await interventionsApi.createIntervention(body);
        if (!res.data) throw new Error("Backend nie zwrócił zapisanej interwencji.");
        latest = res.data;
      }
      if (queue.pending.length) {
        const up = await interventionsApi.addInterventionAttachments(
          latest.id,
          queue.pending.map((p) => p.file)
        );
        queue.clearPending();
        if (up.data) latest = up.data;
      }
      onSaved(latest);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać interwencji."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,44rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="interwencje-podjazd-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{isNew ? "Nowa interwencja" : "Edycja interwencji"}</DialogTitle>
          <DialogDescription>
            Firmę i stawki bierzemy z warunków obowiązujących na obiekcie w dniu podjazdu.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Obiekt</Label>
          <ObjectPicker
            value={object}
            onChange={setObject}
            disabled={!!fixedObject || busy}
            testid="interwencje-podjazd-obiekt"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-podjazd-kiedy">Data i godzina</Label>
            <Input
              id="interwencje-podjazd-kiedy"
              type="datetime-local"
              value={happenedAt}
              onChange={(e) => setHappenedAt(e.target.value)}
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-podjazd-kiedy"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-podjazd-zglosil">Zgłosił</Label>
            <Input
              id="interwencje-podjazd-zglosil"
              value={reportedBy}
              onChange={(e) => setReportedBy(e.target.value)}
              placeholder="np. operator CMA"
              disabled={busy}
              data-testid="interwencje-podjazd-zglosil"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-podjazd-postoj">Godziny postoju</Label>
            <Input
              id="interwencje-podjazd-postoj"
              inputMode="decimal"
              value={standbyHours}
              onChange={(e) => setStandbyHours(e.target.value)}
              placeholder="np. 1,5"
              disabled={busy}
              className="tabular-nums"
              data-testid="interwencje-podjazd-postoj"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="interwencje-podjazd-powod">Powód</Label>
          <Input
            id="interwencje-podjazd-powod"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="np. alarm włamaniowy, strefa 3"
            disabled={busy}
            data-testid="interwencje-podjazd-powod"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="interwencje-podjazd-notatki">Notatki</Label>
          <Textarea
            id="interwencje-podjazd-notatki"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            disabled={busy}
            data-testid="interwencje-podjazd-notatki"
          />
        </div>

        {objectId !== null && terms !== null && (
          <p
            className={
              matchedTerm
                ? "flex items-start gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                : "flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            }
            data-testid="interwencje-podjazd-warunki"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {matchedTerm ? (
              <span>
                Warunki: <strong>{matchedTerm.companyName}</strong>, od {formatDate(matchedTerm.startDate)}
                {matchedTerm.endDate ? ` do ${formatDate(matchedTerm.endDate)}` : ""}
                {matchedTerm.calloutFee != null ? ` · podjazd ${formatCurrency(matchedTerm.calloutFee)}` : ""}
                {matchedTerm.freeCallouts != null ? ` · darmowe ${matchedTerm.freeCallouts}/mies.` : ""}
              </span>
            ) : (
              <span>
                Obiekt nie ma warunków grupy interwencyjnej obowiązujących w tym dniu — dodaj je w panelu
                „Obiekty”, inaczej zapis zostanie odrzucony.
              </span>
            )}
          </p>
        )}

        {/* --- Załączniki (zdjęcia z podjazdu, notatka firmy) --- */}
        <div className="space-y-2 rounded-md border p-3">
          <AttachmentUploader
            queue={queue}
            existingCount={attachments.length}
            disabled={busy}
            label="Załączniki"
            testid="interwencje-podjazd-att"
          />
          <AttachmentList
            attachments={attachments}
            onDelete={intervention ? (a) => void deleteAttachment(a) : undefined}
            deleteDisabled={busy}
            emptyText={
              queue.pending.length === 0
                ? "Brak plików. Przeciągnij je tutaj albo kliknij „Dodaj pliki”."
                : undefined
            }
            testid="interwencje-podjazd-att-list"
          />
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="interwencje-podjazd-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="interwencje-podjazd-zapisz">
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {busy ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
