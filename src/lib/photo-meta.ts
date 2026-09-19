/**
 * Metadane zdjęć przy załącznikach notatek — odczyt EXIF-u, walidacja tego, co
 * przyśle front, scalanie obu źródeł i serializacja do API.
 *
 * DLACZEGO TO ISTNIEJE. Zdjęcie z serwisu ma odpowiadać na pytanie „kiedy i gdzie”,
 * a ta wiedza ginęła dwa razy:
 *  1. na telefonie — panel technika zmniejsza zdjęcie przez canvas PRZED wysyłką,
 *     a canvas nie przepisuje EXIF-u (zostaje sam obraz);
 *  2. na serwerze — `storeUploads` (src/lib/calendar-attachments.ts) przepuszcza
 *     każdy obrazek przez sharp `.rotate().webp()`, co świadomie zrzuca EXIF
 *     z pliku lądującego na dysku. TAK MA ZOSTAĆ: plik jest serwowany
 *     przeglądarce, a razem z EXIF-em wyciekałyby współrzędne i numery seryjne.
 *
 * Stąd DWA źródła, oba potrzebne:
 *  - SERWER czyta EXIF z SUROWEGO bufora, zanim cokolwiek skonwertuje. Działa dla
 *    uploadu z biura, małych plików z telefonu i załączników wypakowanych z `.msg`.
 *  - KLIENT dosyła metadane osobnym polem multipartu `photoMeta` (JSON, tablica
 *    wyrównana indeksami z `files`) — jedyne wyjście, gdy zdjęcie przeszło przez canvas.
 *
 * Przy scalaniu SERWER MA PIERWSZEŃSTWO pole po polu (widział oryginał, klienta
 * da się oszukać) — z jednym wyjątkiem: `orig.*`, czyli wymiary/rozmiar oryginału.
 * Tu wygrywa klient, bo serwer widzi już plik PO zmniejszeniu canvasem.
 *
 * Kolumny: `calendar_note_attachments.taken_at…meta_json` (migracja 0113).
 * Kształt w API: `attachmentMetaJson` — ten sam obiekt `meta` w kalendarzu biurowym
 * i w panelu technika.
 */
import exifReader from "exif-reader";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Typy i enumy (SQLite trzyma zwykły TEXT — pilnujemy tego tutaj)
// ---------------------------------------------------------------------------

/** Skąd wzięła się data zdjęcia. „file” = klient wziął ją z daty modyfikacji pliku. */
export const PHOTO_TAKEN_AT_SOURCES = ["exif", "file", "none"] as const;
export type PhotoTakenAtSource = (typeof PHOTO_TAKEN_AT_SOURCES)[number];

/** Jak plik trafił do notatki. „msg” ustawia serwer dla załączników z maila. */
export const PHOTO_CAPTURED_VIA = ["camera", "gallery", "upload", "msg"] as const;
export type PhotoCapturedVia = (typeof PHOTO_CAPTURED_VIA)[number];

/** Klient może zadeklarować tylko to, co sam widzi — „msg” jest wyłącznie serwerowe. */
const CLIENT_CAPTURED_VIA = ["camera", "gallery", "upload"] as const;

/** Wartości, które wolno trzymać w `meta_json` (żadnych binariów). */
export type PhotoExtra = Record<string, string | number | number[]>;

/** Kolumny metadanych w `calendar_note_attachments` (migracja 0113). */
export interface PhotoMetaColumns {
  takenAt: string | null;
  takenAtOffset: string | null;
  takenAtSource: PhotoTakenAtSource | null;
  capturedVia: PhotoCapturedVia | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracyM: number | null;
  gpsAltitudeM: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  cameraLens: string | null;
  origWidth: number | null;
  origHeight: number | null;
  origSize: number | null;
  origMime: string | null;
  metaJson: string | null;
}

/**
 * Wiersz załącznika w części, która nas tu interesuje (reszta kolumn nieistotna).
 * `taken_at_source` i `captured_via` są w SQLite zwykłym TEXT-em — wiersz z bazy
 * ma tam `string`, a nie enum; zawężamy dopiero przy serializacji.
 */
export type PhotoMetaRow = Omit<{ [K in keyof PhotoMetaColumns]?: PhotoMetaColumns[K] | null }, "takenAtSource" | "capturedVia"> & {
  takenAtSource?: string | null;
  capturedVia?: string | null;
};

