/**
 * METADANE ZDJĘCIA — odczyt EXIF-u w przeglądarce i wspólne formatery.
 *
 * Po co własny parser zamiast `exifr`:
 *   1. Panel technika kompresuje zdjęcia przez canvas (`technik/lib/image.ts`),
 *      a canvas KASUJE EXIF — więc dane trzeba wyjąć z oryginału PRZED
 *      zmniejszeniem, po stronie tabletu. Serwer dostaje już „gołego” JPEG-a.
 *   2. Wszystko, czego potrzebujemy (data, GPS, aparat, kilkanaście liczb),
 *      siedzi w jednym segmencie APP1 zwykłego JPEG-a. Aparat telefonu oddaje
 *      JPEG — HEIC panel odrzuca jeszcze przed wysyłką, bo nie przetworzy go
 *      ani przeglądarka, ani sharp na serwerze.
 *   3. `exifr` to ~30–50 kB gzip i NOWA pozycja w `frontend/package.json`
 *      + lockfile. Ten plik ma ~2 kB gzip, zero zależności i — co ważniejsze —
 *      da się go przetestować w `scripts/test-technik-front.ts` jako czyste
 *      funkcje (harness importuje frontend po ścieżkach względnych, bez `@/`).
 *
 * Dlatego NIC tutaj nie wolno importować z aliasu `@/` ani dotykać DOM-u poza
 * jedną funkcją `readPhotoMeta` (czyta `File`, ale bez canvasu i bez `window`).
 */

/* ------------------------------------------------------------------ *
 * Kontrakt z backendem
 * ------------------------------------------------------------------ */

/** Skąd wzięło się zdjęcie: przycisk „Aparat”, „Galeria”, wgranie w biurze. */
export type PhotoCapturedVia = "camera" | "gallery" | "upload";
/** Skąd wzięła się data wykonania. `file` = z `File.lastModified` (orientacyjna). */
export type PhotoTakenAtSource = "exif" | "file" | "none";

/** Wartości EXIF, które w ogóle przepuszczamy dalej (żadnych binariów). */
export type ExifValue = string | number | number[];

/**
 * Pole `photoMeta` multipartu — tablica wyrównana indeksami z kolejnością
 * plików `files`; element może być `null` (plik bez metadanych).
 */
export interface PhotoMetaInput {
  /** Czas LOKALNY z aparatu, bez strefy: „YYYY-MM-DDTHH:mm:ss”. */
  takenAt?: string;
  /** Strefa aparatu, jeśli ją podał: „+02:00”. */
  takenAtOffset?: string;
  takenAtSource: PhotoTakenAtSource;
  capturedVia: PhotoCapturedVia;
  gps?: { lat: number; lng: number; accuracyM?: number; altitudeM?: number };
  camera?: { make?: string; model?: string; lens?: string };
  /** Wymiary i waga ORYGINAŁU — tego sprzed kompresji w przeglądarce. */
  orig?: { width?: number; height?: number; size: number; mime: string; name: string };
  exif?: Record<string, ExifValue>;
}

/** Metadane załącznika w odpowiedziach API (kalendarz biura i panel technika). */
export interface AttachmentMeta {
  takenAt: string | null;
  takenAtOffset: string | null;
  takenAtSource: PhotoTakenAtSource;
  /** `msg` = zdjęcie wypakowane z maila; `null` = starszy wpis bez tej informacji. */
  capturedVia: PhotoCapturedVia | "msg" | null;
  gps: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
  camera: { make: string | null; model: string | null; lens: string | null } | null;
  orig: { width: number | null; height: number | null; size: number | null; mime: string | null } | null;
  extra: Record<string, ExifValue> | null;
}

/* ------------------------------------------------------------------ *
 * Parser EXIF-u (JPEG APP1 → TIFF)
 * ------------------------------------------------------------------ */

/** Ile bajtów początku pliku czytamy. EXIF stoi zaraz za nagłówkiem JPEG-a. */
const HEAD_BYTES = 512 * 1024;
/** Ile najwyżej może ważyć `exif` po serializacji (kontrakt: ≤ 8 KB). */
export const EXIF_MAX_BYTES = 8 * 1024;
/** Ile czekamy na odczyt JEDNEGO pliku, zanim odpuścimy (wysyłka > metadane). */
export const READ_TIMEOUT_MS = 1500;

