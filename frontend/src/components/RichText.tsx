/**
 * Renderowanie wolnego tekstu (notatki, opisy) z lekkim formatowaniem
 * i „bogatymi" linkami.
 *
 * Trzy warstwy, świadomie rozdzielone:
 *   1. `lib/linkify.ts` — wykrywanie adresów, e-maili i telefonów;
 *   2. `lib/richtext.ts` — parser bloków (listy, cytaty, etykiety, mail);
 *   3. ten plik — wyłącznie elementy Reacta.
 * Dzięki temu obie pierwsze warstwy są czystymi funkcjami z testami
 * (`scripts/test-richtext.ts`), a tutaj NIE MA `dangerouslySetInnerHTML` —
 * treść wklejona z maila nie ma jak nic wstrzyknąć.
 *
 * Pod tekstem dokładamy karty podglądu (`LinkPreviewCard`) dla maks. trzech
 * pierwszych unikalnych adresów. Pobranie jest LENIWE (IntersectionObserver) —
 * lista dwudziestu notatek nie odpala dwudziestu zapytań, dopóki nie zjedziesz
 * na nie wzrokiem — a wynik siedzi w cache'u modułu i w `sessionStorage`, więc
 * przerysowanie notatki nie generuje ruchu.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { linksApi, type LinkPreview } from "@/lib/api";
import { uniqueUrls } from "@/lib/linkify";
import {
  parseInline,
  parseRichText,
  type RichBlock,
  type RichInline,
  type RichLine,
  type RichTextMode,
} from "@/lib/richtext";

// UWAGA: `linkifyText` i `parseRichText` NIE są tu reeksportowane celowo — ten plik
// ma eksportować wyłącznie komponenty (react-refresh), a czyste funkcje żyją
// w `@/lib/linkify` i `@/lib/richtext`, skąd biorą je też testy.

// ---------------------------------------------------------------------------
// Domena i ikona
// ---------------------------------------------------------------------------

/** Domena adresu, bez „www." — to ona jest podpisem karty. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** Ikona z serwisu Google — używana, gdy strona nie ma własnej albo ta się nie wczytała. */
function googleFavicon(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

// ---------------------------------------------------------------------------
// Cache podglądów po stronie przeglądarki
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "alfa.linkPreview.";
/** Krócej niż serwerowy TTL — `sessionStorage` ma tylko oszczędzić okrążenie do API. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Trwające i zakończone pobrania w obrębie karty przeglądarki. */
const memoryCache = new Map<string, Promise<LinkPreview>>();

function readSession(url: string): LinkPreview | null {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: LinkPreview };
    if (!parsed?.data || Date.now() - parsed.at > SESSION_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeSession(url: string, data: LinkPreview) {
  try {
    sessionStorage.setItem(SESSION_PREFIX + url, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Pełny albo wyłączony storage — podgląd i tak zadziała, tylko bez cache'u.
  }
}

function loadPreview(url: string): Promise<LinkPreview> {
  const pending = memoryCache.get(url);
  if (pending) return pending;
  const promise = linksApi
    .preview(url)
    .then((res) => {
      const data = res.data as LinkPreview;
      writeSession(url, data);
      return data;
    })
    .catch((err) => {
      // Błąd zapytania (400, brak sieci) też jest wynikiem — pokazujemy gołą domenę.
      memoryCache.delete(url);
      const host = hostOf(url);
      const fallback: LinkPreview = {
        url,
        finalUrl: url,
        host,
        title: null,
        description: null,
        image: null,
        // Ikona z serwisu Google działa nawet wtedy, gdy nasz backend nie
        // odpowiedział — karta bez ikony wygląda jak zepsuta.
        favicon: googleFavicon(host),
        siteName: null,
        status: "error",
        error: err instanceof Error ? err.message : "Nie udało się pobrać podglądu",
        fetchedAt: new Date().toISOString(),
      };
      return fallback;
    });
  memoryCache.set(url, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Karta podglądu
// ---------------------------------------------------------------------------

const LINK_CLASS =
  "break-all font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary";

export interface LinkPreviewCardProps {
  url: string;
  /** Jedna linia (favicon + tytuł + domena) — do list i wąskich kolumn. */
  compact?: boolean;
  className?: string;
}

export function LinkPreviewCard({ url, compact = false, className }: LinkPreviewCardProps) {
  const [preview, setPreview] = useState<LinkPreview | null>(() => readSession(url));
  /** 0 = ikona ze strony, 1 = zastępcza z Google, 2 = ikona Lucide. */
  const [iconStage, setIconStage] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  // Bez IntersectionObserver (starsza przeglądarka, test w jsdom) nie ma na co
  // czekać — pobieramy od razu.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const ref = useRef<HTMLAnchorElement | null>(null);
  // Zmiana adresu w tym samym miejscu drzewa = zerowanie stanu W TRAKCIE renderu
  // (wzorzec z dokumentacji Reacta), a nie efektem — efekt dawałby jedno
  // przerysowanie z cudzym podglądem.
  const [lastUrl, setLastUrl] = useState(url);
  if (lastUrl !== url) {
    setLastUrl(url);
    setPreview(readSession(url));
    setIconStage(0);
    setImageFailed(false);
  }

  // Podgląd pobieramy dopiero, gdy karta wejdzie w widok.
  useEffect(() => {
    if (preview || visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [preview, visible]);

  useEffect(() => {
    if (!visible || preview) return;
    let alive = true;
    loadPreview(url).then((data) => {
      if (alive) setPreview(data);
    });
    return () => {
      alive = false;
    };
  }, [visible, preview, url]);

  const host = hostOf(url);
  const failed = preview?.status === "error";
  const siteName = preview?.siteName?.trim();
  /**
   * Pierwsza linia karty: tytuł strony, a gdy go nie ma — nazwa serwisu, a na
   * końcu sama domena. Pełnego adresu NIE pokazujemy nigdy: użytkownik ma go
   * już w tekście notatki, a w karcie wyglądał jak zdublowana domena.
   */
  const primary =
    preview?.title?.trim() ||
    (siteName && siteName.replace(/^www\./i, "").toLowerCase() !== host.toLowerCase() ? siteName : host);
  /** Druga linia tylko wtedy, gdy wnosi coś ponad pierwszą. */
  const showHost = primary.toLowerCase() !== host.toLowerCase();
  const iconSrc = iconStage === 0 ? (preview?.favicon ?? googleFavicon(host)) : iconStage === 1 ? googleFavicon(host) : null;
  const showImage = !compact && !!preview?.image && !imageFailed;

  return (
    <a
      ref={ref}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      title={url}
      className={cn(
        "group flex items-center gap-2 rounded-md border border-border bg-muted/40 no-underline transition-colors hover:bg-muted",
        compact ? "px-2 py-1" : "min-h-[3.25rem] gap-3 p-2",
        className
      )}
    >
      {/*
        Ikona w trzech krokach: własna ikona strony → zastępcza z serwisu Google
        → ikona Lucide. Część serwisów oddaje favicon tylko bez nagłówka
        Referer, stąd `referrerPolicy`.
      */}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {iconSrc ? (
          <img
            key={iconSrc}
            src={iconSrc}
            alt=""
            width={16}
            height={16}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-4 w-4 rounded-sm object-contain"
            onError={() => setIconStage((stage) => stage + 1)}
          />
        ) : (
          <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
        )}
      </span>

      <span className="min-w-0 flex-1">
        {preview ? (
          <>
            <span className="block truncate text-sm font-medium text-foreground">{primary}</span>
            {showHost && <span className="block truncate text-xs text-muted-foreground">{host}</span>}
            {failed ? (
              <span className="block truncate text-xs text-muted-foreground">Podgląd niedostępny</span>
            ) : (
              !compact &&
              preview.description && (
                <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {preview.description}
                </span>
              )
            )}
          </>
        ) : (
          // Szkielet tej samej wysokości co gotowa karta — nic nie podskakuje.
          <>
            <span className="block h-3.5 w-2/3 animate-pulse rounded bg-muted-foreground/20" />
            <span className="mt-1 block h-3 w-1/3 animate-pulse rounded bg-muted-foreground/10" />
          </>
        )}
      </span>

      {showImage && (
        <img
          src={preview?.image ?? ""}
          alt=""
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded object-cover"
          onError={() => setImageFailed(true)}
        />
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Renderowanie tekstu
// ---------------------------------------------------------------------------

function Inline({ nodes }: { nodes: RichInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === "text") {
          if (node.bold) return <strong key={i} className="font-semibold">{node.value}</strong>;
          if (node.italic) return <em key={i}>{node.value}</em>;
          return <span key={i}>{node.value}</span>;
        }
        const external = node.kind === "url";
        return (
          <a
            key={i}
            href={node.href}
            data-testid="rich-link"
            className={LINK_CLASS}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            // Notatka bywa w karcie, którą klik otwiera — link ma tylko otworzyć siebie.
            onClick={(e) => e.stopPropagation()}
          >
            {node.display}
          </a>
        );
      })}
    </>
  );
}

function Line({ line }: { line: RichLine }) {
  return (
    <>
      {line.label && <strong className="font-semibold">{line.label}</strong>}
      {line.label && line.nodes.length > 0 ? " " : null}
      <Inline nodes={line.nodes} />
    </>
  );
}

function Lines({ lines }: { lines: RichLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          <Line line={line} />
        </span>
      ))}
    </>
  );
}

/** Zwijana historia korespondencji z maila. */
function History({ block }: { block: Extract<RichBlock, { kind: "history" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1" data-testid="rich-history">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? "Ukryj cytowaną wiadomość" : `Pokaż cytowaną wiadomość (${block.lineCount} linii)`}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          <Blocks blocks={block.blocks} />
        </div>
      )}
    </div>
  );
}

function Blocks({ blocks }: { blocks: RichBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "paragraph":
            return (
              <p key={i} className={cn(i > 0 && "mt-2")}>
                <Lines lines={block.lines} />
              </p>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={i}
                className={cn(
                  "ml-4 space-y-0.5",
                  i > 0 && "mt-2",
                  block.ordered ? "list-decimal" : "list-disc"
                )}
              >
                {block.items.map((item, j) => (
                  <li key={j} className={cn(item.level > 0 && "ml-4")}>
                    <Inline nodes={item.nodes} />
                  </li>
                ))}
              </ListTag>
            );
          }
          case "quote":
            return (
              <blockquote
                key={i}
                className={cn("border-l-2 border-border pl-3 text-muted-foreground", i > 0 && "mt-2")}
              >
                <Blocks blocks={block.blocks} />
              </blockquote>
            );
          case "hr":
            return <hr key={i} className="my-2 border-border" />;
          case "headers":
            return (
              <div
                key={i}
                data-testid="rich-mail-headers"
                className={cn(
                  "rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground",
                  i > 0 && "mt-2"
                )}
              >
                {block.fields.map((f, j) => (
                  <div key={j} className="flex gap-1">
                    <span className="shrink-0 font-medium text-foreground/70">{f.label}:</span>
                    <span className="min-w-0 break-words">{f.value}</span>
                  </div>
                ))}
              </div>
            );
          case "signature":
            return (
              <div key={i} className="mt-2 text-xs text-muted-foreground" data-testid="rich-signature">
                <Lines lines={block.lines} />
              </div>
            );
          case "history":
            return <History key={i} block={block} />;
          default:
            return null;
        }
      })}
    </>
  );
}