/** Metadane odczytane przez SERWER z surowego bufora (przed konwersją do WebP). */
export interface ServerPhotoMeta {
  /** `false` = obrazek bez czytelnego EXIF-u; zostaje sam opis oryginału. */
  hasExif: boolean;
  takenAt: string | null;
  takenAtOffset: string | null;
  gps: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
  camera: { make: string | null; model: string | null; lens: string | null } | null;
  /** To, co serwer DOSTAŁ — dla zdjęcia po canvasie jest to już wersja zmniejszona. */
  orig: { width: number | null; height: number | null; size: number | null; mime: string | null };
  extra: PhotoExtra | null;
}

/** Metadane z pola `photoMeta` PO walidacji — każde pole niezależnie (złe = null). */
export interface ClientPhotoMeta {
  takenAt: string | null;
  takenAtOffset: string | null;
  takenAtSource: PhotoTakenAtSource | null;
  capturedVia: PhotoCapturedVia | null;
  gps: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
  camera: { make: string | null; model: string | null; lens: string | null } | null;
  orig: { width: number | null; height: number | null; size: number | null; mime: string | null } | null;
  extra: PhotoExtra | null;
}

/** Kształt `meta` w odpowiedziach API (kalendarz biurowy I panel technika). */
export interface AttachmentMetaJson {
  takenAt: string | null;
  takenAtOffset: string | null;
  takenAtSource: PhotoTakenAtSource;
  capturedVia: PhotoCapturedVia | null;
  gps: { lat: number; lng: number; accuracyM: number | null; altitudeM: number | null } | null;
  camera: { make: string | null; model: string | null; lens: string | null } | null;
  orig: { width: number | null; height: number | null; size: number | null; mime: string | null } | null;
  extra: PhotoExtra | null;
}

/** Sufit `meta_json` — EXIF potrafi mieć kilkaset kilobajtów, a to leci do KAŻDEJ odpowiedzi z notatkami. */
export const PHOTO_META_JSON_MAX_BYTES = 8 * 1024;
/** Sufit pojedynczego stringa (nazwa obiektywu bywa długa, ale nie AŻ tak). */
const STRING_MAX = 120;

// ---------------------------------------------------------------------------
// Walidacja pojedynczych pól (zod) — używana i dla klienta, i dla EXIF-u
// ---------------------------------------------------------------------------

/** Data z aparatu: LOKALNA, bez strefy. Format pilnuje regex, sens — zakres poniżej. */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/** Zegar aparatu bywa przestawiony, ale nie o lata — wszystko poza zakresem to śmieć. */
const TAKEN_AT_MIN_MS = Date.UTC(2000, 0, 1);
const TAKEN_AT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const takenAtSchema = z
  .string()
  .regex(LOCAL_DATETIME)
  .refine((s) => {
    // Porównujemy jako czas LOKALNY serwera — przy 24 h zapasu strefa nie ma znaczenia.
    const t = new Date(s).getTime();
    return Number.isFinite(t) && t >= TAKEN_AT_MIN_MS && t <= Date.now() + TAKEN_AT_FUTURE_SLACK_MS;
  });

/** Przesunięcie strefowe „+02:00” / „-05:30” (UTC±14:00 to realny zakres stref). */
const offsetSchema = z
  .string()
  .regex(/^[+-]\d{2}:\d{2}$/)
  .refine((s) => Number(s.slice(1, 3)) <= 14 && Number(s.slice(4, 6)) < 60);

const latSchema = z.number().finite().min(-90).max(90);
const lngSchema = z.number().finite().min(-180).max(180);
const accuracySchema = z.number().finite().min(0).max(1_000_000);
const altitudeSchema = z.number().finite().min(-12_000).max(100_000);
const dimensionSchema = z.number().int().positive().max(1_000_000);
const byteSizeSchema = z.number().int().positive().max(10_000_000_000);
const shortTextSchema = z
  .string()
  .transform((s) => s.replace(/[\x00-\x1f]/g, " ").trim().slice(0, STRING_MAX))
  .refine((s) => s.length > 0);

/** Wartość przechodzi walidację → zwróć ją, inaczej null. Nigdy nie rzuca. */
function pick<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/**
 * Współrzędne (0, 0) to „Null Island” — tyle warte, co brak pozycji. Telefony
 * i przeglądarki wysyłają tam zera, gdy fix się nie udał.
 */
