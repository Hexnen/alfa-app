/**
 * Podgląd pliku DOCX w przeglądarce (biblioteka `docx-preview`).
 *
 * DLACZEGO W OGÓLE. Umowa jest dokumentem Worda — dotąd, żeby zobaczyć, co
 * wyszło z generatora, trzeba było plik POBRAĆ i otworzyć w Wordzie. Przy
 * dwudziestu draftach to dwadzieścia pobrań, więc treść i tak sprawdzało się
 * „na oko” z formularza. Podgląd obok listy pokazuje dokładnie ten plik, który
 * pójdzie do klienta — z nagłówkiem, stopką i logo spółki.
 *
 * JAK. `docx-preview` rozpakowuje DOCX-a i składa z niego HTML: `.docx-wrapper`
 * (szare tło) z `section.docx` w środku jako kartkami A4. Style wstrzykuje do
 * osobnego kontenera — trzymamy go w tym samym drzewie, żeby zniknęły razem
 * z podglądem.
 *
 * SKALA. Kartka A4 ma stałą szerokość (ok. 794 px); kolumna podglądu bywa
 * węższa, więc zamiast poziomego paska przewijania skalujemy całość
 * `transform: scale(...)` liczonym z bieżącej szerokości (ResizeObserver).
 * Pomocniczy „sizer” dostaje przeskalowaną wysokość, bo `transform` nie zmienia
 * miejsca zajmowanego w układzie i bez niego dół dokumentu byłby nie do
 * doscrollowania. Nie powiększamy ponad 1:1 — dokument ma wyglądać jak wydruk.
 *
 * ODŚWIEŻANIE. `version` (np. `generatedAt` draftu) wchodzi do klucza efektu —
 * po „Generuj ponownie” pod tym samym adresem leży już inny plik, a bez tego
 * podgląd pokazywałby poprzednią treść.
 *
 * Pobieramy `fetch`-em z `credentials: "include"` (sesja siedzi w ciasteczku) —
 * `<iframe src>` nie wchodzi w grę, bo przeglądarka nie umie renderować DOCX-a.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { renderAsync } from "docx-preview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Nie zmniejszamy w nieskończoność — poniżej tego tekst przestaje być czytelny. */
const MIN_SCALE = 0.35;

/** Opcje renderu — ustalone raz, bo mają być takie same we wszystkich trzech panelach. */
const RENDER_OPTIONS = {
  inWrapper: true,
  renderHeaders: true,
  renderFooters: true,
  ignoreWidth: false,
  breakPages: true,
  /** Obrazki (logo w nagłówku) jako data: URL — inaczej blob-URL-e wyciekają przy przeładowaniu. */
  useBase64URL: true,
} as const;

interface Props {
  /**
   * Adres DOCX-a (`?inline=1`). `null` = nic nie wybrano → stan pusty.
   * Pod tym adresem leży plik BEZ kolorów — stąd biorą go oba przyciski.
   */
  url: string | null;
  /**
   * Adres wariantu KOLOROWANEGO (`&preview=1`), jeżeli ma być inny niż `url`.
   * Wyświetlamy to, pobieramy tamto: żółte/zielone pola pomagają sprawdzić
   * umowę na ekranie, ale do klienta idzie dokument czysty.
   */
  previewSrc?: string | null;
  /**
   * Cokolwiek, co zmienia się razem z TREŚCIĄ pliku pod tym samym adresem —
   * np. `generatedAt` draftu. Zmiana wymusza ponowne pobranie.
   */
  version?: string | number | null;
  /** Adres do pobrania (bez `inline`); domyślnie ten sam co podglądu. */
  downloadUrl?: string | null;
  /** Nagłówek nad podglądem — zwykle numer umowy albo nazwa wzoru. */
  title?: ReactNode;
  /** Przełącznik/akcje po prawej stronie nagłówka (np. „z tagami / pusty”). */
  actions?: ReactNode;
  /** Pasek nad dokumentem — np. żółta notka „plik nieaktualny”. */
  notice?: ReactNode;
  /** Tekst stanu pustego (gdy `url` jest `null`). */
  emptyText?: string;
  /** Przycisk pod tekstem stanu pustego (np. „Generuj”). */
  emptyAction?: ReactNode;
  /**
   * Legenda kolorów pól nad dokumentem (dla adresów z `preview=1`). Licznik
   * „do uzupełnienia” bierzemy z nagłówka `X-Contract-Missing` odpowiedzi —
   * ten sam kod, który maluje pola, podaje ich liczbę, więc nie może się
   * rozjechać z tym, co widać.
   */
  fieldLegend?: boolean;
  className?: string;
}

