/**
 * Załączniki plikowe — pliki na dysku, metadane w bazie. Ten moduł zna: limity,
 * dozwolone typy, konwersję obrazków do WebP (sharp), zapis/kasowanie plików
 * i ochronę przed path traversal. NIE zna encji, do której należą — dostaje
 * „scope", czyli podkatalog w katalogu załączników.
 *
 * Konsumenci:
 *  - notatki wydarzeń kalendarza (tabela calendar_note_attachments, scope = `<eventId>`),
 *    trasy w src/routes/calendar.ts, wpis do bazy w addNote (src/lib/calendar-mutations.ts);
 *  - manuale (tabela manual_attachments, scope = `manuals/<manualId>`), src/routes/manuals.ts.
 *
 * Układ na dysku: `<DATA_DIR>/attachments/<scope>/<uuid>.<ext>` — katalog per encja,
 * żeby twarde usunięcie encji mogło skasować wszystko jednym `rm -r`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import sharp, { type OutputInfo } from "sharp";
import { inArray } from "drizzle-orm";
import { DATA_DIR, schema } from "../db/index.js";
import type { CalendarAttachmentKind, CalendarNoteAttachment } from "../db/schema.js";
import type { DbOrTx } from "./activity-log.js";
import { ApiError } from "./calendar-labels.js";

export const ATTACHMENTS_DIR = resolve(DATA_DIR, "attachments");
/** Maksymalnie tyle plików na jedną notatkę. */
export const ATTACHMENT_MAX_FILES = 15;
/** Maksymalny rozmiar SUROWEGO uploadu jednego pliku (przed konwersją). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Dłuższy bok obrazka po konwersji (bez powiększania). */
const IMAGE_MAX_SIDE = 2560;
const WEBP_QUALITY = 82;

/** Prefiks URL, pod którym trasa GET /attachments/:id jest widoczna z frontu (router kalendarza pod /api/calendar). */
export const ATTACHMENT_URL_PREFIX = "/api/calendar/attachments";

/** Rozszerzenia obrazków, które sharp dekoduje (svg/bmp przez libvips). */
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "avif", "svg", "bmp", "heic", "heif"]);

/** Dokumenty: rozszerzenie → kanoniczny MIME (przeglądarki bywają niezgodne, np. octet-stream dla .docx). */
const DOC_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  csv: "text/csv",
  txt: "text/plain",
  rtf: "application/rtf",
};
const DOC_MIMES = new Set([...Object.values(DOC_MIME_BY_EXT), "text/rtf", "application/x-rtf"]);

/** Plik z multipartu przed zapisem (już zwalidowany typ). */
export interface IncomingFile {
  name: string;
  mime: string;
  data: Buffer;
}

/** Wynik zapisu na dysk — to, co addNote wstawia do calendar_note_attachments. */
export interface StoredAttachment {
  fileName: string;
  mime: string;
  size: number;
  storedPath: string;
  kind: CalendarAttachmentKind;
  width: number | null;
  height: number | null;
}

/** Kształt załącznika w JSON notatki (kontrakt z frontem). */
export interface NoteAttachmentJson {
  id: number;
  fileName: string;
  mime: string;
  size: number;
  kind: CalendarAttachmentKind;
  width: number | null;
  height: number | null;
  url: string;
}

export function attachmentOfRow(r: CalendarNoteAttachment): NoteAttachmentJson {
  return {
    id: r.id,
    fileName: r.fileName,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    url: `${ATTACHMENT_URL_PREFIX}/${r.id}`,
  };
}

/** Załączniki dla wielu notatek jednym zapytaniem (bez N+1); klucz = noteId. */
export function attachmentsByNote(dbx: DbOrTx, noteIds: number[]): Map<number, NoteAttachmentJson[]> {
  const out = new Map<number, NoteAttachmentJson[]>();
  if (noteIds.length === 0) return out;
  const rows = dbx
    .select()
    .from(schema.calendarNoteAttachments)
    .where(inArray(schema.calendarNoteAttachments.noteId, noteIds))
    .orderBy(schema.calendarNoteAttachments.id)
    .all();
  for (const r of rows) {
    const list = out.get(r.noteId) ?? [];
    list.push(attachmentOfRow(r));
    out.set(r.noteId, list);
  }
  return out;
}

/** Nazwa pliku bez ścieżki (przeglądarki potrafią wysłać pełną ścieżkę), skrócona do rozsądnej długości. */
function baseName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, "/").split("/").pop()?.replace(/[\u0000-\u001f]/g, "").trim() || "plik";
  return cleaned.length > 180 ? cleaned.slice(-180) : cleaned;
}

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

type Classified = { kind: "image" } | { kind: "file"; mime: string };

/**
 * Walidacja typu po rozszerzeniu i MIME. Rozszerzenie ma pierwszeństwo (przeglądarka daje
 * `application/octet-stream` dla nieznanych jej typów); bez rozpoznanego rozszerzenia
 * wystarczy wiarygodny MIME (image/* albo znany dokument).
 */
function classify(name: string, mime: string): Classified {
  const ext = extOf(name);
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: "image" };
  if (DOC_MIME_BY_EXT[ext]) return { kind: "file", mime: DOC_MIME_BY_EXT[ext] };
  if (m.startsWith("image/")) return { kind: "image" };
  if (DOC_MIMES.has(m)) return { kind: "file", mime: m === "text/rtf" || m === "application/x-rtf" ? "application/rtf" : m };
  throw new ApiError(400, `Nieobsługiwany typ pliku: ${baseName(name)}`);
}

