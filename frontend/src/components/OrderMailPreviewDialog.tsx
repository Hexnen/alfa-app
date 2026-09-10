/**
 * Podgląd i wysyłka maili zlecenia — w dwóch wariantach:
 *   • „Do klienta” — potwierdzenie przyjęcia zlecenia (tylko wypełnione pola),
 *   • „Wewnętrzny” — komplet danych dla zespołu (braki jako „—”).
 *
 * Oba szablony składa BACKEND (src/lib/order-mail.ts, GET /api/orders/:id/mail-preview
 * ?variant=client|internal) — front tylko pokazuje gotowy HTML. Dzięki temu wysyłka
 * nodemailerem wysyła dokładnie to, co człowiek zobaczył w tym oknie.
 *
 * HTML renderujemy w `<iframe srcDoc sandbox="allow-same-origin">`: mail ma własne,
 * inline'owe style i nie może przeciec do arkusza aplikacji (ani odwrotnie).
 * `allow-same-origin` jest potrzebne wyłącznie po to, żeby awaryjne kopiowanie
 * (zaznaczenie treści ramki + `execCommand("copy")`) miało dostęp do
 * `contentDocument`. Skryptów NIE dopuszczamy (brak `allow-scripts`), więc mail
 * dalej jest tylko obrazkiem — nic z jego wnętrza się nie wykona.
 *
 * ADRESACI SĄ EDYTOWALNE, temat nie. Adresy to jedyne, co przy wysyłce bywa
 * inne niż w kartotece (klient poda drugi mail, dyspozytor dorzuci kolegę), a
 * temat i treść składa szablon — ręczna podmianka rozjechałaby podgląd z tym,
 * co faktycznie poszło.
 *
 * O tym, CZY wolno wysłać, decyduje backend (`preview.sending`), a nie front:
 * przełącznik wysyłki, konto SMTP i adresat zespołu siedzą w Administracja →
 * Poczta. Front dokłada tylko warunek uprawnień (`canSend`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Check,
  ExternalLink,
  Loader2,
  Mail,
  Send,
} from "lucide-react";
import { MailLogTable } from "@/components/MailLogTable";
import { usePerms } from "@/auth/permissions";
import { cn } from "@/lib/utils";
import { toPasteHtml } from "@/lib/mail-paste";
import {
  getOrderMailLog,
  getOrderMailPreview,
  isMissingEndpoint,
  sendOrderMail,
  type MailLogEntry,
  type Order,
  type OrderMailPreview,
  type OrderMailVariant,
} from "@/lib/api";

interface Props {
  order: Order | null;
  open: boolean;
  onClose: () => void;
  /** Czy użytkownik ma edycję Zleceń. Bez tego „Wyślij” zostaje nieaktywny. */
  canSend?: boolean;
}

/** Podpowiedź, gdy wdrożenie nie ma ustawionej skrzynki zespołu. */
const NO_INTERNAL_RECIPIENT = "(nie skonfigurowano — Administracja → Poczta)";

/** Który przycisk ma przez chwilę pokazywać „Skopiowano”. */
type CopyTarget = "mail" | "subject" | "recipients";

/** Nagłówek wiadomości w postaci, w jakiej człowiek go edytuje (tekst, nie lista). */
interface Recipients {
  to: string;
  cc: string;
  bcc: string;
}

const VARIANT_LABEL: Record<OrderMailVariant, string> = {
  client: "do klienta",
  internal: "wewnętrzny",
};

/** Ta sama prosta walidacja co w panelu Poczty — łapie literówki, nie RFC 5322. */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** „a@x.pl, b@y.pl; " → ["a@x.pl", "b@y.pl"] */
const parseAddresses = (raw: string): string[] =>
  raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const invalidAddresses = (raw: string): string[] =>
  parseAddresses(raw).filter((a) => !EMAIL_RE.test(a));

