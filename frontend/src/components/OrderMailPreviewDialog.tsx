/**
 * Podgląd maili zlecenia — w dwóch wariantach:
 *   • „Do klienta” — potwierdzenie przyjęcia zlecenia (tylko wypełnione pola),
 *   • „Wewnętrzny” — komplet danych dla zespołu (braki jako „—”).
 *
 * Oba szablony składa BACKEND (src/lib/order-mail.ts, GET /api/orders/:id/mail-preview
 * ?variant=client|internal) — front tylko pokazuje gotowy HTML. Dzięki temu późniejsza
 * wysyłka nodemailerem wyśle dokładnie to, co człowiek zobaczył w tym oknie.
 *
 * HTML renderujemy w `<iframe srcDoc sandbox="">`: mail ma własne, inline'owe style
 * i nie może przeciec do arkusza aplikacji (ani odwrotnie), a pusty `sandbox`
 * odcina skrypty i nawigację z wnętrza ramki.
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
import { Copy, Check, ExternalLink, Mail, Send } from "lucide-react";
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

export function OrderMailPreviewDialog({ order, open, onClose }: Props) {
  const [variant, setVariant] = useState<OrderMailVariant>("client");
  const [preview, setPreview] = useState<OrderMailPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const orderId = order?.id ?? null;

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
        setLoading(false);
        setCopied(false);
        return;
      }

      setLoading(true);
      setError(null);
      setPreview(null);
      setCopied(false);
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
      setError("Przeglądarka zablokowała nowe okno — zezwól na wyskakujące okna.");
      return;
    }
    win.document.write(preview.html);
    win.document.close();
    win.focus();
  }, [preview]);

  const copyHtml = useCallback(async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Schowek jest niedostępny — skopiuj HTML z nowej karty.");
    }
  }, [preview]);

  // Wariant wewnętrzny bez skonfigurowanej skrzynki nie może podstawić adresu
  // klienta — pokazujemy wprost, czego brakuje w konfiguracji wdrożenia.
  const recipient =
    variant === "internal"
      ? preview?.to || null
      : preview?.to || order?.requesterEmail || null;
  const recipientMissingHint = variant === "internal" && !recipient;

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
              title="Podgląd maila"
              srcDoc={preview.html}
              sandbox=""
              className="w-full h-full bg-white border border-slate-200 rounded"
              data-testid="zlecenia-mail-preview-frame"
            />
          )}
        </div>

        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 bg-white">
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
            variant="outline"
            onClick={copyHtml}
            disabled={!preview}
            data-testid="zlecenia-mail-preview-copy"
          >
            {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
            {copied ? "Skopiowano" : "Kopiuj HTML"}
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
      </DialogContent>
    </Dialog>
  );
}