/** Tagi IFD0 i ExifIFD, które w ogóle czytamy (reszta to szum albo binaria). */
const TIFF_TAGS: Record<number, string> = {
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "DateTime",
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8822: "ExposureProgram",
  0x8827: "ISO",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal",
  0x9204: "ExposureBiasValue",
  0x9207: "MeteringMode",
  0x9209: "Flash",
  0x920a: "FocalLength",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa402: "ExposureMode",
  0xa403: "WhiteBalance",
  0xa405: "FocalLengthIn35mmFilm",
  0xa406: "SceneCaptureType",
  0xa433: "LensMake",
  0xa434: "LensModel",
};

/** Tagi GPS IFD. */
const GPS_TAGS: Record<number, string> = {
  1: "GPSLatitudeRef",
  2: "GPSLatitude",
  3: "GPSLongitudeRef",
  4: "GPSLongitude",
  5: "GPSAltitudeRef",
  6: "GPSAltitude",
  16: "GPSImgDirectionRef",
  17: "GPSImgDirection",
  31: "GPSHPositioningError",
};

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;

/** Rozmiar wartości w bajtach wg typu TIFF (indeks = numer typu). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** Surowy odczyt: nazwane tagi + wymiary z ramki JPEG-a (SOFn). */
export interface ExifRaw {
  tags: Record<string, ExifValue>;
  gps: Record<string, ExifValue>;
  /** Wymiary z nagłówka ramki — jedyne pewne, gdy aparat nie podał PixelXDimension. */
  frame: { width: number; height: number } | null;
}

/**
 * EXIF z bufora JPEG-a. `null`, gdy to nie JPEG albo nie ma w nim APP1/Exif.
 * NIGDY nie rzuca — uszkodzony plik ma pojechać bez metadanych, a nie wysadzić
 * wysyłkę notatki.
 */
export function parseJpegExif(buffer: ArrayBuffer): ExifRaw | null {
  try {
    return parseJpegExifUnsafe(buffer);
  } catch {
    return null;
  }
}

function parseJpegExifUnsafe(buffer: ArrayBuffer): ExifRaw | null {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // SOI

  let offset = 2;
  let exifStart = -1;
  let frame: { width: number; height: number } | null = null;

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset++; // wypełniacz między segmentami
      continue;
    }
    const marker = view.getUint8(offset + 1);
    // Markery bez długości (RSTn, SOI, EOI, TEM).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / początek danych obrazu
    const length = view.getUint16(offset + 2);
    if (length < 2) break;
    const body = offset + 4;
    // APP1 z sygnaturą „Exif\0\0”.
    if (marker === 0xe1 && exifStart < 0 && body + 6 <= view.byteLength) {
      if (
        view.getUint32(body) === 0x45786966 && // „Exif”
        view.getUint16(body + 4) === 0x0000
      ) {
        exifStart = body + 6;
      }
    }
    // SOFn — wymiary ramki. 0xC4/0xC8/0xCC to tablice Huffmana, nie ramki.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      !frame &&
      body + 5 <= view.byteLength
    ) {
      frame = { width: view.getUint16(body + 3), height: view.getUint16(body + 1) };
    }
    offset += 2 + length;
  }

  if (exifStart < 0) return frame ? { tags: {}, gps: {}, frame } : null;
  const tiff = readTiff(view, exifStart);
  return { tags: tiff.tags, gps: tiff.gps, frame };
}

function readTiff(view: DataView, start: number): { tags: Record<string, ExifValue>; gps: Record<string, ExifValue> } {
  const tags: Record<string, ExifValue> = {};
  const gps: Record<string, ExifValue> = {};
  if (start + 8 > view.byteLength) return { tags, gps };
  const byteOrder = view.getUint16(start);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return { tags, gps };
  const le = byteOrder === 0x4949;
  if (view.getUint16(start + 2, le) !== 42) return { tags, gps };
  const ifd0 = view.getUint32(start + 4, le);

  // IFD0 → (ExifIFD, GPS IFD). IFD1 (miniatura) świadomie pomijamy.
  const pointers = readIfd(view, start, start + ifd0, le, TIFF_TAGS, tags);
  const exifPtr = pointers[EXIF_IFD_POINTER];
  if (exifPtr != null) readIfd(view, start, start + exifPtr, le, TIFF_TAGS, tags);
  const gpsPtr = pointers[GPS_IFD_POINTER];
  if (gpsPtr != null) readIfd(view, start, start + gpsPtr, le, GPS_TAGS, gps);
  return { tags, gps };
}

