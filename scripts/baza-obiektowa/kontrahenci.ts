/**
 * ETAP „KONTRAHENCI” bazy obiektowej — z eksportu księgowego robi zweryfikowany,
 * zdeduplikowany słownik kontrahentów gotowy do importu.
 *
 *   npx tsx scripts/baza-obiektowa/kontrahenci.ts             # pełny przebieg (odpytuje wykaz MF)
 *   npx tsx scripts/baza-obiektowa/kontrahenci.ts --skip-mf   # bez sieci, na danych z poprzedniego przebiegu
 *
 * Źródło: obiekty/KONTRAHENCI.XLSX, arkusz „Sheet” (mieszanka klientów i dostawców,
 * jeden kontrahent potrafi mieć kilkanaście wierszy — po jednym na umowę/urządzenie/samochód:
 * „T-MOBILE 7965”, „TOYOTA WD6132S CYBULSKI”). Deduplikujemy po NIP-ie, a etykiety z kolumny
 * „Nazwa firmy” zbieramy w `aliases[]` — po nich będzie się dało dopasować obiekty z OBIEKTY.XLSX.
 *
 * NIP-ów NIE zgadujemy: wiersz z błędną sumą kontrolną albo bez numeru ląduje w pliku odrzuconych.
 * Skrypt niczego nie zapisuje do bazy — produkuje wyłącznie JSON-y w scripts/data/.
 *
 * Wynik:
 *   scripts/data/kontrahenci-zweryfikowani.json  — jeden rekord na NIP
 *   scripts/data/kontrahenci-odrzuceni.json      — wiersze bez użytecznego NIP-u (z powodem)
 *   $S/baza/kontrahenci-raport.md                — raport liczbowy + próbki do przejrzenia
 */
import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";
import { isMfError, lookupCompanyByNip } from "../../src/lib/mf-whitelist.js";
import { zonedToday } from "../../src/lib/tz.js";
import { normalizeNIP, validateNIP } from "../../src/utils/nip.js";

// ---------------------------------------------------------------------------
// Ścieżki i parametry
// ---------------------------------------------------------------------------

const REPO = path.resolve(import.meta.dirname, "../..");
const XLSX_PATH = path.join(REPO, "obiekty/KONTRAHENCI.XLSX");
const SHEET = "Sheet";
const OUT_OK = path.join(REPO, "scripts/data/kontrahenci-zweryfikowani.json");
const OUT_REJECTED = path.join(REPO, "scripts/data/kontrahenci-odrzuceni.json");
const REPORT_PATH =
  process.env.KONTRAHENCI_RAPORT ||
  path.join(
    "/tmp/claude-1000/-config-workspace-programming-alfa-app",
    "913bea21-d7b7-43f1-929f-335f6f89b018/scratchpad/baza/kontrahenci-raport.md"
  );

const skipMf = process.argv.includes("--skip-mf");
const THROTTLE_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------

interface Row {
  ID: unknown;
  "Nazwa firmy"?: unknown;
  "Status VAT"?: unknown;
  "Rzetelność"?: unknown;
  "Tel. kom."?: unknown;
  Email?: unknown;
  Nip?: unknown;
  Regon?: unknown;
  "Województwo"?: unknown;
  "Państwo"?: unknown;
  Kod?: unknown;
  "Miejscowość"?: unknown;
  Ulica?: unknown;
  Nr?: unknown;
  "Forma płatności"?: unknown;
  "Pełna nazwa firmy"?: unknown;
}

/** Dane tak, jak stoją w pliku księgowym — zostają przy rekordzie na wypadek sporu z MF. */
interface SourceData {
  name: string;
  address: string;
  postalCode: string;
  city: string;
  voivodeship: string;
  country: string;
  email: string;
  phone: string;
  paymentForm: string;
  regon: string;
  vatStatus: string;
  reliability: string;
}

