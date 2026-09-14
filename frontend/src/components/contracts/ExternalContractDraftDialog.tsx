/**
 * „Dodaj PDF” — umowa, która NIE wyszła z generatora: skan podpisanego
 * egzemplarza, dokument przysłany przez klienta, umowa sprzed wdrożenia.
 *
 * DLACZEGO OSOBNE OKNO OD „Nowej umowy”. Tamto jest dwukrokowe, bo wybór wzoru
 * decyduje o całym formularzu (pola lecą z rejestru szablonów, wartości
 * z kartoteki). Tu wzoru nie ma — dokument przyszedł gotowy, a aplikacja ma
 * o nim wiedzieć tylko to, czego sama nie wyczyta z pliku: czyj jest, z jakiego
 * dnia, pod jakim numerem i w jakim stanie. Jedno okno obsługujące oba
 * przypadki musiałoby połowę siebie chować przed drugą połową.
 *
 * NUMER JEST OPCJONALNY i to jest tu najważniejsza decyzja. Umowa z papieru ma
 * już swój numer i to on musi zgadzać się z segregatorem, więc przepisujemy go
 * ręcznie. Ale bywa i tak, że dokument numeru nie ma (albo nikt go nie zna) —
 * wtedy puste pole znaczy „nadaj kolejny z serii spółki”, dokładnie jak przy
 * umowie z generatora.
 *
 * To samo okno służy do EDYCJI wgranego PDF-a (z podmianą pliku) — dialog
 * szablonowy nie miałby tu czego pokazać, bo pól umowy nie ma.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, Building2, FileText, Loader2, Save, Upload, X } from "lucide-react";
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
import { ObjectPicker } from "@/components/interventions/ObjectPicker";
import { errMsg, todayIso } from "@/components/interventions/helpers";
import { fmtFileSize } from "@/lib/attachments";
import {
  CONTRACT_DRAFT_STATUS_LABELS,
  contractDraftsApi,
  type ContractDraft,
  type ContractDraftStatus,
  type InterventionPickObject,
} from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { draftObjectsFetcher, draftPickObject } from "./draftsShared";

const STATUS_ORDER: ContractDraftStatus[] = ["draft", "sent", "signed", "rejected", "archived"];

/** Ten sam limit, co po stronie serwera (ATTACHMENT_MAX_BYTES). */
const MAX_BYTES = 5 * 1024 * 1024;

/** Powód odrzucenia pliku albo null. Serwer sprawdza to ponownie, łącznie z bajtami `%PDF-`. */
function pdfProblem(file: File): string | null {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isPdf) return `Plik ${file.name} nie jest PDF-em — umowę wgraj jako PDF.`;
  if (file.size === 0) return `Plik ${file.name} jest pusty.`;
  if (file.size > MAX_BYTES) return `Plik ${file.name} przekracza 5 MB.`;
  return null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = nowa umowa; wpis `source: "external"` = edycja. */
  draft: ContractDraft | null;
  /** Wejście z karty obiektu — obiekt jest z góry ustalony i zablokowany. */
  fixedObject?: InterventionPickObject | null;
  /** Podpowiedź z filtra listy — pole wypełnione, ale wolno je zmienić. */
  initialObject?: InterventionPickObject | null;
  onSaved: (draft: ContractDraft) => void;
}

