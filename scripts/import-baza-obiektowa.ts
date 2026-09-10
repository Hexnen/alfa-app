/**
 * Import PRAWDZIWEJ kartoteki kontrahentów i obiektów (baza obiektowa, wrzesień 2026):
 *   npx tsx scripts/import-baza-obiektowa.ts                     # suchy przebieg — raport, nic nie zapisuje
 *   npx tsx scripts/import-baza-obiektowa.ts --rebuild --apply   # kasuje kartotekę DEMO i wgrywa prawdziwą
 *   npx tsx scripts/import-baza-obiektowa.ts --apply             # przebieg PRZYROSTOWY (nic nie kasuje)
 *
 * Honoruje ALFA_DB_PATH (patrz src/db/index.ts) — pierwsze przebiegi rób na kopii bazy.
 *
 * SKĄD DANE. Decyzje „kto jest płatnikiem którego obiektu” zapadły wcześniej, w plikach
 * mapowań (scripts/data/mapowanie-obiektow/*.json) — skrypt ich nie wymyśla, tylko wykonuje:
 *  - kontrahenci-zweryfikowani.json — 584 podmioty z NIP-em sprawdzonym sumą kontrolną i wykazem VAT MF,
 *  - cma-1..3.json — 416 pozycji rejestru CMA (monitored_objects) z decyzją nip / new / noNip / internal,
 *  - faktury.json / sk.json / hr.json — fakturowanie miesięczne, spółki komandytowe, posterunki OFI z kadr.
 * Brakujące pliki mapowań są POMIJANE z ostrzeżeniem, żeby dało się pracować, zanim powstaną wszystkie.
 *
 * CZEGO SKRYPT NIE ZROBI. Kontrahenta bez NIP-u nie ma jak utworzyć (kolumna NOT NULL UNIQUE
 * + walidator), więc obiekty z decyzją „new”/„noNip” NIE trafiają do kartoteki — lądują w
 * obiekty/RAPORT-do-uzupelnienia.md. Żeby je zaimportować, dopisz NIP do opcjonalnego pliku
 * scripts/data/kontrahenci-uzupelnienie.json i uruchom skrypt ponownie (dane firmy dociąga wykaz MF).
 *
 * BEZPIECZEŃSTWO DANYCH. Do objects.notes nie trafia NIC z pól, w których rejestr CMA trzyma
 * hasła, loginy i adresy kamer (extra_data3/4/5, hasła przymusu) — a pozostałe pola opisowe
 * przechodzą przez filtr `sanitize()`, który wycina wszystko, co wygląda na sekret.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { splitAbonament } from "../src/lib/abonament-split.js";
import { removeStoredFiles } from "../src/lib/calendar-attachments.js";
import { isMfError, lookupCompanyByNip } from "../src/lib/mf-whitelist.js";
import { legacyObjectType, upsertServiceRowsFromFlags } from "../src/lib/object-services.js";
import { normalizeNIP, validateNIP } from "../src/utils/nip.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "scripts", "data");
const MAP = join(DATA, "mapowanie-obiektow");
const OUT_DIR = join(ROOT, "obiekty");

const apply = process.argv.includes("--apply");
const rebuild = process.argv.includes("--rebuild");
const TODAY = new Date().toISOString().slice(0, 10);
/** Data w formacie kolumn dat (`YYYY-MM-DD`) — rejestr CMA bywa niechlujny. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_NOTE = "Źródło: KONTRAHENCI.XLSX 2026-09-07";
const CMA_NOTE = "Źródło: raport CMA 2026-07-07";

// ---------------------------------------------------------------------------
// Wejścia
// ---------------------------------------------------------------------------
interface VerifiedContractor {
  nip: string;
  name: string;
  nameFromFile?: string;
  aliases?: string[];
  address?: string;
  postalCode?: string;
  city?: string;
  email?: string;
  phone?: string;
  paymentForm?: string;
  regon?: string;
  krs?: string;
  vatStatus?: string;
  vatCheckedAt?: string;
}

type Decision = "nip" | "new" | "noNip" | "internal" | "empty";

interface CmaDecision {
  externalId: number;
  cmaName: string;
  decision: Decision;
  nip: string | null;
  noNipKey: string | null;
  contractorName: string | null;
  confidence?: string;
  invoiceClient?: string | null;
  invoiceSheet?: string | null;
  hrObject?: string | null;
  note?: string;
}

interface SkDecision {
  company: string;
  objectName: string | null;
  decision: Decision;
  nip: string | null;
  contractorName: string | null;
  hrObject: string | null;
  cmaExternalId: number | null;
  note?: string;
}

interface HrDecision {
  hrName: string;
  decision: Decision;
  nip: string | null;
  contractorName: string | null;
  cmaExternalId: number | null;
  skCompany: string | null;
  note?: string;
}

interface InvoiceRow {
  nip?: string | null;
  client?: string | null;
  invoiceClient?: string | null;
  sheet?: string | null;
  invoiceSheet?: string | null;
  flag?: string | null;
  netto?: number | string | null;
  cmaExternalIds?: number[] | null;
}

/** Wpis ręcznego uzupełnienia: NIP dopisany do obiektów, których nie dało się przypisać. */
interface Supplement {
  nip: string;
  name?: string;
  matchCma?: number[];
  matchNames?: string[];
  email?: string;
  phone?: string;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const warnings: string[] = [];
function warn(msg: string) {
  warnings.push(msg);
  console.warn(`  UWAGA: ${msg}`);
}

const verified = readJson<VerifiedContractor[]>(join(DATA, "kontrahenci-zweryfikowani.json"));
if (!verified) {
  console.error("Brak scripts/data/kontrahenci-zweryfikowani.json — bez tego nie ma czego importować.");
  process.exit(1);
}

const cmaDecisions: CmaDecision[] = [];
for (const n of [1, 2, 3]) {
  const part = readJson<CmaDecision[]>(join(MAP, `cma-${n}.json`));
  if (!part) warn(`brak mapowania cma-${n}.json — pominięte`);
  else cmaDecisions.push(...part);
}
const skDecisions = readJson<SkDecision[]>(join(MAP, "sk.json"));
if (!skDecisions) warn("brak sk.json — spółki komandytowe i ich posterunki pominięte");
const hrDecisions = readJson<HrDecision[]>(join(MAP, "hr.json"));
if (!hrDecisions) warn("brak hr.json — powiązanie posterunków kadrowych pominięte");
const invoices = readJson<InvoiceRow[]>(join(MAP, "faktury.json"));
if (!invoices) warn("brak faktury.json — abonamenty i spółka fakturująca z arkuszy OBIEKTY pominięte");

const supplements = readJson<Supplement[]>(join(DATA, "kontrahenci-uzupelnienie.json")) ?? [];
const MF_CACHE_PATH = join(DATA, "kontrahenci-uzupelnienie-mf.json");

// ---------------------------------------------------------------------------
// Narzędzia tekstowe
// ---------------------------------------------------------------------------
/** „BYDGOSZCZ” → „Bydgoszcz”; zapisy mieszane (już poprawne) zostawiamy w spokoju. */
function titleCaseCity(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (v !== v.toLocaleUpperCase("pl-PL")) return v; // ktoś już to zapisał po ludzku
  return v
    .toLocaleLowerCase("pl-PL")
    .split(/(\s+|-)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toLocaleUpperCase("pl-PL") + part.slice(1)))
    .join("");
}

