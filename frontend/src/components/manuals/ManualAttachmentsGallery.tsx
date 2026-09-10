import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ManualAttachment } from "@/lib/api";
import { cn } from "@/lib/utils";
import { attachmentIcon, downloadUrlOf, extOf, fmtFileSize, opensInline } from "./manualsShared";

/**
 * `chips` — siatka miniatur + chipy plików (formularz edycji: kompaktowo, z krzyżykami).
 * `inline` — treść załączników rozwinięta na pełną szerokość (panel podglądu:
 * użytkownik czyta instrukcję bez klikania).
 */
export type ManualGalleryVariant = "chips" | "inline";

interface ManualAttachmentsGalleryProps {
  attachments: ManualAttachment[];
  /** Podany = przy każdym załączniku pojawia się krzyżyk „usuń” (tryb edycji). */
  onDelete?: (attachment: ManualAttachment) => void;
  /** Blokuje krzyżyki na czas zapisu. */
  deleteDisabled?: boolean;
  /** Komunikat pustej listy; brak = nic nie renderujemy (formularz pokazuje własny). */
  emptyText?: string;
  className?: string;
  /** Domyślnie `chips` — zachowanie sprzed dodania trybu inline (dialog edycji). */
  variant?: ManualGalleryVariant;
}

/** Największy plik tekstowy, jaki wciągamy do <pre> (dalej to już nie jest podgląd). */
const TEXT_PREVIEW_MAX = 200 * 1024;

const isPdf = (a: ManualAttachment) => a.mime === "application/pdf" || extOf(a.fileName) === "pdf";
const isTextPreview = (a: ManualAttachment) =>
  a.kind !== "image" &&
  // Także CSV (backend podaje `text/csv`) i plik pusty — lepiej pokazać puste
  // <pre> niż chip „do pobrania”, bo to nadal treść, którą da się przeczytać.
  (a.mime === "text/plain" || a.mime === "text/csv" || extOf(a.fileName) === "txt" || extOf(a.fileName) === "csv") &&
  a.size <= TEXT_PREVIEW_MAX;
/** Co potrafimy pokazać od razu w panelu; reszta zostaje wierszem do pobrania. */
const isInlineRenderable = (a: ManualAttachment) => a.kind === "image" || isPdf(a) || isTextPreview(a);

/** „Pobierz” / „Otwórz w nowej karcie” — te same linki w nagłówkach bloków inline. */
function AttachmentActions({ attachment, withOpen }: { attachment: ManualAttachment; withOpen?: boolean }) {
  return (
    <>
      {withOpen && (
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          title="Otwórz w nowej karcie"
          data-testid="manual-attachment-open"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          Otwórz w nowej karcie
        </a>
      )}
      <a
        href={downloadUrlOf(attachment)}
        download={attachment.fileName}
        className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
        title="Pobierz"
        data-testid="manual-attachment-download"
      >
        <Download className="h-3 w-3" aria-hidden />
        Pobierz
      </a>
    </>
  );
}

/**
 * Jeden załącznik pokazany inline: nagłówek (chevron + nazwa + rozmiar + akcje)
 * i pod nim treść — obrazek, ramka z PDF-em albo tekst. Zwijanie jest lokalne
 * dla bloku, żeby przy kilkunastu plikach dało się przewinąć panel.
 */
function InlineBlock({
  attachment,
  onOpenImage,
}: {
  attachment: ManualAttachment;
  onOpenImage: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const pdf = isPdf(attachment);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="space-y-1" data-testid="manual-attachment-block">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          title={open ? "Zwiń" : "Rozwiń"}
          data-testid="manual-attachment-toggle"
        >
          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{attachment.fileName}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(attachment.size)}</span>
        </button>
        <AttachmentActions attachment={attachment} withOpen={pdf} />
      </div>

      {open &&
        (attachment.kind === "image" ? (
          <button
            type="button"
            onClick={() => onOpenImage(attachment.id)}
            className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Powiększ"
            data-testid="manual-attachment-image"
          >
            <img
              src={attachment.url}
              alt={attachment.fileName}
              width={attachment.width ?? undefined}
              height={attachment.height ?? undefined}
              loading="lazy"
              className="w-full h-auto rounded border"
            />
          </button>
        ) : pdf ? (
          <iframe
            src={attachment.url}
            title={attachment.fileName}
            className="w-full rounded border"
            style={{ height: "70vh" }}
            data-testid="manual-attachment-pdf"
          />
        ) : (
          <TextPreview attachment={attachment} />
        ))}
    </div>
  );
}

