import * as XLSX from "xlsx";

// Parsed entry from a CMA camera-review report (DMSI/Safestar XLS export)
export interface ParsedCmaEntry {
  objectCategory: string | null;
  objectName: string;
  address: string | null;
  identifier1: string | null;
  identifier2: string | null;
  identifier3: string | null;
  generatedAt: string | null;
  patrolName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endType: string | null;
  description: string | null;
  videoDevice: string | null;
  videoChannel: string | null;
  userName: string | null;
}

export interface ParsedCmaReport {
  title: string;
  dateFrom: string | null;
  dateTo: string | null;
  entries: ParsedCmaEntry[];
}

export class CmaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmaParseError";
  }
}

// Windows-1252 special characters in the 0x80-0x9F range (reverse map)
const CP1252_REVERSE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Repair strings that are UTF-8 bytes mis-decoded as Windows-1252
// (document properties of BIFF files often come out this way,
// e.g. "przeglÄ…du" instead of "przeglądu").
function fixMojibake(value: string): string {
  if (!/[Â-Å]/.test(value)) return value;
  const bytes: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) {
      bytes.push(cp);
    } else if (CP1252_REVERSE[cp] !== undefined) {
      bytes.push(CP1252_REVERSE[cp]);
    } else {
      // Contains characters that cannot come from cp1252 decoding - not mojibake
      return value;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes)
    );
  } catch {
    return value;
  }
}

// Normalize cell value to trimmed string or null
function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

// Normalize DMSI date format "2026-07-04, 20:49:02" -> "2026-07-04 20:49:02"
// so values sort lexicographically
function normalizeDate(value: unknown): string | null {
  const str = cellToString(value);
  if (!str) return null;
  return str.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();
}

// Column headers expected in the report file
const HEADERS = {
  objectCategory: "Kategoria obiektu",
  objectName: "Obiekt",
  address: "Adres",
  identifier1: "Identyfikator 1",
  identifier2: "Identyfikator 2",
  identifier3: "Identyfikator 3",
  generatedAt: "Data wygenerowania wideo-obchodu",
  patrolName: "Nazwa wideo-obchodu",
  startedAt: "Rozpoczęcie wideo-obchodu",
  endedAt: "Zakończenie wideo-obchodu",
  endType: "Rodzaj zakończenia",
  description: "Opis nieprawidłowości",
  videoDevice: "Urządzenie wideo",
  videoChannel: "Kanał urządzenia wideo",
  userName: "Użytkownik",
} as const;

/**
 * Parse a CMA camera-review report file (binary XLS from DMSI/Safestar
 * or XLSX). Finds the header row dynamically and maps columns by header
 * name - column positions are not assumed.
 *
 * @throws CmaParseError when the file cannot be parsed or contains no data
 */
export function parseCmaReportXls(
  buffer: Buffer,
  fileName: string
): ParsedCmaReport {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new CmaParseError(
      "Nie udało się odczytać pliku. Upewnij się, że to prawidłowy plik Excel (.xls lub .xlsx)."
    );
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    throw new CmaParseError("Plik nie zawiera żadnego arkusza z danymi.");
  }

  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
  });

  // Find header row - first row containing the "Obiekt" header
  let headerRowIndex = -1;
  let columnIndex: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const cells = row.map((cell) => cellToString(cell));
    if (cells.includes(HEADERS.objectName)) {
      headerRowIndex = i;
      for (const [field, header] of Object.entries(HEADERS) as [
        keyof typeof HEADERS,
        string
      ][]) {
        const idx = cells.indexOf(header);
        if (idx !== -1) columnIndex[field] = idx;
      }
      break;
    }
  }

  if (headerRowIndex === -1) {
    throw new CmaParseError("Nie znaleziono danych raportu w pliku");
  }

  const col = (row: unknown[], field: keyof typeof HEADERS): string | null => {
    const idx = columnIndex[field];
    if (idx === undefined) return null;
    return cellToString(row[idx]);
  };

  const entries: ParsedCmaEntry[] = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const objectName = col(row, "objectName");
    if (!objectName) continue; // skip rows without "Obiekt" (incl. trailing null row)

    const idxGenerated = columnIndex.generatedAt;
    const idxStarted = columnIndex.startedAt;
    const idxEnded = columnIndex.endedAt;

    entries.push({
      objectCategory: col(row, "objectCategory"),
      objectName,
      address: col(row, "address"),
      identifier1: col(row, "identifier1"),
      identifier2: col(row, "identifier2"),
      identifier3: col(row, "identifier3"),
      generatedAt:
        idxGenerated !== undefined ? normalizeDate(row[idxGenerated]) : null,
      patrolName: col(row, "patrolName"),
      startedAt: idxStarted !== undefined ? normalizeDate(row[idxStarted]) : null,
      endedAt: idxEnded !== undefined ? normalizeDate(row[idxEnded]) : null,
      endType: col(row, "endType"),
      description: col(row, "description"),
      videoDevice: col(row, "videoDevice"),
      videoChannel: col(row, "videoChannel"),
      userName: col(row, "userName"),
    });
  }

  if (entries.length === 0) {
    throw new CmaParseError("Nie znaleziono danych raportu w pliku");
  }

  // Date range = min/max of "Data wygenerowania wideo-obchodu" (normalized)
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  for (const entry of entries) {
    if (!entry.generatedAt) continue;
    if (dateFrom === null || entry.generatedAt < dateFrom) {
      dateFrom = entry.generatedAt;
    }
    if (dateTo === null || entry.generatedAt > dateTo) {
      dateTo = entry.generatedAt;
    }
  }

  // Title from document properties, fallback to file name
  const rawTitle = workbook.Props?.Title?.trim();
  const title = rawTitle ? fixMojibake(rawTitle).trim() : fileName;

  return { title, dateFrom, dateTo, entries };
}
