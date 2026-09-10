/**
 * Podgląd i wysyłka maili modułu „Grupy interwencyjne” — rodzeństwo
 * `components/OrderMailPreviewDialog.tsx`, te same zasady:
 *
 *  • treść składa BACKEND (`POST /mail/preview`) z szablonu z ustawień, front
 *    pokazuje gotowy HTML w `<iframe srcDoc sandbox="allow-same-origin">`
 *    (bez `allow-scripts` — mail jest obrazkiem, nic się z niego nie wykona);
 *  • edytowalni są tylko adresaci; temat i treść zostają, bo inaczej podgląd
 *    rozjechałby się z tym, co faktycznie poszło;
 *  • o tym, CZY wolno wysłać, decyduje backend (`sending.ready`), front dokłada
 *    warunek uprawnień (`canSend`).
 *
 * Dwa warianty: „Zapytanie o ofertę” (rfq — obiekt opcjonalny, można go wybrać
 * pickerem) i „Wypowiedzenie” (termination — zawsze z konkretnego wiersza
 * warunków, bo to z niego biorą się daty).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  Mail,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MailLogTable } from "@/components/MailLogTable";
import { usePerms } from "@/auth/permissions";
import { cn } from "@/lib/utils";
import { toPasteHtml } from "@/lib/mail-paste";
import {
  interventionsApi,
  type InterventionMailKind,
  type InterventionMailPreview,
  type InterventionPickObject,
  type MailLogEntry,
} from "@/lib/api";
import { ObjectPicker } from "./ObjectPicker";
import { errMsg } from "./helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  kind: InterventionMailKind;
  companyId: number;
  /** Nazwa firmy do nagłówka okna (podgląd i tak przychodzi z backendu). */
  companyName?: string;
  /** Obiekt kontekstu — dla „rfq” opcjonalny, można go dobrać pickerem. */
  objectId?: number;
  /** Wiersz warunków — wymagany dla „termination” (z niego biorą się daty). */
  termId?: number;
  canSend?: boolean;
}

const KIND_LABEL: Record<InterventionMailKind, string> = {
  rfq: "Zapytanie o ofertę",
  termination: "Wypowiedzenie obiektu",
};

/** Który przycisk ma przez chwilę pokazywać „Skopiowano”. */
type CopyTarget = "mail" | "subject" | "recipients";

/** Ta sama prosta walidacja co w panelu Poczty — łapie literówki, nie RFC 5322. */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const parseAddresses = (raw: string): string[] =>
  raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const invalidAddresses = (raw: string): string[] =>
  parseAddresses(raw).filter((a) => !EMAIL_RE.test(a));