/**
 * Walidacja zestawu plików PRZED zapisem czegokolwiek: liczba, rozmiar surowy, typ.
 * Rzuca ApiError 400 z polskim komunikatem.
 */
export function validateUploads(files: IncomingFile[]): void {
  if (files.length > ATTACHMENT_MAX_FILES) throw new ApiError(400, `Maksymalnie ${ATTACHMENT_MAX_FILES} plików`);
  for (const f of files) {
    if (f.data.length > ATTACHMENT_MAX_BYTES) throw new ApiError(400, `Plik ${baseName(f.name)} przekracza 5 MB`);
    if (f.data.length === 0) throw new ApiError(400, `Plik ${baseName(f.name)} jest pusty`);
    classify(f.name, f.mime);
  }
}

/**
 * Zapisuje pliki na dysk do katalogu `scope` (podkatalog katalogu załączników:
 * `<eventId>` dla notatek kalendarza, `manuals/<manualId>` dla manuali). Obrazki → WebP
 * (rotate wg EXIF, max 2560 px dłuższego boku, bez powiększania). Przy błędzie w połowie
 * sprząta już zapisane pliki i rzuca dalej — wołający nie ma nic do posprzątania.
 */
export async function storeUploads(scope: string | number, files: IncomingFile[]): Promise<StoredAttachment[]> {
  validateUploads(files);
  const scopeDir = String(scope);
  // Scope pochodzi z kodu (id encji), nie z żądania — sprawdzamy i tak, bo koszt zerowy.
  const dir = resolveStoredPath(scopeDir);
  if (!dir || dir === ATTACHMENTS_DIR) throw new ApiError(400, "Nieprawidłowy katalog załączników");
  mkdirSync(dir, { recursive: true });
  const stored: StoredAttachment[] = [];
  try {
    for (const f of files) {
      const cls = classify(f.name, f.mime);
      const original = baseName(f.name);
      if (cls.kind === "image") {
        let out: { data: Buffer; info: OutputInfo };
        try {
          out = await sharp(f.data, { failOn: "error" })
            .rotate()
            .resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer({ resolveWithObject: true });
        } catch {
          throw new ApiError(400, `Nie udało się przetworzyć obrazka: ${original}`);
        }
        const storedPath = `${scopeDir}/${randomUUID()}.webp`;
        writeFileSync(join(ATTACHMENTS_DIR, storedPath), out.data);
        stored.push({
          fileName: original.replace(/\.[^.]+$/, "") + ".webp",
          mime: "image/webp",
          size: out.info.size,
          storedPath,
          kind: "image",
          width: out.info.width,
          height: out.info.height,
        });
      } else {
        const ext = extOf(original) || "bin";
        const storedPath = `${scopeDir}/${randomUUID()}.${ext}`;
        writeFileSync(join(ATTACHMENTS_DIR, storedPath), f.data);
        stored.push({ fileName: original, mime: cls.mime, size: f.data.length, storedPath, kind: "file", width: null, height: null });
      }
    }
  } catch (error) {
    removeStoredFiles(stored);
    throw error;
  }
  return stored;
}

/** Kasuje pliki z dysku (best effort — brak pliku nie jest błędem). */
export function removeStoredFiles(items: Array<{ storedPath: string }>): void {
  for (const it of items) {
    const abs = resolveStoredPath(it.storedPath);
    if (!abs) continue;
    try {
      unlinkSync(abs);
    } catch {
      /* już nie ma — nic do zrobienia */
    }
  }
}

/**
 * Bezwzględna ścieżka pliku załącznika albo null, gdy `storedPath` wychodzi poza katalog
 * załączników. Ścieżki pochodzą tylko z bazy, ale sprawdzamy i tak — koszt zerowy.
 */
export function resolveStoredPath(storedPath: string): string | null {
  const abs = resolve(ATTACHMENTS_DIR, storedPath);
  if (abs !== ATTACHMENTS_DIR && !abs.startsWith(ATTACHMENTS_DIR + sep)) return null;
  return abs;
}

/** Ścieżka istniejącego pliku albo null (poza katalogiem / brak na dysku). */
export function attachmentFilePath(storedPath: string): string | null {
  const abs = resolveStoredPath(storedPath);
  return abs && existsSync(abs) ? abs : null;
}

/**
 * Usuwa cały katalog załączników danego scope'u — do wołania PO commicie twardego
 * usunięcia encji (wiersze znikają kaskadą FK). Nie usunie samego katalogu załączników
 * ani niczego spoza niego.
 */
export function removeAttachmentDir(scope: string | number): void {
  const dir = resolveStoredPath(String(scope));
  if (!dir || dir === ATTACHMENTS_DIR || !dirname(dir).startsWith(ATTACHMENTS_DIR)) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Katalog załączników wydarzenia kalendarza — do wołania PO commicie twardego usunięcia
 * wydarzenia (wiersze znikają kaskadą przez calendar_event_notes). Soft delete nie rusza plików.
 */
export function removeEventAttachmentDir(eventId: number): void {
  removeAttachmentDir(eventId);
}

/**
 * Nagłówek Content-Disposition z nazwą w RFC 5987 (`filename*`) + ASCII-owy fallback
 * dla starych klientów.
 */
export function contentDisposition(type: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
