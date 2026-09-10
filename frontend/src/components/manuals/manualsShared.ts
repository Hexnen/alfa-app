// Drobiazgi modułu Manuale. Reguły plików (typy, rozmiar, ikony, limity) żyją
// od czasu Grup interwencyjnych w `@/lib/attachments` — tu został cienki
// re-eksport, żeby komponenty manuali (i ich testy) importowały to, co zawsze.
export {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_SIZE,
  attachmentIcon,
  downloadUrlOf,
  extOf,
  fmtFileSize,
  isAllowedFile,
  isImageFile,
  mimeOf,
  opensInline,
  partitionAttachmentFiles,
  type AttachmentLike,
} from "@/lib/attachments";

import { partitionAttachmentFiles } from "@/lib/attachments";

/**
 * Waliduje pliki wg limitów backendu (15 sztuk po 5 MB na manual).
 * Zwraca przyjęte pliki i polskie komunikaty o odrzuconych.
 */
export const partitionManualFiles = (incoming: File[], alreadyCount: number) =>
  partitionAttachmentFiles(incoming, alreadyCount, { scopeSuffix: "w jednym manualu" });

/** Klucz wybranego powiązania w formularzu (jeden zbiór dla towarów i usług). */
export const linkKey = (kind: "item" | "service", refId: number) => `${kind}:${refId}`;