/**
 * Jedno IFD. Zwraca wskaźniki na pod-IFD (`0x8769`, `0x8825`), a nazwane
 * wartości dokłada do `out`. Cudze tagi (MakerNote, miniatury) nie są nawet
 * czytane — nie ma ich w tablicach nazw.
 */
function readIfd(
  view: DataView,
  tiffStart: number,
  ifdStart: number,
  le: boolean,
  names: Record<number, string>,
  out: Record<string, ExifValue>,
): Record<number, number> {
  const pointers: Record<number, number> = {};
  if (ifdStart + 2 > view.byteLength) return pointers;
  const count = view.getUint16(ifdStart, le);
  // 12 bajtów na wpis; sanity check chroni przed pętlą na uszkodzonym pliku.
  if (count > 512 || ifdStart + 2 + count * 12 > view.byteLength) return pointers;
  for (let i = 0; i < count; i++) {
    const entry = ifdStart + 2 + i * 12;
    const tag = view.getUint16(entry, le);
    if (tag === EXIF_IFD_POINTER || tag === GPS_IFD_POINTER) {
      pointers[tag] = view.getUint32(entry + 8, le);
      continue;
    }
    const name = names[tag];
    if (!name) continue;
    const value = readValue(view, tiffStart, entry, le);
    if (value != null) out[name] = value;
  }
  return pointers;
}

function readValue(view: DataView, tiffStart: number, entry: number, le: boolean): ExifValue | null {
  const type = view.getUint16(entry + 2, le);
  const count = view.getUint32(entry + 4, le);
  const size = TYPE_SIZE[type];
  if (!size || count === 0 || count > 4096) return null;
  const bytes = size * count;
  const at = bytes <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, le);
  if (at < 0 || at + bytes > view.byteLength) return null;

  // ASCII — tekst do pierwszego NUL-a.
  if (type === 2) {
    let s = "";
    for (let i = 0; i < count; i++) {
      const c = view.getUint8(at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    s = s.trim();
    return s || null;
  }
  const nums: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = at + i * size;
    switch (type) {
      case 1:
      case 7:
        nums.push(view.getUint8(p));
        break;
      case 3:
        nums.push(view.getUint16(p, le));
        break;
      case 4:
        nums.push(view.getUint32(p, le));
        break;
      case 9:
        nums.push(view.getInt32(p, le));
        break;
      case 5: {
        const den = view.getUint32(p + 4, le);
        nums.push(den === 0 ? 0 : view.getUint32(p, le) / den);
        break;
      }
      case 10: {
        const den = view.getInt32(p + 4, le);
        nums.push(den === 0 ? 0 : view.getInt32(p, le) / den);
        break;
      }
      case 11:
        nums.push(view.getFloat32(p, le));
        break;
      case 12:
        nums.push(view.getFloat64(p, le));
        break;
      default:
        return null;
    }
  }
  if (nums.some((n) => !Number.isFinite(n))) return null;
  // UNDEFINED o wielu bajtach (np. wersje) zwracamy tylko, gdy jest krótkie.
  if (type === 7 && nums.length > 8) return null;
  return nums.length === 1 ? nums[0] : nums;
}

/* ------------------------------------------------------------------ *
 * EXIF → PhotoMetaInput
 * ------------------------------------------------------------------ */

/** Stopnie-minuty-sekundy + półkula („N”/„S”/„E”/„W”) → stopnie dziesiętne. */
export function dmsToDecimal(dms: ExifValue | undefined, ref: ExifValue | undefined): number | null {
  const parts = Array.isArray(dms) ? dms : typeof dms === "number" ? [dms] : null;
  if (!parts || parts.length === 0) return null;
  const [d = 0, m = 0, s = 0] = parts;
  if (![d, m, s].every((n) => Number.isFinite(n))) return null;
  const value = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
  if (!Number.isFinite(value)) return null;
  const hemisphere = typeof ref === "string" ? ref.trim().toUpperCase()[0] : "";
  const negative = hemisphere === "S" || hemisphere === "W";
  // Sześć miejsc po przecinku to ~10 cm — dalej to już szum odbiornika.
  return round(negative ? -value : value, 6);
}