export function ExternalContractDraftDialog({
  open,
  onClose,
  draft,
  fixedObject,
  initialObject,
  onSaved,
}: Props) {
  const isNew = !draft;

  const [object, setObject] = useState<InterventionPickObject | null>(
    draft ? draftPickObject(draft) : (fixedObject ?? initialObject ?? null)
  );
  const [file, setFile] = useState<File | null>(null);
  const [contractNumber, setContractNumber] = useState(draft?.contractNumber ?? "");
  const [contractDate, setContractDate] = useState(draft?.contractDate ?? todayIso());
  const [status, setStatus] = useState<ContractDraftStatus>(draft?.status ?? "draft");
  const [notes, setNotes] = useState(draft?.notes ?? "");

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Obiekt bez spółki nie ma serii numeracji ani właściciela dokumentu. */
  const objectWithoutCompany = object !== null && (object.companyId ?? null) === null;

  const take = useCallback((incoming: File | null | undefined) => {
    if (!incoming) return;
    const problem = pdfProblem(incoming);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(incoming);
    setError(null);
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    take(e.dataTransfer.files?.[0]);
  };

  // Zmiana obiektu przy NOWEJ umowie czyści ręczny numer: numer należy do serii
  // spółki tamtego obiektu, więc przeniesiony na inny byłby po prostu cudzy.
  useEffect(() => {
    if (!isNew) return;
    setContractNumber("");
  }, [isNew, object?.id]);

  const save = async () => {
    if (!object) {
      setError("Wybierz obiekt, którego dotyczy umowa.");
      return;
    }
    if (isNew && !file) {
      setError("Wybierz plik PDF z umową.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(contractDate)) {
      setError("Podaj datę zawarcia umowy.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let saved: ContractDraft;
      if (draft) {
        const res = await contractDraftsApi.update(draft.id, {
          contractDate,
          status,
          notes: notes.trim() || null,
          contractNumber: contractNumber.trim(),
        });
        saved = res.data ?? draft;
        // Plik podmieniamy PO zapisie pól — inaczej nieudana walidacja numeru
        // zostawiłaby nowy dokument przy starych danych.
        if (file) {
          const up = await contractDraftsApi.replaceFile(saved.id, file);
          saved = up.data ?? saved;
        }
      } else {
        const res = await contractDraftsApi.createExternal({
          objectId: object.id,
          file: file!,
          contractNumber: contractNumber.trim() || undefined,
          contractDate,
          status,
          notes: notes.trim() || null,
        });
        if (!res.data) throw new Error("Backend nie zwrócił zapisanej umowy.");
        saved = res.data;
      }
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać umowy."));
    } finally {
      setBusy(false);
    }
  };

  const objectMetaLine = [object?.city, object?.contractorName, object?.companyName]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,40rem)] max-w-none flex-col gap-3 overflow-y-auto focus:outline-none"
        data-testid="umowy-drafty-pdf-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">
            {isNew ? "Dodaj umowę w PDF" : `Umowa ${draft?.contractNumber ?? ""} (wgrany PDF)`}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? "Umowa, która nie wyszła z generatora: skan podpisanego egzemplarza albo dokument od klienta. Aplikacja nie zmienia pliku — dopisuje go do obiektu i nadaje mu miejsce w rejestrze."
              : "Poprawki opisu wgranej umowy. Plik możesz podmienić, jeśli przyszła nowa wersja dokumentu."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Obiekt</Label>
          <ObjectPicker
            value={object}
            onChange={setObject}
            // Obiekt nadaje serię numeru i właściciela dokumentu — po zapisie
            // przeniesienie umowy na inny obiekt osierociłoby numer.
            disabled={!!fixedObject || !isNew || busy}
            fetcher={draftObjectsFetcher}
            testid="umowy-drafty-pdf-obiekt"
          />
          {objectMetaLine && <p className="text-[11px] text-muted-foreground">{objectMetaLine}</p>}
        </div>

        {objectWithoutCompany && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            data-testid="umowy-drafty-pdf-brak-spolki"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Obiekt „{object?.name}” nie ma przypisanej spółki
            </p>
            <p className="mt-1">
              Umowa należy do spółki, która ją wystawiła — bez niej nie da się nadać numeru. Uzupełnij
              spółkę w kartotece obiektu.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Plik umowy (PDF)</Label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground transition-colors",
              dragging && "border-primary bg-primary/5"
            )}
            data-testid="umowy-drafty-pdf-drop"
          >
            <Upload className="h-5 w-5 text-muted-foreground/70" aria-hidden />
            <p>Przeciągnij PDF-a tutaj albo wybierz plik z dysku. Maksymalnie 5 MB.</p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                take(e.target.files?.[0]);
                // Wyczyszczenie pozwala wybrać TEN SAM plik drugi raz (po pomyłce).
                e.target.value = "";
              }}
              data-testid="umowy-drafty-pdf-input"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              data-testid="umowy-drafty-pdf-wybierz"
            >
              <FileText className="mr-1 h-4 w-4" aria-hidden /> Wybierz plik
            </Button>
          </div>

          {file ? (
            <p
              className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs"
              data-testid="umowy-drafty-pdf-wybrany"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="tabular-nums text-muted-foreground">{fmtFileSize(file.size)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={busy}
                onClick={() => setFile(null)}
                title="Usuń wybrany plik"
              >
                <X className="h-4 w-4" />
              </Button>
            </p>
          ) : (
            !isNew &&
            draft?.generatedFileName && (
              <p className="text-[11px] text-muted-foreground" data-testid="umowy-drafty-pdf-obecny">
                Obecny plik: {draft.generatedFileName}
                {draft.generatedAt ? ` (wgrany ${formatDate(draft.generatedAt)})` : ""}. Wybierz nowy,
                żeby go podmienić.
              </p>
            )
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="umowy-drafty-pdf-numer" className="text-xs">
              Numer umowy
            </Label>
            <Input
              id="umowy-drafty-pdf-numer"
              value={contractNumber}
              disabled={busy}
              placeholder="puste = numer z serii spółki"
              onChange={(e) => setContractNumber(e.target.value)}
              className="tabular-nums"
              data-testid="umowy-drafty-pdf-numer"
            />
            <p className="text-[11px] leading-tight text-muted-foreground">
              Przepisz numer z dokumentu. Puste pole = kolejny numer z serii spółki, jak przy umowie
              z generatora.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="umowy-drafty-pdf-data" className="text-xs">
              Data zawarcia
            </Label>
            <Input
              id="umowy-drafty-pdf-data"
              type="date"
              value={contractDate}
              disabled={busy}
              onChange={(e) => setContractDate(e.target.value)}
              className="tabular-nums"
              data-testid="umowy-drafty-pdf-data"
            />
            <p className="text-[11px] leading-tight text-muted-foreground">
              Z niej bierze się rok w numerze nadawanym z serii.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="umowy-drafty-pdf-status" className="text-xs">
              Status
            </Label>
            <Select value={status} disabled={busy} onValueChange={(v) => setStatus(v as ContractDraftStatus)}>
              <SelectTrigger id="umowy-drafty-pdf-status" data-testid="umowy-drafty-pdf-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CONTRACT_DRAFT_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="umowy-drafty-pdf-notatki" className="text-xs">
              Notatki (nie trafiają do dokumentu)
            </Label>
            <Textarea
              id="umowy-drafty-pdf-notatki"
              rows={2}
              value={notes}
              disabled={busy}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="umowy-drafty-pdf-notatki"
            />
          </div>
        </div>

        {error && (
          <p
            className="flex items-start gap-1.5 text-xs text-destructive"
            role="alert"
            data-testid="umowy-drafty-pdf-error"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
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
            disabled={busy || !object || (isNew && !file)}
            data-testid="umowy-drafty-pdf-zapisz"
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="mr-1 h-4 w-4" aria-hidden />
            )}
            {isNew ? "Wgraj umowę" : "Zapisz"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