export function DocxPreview({
  url,
  previewSrc = null,
  version = null,
  downloadUrl,
  title,
  actions,
  notice,
  emptyText = "Wybierz pozycję z listy, aby zobaczyć podgląd",
  emptyAction,
  fieldLegend = false,
  className,
}: Props) {
  /** Element z paskiem przewijania — z jego szerokości liczymy skalę. */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** Rozpięty na przeskalowaną wysokość, żeby dokument dało się doscrollować. */
  const sizerRef = useRef<HTMLDivElement | null>(null);
  /** Tu ląduje wynik renderu (`width: max-content`, więc mierzy się jak kartka). */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  /** Rośnie po każdym udanym renderze — sygnał „przelicz skalę na nowo”. */
  const [rendered, setRendered] = useState(0);
  /** Ile pól zostało do uzupełnienia (`X-Contract-Missing`); null = serwer nie podał. */
  const [missing, setMissing] = useState<number | null>(null);

  /** Skala z bieżącej szerokości kolumny; nigdy nie powiększamy ponad 1:1. */
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const natural = content.scrollWidth;
    if (natural <= 0) return;
    // Zapas na pionowy pasek przewijania — bez niego wchodzi także poziomy.
    const available = viewport.clientWidth;
    const next = Math.min(1, Math.max(MIN_SCALE, available / natural));
    setScale(next);
    if (sizerRef.current) {
      sizerRef.current.style.height = `${content.scrollHeight * next}px`;
      sizerRef.current.style.width = `${natural * next}px`;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const content = contentRef.current;
    const styles = styleRef.current;
    if (!content || !styles) return;

    // Poprzedni dokument znika od razu — inaczej przy wolnym pobieraniu przez
    // chwilę widać treść innej umowy.
    content.replaceChildren();
    styles.replaceChildren();
    setError(null);
    setMissing(null);
    const src = url === null ? null : (previewSrc ?? url);
    if (!src) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(src, { credentials: "include" });
        if (!res.ok) {
          // Błędy tras plikowych wracają JSON-em; gdy nie — zostaje status.
          const text = await res.text().catch(() => "");
          let message = `Nie udało się pobrać dokumentu (błąd ${res.status}).`;
          try {
            const parsed = JSON.parse(text) as { error?: string };
            if (parsed?.error) message = parsed.error;
          } catch {
            /* nie JSON — zostaje komunikat ze statusem */
          }
          throw new Error(message);
        }
        const header = Number(res.headers.get("X-Contract-Missing"));
        const blob = await res.blob();
        if (cancelled) return;
        setMissing(Number.isFinite(header) && res.headers.has("X-Contract-Missing") ? header : null);
        await renderAsync(blob, content, styles, RENDER_OPTIONS);
        if (cancelled) return;
        setRendered((n) => n + 1);
      } catch (e) {
        if (cancelled) return;
        content.replaceChildren();
        setError(
          e instanceof Error && e.message
            ? e.message
            : "Nie udało się wyświetlić dokumentu. Pobierz plik i otwórz go w Wordzie."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, previewSrc, version]);

  // Skalę liczymy PO wstawieniu węzłów (useLayoutEffect), żeby nie mignął
  // dokument w skali 1:1 przed dopasowaniem. `loading` w zależnościach nie jest
  // ozdobą: dopóki trwa wczytywanie, kontener z treścią jest ukryty i mierzy
  // się na zero — przeliczamy więc jeszcze raz, gdy się pokaże.
  useLayoutEffect(() => {
    fit();
  }, [fit, rendered, loading]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [fit]);

  const hasDoc = url !== null && !error && !loading;
  const dl = downloadUrl ?? url;

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)} data-testid="docx-podglad">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
        {actions}
        {url && (
          <>
            <Button asChild variant="outline" size="sm" data-testid="docx-podglad-nowa-karta">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1 h-4 w-4" aria-hidden /> Otwórz w nowej karcie
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" data-testid="docx-podglad-pobierz">
              <a href={dl ?? undefined}>
                <Download className="mr-1 h-4 w-4" aria-hidden /> Pobierz
              </a>
            </Button>
          </>
        )}
      </div>

      {fieldLegend && url && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
          data-testid="docx-podglad-legenda"
        >
          <span className="inline-flex items-center gap-1.5">
            {/* Te same pastele co `w:shd w:fill` wstrzykiwane w podglądzie
                (CONTRACT_FIELD_FILL w src/lib/contract-templates/render.ts) —
                legenda ma się zgadzać z dokumentem co do odcienia. */}
            <span className="h-3 w-3 rounded-[2px] border border-black/20 bg-[#FFF3A3]" aria-hidden />
            do uzupełnienia
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-[2px] border border-black/20 bg-[#C6F0C2]" aria-hidden />
            uzupełnione
          </span>
          {missing !== null && (
            <span className="font-medium text-foreground" data-testid="docx-podglad-brakuje">
              do uzupełnienia: {missing}
            </span>
          )}
          <span className="ml-auto">Kolory są tylko w podglądzie — pobrany plik jest bez nich.</span>
        </div>
      )}

      {notice}

      <div
        ref={viewportRef}
        className="docx-podglad-viewport relative min-h-[420px] flex-1 overflow-auto rounded-md border bg-muted/60"
      >
        {/*
          Domyślne style docx-preview malują tło wrappera na twardy `gray`
          i dają 30 px marginesu wokół kartek. Tło bierzemy z kontenera (żeby
          podgląd nie odcinał się od reszty aplikacji), a odstępy zmniejszamy —
          przy skalowaniu do szerokości kolumny każdy piksel marginesu zabiera
          miejsce samej treści.
        */}
        <style>{`
          .docx-podglad-viewport .docx-wrapper { background: transparent; padding: 12px; gap: 12px; }
          .docx-podglad-viewport .docx-wrapper > section.docx { margin-bottom: 0; box-shadow: 0 1px 4px rgb(0 0 0 / 0.18); }
        `}</style>
        {/* Style wstrzyknięte przez docx-preview; `hidden` nie wpływa na `<style>`. */}
        <div ref={styleRef} hidden />

        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center gap-3 bg-muted/60 p-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie dokumentu…
            </div>
            {/* Szkielet kartki — żeby kolumna nie „skakała” między dokumentami. */}
            <div className="mx-auto w-full max-w-[560px] animate-pulse space-y-3 rounded bg-background p-8 shadow-sm">
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="h-3 w-full rounded bg-muted" />
              <div className="h-3 w-5/6 rounded bg-muted" />
              <div className="h-3 w-full rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
              <div className="h-24 w-full rounded bg-muted" />
              <div className="h-3 w-4/5 rounded bg-muted" />
            </div>
          </div>
        )}

        {error && !loading && (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
            data-testid="docx-podglad-blad"
          >
            <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden />
            <p className="text-sm text-destructive">{error}</p>
            {dl && (
              <Button asChild variant="outline" size="sm">
                <a href={dl}>
                  <Download className="mr-1 h-4 w-4" aria-hidden /> Pobierz plik
                </a>
              </Button>
            )}
          </div>
        )}

        {url === null && !loading && (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
            data-testid="docx-podglad-pusty"
          >
            <FileText className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="max-w-sm text-sm text-muted-foreground">{emptyText}</p>
            {emptyAction}
          </div>
        )}

        {/* Sizer dostaje przeskalowaną wysokość; treść skalujemy od lewego górnego rogu. */}
        <div ref={sizerRef} className={cn("mx-auto", !hasDoc && "hidden")}>
          <div
            ref={contentRef}
            className="docx-podglad-tresc w-max origin-top-left"
            style={{ transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}
