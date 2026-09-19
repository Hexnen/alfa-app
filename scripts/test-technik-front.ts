/**
 * Panel technika — CZYSTE FUNKCJE FRONTU (bez DOM-u i bez Reacta):
 *   npx tsx scripts/test-technik-front.ts
 *
 * Moduły w `frontend/src/technik/lib/*` są importowane po ścieżce WZGLĘDNEJ,
 * bez aliasu `@/` (który działa tylko w buildzie Vite). Dlatego testujemy tu
 * `dates.ts` (zero importów) i `protocol.ts` (importy typów są kasowane przy
 * transpilacji, a `activities.ts` i `dates.ts` też są bez aliasu). Wszystko,
 * co dotyka `window`, `canvas` czy `fetch`, sprawdzają skrypty przeglądarkowe.
 *
 * Strefa jest USTAWIONA NA SZTYWNO (Europe/Warsaw): połowa tych błędów była
 * właśnie o strefę i w CI pod UTC przechodziłyby, niczego nie sprawdzając.
 *
 * Co jest tu pilnowane:
 *   • S8  — `toPayload` nie kasuje kontaktu (telefon/mail) samym otwarciem protokołu,
 *   • S9  — wielodniowe zlecenie ląduje pod dniem „dziś”, nie pod dniem startu,
 *   • S11 — znacznik z przyszłości jest odrzucany jeszcze przed wysyłką,
 *   • N21 — `YYYY-MM-DD HH:MM` (SQLite bez sekund) czytamy jako UTC, nie lokalnie,
 *   • K1  — Enter, spacja i wcięcie przeżywają drogę przez stan pola „Uwagi”,
 *   • N1  — linia rozwinięta ręcznie („… - kanał 3”) to nadal czynność ze słownika,
 *   • N3  — `shortContactName` wycina nawiasy, telefony i maile z KAŻDEGO miejsca,
 *   • S4  — dzień podpisu liczony ze znacznika, a nie z pierwszych pięciu znaków ISO,
 *   • G1  — wybór z galerii: film odpada, HEIC jest rozpoznany, zdjęcie sprzed dnia
 *           dostaje adnotację „17.09 14:20” (pełne zdanie siedzi w dymku),
 *   • F1  — metadane zdjęcia: EXIF → photoMeta (DMS→dziesiętne z półkulą, strefa
 *           aparatu, fallback na datę pliku w Warszawie — też zimą), przycinanie
 *           zestawu do 8 KB i formatery panelu „i” (1/x s, f/x, haversine).
 */
process.env.TZ = "Europe/Warsaw";

import {
  clockOf,
  formatDatePl,
  formatStampDayMonth,
  isFutureStamp,
  parseStamp,
  photoTakenLabel,
  upcomingDayOf,
} from "../frontend/src/technik/lib/dates.js";
import { isHeicLike, isImageLike } from "../frontend/src/technik/lib/image.js";
import {
  shortContactName,
  toForm,
  toPayload,
  type FormState,
} from "../frontend/src/technik/lib/protocol.js";
import {
  EXIF_MAX_BYTES,
  dmsToDecimal,
  epochToWarsaw,
  exifDateToLocalIso,
  exifToPhotoMeta,
  formatAperture,
  formatCoords,
  formatExposureTime,
  formatExtraValue,
  formatMeters,
  formatTakenAt,
  haversineMeters,
  mapsLink,
  normalizeOffset,
  parseJpegExif,
  pickExtra,
  takenAtEpoch,
  toAttachmentMeta,
} from "../frontend/src/lib/photo-meta.js";
import {
  isActivityPicked,
  matchedActivity,
  normalizeActivities,
  setActivityNotes,
  splitActivities,
  toggleActivity,
} from "../frontend/src/technik/lib/activities.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------------ *
 * N21 — znaczniki SQLite bez sekund
 * ------------------------------------------------------------------ */

