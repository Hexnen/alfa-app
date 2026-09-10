/**
 * Lista załączników zapisanych już na encji: siatka miniatur z lightboxem,
 * chipy pozostałych plików i (opcjonalnie) krzyżyki „usuń”.
 *
 * Uogólnienie `components/manuals/ManualAttachmentsGallery.tsx` (wariant
 * `chips`) — ten sam wygląd obsługuje manuale i Grupy interwencyjne, bo
 * różnicę w nazwie pola MIME godzi `mimeOf` z `@/lib/attachments`.
 */
import { useState } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  attachmentIcon,
  downloadUrlOf,
  fmtFileSize,
  mimeOf,
  opensInline,
  type AttachmentLike,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

interface AttachmentListProps {
  attachments: AttachmentLike[];
  /** Podany = przy każdym pliku pojawia się krzyżyk „usuń” (tryb edycji). */
  onDelete?: (attachment: AttachmentLike) => void;
  /** Blokuje krzyżyki na czas zapisu. */
  deleteDisabled?: boolean;
  /** Komunikat pustej listy; brak = nic nie renderujemy. */
  emptyText?: string;
  className?: string;
  /** Prefiks `data-testid` (np. `interwencje-firma-att`). */
  testid?: string;
}

export function AttachmentList({
  attachments,
  onDelete,
  deleteDisabled,
  emptyText,
  className,
  testid = "attachment",
}: AttachmentListProps) {
  // Trzymamy id, nie obiekt: gdy załącznik zniknie z listy (usunięty albo zmiana
  // encji), lightbox zamyka się sam, bez efektu synchronizującego.
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const lightbox = attachments.find((a) => a.id === lightboxId) ?? null;

  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  if (attachments.length === 0) {
    return emptyText ? (
      <p
        className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
        data-testid={`${testid}-empty`}
      >
        {emptyText}
      </p>
    ) : null;
  }

  return (
    <div className={cn("space-y-2", className)} data-testid={testid}>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Obrazy">
          {images.map((a) => (
            <li key={a.id} className="group/att relative">
              <button
                type="button"
                onClick={() => setLightboxId(a.id)}
                className="block h-24 w-24 overflow-hidden rounded-md border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-28 sm:w-28"
                title={`${a.fileName} · ${fmtFileSize(a.size)}`}
                data-testid={`${testid}-image`}
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
                  data-testid={`${testid}-delete`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pliki">
          {files.map((a) => {
            const Icon = attachmentIcon(mimeOf(a), a.fileName);
            const inline = opensInline(a);
            return (
              <li
                key={a.id}
                className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-xs"
              >
                <a
                  href={inline ? a.url : downloadUrlOf(a)}
                  target={inline ? "_blank" : undefined}
                  rel={inline ? "noopener noreferrer" : undefined}
                  download={inline ? undefined : a.fileName}
                  className="flex min-w-0 items-center gap-1.5 py-1 hover:underline"
                  title={inline ? "Otwórz w nowej karcie" : "Pobierz"}
                  data-testid={`${testid}-file`}
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
                    data-testid={`${testid}-delete`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Lightbox — podgląd obrazka w pełnym rozmiarze */}
      <Dialog open={lightbox != null} onOpenChange={(o) => !o && setLightboxId(null)}>
        <DialogContent
          className="flex max-h-[95vh] w-[min(96vw,64rem)] max-w-none flex-col gap-2 p-3 sm:p-4"
          data-testid={`${testid}-lightbox`}
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
