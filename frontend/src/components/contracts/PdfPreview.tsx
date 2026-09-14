/**
 * Podgląd PDF-a w tej samej ramce, co `DocxPreview` — dla umów, które nie
 * wyszły z generatora: skanów podpisanych egzemplarzy i dokumentów przysłanych
 * przez klienta.
 *
 * DLACZEGO OSOBNY KOMPONENT, A NIE TRYB DOCX-a. Tamten rozpakowuje plik
 * biblioteką `docx-preview` i skaluje kartki `transform`-em, bo przeglądarka
 * DOCX-a nie umie. PDF-a umie każda — wystarczy `<object>`, który dostaje
 * wbudowaną przeglądarkę razem z wyszukiwaniem, zaznaczaniem i drukowaniem.
 * Doklejanie tego do DOCX-a zostawiłoby komponent, w którym połowa kodu
 * (skala, ResizeObserver, wstrzykiwane style) nie dotyczy połowy przypadków.
 *
 * ŹRÓDŁEM JEST ADRES, NIE BLOB. Sesja siedzi w ciasteczku (`request` w
 * lib/api.ts nie dokłada żadnego nagłówka autoryzacji), więc `<object data=…>`
 * pobierze plik tak samo jak `fetch`. Blob URL byłby tu tylko dodatkową kopią
 * w pamięci i osobnym cyklem sprzątania.
 *
 * `#toolbar=0` chowa pasek narzędzi wbudowanej przeglądarki: własne „Pobierz”
 * i „Otwórz w nowej karcie” stoją nad podglądem, a dwa komplety tych samych
 * przycisków tylko myliłyby (te z paska potrafią zapisać plik pod nazwą
 * z adresu, a nie pod nazwą dokumentu).
 *
 * `key` z adresu i wersji: podmiana pliku pod tym samym adresem („Podmień PDF”)
 * musi przeładować wtyczkę, a sama zmiana `data` tego nie gwarantuje.
 */
import type { ReactNode } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** Adres PDF-a (`?inline=1`). `null` = nic nie wybrano → stan pusty. */
  url: string | null;
  /**
   * Cokolwiek, co zmienia się razem z TREŚCIĄ pliku pod tym samym adresem
   * (np. `generatedAt` draftu) — wymusza przeładowanie podglądu.
   */
  version?: string | number | null;
  /** Adres do pobrania (bez `inline`); domyślnie ten sam co podglądu. */
  downloadUrl?: string | null;
  /** Nagłówek nad podglądem — zwykle numer umowy i obiekt. */
  title?: ReactNode;
  /** Akcje po prawej stronie nagłówka (np. „Przenieś do rejestru”). */
  actions?: ReactNode;
  /** Pasek nad dokumentem — np. zielona notka po przeniesieniu do rejestru. */
  notice?: ReactNode;
  /** Tekst stanu pustego (gdy `url` jest `null`). */
  emptyText?: string;
  /** Przycisk pod tekstem stanu pustego (np. „Wgraj PDF”). */
  emptyAction?: ReactNode;
  className?: string;
}

export function PdfPreview({
  url,
  version = null,
  downloadUrl,
  title,
  actions,
  notice,
  emptyText = "Wybierz pozycję z listy, aby zobaczyć podgląd",
  emptyAction,
  className,
}: Props) {
  const dl = downloadUrl ?? url;
  const src = url ? `${url}${url.includes("#") ? "" : "#toolbar=0&navpanes=0"}` : null;

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)} data-testid="pdf-podglad">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
        {actions}
        {url && (
          <>
            <Button asChild variant="outline" size="sm" data-testid="pdf-podglad-nowa-karta">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1 h-4 w-4" aria-hidden /> Otwórz w nowej karcie
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" data-testid="pdf-podglad-pobierz">
              <a href={dl ?? undefined}>
                <Download className="mr-1 h-4 w-4" aria-hidden /> Pobierz
              </a>
            </Button>
          </>
        )}
      </div>

      {notice}

      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-md border bg-muted/60">
        {src ? (
          <>
            {/*
              Awaryjna warstwa POD dokumentem. `<object>` nie daje wiarygodnego
              `onerror` (wtyczka PDF-a żyje poza drzewem DOM), więc zamiast
              udawać wykrywanie błędu zostawiamy komunikat, który przykryje
              wyświetlony dokument — a zobaczy go ten, komu przeglądarka
              PDF-ów nie otwiera w ramce.
            */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <FileText className="h-8 w-8 text-muted-foreground/60" aria-hidden />
              <p className="max-w-sm text-sm text-muted-foreground">
                Twoja przeglądarka nie pokazuje PDF-ów w oknie aplikacji. Otwórz dokument w nowej
                karcie albo pobierz go.
              </p>
              {dl && (
                <Button asChild variant="outline" size="sm">
                  <a href={dl}>
                    <Download className="mr-1 h-4 w-4" aria-hidden /> Pobierz plik
                  </a>
                </Button>
              )}
            </div>
            <object
              key={`${url}|${version ?? ""}`}
              data={src}
              type="application/pdf"
              className="relative h-full w-full"
              aria-label="Podgląd umowy w PDF"
              data-testid="pdf-podglad-ramka"
            />
          </>
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
            data-testid="pdf-podglad-pusty"
          >
            <FileText className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="max-w-sm text-sm text-muted-foreground">{emptyText}</p>
            {emptyAction}
          </div>
        )}
      </div>
    </div>
  );
}