console.log("\n— N21: SQLITE_UTC_RE bez sekund —");
// Wrzesień = czas letni w Warszawie (UTC+2).
ok('clockOf("2026-09-14 11:33:07") = 13:33 (UTC→lokalny)', clockOf("2026-09-14 11:33:07") === "13:33", clockOf("2026-09-14 11:33:07"));
ok('clockOf("2026-09-14 11:33") = 13:33 (bez sekund też UTC)', clockOf("2026-09-14 11:33") === "13:33", clockOf("2026-09-14 11:33"));
// Styczeń = czas zimowy (UTC+1) — ta sama ścieżka, inne przesunięcie.
ok('clockOf("2026-01-14 11:33") = 12:33 (zima)', clockOf("2026-01-14 11:33") === "12:33", clockOf("2026-01-14 11:33"));
// Lokalny ISO kalendarza zostaje NIETKNIĘTY — to nie jest UTC.
ok('clockOf("2026-09-14T11:33") = 11:33 (lokalny ISO)', clockOf("2026-09-14T11:33") === "11:33", clockOf("2026-09-14T11:33"));
ok('clockOf(pełny ISO z "Z") = 13:33', clockOf("2026-09-14T11:33:07.000Z") === "13:33", clockOf("2026-09-14T11:33:07.000Z"));
ok(
  'parseStamp("2026-09-14 11:33") = 11:33 UTC',
  parseStamp("2026-09-14 11:33")?.toISOString() === "2026-09-14T11:33:00.000Z",
  parseStamp("2026-09-14 11:33")?.toISOString(),
);
ok("clockOf(null) = pusty", clockOf(null) === "", clockOf(null));
ok("clockOf(śmieci) = pusty", clockOf("nie-data") === "", clockOf("nie-data"));

/* ------------------------------------------------------------------ *
 * S9 — grupowanie „Nadchodzących”
 * ------------------------------------------------------------------ */

console.log("\n— S9: kubełek dnia na liście nadchodzących —");
const TODAY = "2026-09-16";
ok(
  "zlecenie z dziś zostaje pod dziś",
  upcomingDayOf("2026-09-16T08:00", TODAY) === "2026-09-16",
  upcomingDayOf("2026-09-16T08:00", TODAY),
);
ok(
  "zlecenie z jutra zostaje pod jutrem",
  upcomingDayOf("2026-09-17T08:00", TODAY) === "2026-09-17",
  upcomingDayOf("2026-09-17T08:00", TODAY),
);
ok(
  "wielodniowy montaż z poniedziałku wpada pod DZIŚ, nie pod dzień startu",
  upcomingDayOf("2026-09-14T07:00", TODAY) === TODAY,
  upcomingDayOf("2026-09-14T07:00", TODAY),
);
ok(
  "całodniowe (sam YYYY-MM-DD) też się grupuje",
  upcomingDayOf("2026-09-14", TODAY) === TODAY,
  upcomingDayOf("2026-09-14", TODAY),
);

/* ------------------------------------------------------------------ *
 * S11 — „Inna godzina” nie wysyła przyszłości
 * ------------------------------------------------------------------ */

console.log("\n— S11: walidacja znacznika z przyszłości —");
const NOW = new Date("2026-09-16T12:00:00+02:00"); // 12:00 czasu warszawskiego
ok("teraz nie jest przyszłością", !isFutureStamp("2026-09-16T12:00", NOW));
ok("godzina wstecz przechodzi", !isFutureStamp("2026-09-16T09:30", NOW));
ok("wczoraj przechodzi", !isFutureStamp("2026-09-15T18:00", NOW));
ok("+3 min mieści się w tolerancji zegara tabletu", !isFutureStamp("2026-09-16T12:03", NOW));
ok("+30 min to już przyszłość", isFutureStamp("2026-09-16T12:30", NOW));
ok("jutro to przyszłość (zlecenie z jutra!)", isFutureStamp("2026-09-17T08:00", NOW));
ok("śmieci nie blokują zapisu", !isFutureStamp("", NOW));

/* ------------------------------------------------------------------ *
 * S8 — kontakt w protokole
 * ------------------------------------------------------------------ */