/**
 * Filtr sekretów. Rejestr CMA trzyma w polach opisowych hasła, loginy, adresy kamer i IP —
 * kartoteka jest widoczna dla całej firmy, więc takie zdanie nie ma prawa się w niej znaleźć.
 * Zwraca null, gdy tekst wygląda na sekret (całe pole wypada, nie tylko jedno słowo).
 */
const SECRET_RE =
  /(has[łl]o|has[łl]a|hasel|login|użytkownik\s*:|uzytkownik\s*:|admin\s*[:/]|rtsp:|https?:\/\/|\bpassword\b|\bpin\b|\bip\s*[:=]|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i;
function sanitize(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (SECRET_RE.test(v)) return null;
  return v;
}

/** „2 000 zł” / „6000zł netto” → 2000 / 6000; tekst bez liczby → null. */
function parseMoney(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = (value ?? "").toString().trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s| /g, "")
    .replace(/z[łl]|netto|pln|\/mies\.?|miesi[ąa]c/gi, "")
    .replace(/,/g, ".");
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseCoord(value: string | null | undefined): number | null {
  const n = Number.parseFloat((value ?? "").toString().replace(",", "."));
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/** Ulica z adresu CMA: „Koniczynowa 2A, 03-612 Warszawa” → „Koniczynowa 2A”; „, BYDGOSZCZ” → null. */
function streetFrom(mo: { address: string | null; street: string | null; houseNumber: string | null }): string | null {
  const street = (mo.street ?? "").trim();
  if (street) {
    const nr = (mo.houseNumber ?? "").trim();
    return nr ? `${street} ${nr}` : street;
  }
  const first = (mo.address ?? "").split(",")[0]?.trim() ?? "";
  if (!first) return null;
  if (/^\d{2}-\d{3}$/.test(first)) return null; // sam kod pocztowy to nie adres
  return first;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");

// ---------------------------------------------------------------------------
// Kontrahenci: nazwa handlowa vs nazwa z MF
// ---------------------------------------------------------------------------
const COMPANY_RE =
  /(SP[ÓO][ŁL]KA|SP\.\s*Z\s*O|S\.?A\.?$|\bS\.A\.|SPÓ[ŁL]DZIEL|WSP[ÓO]LNOT|FUNDACJ|STOWARZYSZ|S\.?C\.?$|SPOLKA|GMIN|POWIAT|MIASTO|INSTYTUT|UNIWERSYTET|SZKO[ŁL]A|PRZEDSI[ĘE]BIORSTWO|ZAK[ŁL]AD)/i;

/**
 * Dla spółek nazwa z wykazu MF jest prawidłowa i pełna. Dla jednoosobowej działalności MF
 * zwraca samo imię i nazwisko („ARKADIUSZ KLIMCZAK”), a nazwę handlową („AK - TEL …”) zna
 * tylko plik z księgowości — i to jej szuka się w wyszukiwarce kartoteki.
 */
function contractorName(c: VerifiedContractor): string {
  const mfName = (c.name ?? "").trim();
  const fileName = (c.nameFromFile ?? "").trim().replace(/^\d+\.\s*/, "");
  if (COMPANY_RE.test(mfName)) return mfName;
  if (fileName && norm(fileName) !== norm(mfName)) return fileName;
  return mfName || fileName;
}

function contractorNotes(c: VerifiedContractor): string {
  const bits: string[] = [];
  const payment = (c.paymentForm ?? "").trim();
  if (payment) bits.push(`Forma płatności: ${payment}`);
  const aliases = new Set<string>();
  for (const a of c.aliases ?? []) if (a?.trim()) aliases.add(a.trim());
  const fileName = (c.nameFromFile ?? "").trim();
  const used = contractorName(c);
  if (fileName && norm(fileName) !== norm(used)) aliases.add(fileName);
  if (aliases.size > 0) bits.push(`aliasy księgowe: ${[...aliases].slice(0, 8).join(", ")}`);
  const head = bits.join("; ");
  return head ? `${head}\n${SOURCE_NOTE}` : SOURCE_NOTE;
}

// ---------------------------------------------------------------------------
// Uzupełnienia: dociągnięcie danych z wykazu MF (poza transakcją, bo to sieć)
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type MfCacheEntry = { nip: string; name?: string; address?: string; postalCode?: string; city?: string; regon?: string; krs?: string; statusVat?: string; date?: string; found: boolean };
const mfCache: Record<string, MfCacheEntry> = readJson<Record<string, MfCacheEntry>>(MF_CACHE_PATH) ?? {};

const supplementContractors: VerifiedContractor[] = [];
const supplementByCma = new Map<number, string>();
const supplementByName = new Map<string, string>();

for (const s of supplements) {
  const nip = normalizeNIP(s.nip ?? "");
  if (!validateNIP(nip)) {
    warn(`uzupełnienie: NIP „${s.nip}” nie przechodzi walidacji — wpis pominięty`);
    continue;
  }
  let mf = mfCache[nip];
  if (!mf) {
    const res = await lookupCompanyByNip(nip);
    if (isMfError(res)) {
      warn(`uzupełnienie ${nip}: wykaz MF odpowiedział błędem (${res.error}) — dane tylko z pliku`);
      mf = { nip, found: false };
    } else if (!res.found || !res.company) {
      warn(`uzupełnienie ${nip}: wykaz MF nie zna tego NIP-u — dane tylko z pliku`);
      mf = { nip, found: false };
    } else {
      const c = res.company;
      mf = { nip, found: true, name: c.name, address: c.address, postalCode: c.postalCode, city: c.city, regon: c.regon, krs: c.krs, statusVat: c.statusVat ?? undefined, date: c.date };
      if (!res.cached) await sleep(250);
    }
    mfCache[nip] = mf;
    writeFileSync(MF_CACHE_PATH, JSON.stringify(mfCache, null, 2) + "\n", "utf8");
  }
  const name = (mf.found ? mf.name : undefined) ?? s.name ?? `Kontrahent NIP ${nip}`;
  supplementContractors.push({
    nip,
    name,
    nameFromFile: s.name ?? name,
    aliases: s.matchNames ?? [],
    address: mf.address,
    postalCode: mf.postalCode,
    city: mf.city,
    email: s.email,
    phone: s.phone,
    regon: mf.regon,
    krs: mf.krs,
    vatStatus: mf.found ? mf.statusVat : "Niezarejestrowany",
    vatCheckedAt: mf.date ?? TODAY,
  });
  for (const id of s.matchCma ?? []) supplementByCma.set(id, nip);
  for (const n of s.matchNames ?? []) supplementByName.set(norm(n), nip);
}

// Katalog kontrahentów po NIP (plik zweryfikowany + uzupełnienia; uzupełnienie nie nadpisuje
// wpisu, który już ma pełne dane z pierwszego przebiegu weryfikacji).
const contractorsByNip = new Map<string, VerifiedContractor>();
for (const c of verified) {
  const nip = normalizeNIP(c.nip ?? "");
  if (!validateNIP(nip)) {
    warn(`kontrahent „${c.name}”: NIP ${c.nip} nie przechodzi walidacji — pominięty`);
    continue;
  }
  contractorsByNip.set(nip, { ...c, nip });
}
for (const c of supplementContractors) if (!contractorsByNip.has(c.nip)) contractorsByNip.set(c.nip, c);

// ---------------------------------------------------------------------------
// Stan bazy: rejestr CMA, kadry, spółki
// ---------------------------------------------------------------------------
const monitored = db.select().from(schema.monitoredObjects).all();
const monitoredByExternal = new Map(monitored.map((m) => [m.externalId, m]));
const companies = db.select().from(schema.companies).all();
const companyByName = new Map(companies.map((c) => [norm(c.name), c]));
const hrObjectRows = db.select().from(schema.hrObjects).all();
const hrObjectByName = new Map(hrObjectRows.map((h) => [norm(h.name), h]));

/** „GUARD ” (ze spacją) w arkuszu SK = spółka GUARD SK ze słownika kadr — reszta po nazwie 1:1. */
function companyIdFor(rawName: string | null | undefined): number | null {
  const name = (rawName ?? "").trim();
  if (!name) return null;
  const direct = companyByName.get(norm(name));
  if (direct) return direct.id;
  if (norm(name) === "guard") return companyByName.get("guard sk")?.id ?? null;
  return null;
}
const missingCompanies = new Set<string>();

// Fakturowanie: externalId → WSZYSTKIE pozycje, które ten obiekt obejmują. Jeden klient
// bywa w arkuszu kilka razy (ZDV + PODJAZDY + WYNAJEM) i te wiersze wskazują ten sam
// zestaw obiektów — abonamentem jest tylko wiersz usługi stałej.
const invoiceByExternal = new Map<number, InvoiceRow[]>();
const invoiceObjectsCount = new Map<InvoiceRow, number>();
for (const row of invoices ?? []) {
  const ids = Array.isArray(row.cmaExternalIds) ? row.cmaExternalIds.filter((x) => typeof x === "number") : [];
  invoiceObjectsCount.set(row, ids.length);
  for (const id of ids) {
    const bucket = invoiceByExternal.get(id);
    if (bucket) bucket.push(row);
    else invoiceByExternal.set(id, [row]);
  }
}
const invoiceSheetToCompany = (sheet: string | null | undefined): string | null => {
  const s = norm(sheet ?? "");
  if (s === "alfa group") return "ALFA";
  if (s === "alfa s") return "ALFA S";
  return null;
};
const RENTAL_FLAG_RE = /podjazd/i;

// ---------------------------------------------------------------------------
// Plan: kontrahenci i obiekty do wstawienia
// ---------------------------------------------------------------------------
interface PlannedObject {
  key: string;
  nip: string;
  name: string;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  hasSswin: boolean;
  hasCameras: boolean;
  hasOfi: boolean;
  cameraCount: number | null;
  /** Początek świadczenia usług — z rejestru CMA (`monitoring_start`); null = nieznany. */
  serviceStart: string | null;
  /** Koniec świadczenia — import buduje kartotekę OD ZERA, więc wolno domknąć okres. */
  serviceEnd: string | null;
  status: "active" | "inactive";
  monthlyValue: number | null;
  companyName: string | null;
  notes: string;
  externalIds: number[];
  hrNames: string[];
  origin: "cma" | "ofi";
}

const planned: PlannedObject[] = [];
const plannedByKey = new Map<string, PlannedObject>();
const internalCma: CmaDecision[] = [];
const toComplete: Array<{ externalId: number | null; name: string; contractorName: string | null; city: string | null; service: string; price: string; source: string; reason: string }> = [];

function deviceList(devices: string | null): string[] {
  return (devices ?? "")
    .split(/[,\n;]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

const CAMERA_GROUP_RE = /(CMA|ZDW|Budowy|SAFETOWER|GLOK|WIEŻE|WIEZE|AITower)/i;
const CAMERA_DEV_RE = /@(dahua|hikvision|vdev)\b/i;
const SSWIN_DEV_RE = /@(sai|ebs|stationary)\b/i;

function nipForCma(d: CmaDecision): string | null {
  if (d.decision === "nip") {
    const nip = normalizeNIP(d.nip ?? "");
    return nip && contractorsByNip.has(nip) ? nip : null;
  }
  // „new”/„noNip” wchodzą tylko wtedy, gdy ktoś dopisał NIP do pliku uzupełnień.
  const bySupplementId = supplementByCma.get(d.externalId);
  if (bySupplementId && contractorsByNip.has(bySupplementId)) return bySupplementId;
  const byName = d.contractorName ? supplementByName.get(norm(d.contractorName)) : undefined;
  if (byName && contractorsByNip.has(byName)) return byName;
  return null;
}

type MonitoredRow = (typeof monitored)[number];

/**
 * Obiekt kartoteki z pozycji rejestru CMA. Wydzielone z pętli, bo tę samą pozycję potrafi
 * ożywić słownik kadr: rejestr nie zna płatnika (decyzja „new”), a kadry znają go z listy płac.
 */
function buildPlanFromCma(d: CmaDecision, mo: MonitoredRow, nip: string, extraNote?: string): PlannedObject {
  const devices = deviceList(mo.devices);
  const groups = mo.groups ?? "";
  const serviceTypes = mo.serviceTypes ?? "";
  const hasOfi = /OFI/i.test(groups) || (mo.identifier1 ?? "").trim().toUpperCase() === "OFI" || /OFI/i.test(serviceTypes);
  const hasCameras =
    CAMERA_GROUP_RE.test(groups) || /Monitoring Wizyjny/i.test(serviceTypes) || devices.some((dev) => CAMERA_DEV_RE.test(dev));
  const hasSswin = devices.some((dev) => SSWIN_DEV_RE.test(dev));
  const cameras = devices.filter((dev) => CAMERA_DEV_RE.test(dev)).length;

  const end = (mo.monitoringEnd ?? "").trim();
  const ended = end !== "" && end.slice(0, 10) < TODAY;
  const status: "active" | "inactive" = mo.objectStatus === "1" && !ended ? "active" : "inactive";

  // Abonament: najpierw cena wprost z rejestru CMA, potem — tylko dla pozycji fakturowania
  // obejmującej DOKŁADNIE jeden obiekt — kwota z faktury. Kwoty zbiorczej nie dzielimy.
  let monthlyValue = parseMoney(mo.extraData1);
  const invoiceRows = invoiceByExternal.get(d.externalId) ?? [];
  const flagOf = (row: InvoiceRow) => (row.flag ?? "").toString().trim();
  const soleAbonament = invoiceRows.find(
    (row) => (invoiceObjectsCount.get(row) ?? 0) === 1 && !RENTAL_FLAG_RE.test(flagOf(row)) && parseMoney(row.netto ?? null) !== null
  );
  if (monthlyValue === null && soleAbonament) monthlyValue = parseMoney(soleAbonament.netto ?? null);

  const notes: string[] = [];
  // identifier1 to zwykle sucha kategoria (KLT/DT/OFI), ale bywa notatką operatora z hasłem
  // obiektu — dlatego przechodzi przez ten sam filtr, co reszta pól opisowych.
  const category = sanitize(mo.identifier1);
  if (category) notes.push(`Kategoria CMA: ${category}`);
  const extra2 = sanitize(mo.extraData2);
  if (extra2) notes.push(`Dopłaty: ${extra2}`);
  const crew = sanitize(mo.defaultCrew);
  if (crew) notes.push(`Patrol: ${crew}`);
  if ((mo.monitoringStart ?? "").trim()) notes.push(`Monitoring od: ${(mo.monitoringStart ?? "").trim()}`);
  if (end) notes.push(`Monitoring do: ${end}`);
  const locDesc = sanitize(mo.locationDescription);
  if (locDesc) notes.push(`Lokalizacja: ${locDesc.slice(0, 300)}`);
  const objDesc = sanitize(mo.objectDescription);
  if (objDesc) notes.push(`Opis: ${objDesc.slice(0, 300)}`);
  for (const row of invoiceRows) {
    const netto = parseMoney(row.netto ?? null);
    if (netto === null) continue;
    const count = invoiceObjectsCount.get(row) ?? 0;
    const client = (row.client ?? row.invoiceClient ?? "—").toString();
    if (count > 1) {
      // Kwoty zbiorczej nie dzielimy między obiekty — zapisujemy ją jako informację.
      notes.push(`Fakturowanie zbiorcze: ${client} ${flagOf(row)} ${netto} zł netto/mies. (${count} obiektów)`);
    } else if (row !== soleAbonament) {
      // Dodatkowa usługa tego samego klienta (podjazdy, wynajem) — nie jest abonamentem.
      notes.push(`Fakturowanie: ${flagOf(row)} ${netto} zł netto/mies.`);
    }
  }
  notes.push(`ID CMA: ${d.externalId}`);
  notes.push(CMA_NOTE);

  const invoiceForCompany = soleAbonament ?? invoiceRows[0];
  const companyName = invoiceForCompany ? invoiceSheetToCompany(invoiceForCompany.sheet ?? invoiceForCompany.invoiceSheet) : null;

  const key = `cma:${d.externalId}`;
  const plan: PlannedObject = {
    key,
    nip,
    name: (mo.name ?? d.cmaName).trim(),
    address: streetFrom(mo),
    city: titleCaseCity(mo.city),
    latitude: parseCoord(mo.latitude),
    longitude: parseCoord(mo.longitude),
    hasSswin,
    hasCameras,
    hasOfi,
    cameraCount: hasCameras ? (cameras > 0 ? cameras : null) : cameras > 0 ? cameras : null,
    // Okres świadczenia wprost z rejestru CMA. Daty przepuszczamy przez wzorzec
    // ISO — rejestr potrafi nieść pusty string albo datę w innym formacie, a
    // `object_services.start_date` jest NOT NULL i musi dać się porównywać.
    serviceStart: ISO_DATE_RE.test((mo.monitoringStart ?? "").trim())
      ? (mo.monitoringStart ?? "").trim()
      : null,
    serviceEnd: ISO_DATE_RE.test(end) ? end : null,
    status,
    monthlyValue,
    companyName,
    notes: notes.join("\n"),
    externalIds: [d.externalId],
    hrNames: d.hrObject ? [d.hrObject] : [],
    origin: "cma",
  };
  if (extraNote) plan.notes = plan.notes + "\n" + extraNote;
  planned.push(plan);
  plannedByKey.set(key, plan);
  return plan;
}

for (const d of cmaDecisions) {
  const mo = monitoredByExternal.get(d.externalId);
  if (!mo) {
    warn(`decyzja dla CMA ${d.externalId} („${d.cmaName}”) nie ma odpowiednika w monitored_objects — pominięta`);
    continue;
  }
  if (d.decision === "internal") {
    internalCma.push(d);
    continue;
  }
  const nip = nipForCma(d);
  if (!nip) {
    const reason =
      d.decision === "nip"
        ? `decyzja „nip”, ale NIP ${d.nip ?? "—"} nie występuje w kartotece zweryfikowanych (podmiot zagraniczny?)`
        : d.decision === "noNip"
          ? "kontrahent bez NIP-u w KONTRAHENCI"
          : "brak kontrahenta w KONTRAHENCI";
    toComplete.push({
      externalId: d.externalId,
      name: d.cmaName,
      contractorName: d.contractorName,
      city: titleCaseCity(mo.city),
      service: (mo.groups ?? "").trim() || "—",
      price: (mo.extraData1 ?? "").trim() || "—",
      source: `CMA (${d.decision})`,
      reason,
    });
    continue;
  }
  buildPlanFromCma(d, mo, nip);
}

const cmaObjectByExternal = new Map<number, PlannedObject>();
for (const p of planned) for (const id of p.externalIds) cmaObjectByExternal.set(id, p);

// --- Posterunki OFI: obiekty biorą się z kadr (hr.json), spółka z arkusza SK -----
//
// Arkusz SK ma wiersze ZBIORCZE („PINOKIO, ORZYCKA, TYNIECKA, WŁODARZEWSKA” na jednej
// spółce), więc nie da się z niego wyprowadzić obiektów bez zgadywania — służy wyłącznie
// do przypisania spółki komandytowej (`objects.company_id`). Obiekty pochodzą z rejestru
// CMA, a te bez CMA (posterunek ochrony fizycznej bez monitoringu) ze słownika kadr.
function newOfiPost(opts: { nip: string; name: string; hrName: string | null; sourceNote: string }): PlannedObject | null {
  const contractor = contractorsByNip.get(opts.nip);
  if (!contractor) return null;
  const key = `ofi:${opts.nip}:${norm(opts.name)}`;
  const existing = plannedByKey.get(key);
  if (existing) {
    if (opts.hrName && !existing.hrNames.includes(opts.hrName)) existing.hrNames.push(opts.hrName);
    return existing;
  }
  const plan: PlannedObject = {
    key,
    nip: opts.nip,
    name: opts.name,
    address: (contractor.address ?? "").trim() || null,
    city: titleCaseCity(contractor.city),
    latitude: null,
    longitude: null,
    hasSswin: false,
    hasCameras: false,
    hasOfi: true,
    cameraCount: null,
    // Posterunek z kadr nie ma daty startu w źródle — okres zaczyna się datą importu.
    serviceStart: null,
    serviceEnd: null,
    status: "active",
    monthlyValue: null,
    companyName: null,
    notes: opts.sourceNote,
    externalIds: [],
    hrNames: opts.hrName ? [opts.hrName] : [],
    origin: "ofi",
  };
  planned.push(plan);
  plannedByKey.set(key, plan);
  return plan;
}

/** Rozbieżność źródeł zapisujemy w obiekcie — pierwszeństwo ma zawsze decyzja z cma-*.json. */
function noteConflict(plan: PlannedObject, source: string, otherNip: string, otherName: string | null) {
  const line = `Rozbieżność źródeł: ${source} wskazuje ${otherName ?? "innego kontrahenta"} (NIP ${otherNip}); przyjęto płatnika z rejestru CMA (NIP ${plan.nip}).`;
  if (!plan.notes.includes(line)) plan.notes = `${plan.notes}\n${line}`;
}

const cmaDecisionByExternal = new Map(cmaDecisions.map((d) => [d.externalId, d]));
/** Pozycja przestaje być „do uzupełnienia”, gdy inne źródło jednak wskazało płatnika. */
function dropFromToComplete(externalId: number) {
  for (let i = toComplete.length - 1; i >= 0; i--) if (toComplete[i].externalId === externalId) toComplete.splice(i, 1);
}

/** Obiekt, do którego odnosi się wiersz kadrowy/SK — po ID z CMA albo po nazwie posterunku. */
const plannedByHrName = new Map<string, PlannedObject>();
for (const p of planned) for (const n of p.hrNames) plannedByHrName.set(norm(n), p);

for (const h of hrDecisions ?? []) {
  const nip = h.decision === "nip" ? normalizeNIP(h.nip ?? "") : (supplementByName.get(norm(h.contractorName ?? "")) ?? "");
  const cmaPlan = h.cmaExternalId !== null ? (cmaObjectByExternal.get(h.cmaExternalId) ?? null) : null;

  if (cmaPlan) {
    // Obiekt już jest (z CMA) — kadry tylko go dowiązują. Gdy kadry wskazują innego
    // płatnika niż rejestr CMA, wygrywa CMA, a różnica idzie do notatki obiektu.
    if (!cmaPlan.hrNames.includes(h.hrName)) cmaPlan.hrNames.push(h.hrName);
    cmaPlan.hasOfi = true;
    if (nip && nip !== cmaPlan.nip) noteConflict(cmaPlan, "słownik kadr", nip, h.contractorName);
    plannedByHrName.set(norm(h.hrName), cmaPlan);
    continue;
  }

  // Rejestr CMA zna obiekt, ale nie znał płatnika (decyzja „new”/„noNip”), a kadry znają go
  // z listy płac — wtedy obiekt powstaje z danych CMA, z płatnikiem od kadr, i pozycja rejestru
  // zostaje dowiązana zamiast zawisnąć w raporcie do uzupełnienia.
  if (h.cmaExternalId !== null && nip && contractorsByNip.has(nip)) {
    const decision = cmaDecisionByExternal.get(h.cmaExternalId);
    const mo = monitoredByExternal.get(h.cmaExternalId);
    if (decision && mo && decision.decision !== "internal") {
      const revived = buildPlanFromCma(
        decision,
        mo,
        nip,
        `Płatnik ustalony ze słownika kadr (posterunek ${h.hrName}) — rejestr CMA nie wskazywał kontrahenta.`
      );
      revived.hasOfi = true;
      if (!revived.hrNames.includes(h.hrName)) revived.hrNames.push(h.hrName);
      cmaObjectByExternal.set(h.cmaExternalId, revived);
      plannedByHrName.set(norm(h.hrName), revived);
      dropFromToComplete(h.cmaExternalId);
      continue;
    }
  }

  if (!nip || !contractorsByNip.has(nip)) {
    toComplete.push({
      externalId: h.cmaExternalId,
      name: h.hrName,
      contractorName: h.contractorName,
      city: null,
      service: "OFI (posterunek kadrowy)",
      price: "—",
      source: "hr_objects",
      reason:
        h.decision === "nip"
          ? `NIP ${h.nip ?? "—"} spoza kartoteki zweryfikowanych`
          : "brak kontrahenta z NIP-em (wspólnota spoza KONTRAHENCI) — hr_objects.object_id zostaje puste",
    });
    continue;
  }

  const plan = newOfiPost({
    nip,
    name: h.hrName,
    hrName: h.hrName,
    sourceNote: `Posterunek OFI z kadr (hr_objects: ${h.hrName})\n${SOURCE_NOTE}`,
  });
  if (plan) plannedByHrName.set(norm(h.hrName), plan);
}

for (const s of skDecisions ?? []) {
  if (s.decision === "empty") continue;
  const companyName = (s.company ?? "").trim();
  if (!companyName) continue;
  if (companyIdFor(companyName) === null) {
    missingCompanies.add(companyName);
    continue;
  }
  const target =
    (s.cmaExternalId !== null ? cmaObjectByExternal.get(s.cmaExternalId) : undefined) ??
    (s.hrObject ? plannedByHrName.get(norm(s.hrObject)) : undefined);
  if (!target) {
    if ((s.objectName ?? "").trim()) {
      toComplete.push({
        externalId: s.cmaExternalId,
        name: (s.objectName ?? "").trim(),
        contractorName: s.contractorName,
        city: null,
        service: "OFI (ochrona fizyczna)",
        price: "—",
        source: `SK ${companyName}`,
        reason:
          s.decision === "nip"
            ? `NIP ${s.nip ?? "—"} spoza kartoteki albo obiekt nie powstał z CMA/kadr`
            : "brak kontrahenta z NIP-em — obiekt nie powstał z CMA ani z kadr",
      });
    }
    continue;
  }
  target.hasOfi = true;
  // Spółka komandytowa obsługująca posterunek; nie nadpisujemy spółki z fakturowania.
  if (!target.companyName) target.companyName = companyName;
  const skNip = s.decision === "nip" ? normalizeNIP(s.nip ?? "") : "";
  if (skNip && skNip !== target.nip && target.origin === "cma") noteConflict(target, "arkusz SK", skNip, s.contractorName);
}

// Kontrahenci aktywni = ci, którzy mają obiekt albo są fakturowani
const activeNips = new Set<string>();
for (const p of planned) activeNips.add(p.nip);
for (const d of cmaDecisions) if (d.decision === "nip" && d.nip) activeNips.add(normalizeNIP(d.nip));
for (const s of skDecisions ?? []) if (s.nip) activeNips.add(normalizeNIP(s.nip));
for (const h of hrDecisions ?? []) if (h.nip) activeNips.add(normalizeNIP(h.nip));
for (const row of invoices ?? []) if (row.nip) activeNips.add(normalizeNIP(row.nip));

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------
const before = {
  kontrahenci: db.select().from(schema.contractors).all().length,
  obiekty: db.select().from(schema.objects).all().length,
};

console.log(
  `\nTryb: ${rebuild ? "PRZEBUDOWA (kasuje kartotekę demo)" : "PRZYROSTOWY"}${apply ? " + ZAPIS" : " — suchy przebieg"}`
);
console.log(`W bazie teraz: kontrahentów ${before.kontrahenci}, obiektów ${before.obiekty}`);
console.log(
  `Do wgrania: kontrahentów ${contractorsByNip.size} (aktywnych ${[...contractorsByNip.keys()].filter((n) => activeNips.has(n)).length}), obiektów ${planned.length} (CMA ${planned.filter((p) => p.origin === "cma").length}, posterunki OFI ${planned.filter((p) => p.origin === "ofi").length})`
);

const LOG_ENTITIES = ["calendar_event", "protocol", "quote", "realization", "object", "contractor", "order"];
const stats = { contractorsInserted: 0, contractorsSkipped: 0, objectsInserted: 0, objectsSkipped: 0, moLinked: 0, hrLinked: 0, companySet: 0 };

if (apply) {
  const attachments = rebuild ? db.select().from(schema.calendarNoteAttachments).all() : [];

  db.transaction((tx) => {
    if (rebuild) {
      // Rozwiązujemy powiązania, zanim znikną cele — FK są ON (src/db/index.ts), ale
      // wykonujemy to jawnie, żeby nie zależeć od trybu połączenia.
      tx.update(schema.monitoredObjects).set({ objectId: null }).run();
      tx.update(schema.hrObjects).set({ objectId: null }).run();
      tx.update(schema.offers).set({ contractorId: null, objectId: null }).run();

      tx.delete(schema.calendarEventNotes).run();
      tx.delete(schema.calendarEventAssignees).run();
      tx.delete(schema.calendarEvents).run();
      tx.delete(schema.calendarSeries).run();
      tx.delete(schema.quotes).run();
      tx.delete(schema.protocols).run();
      tx.delete(schema.realizations).run();
      tx.delete(schema.orders).run();
      tx.delete(schema.objectHistory).run();
      tx.delete(schema.objects).run();
      tx.delete(schema.contractors).run();
      tx.delete(schema.salespeople).run();
      tx.delete(schema.activityLog).where(inArray(schema.activityLog.entityType, LOG_ENTITIES)).run();
    }

    // --- Kontrahenci ---
    const existingContractors = tx.select().from(schema.contractors).all();
    const contractorIdByNip = new Map(existingContractors.map((c) => [normalizeNIP(c.nip), c.id]));
    for (const [nip, c] of contractorsByNip) {
      if (contractorIdByNip.has(nip)) {
        stats.contractorsSkipped++;
        continue;
      }
      const row = tx
        .insert(schema.contractors)
        .values({
          name: contractorName(c),
          nip,
          address: (c.address ?? "").trim() || null,
          city: (c.city ?? "").trim() || null,
          postalCode: (c.postalCode ?? "").trim() || null,
          phone: (c.phone ?? "").trim() || null,
          email: (c.email ?? "").trim() || null,
          contactPerson: null,
          notes: contractorNotes(c),
          regon: (c.regon ?? "").trim() || null,
          krs: (c.krs ?? "").trim() || null,
          vatStatus: (c.vatStatus ?? "").trim() || null,
          vatCheckedAt: (c.vatCheckedAt ?? "").trim() || null,
          active: activeNips.has(nip),
        })
        .returning({ id: schema.contractors.id })
        .get();
      contractorIdByNip.set(nip, row.id);
      stats.contractorsInserted++;
    }

    // --- Obiekty ---
    const moRows = tx.select().from(schema.monitoredObjects).all();
    const moByExternal = new Map(moRows.map((m) => [m.externalId, m]));
    const objectRows = tx.select().from(schema.objects).all();
    const objectIdByPair = new Map(objectRows.map((o) => [`${o.contractorId}:${norm(o.name)}`, o.id]));
    const objectCompanyById = new Map(objectRows.map((o) => [o.id, o.companyId]));

    for (const p of planned) {
      const contractorId = contractorIdByNip.get(p.nip);
      if (!contractorId) continue;
      const companyId = companyIdFor(p.companyName);

      let objectId: number | null = null;
      for (const ext of p.externalIds) {
        const mo = moByExternal.get(ext);
        if (mo?.objectId) {
          objectId = mo.objectId;
          break;
        }
      }
      if (objectId === null) objectId = objectIdByPair.get(`${contractorId}:${norm(p.name)}`) ?? null;

      if (objectId === null) {
        const inserted = tx
          .insert(schema.objects)
          .values({
            contractorId,
            name: p.name,
            address: p.address,
            city: p.city,
            type: legacyObjectType({ hasCameras: p.hasCameras, hasSswin: p.hasSswin, hasOfi: p.hasOfi, hasVideoreception: false }),
            hasSswin: p.hasSswin,
            hasCameras: p.hasCameras,
            cameraCount: p.cameraCount,
            hasOfi: p.hasOfi,
            hasVideoreception: false,
            installationType: "takeover",
            status: p.status,
            department: "technical",
            // Abonament trafia do kartoteki ROZBITY na linie (ZDW / OFI) — tą
            // samą regułą, co migracja 0082 (src/lib/abonament-split.ts).
            // Kwota z rejestru CMA (`extra_data1`) wycenia monitoring, więc
            // obiekt mieszany dostaje ją na ZDW.
            ...(() => {
              const split = splitAbonament({
                monthlyValue: p.monthlyValue,
                hasOfi: p.hasOfi,
                hasCameras: p.hasCameras,
                hasSswin: p.hasSswin,
                hasVideoreception: false,
                notes: p.notes,
                priceFromCma: p.origin === "cma",
              });
              return { monthlyZdw: split.monthlyZdw, monthlyOfi: split.monthlyOfi };
            })(),
            notes: p.notes,
            latitude: p.latitude,
            longitude: p.longitude,
            companyId,
          })
          .returning({ id: schema.objects.id })
          .get();
        objectId = inserted.id;
        objectIdByPair.set(`${contractorId}:${norm(p.name)}`, objectId);
        objectCompanyById.set(objectId, companyId);
        stats.objectsInserted++;
        /*
         * OKRESY USŁUG (`object_services`) — źródło prawdy, z którego backend
         * przelicza flagi `has_*`. Import buduje kartotekę OD ZERA, więc jako
         * jedyny wolno mu domknąć okres datą `monitoring_end` z rejestru: to nie
         * jest zmiana czyjegoś stanu, tylko przepisanie faktu ze źródła. Start
         * bez daty w rejestrze = data importu — `start_date` jest NOT NULL.
         *
         * Taki zastępczy start leci z `startEstimated`, bo to data URUCHOMIENIA
         * IMPORTU, a nie rozpoczęcia usługi. Bez tej flagi seria czasowa
         * analityki pokazałaby całą wgraną kartotekę jako usługi „rozpoczęte"
         * w miesiącu importu (dokładnie ten artefakt, który dla backfillu 0084
         * naprawia migracja 0087).
         */
        upsertServiceRowsFromFlags(
          tx,
          objectId,
          { hasCameras: p.hasCameras, hasSswin: p.hasSswin, hasOfi: p.hasOfi, cameraCount: p.cameraCount },
          p.serviceStart ?? TODAY,
          { endDate: p.serviceEnd, startEstimated: !p.serviceStart }
        );
      } else {
        // Wiersz już jest (przebieg przyrostowy) — nie nadpisujemy, bo mógł być edytowany
        // w aplikacji. Uzupełniamy tylko puste powiązanie ze spółką.
        stats.objectsSkipped++;
        if (companyId !== null && !objectCompanyById.get(objectId)) {
          tx.update(schema.objects).set({ companyId }).where(eq(schema.objects.id, objectId)).run();
          objectCompanyById.set(objectId, companyId);
          stats.companySet++;
        }
      }

      for (const ext of p.externalIds) {
        const mo = moByExternal.get(ext);
        if (!mo || mo.objectId) continue;
        tx.update(schema.monitoredObjects).set({ objectId }).where(eq(schema.monitoredObjects.id, mo.id)).run();
        mo.objectId = objectId;
        stats.moLinked++;
      }
      for (const hrName of p.hrNames) {
        const hr = hrObjectByName.get(norm(hrName));
        if (!hr) {
          warn(`hr_objects nie ma pozycji „${hrName}” — powiązanie pominięte`);
          continue;
        }
        const current = tx.select().from(schema.hrObjects).where(eq(schema.hrObjects.id, hr.id)).get();
        if (current?.objectId) continue;
        tx.update(schema.hrObjects).set({ objectId }).where(eq(schema.hrObjects.id, hr.id)).run();
        stats.hrLinked++;
      }
    }
  });

  if (rebuild && attachments.length > 0) {
    // Pliki znikają dopiero po commicie — nieudana transakcja nie zostawia bazy bez plików.
    removeStoredFiles(attachments);
  }
}

// ---------------------------------------------------------------------------
// Raporty
// ---------------------------------------------------------------------------
const afterContractors = db.select().from(schema.contractors).all();
const afterObjects = db.select().from(schema.objects).all();
const afterMonitored = db.select().from(schema.monitoredObjects).all();
const afterHr = db.select().from(schema.hrObjects).all();
const contractorById = new Map(afterContractors.map((c) => [c.id, c]));

const activeContractors = afterContractors.filter((c) => c.active).length;
const objectsByStatus = new Map<string, number>();
for (const o of afterObjects) objectsByStatus.set(o.status, (objectsByStatus.get(o.status) ?? 0) + 1);
const withCameras = afterObjects.filter((o) => o.hasCameras).length;
const withOfi = afterObjects.filter((o) => o.hasOfi).length;
const withSswin = afterObjects.filter((o) => o.hasSswin).length;
const withCompany = afterObjects.filter((o) => o.companyId !== null).length;
const withoutPrice = afterObjects.filter((o) => o.monthlyZdw === null && o.monthlyOfi === null);
const withoutCoords = afterObjects.filter((o) => o.latitude === null || o.longitude === null);
const linkedMonitored = afterMonitored.filter((m) => m.objectId !== null).length;
const linkedHr = afterHr.filter((h) => h.objectId !== null).length;
const nonActiveVat = afterContractors.filter(
  (c) => (c.vatStatus ?? "") !== "Czynny" && afterObjects.some((o) => o.contractorId === c.id)
);

const md: string[] = [];
md.push(`# Raport importu bazy obiektowej — ${TODAY}`);
md.push("");
md.push(`Tryb: **${rebuild ? "przebudowa (--rebuild)" : "przyrostowy"}${apply ? " + zapis (--apply)" : " — suchy przebieg, nic nie zapisano"}**`);
md.push(`Baza: \`${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}\``);
md.push("");
md.push("## Liczby");
md.push("");
md.push("| Pozycja | Wartość |");
md.push("| --- | --- |");
md.push(`| Kontrahenci w bazie | ${afterContractors.length} |`);
md.push(`| — aktywni (mają obiekt / są fakturowani) | ${activeContractors} |`);
md.push(`| — archiwalni (sam słownik księgowy) | ${afterContractors.length - activeContractors} |`);
md.push(`| Obiekty w bazie | ${afterObjects.length} |`);
for (const [st, n] of [...objectsByStatus].sort()) md.push(`| — status ${st} | ${n} |`);
md.push(`| — z kamerami | ${withCameras} |`);
md.push(`| — z OFI | ${withOfi} |`);
md.push(`| — z SSWiN | ${withSswin} |`);
md.push(`| — ze spółką fakturującą | ${withCompany} |`);
md.push(`| — bez abonamentu (monthly_zdw i monthly_ofi NULL) | ${withoutPrice.length} |`);
md.push(`| — bez współrzędnych | ${withoutCoords.length} |`);
md.push(`| monitored_objects powiązane z kartoteką | ${linkedMonitored} / ${afterMonitored.length} |`);
md.push(`| hr_objects powiązane z kartoteką | ${linkedHr} / ${afterHr.length} |`);
md.push("");
md.push(
  `Wstawione w tym przebiegu: kontrahentów ${stats.contractorsInserted} (pominiętych jako istniejące ${stats.contractorsSkipped}), obiektów ${stats.objectsInserted} (istniejących ${stats.objectsSkipped}), nowych powiązań CMA ${stats.moLinked}, kadrowych ${stats.hrLinked}, uzupełnionych spółek ${stats.companySet}.`
);
md.push("");

md.push(`## Obiekty wewnętrzne / testowe — nie trafiają do kartoteki (${internalCma.length})`);
md.push("");
md.push("| ID CMA | Nazwa | Uzasadnienie |");
md.push("| --- | --- | --- |");
for (const d of internalCma) md.push(`| ${d.externalId} | ${d.cmaName} | ${(d.note ?? "").replace(/\|/g, "/").slice(0, 160)} |`);
md.push("");

md.push(`## Kontrahenci z obiektami, których status VAT ≠ „Czynny” (${nonActiveVat.length})`);
md.push("");
if (nonActiveVat.length === 0) md.push("Brak — wszyscy płatnicy z obiektami są czynnymi podatnikami VAT.");
else for (const c of nonActiveVat) md.push(`- ${c.name} (NIP ${c.nip}) — ${c.vatStatus ?? "brak danych"}`);
md.push("");

md.push(`## Obiekty bez abonamentu (${withoutPrice.length})`);
md.push("");
md.push(
  withoutPrice.length === 0
    ? "Brak."
    : withoutPrice.map((o) => `- ${o.name} — ${contractorById.get(o.contractorId)?.name ?? "?"}`).join("\n")
);
md.push("");
md.push(`## Obiekty bez współrzędnych (${withoutCoords.length})`);
md.push("");
md.push(withoutCoords.length === 0 ? "Brak." : withoutCoords.map((o) => `- ${o.name}`).join("\n"));
md.push("");

if (missingCompanies.size > 0) {
  md.push(`## Spółki do dodania w słowniku \`companies\` (${missingCompanies.size})`);
  md.push("");
  md.push(
    "Arkusz SK przypisuje im posterunki, ale słownik spółek (Kadry → Spółki) ich nie zna — te obiekty " +
      "zostały wgrane z pustym `company_id`. Dopisz spółki i uruchom przebieg przyrostowy (`--apply` bez `--rebuild`), " +
      "który uzupełni puste przypisania."
  );
  md.push("");
  md.push([...missingCompanies].sort().map((n) => `- ${n}`).join("\n"));
  md.push("");
}

if (warnings.length > 0) {
  md.push(`## Ostrzeżenia (${warnings.length})`);
  md.push("");
  md.push([...new Set(warnings)].map((w) => `- ${w}`).join("\n"));
  md.push("");
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "RAPORT-import.md"), md.join("\n") + "\n", "utf8");

const todo: string[] = [];
todo.push(`# Obiekty do uzupełnienia — ${TODAY}`);
todo.push("");
todo.push(
  "Te pozycje NIE zostały wgrane do kartoteki: nie znamy NIP-u płatnika, a `contractors.nip` jest wymagany i walidowany. " +
    "Pozostają widoczne w rejestrze CMA. Żeby je zaimportować: dopisz wpis do `scripts/data/kontrahenci-uzupelnienie.json` " +
    "(`{ \"nip\": \"...\", \"matchCma\": [ID], \"matchNames\": [\"nazwa z kolumny „proponowany kontrahent”\"] }`) " +
    "i uruchom `npx tsx scripts/import-baza-obiektowa.ts --apply` (przyrostowo, bez `--rebuild`)."
);
todo.push("");
todo.push(`Pozycji: **${toComplete.length}**`);
todo.push("");
todo.push("| ID CMA | Nazwa | Proponowany kontrahent | Miasto | Usługa / grupy | Cena z CMA | Skąd | Dlaczego |");
todo.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const t of toComplete.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pl"))) {
  const cell = (v: string | null | undefined) => (v ?? "—").toString().replace(/\|/g, "/").replace(/\n/g, " ");
  todo.push(
    `| ${t.externalId ?? "—"} | ${cell(t.name)} | ${cell(t.contractorName)} | ${cell(t.city)} | ${cell(t.service)} | ${cell(t.price)} | ${cell(t.source)} | ${cell(t.reason)} |`
  );
}
todo.push("");
writeFileSync(join(OUT_DIR, "RAPORT-do-uzupelnienia.md"), todo.join("\n") + "\n", "utf8");

console.log(md.join("\n"));
console.log(`\nDo uzupełnienia (bez NIP-u płatnika): ${toComplete.length} pozycji → obiekty/RAPORT-do-uzupelnienia.md`);
console.log(`Raport: obiekty/RAPORT-import.md`);
if (!apply) console.log("\nSuchy przebieg — w bazie nic nie zmieniono. Uruchom z --apply (pierwszy raz razem z --rebuild).");