/** Treść pliku text/plain wciągnięta fetchem (cookie sesji leci same-origin). */
function TextPreview({ attachment }: { attachment: ManualAttachment }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Bez resetu stanu na starcie: blok jest kluczowany id załącznika (`key={a.id}`),
  // więc inny plik = inna instancja, a URL w ramach instancji się nie zmienia.
  useEffect(() => {
    let alive = true;
    fetch(attachment.url, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (alive) setText(t.slice(0, TEXT_PREVIEW_MAX));
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [attachment.url]);

  if (error) {
    return <p className="rounded border px-3 py-2 text-xs text-muted-foreground">Nie udało się wczytać treści pliku.</p>;
  }
  return (
    <pre
      className="max-h-[50vh] overflow-auto rounded border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words"
      data-testid="manual-attachment-text"
    >
      {text ?? "Wczytywanie…"}
    </pre>
  );
}

/** Chipy plików nie-inline — wspólne dla obu wariantów (w inline lądują na końcu). */
function FileChips({
  files,
  onDelete,
  deleteDisabled,
}: {
  files: ManualAttachment[];
  onDelete?: (attachment: ManualAttachment) => void;
  deleteDisabled?: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Pliki">
      {files.map((a) => {
        const Icon = attachmentIcon(a.mime, a.fileName);
        const inline = opensInline(a);
        return (
          <li key={a.id} className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs">
            <a
              href={inline ? a.url : downloadUrlOf(a)}
              target={inline ? "_blank" : undefined}
              rel={inline ? "noopener noreferrer" : undefined}
              download={inline ? undefined : a.fileName}
              className="flex min-w-0 items-center gap-1.5 py-1 hover:underline"
              title={inline ? "Otwórz w nowej karcie" : "Pobierz"}
              data-testid="manual-attachment-file"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{a.fileName}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(a.size)}</span>
              {inline ? (
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Download className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </a>
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(a)}
                disabled={deleteDisabled}
                className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                aria-label={`Usuń załącznik ${a.fileName}`}
                title="Usuń załącznik"
                data-testid="manual-attachment-delete"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Wspólne renderowanie załączników manuala. Dwa warianty:
 * `chips` (domyślny) — siatka miniatur z lightboxem i chipy plików, tak jak
 * używa tego formularz `ManualDialog`; `inline` — obrazki, PDF-y i pliki
 * tekstowe rozwinięte na pełną szerokość panelu (`ManualPreview`), żeby
 * instrukcję dało się przeczytać bez klikania. Lightbox obrazków jest wspólny.
 */
export function ManualAttachmentsGallery({
  attachments,
  onDelete,
  deleteDisabled,
  emptyText,
  className,
  variant = "chips",
}: ManualAttachmentsGalleryProps) {
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  // Trzymamy id, nie obiekt: gdy załącznik zniknie z listy (usunięty albo zmiana
  // wybranego manuala), lightbox zamyka się sam, bez efektu synchronizującego.
  const lightbox = attachments.find((a) => a.id === lightboxId) ?? null;

  const images = attachments.filter((a) => a.kind === "image");
  // Kolejność inline: obrazki i PDF-y (w kolejności dodania), potem reszta plików.
  const inlineAtts = attachments.filter(isInlineRenderable);
  const restFiles = attachments.filter((a) => !isInlineRenderable(a));

  if (attachments.length === 0) {
    return emptyText ? (
      <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
        {emptyText}
      </p>
    ) : null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {variant === "inline" ? (
        <div className="space-y-3">
          {inlineAtts.map((a) => (
            <InlineBlock key={a.id} attachment={a} onOpenImage={setLightboxId} />
          ))}
          <FileChips files={restFiles} onDelete={onDelete} deleteDisabled={deleteDisabled} />
        </div>
      ) : (
        <>
          {images.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Obrazy">
              {images.map((a) => (
                <li key={a.id} className="group/att relative">
                  <button
                    type="button"
                    onClick={() => setLightboxId(a.id)}
                    className="block h-24 w-24 overflow-hidden rounded-md border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-28 sm:w-28"
                    title={`${a.fileName} · ${fmtFileSize(a.size)}`}
                    data-testid="manual-attachment-image"
                  >
                    <img
                      src={a.url}
                      alt={a.fileName}
                      width={a.width ?? undefined}
                      height={a.height ?? undefined}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform group-hover/att:scale-[1.03]"
                    />
                  </button>
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      disabled={deleteDisabled}
                      className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow ring-1 ring-border hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      aria-label={`Usuń załącznik ${a.fileName}`}
                      title="Usuń załącznik"
                      data-testid="manual-attachment-delete"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <FileChips
            files={attachments.filter((a) => a.kind !== "image")}
            onDelete={onDelete}
            deleteDisabled={deleteDisabled}
          />
        </>
      )}

      {/* Lightbox — podgląd obrazka w pełnym rozmiarze */}
      <Dialog open={lightbox != null} onOpenChange={(o) => !o && setLightboxId(null)}>
        <DialogContent
          className="flex max-h-[95vh] w-[min(96vw,64rem)] max-w-none flex-col gap-2 p-3 sm:p-4"
          data-testid="manual-attachment-lightbox"
        >
          <DialogTitle className="truncate pr-8 text-sm font-medium">{lightbox?.fileName}</DialogTitle>
          <DialogDescription className="sr-only">Podgląd załącznika</DialogDescription>
          {lightbox && (
            <>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md bg-muted/40">
                <img
                  src={lightbox.url}
                  alt={lightbox.fileName}
                  width={lightbox.width ?? undefined}
                  height={lightbox.height ?? undefined}
                  className="max-h-[80vh] max-w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {lightbox.width && lightbox.height ? `${lightbox.width}×${lightbox.height} · ` : ""}
                  {fmtFileSize(lightbox.size)}
                </span>
                <Button asChild size="sm" variant="outline" className="h-8">
                  <a href={downloadUrlOf(lightbox)} download={lightbox.fileName}>
                    <Download className="mr-1 h-3.5 w-3.5" /> Pobierz
                  </a>
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