console.log("\n— S8: kontakt nietknięty do pierwszej edycji —");
const CONTACT = "Jan Nowak (kierownik), +48 600 100 200, jan@example.pl";
const protocol = {
  id: 1,
  number: "P/1/2026",
  status: "draft",
  workDate: "2026-09-16",
  workType: "serwis",
  actualHours: 2,
  actualKm: 40,
  activities: "Wymiana kamery",
  contact: CONTACT,
  contractor: "ALFA",
  salesperson: "MS",
  clientName: "Klient sp. z o.o.",
  clientNip: "1234567890",
  clientCity: "Warszawa",
  installationAddress: "ul. Prosta 1",
  items: [],
  updatedAt: "2026-09-16 09:00:00",
  signedAt: null,
  signerName: null,
  signaturePng: null,
} as unknown as Parameters<typeof toPayload>[0];

const form = toForm(protocol);
ok("toForm zostawia pełny kontakt", form.contact === CONTACT, form.contact);
ok('toForm wycina samo nazwisko do pola „Osoba odbierająca"', form.signerName === "Jan Nowak", form.signerName);
ok("świeży formularz nie jest „edytowany”", form.contactEdited === false, form.contactEdited);

const untouched = toPayload(protocol, form);
ok(
  "PUT bez edycji odsyła kontakt bajt w bajt (telefon i mail zostają)",
  untouched.contact === CONTACT,
  untouched.contact,
);

const edited: FormState = { ...form, signerName: "Anna Kowalska", contactEdited: true };
ok(
  "po edycji pola w PUT idzie to, co wpisał technik",
  toPayload(protocol, edited).contact === "Anna Kowalska",
  toPayload(protocol, edited).contact,
);

// Kontakt bez sklejki: nazwisko i `contact` są tym samym, więc nic się nie gubi.
const plain = toForm({ ...protocol, contact: "Anna Kowalska" } as typeof protocol);
ok("prosty kontakt zostaje prostym kontaktem", plain.contact === "Anna Kowalska" && plain.signerName === "Anna Kowalska", plain);

// Pusty kontakt w protokole nie robi się nagle niepustym.
const empty = toForm({ ...protocol, contact: null } as unknown as typeof protocol);
ok("brak kontaktu = puste pola", empty.contact === "" && empty.signerName === "", empty);
ok("…i pusty kontakt w PUT", toPayload({ ...protocol, contact: null } as unknown as typeof protocol, empty).contact === "", toPayload({ ...protocol, contact: null } as unknown as typeof protocol, empty).contact);

/* ------------------------------------------------------------------ *
 * K1 — pole „Uwagi / inne czynności” jest KONTROLOWANE, więc każda podróż
 *      tekstu przez split→compose musi być wierna co do znaku
 * ------------------------------------------------------------------ */

console.log("\n— K1: Enter, spacja i wcięcie w uwagach —");
const DICT = ["Wymiana kamery", "Przegląd rejestratora"];

// Technik pisze „linia pierwsza”, naciska Enter, pisze „linia druga”.
let pole = "";
pole = setActivityNotes(pole, DICT, "linia pierwsza");
pole = setActivityNotes(pole, DICT, "linia pierwsza\n");
ok("Enter zostaje w tekście (nie zlewa linii)", pole === "linia pierwsza\n", pole);
pole = setActivityNotes(pole, DICT, "linia pierwsza\nlinia druga");
ok("obie linie w polu", splitActivities(pole, DICT).notes === "linia pierwsza\nlinia druga", splitActivities(pole, DICT).notes);

ok(
  "spacja na końcu przeżywa (technik jest w połowie słowa)",
  splitActivities(setActivityNotes("", DICT, "kamera "), DICT).notes === "kamera ",
  splitActivities(setActivityNotes("", DICT, "kamera "), DICT).notes,
);
ok(
  "wcięcie na początku zostaje",
  splitActivities(setActivityNotes("", DICT, "  wcięcie"), DICT).notes === "  wcięcie",
  splitActivities(setActivityNotes("", DICT, "  wcięcie"), DICT).notes,
);

// Uwagi obok czynności ze słownika — czynności zostają na górze, uwagi wierne.
const zChynnoscia = setActivityNotes("Wymiana kamery", DICT, "uwaga\n");
ok(
  "czynność ze słownika + świeży Enter w uwagach",
  zChynnoscia === "Wymiana kamery\nuwaga\n",
  zChynnoscia,
);

