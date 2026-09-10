// Wspólne drobiazgi załączników: rozpoznawanie typów plików, formatowanie
// rozmiaru, ikony i walidacja zgodna z limitami backendu (15 × 5 MB, te same,
// co przy notatkach kalendarza — src/lib/calendar-attachments.ts).
//
// Moduł powstał z `components/manuals/manualsShared.ts` (który został cienkim
// re-eksportem), bo od Grup interwencyjnych te same reguły obowiązują w trzech
// miejscach naraz: firmy, warunki i interwencje. Funkcje są czyste — żadnego
// Reacta, żadnego stanu, żeby dało się je wołać i z komponentu, i z testu.
import {
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import {
  MANUAL_ATTACHMENT_ACCEPT,
  MANUAL_ATTACHMENT_MAX_FILES,
  MANUAL_ATTACHMENT_MAX_SIZE,
} from "@/lib/api";

/** Limity są wspólne dla wszystkich modułów z załącznikami — jedna wartość, jedno źródło. */
export const ATTACHMENT_MAX_FILES = MANUAL_ATTACHMENT_MAX_FILES;
export const ATTACHMENT_MAX_SIZE = MANUAL_ATTACHMENT_MAX_SIZE;
export const ATTACHMENT_ACCEPT = MANUAL_ATTACHMENT_ACCEPT;

/**
 * Najmniejszy wspólny kształt załącznika. Manuale zwracają `mime`, moduł Grup
 * interwencyjnych `mimeType` — helpery godzą oba przez `mimeOf`, żeby nie
 * przepisywać kontraktu żadnej ze stron.
 */
export interface AttachmentLike {
  id: number;
  fileName: string;
  mime?: string;
  mimeType?: string;
  size: number;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  /** Ścieżka względem origin (podgląd/pobranie zależy od parametru). */
  url: string;
  /** To samo z dyspozycją `attachment`; gdy backend nie poda — dokładamy sami. */
  downloadUrl?: string;
  createdAt?: string;
}

/** Typ MIME niezależnie od tego, którym polem przyszedł. */
export const mimeOf = (a: AttachmentLike): string => a.mime ?? a.mimeType ?? "";

/** Rozszerzenia dopuszczane przez backend (poza image/*). */
const ALLOWED_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "csv", "txt", "rtf",
]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "tif", "tiff"]);

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

export const isImageFile = (f: File) => f.type.startsWith("image/") || IMAGE_EXT.has(extOf(f.name));
export const isAllowedFile = (f: File) => isImageFile(f) || ALLOWED_EXT.has(extOf(f.name));

export function fmtFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Ikona wg typu pliku (ta sama logika, co na chipach notatek). */
export function attachmentIcon(mime: string, fileName: string): LucideIcon {
  const ext = extOf(fileName);
  if (mime === "application/pdf" || ext === "pdf" || mime.startsWith("text/") || ["doc", "docx", "odt", "rtf", "txt"].includes(ext)) {
    return FileText;
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime === "text/csv" || ["xls", "xlsx", "ods", "csv"].includes(ext)) {
    return FileSpreadsheet;
  }
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["ppt", "pptx", "odp"].includes(ext)) {
    return Presentation;
  }
  return FileIcon;
}

/** PDF i obrazki przeglądarka otworzy w nowej karcie; reszta = pobranie. */
export const opensInline = (a: AttachmentLike) =>
  a.kind === "image" || mimeOf(a) === "application/pdf" || extOf(a.fileName) === "pdf";

/** Backend podaje `downloadUrl`; gdyby go zabrakło, dokładamy parametr sami. */
export const downloadUrlOf = (a: AttachmentLike) =>
  a.downloadUrl || `${a.url}${a.url.includes("?") ? "&" : "?"}download=1`;

interface PartitionOptions {
  /** Limit sztuk na encję (domyślnie limit backendu). */
  maxFiles?: number;
  /**
   * Dopełnienie komunikatu o przepełnieniu: „Maks. 15 plików {scopeSuffix} —
   * pominięto 2.”. Domyślnie brzmi jak przy manualach.
   */
  scopeSuffix?: string;
}

/**
 * Waliduje pliki wg limitów backendu (15 sztuk po 5 MB na encję).
 * Zwraca przyjęte pliki i polskie komunikaty o odrzuconych.
 */
export function partitionAttachmentFiles(
  incoming: File[],
  alreadyCount: number,
  options: PartitionOptions = {}
): { accepted: File[]; messages: string[] } {
  const maxFiles = options.maxFiles ?? ATTACHMENT_MAX_FILES;
  const scopeSuffix = options.scopeSuffix ?? "w jednym manualu";
  const accepted: File[] = [];
  const messages: string[] = [];
  const tooBig: string[] = [];
  const badType: string[] = [];
  let overflow = 0;
  for (const f of incoming) {
    if (!isAllowedFile(f)) {
      badType.push(f.name);
      continue;
    }
    if (f.size > ATTACHMENT_MAX_SIZE) {
      tooBig.push(f.name);
      continue;
    }
    if (alreadyCount + accepted.length >= maxFiles) {
      overflow++;
      continue;
    }
    accepted.push(f);
  }
  if (badType.length) {
    messages.push(
      `Niedozwolony typ pliku: ${badType.join(", ")}. Dozwolone: obrazy, PDF, dokumenty Office/OpenDocument, CSV, TXT, RTF.`
    );
  }
  if (tooBig.length) {
    messages.push(`Plik przekracza 5 MB: ${tooBig.join(", ")}.`);
  }
  if (overflow > 0) {
    messages.push(`Maks. ${maxFiles} plików ${scopeSuffix} — pominięto ${overflow}.`);
  }
  return { accepted, messages };
}

/** Plik czekający w formularzu na wysyłkę (jeszcze nie ma id z backendu). */
export interface PendingFile {
  key: string;
  file: File;
  /** Object URL miniatury (tylko obrazki) — zwalniany przy usunięciu / zapisie / zamknięciu. */
  previewUrl: string | null;
}

let pendingSeq = 0;

/** Opakowuje wybrane pliki w kolejkę z miniaturami. */
export function makePendingFiles(files: File[]): PendingFile[] {
  return files.map((file) => ({
    key: `${Date.now()}-${++pendingSeq}`,
    file,
    previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
  }));
}

/** Zwalnia miniatury — obowiązkowe przy zamknięciu formularza i po wysyłce. */
export function revokePendingPreviews(list: PendingFile[]): void {
  for (const p of list) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
}
