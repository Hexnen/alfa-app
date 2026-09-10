/**
 * Pliki draftu umowy na dysku: wygenerowany DOCX i załączniki (skan podpisanej
 * umowy, aneksy) leżą w JEDNYM katalogu `contract-drafts/<draftId>` wewnątrz
 * katalogu załączników. Dzięki temu usunięcie draftu albo obiektu sprząta
 * wszystko jednym `rm -r`, a moduł nie potrzebuje własnej obsługi dysku
 * (limity, ochrona przed path traversal — src/lib/calendar-attachments.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  attachmentFilePath,
  removeAttachmentDir,
  removeStoredFiles,
  resolveStoredPath,
} from "../calendar-attachments.js";
import { ApiError } from "../calendar-labels.js";

/** Podkatalog załączników jednego draftu. */
export function draftScope(draftId: number): string {
  return `contract-drafts/${draftId}`;
}

/**
 * Nazwa pliku pokazywana użytkownikowi: „Umowa ZDW 12-ZDW-2026.docx”.
 *
 * Ukośniki z numeru MUSZĄ zniknąć: nazwa trafia do nagłówka Content-Disposition
 * i stamtąd wprost do zapisu na dysku klienta, gdzie „/” znaczy katalog. Przy
 * okazji lecą znaki, których Windows nie przyjmuje w nazwie pliku.
 */
export function generatedFileName(fileLabel: string, contractNumber: string): string {
  const safe = contractNumber
    .replace(/[\\/]+/g, "-")
    .replace(/["*:<>?|]/g, "")
    .trim();
  return `${fileLabel} ${safe}`.replace(/\s+/g, " ").trim() + ".docx";
}

/**
 * Zapisuje świeżo wyrenderowany DOCX pod NOWYM uuid i dopiero potem kasuje
 * poprzedni. Nadpisanie w miejscu zostawiłoby otwarte pobranie ze starym
 * rozmiarem i uciętą treścią; przy nowej nazwie stary plik żyje do końca
 * trwających pobrań.
 */
export function writeGeneratedDocx(draftId: number, buffer: Buffer, previousStoredPath: string | null): string {
  const scope = draftScope(draftId);
  const dir = resolveStoredPath(scope);
  if (!dir || dir === ATTACHMENTS_DIR) throw new ApiError(500, "Nieprawidłowy katalog dokumentów umowy");
  mkdirSync(dir, { recursive: true });

  const storedPath = `${scope}/${randomUUID()}.docx`;
  writeFileSync(join(ATTACHMENTS_DIR, storedPath), buffer);
  if (previousStoredPath && previousStoredPath !== storedPath) {
    removeStoredFiles([{ storedPath: previousStoredPath }]);
  }
  return storedPath;
}

/** Bezwzględna ścieżka istniejącego pliku albo null (skasowany ręcznie / brak). */
export function generatedFilePath(storedPath: string | null): string | null {
  return storedPath ? attachmentFilePath(storedPath) : null;
}

/** Kasuje cały katalog draftu — wołać PO commicie usunięcia wiersza. */
export function removeDraftDir(draftId: number): void {
  removeAttachmentDir(draftScope(draftId));
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