export function OrderMailPreviewDialog({ order, open, onClose, canSend = false }: Props) {
  const [variant, setVariant] = useState<OrderMailVariant>("client");
  const [preview, setPreview] = useState<OrderMailPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  // Błędy akcji ze stopki lecą osobno: `error` zastępuje podgląd, a nieudane
  // kopiowanie nie jest powodem, żeby zabierać człowiekowi mail z ekranu.
  const [actionError, setActionError] = useState<string | null>(null);

  // Ręczne poprawki adresatów. `null` = „człowiek nie tknął, bierz z podglądu”,
  // dzięki czemu odświeżony podgląd nie nadpisuje tego, co ktoś dopisał.
  const [edited, setEdited] = useState<Partial<Record<OrderMailVariant, Recipients>>>({});

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

  const orderId = order?.id ?? null;

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const flashCopied = useCallback((target: CopyTarget) => {
    setActionError(null);
    setCopied(target);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(null), 2000);
  }, []);

  // Cache per wariant trzymamy w ref, a nie w stanie: przełączanie zakładek
  // tam i z powrotem nie ma odpytywać backendu, ale sam cache nie jest niczym,
  // co miałoby wywołać render (renderujemy `preview`).
  const cacheRef = useRef<{ orderId: number | null; entries: Partial<Record<OrderMailVariant, OrderMailPreview>> }>({
    orderId: null,
    entries: {},
  });

  useEffect(() => {
    if (!open || orderId === null) return;
    let cancelled = false;

    // Cały stan (czyszczenie + wynik) ustawiamy w asynchronicznej funkcji, a nie
    // wprost w ciele efektu — inaczej pierwszy render dialogu robi kaskadę renderów
    // (reguła react-hooks/set-state-in-effect).
    const load = async () => {
      // Inne zlecenie → cache poprzedniego jest bezużyteczny, a okno wraca na
      // wariant kliencki. Zmiana wariantu wywoła ten efekt jeszcze raz, już z
      // wyczyszczonym cache'em — stąd wcześniejszy `return`.
      if (cacheRef.current.orderId !== orderId) {
        cacheRef.current = { orderId, entries: {} };
        setEdited({});
        setHistory([]);
        setHistoryError(null);
        setSendOk(null);
        setSendError(null);
        if (variant !== "client") {
          setVariant("client");
          return;
        }
      }

      const cached = cacheRef.current.entries[variant];
      if (cached) {
        setPreview(cached);
        setError(null);
        setActionError(null);
        setLoading(false);
        setCopied(null);
        return;
      }

      setLoading(true);
      setError(null);
      setActionError(null);
      setPreview(null);
      setCopied(null);
      try {
        const res = await getOrderMailPreview(orderId, variant);
        if (cancelled) return;
        const data = res.data ?? null;
        if (data) cacheRef.current.entries[variant] = data;
        setPreview(data);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Nie udało się zbudować podglądu maila.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, orderId, variant]);

  const loadHistory = useCallback(async (id: number) => {
    setHistoryLoading(true);
    try {
      const items = await getOrderMailLog(id);
      setHistory(items);
      setHistoryError(null);
    } catch (e) {
      setHistory([]);
      setHistoryError(
        isMissingEndpoint(e)
          ? "Historia pojawi się, gdy backend udostępni dziennik wysyłek."
          : e instanceof Error
            ? e.message
            : "Nie udało się wczytać historii wysyłek.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Historia domyślnie zwinięta — dociągamy ją dopiero, gdy ktoś ją rozwinie
  // (okno przy 1280×800 ma się mieścić bez przewijania).
  useEffect(() => {
    if (!open || !historyOpen || orderId === null) return;
    void loadHistory(orderId);
  }, [open, historyOpen, orderId, loadHistory]);

  // Nowa karta — ten sam sposób co wydruk protokołu (frontend/src/lib/protocolPrint.ts):
  // pusty `window.open` + `document.write`, bo mail żyje tylko w pamięci (nie ma URL-a).
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

  /**
   * Awaryjne kopiowanie bogatego tekstu: zaznaczamy zawartość ramki z podglądem
   * i wołamy `execCommand("copy")` w JEJ dokumencie. Zaznaczenie niesie ze sobą
   * formatowanie, więc do Outlooka trafia to samo co przez ClipboardItem.
   * Potrzebne tam, gdzie nie ma `ClipboardItem` (starszy Firefox) albo strona
   * chodzi po http bez bezpiecznego kontekstu — tam `navigator.clipboard` nie żyje.
   */
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
      // Bez fokusa w ramce przeglądarka kopiuje zaznaczenie strony (czyli nic).
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

  /** Główna akcja: mail w schowku jako sformatowana treść (text/html + text/plain). */
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

  /** Drobiazgi do pól nagłówka Outlooka — zwykły tekst wystarczy. */
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
    [flashCopied],
  );

  // Adresaci z backendu — punkt wyjścia, dopóki nikt ich nie poprawił.
  // Wariant wewnętrzny bez skonfigurowanej skrzynki nie podstawia adresu klienta:
  // ma być widać, czego brakuje w konfiguracji, a nie wysłać maila zespołu do klienta.
  const suggested = useMemo<Recipients>(
    () => ({
      to: (variant === "internal" ? preview?.to : preview?.to || order?.requesterEmail) ?? "",
      cc: preview?.cc ?? "",
      bcc: preview?.bcc ?? "",
    }),
    [preview, order, variant],
  );

  const recipients = edited[variant] ?? suggested;
  const patchRecipients = (patch: Partial<Recipients>) =>
    setEdited((prev) => ({ ...prev, [variant]: { ...recipients, ...patch } }));

  const toBad = invalidAddresses(recipients.to);
  const ccBad = invalidAddresses(recipients.cc);
  const bccBad = invalidAddresses(recipients.bcc);
  const toList = parseAddresses(recipients.to);
  const recipientMissingHint = variant === "internal" && toList.length === 0;

  // Outlook przyjmuje w polu „Do” listę rozdzieloną średnikami — dokładnie w tej
  // postaci wkładamy do schowka adresata razem z DW.
  const recipientsForOutlook = [...toList, ...parseAddresses(recipients.cc)].join("; ");

  // O gotowości decyduje backend. Starszy backend pola nie zwraca — wtedy
  // traktujemy wysyłkę jako niedostępną (lepiej zablokować niż wysłać w próżnię).
  const sendReady = preview?.sending?.ready === true;
  const sendReason =
    preview?.sending?.reason ?? "backend nie udostępnia jeszcze wysyłki maili ze zleceń";
  const addressesOk = toList.length > 0 && toBad.length === 0 && ccBad.length === 0 && bccBad.length === 0;
  const sendDisabled = !preview || !canSend || !sendReady || !addressesOk || sending;
  const sendBlockedTitle = !canSend
    ? "Brak uprawnień do edycji zleceń"
    : !sendReady
      ? sendReason
      : toList.length === 0
        ? "Podaj co najmniej jednego adresata"
        : !addressesOk
          ? "Popraw niepoprawne adresy"
          : undefined;

  const doSend = async () => {
    if (orderId === null) return;
    setSending(true);
    setSendOk(null);
    setSendError(null);
    try {
      const res = await sendOrderMail(orderId, {
        variant,
        to: toList,
        cc: parseAddresses(recipients.cc),
        bcc: parseAddresses(recipients.bcc),
      });
      if (res.ok) {
        setSendOk(
          `Wysłano ✓ ${new Date().toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}`,
        );
      } else {
        setSendError(res.error ?? "Nie udało się wysłać maila.");
      }
      // Nieudana próba też jest wpisem w dzienniku — historia ma to pokazać.
      setHistoryOpen(true);
      void loadHistory(orderId);
    } finally {
      setSending(false);
      setConfirmOpen(false);
    }
  };

  const confirmText = `Wysłać mail ${VARIANT_LABEL[variant]} do ${toList.join(", ") || "—"}${
    parseAddresses(recipients.cc).length ? ` (DW: ${parseAddresses(recipients.cc).join(", ")})` : ""
  }${parseAddresses(recipients.bcc).length ? ` (UDW: ${parseAddresses(recipients.bcc).join(", ")})` : ""}?`;

  /** Wspólny wygląd pól nagłówka — wąskie, żeby okno mieściło się przy 1280×800. */
  const headerInput = "h-8 text-xs";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* Kolumna na pełnej wysokości okna: nagłówek i stopka z przyciskami mają
          stały rozmiar, a podgląd między nimi ROŚNIE do tego, co zostanie.
          `h-[92vh]`, nie samo `max-h`: przy max-h okno kurczy się do treści, a
          że mail siedzi w iframe (element bez własnej wysokości), podgląd
          dostawał kilkadziesiąt pikseli, a pod stopką zostawała pustka. */}
      <DialogContent
        className="sm:max-w-3xl h-[92vh] max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden bg-white"
        data-testid="zlecenia-mail-preview-dialog"
      >
        <DialogHeader className="shrink-0 space-y-1 px-6 pt-5 pb-3 border-b border-slate-200">
          <DialogTitle className="flex items-center gap-2 text-slate-900">
            <Mail className="w-5 h-5 text-indigo-600" />
            Podgląd maila — {order?.orderNumber ?? ""}
          </DialogTitle>

          <Tabs
            value={variant}
            onValueChange={(v) => setVariant(v as OrderMailVariant)}
            className="pt-1"
          >
            <TabsList className="bg-slate-100">
              <TabsTrigger value="client" data-testid="zlecenia-mail-variant-client">
                Do klienta
              </TabsTrigger>
              <TabsTrigger value="internal" data-testid="zlecenia-mail-variant-internal">
                Wewnętrzny
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <DialogDescription asChild>
            <div className="text-sm text-slate-500 space-y-1 pt-1.5">
              {/* Adresaci są edytowalne — temat i treść składa szablon, więc
                  zostają do odczytu (inaczej podgląd rozjechałby się z wysyłką). */}
              <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
                <label htmlFor="zlecenia-mail-to" className="text-xs text-slate-400">
                  Do:
                </label>
                <Input
                  id="zlecenia-mail-to"
                  data-testid="zlecenia-mail-to"
                  className={cn(headerInput, toBad.length && "border-red-500 focus-visible:ring-red-500")}
                  value={recipients.to}
                  placeholder={recipientMissingHint ? NO_INTERNAL_RECIPIENT : "adresy po przecinku"}
                  aria-invalid={toBad.length > 0}
                  onChange={(e) => patchRecipients({ to: e.target.value })}
                />

                <label htmlFor="zlecenia-mail-cc" className="text-xs text-slate-400">
                  DW:
                </label>
                {/* DW i UDW dzielą jeden rząd: pełnowymiarowe wiersze zabierały
                    podglądowi maila kolejne 36 px, a wypełnia się je rzadko. */}
                <div className="grid grid-cols-[minmax(0,1fr)_2.6rem_minmax(0,1fr)] items-center gap-2">
                  <Input
                    id="zlecenia-mail-cc"
                    data-testid="zlecenia-mail-cc"
                    className={cn(headerInput, ccBad.length && "border-red-500 focus-visible:ring-red-500")}
                    value={recipients.cc}
                    placeholder="—"
                    aria-invalid={ccBad.length > 0}
                    onChange={(e) => patchRecipients({ cc: e.target.value })}
                  />
                  <label htmlFor="zlecenia-mail-bcc" className="text-xs text-slate-400">
                    UDW:
                  </label>
                  <Input
                    id="zlecenia-mail-bcc"
                    data-testid="zlecenia-mail-bcc"
                    className={cn(headerInput, bccBad.length && "border-red-500 focus-visible:ring-red-500")}
                    value={recipients.bcc}
                    placeholder="—"
                    aria-invalid={bccBad.length > 0}
                    onChange={(e) => patchRecipients({ bcc: e.target.value })}
                  />
                </div>
              </div>

              {(toBad.length > 0 || ccBad.length > 0 || bccBad.length > 0) && (
                <div className="text-xs text-red-600" data-testid="zlecenia-mail-address-error">
                  Niepoprawne adresy: {[...toBad, ...ccBad, ...bccBad].join(", ")}
                </div>
              )}

              <div data-testid="zlecenia-mail-preview-subject" className="pt-0.5">
                <span className="text-slate-400">Temat:</span>{" "}
                <span className="text-slate-700">{preview?.subject || "—"}</span>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        {/* `min-h-0` jest tu obowiązkowe: element flex ma domyślnie
            `min-height:auto`, więc bez tego iframe rozepchnąłby okno zamiast
            oddać wysokość nagłówkowi i stopce. */}
        <div className="flex-1 min-h-0 bg-slate-100 px-6 py-3">
          {loading && (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm">
              Buduję podgląd…
            </div>
          )}
          {!loading && error && (
            <div
              className="h-full flex items-center justify-center text-red-600 text-sm text-center px-6"
              data-testid="zlecenia-mail-preview-error"
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
              className="w-full h-full bg-white border border-slate-200 rounded"
              data-testid="zlecenia-mail-preview-frame"
            />
          )}
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-3 space-y-1.5">
          {sendOk && (
            <div
              className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700"
              role="status"
              data-testid="zlecenia-mail-send-ok"
            >
              {sendOk}
            </div>
          )}
          {sendError && (
            <div
              className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
              data-testid="zlecenia-mail-send-error"
            >
              {sendError}
            </div>
          )}
          {actionError && (
            <div className="text-xs text-red-600" data-testid="zlecenia-mail-preview-copy-error">
              {actionError}
            </div>
          )}

          {/* Historia zwinięta domyślnie — okno ma się mieścić przy 1280×800. */}
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
              data-testid="zlecenia-mail-history-toggle"
            >
              {historyOpen ? (
                <ChevronDown className="w-3.5 h-3.5" aria-hidden />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" aria-hidden />
              )}
              Historia wysyłek tego zlecenia
              {history.length > 0 && <span className="text-slate-400">({history.length})</span>}
            </button>
            {/* Własny limit wysokości: rozwinięta historia ma przewijać się w
                miejscu, a nie wypychać podglądu maila ze środka okna. */}
            {historyOpen && (
              <div className="mt-2 max-h-48 overflow-y-auto" data-testid="zlecenia-mail-history">
                {historyLoading ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Wczytywanie…
                  </div>
                ) : historyError ? (
                  <p className="text-xs text-slate-500">{historyError}</p>
                ) : (
                  <MailLogTable items={history} compact emptyText="Z tego zlecenia nic jeszcze nie wysłano." />
                )}
              </div>
            )}
          </div>

          {/* Osobno drobiazgi do nagłówka wiadomości — Outlook chce je w polach,
              nie w treści, więc lądują w schowku jako czysty tekst. Trzymamy je
              w osobnym rzędzie, bo razem z resztą nie mieszczą się w oknie. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">Do pól nagłówka:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyPlain(preview?.subject ?? "", "subject")}
              disabled={!preview?.subject}
              data-testid="zlecenia-mail-preview-copy-subject"
            >
              {copied === "subject" ? <Check className="w-3.5 h-3.5 mr-1.5 text-green-600" /> : null}
              {copied === "subject" ? "Skopiowano ✓" : "Kopiuj temat"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyPlain(recipientsForOutlook, "recipients")}
              disabled={!recipientsForOutlook}
              data-testid="zlecenia-mail-preview-copy-to"
            >
              {copied === "recipients" ? <Check className="w-3.5 h-3.5 mr-1.5 text-green-600" /> : null}
              {copied === "recipients" ? "Skopiowano ✓" : "Kopiuj adresata"}
            </Button>
          </div>

          {!sendReady && preview && (
            <div className="text-xs text-slate-500" data-testid="zlecenia-mail-send-hint">
              {/* Sam powód od backendu — brzmi już jak zdanie („Wysyłka maili jest
                  wyłączona…", „Nie ustawiono hasła SMTP"), więc nie doklejamy
                  do niego drugiego „Wysyłka wyłączona:". */}
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
              data-testid="zlecenia-mail-preview-newtab"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Otwórz w nowej karcie
            </Button>
            <Button
              onClick={() => void copyForOutlook()}
              disabled={!preview}
              data-testid="zlecenia-mail-preview-copy"
            >
              {copied === "mail" ? (
                <Check className="w-4 h-4 mr-2" />
              ) : (
                <ClipboardCopy className="w-4 h-4 mr-2" />
              )}
              {copied === "mail" ? "Skopiowano ✓" : "Kopiuj do Outlooka"}
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={sendDisabled}
              title={sendBlockedTitle}
              data-testid="zlecenia-mail-send"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Wyślij
            </Button>
            <Button variant="ghost" onClick={onClose} data-testid="zlecenia-mail-preview-close">
              Zamknij
            </Button>
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Potwierdź wysyłkę</AlertDialogTitle>
            <AlertDialogDescription>{confirmText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="zlecenia-mail-send-confirm"
              disabled={sending}
              onClick={(e) => {
                e.preventDefault();
                void doSend();
              }}
            >
              {sending && <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden />}
              Wyślij
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