// Porządki robi dopiero droga na serwer.
ok(
  "normalizeActivities ucina końcówki, zostawia wcięcie",
  normalizeActivities("  wcięcie   \n\n\n\nkoniec  \n") === "  wcięcie\n\nkoniec",
  normalizeActivities("  wcięcie   \n\n\n\nkoniec  \n"),
);
ok(
  "toPayload odsyła uwagi wyprostowane",
  toPayload(protocol, { ...form, activities: "Wymiana kamery\nuwaga  \n" }).activities ===
    "Wymiana kamery\nuwaga",
  toPayload(protocol, { ...form, activities: "Wymiana kamery\nuwaga  \n" }).activities,
);

/* ------------------------------------------------------------------ *
 * N1 — linia rozwinięta ręcznie nadal należy do słownika
 * ------------------------------------------------------------------ */

console.log("\n— N1: chip przy ręcznie rozwiniętej linii —");
const ROZWINIETA = "Wymiana kamery - kanał 3";
ok(
  "linia z dopiskiem wskazuje na pozycję słownika",
  matchedActivity(ROZWINIETA, DICT) === "Wymiana kamery",
  matchedActivity(ROZWINIETA, DICT),
);
ok(
  "„Wymiana kamerynowej” to JUŻ nie ta czynność",
  matchedActivity("Wymiana kamerynowej", DICT) === null,
  matchedActivity("Wymiana kamerynowej", DICT),
);
const rozbita = splitActivities(ROZWINIETA, DICT);
ok("rozwinięta linia stoi na liście czynności, nie w uwagach", rozbita.picked.length === 1 && rozbita.notes === "", rozbita);
ok("chip jest zaznaczony", isActivityPicked(rozbita.picked, DICT, "Wymiana kamery"));
ok(
  "stuknięcie chipa USUWA tę linię, zamiast dokładać duplikat",
  toggleActivity(ROZWINIETA, DICT, "Wymiana kamery") === "",
  toggleActivity(ROZWINIETA, DICT, "Wymiana kamery"),
);
ok(
  "ponowne stuknięcie dopisuje czystą czynność",
  toggleActivity("", DICT, "Wymiana kamery") === "Wymiana kamery",
  toggleActivity("", DICT, "Wymiana kamery"),
);

/* ------------------------------------------------------------------ *
 * N3 — kontakt zapisany nietypowo
 * ------------------------------------------------------------------ */

console.log("\n— N3: shortContactName niezależnie od kolejności —");
ok(
  "rola w nawiasie NA POCZĄTKU nie zostaje w polu",
  shortContactName("(recepcja) Anna Nowak, 600 100 200") === "Anna Nowak",
  shortContactName("(recepcja) Anna Nowak, 600 100 200"),
);
ok(
  "telefon i mail wypadają z każdego miejsca",
  shortContactName("+48 600 100 200 Jan Kowalski jan@x.pl") === "Jan Kowalski",
  shortContactName("+48 600 100 200 Jan Kowalski jan@x.pl"),
);
ok(
  "nazwa firmy z kropkami zostaje w całości",
  shortContactName("Firma Sp. z o.o., Jan") === "Firma Sp. z o.o.",
  shortContactName("Firma Sp. z o.o., Jan"),
);
ok(
  "gdy nie zostaje nic — wraca cała wartość (przycięta)",
  shortContactName("(brak), 600") === "(brak), 600",
  shortContactName("(brak), 600"),
);
ok("pusty kontakt zostaje pusty", shortContactName(null) === "", shortContactName(null));

/* ------------------------------------------------------------------ *
 * S4 — dzień podpisu (ISO w UTC) na karcie i w kroku „Odbiór”
 * ------------------------------------------------------------------ */