interface Contractor {
  nip: string;
  name: string;
  nameFromFile: string;
  aliases: string[];
  sourceIds: (number | string)[];
  address: string;
  postalCode: string;
  city: string;
  voivodeship: string;
  email: string;
  phone: string;
  paymentForm: string;
  regon: string;
  krs: string;
  vatStatus: string;
  vatCheckedAt: string;
  mf: { found: boolean; error?: string };
  source: SourceData;
}

interface Rejected {
  reason: "invalid_nip" | "no_nip" | "foreign";
  sourceId: number | string;
  name: string;
  fullName: string;
  nipRaw: string;
  country: string;
  city: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

const txt = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

/** „Polska” / „POLSKA” / puste = krajowy. Cokolwiek innego traktujemy jako podmiot zagraniczny. */
function isDomestic(country: string): boolean {
  const c = country.toLowerCase().replace(/\./g, "").trim();
  return c === "" || c === "polska" || c === "pl" || c === "rzeczpospolita polska";
}

/** Ulica + numer w jedno pole `address` (schemat contractors nie ma osobnego numeru). */
function joinAddress(street: string, no: string): string {
  if (!street) return no;
  if (!no) return street;
  return `${street} ${no}`;
}

/** Do porównywania nazw: bez interpunkcji, bez form prawnych, wersaliki. */
function nameKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ/g, "SP Z OO")
    .replace(/SPÓŁKA AKCYJNA/g, "SA")
    .replace(/SPÓŁKA KOMANDYTOWA/g, "SP K")
    .replace(/SPÓŁKA JAWNA/g, "SP J")
    .replace(/SPÓŁKA CYWILNA/g, "SC")
    .replace(/\bSP\.? ?Z ?O\.? ?O\.?\b/g, "SP Z OO")
    .replace(/[^A-ZĄĆĘŁŃÓŚŹŻ0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Podobieństwo nazw (Jaccard na słowach) — służy tylko do wskazania rekordów do obejrzenia. */
function nameSimilarity(a: string, b: string): number {
  const A = new Set(nameKey(a).split(" ").filter(Boolean));
  const B = new Set(nameKey(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common);
}

// ---------------------------------------------------------------------------
// 1. Wczytanie i klasyfikacja wierszy
// ---------------------------------------------------------------------------

if (!fs.existsSync(XLSX_PATH)) {
  console.error(`Brak pliku źródłowego: ${XLSX_PATH}`);
  process.exit(1);
}

const workbook = xlsx.readFile(XLSX_PATH);
const sheet = workbook.Sheets[SHEET];
if (!sheet) {
  console.error(`Arkusz „${SHEET}” nie istnieje. Dostępne: ${workbook.SheetNames.join(", ")}`);
  process.exit(1);
}
const rows = xlsx.utils.sheet_to_json<Row>(sheet, { defval: "" });

const rejected: Rejected[] = [];
/** NIP → wiersze tego samego podmiotu. */
const groups = new Map<string, Row[]>();

for (const row of rows) {
  const sourceId = (typeof row.ID === "number" ? row.ID : txt(row.ID)) as number | string;
  const label = txt(row["Nazwa firmy"]);
  const fullName = txt(row["Pełna nazwa firmy"]);
  const nipRaw = txt(row.Nip);
  const country = txt(row["Państwo"]);
  const base = { sourceId, name: label, fullName, nipRaw, country, city: txt(row["Miejscowość"]) };

  if (!isDomestic(country)) {
    rejected.push({ ...base, reason: "foreign", detail: `podmiot zagraniczny (Państwo: ${country})` });
    continue;
  }
  if (!nipRaw) {
    rejected.push({ ...base, reason: "no_nip", detail: "brak NIP-u w pliku" });
    continue;
  }

  const nip = normalizeNIP(nipRaw);
  if (!validateNIP(nip)) {
    rejected.push({
      ...base,
      reason: "invalid_nip",
      detail:
        nip.length !== 10
          ? `NIP ma ${nip.length} cyfr zamiast 10`
          : "błędna suma kontrolna",
    });
    continue;
  }

  const bucket = groups.get(nip);
  if (bucket) bucket.push(row);
  else groups.set(nip, [row]);
}

// ---------------------------------------------------------------------------
// 2. Scalanie wierszy jednego NIP-u w jednego kontrahenta
// ---------------------------------------------------------------------------

/** Najczęstsza wartość; przy remisie wygrywa dłuższa (pełniejsza) — i zawsze niepusta. */
function pickDominant(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v.length > best.length)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

const firstNonEmpty = (values: string[]): string => values.find((v) => v) ?? "";

interface Merged {
  nip: string;
  nameFromFile: string;
  aliases: string[];
  sourceIds: (number | string)[];
  source: SourceData;
}

const merged: Merged[] = [];

for (const [nip, bucket] of groups) {
  const fullNames = bucket.map((r) => txt(r["Pełna nazwa firmy"]));
  const labels = bucket.map((r) => txt(r["Nazwa firmy"]));
  // Gdy „Pełna nazwa firmy” jest pusta, spada na etykietę z „Nazwa firmy”.
  const nameFromFile = pickDominant(fullNames) || pickDominant(labels);

  // Etykiety różne od nazwy głównej to aliasy — po nich dopasujemy obiekty i faktury.
  const canonical = nameKey(nameFromFile);
  const aliases = [...new Set([...labels, ...fullNames])]
    .filter((v) => v && nameKey(v) !== canonical)
    .sort((a, b) => a.localeCompare(b, "pl"));

  // Adres bierzemy z wiersza „głównego” (o nazwie kanonicznej), reszta pól — pierwsza niepusta.
  const primary =
    bucket.find((r) => nameKey(txt(r["Pełna nazwa firmy"])) === canonical) ??
    bucket.find((r) => nameKey(txt(r["Nazwa firmy"])) === canonical) ??
    bucket[0];

  merged.push({
    nip,
    nameFromFile,
    aliases,
    sourceIds: bucket.map((r) => (typeof r.ID === "number" ? r.ID : txt(r.ID))),
    source: {
      name: nameFromFile,
      address: joinAddress(txt(primary.Ulica), txt(primary.Nr)),
      postalCode: txt(primary.Kod),
      city: txt(primary["Miejscowość"]),
      voivodeship: txt(primary["Województwo"]),
      country: txt(primary["Państwo"]),
      email: firstNonEmpty(bucket.map((r) => txt(r.Email))),
      phone: firstNonEmpty(bucket.map((r) => txt(r["Tel. kom."]))),
      paymentForm: pickDominant(bucket.map((r) => txt(r["Forma płatności"]))),
      regon: firstNonEmpty(bucket.map((r) => txt(r.Regon))),
      vatStatus: firstNonEmpty(bucket.map((r) => txt(r["Status VAT"]))),
      reliability: firstNonEmpty(bucket.map((r) => txt(r["Rzetelność"]))),
    },
  });
}

merged.sort((a, b) => a.nameFromFile.localeCompare(b.nameFromFile, "pl"));

// ---------------------------------------------------------------------------
// 3. Wykaz VAT MF
// ---------------------------------------------------------------------------

const today = zonedToday();

/** Poprzedni przebieg — do trybu --skip-mf (i tylko do niego). */
const previous = new Map<string, Contractor>();
if (fs.existsSync(OUT_OK)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_OK, "utf8")) as Contractor[];
    for (const c of parsed) previous.set(c.nip, c);
  } catch {
    // Uszkodzony plik z poprzedniego przebiegu nie może blokować nowego.
  }
}

