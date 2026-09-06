/**
 * Podgląd oferty oczami klienta — dokładnie ten dokument, który wyjdzie
 * z „Drukuj zewnętrznie" i który klient zobaczy pod swoim linkiem.
 *
 * DLACZEGO IFRAME, A NIE `dangerouslySetInnerHTML`:
 * dokument ma własny, kompletny arkusz stylów pisany pod stronę bez Tailwinda —
 * z globalnym resetem i stylami `body`. Wstrzyknięty w aplikację zderzyłby się
 * z preflightem Tailwinda (to ten sam problem, przez który `TextEditor.tsx` musi
 * mieć osobne `MD_PREVIEW_CLASS`). W ramce CSS jest izolowany, więc podgląd
 * pokazuje DOKŁADNIE to, co pójdzie na papier — a o to w podglądzie chodzi.
 *
 * `sandbox="allow-same-origin"` (bez `allow-scripts`) blokuje wykonanie skryptów —
 * zapas bezpieczeństwa na wypadek przyszłego błędu w escapowaniu — a jednocześnie
 * pozwala zmierzyć wysokość dokumentu, żeby nie było ramki w ramce ze scrollem.
 *
 * Druk NIE idzie przez `iframe.contentWindow.print()`: to wymagałoby
 * `allow-scripts allow-modals`, czyli faktycznego odpiaskownicowania ramki, i
 * inaczej zachowuje się w Firefoksie i Safari. Zamiast tego stopka woła
 * `printOffer`, czyli tę samą ścieżkę co wszystkie wydruki w projekcie.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Company } from "@/lib/api";
import { buildOfferHtml, PAGE_WIDTH_PX, type OfferDocInput } from "@/lib/offerPrint";

/** Wysokość A4 przy 96 dpi — awaryjna, gdy pomiar ramki się nie uda. */
const A4_HEIGHT_PX = 1123;

interface OfferPreviewDialogProps {
  open: boolean;
  detail: OfferDocInput;
  company: Company | null;
  onClose: () => void;
  /** „Drukuj" ze stopki — otwiera okno wydruku wersji dla klienta. */
  onPrint: () => void;
}

export function OfferPreviewDialog({
  open,
  detail,
  company,
  onClose,
  onPrint,
}: OfferPreviewDialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [docH, setDocH] = useState(A4_HEIGHT_PX);
  const [scale, setScale] = useState(1);

  const html = useMemo(
    () =>
      open
        ? buildOfferHtml(detail, {
            audience: "client",
            company,
            withPrintButton: false,
            pageFrame: true,
          })
        : "",
    [open, detail, company]
  );

  /* Wysokość ramki = wysokość dokumentu, żeby przewijał się kontener dialogu,
     a nie ramka w ramce. Pomiar w try/catch: gdyby kiedyś doszło zaostrzenie
     sandboksa, podgląd zdegraduje się do jednej kartki zamiast zniknąć. */
  const measure = useCallback(() => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (doc) setDocH(Math.max(600, doc.documentElement.scrollHeight + 8));
    } catch {
      setDocH(A4_HEIGHT_PX);
    }
  }, []);

  // Dokument ma stałą szerokość kartki — na wąskim ekranie skalujemy go w dół,
  // zamiast zostawiać poziomy pasek przewijania.
  useLayoutEffect(() => {
    if (!open) return;
    const box = boxRef.current;
    if (!box) return;
    const fit = () => setScale(Math.min(1, (box.clientWidth - 32) / PAGE_WIDTH_PX));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [open]);


  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0",
          "sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,60rem)] sm:max-w-none sm:rounded-lg"
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-sky-100 text-sky-700">
            <Eye className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-base">Podgląd dla klienta</DialogTitle>
            <DialogDescription className="text-xs">
              Dokładnie to, co zobaczy klient — bez kosztów, marży, uwag wewnętrznych
              i niewybranych wariantów.
            </DialogDescription>
          </div>
        </div>

        {!company && (
          <div className="shrink-0 border-b bg-amber-50 px-5 py-2 text-xs text-amber-800">
            Oferta nie ma przypisanej spółki — dokument nie zawiera danych sprzedawcy
            ani stopki.
          </div>
        )}

        <div ref={boxRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
          <div style={{ width: PAGE_WIDTH_PX * scale, height: docH * scale }}>
            <iframe
              ref={frameRef}
              title="Podgląd oferty dla klienta"
              srcDoc={html}
              sandbox="allow-same-origin"
              onLoad={measure}
              className="border-0 bg-white shadow-md"
              style={{
                width: PAGE_WIDTH_PX,
                height: docH,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Zamknij
          </Button>
          <Button size="sm" onClick={onPrint}>
            <Printer className="mr-1 h-4 w-4" /> Drukuj / zapisz PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
