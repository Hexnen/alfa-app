import * as XLSX from "xlsx";

/**
 * Parser dziennego raportu obiektów (CSV z Safestar).
 *
 * Kolumny mapowane są po polskich nagłówkach (nie po pozycji), wartości
 * "---" traktowane jak brak danych. Jeden obiekt może wystąpić w raporcie
 * w kilku wierszach (po jednym na typ usługi) — wiersze są scalane po
 * "ID Obiektu", a różniące się wartości łączone przez "; ".
 */

export class ObjectReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectReportParseError";
  }
}

/** Pola obiektu śledzone w logu zmian (bez externalId). */
export interface ParsedMonitoredObject {
  externalId: number;
  account: string | null;
  category: string | null;
  name: string;
  identifier1: string | null;
  identifier2: string | null;
  identifier3: string | null;
  extraData1: string | null;
  extraData2: string | null;
  extraData3: string | null;
  extraData4: string | null;
  extraData5: string | null;
  address: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  latitude: string | null;
  longitude: string | null;
  locationDescription: string | null;
  objectDescription: string | null;
  phones: string | null;
  devices: string | null;
  defaultCrew: string | null;
  allCrews: string | null;
  groups: string | null;
  monitoringStart: string | null;
  monitoringEnd: string | null;
  objectStatus: string | null;
  addedAt: string | null;
  authorizedPersons: string | null;
  authorizedPhones: string | null;
  authorizedPasswords: string | null;
  duressPasswords: string | null;
  dayArrivalTime: string | null;
  nightArrivalTime: string | null;
  relatedObjects: string | null;
  serviceTypes: string | null;
  serviceMonitoringFrom: string | null;
  serviceMonitoringTo: string | null;
}

export interface ParsedObjectReport {
  fileName: string;
  objects: ParsedMonitoredObject[];
}

type DataField = Exclude<keyof ParsedMonitoredObject, "externalId" | "name">;

const ID_HEADER = "ID Obiektu";
const NAME_HEADER = "Nazwa obiektu";

// Nagłówek CSV -> pole rekordu
const HEADERS: Record<string, DataField> = {
  Konto: "account",
  "Kategoria obiektu": "category",
  "Identyfikator 1": "identifier1",
  "Identyfikator 2": "identifier2",
  "Identyfikator 3": "identifier3",
  "Dane dodatkowe 1": "extraData1",
  "Dane dodatkowe 2": "extraData2",
  "Dane dodatkowe 3": "extraData3",
  "Dane dodatkowe 4": "extraData4",
  "Dane dodatkowe 5": "extraData5",
  Adres: "address",
  Ulica: "street",
  "Numer domu": "houseNumber",
  "Kod pocztowy": "postalCode",
  Miasto: "city",
  "Szerokość geograficzna": "latitude",
  "Długość geograficzna": "longitude",
  "Opis lokalizacji": "locationDescription",
  "Opis obiektu": "objectDescription",
  "Telefony obiektu": "phones",
  Urządzenia: "devices",
  "Domyślna załoga": "defaultCrew",
  "Wszystkie załogi": "allCrews",
  Grupy: "groups",
  "Rozpoczęcie monitorowania": "monitoringStart",
  "Zakończenie monitorowania": "monitoringEnd",
  "Status obiektu": "objectStatus",
  "Data dodania": "addedAt",
  "Dane osób upoważnionych": "authorizedPersons",
  "Nr kontaktowe osób upoważnionych": "authorizedPhones",
  "Hasło osób upoważnionych": "authorizedPasswords",
  "Hasła pod przymusem osób upoważnionych": "duressPasswords",
  "Czas dojazdu w dzień": "dayArrivalTime",
  "Czas dojazdu w nocy": "nightArrivalTime",
  "Obiekty powiązane": "relatedObjects",
  "Typ usługi": "serviceTypes",
  "Początek monitorowania usługi": "serviceMonitoringFrom",
  "Koniec monitorowania usługi": "serviceMonitoringTo",
};

function normalizeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n/g, "\n").trim();
  if (!text || text === "---") return null;
  return text;
}

/** Łączy różniące się wartości scalanych wierszy tego samego obiektu. */
function mergeValues(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null || a === b) return a;
  const parts = a.split("; ");
  if (parts.includes(b)) return a;
  return [...parts, b].sort((x, y) => x.localeCompare(y, "pl")).join("; ");
}

export function parseObjectReportCsv(
  buffer: Buffer,
  fileName: string
): ParsedObjectReport {
  let workbook: XLSX.WorkBook;
  try {
    if (/\.csv$/i.test(fileName)) {
      // CSV czytamy jako string, żeby wymusić UTF-8 (domyślnie SheetJS
      // dekoduje bufor CSV jako latin1 i psuje polskie znaki)
      let text = buffer.toString("utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      workbook = XLSX.read(text, { type: "string", raw: true });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch {
    throw new ObjectReportParseError(
      "Nie udało się odczytać pliku raportu obiektów."
    );
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    throw new ObjectReportParseError("Plik raportu nie zawiera danych.");
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  // Wiersz nagłówka znajdujemy po komórce "ID Obiektu"
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i]?.some((cell) => normalizeCell(cell) === ID_HEADER)) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw new ObjectReportParseError(
      `Nie znaleziono nagłówka "${ID_HEADER}" — to nie wygląda na raport obiektów.`
    );
  }

  const headerRow = rows[headerRowIndex].map((cell) => normalizeCell(cell));
  const idColumn = headerRow.indexOf(ID_HEADER);
  const nameColumn = headerRow.indexOf(NAME_HEADER);
  if (nameColumn === -1) {
    throw new ObjectReportParseError(
      `Nie znaleziono kolumny "${NAME_HEADER}" w raporcie.`
    );
  }
  const fieldColumns: [number, DataField][] = [];
  headerRow.forEach((header, index) => {
    if (header && HEADERS[header]) fieldColumns.push([index, HEADERS[header]]);
  });

  const byExternalId = new Map<number, ParsedMonitoredObject>();

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rawId = normalizeCell(row[idColumn]);
    if (!rawId) continue;
    const externalId = Number.parseInt(rawId, 10);
    if (!Number.isInteger(externalId)) continue;

    const name = normalizeCell(row[nameColumn]);

    const existing = byExternalId.get(externalId);
    if (existing) {
      if (name && !existing.name) existing.name = name;
      for (const [index, field] of fieldColumns) {
        existing[field] = mergeValues(existing[field], normalizeCell(row[index]));
      }
      continue;
    }

    const record = { externalId, name: name ?? "" } as ParsedMonitoredObject;
    for (const field of Object.values(HEADERS)) record[field] = null;
    for (const [index, field] of fieldColumns) {
      record[field] = normalizeCell(row[index]);
    }
    byExternalId.set(externalId, record);
  }

  const objects = [...byExternalId.values()].map((obj) => ({
    ...obj,
    name: obj.name || `Obiekt ${obj.externalId}`,
  }));

  if (objects.length === 0) {
    throw new ObjectReportParseError(
      "Raport nie zawiera żadnych obiektów z poprawnym ID."
    );
  }

  return { fileName, objects };
}