export interface RichTextProps {
  text: string | null | undefined;
  className?: string;
  /** `mail` włącza wykrywanie cytowanej historii i sygnatury (treść z Outlooka). */
  mode?: RichTextMode;
  /** Karty podglądu pod tekstem (domyślnie tak). */
  previews?: boolean;
  /** Ile pierwszych unikalnych adresów dostaje kartę. */
  previewLimit?: number;
  /** Karty w wariancie jednoliniowym. */
  compactPreviews?: boolean;
  /** Nadpisuje `data-testid` — miejsca z własnymi testami zachowują swoją nazwę. */
  testId?: string;
}

/**
 * Tekst notatki z formatowaniem, klikalnymi linkami i kartami podglądu.
 * `whitespace-pre-wrap` zostaje na wypadek treści, których parser nie rusza
 * (np. wyrównane spacjami tabelki z maila).
 */
export function RichText({
  text,
  className,
  mode = "note",
  previews = true,
  previewLimit = 3,
  compactPreviews = false,
  testId = "rich-text",
}: RichTextProps) {
  const value = text ?? "";
  if (!value.trim()) return null;

  const blocks = parseRichText(value, mode);
  const urls = previews ? uniqueUrls(value, previewLimit) : [];

  return (
    <div className={cn("whitespace-pre-wrap break-words", className)} data-testid={testId}>
      <Blocks blocks={blocks} />
      {urls.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {urls.map((url) => (
            <LinkPreviewCard key={url} url={url} compact={compactPreviews} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Wariant „w jednej linii": same tokeny (linki, pogrubienia), bez bloków i bez
 * kart podglądu. Dla miejsc, które składają treść z kawałków i nie mogą oddać
 * całego akapitu — np. notatka ze wstawionymi chipami wzmianek dat.
 */
export function RichTextInline({ text }: { text: string }) {
  return <Inline nodes={parseInline(text)} />;
}

export default RichText;
