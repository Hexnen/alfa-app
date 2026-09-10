/**
 * Dodawanie plików do encji: przycisk + ukryty input + drag&drop + kolejka
 * plików czekających na wysyłkę (z miniaturami obrazków).
 *
 * Uogólnienie kawałka `components/manuals/ManualDialog.tsx`. Kolejka jest
 * potrzebna, bo backend przyjmuje pliki dopiero POD ISTNIEJĄCĄ encję — przy
 * tworzeniu formularz najpierw POST-uje encję, a potem dosyła załączniki
 * (flow „create-then-upload”). Stanem kolejki zarządza hook
 * `usePendingAttachments`, żeby trzy dialogi modułu nie przepisywały tego samego.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Paperclip, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_FILES,
  attachmentIcon,
  fmtFileSize,
  makePendingFiles,
  partitionAttachmentFiles,
  revokePendingPreviews,
  type PendingFile,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

interface PendingQueueOptions {
  /** Limit sztuk na encję (domyślnie limit backendu: 15). */
  maxFiles?: number;
  /** Dopełnienie komunikatu o przepełnieniu — np. „na firmę”. */
  scopeSuffix?: string;
}

export interface PendingAttachments {
  pending: PendingFile[];
  /** Komunikat walidacji (zły typ, za duży plik, przepełnienie) albo null. */
  fileError: string | null;
  /** `existingCount` = ile plików encja już ma — limit liczy się łącznie. */
  addFiles: (incoming: File[], existingCount: number) => void;
  removePending: (key: string) => void;
  /** Po udanej wysyłce — zwalnia miniatury i czyści kolejkę. */
  clearPending: () => void;
}

/**
 * Kolejka plików formularza. Miniatury (`URL.createObjectURL`) zwalniamy przy
 * usunięciu pozycji, wyczyszczeniu kolejki i odmontowaniu — inaczej zamknięty
 * dialog zostawia w pamięci przeglądarki obrazki.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePendingAttachments(options: PendingQueueOptions = {}): PendingAttachments {
  const { maxFiles, scopeSuffix } = options;
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  // Lustro kolejki w ref: cleanup przy odmontowaniu musi zobaczyć AKTUALNĄ
  // listę, a nie tę z pierwszego renderu (efekt bez zależności zamyka stan).
  const pendingRef = useRef<PendingFile[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => () => revokePendingPreviews(pendingRef.current), []);

  const addFiles = useCallback(
    (incoming: File[], existingCount: number) => {
      if (incoming.length === 0) return;
      const already = existingCount + pendingRef.current.length;
      const { accepted, messages } = partitionAttachmentFiles(incoming, already, { maxFiles, scopeSuffix });
      if (accepted.length) setPending((p) => [...p, ...makePendingFiles(accepted)]);
      setFileError(messages.length ? messages.join(" ") : null);
    },
    [maxFiles, scopeSuffix]
  );

  const removePending = useCallback((key: string) => {
    setPending((p) => {
      const item = p.find((x) => x.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return p.filter((x) => x.key !== key);
    });
  }, []);

  const clearPending = useCallback(() => {
    revokePendingPreviews(pendingRef.current);
    setPending([]);
  }, []);

  return { pending, fileError, addFiles, removePending, clearPending };
}

interface AttachmentUploaderProps {
  queue: PendingAttachments;
  /** Ile plików encja już ma zapisanych — limit liczony łącznie. */
  existingCount: number;
  disabled?: boolean;
  maxFiles?: number;
  /** Nagłówek sekcji, np. „Umowy ramowe”. */
  label?: string;
  /** Prefiks `data-testid`. */
  testid?: string;
  className?: string;
}

/**
 * Przycisk „Dodaj pliki” + strefa drag&drop + lista kolejki. Same pliki wysyła
 * formularz, który ten komponent osadza (zna id encji i właściwy endpoint).
 */
export function AttachmentUploader({
  queue,
  existingCount,
  disabled,
  maxFiles = ATTACHMENT_MAX_FILES,
  label = "Załączniki",
  testid = "attachment",
  className,
}: AttachmentUploaderProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const total = existingCount + queue.pending.length;

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    // Reset, żeby ten sam plik dało się wybrać ponownie po usunięciu z listy.
    e.target.value = "";
    queue.addFiles(list, existingCount);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    queue.addFiles(e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [], existingCount);
  };

  return (
    <div
      className={cn("space-y-2", className)}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      data-testid={`${testid}-uploader`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          {label} ({total})
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled || total >= maxFiles}
          onClick={() => inputRef.current?.click()}
          title={`Maks. ${maxFiles} plików po 5 MB — pliki można też upuścić na to pole`}
          data-testid={`${testid}-add`}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Dodaj pliki
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={onFileInput}
        data-testid={`${testid}-input`}
      />

      {dragOver && (
        <p className="rounded-md border border-dashed border-primary bg-primary/5 px-3 py-2 text-xs text-primary">
          Upuść pliki, żeby dodać je do listy.
        </p>
      )}

      {queue.pending.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pliki do wysłania" data-testid={`${testid}-pending`}>
          {queue.pending.map((p) => {
            const Icon = attachmentIcon(p.file.type, p.file.name);
            return (
              <li
                key={p.key}
                className="flex max-w-full items-center gap-1.5 rounded-md border border-dashed bg-muted/40 py-1 pl-1.5 pr-1 text-xs"
                data-testid={`${testid}-pending-file`}
              >
                {p.previewUrl ? (
                  <img src={p.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="max-w-[12rem] truncate" title={p.file.name}>
                  {p.file.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{fmtFileSize(p.file.size)}</span>
                <button
                  type="button"
                  onClick={() => queue.removePending(p.key)}
                  disabled={disabled}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  aria-label={`Usuń ${p.file.name} z listy`}
                  title="Usuń z listy"
                  data-testid={`${testid}-pending-remove`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {queue.fileError && (
        <p className="text-xs text-destructive" role="alert" data-testid={`${testid}-file-error`}>
          {queue.fileError}
        </p>
      )}
    </div>
  );
}
