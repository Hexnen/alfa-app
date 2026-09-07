/**
 * Sprawdzenie kartoteki po imporcie bazy obiektowej (scripts/import-baza-obiektowa.ts):
 *   npx tsx scripts/test-on-copy.ts scripts/test-baza-obiektowa.ts     # na kopii bazy
 *   ALFA_DB_PATH=… npx tsx scripts/test-baza-obiektowa.ts              # wprost na wskazanej bazie
 *
 * Test jest CZYSTO ODCZYTOWY — niczego nie zapisuje, więc można go puścić także na kopii
 * produkcyjnej bazy zaraz po imporcie. Porównuje stan bazy z plikami mapowań: każda decyzja
 * „nip”, dla której znamy kontrahenta, ma mieć obiekt i dowiązaną pozycję rejestru CMA,
 * a żadne hasło z rejestru nie ma prawa wylądować w notatce obiektu.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, schema } from "../src/db/index.js";
import { normalizeNIP, validateNIP } from "../src/utils/nip.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(ROOT, "scripts", "data", "mapowanie-obiektow");

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

interface CmaDecision {
  externalId: number;
  cmaName: string;
  decision: string;
  nip: string | null;
  contractorName: string | null;
}
interface HrDecision {
  hrName: string;
  decision: string;
  nip: string | null;
  cmaExternalId: number | null;
}

const cma: CmaDecision[] = [];
for (const n of [1, 2, 3]) cma.push(...(readJson<CmaDecision[]>(join(MAP, `cma-${n}.json`)) ?? []));
const hr = readJson<HrDecision[]>(join(MAP, "hr.json")) ?? [];

const contractors = db.select().from(schema.contractors).all();
const objects = db.select().from(schema.objects).all();
const monitored = db.select().from(schema.monitoredObjects).all();
const hrObjects = db.select().from(schema.hrObjects).all();
const companies = db.select().from(schema.companies).all();

const contractorById = new Map(contractors.map((c) => [c.id, c]));
const contractorByNip = new Map(contractors.map((c) => [normalizeNIP(c.nip), c]));
const objectById = new Map(objects.map((o) => [o.id, o]));
const moByExternal = new Map(monitored.map((m) => [m.externalId, m]));
const companyIds = new Set(companies.map((c) => c.id));
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.log(`  BŁĄD ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}
/** Pierwsze kilka przykładów — cała lista w błędzie jest nieczytelna. */
const sample = (items: string[], n = 8) =>
  `${items.length} szt.: ${items.slice(0, n).join(" | ")}${items.length > n ? " …" : ""}`;

console.log(`Baza: ${process.env.ALFA_DB_PATH ?? "./data/alfa.db"}`);
console.log(`Kontrahentów ${contractors.length}, obiektów ${objects.length}, pozycji CMA ${monitored.length}, pozycji kadr ${hrObjects.length}\n`);

// 1. Każdy obiekt ma istniejącego kontrahenta.
{
  const orphans = objects.filter((o) => !contractorById.has(o.contractorId));
  check("każdy obiekt ma kontrahenta", orphans.length === 0, sample(orphans.map((o) => `${o.id} ${o.name}`)));
}

// 2. Każdy NIP w kartotece przechodzi walidację sumą kontrolną i jest unikalny.
{
  const bad = contractors.filter((c) => !validateNIP(c.nip));
  check("każdy NIP kontrahenta przechodzi validateNIP", bad.length === 0, sample(bad.map((c) => `${c.name} (${c.nip})`)));
  const dup = contractors.length - new Set(contractors.map((c) => normalizeNIP(c.nip))).size;
  check("NIP-y kontrahentów bez duplikatów", dup === 0, `duplikatów: ${dup}`);
}

// 3. Każda decyzja „nip”, dla której kontrahent jest w bazie, ma obiekt i dowiązaną pozycję CMA
//    — i to obiekt TEGO płatnika (rejestr CMA ma pierwszeństwo przed kadrami i arkuszem SK).
{
  const expected = cma.filter((d) => d.decision === "nip" && d.nip && contractorByNip.has(normalizeNIP(d.nip)));
  const unlinked: string[] = [];
  const wrongOwner: string[] = [];
  for (const d of expected) {
    const mo = moByExternal.get(d.externalId);
    if (!mo || mo.objectId === null) {
      unlinked.push(`${d.externalId} ${d.cmaName}`);
      continue;
    }
    const obj = objectById.get(mo.objectId);
    const owner = obj ? contractorById.get(obj.contractorId) : undefined;
    if (!owner || normalizeNIP(owner.nip) !== normalizeNIP(d.nip ?? "")) {
      wrongOwner.push(`${d.externalId} ${d.cmaName} → ${owner?.nip ?? "brak"} (oczekiwano ${d.nip})`);
    }
  }
  check(`decyzje „nip” mają obiekt i powiązanie CMA (${expected.length})`, unlinked.length === 0, sample(unlinked));
  check("płatnik obiektu zgodny z decyzją z cma-*.json", wrongOwner.length === 0, sample(wrongOwner));
}

// 4. Pozycje wewnętrzne/testowe zostają niezmapowane (nie ma ich w kartotece klientów).
{
  const internal = cma.filter((d) => d.decision === "internal");
  const linked = internal.filter((d) => moByExternal.get(d.externalId)?.objectId != null);
  check(`pozycje wewnętrzne CMA nie mają obiektu (${internal.length})`, linked.length === 0, sample(linked.map((d) => `${d.externalId} ${d.cmaName}`)));
}