/** „2026:09:17 14:20:05” (format EXIF-u) → „2026-09-17T14:20:05”. */
export function exifDateToLocalIso(raw: ExifValue | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // Aparat bez ustawionej daty oddaje „0000:00:00 00:00:00” — to nie jest data.
  if (y === "0000" || mo === "00" || d === "00") return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}`;
}

/** „+02:00” z tagu OffsetTimeOriginal; `null` dla śmieci. */
export function normalizeOffset(raw: ExifValue | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}${m[2]}:${m[3]}` : null;
}

const WARSAW = "Europe/Warsaw";

/**
 * Znacznik `File.lastModified` → czas ŚCIENNY w Warszawie + przesunięcie strefy.
 *
 * Świadomie nie `new Date(ms)` + gettery: tablet potrafi stać na innej strefie
 * (albo test na UTC), a data w notatce ma być ta, którą widzi biuro w Polsce.
 * Zimą wychodzi „+01:00”, latem „+02:00” — i właśnie to sprawdza test.
 */
export function epochToWarsaw(ms: number): { takenAt: string; takenAtOffset: string } | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  try {
    // „sv-SE” daje z natury „YYYY-MM-DD HH:MM:SS” — bez składania z części.
    const takenAt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: WARSAW,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .format(date)
      .replace(" ", "T");
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: WARSAW, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = zone ? /GMT([+-]\d{2}:\d{2})/.exec(zone) : null;
    return { takenAt, takenAtOffset: m ? m[1] : "+00:00" };
  } catch {
    return null;
  }
}

/** Klucze `extra` w kolejności WAŻNOŚCI — przy przycinaniu do 8 KB spadają od końca. */
const EXTRA_ORDER = [
  "ISO",
  "FNumber",
  "ExposureTime",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "Flash",
  "Orientation",
  "Software",
  "GPSImgDirection",
  "GPSImgDirectionRef",
  "ExposureBiasValue",
  "ExposureProgram",
  "ExposureMode",
  "MeteringMode",
  "WhiteBalance",
  "SceneCaptureType",
  "DateTimeDigitized",
  "DateTime",
];

/**
 * Zestaw `exif` (u serwera: `extra`) — tylko pola z `EXTRA_ORDER`, przycięte
 * do `EXIF_MAX_BYTES`. Nadmiarowe klucze lecą OD KOŃCA listy, więc ISO
 * i przysłona zostają nawet przy dziwnym aparacie sypiącym długimi napisami.
 */
