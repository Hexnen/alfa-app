/**
 * Podgląd maili zlecenia — w dwóch wariantach:
 *   • „Do klienta” — potwierdzenie przyjęcia zlecenia (tylko wypełnione pola),
 *   • „Wewnętrzny” — komplet danych dla zespołu (braki jako „—”).
 *
 * Oba szablony składa BACKEND (src/lib/order-mail.ts, GET /api/orders/:id/mail-preview
 * ?variant=client|internal) — front tylko pokazuje gotowy HTML. Dzięki temu późniejsza
 * wysyłka nodemailerem wyśle dokładnie to, co człowiek zobaczył w tym oknie.
 *
 * HTML renderujemy w `<iframe srcDoc sandbox="allow-same-origin">`: mail ma własne,
 * inline'owe style i nie może przeciec do arkusza aplikacji (ani odwrotnie).
 * `allow-same-origin` jest potrzebne wyłącznie po to, żeby awaryjne kopiowanie
 * (zaznaczenie treści ramki + `execCommand("copy")`) miało dostęp do
 * `contentDocument`. Skryptów NIE dopuszczamy (brak `allow-scripts`), więc mail
 * dalej jest tylko obrazkiem — nic z jego wnętrza się nie wykona.
 *
 * Na razie WYŁĄCZNIE podgląd — przycisk „Wyślij” jest zablokowany.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClipboardCopy, Check, ExternalLink, Mail, Send } from "lucide-react";
import {
  getOrderMailPreview,
  type Order,
  type OrderMailPreview,
  type OrderMailVariant,
} from "@/lib/api";

interface Props {
  order: Order | null;
  open: boolean;
  onClose: () => void;
}

/** Podpowiedź, gdy wdrożenie nie ma ustawionej skrzynki zespołu. */
const NO_INTERNAL_RECIPIENT = "(nie skonfigurowano — ORDER_INTERNAL_MAIL_TO)";

/** Który przycisk ma przez chwilę pokazywać „Skopiowano”. */
type CopyTarget = "mail" | "subject" | "recipients";

/**
 * Przygotowuje HTML pod wklejenie do Outlooka/Worda.
 *
 * Outlook wkleja tylko fragment — `<head>` (a więc i `<title>`) ignoruje, więc
 * podanie mu całego dokumentu nic nie daje, a bywa, że psuje. Style szablonu są
 * inline'owe, żaden nie siedzi w `<head>`, więc przy zejściu do `<body>` nic nie
 * ginie. Dodatkowo zdejmujemy ukryty preheader z początku body: w mailu jest
 * niewidoczny (`display:none`), ale Word potrafi go pokazać jako pierwszą linijkę.
 */
function toPasteHtml(fullHtml: string): string {
  try {
    const doc = new DOMParser().parseFromString(fullHtml, "text/html");
    const body = doc.body;
    if (!body) return fullHtml;
    // Zdejmujemy z początku body komentarze i puste teksty (szablon ma tam
    // komentarz opisujący preheader) oraz sam ukryty preheader.
    for (let node = body.firstChild; node; node = body.firstChild) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
        node.remove();
        continue;
      }
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
      const style = (el?.getAttribute("style") ?? "").replace(/\s+/g, "");
      if (!el || !style.includes("display:none")) break;
      el.remove();
    }
    const inner = body.innerHTML.trim();
    return inner || fullHtml;
  } catch {
    // DOMParser nie powinien rzucać, ale wolimy skopiować cokolwiek niż nic.
    return fullHtml;
  }
}

export function OrderMailPreviewDialog({ order, open, onClose }: Props) {
  const [variant, setVariant] = useState<OrderMailVariant>("client");
  const [preview, setPreview] = useState<OrderMailPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  // Błędy akcji ze stopki lecą osobno: `error` zastępuje podgląd, a nieudane
  // kopiowanie nie jest powodem, żeby zabierać człowiekowi mail z ekranu.
  const [actionError, setActionError] = useState<string | null>(null);

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

  // Wariant wewnętrzny bez skonfigurowanej skrzynki nie może podstawić adresu
  // klienta — pokazujemy wprost, czego brakuje w konfiguracji wdrożenia.
  const recipient =
    variant === "internal"
      ? preview?.to || null
      : preview?.to || order?.requesterEmail || null;
  const recipientMissingHint = variant === "internal" && !recipient;

  // Outlook przyjmuje w polu „Do” listę rozdzieloną średnikami — dokładnie w tej
  // postaci wkładamy do schowka adresata razem z DW.
  const recipientsForOutlook = [recipient, preview?.cc].filter(Boolean).join("; ");

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* Kolumna na pełnej wysokości okna: nagłówek i stopka z przyciskami mają
          stały rozmiar, a podgląd między nimi kurczy się do tego, co zostanie.
          Bez `max-h`/`flex` Radix centruje okno o stałej wysokości i przy
          1280×800 tytuł oraz rząd przycisków wychodziły poza ekran. */}
      <DialogContent
        className="sm:max-w-3xl max-h-[92vh] flex flex-col p-0 overflow-hidden bg-white"
        data-testid="zlecenia-mail-preview-dialog"
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-slate-200">
          <DialogTitle className="flex items-center gap-2 text-slate-900">
            <Mail className="w-5 h-5 text-indigo-600" />
            Podgląd maila — {order?.orderNumber ?? ""}
          </DialogTitle>

          <Tabs
            value={variant}
            onValueChange={(v) => setVariant(v as OrderMailVariant)}
            className="pt-2"
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
            <div className="text-sm text-slate-500 space-y-0.5 pt-1">
              <div data-testid="zlecenia-mail-preview-to">
                <span className="text-slate-400">Do:</span>{" "}
                {recipient ? (
                  <span className="text-slate-700">{recipient}</span>
                ) : (
                  <span className="text-slate-400">
                    {recipientMissingHint ? NO_INTERNAL_RECIPIENT : "—"}
                  </span>
                )}
                {preview?.cc ? (
                  <>
                    {" "}
                    <span className="text-slate-400">DW:</span>{" "}
                    <span className="text-slate-700">{preview.cc}</span>
                  </>
                ) : null}
              </div>
              <div data-testid="zlecenia-mail-preview-subject">
                <span className="text-slate-400">Temat:</span>{" "}
                <span className="text-slate-700">{preview?.subject || "—"}</span>
              </div>
              <div className="text-xs text-slate-400 pt-1" data-testid="zlecenia-mail-preview-hint">
                Wklej w Outlooku: Nowa wiadomość → Ctrl+V w treści (format HTML zostaje zachowany).
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        {/* `min-h-0` jest tu obowiązkowe: element flex ma domyślnie
            `min-height:auto`, więc bez tego iframe rozepchnąłby okno zamiast
            oddać wysokość nagłówkowi i stopce. */}
        <div className="flex-1 min-h-0 bg-slate-100 px-6 py-4">
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

        <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4 space-y-2">
          {actionError && (
            <div className="text-xs text-red-600" data-testid="zlecenia-mail-preview-copy-error">
              {actionError}
            </div>
          )}

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
            {/* Wysyłka jeszcze nie istnieje — przycisk stoi, żeby było widać, dokąd to zmierza. */}
            <Button disabled title="Wysyłka wkrótce" data-testid="zlecenia-mail-preview-send">
              <Send className="w-4 h-4 mr-2" />
              Wyślij
            </Button>
            <Button variant="ghost" onClick={onClose} data-testid="zlecenia-mail-preview-close">
              Zamknij
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