function gpsOf(rawLat: unknown, rawLng: unknown, rawAcc: unknown, rawAlt: unknown) {
  const lat = pick(latSchema, rawLat);
  const lng = pick(lngSchema, rawLng);
  if (lat === null || lng === null) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng, accuracyM: pick(accuracySchema, rawAcc), altitudeM: pick(altitudeSchema, rawAlt) };
}

/** `{make, model, lens}` albo null, gdy nic sensownego nie zostało. */
function cameraOf(make: unknown, model: unknown, lens: unknown) {
  const c = { make: pick(shortTextSchema, make), model: pick(shortTextSchema, model), lens: pick(shortTextSchema, lens) };
  return c.make || c.model || c.lens ? c : null;
}

/**
 * Filtr `extra`: tylko prymitywy (string / skończona liczba / tablica liczb) i sufit
 * 8 KB na całość. Klucze dokładamy po kolei i przerywamy, gdy JSON przestaje się
 * mieścić — przycięty zestaw jest lepszy niż brak albo 300 KB w każdej odpowiedzi.
 */
export function sanitizeExtra(raw: unknown): PhotoExtra | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: PhotoExtra = {};
  let used = 2; // "{}"
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    let clean: string | number | number[] | null = null;
    if (typeof value === "string") {
      const s = value.replace(/[\x00-\x1f]/g, " ").trim().slice(0, STRING_MAX);
      if (s) clean = s;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      // Ułamki z EXIF-u (1/250 s) są długie w zapisie — 6 miejsc wystarczy.
      clean = Number.isInteger(value) ? value : Number(value.toFixed(6));
    } else if (Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every((v) => typeof v === "number" && Number.isFinite(v))) {
      clean = (value as number[]).map((v) => (Number.isInteger(v) ? v : Number(v.toFixed(6))));
    }
    if (clean === null) continue;
    const cost = JSON.stringify(key).length + 1 + JSON.stringify(clean).length + 1;
    if (used + cost > PHOTO_META_JSON_MAX_BYTES) continue;
    used += cost;
    out[key] = clean;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Pole `photoMeta` z multipartu
// ---------------------------------------------------------------------------

/**
 * Parsuje pole `photoMeta` (JSON: tablica wyrównana indeksami z `files`, element
 * może być `null`). Brak pola, zły JSON, nie-tablica albo zła długość → `null`,
 * czyli „ignorujemy metadane klienta”. NIGDY nie rzuca: stary front nie wysyła
 * tego pola w ogóle, a upload ma przechodzić tak samo jak dotąd.
 *
 * Wewnątrz elementu walidacja idzie POLE PO POLU — jedna bzdurna współrzędna nie
 * kasuje poprawnej daty obok.
 */
export function parseClientPhotoMeta(raw: unknown, expectedLength: number): Array<ClientPhotoMeta | null> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Sufit na wszelki wypadek: 15 plików × 8 KB metadanych + zapas.
  if (raw.length > 256 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) return null;
  return parsed.map((item) => clientMetaOf(item));
}

function clientMetaOf(item: unknown): ClientPhotoMeta | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const gpsRaw = (o.gps ?? {}) as Record<string, unknown>;
  const camRaw = (o.camera ?? {}) as Record<string, unknown>;
  const origRaw = (o.orig ?? {}) as Record<string, unknown>;
  const orig = {
    width: pick(dimensionSchema, origRaw.width),
    height: pick(dimensionSchema, origRaw.height),
    size: pick(byteSizeSchema, origRaw.size),
    mime: pick(shortTextSchema, origRaw.mime),
  };
  const meta: ClientPhotoMeta = {
    takenAt: pick(takenAtSchema, o.takenAt),
    takenAtOffset: pick(offsetSchema, o.takenAtOffset),
    takenAtSource: pick(z.enum(PHOTO_TAKEN_AT_SOURCES), o.takenAtSource),
    capturedVia: pick(z.enum(CLIENT_CAPTURED_VIA), o.capturedVia),
    gps: gpsOf(gpsRaw.lat, gpsRaw.lng, gpsRaw.accuracyM, gpsRaw.altitudeM),
    camera: cameraOf(camRaw.make, camRaw.model, camRaw.lens),
    // `orig.name` świadomie pomijamy — nazwę pliku trzyma już kolumna `file_name`.
    orig: orig.width || orig.height || orig.size || orig.mime ? orig : null,
    extra: sanitizeExtra(o.exif),
  };
  // Element bez ani jednego sensownego pola jest tym samym, co `null`.
  return hasAnyClientField(meta) ? meta : null;
}