// 5. Każdy obiekt ma źródło: albo pozycję w rejestrze CMA, albo posterunek OFI z kadr.
{
  const linkedObjectIds = new Set(monitored.filter((m) => m.objectId !== null).map((m) => m.objectId as number));
  const hrLinkedIds = new Set(hrObjects.filter((h) => h.objectId !== null).map((h) => h.objectId as number));
  const stray = objects.filter((o) => !linkedObjectIds.has(o.id) && !hrLinkedIds.has(o.id));
  check("każdy obiekt pochodzi z CMA albo z kadr", stray.length === 0, sample(stray.map((o) => `${o.id} ${o.name}`)));
  const ofiOnly = objects.filter((o) => !linkedObjectIds.has(o.id) && hrLinkedIds.has(o.id));
  check(
    `posterunki bez CMA mają usługę OFI (${ofiOnly.length})`,
    ofiOnly.every((o) => o.hasOfi),
    sample(ofiOnly.filter((o) => !o.hasOfi).map((o) => o.name))
  );
}

// 6. Do notatek nie przeciekły hasła, loginy ani adresy urządzeń z rejestru CMA.
{
  const SECRET = /(has[łl]o|has[łl]a|rtsp:|admin\s*[:/]|login|\bpassword\b|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i;
  const leaking = objects.filter((o) => SECRET.test(o.notes ?? ""));
  check(
    "notatki obiektów bez haseł/loginów/adresów IP",
    leaking.length === 0,
    sample(leaking.map((o) => `${o.id} ${o.name}: ${(o.notes ?? "").match(SECRET)?.[0]}`))
  );
}

// 7. Ten sam kontrahent nie ma dwóch obiektów o tej samej nazwie.
{
  const seen = new Map<string, number>();
  const dups: string[] = [];
  for (const o of objects) {
    const key = `${o.contractorId}:${norm(o.name)}`;
    if (seen.has(key)) dups.push(`${o.name} (kontrahent ${o.contractorId})`);
    else seen.set(key, o.id);
  }
  check("brak duplikatów (kontrahent, nazwa obiektu)", dups.length === 0, sample(dups));
}

// 8. Kadry: posterunki z ustalonym płatnikiem są dowiązane, wspólnoty bez NIP-u zostają puste.
{
  const hrByName = new Map(hrObjects.map((h) => [norm(h.name), h]));
  const shouldLink = hr.filter((h) => h.decision === "nip" && h.nip && contractorByNip.has(normalizeNIP(h.nip)));
  const missing = shouldLink.filter((h) => {
    const row = hrByName.get(norm(h.hrName));
    return !row || row.objectId === null;
  });
  check(`posterunki kadr z decyzją „nip” są dowiązane (${shouldLink.length})`, missing.length === 0, sample(missing.map((h) => h.hrName)));

  // „new” = kadry nie znają płatnika. Posterunek bywa mimo to zmapowany, gdy ten sam obiekt
  // ma płatnika w rejestrze CMA — wtedy powiązanie jest w porządku i nie liczy się do testu.
  const shouldStayEmpty = hr.filter(
    (h) => h.decision === "new" && !(h.cmaExternalId !== null && moByExternal.get(h.cmaExternalId)?.objectId != null)
  );
  const wronglyLinked = shouldStayEmpty.filter((h) => hrByName.get(norm(h.hrName))?.objectId != null);
  check(
    `posterunki bez ustalonego płatnika zostają niezmapowane (${shouldStayEmpty.length})`,
    wronglyLinked.length === 0,
    sample(wronglyLinked.map((h) => h.hrName))
  );
}

// 9. Spójność pól, które czyta Analityka: spółka musi istnieć, kwoty i współrzędne mieć sens.
{
  const badCompany = objects.filter((o) => o.companyId !== null && !companyIds.has(o.companyId));
  check("company_id wskazuje istniejącą spółkę", badCompany.length === 0, sample(badCompany.map((o) => o.name)));

  const badMoney = objects.filter((o) => o.monthlyValue !== null && !(o.monthlyValue > 0));
  check("abonament, jeśli jest, jest dodatni", badMoney.length === 0, sample(badMoney.map((o) => `${o.name}: ${o.monthlyValue}`)));

  const badCoords = objects.filter(
    (o) =>
      (o.latitude === null) !== (o.longitude === null) ||
      (o.latitude !== null && (o.latitude < 47 || o.latitude > 56)) ||
      (o.longitude !== null && (o.longitude < 13 || o.longitude > 25))
  );
  check("współrzędne kompletne i w granicach Polski", badCoords.length === 0, sample(badCoords.map((o) => `${o.name}: ${o.latitude},${o.longitude}`)));

  const badCameras = objects.filter((o) => o.cameraCount !== null && o.cameraCount <= 0);
  check("liczba kamer nigdy nie jest zerem (NULL = nie policzono)", badCameras.length === 0, sample(badCameras.map((o) => o.name)));
}

// 10. Kartoteka nie jest już demonstracyjna — dane z seeda musiały zniknąć.
{
  const demo = contractors.filter((c) => (c.notes ?? "").includes("Umowa monitoringu na dwa magazyny") || c.name === "Nowak Logistyka Sp. z o.o.");
  check("po przebudowie nie ma kontrahentów z seed-demo-data", demo.length === 0, sample(demo.map((c) => c.name)));
}

console.log(`\nZaliczone: ${passed}, nieudane: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