console.log("\n— S4: dzień podpisu ze znacznika, nie z cięcia tekstu —");
// Podpis 15.09 o 01:30 czasu warszawskiego = 2026-09-14T23:30Z.
const PODPIS = "2026-09-14T23:30:00.000Z";
ok('formatStampDayMonth(po północy) = "15.09"', formatStampDayMonth(PODPIS) === "15.09", formatStampDayMonth(PODPIS));
ok(
  "stare cięcie tekstu dawało inny dzień (dowód regresji)",
  formatDatePl(PODPIS).slice(0, 5) !== formatStampDayMonth(PODPIS),
  { tekstowo: formatDatePl(PODPIS).slice(0, 5), znacznikiem: formatStampDayMonth(PODPIS) },
);
ok(
  "znacznik SQLite bez „Z” też jest UTC",
  formatStampDayMonth("2026-09-14 23:30:00") === "15.09",
  formatStampDayMonth("2026-09-14 23:30:00"),
);
ok("brak podpisu = myślnik", formatStampDayMonth(null) === "—", formatStampDayMonth(null));

/* ------------------------------------------------------------------ *
 * G1 — zdjęcia z galerii: co wolno dołożyć i z jakiej daty
 * ------------------------------------------------------------------ */

console.log("\n— G1: rozpoznanie pliku z galerii —");
const plik = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });

ok("zwykłe zdjęcie przechodzi", isImageLike(plik("IMG_1.jpg", "image/jpeg")));
ok("film z galerii odpada", !isImageLike(plik("VID_1.mp4", "video/mp4")));
ok("PDF z galerii odpada", !isImageLike(plik("umowa.pdf", "application/pdf")));
// Udostępnianie z „Plików” na iPadzie potrafi nie podać typu MIME w ogóle.
ok("bez typu MIME decyduje rozszerzenie", isImageLike(plik("IMG_2.HEIC", "")));
ok("bez typu i bez rozszerzenia obrazka — odpada", !isImageLike(plik("notatka", "")));

ok("HEIC po typie MIME", isHeicLike(plik("x.jpg", "image/heic")));
ok("HEIC po rozszerzeniu, gdy typu brak", isHeicLike(plik("IMG_3.heic", "")));
// Android przy udostępnianiu potrafi wstawić octet-stream zamiast typu.
ok("HEIC w przebraniu octet-stream", isHeicLike(plik("IMG_4.HEIF", "application/octet-stream")));
ok("JPEG to nie HEIC", !isHeicLike(plik("IMG_5.jpg", "image/jpeg")));
// Po udanej konwersji plik nazywa się .jpg i ma typ image/jpeg — to jest
// dokładnie ten warunek, po którym `prepareForUpload` poznaje sukces.
ok("po konwersji nie zostaje śladu HEIC-a", !isHeicLike(plik("IMG_3.jpg", "image/jpeg")));

console.log("\n— G1: data wykonania zdjęcia —");
const TERAZ = new Date("2026-09-18T12:00:00");
ok("świeże z aparatu — bez adnotacji", photoTakenLabel(TERAZ.getTime() - 60_000, TERAZ) === null);
ok(
  "wczorajsze z galerii — z datą i godziną",
  photoTakenLabel(new Date("2026-09-17T14:20:00").getTime(), TERAZ) === "17.09 14:20",
  photoTakenLabel(new Date("2026-09-17T14:20:00").getTime(), TERAZ),
);
ok(
  "jednocyfrowy dzień i godzina mają zero wiodące",
  photoTakenLabel(new Date("2026-09-03T08:05:00").getTime(), TERAZ) === "03.09 08:05",
  photoTakenLabel(new Date("2026-09-03T08:05:00").getTime(), TERAZ),
);
// Zegar aparatu bywa ustawiony w przyszłość — wtedy lepiej nic nie pisać.
ok("znacznik z przyszłości — bez adnotacji", photoTakenLabel(TERAZ.getTime() + 3_600_000, TERAZ) === null);
ok("brak znacznika — bez adnotacji", photoTakenLabel(0, TERAZ) === null && photoTakenLabel(undefined, TERAZ) === null);


/* ------------------------------------------------------------------ *
 * F1 — metadane zdjęcia: EXIF → PhotoMetaInput i formatery panelu „i”
 * ------------------------------------------------------------------ */