export function pickExtra(
  tags: Record<string, ExifValue>,
  gps: Record<string, ExifValue> = {},
  limit = EXIF_MAX_BYTES,
): Record<string, ExifValue> | undefined {
  const source: Record<string, ExifValue> = { ...tags, ...gps };
  const out: Record<string, ExifValue> = {};
  for (const key of EXTRA_ORDER) {
    const v = source[key];
    if (v == null) continue;
    if (typeof v === "string" && v.length > 120) continue;
    if (Array.isArray(v) && v.length > 8) continue;
    out[key] = Array.isArray(v) ? v.map((n) => round(n, 6)) : typeof v === "number" ? round(v, 6) : v;
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return undefined;
  // Przycinanie: od najmniej istotnego klucza, aż JSON zmieści się w limicie.
  for (let i = keys.length; i > 0; i--) {
    const slice: Record<string, ExifValue> = {};
    for (const key of keys.slice(0, i)) slice[key] = out[key];
    if (byteLength(JSON.stringify(slice)) <= limit) return slice;
  }
  return undefined;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Plik bez `File` — żeby dało się testować bez DOM-u. */
export interface PhotoFileFacts {
  name: string;
  type: string;
  size: number;
  lastModified: number;
}

/**
 * EXIF + fakty o pliku → gotowy element `photoMeta`.
 *
 * Kolejność źródeł daty: DateTimeOriginal → DateTime (skan/aparat bez „Original”)
 * → `File.lastModified` (`takenAtSource: "file"`, czyli „orientacyjnie”).
 */
export function exifToPhotoMeta(
  raw: ExifRaw | null,
  file: PhotoFileFacts,
  capturedVia: PhotoCapturedVia,
): PhotoMetaInput {
  const tags = raw?.tags ?? {};
  const gpsTags = raw?.gps ?? {};
  const meta: PhotoMetaInput = { takenAtSource: "none", capturedVia };

  const exifDate = exifDateToLocalIso(tags.DateTimeOriginal) ?? exifDateToLocalIso(tags.DateTime);
  if (exifDate) {
    meta.takenAt = exifDate;
    meta.takenAtSource = "exif";
    const offset = normalizeOffset(tags.OffsetTimeOriginal) ?? normalizeOffset(tags.OffsetTime);
    if (offset) meta.takenAtOffset = offset;
  } else {
    const fallback = epochToWarsaw(file.lastModified);
    if (fallback) {
      meta.takenAt = fallback.takenAt;
      meta.takenAtOffset = fallback.takenAtOffset;
      meta.takenAtSource = "file";
    }
  }

  const lat = dmsToDecimal(gpsTags.GPSLatitude, gpsTags.GPSLatitudeRef);
  const lng = dmsToDecimal(gpsTags.GPSLongitude, gpsTags.GPSLongitudeRef);
  // (0, 0) na Atlantyku to w praktyce „odbiornik nie złapał” — nie pinezka.
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
    meta.gps = { lat, lng };
    const accuracy = numberOf(gpsTags.GPSHPositioningError);
    if (accuracy != null && accuracy > 0) meta.gps.accuracyM = round(accuracy, 1);
    const altitude = numberOf(gpsTags.GPSAltitude);
    if (altitude != null) {
      // GPSAltitudeRef = 1 znaczy „poniżej poziomu morza”.
      meta.gps.altitudeM = round(numberOf(gpsTags.GPSAltitudeRef) === 1 ? -altitude : altitude, 1);
    }
  }

  const make = stringOf(tags.Make);
  const model = stringOf(tags.Model);
  const lens = stringOf(tags.LensModel);
  if (make || model || lens) {
    meta.camera = {};
    if (make) meta.camera.make = make;
    if (model) meta.camera.model = model;
    if (lens) meta.camera.lens = lens;
  }

  const width = numberOf(tags.PixelXDimension) ?? raw?.frame?.width;
  const height = numberOf(tags.PixelYDimension) ?? raw?.frame?.height;
  meta.orig = {
    size: file.size,
    mime: file.type || guessMime(file.name),
    name: file.name,
  };
  // Obrót z EXIF-u (6/8 = pion) zamienia boki — pokazujemy to, co technik widzi.
  const rotated = numberOf(tags.Orientation) === 6 || numberOf(tags.Orientation) === 8;
  if (width && height) {
    meta.orig.width = rotated ? height : width;
    meta.orig.height = rotated ? width : height;
  }

  const extra = pickExtra(tags, gpsTags);
  if (extra) meta.exif = extra;
  return meta;
}

function stringOf(v: ExifValue | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\0/g, "").trim();
  return s ? s.slice(0, 120) : undefined;
}

function numberOf(v: ExifValue | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && Number.isFinite(v[0])) return v[0];
  return null;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function guessMime(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!ext) return "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "";
}

/* ------------------------------------------------------------------ *
 * Odczyt z pliku (jedyne miejsce dotykające `File`)
 * ------------------------------------------------------------------ */

/**
 * Metadane jednego pliku. NIGDY nie rzuca i nigdy nie wisi dłużej niż
 * `READ_TIMEOUT_MS` — metadane są dodatkiem, a notatka musi wyjść.
 *
 * Czytamy tylko pierwsze 512 kB: EXIF siedzi w drugim segmencie JPEG-a,
 * a wciąganie 8-megabajtowego zdjęcia do pamięci tabletu po to, żeby przeczytać
 * z niego dwa kilobajty, byłoby marnotrawstwem przy serii z galerii.
 */
export async function readPhotoMeta(file: File, capturedVia: PhotoCapturedVia): Promise<PhotoMetaInput> {
  const facts: PhotoFileFacts = {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
  try {
    const raw = await withTimeout(readHead(file), READ_TIMEOUT_MS);
    return exifToPhotoMeta(raw, facts, capturedVia);
  } catch {
    // HEIC, plik bez prawa odczytu, timeout — zostaje sama data pliku.
    return exifToPhotoMeta(null, facts, capturedVia);
  }
}

async function readHead(file: File): Promise<ExifRaw | null> {
  const blob = file.size > HEAD_BYTES ? file.slice(0, HEAD_BYTES) : file;
  return parseJpegExif(await blob.arrayBuffer());
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Formatery pod panel „i”
 * ------------------------------------------------------------------ */

/** „1/125 s”, „2 s” — czas otwarcia migawki po ludzku, a nie „0.008”. */
export function formatExposureTime(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1) return `${plNumber(round(v, 1))} s`;
  return `1/${Math.round(1 / v)} s`;
}

/** „f/1,8” — przysłona. */
export function formatAperture(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  return `f/${plNumber(round(v, 1))}`;
}

/** Liczba po polsku: przecinek dziesiętny, bez zbędnego „,0”. */
export function plNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  return String(n).replace(".", ",");
}

