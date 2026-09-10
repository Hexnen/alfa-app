/**
 * Formularz firmy interwencyjnej: dane kontaktowe, obszar działania, notatki,
 * status i sekcja „Umowy ramowe” (załączniki firmy).
 *
 * Flow create-then-upload: przy nowej firmie najpierw leci POST z polami, a
 * dopiero potem `addCompanyAttachments(newId, …)` — backend przyjmuje pliki
 * wyłącznie pod istniejącą encję. Dzięki temu widać, który krok padł.
 */
import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  type InterventionAttachment,
  type InterventionCompany,
} from "@/lib/api";
import { errMsg } from "./helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = nowa firma. */
  company: InterventionCompany | null;
  onSaved: (company: InterventionCompany) => void;
}

export function InterventionCompanyDialog({ open, onClose, company, onSaved }: Props) {
  const isNew = !company;
  const [name, setName] = useState(company?.name ?? "");
  const [area, setArea] = useState(company?.area ?? "");
  const [contactPerson, setContactPerson] = useState(company?.contactPerson ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [email, setEmail] = useState(company?.email ?? "");
  const [notes, setNotes] = useState(company?.notes ?? "");
  const [active, setActive] = useState(company?.active ?? true);
  const [attachments, setAttachments] = useState<InterventionAttachment[]>(company?.attachments ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = usePendingAttachments({ scopeSuffix: "na firmę" });

  const deleteAttachment = async (a: { id: number; fileName: string }) => {
    if (busy || !company) return;
    if (!window.confirm(`Usunąć załącznik „${a.fileName}”? Pliku nie da się przywrócić.`)) return;
    try {
      await interventionsApi.deleteCompanyAttachment(company.id, a.id);
      setAttachments((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      setError(errMsg(e, "Nie udało się usunąć załącznika."));
    }
  };

  const save = async () => {
    const n = name.trim();
    if (!n) {
      setError("Nazwa firmy jest wymagana.");
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name: n,
      area: area.trim() || null,
      contactPerson: contactPerson.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      notes: notes.trim() || null,
      active,
    };
    try {
      let latest: InterventionCompany;
      if (company) {
        const res = await interventionsApi.updateCompany(company.id, body);
        latest = res.data ?? company;
      } else {
        const res = await interventionsApi.createCompany(body);
        if (!res.data) throw new Error("Backend nie zwrócił zapisanej firmy.");
        latest = res.data;
      }
      if (queue.pending.length) {
        const up = await interventionsApi.addCompanyAttachments(
          latest.id,
          queue.pending.map((p) => p.file)
        );
        queue.clearPending();
        if (up.data) latest = up.data;
      }
      onSaved(latest);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać firmy."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,44rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="interwencje-firma-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{isNew ? "Nowa firma interwencyjna" : "Edycja firmy"}</DialogTitle>
          <DialogDescription>
            Dane kontaktowe podwykonawcy i umowy ramowe. Warunki na obiektach są w panelu „Obiekty”.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="interwencje-firma-nazwa">Nazwa</Label>
          <Input
            id="interwencje-firma-nazwa"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. Grupa Interwencyjna Sokół sp. z o.o."
            disabled={busy}
            data-testid="interwencje-firma-nazwa"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-firma-obszar">Obszar działania</Label>
            <Input
              id="interwencje-firma-obszar"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="np. Kraków i powiat krakowski"
              disabled={busy}
              data-testid="interwencje-firma-obszar"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-firma-osoba">Osoba kontaktowa</Label>
            <Input
              id="interwencje-firma-osoba"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              disabled={busy}
              data-testid="interwencje-firma-osoba"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-firma-telefon">Telefon</Label>
            <Input
              id="interwencje-firma-telefon"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              data-testid="interwencje-firma-telefon"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="interwencje-firma-email">E-mail</Label>
            <Input
              id="interwencje-firma-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="adres, na który idzie zapytanie o ofertę"
              disabled={busy}
              data-testid="interwencje-firma-email"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="interwencje-firma-notatki">Notatki</Label>
          <Textarea
            id="interwencje-firma-notatki"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            disabled={busy}
            data-testid="interwencje-firma-notatki"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={active}
            onCheckedChange={(v) => setActive(v === true)}
            disabled={busy}
            data-testid="interwencje-firma-aktywna"
          />
          Firma aktywna (widoczna przy dodawaniu warunków)
        </label>

        {/* --- Umowy ramowe --- */}
        <div className="space-y-2 rounded-md border p-3">
          <AttachmentUploader
            queue={queue}
            existingCount={attachments.length}
            disabled={busy}
            label="Umowy ramowe"
            testid="interwencje-firma-att"
          />
          <AttachmentList
            attachments={attachments}
            onDelete={company ? (a) => void deleteAttachment(a) : undefined}
            deleteDisabled={busy}
            emptyText={
              queue.pending.length === 0
                ? "Brak plików. Przeciągnij je tutaj albo kliknij „Dodaj pliki”."
                : undefined
            }
            testid="interwencje-firma-att-list"
          />
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="interwencje-firma-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="interwencje-firma-zapisz">
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {busy ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