console.log("\n— F1: współrzędne z EXIF-u —");
// Stopnie-minuty-sekundy: 52° 13′ 46,92″ N = 52,2297.
ok(
  "DMS + N → dodatnia szerokość",
  dmsToDecimal([52, 13, 46.92], "N") === 52.2297,
  dmsToDecimal([52, 13, 46.92], "N"),
);
// Półkula S/W musi ZMIENIĆ ZNAK — bez tego zdjęcie z Chile ląduje w Europie.
ok("DMS + S → ujemna szerokość", dmsToDecimal([33, 27, 0], "S") === -33.45, dmsToDecimal([33, 27, 0], "S"));
ok("DMS + W → ujemna długość", dmsToDecimal([70, 39, 0], "W") === -70.65, dmsToDecimal([70, 39, 0], "W"));
ok("DMS bez półkuli → dodatnia", dmsToDecimal([21, 0, 43.92], undefined) === 21.0122);
ok("brak DMS → null", dmsToDecimal(undefined, "N") === null);

console.log("\n— F1: data z EXIF-u i strefa —");
ok(
  'EXIF „2026:09:17 14:20:05” → lokalny ISO',
  exifDateToLocalIso("2026:09:17 14:20:05") === "2026-09-17T14:20:05",
  exifDateToLocalIso("2026:09:17 14:20:05"),
);
// Aparat bez ustawionej daty — to nie jest data, tylko puste pole.
ok("EXIF „0000:00:00 00:00:00” → null", exifDateToLocalIso("0000:00:00 00:00:00") === null);
ok("EXIF ze śmieci → null", exifDateToLocalIso("wczoraj") === null);
ok('offset „+02:00” przechodzi', normalizeOffset("+02:00") === "+02:00");
ok('offset „+0200” dostaje dwukropek', normalizeOffset("+0200") === "+02:00", normalizeOffset("+0200"));
ok("offset ze śmieci → null", normalizeOffset("CEST") === null);

// Lipiec = czas letni (UTC+2), styczeń = zimowy (UTC+1). Ta sama funkcja,
// dwa różne przesunięcia — właśnie o to się rozbija „data z pliku”.
ok(
  "lastModified z lipca → 12:00 +02:00",
  JSON.stringify(epochToWarsaw(Date.UTC(2026, 6, 1, 10, 0, 0))) ===
    JSON.stringify({ takenAt: "2026-07-01T12:00:00", takenAtOffset: "+02:00" }),
  epochToWarsaw(Date.UTC(2026, 6, 1, 10, 0, 0)),
);
ok(
  "lastModified ze stycznia → 11:00 +01:00 (zima)",
  JSON.stringify(epochToWarsaw(Date.UTC(2026, 0, 14, 10, 0, 0))) ===
    JSON.stringify({ takenAt: "2026-01-14T11:00:00", takenAtOffset: "+01:00" }),
  epochToWarsaw(Date.UTC(2026, 0, 14, 10, 0, 0)),
);
ok("lastModified = 0 → null", epochToWarsaw(0) === null);

console.log("\n— F1: mapowanie EXIF → photoMeta —");
const FAKTY = {
  name: "IMG_0042.jpg",
  type: "image/jpeg",
  size: 3_145_728,
  lastModified: Date.UTC(2026, 0, 14, 10, 0, 0),
};
const SUROWY = {
  tags: {
    Make: "Apple",
    Model: "iPhone 13",
    LensModel: "iPhone 13 back camera 5.7mm f/1.8",
    DateTimeOriginal: "2026:09:17 14:20:05",
    OffsetTimeOriginal: "+02:00",
    Orientation: 6,
    ISO: 200,
    FNumber: 1.8,
    ExposureTime: 0.008,
    PixelXDimension: 4032,
    PixelYDimension: 3024,
  },
  gps: {
    GPSLatitude: [52, 13, 46.92],
    GPSLatitudeRef: "N",
    GPSLongitude: [21, 0, 43.92],
    GPSLongitudeRef: "E",
    GPSHPositioningError: 12,
    GPSAltitude: 110,
    GPSAltitudeRef: 0,
  },
  frame: { width: 4032, height: 3024 },
};
const META = exifToPhotoMeta(SUROWY, FAKTY, "camera");
ok('data z EXIF-u wygrywa z datą pliku', META.takenAt === "2026-09-17T14:20:05" && META.takenAtSource === "exif", META);
ok("strefa aparatu przepisana", META.takenAtOffset === "+02:00");
ok("pinezka dziesiętna", META.gps?.lat === 52.2297 && META.gps?.lng === 21.0122, META.gps);
ok("dokładność i wysokość", META.gps?.accuracyM === 12 && META.gps?.altitudeM === 110, META.gps);
ok("aparat i obiektyw", META.camera?.make === "Apple" && META.camera?.model === "iPhone 13" && !!META.camera?.lens);
// Orientation 6 = zdjęcie pionowe zapisane poziomo; w panelu mają stać boki,
// które widać na ekranie, a nie te z matrycy.
ok("obrót z EXIF-u zamienia boki", META.orig?.width === 3024 && META.orig?.height === 4032, META.orig);
ok("waga i format oryginału", META.orig?.size === 3_145_728 && META.orig?.mime === "image/jpeg");
ok("bez MakerNote i miniatur w extra", !("MakerNote" in (META.exif ?? {})));