/** „17.09.2026, 14:20” z lokalnego ISO — bez `Date`, żeby nie wciągać strefy. */
export function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt || takenAt.length < 16) return "";
  const [day, time] = takenAt.split("T");
  const [y, m, d] = day.split("-");
  if (!y || !m || !d) return "";
  return `${d}.${m}.${y}, ${time.slice(0, 5)}`;
}

/**
 * Moment wykonania jako epoka — do porównania z datą dodania notatki.
 * Ze strefą, gdy aparat ją podał; bez niej `Date` czyta znacznik jako lokalny,
 * czyli dokładnie tak, jak go widzi patrzący na ekran.
 */
export function takenAtEpoch(meta: { takenAt: string | null; takenAtOffset?: string | null }): number | null {
  if (!meta.takenAt) return null;
  const t = Date.parse(meta.takenAtOffset ? `${meta.takenAt}${meta.takenAtOffset}` : meta.takenAt);
  return Number.isNaN(t) ? null : t;
}

/** Odległość w linii prostej (metry) — wzór haversine, promień 6371 km. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** „120 m” / „1,2 km” — dystans w jednostce, w której się o nim mówi. */
export function formatMeters(m: number): string {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${plNumber(round(m / 1000, 1))} km`;
}

/** Współrzędne skrócone do czterech miejsc (~11 m) z półkulami. */
export function formatCoords(lat: number, lng: number): string {
  const one = (v: number, pos: string, neg: string) =>
    `${plNumber(round(Math.abs(v), 4))}° ${v < 0 ? neg : pos}`;
  return `${one(lat, "N", "S")}, ${one(lng, "E", "W")}`;
}

/** Link do Map Google dla pinezki zdjęcia (kropka dziesiętna — tego chce Google). */
export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${round(lat, 6)},${round(lng, 6)}`;
}

/** „2,4 MB” — waga oryginału. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${plNumber(round(size / 1024, 0))} kB`;
  return `${plNumber(round(size / (1024 * 1024), 1))} MB`;
}

/** Format pliku po ludzku: „JPEG”, „PNG”, „WebP”. */
export function formatMime(mime: string | null | undefined): string {
  if (!mime) return "";
  const sub = mime.split("/")[1]?.toUpperCase() ?? "";
  if (sub === "JPEG" || sub === "JPG") return "JPEG";
  if (sub === "WEBP") return "WebP";
  return sub;
}

/** Skąd wzięło się zdjęcie — etykieta sekcji „Źródło”. */
export function capturedViaLabel(via: AttachmentMeta["capturedVia"]): string {
  switch (via) {
    case "camera":
      return "Aparat";
    case "gallery":
      return "Galeria";
    case "upload":
      return "Wgrany plik";
    case "msg":
      return "Z maila";
    default:
      return "";
  }
}

/** Dopisek przy dacie: czy to data z EXIF-u, czy tylko data pliku. */
export function takenAtSourceNote(source: PhotoTakenAtSource): string {
  if (source === "exif") return "z danych zdjęcia";
  if (source === "file") return "z daty pliku — orientacyjnie";
  return "";
}

/** Czytelne nazwy pól `extra` — po polsku, bez żargonu EXIF-u. */
export const EXTRA_LABELS: Record<string, string> = {
  ISO: "Czułość ISO",
  FNumber: "Przysłona",
  ExposureTime: "Czas naświetlania",
  FocalLength: "Ogniskowa",
  FocalLengthIn35mmFilm: "Ogniskowa (ekw. 35 mm)",
  Flash: "Lampa",
  Orientation: "Orientacja",
  Software: "Oprogramowanie",
  GPSImgDirection: "Kierunek obiektywu",
  GPSImgDirectionRef: "Odniesienie kierunku",
  ExposureBiasValue: "Korekta ekspozycji",
  ExposureProgram: "Program",
  ExposureMode: "Tryb ekspozycji",
  MeteringMode: "Pomiar światła",
  WhiteBalance: "Balans bieli",
  SceneCaptureType: "Rodzaj sceny",
  DateTimeDigitized: "Zapisano",
  DateTime: "Zmodyfikowano",
};