if (skipMf && previous.size === 0) {
  console.error("--skip-mf, ale nie ma z czego korzystać: brak scripts/data/kontrahenci-zweryfikowani.json");
  process.exit(1);
}

interface MfFields {
  found: boolean;
  error?: string;
  name?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  regon?: string;
  krs?: string;
  statusVat?: string;
}

const mfResults = new Map<string, MfFields>();

/** Błędy sieciowe (timeout / DNS / HTTP) — warte ponowienia; zły NIP już nie. */
function isRetryable(error: string): boolean {
  return !error.includes("Nieprawidłowy NIP");
}

async function askMf(nip: string): Promise<MfFields> {
  const result = await lookupCompanyByNip(nip, { date: today });
  if (isMfError(result)) return { found: false, error: result.error };
  if (!result.found || !result.company) return { found: false };
  const c = result.company;
  return {
    found: true,
    name: c.name,
    address: c.address,
    postalCode: c.postalCode,
    city: c.city,
    regon: c.regon,
    krs: c.krs,
    statusVat: c.statusVat ?? "",
  };
}

if (skipMf) {
  for (const m of merged) {
    const prev = previous.get(m.nip);
    if (!prev) continue;
    mfResults.set(m.nip, {
      found: prev.mf.found,
      error: prev.mf.error,
      name: prev.mf.found ? prev.name : undefined,
      address: prev.mf.found ? prev.address : undefined,
      postalCode: prev.mf.found ? prev.postalCode : undefined,
      city: prev.mf.found ? prev.city : undefined,
      regon: prev.mf.found ? prev.regon : undefined,
      krs: prev.mf.found ? prev.krs : undefined,
      statusVat: prev.mf.found ? prev.vatStatus : undefined,
    });
  }
  console.log(`--skip-mf: użyto ${mfResults.size} wyników z poprzedniego przebiegu (bez sieci).`);
} else {
  console.log(`Odpytuję wykaz MF o ${merged.length} NIP-ów (throttle ${THROTTLE_MS} ms)…`);
  let done = 0;
  for (const m of merged) {
    const res = await askMf(m.nip);
    mfResults.set(m.nip, res);
    done++;
    if (done % 50 === 0) console.log(`  … ${done}/${merged.length}`);
    await sleep(THROTTLE_MS);
  }

  // Jedna runda ponowień dla błędów sieciowych — MF potrafi chwilowo przyciąć ruch.
  const toRetry = merged.filter((m) => {
    const r = mfResults.get(m.nip);
    return r?.error && isRetryable(r.error);
  });
  if (toRetry.length > 0) {
    console.log(`Ponawiam ${toRetry.length} zapytań zakończonych błędem…`);
    for (const m of toRetry) {
      const res = await askMf(m.nip);
      mfResults.set(m.nip, res);
      await sleep(THROTTLE_MS * 2);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Złożenie rekordów — dane MF mają pierwszeństwo, plik zostaje w `source`
// ---------------------------------------------------------------------------

const contractors: Contractor[] = merged.map((m) => {
  const mf = mfResults.get(m.nip) ?? { found: false, error: "brak wyniku MF (przebieg bez sieci)" };
  return {
    nip: m.nip,
    name: mf.found && mf.name ? mf.name : m.nameFromFile,
    nameFromFile: m.nameFromFile,
    aliases: m.aliases,
    sourceIds: m.sourceIds,
    address: mf.found && mf.address ? mf.address : m.source.address,
    postalCode: mf.found && mf.postalCode ? mf.postalCode : m.source.postalCode,
    city: mf.found && mf.city ? mf.city : m.source.city,
    voivodeship: m.source.voivodeship,
    email: m.source.email,
    phone: m.source.phone,
    paymentForm: m.source.paymentForm,
    regon: mf.found && mf.regon ? mf.regon : m.source.regon,
    krs: mf.found ? (mf.krs ?? "") : "",
    // MF nie zna NIP-u → podmiot nie figuruje w wykazie VAT. Błąd zapytania ≠ brak rejestracji.
    vatStatus: mf.found ? (mf.statusVat ?? "") : mf.error ? "" : "Niezarejestrowany",
    vatCheckedAt: mf.error ? "" : today,
    mf: mf.error ? { found: false, error: mf.error } : { found: mf.found },
    source: m.source,
  };
});

fs.mkdirSync(path.dirname(OUT_OK), { recursive: true });
fs.writeFileSync(OUT_OK, JSON.stringify(contractors, null, 2) + "\n", "utf8");
fs.writeFileSync(OUT_REJECTED, JSON.stringify(rejected, null, 2) + "\n", "utf8");

// ---------------------------------------------------------------------------
// 5. Raport
// ---------------------------------------------------------------------------

const found = contractors.filter((c) => c.mf.found).length;
const notFound = contractors.filter((c) => !c.mf.found && !c.mf.error).length;
const errored = contractors.filter((c) => c.mf.error);
const byReason = (r: Rejected["reason"]) => rejected.filter((x) => x.reason === r);

const drift = contractors
  .filter((c) => c.mf.found && nameSimilarity(c.name, c.nameFromFile) < 0.5)
  .map((c) => ({ nip: c.nip, file: c.nameFromFile, mf: c.name, sim: nameSimilarity(c.name, c.nameFromFile) }))
  .sort((a, b) => a.sim - b.sim);

// Ta sama nazwa pod różnymi NIP-ami — zwykle zmiana formy prawnej albo literówka w księgowości.
const byName = new Map<string, Contractor[]>();
for (const c of contractors) {
  const k = nameKey(c.nameFromFile);
  if (!k) continue;
  const b = byName.get(k);
  if (b) b.push(c);
  else byName.set(k, [c]);
}
const nameCollisions = [...byName.values()].filter((v) => v.length > 1);

const L: string[] = [];
L.push("# Kontrahenci — raport weryfikacji", "");
L.push(`Źródło: \`obiekty/KONTRAHENCI.XLSX\` (arkusz „${SHEET}”), przebieg z ${today}${skipMf ? " — tryb `--skip-mf`" : ""}.`, "");
L.push("## Liczby", "");
L.push(`- wierszy w pliku: **${rows.length}**`);
L.push(`- unikalnych poprawnych NIP-ów (rekordów wynikowych): **${contractors.length}**`);
L.push(`- wierszy scalonych w duplikaty: ${rows.length - rejected.length - contractors.length}`);
L.push(`- MF zna NIP: **${found}**, MF nie zna: **${notFound}**, błąd zapytania: **${errored.length}**`);
L.push(`- odrzuconych wierszy: **${rejected.length}** (brak NIP: ${byReason("no_nip").length}, błędny NIP: ${byReason("invalid_nip").length}, zagraniczne: ${byReason("foreign").length})`);
L.push(`- kontrahentów z aliasami: ${contractors.filter((c) => c.aliases.length > 0).length}`);
L.push("");

if (errored.length > 0) {
  L.push("## Błędy zapytań do MF (po ponowieniu)", "");
  for (const c of errored) L.push(`- ${c.nip} — ${c.nameFromFile}: ${c.mf.error}`);
  L.push("");
}

L.push("## Odrzucone — 20 przykładów", "");
for (const r of rejected.slice(0, 20)) {
  L.push(`- [${r.reason}] ID ${r.sourceId} — ${r.name || r.fullName || "(bez nazwy)"} — NIP „${r.nipRaw}” — ${r.detail}`);
}
L.push("");

L.push(`## Nazwa z MF mocno różna od nazwy z pliku (${drift.length}) — do sanity-checku`, "");
for (const d of drift) L.push(`- ${d.nip}: plik „${d.file}” → MF „${d.mf}” (podobieństwo ${d.sim.toFixed(2)})`);
L.push("");

L.push(`## Ta sama nazwa pod różnymi NIP-ami (${nameCollisions.length})`, "");
for (const g of nameCollisions) L.push(`- ${g[0].nameFromFile}: ${g.map((c) => c.nip).join(", ")}`);
L.push("");

const report = L.join("\n");
fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, report, "utf8");

console.log("\n" + report);
console.log(`\nZapisano:\n  ${OUT_OK}\n  ${OUT_REJECTED}\n  ${REPORT_PATH}`);
