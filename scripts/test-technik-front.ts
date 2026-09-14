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
 *   • S4  — dzień podpisu liczony ze znacznika, a nie z pierwszych pięciu znaków ISO.
 */
process.env.TZ = "Europe/Warsaw";

import {
  clockOf,
  formatDatePl,
  formatStampDayMonth,
  isFutureStamp,
  parseStamp,
  upcomingDayOf,
} from "../frontend/src/technik/lib/dates.js";
import {
  shortContactName,
  toForm,
  toPayload,
  type FormState,
} from "../frontend/src/technik/lib/protocol.js";
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

console.log(`\n${failures === 0 ? "WSZYSTKO OK" : `BŁĘDÓW: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