// Zdjęcie bez EXIF-u (zrzut ekranu, plik po canvasie) — zostaje data pliku,
// przeliczona na czas warszawski, i OZNACZONA jako orientacyjna.
const BEZ_EXIF = exifToPhotoMeta(null, FAKTY, "upload");
ok(
  "brak EXIF-u → data z pliku, czas warszawski (zima)",
  BEZ_EXIF.takenAtSource === "file" && BEZ_EXIF.takenAt === "2026-01-14T11:00:00",
  BEZ_EXIF,
);
ok("brak EXIF-u → bez pinezki i bez aparatu", !BEZ_EXIF.gps && !BEZ_EXIF.camera);
ok("capturedVia idzie z wyboru, nie z pliku", BEZ_EXIF.capturedVia === "upload" && META.capturedVia === "camera");

console.log("\n— F1: przycinanie zestawu EXIF —");
const PELNY = pickExtra(SUROWY.tags, SUROWY.gps) ?? {};
ok(
  "pełny zestaw mieści się w 8 KB",
  new TextEncoder().encode(JSON.stringify(PELNY)).length <= EXIF_MAX_BYTES,
  JSON.stringify(PELNY).length,
);
ok("ISO i przysłona są w zestawie", PELNY.ISO === 200 && PELNY.FNumber === 1.8, PELNY);
// Przy ciasnym limicie spadają pola NAJMNIEJ istotne — ISO zostaje do końca.
const CIASNY = pickExtra(SUROWY.tags, SUROWY.gps, 40) ?? {};
ok(
  "ciasny limit zostawia najważniejsze i nie przekracza limitu",
  new TextEncoder().encode(JSON.stringify(CIASNY)).length <= 40 && "ISO" in CIASNY,
  CIASNY,
);

console.log("\n— F1: formatery panelu —");
ok('ExposureTime 0,008 → „1/125 s”', formatExposureTime(0.008) === "1/125 s", formatExposureTime(0.008));
ok('ExposureTime 2 → „2 s”', formatExposureTime(2) === "2 s", formatExposureTime(2));
ok("ExposureTime 0 → pusto", formatExposureTime(0) === "");
ok('FNumber 1,8 → „f/1,8”', formatAperture(1.8) === "f/1,8", formatAperture(1.8));
ok('FNumber 2 → „f/2”', formatAperture(2) === "f/2", formatAperture(2));
ok(
  "formatExtraValue zna czas i przysłonę",
  formatExtraValue("ExposureTime", 0.008) === "1/125 s" && formatExtraValue("FNumber", 1.8) === "f/1,8",
);
ok("Flash: bit 0 mówi, czy błysnęło", formatExtraValue("Flash", 16) === "Bez błysku" && formatExtraValue("Flash", 25) === "Błysk");
ok('data wykonania „17.09.2026, 14:20”', formatTakenAt("2026-09-17T14:20:05") === "17.09.2026, 14:20", formatTakenAt("2026-09-17T14:20:05"));
ok("współrzędne skrócone z półkulami", formatCoords(52.2297, 21.0122) === "52,2297° N, 21,0122° E", formatCoords(52.2297, 21.0122));
ok("link do map z kropką dziesiętną", mapsLink(52.2297, 21.0122) === "https://www.google.com/maps?q=52.2297,21.0122");