const FLASH_FIRED = "Błysk";
const FLASH_OFF = "Bez błysku";
const ORIENTATIONS: Record<number, string> = {
  1: "poziomo",
  3: "obrócone o 180°",
  6: "obrócone w prawo",
  8: "obrócone w lewo",
};
const WHITE_BALANCE: Record<number, string> = { 0: "automatyczny", 1: "ręczny" };
const EXPOSURE_PROGRAMS: Record<number, string> = {
  1: "ręczny",
  2: "automatyczny",
  3: "priorytet przysłony",
  4: "priorytet migawki",
  5: "kreatywny",
  6: "sportowy",
  7: "portret",
  8: "krajobraz",
};
const METERING: Record<number, string> = {
  1: "średni",
  2: "centralny ważony",
  3: "punktowy",
  4: "wielopunktowy",
  5: "matrycowy",
  6: "częściowy",
};
const SCENES: Record<number, string> = { 0: "standardowa", 1: "krajobraz", 2: "portret", 3: "noc" };

/** Wartość pola `extra` w formie, w jakiej ma stanąć w panelu. */
export function formatExtraValue(key: string, value: ExifValue): string {
  if (Array.isArray(value)) return value.map((n) => plNumber(round(n, 3))).join(" · ");
  if (typeof value === "string") {
    if (key === "DateTime" || key === "DateTimeDigitized") {
      return formatTakenAt(exifDateToLocalIso(value)) || value;
    }
    return value;
  }
  switch (key) {
    case "ExposureTime":
      return formatExposureTime(value);
    case "FNumber":
      return formatAperture(value);
    case "FocalLength":
    case "FocalLengthIn35mmFilm":
      return `${plNumber(round(value, 1))} mm`;
    case "GPSImgDirection":
      return `${plNumber(round(value, 0))}°`;
    case "ExposureBiasValue":
      return `${value > 0 ? "+" : ""}${plNumber(round(value, 1))} EV`;
    // Bit 0 tagu Flash mówi, czy lampa w ogóle błysnęła — reszta to szczegóły
    // trybu, których i tak nikt nie czyta z notatki serwisowej.
    case "Flash":
      return (value & 1) === 1 ? FLASH_FIRED : FLASH_OFF;
    case "Orientation":
      return ORIENTATIONS[value] ?? String(value);
    case "WhiteBalance":
      return WHITE_BALANCE[value] ?? String(value);
    case "ExposureProgram":
      return EXPOSURE_PROGRAMS[value] ?? String(value);
    case "MeteringMode":
      return METERING[value] ?? String(value);
    case "SceneCaptureType":
      return SCENES[value] ?? String(value);
    case "ISO":
      return String(Math.round(value));
    default:
      return plNumber(round(value, 3));
  }
}

/**
 * `PhotoMetaInput` → `AttachmentMeta`, czyli to, co serwer odeśle po zapisie.
 *
 * Potrzebne tylko po to, żeby panel „i” działał JUŻ przy wybranym zdjęciu,
 * zanim notatka pojedzie — technik widzi wtedy dokładnie te dane, które za
 * chwilę zobaczy biuro, i może zdjęcie odrzucić, gdy aparat nie złapał GPS-u.
 */
export function toAttachmentMeta(input: PhotoMetaInput): AttachmentMeta {
  return {
    takenAt: input.takenAt ?? null,
    takenAtOffset: input.takenAtOffset ?? null,
    takenAtSource: input.takenAtSource,
    capturedVia: input.capturedVia,
    gps: input.gps
      ? {
          lat: input.gps.lat,
          lng: input.gps.lng,
          accuracyM: input.gps.accuracyM ?? null,
          altitudeM: input.gps.altitudeM ?? null,
        }
      : null,
    camera: input.camera
      ? {
          make: input.camera.make ?? null,
          model: input.camera.model ?? null,
          lens: input.camera.lens ?? null,
        }
      : null,
    orig: input.orig
      ? {
          width: input.orig.width ?? null,
          height: input.orig.height ?? null,
          size: input.orig.size,
          mime: input.orig.mime || null,
        }
      : null,
    extra: input.exif ?? null,
  };
}

/** Aparat jednym napisem: „Apple iPhone 13” (bez powtórzonej marki w modelu). */
export function cameraLabel(camera: AttachmentMeta["camera"]): string {
  if (!camera) return "";
  const make = (camera.make ?? "").trim();
  const model = (camera.model ?? "").trim();
  if (!make) return model;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}