function hasAnyClientField(m: ClientPhotoMeta): boolean {
  return !!(m.takenAt || m.takenAtOffset || m.gps || m.camera || m.orig || m.extra || m.capturedVia || m.takenAtSource);
}

// ---------------------------------------------------------------------------
// Odczyt EXIF-u z surowego bufora (serwer)
// ---------------------------------------------------------------------------

/**
 * Pola EXIF, które trafiają do `meta_json`. Biała lista, nie czarna: EXIF potrafi
 * nieść MakerNote producenta, miniaturę, UserComment i inne binaria — nic z tego
 * nie ma czego szukać w bazie ani w odpowiedzi API.
 */
const EXTRA_IMAGE_TAGS = ["Orientation", "Software", "XResolution", "YResolution", "ResolutionUnit"] as const;
const EXTRA_PHOTO_TAGS = [
  "ISOSpeedRatings", "PhotographicSensitivity", "FNumber", "ExposureTime", "ExposureProgram", "ExposureMode",
  "ExposureBiasValue", "FocalLength", "FocalLengthIn35mmFilm", "Flash", "MeteringMode", "WhiteBalance",
  "LightSource", "SceneCaptureType", "DigitalZoomRatio", "BrightnessValue", "ShutterSpeedValue", "ApertureValue",
  "ColorSpace", "PixelXDimension", "PixelYDimension", "SubSecTimeOriginal", "LensMake", "LensSpecification",
] as const;
const EXTRA_GPS_TAGS = [
  "GPSImgDirection", "GPSImgDirectionRef", "GPSSpeed", "GPSSpeedRef", "GPSTrack", "GPSTrackRef",
  "GPSDOP", "GPSMapDatum", "GPSDateStamp", "GPSSatellites", "GPSMeasureMode", "GPSDifferential",
] as const;

type ExifGroup = Record<string, unknown> | undefined;

function collectExtra(image: ExifGroup, photo: ExifGroup, gps: ExifGroup): PhotoExtra | null {
  const raw: Record<string, unknown> = {};
  for (const t of EXTRA_IMAGE_TAGS) if (image?.[t] !== undefined) raw[t] = image[t];
  for (const t of EXTRA_PHOTO_TAGS) if (photo?.[t] !== undefined) raw[t] = photo[t];
  for (const t of EXTRA_GPS_TAGS) if (gps?.[t] !== undefined) raw[t] = gps[t];
  // sanitizeExtra odsieje Buffery (np. GPSProcessingMethod), daty i resztę nie-prymitywów.
  return sanitizeExtra(raw);
}

/** exif-reader zwraca daty jako `Date` zbudowaną z cyfr aparatu w UTC — stąd `toISOString`. */
function localDateTimeOf(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return pick(takenAtSchema, value.toISOString().slice(0, 19));
}