console.log("\n— F1: odległość od obiektu —");
// 0,01° długości na szerokości Warszawy to ~682 m — tyle, ile wyjdzie z mapy.
const D = haversineMeters(52.2297, 21.0122, 52.2297, 21.0222);
ok("haversine: 0,01° długości ≈ 682 m", Math.abs(D - 682) < 10, D);
ok("haversine: ten sam punkt = 0 m", haversineMeters(52.2297, 21.0122, 52.2297, 21.0122) === 0);
ok('dystans po ludzku: „120 m” i „1,2 km”', formatMeters(118) === "120 m" && formatMeters(1234) === "1,2 km", [formatMeters(118), formatMeters(1234)]);

console.log("\n— F1: moment wykonania kontra moment dodania —");
// Ze strefą aparatu liczymy PRAWDZIWY moment; bez niej znacznik czytamy jako
// lokalny, czyli tak, jak go widzi patrzący na ekran.
ok(
  "takenAtEpoch ze strefą",
  takenAtEpoch({ takenAt: "2026-09-17T14:20:05", takenAtOffset: "+02:00" }) === Date.UTC(2026, 8, 17, 12, 20, 5),
  takenAtEpoch({ takenAt: "2026-09-17T14:20:05", takenAtOffset: "+02:00" }),
);
ok("takenAtEpoch bez daty → null", takenAtEpoch({ takenAt: null }) === null);
const PRZEZ_API = toAttachmentMeta(META);
ok(
  "toAttachmentMeta wypełnia null-e kontraktu",
  PRZEZ_API.gps?.accuracyM === 12 && PRZEZ_API.camera?.make === "Apple" && PRZEZ_API.extra !== null,
  PRZEZ_API,
);
ok(
  "toAttachmentMeta dla pustych metadanych",
  toAttachmentMeta(BEZ_EXIF).gps === null && toAttachmentMeta(BEZ_EXIF).camera === null,
);

console.log("\n— F1: parser JPEG-a —");
ok("nie-JPEG → null, bez wyjątku", parseJpegExif(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer as ArrayBuffer) === null);
ok("obcięty JPEG → null, bez wyjątku", parseJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]).buffer as ArrayBuffer) === null);
try {
  // Prawdziwy JPEG z EXIF-em — składany sharpem z `node_modules` backendu,
  // żeby test sprawdzał parser na bajtach, a nie na wymyślonym obiekcie.
  const { default: sharp } = await import("sharp");
  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 90, b: 140 } },
  })
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 13", Software: "17.5.1" },
      IFD2: {
        DateTimeOriginal: "2026:09:17 14:20:05",
        OffsetTimeOriginal: "+02:00",
        ExposureTime: "0.008",
        FNumber: "1.8",
        ISOSpeedRatings: "200",
        LensModel: "iPhone 13 back camera 5.7mm f/1.8",
      },
      IFD3: {
        GPSLatitude: "52/1 13/1 4692/100",
        GPSLatitudeRef: "N",
        GPSLongitude: "21/1 0/1 4392/100",
        GPSLongitudeRef: "E",
        GPSHPositioningError: "12/1",
      },
    })
    .jpeg()
    .toBuffer();
  const ab = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
  const raw = parseJpegExif(ab);
  ok("APP1 znaleziony w prawdziwym pliku", raw !== null && raw.tags.Make === "Apple", raw?.tags);
  const z = exifToPhotoMeta(raw, { ...FAKTY, size: jpeg.length }, "gallery");
  ok("data z prawdziwego pliku", z.takenAt === "2026-09-17T14:20:05" && z.takenAtSource === "exif", z.takenAt);
  ok("pinezka z prawdziwego pliku", z.gps?.lat === 52.2297 && z.gps?.lng === 21.0122, z.gps);
  ok("wymiary z ramki JPEG-a", z.orig?.width === 640 && z.orig?.height === 480, z.orig);
  ok("czułość i przysłona w extra", z.exif?.ISO === 200 && z.exif?.FNumber === 1.8, z.exif);
} catch (e) {
  ok(`parser na prawdziwym JPEG-u (sharp: ${e instanceof Error ? e.message : e})`, false);
}

console.log(`\n${failures === 0 ? "WSZYSTKO OK" : `BŁĘDÓW: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
