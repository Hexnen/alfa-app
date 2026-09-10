/**
 * Formularz osoby kontaktowej.
 *
 * Dwie reguły pilnuje backend, a formularz tylko je uprzedza, żeby użytkownik
 * nie zderzał się z błędem po zapisie: NAZWISKO jest wymagane, a kontakt musi
 * mieć co najmniej jedno powiązanie (kontrahent, szansa albo obiekt) — kontakt
 * bez żadnego z nich nigdzie by się nie pokazał.
 *
 * „Główna osoba" jest jedna na kontrahenta: zaznaczenie zdejmuje flagę
 * poprzedniej (transakcja po stronie API), więc formularz mówi o tym wprost
 * zamiast udawać, że to zwykły przełącznik.
 */
import { useEffect, useState } from "react";
import { Handshake, Loader2, Save, Star, User } from "lucide-react";
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
import { LeadPicker, type LeadRef } from "@/components/sales/LeadPicker";
import {
  contactsApi,
  getContractorCatalog,
  type Contact,
  type ContactInput,
  type ContractorCatalogEntry,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ContactDialogProps {
  open: boolean;
  onClose: () => void;
  /** `null` = nowa osoba kontaktowa. */
  contact: Contact | null;
  /** Powiązania podpowiedziane przez ekran, z którego przyszło otwarcie. */
  defaults?: { contractorId?: number | null; leadId?: number | null; objectId?: number | null };
  onSaved: (contact: Contact) => void;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function ContactDialog({ open, onClose, contact, defaults, onSaved }: ContactDialogProps) {
  const isNew = contact == null;

  const [firstName, setFirstName] = useState(contact?.firstName ?? "");
  const [lastName, setLastName] = useState(contact?.lastName ?? "");
  const [role, setRole] = useState(contact?.role ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [notes, setNotes] = useState(contact?.notes ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [active, setActive] = useState(contact?.active ?? true);
  const [contractorId, setContractorId] = useState<number | null>(
    contact?.contractorId ?? defaults?.contractorId ?? null
  );
  const [lead, setLead] = useState<LeadRef | null>(
    contact?.leadId != null
      ? { id: contact.leadId, title: contact.leadTitle ?? `Szansa #${contact.leadId}` }
      : defaults?.leadId != null
        ? { id: defaults.leadId, title: `Szansa #${defaults.leadId}` }
        : null
  );
  /** Obiekt tylko pokazujemy — przypina się go z kartoteki obiektu, nie stąd. */
  const objectId = contact?.objectId ?? defaults?.objectId ?? null;

  const [contractors, setContractors] = useState<ContractorCatalogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    getContractorCatalog()
      .then((res) => setContractors(res.data ?? []))
      .catch(() => setContractors([]));
  }, [open]);

  const hasLink = contractorId != null || lead != null || objectId != null;
  const canSave = lastName.trim().length > 0 && hasLink && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const payload: ContactInput = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: role.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      notes: notes.trim() || null,
      isPrimary,
      active,
      contractorId,
      leadId: lead?.id ?? null,
      objectId,
    };
    try {
      const res = isNew
        ? await contactsApi.create(payload)
        : await contactsApi.update(contact!.id, payload);
      if (res.data) onSaved(res.data);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać kontaktu."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[min(96vw,36rem)] max-w-none flex-col gap-3 overflow-y-auto" data-testid="contact-dialog">
        <DialogHeader>
          <DialogTitle className="pr-8">{isNew ? "Nowa osoba kontaktowa" : "Edycja osoby kontaktowej"}</DialogTitle>
          <DialogDescription>
            Nazwisko i przynajmniej jedno powiązanie (kontrahent, szansa albo obiekt) są wymagane.
          </DialogDescription>
        </DialogHeader>

        <Section icon={User} title="Osoba" id="contact-person">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-first">Imię</Label>
              <Input
                id="contact-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={busy}
                data-testid="contact-first-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-last">Nazwisko</Label>
              <Input
                id="contact-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={busy}
                aria-invalid={lastName.trim() === ""}
                data-testid="contact-last-input"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-role">Rola</Label>
            <Input
              id="contact-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="np. kierownik obiektu, właściciel, administrator"
              disabled={busy}
              data-testid="contact-role-input"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-phone">Telefon</Label>
              <Input
                id="contact-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
                data-testid="contact-phone-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-email">E-mail</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                data-testid="contact-email-input"
              />
            </div>
          </div>
        </Section>

        <Section icon={Handshake} title="Powiązania" id="contact-links">
          <div className="space-y-1.5">
            <Label htmlFor="contact-contractor">Kontrahent</Label>
            <Select
              value={contractorId == null ? "all" : String(contractorId)}
              onValueChange={(v) => setContractorId(v === "all" ? null : Number(v))}
              disabled={busy}
            >
              <SelectTrigger id="contact-contractor" data-testid="contact-contractor-select">
                <SelectValue placeholder="Kontrahent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Bez kontrahenta</SelectItem>
                {contractors.map((ct) => (
                  <SelectItem key={ct.id} value={String(ct.id)}>
                    {ct.name}
                    {!ct.active ? " (nieaktywny)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contact-lead">Szansa sprzedaży</Label>
            <LeadPicker
              inputId="contact-lead"
              value={lead}
              onPick={(l) => setLead({ id: l.id, title: l.title, stage: l.stage, clientLabel: l.clientLabel })}
              onClear={() => setLead(null)}
              disabled={busy}
            />
          </div>

          {objectId != null && (
            <p className="text-xs text-muted-foreground">
              Powiązany obiekt #{objectId} — powiązanie zakłada się z kartoteki obiektu.
            </p>
          )}

          {!hasLink && (
            <p className="text-xs text-amber-600">
              Wskaż kontrahenta albo szansę — bez powiązania kontakt nigdzie się nie pokaże.
            </p>
          )}
        </Section>

        <Section icon={Star} title="Ustawienia" id="contact-flags">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={isPrimary}
              disabled={busy || contractorId == null}
              onChange={(e) => setIsPrimary(e.target.checked)}
              data-testid="contact-primary-checkbox"
            />
            <span>
              Główna osoba kontaktowa u kontrahenta
              <span className="block text-xs text-muted-foreground">
                {contractorId == null
                  ? "Dostępne po wskazaniu kontrahenta."
                  : "Zaznaczenie zdejmie tę flagę poprzedniej osobie tego kontrahenta."}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={active}
              disabled={busy}
              onChange={(e) => setActive(e.target.checked)}
              data-testid="contact-active-checkbox"
            />
            <span>
              Aktywna
              <span className="block text-xs text-muted-foreground">
                Nieaktywne osoby zostają w historii spotkań, ale znikają z podpowiedzi.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="contact-notes">Notatka</Label>
            <Textarea
              id="contact-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              data-testid="contact-notes-input"
            />
          </div>
        </Section>

        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="contact-dialog-error">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Anuluj
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className={cn(!canSave && "cursor-not-allowed")}
            data-testid="contact-save"
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {busy ? "Zapisywanie…" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ContactDialog;