/** [stopnie, minuty, sekundy] + „N/S/E/W” → stopnie dziesiętne. */
function dmsToDecimal(dms: unknown, ref: unknown): number | null {
  if (!Array.isArray(dms) || dms.length === 0) return null;
  const [d = 0, m = 0, s = 0] = dms as number[];
  if (![d, m, s].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const dec = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
  const negative = typeof ref === "string" && /^[SW]/i.test(ref.trim());
  return Number((negative ? -dec : dec).toFixed(7));
}

/**
 * Metadane oryginału PRZED konwersją. `null` dla plików, których sharp nie czyta
 * (PDF, .msg, .docx) — wołający po prostu nie dostaje wtedy metadanych.
 *
 * `mimeHint` = MIME z multipartu; bierzemy go tylko wtedy, gdy wygląda na obrazek
 * (przeglądarki potrafią wysłać `application/octet-stream`).
 */
export async function readServerPhotoMeta(buf: Buffer, mimeHint?: string): Promise<ServerPhotoMeta | null> {
  let md: Metadata;
  try {
    md = await sharp(buf, { failOn: "none" }).metadata();
  } catch {
    return null;
  }
  if (!md.format) return null;
  // Orientacja 5–8 obraca obraz o 90° — `.rotate()` zrobi to przy konwersji, więc
  // wymiary „oryginału” podajemy tak, jak zobaczył je człowiek, a nie jak leżą w pliku.
  const turned = (md.orientation ?? 1) >= 5;
  const hint = (mimeHint ?? "").split(";")[0].trim().toLowerCase();
  const orig = {
    width: pick(dimensionSchema, turned ? md.height : md.width),
    height: pick(dimensionSchema, turned ? md.width : md.height),
    size: pick(byteSizeSchema, buf.length),
    mime: hint.startsWith("image/") ? hint : `image/${md.format}`,
  };
  const empty: ServerPhotoMeta = { hasExif: false, takenAt: null, takenAtOffset: null, gps: null, camera: null, orig, extra: null };
  if (!md.exif) return empty;

  let exif: ReturnType<typeof exifReader>;
  try {
    exif = exifReader(md.exif);
  } catch {
    // Uszkodzony EXIF nie może wywrócić uploadu — zostaje sam opis oryginału.
    return empty;
  }
  const image = exif.Image as ExifGroup;
  const photo = exif.Photo as ExifGroup;
  const gpsInfo = exif.GPSInfo as ExifGroup;

  const takenAt =
    localDateTimeOf(photo?.DateTimeOriginal) ?? localDateTimeOf(photo?.DateTimeDigitized) ?? localDateTimeOf(image?.DateTime);
  const takenAtOffset =
    pick(offsetSchema, photo?.OffsetTimeOriginal) ??
    pick(offsetSchema, photo?.OffsetTime) ??
    pick(offsetSchema, photo?.OffsetTimeDigitized);

  // GPSAltitudeRef = 1 znaczy „poniżej poziomu morza”.
  const altitude =
    typeof gpsInfo?.GPSAltitude === "number" && Number.isFinite(gpsInfo.GPSAltitude)
      ? gpsInfo.GPSAltitudeRef === 1
        ? -gpsInfo.GPSAltitude
        : gpsInfo.GPSAltitude
      : null;
  const gps = gpsOf(
    dmsToDecimal(gpsInfo?.GPSLatitude, gpsInfo?.GPSLatitudeRef),
    dmsToDecimal(gpsInfo?.GPSLongitude, gpsInfo?.GPSLongitudeRef),
    gpsInfo?.GPSHPositioningError,
    altitude
  );
  const camera = cameraOf(image?.Make, image?.Model, photo?.LensModel);
  const extra = collectExtra(image, photo, gpsInfo);

  return { hasExif: !!(takenAt || takenAtOffset || gps || camera || extra), takenAt, takenAtOffset, gps, camera, orig, extra };
}

// ---------------------------------------------------------------------------
// Scalanie źródeł → kolumny
// ---------------------------------------------------------------------------

/** Puste kolumny = „nic nie wiadomo” → w API `meta: null`. */
const NO_META: Partial<PhotoMetaColumns> = {};

/**
 * Serwer wygrywa pole po polu tam, gdzie COŚ znalazł (`takenAtSource: "exif"`);
 * `orig.*` odwrotnie — tam wygrywa klient, bo tylko on widział plik sprzed canvasu.
 *
 * Zwraca PUSTY obiekt, gdy nie ma czego zapisać: obrazek bez EXIF-u wysłany przez
 * stary front nie zakłada wiersza metadanych z samym „upload”.
 */
export function mergePhotoMeta(p: {
  server: ServerPhotoMeta | null;
  client: ClientPhotoMeta | null;
  /** Domyślne `capturedVia`, gdy klient nic nie powiedział: „msg” dla maila, inaczej „upload”. */
  capturedViaFallback?: PhotoCapturedVia;
}): Partial<PhotoMetaColumns> {
  const { server, client } = p;
  if (!server?.hasExif && !client) return NO_META;

  const takenAt = server?.takenAt ?? client?.takenAt ?? null;
  const takenAtOffset = server?.takenAtOffset ?? client?.takenAtOffset ?? null;
  const gps = server?.gps ?? client?.gps ?? null;
  const camera = {
    make: server?.camera?.make ?? client?.camera?.make ?? null,
    model: server?.camera?.model ?? client?.camera?.model ?? null,
    lens: server?.camera?.lens ?? client?.camera?.lens ?? null,
  };
  // Wyjątek od „serwer wygrywa”: po canvasie serwer zna już tylko wersję zmniejszoną.
  const orig = {
    width: client?.orig?.width ?? server?.orig.width ?? null,
    height: client?.orig?.height ?? server?.orig.height ?? null,
    size: client?.orig?.size ?? server?.orig.size ?? null,
    mime: client?.orig?.mime ?? server?.orig.mime ?? null,
  };
  const extra =
    server?.extra || client?.extra ? sanitizeExtra({ ...(client?.extra ?? {}), ...(server?.extra ?? {}) }) : null;

  const anyCamera = camera.make || camera.model || camera.lens;
  const anyOrig = orig.width || orig.height || orig.size || orig.mime;
  if (!takenAt && !takenAtOffset && !gps && !anyCamera && !anyOrig && !extra) return NO_META;

  return {
    takenAt,
    takenAtOffset,
    takenAtSource: server?.takenAt ? "exif" : client?.takenAtSource ?? (takenAt ? "exif" : "none"),
    capturedVia: client?.capturedVia ?? p.capturedViaFallback ?? "upload",
    gpsLat: gps?.lat ?? null,
    gpsLng: gps?.lng ?? null,
    gpsAccuracyM: gps?.accuracyM ?? null,
    gpsAltitudeM: gps?.altitudeM ?? null,
    cameraMake: camera.make,
    cameraModel: camera.model,
    cameraLens: camera.lens,
    origWidth: orig.width,
    origHeight: orig.height,
    origSize: orig.size,
    origMime: orig.mime,
    metaJson: extra ? JSON.stringify(extra) : null,
  };
}

// ---------------------------------------------------------------------------
// Serializacja do API
// ---------------------------------------------------------------------------

/**
 * `meta` przy załączniku notatki — JEDNA funkcja dla obu konsumentów (kalendarz
 * biurowy i panel technika), żeby kształt nie rozjechał się między nimi.
 * `null` = wszystkie kolumny puste, czyli załącznik sprzed migracji 0113.
 */
export function attachmentMetaJson(row: PhotoMetaRow): AttachmentMetaJson | null {
  const gps =
    row.gpsLat != null && row.gpsLng != null
      ? { lat: row.gpsLat, lng: row.gpsLng, accuracyM: row.gpsAccuracyM ?? null, altitudeM: row.gpsAltitudeM ?? null }
      : null;
  const camera =
    row.cameraMake || row.cameraModel || row.cameraLens
      ? { make: row.cameraMake ?? null, model: row.cameraModel ?? null, lens: row.cameraLens ?? null }
      : null;
  const orig =
    row.origWidth != null || row.origHeight != null || row.origSize != null || row.origMime
      ? { width: row.origWidth ?? null, height: row.origHeight ?? null, size: row.origSize ?? null, mime: row.origMime ?? null }
      : null;
  let extra: PhotoExtra | null = null;
  if (row.metaJson) {
    try {
      extra = sanitizeExtra(JSON.parse(row.metaJson));
    } catch {
      extra = null;
    }
  }
  if (!row.takenAt && !row.takenAtOffset && !row.takenAtSource && !row.capturedVia && !gps && !camera && !orig && !extra) {
    return null;
  }
  // Kolumny są zwykłym TEXT-em, więc nieznaną wartość (ręczna edycja bazy, starszy
  // kod) traktujemy jak brak — front dostaje zawsze jedną z umówionych etykiet.
  const isSource = (v: string | null | undefined): v is PhotoTakenAtSource =>
    !!v && (PHOTO_TAKEN_AT_SOURCES as readonly string[]).includes(v);
  const isCapturedVia = (v: string | null | undefined): v is PhotoCapturedVia =>
    !!v && (PHOTO_CAPTURED_VIA as readonly string[]).includes(v);
  return {
    takenAt: row.takenAt ?? null,
    takenAtOffset: row.takenAtOffset ?? null,
    takenAtSource: isSource(row.takenAtSource) ? row.takenAtSource : "none",
    capturedVia: isCapturedVia(row.capturedVia) ? row.capturedVia : null,
    gps,
    camera,
    orig,
    extra,
  };
}
