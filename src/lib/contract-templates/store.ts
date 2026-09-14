/**
 * Pliki umów na dysku: wygenerowany DOCX (albo wgrany PDF) i załączniki (skan
 * podpisanej umowy, aneksy) leżą w JEDNYM katalogu `contract-drafts/<draftId>`
 * wewnątrz katalogu załączników. Dzięki temu usunięcie draftu albo obiektu
 * sprząta wszystko jednym `rm -r`, a moduł nie potrzebuje własnej obsługi dysku
 * (limity, ochrona przed path traversal — src/lib/calendar-attachments.ts).
 *
 * Ten sam układ dostał REJESTR umów: własny dokument wpisu (`contracts.document_*`,
 * migracja 0099) leży w `contracts/<contractId>`. Dwa katalogi zamiast jednego,
 * bo to dwa niezależne byty — skasowanie draftu nie może zabrać pliku, który
 * ktoś wgrał do wpisu w rejestrze.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  ATTACHMENT_MAX_BYTES,
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

/** Podkatalog dokumentu jednego wpisu rejestru umów. */
export function contractScope(contractId: number): string {
  return `contracts/${contractId}`;
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
 * Zapisuje plik dokumentu pod NOWYM uuid i dopiero potem kasuje poprzedni.
 * Nadpisanie w miejscu zostawiłoby otwarte pobranie ze starym rozmiarem
 * i uciętą treścią; przy nowej nazwie stary plik żyje do końca trwających pobrań.
 */
function writeDocumentFile(scope: string, ext: "docx" | "pdf", buffer: Buffer, previousStoredPath: string | null): string {
  const dir = resolveStoredPath(scope);
  if (!dir || dir === ATTACHMENTS_DIR) throw new ApiError(500, "Nieprawidłowy katalog dokumentów umowy");
  mkdirSync(dir, { recursive: true });

  const storedPath = `${scope}/${randomUUID()}.${ext}`;
  writeFileSync(join(ATTACHMENTS_DIR, storedPath), buffer);
  if (previousStoredPath && previousStoredPath !== storedPath) {
    removeStoredFiles([{ storedPath: previousStoredPath }]);
  }
  return storedPath;
}

/** Świeżo wyrenderowany DOCX draftu (wzór Worda + pola formularza). */
export function writeGeneratedDocx(draftId: number, buffer: Buffer, previousStoredPath: string | null): string {
  return writeDocumentFile(draftScope(draftId), "docx", buffer, previousStoredPath);
}

/**
 * Wgrany PDF draftu spoza generatora. Ląduje w TYCH SAMYCH kolumnach i tym
 * samym katalogu co DOCX — dla reszty modułu (podgląd, pobranie, przeniesienie
 * do rejestru, kasowanie) to po prostu „dokument draftu”.
 */
export function writeExternalPdf(draftId: number, buffer: Buffer, previousStoredPath: string | null): string {
  return writeDocumentFile(draftScope(draftId), "pdf", buffer, previousStoredPath);
}

/** Własny PDF wpisu w rejestrze umów (`contracts.document_*`). */
export function writeContractDocument(contractId: number, buffer: Buffer, previousStoredPath: string | null): string {
  return writeDocumentFile(contractScope(contractId), "pdf", buffer, previousStoredPath);
}

/** Bezwzględna ścieżka istniejącego pliku albo null (skasowany ręcznie / brak). */
export function generatedFilePath(storedPath: string | null): string | null {
  return storedPath ? attachmentFilePath(storedPath) : null;
}

/** Kasuje cały katalog draftu — wołać PO commicie usunięcia wiersza. */
export function removeDraftDir(draftId: number): void {
  removeAttachmentDir(draftScope(draftId));
}

/** Kasuje katalog dokumentu wpisu rejestru — wołać PO commicie usunięcia umowy. */
export function removeContractDir(contractId: number): void {
  removeAttachmentDir(contractScope(contractId));
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF_MIME = "application/pdf";

/** Maksymalny rozmiar wgrywanego PDF-a — ten sam limit, co dla załączników. */
export const CONTRACT_PDF_MAX_BYTES = ATTACHMENT_MAX_BYTES;

/**
 * Nazwa wgranego PDF-a pokazywana użytkownikowi: oryginalna, bez ścieżki
 * i znaków, których nie przyjmie zapis na dysku klienta (nazwa idzie do
 * `Content-Disposition`, a stamtąd wprost do zapisu pliku).
 */
export function externalFileName(originalName: string): string {
  const base = originalName.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  const cleaned = base
    // Znaki sterujące z nazwy pliku wycinamy zanim trafi do nagłówka odpowiedzi.
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/["*:<>?|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const named = cleaned || "umowa.pdf";
  const withExt = /\.pdf$/i.test(named) ? named : `${named}.pdf`;
  return withExt.length > 180 ? withExt.slice(-180) : withExt;
}

/**
 * Czy bufor to PDF. Sprawdzamy MAGICZNE BAJTY, a nie samo rozszerzenie i MIME
 * z formularza: jedno i drugie ustawia klient, więc „.pdf” bywa DOCX-em albo
 * obrazkiem, a podgląd pokazałby wtedy pustą ramkę bez słowa wyjaśnienia.
 * Nagłówek `%PDF-` bywa poprzedzony śmieciem (skanery, scalarki), więc
 * dopuszczamy go w pierwszym kilobajcie — tak samo robią czytniki PDF.
 */
export function looksLikePdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes("%PDF-");
}

/** Plik gotowy do zapisu — kształt wspólny z `IncomingFile` załączników. */
export interface PdfUploadFile {
  name: string;
  mime: string;
  data: Buffer;
}

/**
 * Walidacja wgrywanego PDF-a (rozmiar, rozszerzenie/MIME, magiczne bajty) albo
 * `ApiError 400` z polskim zdaniem. Jedno miejsce dla obu dróg: draftu spoza
 * generatora (`/contracts/drafts/external`) i dokumentu wpisu w rejestrze
 * (`/contracts/:id/document`) — inaczej dwa formularze przyjmowałyby dwa różne
 * zbiory plików.
 */
export function assertPdfUpload(name: string, mime: string, data: Buffer): PdfUploadFile {
  if (data.length === 0) throw new ApiError(400, "Wybrany plik jest pusty");
  if (data.length > ATTACHMENT_MAX_BYTES) {
    throw new ApiError(400, `Plik ${name} przekracza ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB`);
  }
  const clean = (mime || "").split(";")[0].trim().toLowerCase();
  if (!/\.pdf$/i.test(name) && clean !== PDF_MIME) {
    throw new ApiError(400, "Umowę można wgrać wyłącznie jako plik PDF");
  }
  if (!looksLikePdf(data)) {
    throw new ApiError(400, "To nie jest plik PDF — zapisz umowę jako PDF i spróbuj ponownie");
  }
  return { name, mime: PDF_MIME, data };
}