export function InterventionMailDialog({
  open,
  onClose,
  kind,
  companyId,
  companyName,
  objectId,
  termId,
  canSend = false,
}: Props) {
  const [preview, setPreview] = useState<InterventionMailPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  /** Obiekt dobrany w oknie (tylko RFQ bez kontekstu obiektu). */
  const [pickedObject, setPickedObject] = useState<InterventionPickObject | null>(null);

  // `null` = „człowiek nie tknął, bierz z podglądu”.
  const [to, setTo] = useState<string | null>(null);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendOk, setSendOk] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<MailLogEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const perms = usePerms();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveObjectId = objectId ?? pickedObject?.id;

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const flashCopied = useCallback((target: CopyTarget) => {
    setActionError(null);
    setCopied(target);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(null), 2000);
  }, []);

  // Podgląd przeliczamy przy każdej zmianie kontekstu (wariant, firma, obiekt).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setActionError(null);
      setPreview(null);
      setCopied(null);
      try {
        const res = await interventionsApi.mailPreview({
          kind,
          companyId,
          objectId: effectiveObjectId,
          termId,
        });
        if (cancelled) return;
        setPreview(res.data ?? null);
      } catch (e) {
        if (!cancelled) setError(errMsg(e, "Nie udało się zbudować podglądu maila."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, kind, companyId, effectiveObjectId, termId]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const items = await interventionsApi.mailLog({ companyId, limit: 50 });
      setHistory(items);
      setHistoryError(null);
    } catch (e) {
      setHistory([]);
      setHistoryError(errMsg(e, "Nie udało się wczytać historii wysyłek."));
    } finally {
      setHistoryLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (!open || !historyOpen) return;
    void loadHistory();
  }, [open, historyOpen, loadHistory]);

  const openInNewTab = useCallback(() => {
    if (!preview) return;
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) {
      setActionError("Przeglądarka zablokowała nowe okno — zezwól na wyskakujące okna.");
      return;
    }
    win.document.write(preview.html);
    win.document.close();
    win.focus();
  }, [preview]);

  /** Awaryjne kopiowanie: zaznaczenie treści ramki + `execCommand("copy")`. */
  const copyBySelectingFrame = useCallback((): boolean => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!frame || !doc?.body || !win) return false;
    const selection = win.getSelection?.();
    if (!selection) return false;
    const active = document.activeElement as HTMLElement | null;
    try {
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      selection.removeAllRanges();
      selection.addRange(range);
      win.focus();
      const ok = doc.execCommand("copy");
      selection.removeAllRanges();
      return ok;
    } catch {
      return false;
    } finally {
      active?.focus?.();
    }
  }, []);

  const copyForOutlook = useCallback(async () => {
    if (!preview) return;
    setActionError(null);
    const html = toPasteHtml(preview.html);
    const plain = preview.text || "";
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
        flashCopied("mail");
        return;
      }
    } catch {
      // Odmowa uprawnień albo brak gestu — próbujemy jeszcze zaznaczeniem.
    }
    if (copyBySelectingFrame()) {
      flashCopied("mail");
      return;
    }
    setActionError("Nie udało się skopiować — otwórz w nowej karcie i użyj Ctrl+A, Ctrl+C.");
  }, [preview, copyBySelectingFrame, flashCopied]);

  const copyPlain = useCallback(
    async (value: string, target: CopyTarget) => {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        flashCopied(target);
      } catch {
        setActionError("Schowek jest niedostępny w tej przeglądarce.");
      }
    },
    [flashCopied]
  );

  const recipients = to ?? preview?.to ?? "";
  const toBad = invalidAddresses(recipients);
  const ccBad = invalidAddresses(cc);
  const bccBad = invalidAddresses(bcc);
  const toList = parseAddresses(recipients);
  const recipientsForOutlook = [...toList, ...parseAddresses(cc)].join("; ");

  const sendReady = preview?.sending?.ready === true;
  const sendReason = preview?.sending?.reason ?? "backend nie udostępnia jeszcze wysyłki maili";
  const addressesOk = toList.length > 0 && !toBad.length && !ccBad.length && !bccBad.length;
  const sendDisabled = !preview || !canSend || !sendReady || !addressesOk || sending;
  const sendBlockedTitle = !canSend
    ? "Brak uprawnień do edycji Grup interwencyjnych"
    : !sendReady
      ? sendReason
      : toList.length === 0
        ? "Podaj co najmniej jednego adresata"
        : !addressesOk
          ? "Popraw niepoprawne adresy"
          : undefined;

  const doSend = async () => {
    setSending(true);
    setSendOk(null);
    setSendError(null);
    try {
      const res = await interventionsApi.sendMail({
        kind,
        companyId,
        objectId: effectiveObjectId,
        termId,
        to: toList,
        cc: parseAddresses(cc),
        bcc: parseAddresses(bcc),
      });
      if (res.ok) {
        setSendOk(
          `Wysłano ✓ ${new Date().toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}`
        );
      } else {
        setSendError(res.error ?? "Nie udało się wysłać maila.");
      }
      // Nieudana próba też jest wpisem w dzienniku — historia ma to pokazać.
      setHistoryOpen(true);
      void loadHistory();
    } finally {
      setSending(false);
      setConfirmOpen(false);
    }
  };

  const headerInput = "h-8 text-xs";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !sending && onClose()}>
      <DialogContent
        className="flex h-[92vh] max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        data-testid="interwencje-mail-dialog"
      >
        <DialogHeader className="shrink-0 space-y-1 border-b px-6 pb-3 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-indigo-600" />
            {KIND_LABEL[kind]}
            {companyName ? ` — ${companyName}` : ""}
          </DialogTitle>

          <DialogDescription asChild>
            <div className="space-y-1 pt-1.5 text-sm text-muted-foreground">
              {/* Obiekt dobieramy tylko w zapytaniu o ofertę — wypowiedzenie
                  zawsze wychodzi z konkretnego wiersza warunków. */}
              {kind === "rfq" && !objectId && (
                <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-2">
                  <span className="text-xs">Obiekt:</span>
                  <ObjectPicker
                    value={pickedObject}
                    onChange={setPickedObject}
                    placeholder="opcjonalnie — obiekt, którego dotyczy zapytanie"
                    testid="interwencje-mail-obiekt"
                  />
                </div>
              )}

              <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
                <label htmlFor="interwencje-mail-to" className="text-xs">
                  Do:
                </label>
                <Input
                  id="interwencje-mail-to"
                  data-testid="interwencje-mail-to"
                  className={cn(headerInput, toBad.length && "border-red-500 focus-visible:ring-red-500")}
                  value={recipients}
                  placeholder="adresy po przecinku"
                  aria-invalid={toBad.length > 0}
                  onChange={(e) => setTo(e.target.value)}
                />

                <label htmlFor="interwencje-mail-cc" className="text-xs">
                  DW:
                </label>
                <div className="grid grid-cols-[minmax(0,1fr)_2.6rem_minmax(0,1fr)] items-center gap-2">
                  <Input
                    id="interwencje-mail-cc"
                    data-testid="interwencje-mail-cc"
                    className={cn(headerInput, ccBad.length && "border-red-500 focus-visible:ring-red-500")}
                    value={cc}
                    placeholder="—"
                    aria-invalid={ccBad.length > 0}
                    onChange={(e) => setCc(e.target.value)}
                  />
                  <label htmlFor="interwencje-mail-bcc" className="text-xs">
                    UDW:
                  </label>
                  <Input
                    id="interwencje-mail-bcc"
                    data-testid="interwencje-mail-bcc"
                    className={cn(headerInput, bccBad.length && "border-red-500 focus-visible:ring-red-500")}
                    value={bcc}
                    placeholder="—"
                    aria-invalid={bccBad.length > 0}
                    onChange={(e) => setBcc(e.target.value)}
                  />
                </div>
              </div>

              {(toBad.length > 0 || ccBad.length > 0 || bccBad.length > 0) && (
                <div className="text-xs text-red-600" data-testid="interwencje-mail-address-error">
                  Niepoprawne adresy: {[...toBad, ...ccBad, ...bccBad].join(", ")}
                </div>
              )}

              <div data-testid="interwencje-mail-subject" className="pt-0.5">
                <span>Temat:</span> <span className="text-foreground">{preview?.subject || "—"}</span>
              </div>

              {preview && preview.missing.length > 0 && (
                <div
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
                  data-testid="interwencje-mail-missing"
                >
                  Brak danych do pól: {preview.missing.join(", ")} — uzupełnij kartotekę albo popraw treść ręcznie
                  po wklejeniu.
                </div>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 bg-muted/40 px-6 py-3">
          {loading && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Buduję podgląd…
            </div>
          )}
          {!loading && error && (
            <div
              className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive"
              data-testid="interwencje-mail-error"
            >
              {error}
            </div>
          )}
          {!loading && !error && preview && (
            <iframe
              ref={frameRef}
              title="Podgląd maila"
              srcDoc={preview.html}
              sandbox="allow-same-origin"
              className="h-full w-full rounded border bg-white"
              data-testid="interwencje-mail-frame"
            />
          )}
        </div>

        <div className="shrink-0 space-y-1.5 border-t px-6 py-3">
          {sendOk && (
            <div
              className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700"
              role="status"
              data-testid="interwencje-mail-send-ok"
            >
              {sendOk}
            </div>
          )}
          {sendError && (
            <div
              className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
              data-testid="interwencje-mail-send-error"
            >
              {sendError}
            </div>
          )}
          {actionError && (
            <div className="text-xs text-destructive" data-testid="interwencje-mail-copy-error">
              {actionError}
            </div>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
              data-testid="interwencje-mail-history-toggle"
            >
              {historyOpen ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
              Historia wysyłek do tej firmy
              {history.length > 0 && <span>({history.length})</span>}
            </button>
            {historyOpen && (
              <div className="mt-2 max-h-48 overflow-y-auto" data-testid="interwencje-mail-history">
                {historyLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Wczytywanie…
                  </div>
                ) : historyError ? (
                  <p className="text-xs text-muted-foreground">{historyError}</p>
                ) : (
                  <MailLogTable items={history} compact emptyText="Do tej firmy nic jeszcze nie wysłano." />
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Do pól nagłówka:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyPlain(preview?.subject ?? "", "subject")}
              disabled={!preview?.subject}
              data-testid="interwencje-mail-copy-subject"
            >
              {copied === "subject" ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-600" /> : null}
              {copied === "subject" ? "Skopiowano ✓" : "Kopiuj temat"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyPlain(recipientsForOutlook, "recipients")}
              disabled={!recipientsForOutlook}
              data-testid="interwencje-mail-copy-to"
            >
              {copied === "recipients" ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-600" /> : null}
              {copied === "recipients" ? "Skopiowano ✓" : "Kopiuj adresata"}
            </Button>
          </div>

          {!sendReady && preview && (
            <div className="text-xs text-muted-foreground" data-testid="interwencje-mail-send-hint">
              {sendReason}. Ustawienia:{" "}
              {perms.isAdmin ? (
                <Link to="/admin/poczta" className="text-indigo-600 underline underline-offset-2">
                  Administracja → Poczta
                </Link>
              ) : (
                "Administracja → Poczta"
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={openInNewTab}
              disabled={!preview}
              data-testid="interwencje-mail-newtab"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Otwórz w nowej karcie
            </Button>
            <Button onClick={() => void copyForOutlook()} disabled={!preview} data-testid="interwencje-mail-copy">
              {copied === "mail" ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <ClipboardCopy className="mr-2 h-4 w-4" />
              )}
              {copied === "mail" ? "Skopiowano ✓" : "Kopiuj do Outlooka"}
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={sendDisabled}
              title={sendBlockedTitle}
              data-testid="interwencje-mail-send"
            >
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Wyślij
            </Button>
            <Button variant="ghost" onClick={onClose} data-testid="interwencje-mail-close">
              Zamknij
            </Button>
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Potwierdź wysyłkę</AlertDialogTitle>
            <AlertDialogDescription>
              {`Wysłać „${KIND_LABEL[kind]}” do ${toList.join(", ") || "—"}${
                parseAddresses(cc).length ? ` (DW: ${parseAddresses(cc).join(", ")})` : ""
              }${parseAddresses(bcc).length ? ` (UDW: ${parseAddresses(bcc).join(", ")})` : ""}?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="interwencje-mail-send-confirm"
              disabled={sending}
              onClick={(e) => {
                e.preventDefault();
                void doSend();
              }}
            >
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Wyślij
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
