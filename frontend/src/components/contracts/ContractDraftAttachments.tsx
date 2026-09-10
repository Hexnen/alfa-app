/**
 * Załączniki draftu umowy — skan podpisanego egzemplarza, korespondencja,
 * aneksy. To okno działa TYLKO na zapisanym drafcie (pliki idą pod istniejącą
 * encję), więc przy tworzeniu umowy kolejka plików siedzi w `ContractDraftDialog`.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { contractDraftsApi, type ContractDraft } from "@/lib/api";
import { errMsg } from "@/components/interventions/helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  draft: ContractDraft;
  /** `canEdit("contracts")` — bez tego sama lista, bez dodawania i kasowania. */
  editable: boolean;
  /** Odpowiedź backendu z aktualną listą załączników. */
  onChanged: (draft: ContractDraft) => void;
}

export function ContractDraftAttachments({ open, onClose, draft, editable, onChanged }: Props) {
  const [attachments, setAttachments] = useState(draft.attachments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = usePendingAttachments({ scopeSuffix: "na umowę" });

  const upload = async () => {
    if (!queue.pending.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await contractDraftsApi.addAttachments(
        draft.id,
        queue.pending.map((p) => p.file)
      );
      queue.clearPending();
      if (res.data) {
        setAttachments(res.data.attachments);
        onChanged(res.data);
      }
    } catch (e) {
      setError(errMsg(e, "Nie udało się wysłać plików."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: { id: number; fileName: string }) => {
    if (busy) return;
    if (!window.confirm(`Usunąć załącznik „${a.fileName}”? Pliku nie da się przywrócić.`)) return;
    setBusy(true);
    setError(null);
    try {
      await contractDraftsApi.deleteAttachment(draft.id, a.id);
      const next = attachments.filter((x) => x.id !== a.id);
      setAttachments(next);
      onChanged({ ...draft, attachments: next });
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,40rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="umowy-drafty-att-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">Załączniki umowy {draft.contractNumber}</DialogTitle>
          <DialogDescription>
            {draft.objectName}
            {draft.contractorName ? ` · ${draft.contractorName}` : ""} — skan podpisanej umowy,
            korespondencja, aneksy. Wygenerowany DOCX pobierzesz z listy, tu go nie ma.
          </DialogDescription>
        </DialogHeader>

        {editable && (
          <AttachmentUploader
            queue={queue}
            existingCount={attachments.length}
            disabled={busy}
            label="Załączniki"
            testid="umowy-drafty-att"
          />
        )}

        <AttachmentList
          attachments={attachments}
          onDelete={editable ? (a) => void remove(a) : undefined}
          deleteDisabled={busy}
          emptyText={
            queue.pending.length === 0
              ? "Brak plików. Przeciągnij je tutaj albo kliknij „Dodaj pliki”."
              : undefined
          }
          testid="umowy-drafty-att-list"
        />

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="umowy-drafty-att-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Zamknij
          </Button>
          {editable && (
            <Button
              type="button"
              onClick={() => void upload()}
              disabled={busy || queue.pending.length === 0}
              data-testid="umowy-drafty-att-wyslij"
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              Wyślij pliki ({queue.pending.length})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
