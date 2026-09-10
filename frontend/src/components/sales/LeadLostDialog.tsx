/**
 * „Dlaczego przegraliśmy?” — jedyne miejsce, w którym da się jeszcze zebrać tę
 * informację. Potem nikt do tej szansy nie wróci, a statystyka powodów jest
 * jedynym wejściem do rozmowy „za drogo czy za wolno”.
 *
 * Backend też tego pilnuje (`PATCH /leads/:id/stage` odrzuca `przegrany` bez
 * powodu) — dialog jest po to, żeby użytkownik dostał listę zamiast błędu 400.
 */
import { useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { LOST_REASONS, LOST_REASON_LABELS } from "@/lib/sales-labels";
import type { LeadLostReason } from "@/lib/api";

export function LeadLostDialog({
  open,
  leadTitle,
  onClose,
  onConfirm,
}: {
  open: boolean;
  leadTitle: string;
  onClose: () => void;
  /** Zapis robi rodzic (kanban zna rollback, karta szansy — przeładowanie). */
  onConfirm: (reason: LeadLostReason, note: string | null) => Promise<void>;
}) {
  const [reason, setReason] = useState<LeadLostReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!reason) {
      setError("Wybierz powód — bez niego szansa nie da się zamknąć.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason, note.trim() || null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zamknąć szansy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="lead-lost-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" aria-hidden />
            Szansa przegrana
          </DialogTitle>
          <DialogDescription>„{leadTitle}” — powód jest wymagany.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lead-lost-reason">Powód</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as LeadLostReason)}>
              <SelectTrigger id="lead-lost-reason" data-testid="lead-lost-reason">
                <SelectValue placeholder="Wybierz powód…" />
              </SelectTrigger>
              <SelectContent>
                {LOST_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {LOST_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-lost-note">Komentarz (opcjonalnie)</Label>
            <Textarea
              id="lead-lost-note"
              data-testid="lead-lost-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Np. wybrali tańszą ofertę konkurencji, wracamy za rok."
            />
          </div>
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
          <Button onClick={submit} disabled={busy} data-testid="lead-lost-submit">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Zamknij jako przegraną
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LeadLostDialog;
